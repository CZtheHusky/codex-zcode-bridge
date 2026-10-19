// ZCodeAdapter: the V0.1 CodingAgentAdapter implementation (docs/ARCHITECTURE.md,
// docs/INTERFACES.md — frozen).
//
// Invocation shape (frozen): `--prompt … --json --mode yolo --cwd <workspace>`,
// continuation adds `--resume <sessionId>`. `--max-turns` is never passed (not
// supported by the verified CLI). The prompt travels via a unique temporary
// UTF-8 file and src/adapters/zcode-loader.cjs so it never appears in the OS
// argv. The child environment carries only the two official provider
// variables (no other ZCODE_* keys, no logging of their contents). JSON is
// parsed only for exit code 0; timeout/cancel terminate and verify the whole
// process tree (taskkill /T /F on Windows).
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  AgentHandle,
  AgentProcessStatus,
  AgentRunOutcome,
  CodingAgentAdapter,
  RuntimeResolver,
  TaskPackage,
  TaskResult,
  WorkspaceRef,
  ZCodeRuntimeConfig,
} from "../interfaces.js";
import type { AgentReport } from "../interfaces.js";
import { BridgeError } from "../runtime/errors.js";
import { createMinimalOsEnv } from "../runtime/child-env.js";
import { resolveTaskTimeout } from "../runtime/task-timeout.js";
import { NodeRuntimeResolver } from "../runtime/resolver.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { parseZcodeEnvelope } from "./envelope.js";
import { parseAgentReport } from "./agent-report.js";
import {
  appendBounded,
  captureSpawnGenerationIdentity,
  childStillOnSpawnGeneration,
  createPlatformProbe,
  defaultSpawnFunction,
  terminateProcessTree,
  type BoundedText,
  type SpawnedProcess,
  type SpawnFunction,
  type TerminateProcessTree,
} from "./process-spawn.js";

export type AdapterErrorCode =
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "invalid_json"
  | "invalid_agent_report"
  | "zcode_nonzero_exit"
  | "unknown_turn_terminal";

/**
 * Frozen AgentRunOutcome fields plus adapter-normalization evidence. A
 * non-null reportError or errorCode means the run must be treated as failed
 * for review even when exitCode is 0 (docs/INTERFACES.md: never mark a run
 * successful on invalid JSON or an invalid report).
 */
export interface ZCodeRunOutcome extends AgentRunOutcome {
  readonly agentReport: AgentReport | null;
  readonly reportCandidate: Partial<AgentReport> | null;
  readonly reportError: string | null;
  readonly errorCode: AdapterErrorCode | null;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly attempts: number;
  /** Process cleanup failed after the turn result was captured. */
  readonly cleanupError?: string | null;
  readonly cleanupVerified?: boolean;
  /** B2 additive: persisted correlation timestamps (RPC accept / turn start / turn end). */
  readonly phaseTimestamps?: {
    readonly rpc_accepted_at?: string | null;
    readonly turn_started_at?: string | null;
    readonly turn_completed_at?: string | null;
  } | null;
  /** B4 additive: runtime-confirmed model and reasoning-depth evidence. */
  readonly modelProfile?: import("../interfaces.js").ExecutionProfile | null;
}

export interface ZCodeAdapterOptions {
  resolver?: RuntimeResolver;
  spawnImpl?: SpawnFunction;
  terminateProcessTreeImpl?: TerminateProcessTree;
  /** Platform probe for the spawn-generation identity capture (ADR-009);
   * defaults to the real platform probe. */
  probe?: import("../runtime/process-probe.js").ProcessProbe;
  /** Wall-clock budget per attempt; default 60 minutes. */
  timeoutMs?: number;
  /** Capture cap per stream in bytes; default 10 MiB. */
  maxOutputBytes?: number;
  /** Base backoff before transient retries; default 1000 ms, doubling per retry. */
  retryBackoffMs?: number;
  /** Transient release-error retries; frozen policy caps this at 2. */
  maxTransientRetries?: number;
  /** Base environment for the child; defaults to process.env. */
  childEnvBase?: NodeJS.ProcessEnv;
  /** Directory for prompt files; defaults to os.tmpdir(). */
  promptTmpDir?: string;
  now?: () => Date;
}

/** Exact transient failure observed and recorded in docs/ZCODE_RUNTIME.md. */
const TRANSIENT_RELEASE_ERROR = "Bundled 与 Active ZCode Built-in Release 均不可用";
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;

