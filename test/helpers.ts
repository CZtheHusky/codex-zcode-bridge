// Shared test fixtures: fake spawn infrastructure, disposable directories, and
// sample payloads. Unit tests never invoke the real ZCode CLI or any model.
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProcessRunning } from "../src/adapters/process-spawn.js";
import type {
  AgentReport,
  TaskPackage,
  WorkspaceRef,
  ZCodeRuntimeConfig,
} from "../src/interfaces.js";
import type { SpawnedProcess, SpawnFunction, SpawnOptionsLike } from "../src/adapters/process-spawn.js";

export const SESSION_ID = "sess_11111111-aaaa-4bbb-8ccc-cccccccccccc";

export class FakeStream {
  readonly #emitter = new EventEmitter();

  setEncoding(_encoding: "utf8"): void {
    // encoding is irrelevant for fakes
  }

  on(event: "data", listener: (chunk: string) => void): void {
    this.#emitter.on(event, listener);
  }

  emitData(chunk: string): void {
    this.#emitter.emit("data", chunk);
  }
}

export class FakeChild implements SpawnedProcess {
  readonly stdout: FakeStream = new FakeStream();
  readonly stderr: FakeStream = new FakeStream();
  readonly pid: number;
  /** Mirrors a real ChildProcess: null until the exit event is delivered
   * (which happens before stdio close). ADR-009 continuity reads these. */
  exitCode: number | null = null;
  signalCode: string | null = null;
  killCallCount = 0;
  readonly #events = new EventEmitter();

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.#events.on(event, listener);
    return this;
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killCallCount += 1;
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emitData(text);
  }

  emitStderr(text: string): void {
    this.stderr.emitData(text);
  }

  /** Marks the child exited: exit state first, then the event — mirroring
   * Node's exit-before-close ordering (ADR-009). */
  emitExit(code: number | null, signal: string | null): void {
    if (code !== null) this.exitCode = code;
    if (signal !== null) this.signalCode = signal;
    setImmediate(() => this.#events.emit("exit", code, signal));
  }

  /** Deferred so the adapter's listeners (attached synchronously) are ready.
   * The exit state is set before the close event fires, like a real child. */
  emitClose(code: number | null, signal: string | null): void {
    setImmediate(() => {
      if (code !== null) this.exitCode = code;
      if (signal !== null) this.signalCode = signal;
      this.#events.emit("close", code, signal);
    });
  }

  emitError(error: Error): void {
    setImmediate(() => this.#events.emit("error", error));
  }
}

export interface SpawnRecord {
  readonly file: string;
  readonly args: string[];
  readonly options: SpawnOptionsLike;
  readonly child: FakeChild;
  promptContent: string | null;
}

/**
 * Scriptable fake spawn. Each queued script hook runs after listeners are
 * attached; hooks typically capture the prompt file content and emit
 * stdout/stderr/close.
 */
export class FakeSpawn {
  readonly records: SpawnRecord[] = [];
  readonly script: Array<(child: FakeChild, record: SpawnRecord, index: number) => void> = [];
  /** When set, spawn itself throws synchronously (ENOENT-style failures). */
  spawnThrows: Error | null = null;

  spawnFn: SpawnFunction = (file, args, options) => {
    if (this.spawnThrows) {
      throw this.spawnThrows;
    }
    const child = new FakeChild(30_000 + this.records.length);
    const record: SpawnRecord = { file, args, options, child, promptContent: null };
    this.records.push(record);
    const hook = this.script.shift();
    if (hook) {
      queueMicrotask(() => hook(child, record, this.records.length - 1));
    }
    return child;
  };

  recordForPid(pid: number): SpawnRecord | undefined {
    return this.records.find((record) => record.child.pid === pid);
  }
}

export function fakeConfig(overrides: Partial<ZCodeRuntimeConfig> = {}): ZCodeRuntimeConfig {
  return {
    nodeExecutable: "node-fake",
    zcodeEntrypoint: "C:\\fake\\zcode.cjs",
    providerBuiltinConfigFile: "C:\\fake\\zcode-builtin.json",
    providerPersonalConfigFile: "C:\\fake\\provider_config.json",
    dataRoot: "C:\\fake\\data",
    ...overrides,
  };
}

export function stubResolver(config: ZCodeRuntimeConfig = fakeConfig()): {
  resolve: () => Promise<ZCodeRuntimeConfig>;
} {
  return { resolve: async () => config };
}

export function validReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    summary: "Created the requested file",
    files_changed: ["bridge-smoke.txt"],
    tests: [{ command: "pytest -q", status: "passed" }],
    issues: [],
    needs_master_decision: false,
    ...overrides,
  };
}

export function successEnvelope(
  report: AgentReport | object,
  sessionId: string = SESSION_ID,
): string {
  return JSON.stringify({
    sessionId,
    traceId: "trace-1",
    turnId: "turn-1",
    response: JSON.stringify(report),
    usage: { source: "provider", totalTokens: 100 },
    eventCount: 1,
    projection: { status: "idle" },
  });
}