type AttemptSnapshot =
  | { kind: "cancelled-before-spawn" }
  | { kind: "spawn_threw"; error: unknown }
  | { kind: "spawn_error"; error: unknown; stdout: BoundedText; stderr: BoundedText }
  | {
      kind: "closed";
      code: number | null;
      signal: string | null;
      stdout: BoundedText;
      stderr: BoundedText;
    };

interface RunEntry {
  readonly handle: AgentHandle;
  readonly workspacePath: string;
  readonly promptFile: string;
  readonly cliArgs: string[];
  readonly resumeSessionId: string | null;
  readonly timeoutMs: number;
  child: SpawnedProcess | null;
  zcodePid: number | null;
  /** ADR-009: spawn-generation identity captured while libuv still holds the
   * child's native handle (before its close/exit event); Windows termination
   * refuses to signal without it. */
  childIdentity: { pid: number; fingerprint: string } | null;
  /** True once the CURRENT generation's close event fired. Reset on every
   * retry spawn (review-round-2 C1); exit-state continuity per ADR-009 is
   * decided from the current child's exitCode/signalCode, with this flag as
   * the close-side bound — never as proof that a native handle is still
   * held (that guarantee belongs to the exit state). */
  childClosed: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  finished: boolean;
  terminationStarted: boolean;
  terminationError: Error | null;
  termination: Promise<void>;
  runPromise: Promise<ZCodeRunOutcome>;
  cachedOutcome: ZCodeRunOutcome | null;
  cachedError: unknown;
}

export class ZCodeAdapter implements CodingAgentAdapter {
  readonly #resolver: RuntimeResolver;
  readonly #spawnImpl: SpawnFunction;
  readonly #terminateImpl: TerminateProcessTree;
  readonly #probe: import("../runtime/process-probe.js").ProcessProbe;
  readonly #timeoutMs: number | null;
  readonly #maxOutputBytes: number;
  readonly #retryBackoffMs: number;
  readonly #maxTransientRetries: number;
  readonly #childEnvBase: NodeJS.ProcessEnv | null;
  readonly #promptTmpDir: string;
  readonly #now: () => Date;
  readonly #loaderPath: string;
  #configPromise: Promise<ZCodeRuntimeConfig> | null = null;
  readonly #runs = new Map<AgentHandle, RunEntry>();
  readonly #workspaceByTask = new Map<string, string>();

  constructor(options: ZCodeAdapterOptions = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver();
    this.#spawnImpl = options.spawnImpl ?? defaultSpawnFunction;
    this.#terminateImpl = options.terminateProcessTreeImpl ?? terminateProcessTree;
    this.#probe = options.probe ?? createPlatformProbe();
    this.#timeoutMs = options.timeoutMs ?? null;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.#maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
    this.#childEnvBase = options.childEnvBase ?? null;
    this.#promptTmpDir = options.promptTmpDir ?? tmpdir();
    this.#now = options.now ?? (() => new Date());
    this.#loaderPath = fileURLToPath(new URL("./zcode-loader.cjs", import.meta.url));
  }

  async startTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
  }): Promise<AgentHandle> {
    const prompt = buildTaskPrompt(input.task);
    return this.#launch({
      task: input.task,
      workspace: input.workspace,
      attempt: input.attempt,
      prompt,
      resumeSessionId: null,
    });
  }

  async continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle> {
    const recorded = this.#workspaceByTask.get(input.task.task_id);
    if (recorded !== undefined && recorded !== input.workspace.canonicalPath) {
      throw new Error(
        `continuation workspace mismatch for task ${input.task.task_id}: started in ${recorded}, continuation requested in ${input.workspace.canonicalPath}`,
      );
    }
    const prompt = buildContinuePrompt({
      task: input.task,
      feedback: input.feedback,
      additionalRequirements: input.additionalRequirements,
      previousSessionId: input.previousSessionId,
      previousResult: input.previousResult,
    });
    return this.#launch({
      task: input.task,
      workspace: input.workspace,
      attempt: input.attempt,
      prompt,
      resumeSessionId: input.previousSessionId,
    });
  }

  async getStatus(handle: AgentHandle): Promise<AgentProcessStatus> {
    const entry = this.#requireEntry(handle, "getStatus");
    if (!entry.finished) {
      return {
        state: "running",
        workerPid: entry.handle.workerPid,
        zcodePid: entry.zcodePid,
        exitCode: null,
        signal: null,
      };
    }
    return {
      state: "exited",
      workerPid: entry.handle.workerPid,
      zcodePid: entry.zcodePid,
      exitCode: entry.cachedOutcome ? entry.cachedOutcome.exitCode : null,
      signal: entry.cachedOutcome ? entry.cachedOutcome.signal : null,
    };
  }

  async getResult(handle: AgentHandle): Promise<ZCodeRunOutcome> {
    const entry = this.#requireEntry(handle, "getResult");
    if (entry.cachedError) throw entry.cachedError;
    if (entry.cachedOutcome) return entry.cachedOutcome;
    return entry.runPromise;
  }

  async cancelTask(handle: AgentHandle): Promise<void> {
    const entry = this.#requireEntry(handle, "cancelTask");
    if (entry.finished) return; // already settled; nothing to cancel
    entry.cancelRequested = true;
    await this.#triggerTerminate(entry);
    if (entry.terminationError) {
      throw entry.terminationError;
    }
  }

  async #launch(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    prompt: string;
    resumeSessionId: string | null;
  }): Promise<AgentHandle> {
    if (!existsSync(this.#loaderPath)) {
      throw new Error(
        `zcode-loader.cjs asset is missing next to the compiled adapter (build incomplete): ${this.#loaderPath}`,
      );
    }
    const cliArgs = ["--json", "--mode", "yolo", "--cwd", input.workspace.canonicalPath];
    if (input.resumeSessionId) {
      cliArgs.push("--resume", input.resumeSessionId);
    }
    const promptFile = await this.#writePromptFile(input.prompt);
    const handle: AgentHandle = {
      taskId: input.task.task_id,
      attempt: input.attempt,
      // Minimal in-process V0.1 adapter: this process plays the worker role
      // until the TaskManager phase introduces detached workers.
      workerPid: process.pid,
      zcodePid: null,
      startedAt: this.#now().toISOString(),
    };
    const entry: RunEntry = {
      handle,
      workspacePath: input.workspace.canonicalPath,
      promptFile,
      cliArgs,
      resumeSessionId: input.resumeSessionId,
      timeoutMs: this.#timeoutMs ?? resolveTaskTimeout(input.task, this.#childEnvBase ?? process.env),
      child: null,
      zcodePid: null,
      childIdentity: null,
      childClosed: false,
      cancelRequested: false,
      timedOut: false,
      finished: false,
      terminationStarted: false,
      terminationError: null,
      termination: Promise.resolve(),
      runPromise: new Promise<ZCodeRunOutcome>(() => {}),
      cachedOutcome: null,
      cachedError: null,
    };
    this.#runs.set(handle, entry);
    this.#workspaceByTask.set(input.task.task_id, input.workspace.canonicalPath);
    entry.runPromise = this.#execute(entry);
    void entry.runPromise.then(
      (outcome) => {
        entry.cachedOutcome = outcome;
        entry.finished = true;
        entry.child = null;
      },
      (error) => {
        entry.cachedError = error;
        entry.finished = true;
        entry.child = null;
      },
    );
    return handle;
  }

  async #execute(entry: RunEntry): Promise<ZCodeRunOutcome> {
    try {
      const config = await this.#resolveConfig();
      const childEnv = this.#buildChildEnv(config);
      const fullArgs = [this.#loaderPath, config.zcodeEntrypoint, entry.promptFile, ...entry.cliArgs];
      let attempt = 0;
      while (true) {
        if (entry.cancelRequested) {
          return this.#buildOutcome({ kind: "cancelled-before-spawn" }, attempt + 1, entry);
        }
        attempt++;
        const snapshot = await this.#runSingleAttempt(entry, config, fullArgs, childEnv);
        if (
          snapshot.kind === "closed" &&
          snapshot.code !== 0 &&
          !entry.timedOut &&
          !entry.cancelRequested &&
          isTransientReleaseError(snapshot.stderr.value) &&
          attempt <= this.#maxTransientRetries
        ) {
          await sleep(this.#retryBackoffMs * attempt);
          continue;
        }
        return this.#buildOutcome(snapshot, attempt, entry);
      }
    } finally {
      await rm(entry.promptFile, { force: true }).catch(() => undefined);
    }
  }

  #runSingleAttempt(
    entry: RunEntry,
    config: ZCodeRuntimeConfig,
    fullArgs: string[],
    childEnv: NodeJS.ProcessEnv,
  ): Promise<AttemptSnapshot> {
    return new Promise<AttemptSnapshot>((resolveSnapshot) => {
      let child: SpawnedProcess;
      try {
        child = this.#spawnImpl(
          config.nodeExecutable,
          fullArgs,
          {
            cwd: entry.workspacePath,
            env: childEnv,
            shell: false,
            windowsHide: true,
          },
        );
      } catch (error) {
        setImmediate(() => resolveSnapshot({ kind: "spawn_threw", error }));
        return;
      }
      entry.child = child;
      entry.zcodePid = typeof child.pid === "number" ? child.pid : null;
      // Per-generation reset (review-round-2 C1): the RunEntry is REUSED
      // across the retry policy's spawn generations — every spawn-local
      // field starts fresh so a closed previous generation can never
      // short-circuit this generation's termination or leak its identity.
      entry.childClosed = false;
      entry.childIdentity = null;
      // ADR-009: continuity is proven from the child's exit state (Node
      // delivers exit before close and libuv releases the native handle at
      // exit delivery). The shared capture re-verifies after every await and
      // discards fingerprints that raced an exit or lack exact precision.
      // A late capture from a PREVIOUS generation (its 250 ms retry window
      // can outlive the spawn of the next) must never overwrite the current
      // generation's identity, so the assignment is bound to this child.
      if (process.platform === "win32" && typeof child.pid === "number") {
        void captureSpawnGenerationIdentity(child, this.#probe).then((identity) => {
          if (entry.child === child) entry.childIdentity = identity;
        });
      }

      let stdout: BoundedText = { value: "", truncated: false };
      let stderr: BoundedText = { value: "", truncated: false };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk, this.#maxOutputBytes);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk, this.#maxOutputBytes);
      });

      let settled = false;
      const finish = (snapshot: AttemptSnapshot): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.childClosed = true;
        entry.child = null;
        void entry.termination.then(
          () => resolveSnapshot(snapshot),
          () => resolveSnapshot(snapshot),
        );
      };
      const timer = setTimeout(() => {
        entry.timedOut = true;
        void this.#triggerTerminate(entry);
      }, entry.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      child.on("error", (error: Error) => {
        finish({ kind: "spawn_error", error, stdout, stderr });
      });
      child.on("close", (code: number | null, signal: string | null) => {
        finish({ kind: "closed", code, signal, stdout, stderr });
      });
    });
  }

  #triggerTerminate(entry: RunEntry): Promise<void> {
    if (entry.terminationStarted) return entry.termination;
    entry.terminationStarted = true;
    const pid = entry.zcodePid;
    const child = entry.child;
    // ADR-009: on Windows, exit evidence ends the provable generation even
    // before stdio close; POSIX keeps its existing close-based behaviour.
    const generationRefused = process.platform === "win32" && child !== null
      && !childStillOnSpawnGeneration({ pid: pid ?? undefined, exitCode: child.exitCode, signalCode: child.signalCode, exitSeen: entry.childClosed });
    if (pid === null || entry.childClosed || generationRefused) {
      // No recorded pid, or the child's exit was already delivered (its
      // native handle is released and the PID may have been recycled):
      // nothing may be signalled (ADR-009). Windows refuses; POSIX callers
      // only reach here for genuinely closed children.
      entry.termination = Promise.resolve();
      return entry.termination;
    }
    entry.termination = this.#terminateImpl(pid, {
      graceMs: 500,
      killWaitMs: 5_000,
      expectedRootFingerprint: entry.childIdentity?.pid === pid ? entry.childIdentity.fingerprint : null,
    }).then(
      () => undefined,
      (error: unknown) => {
        entry.terminationError =
          error instanceof Error ? error : new Error(String(error));
      },
    );
    return entry.termination;
  }

  #buildOutcome(snapshot: AttemptSnapshot, attempts: number, entry: RunEntry): ZCodeRunOutcome {
    const base = {
      attempts,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      agentReport: null,
      reportCandidate: null,
      reportError: null,
      errorCode: null,
      sessionId: null,
      response: null,
      usage: null,
      timedOut: entry.timedOut && !entry.cancelRequested,
    } satisfies Omit<
      ZCodeRunOutcome,
      | "exitCode"
      | "signal"
      | "stdout"
      | "stderr"
      | "agentReport"
      | "reportCandidate"
      | "reportError"
      | "errorCode"
      | "sessionId"
      | "response"
      | "usage"
    > & {
      agentReport: null;
      reportCandidate: null;
      reportError: null;
      errorCode: null;
      sessionId: null;
      response: null;
      usage: null;
    };

    if (snapshot.kind === "spawn_threw" || snapshot.kind === "spawn_error") {
      const message = snapshot.error instanceof Error ? snapshot.error.message : String(snapshot.error);
      throw new BridgeError("spawn_failed", `failed to start the ZCode process: ${message}`);
    }

    if (snapshot.kind === "cancelled-before-spawn") {
      return {
        ...base,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        errorCode: "cancelled",
        reportError: "cancelled before the ZCode process was spawned",
      };
    }

    if (entry.timedOut) {
      return {
        ...base,
        exitCode: snapshot.code,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        errorCode: "timeout",
        reportError: `ZCode run exceeded ${entry.timeoutMs}ms wall-clock budget; the process tree was terminated${
          entry.terminationError ? ` (termination verification failed: ${entry.terminationError.message})` : " and verified"
        }`,
      };
    }

    const terminationVerified = entry.terminationStarted && entry.terminationError === null;
    // A cancellation whose process-tree termination could not be verified does
    // not eclipse a natural clean completion (docs/INTERFACES.md zcode_cancel:
    // the task stays nonterminal; the natural result still becomes evidence).
    if (entry.cancelRequested && (terminationVerified || snapshot.code !== 0)) {
      return {
        ...base,
        exitCode: snapshot.code,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        cancelled: true,
        errorCode: "cancelled",
        reportError: entry.terminationError
          ? `cancelled by request; process-tree termination could not be verified: ${entry.terminationError.message}`
          : "cancelled by request; the process tree was terminated and verified",
      };
    }

    if (snapshot.code !== 0) {
      const excerpt = snapshot.stderr.value.trim().slice(0, 2_000);
      return {
        ...base,
        exitCode: snapshot.code,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        errorCode: "zcode_nonzero_exit",
        reportError: `zcode exited with code ${String(snapshot.code)}${excerpt ? `; stderr: ${excerpt}` : ""}`,
      };
    }

    // Exit code 0: parse the single JSON envelope, then the embedded report.
    const parsedEnvelope = parseZcodeEnvelope(snapshot.stdout.value);
    if (!parsedEnvelope.envelope) {
      return {
        ...base,
        exitCode: 0,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        errorCode: "invalid_json",
        reportError: parsedEnvelope.error,
      };
    }
    const envelope = parsedEnvelope.envelope;
    if (entry.resumeSessionId && envelope.sessionId !== entry.resumeSessionId) {
      return {
        ...base,
        exitCode: 0,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        sessionId: envelope.sessionId,
        response: envelope.response,
        usage: envelope.usage,
        errorCode: "invalid_json",
        reportError: `resume session mismatch: requested ${entry.resumeSessionId}, runtime returned ${envelope.sessionId}`,
      };
    }
    const parsedReport = parseAgentReport(envelope.response);
    if (!parsedReport.report) {
      return {
        ...base,
        exitCode: 0,
        signal: snapshot.signal,
        stdout: snapshot.stdout.value,
        stderr: snapshot.stderr.value,
        stdoutTruncated: snapshot.stdout.truncated,
        stderrTruncated: snapshot.stderr.truncated,
        sessionId: envelope.sessionId,
        response: envelope.response,
        usage: envelope.usage,
        errorCode: "invalid_agent_report",
        reportError: parsedReport.error,
        reportCandidate: parsedReport.candidate,
      };
    }
    return {
      ...base,
      exitCode: 0,
      signal: snapshot.signal,
      stdout: snapshot.stdout.value,
      stderr: snapshot.stderr.value,
      stdoutTruncated: snapshot.stdout.truncated,
      stderrTruncated: snapshot.stderr.truncated,
      sessionId: envelope.sessionId,
      response: envelope.response,
      usage: envelope.usage,
      agentReport: parsedReport.report,
      reportCandidate: parsedReport.candidate,
      reportError: null,
      errorCode: null,
    };
  }

  async #resolveConfig(): Promise<ZCodeRuntimeConfig> {
    if (!this.#configPromise) {
      this.#configPromise = this.#resolver.resolve();
    }
    return this.#configPromise;
  }

  /** The child receives an OS allowlist plus validated provider config paths. */
  #buildChildEnv(config: ZCodeRuntimeConfig): NodeJS.ProcessEnv {
    const env = createMinimalOsEnv(this.#childEnvBase ?? process.env);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    return env;
  }

  async #writePromptFile(prompt: string): Promise<string> {
    await mkdir(this.#promptTmpDir, { recursive: true });
    const file = path.join(this.#promptTmpDir, `zcode-bridge-prompt-${randomUUID()}.txt`);
    await writeFile(file, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return file;
  }

  #requireEntry(handle: AgentHandle, method: string): RunEntry {
    const entry = this.#runs.get(handle);
    if (!entry) {
      throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    }
    return entry;
  }
}

function isTransientReleaseError(stderrText: string): boolean {
  return stderrText.includes(TRANSIENT_RELEASE_ERROR);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