export function makeTask(overrides: Partial<TaskPackage> = {}): TaskPackage {
  return {
    task_id: "task_1",
    workspace: "C:\\work\\demo",
    objective: "Create bridge-smoke.txt containing ZCODE_HEADLESS_SMOKE_OK",
    requirements: ["The file must contain exactly one line"],
    allowed_paths: ["bridge-smoke.txt"],
    forbidden_paths: ["../outside"],
    acceptance_criteria: ["File exists with the expected content"],
    test_commands: [],
    ...overrides,
  };
}

export function makeWorkspace(canonicalPath = "C:\\work\\demo"): WorkspaceRef {
  return { requestedPath: canonicalPath, canonicalPath, mode: "direct" };
}

export async function makeTempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `zcode-bridge-test-${label}-`));
}

/**
 * Windows teardown tolerance (2026-10-17): recursive removals of trees that
 * hosted child processes and lock directories can fail transiently with
 * ENOTEMPTY/EPERM/EBUSY while directory entries propagate. These are exactly
 * the codes Node documents as retryable for recursive rm; the retry budget is
 * bounded and exhaustion still rejects, so genuine cleanup failures stay
 * visible instead of being masked.
 */
export const TEMP_TREE_REMOVE_OPTIONS = { maxRetries: 5, retryDelay: 100 } as const;

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS });
}

export interface OwnedProcessFixtureCleanup {
  /** Pids of ONLY the processes this test spawned itself — never broad
   * PID-tree signalling, and never a pid whose provenance is not this test. */
  readonly pids: readonly number[];
  /** File the fixture children watch for their cooperative release. */
  readonly releasePath: string;
  /** Fixture root removed only after every owned child confirmed exit. */
  readonly dir: string;
  /** Whether the test's primary path already failed; cleanup problems then
   * never mask the original failure but are still reported loudly. */
  readonly primaryFailed: boolean;
  readonly timeoutMs?: number;
  /** When a descendant's identity could not be established (for example a
   * failed pid receipt), the tree must not be deleted around a possibly live
   * unknown child: release the known pids but preserve everything. */
  readonly preserveTree?: boolean;
}

/**
 * Fixture-only cooperative teardown for REAL child processes (2026-10-17
 * matrix2 review): a probe that has written its receipt is not necessarily
 * exited — a detached worker's cwd is the fixture root, so removing the tree
 * before the exit is confirmed failed with EBUSY in the wild. The fixture
 * scripts watch their release file; this helper writes it and CONFIRMS each
 * owned pid reports exited within a bounded window. Mechanical gates: any
 * release-signaling or exit-confirmation failure — or an explicit
 * preserveTree request for unknown descendants — keeps the fixture tree for
 * diagnosis instead of deleting around live or unaccounted children; a blind
 * sleep or a plain rmdir retry cannot substitute for the exit confirmation.
 * Errors stay visible unless the primary path already failed, in which case
 * they are reported without masking it. Callers whose primary action already
 * ran a successful gated cleanup must not call this again — track that
 * success at the call site instead of relying on this helper to detect it.
 */
export async function cleanupOwnedProcessFixture(cleanup: OwnedProcessFixtureCleanup): Promise<void> {
  const issues: string[] = [];
  let treeRemovalAllowed = !cleanup.preserveTree;
  try {
    await writeFile(cleanup.releasePath, String(Date.now()), "utf8");
  } catch (error) {
    issues.push(`writing the release signal failed: ${error instanceof Error ? error.message : String(error)}`);
    treeRemovalAllowed = false;
  }
  const timeoutMs = cleanup.timeoutMs ?? 15_000;
  for (const pid of cleanup.pids) {
    const deadline = Date.now() + timeoutMs;
    while (isProcessRunning(pid)) {
      if (Date.now() >= deadline) {
        issues.push(`owned test process pid ${String(pid)} did not report exit within ${String(timeoutMs)} ms of its release signal`);
        treeRemovalAllowed = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (cleanup.preserveTree) {
    issues.push(`tree removal skipped by request: a descendant's identity is unknown; fixture tree preserved at ${cleanup.dir} for diagnosis`);
  }
  if (treeRemovalAllowed) {
    try {
      await removeTempDir(cleanup.dir);
    } catch (error) {
      issues.push(`removing the fixture tree failed: ${error instanceof Error ? error.message : String(error)}`);
      treeRemovalAllowed = false;
    }
  }
  if (issues.length > 0) {
    const preserved = treeRemovalAllowed ? "" : `; fixture tree preserved at ${cleanup.dir} for diagnosis`;
    const message = `fixture teardown failed: ${issues.join("; ")}${preserved}`;
    if (!cleanup.primaryFailed) throw new Error(message);
    // The primary failure is already propagating; surface this loudly without
    // replacing it.
    console.error(message);
  }
}

export const TRANSIENT_STDERR = "Error: Bundled 与 Active ZCode Built-in Release 均不可用";
