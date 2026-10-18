// Shared fixtures for TaskManager / worker lifecycle tests: a scripted fake
// CodingAgentAdapter and a TaskManager harness with fake worker spawning, PID
// liveness, and process-tree termination. No model calls, no real processes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentHandle,
  AgentProcessStatus,
  AgentRunOutcome,
  CodingAgentAdapter,
  TaskPackage,
  WorkspaceRef,
} from "../src/interfaces.js";
import { BridgeError } from "../src/runtime/errors.js";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import type { ZCodeRunOutcome } from "../src/adapters/zcode-adapter.js";
import type { TerminateProcessTree } from "../src/adapters/process-spawn.js";
import { verifyWindowsRecordedTreeClaimants, type WindowsTreeTransactionLike } from "../src/adapters/windows-process-cleanup.js";
import { SESSION_ID, validReport } from "./helpers.js";

export type FakeBehavior =
  | "ok"
  | "master"
  | "adapterFailed"
  | "throwConfig"
  | "throwPlain"
  | "hang";

export class FakeAdapter implements CodingAgentAdapter {
  behavior: FakeBehavior = "ok";
  readonly calls: Array<{
    kind: "start" | "continue";
    taskId: string;
    attempt: number;
    workspace: string;
    feedback?: string;
    additionalRequirements?: string[];
    previousSessionId?: string | null;
    previousResult?: unknown;
  }> = [];
  cancelCallCount = 0;

  async startTask(input: { task: TaskPackage; workspace: WorkspaceRef; attempt: number }): Promise<AgentHandle> {
    this.calls.push({
      kind: "start",
      taskId: input.task.task_id,
      attempt: input.attempt,
      workspace: input.workspace.canonicalPath,
    });
    return makeHandle(input.task.task_id, input.attempt);
  }

  async continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: unknown;
  }): Promise<AgentHandle> {
    this.calls.push({
      kind: "continue",
      taskId: input.task.task_id,
      attempt: input.attempt,
      workspace: input.workspace.canonicalPath,
      feedback: input.feedback,
      additionalRequirements: input.additionalRequirements,
      previousSessionId: input.previousSessionId,
      previousResult: input.previousResult,
    });
    return makeHandle(input.task.task_id, input.attempt);
  }

  async getStatus(_handle: AgentHandle): Promise<AgentProcessStatus> {
    return {
      state: this.behavior === "hang" ? "running" : "exited",
      workerPid: process.pid,
      zcodePid: null,
      exitCode: null,
      signal: null,
    };
  }

  async getResult(_handle: AgentHandle): Promise<ZCodeRunOutcome> {
    switch (this.behavior) {
      case "ok":
      case "master":
      case "adapterFailed":
        return fakeOutcome(this.behavior);
      case "throwConfig":
        throw new BridgeError("provider_config_missing", "no personal provider config exists");
      case "throwPlain":
        throw new Error("worker exploded");
      case "hang":
        return new Promise<ZCodeRunOutcome>(() => {});
    }
  }

  async cancelTask(_handle: AgentHandle): Promise<void> {
    this.cancelCallCount += 1;
  }
}

export function fakeOutcome(behavior: FakeBehavior = "ok"): ZCodeRunOutcome {
  const report = validReport(
    behavior === "master" ? { needs_master_decision: true } : {},
  );
  const failed = behavior === "adapterFailed";
  return {
    exitCode: failed ? 1 : 0,
    signal: null,
    stdout: failed ? "" : JSON.stringify({ sessionId: SESSION_ID }),
    stderr: failed ? "Error: zcode exited with code 1" : "",
    sessionId: failed ? null : SESSION_ID,
    response: failed ? null : JSON.stringify(report),
    usage: failed ? null : { totalTokens: 5 },
    timedOut: false,
    agentReport: failed ? null : report,
    reportCandidate: failed ? null : report,
    reportError: failed ? "zcode exited with code 1; stderr: boom" : null,
    errorCode: failed ? "zcode_nonzero_exit" : null,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    attempts: 1,
  };
}

function makeHandle(taskId: string, attempt: number): AgentHandle {
  return {
    taskId,
    attempt,
    workerPid: process.pid,
    zcodePid: null,
    startedAt: new Date().toISOString(),
  };
}

export interface ManagerFixture {
  dataRoot: string;
  workspaceDir: string;
  store: TaskStore;
  manager: BridgeTaskManager;
  /** Workers "spawned" by the manager; none of them actually run. */
  spawned: Array<{ dataRoot: string; taskId: string; pid: number }>;
  pidsAlive: Set<number>;
  terminateCalls: number[];
  /** expectedRootFingerprint received per termination call (null = none). */
  terminateExpected: Array<string | null>;
  setTerminateError: (error: Error | null) => void;
  /** Recorded-tree claimant scans requested by the manager (ADR-009). */
  scanCalls: Array<Array<{ pid: number; fingerprint: string | null }>>;
  setScanResult: (result: { clean: boolean; livePids: readonly number[] } | Error) => void;
  /** Moves the fake clock forward; the manager's injected now() reads it. */
  advanceMs: (ms: number) => void;
  makeTask: (overrides?: Partial<TaskPackage>) => TaskPackage;
  runWorker: (taskId: string, adapter: FakeAdapter, behavior?: FakeBehavior) => Promise<unknown>;
  cleanup: () => Promise<void>;
}

export async function makeManagerFixture(options: {
  maxConcurrentWorkers?: number;
  /** Defaults to 0 (immediate worker_lost finalization) for legacy tests. */
  workerStartGraceMs?: number;
  /** When provided, the manager's release gate runs the REAL recorded-tree
   * claimant scan (verifyWindowsRecordedTreeClaimants) against the OS
   * transaction returned by this factory — only the transport is faked; the
   * scan logic and the whole manager cancel/occupancy path stay real. */
  scanOpen?: () => Promise<WindowsTreeTransactionLike>;
} = {}): Promise<ManagerFixture> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "zcode-bridge-mgr-"));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "zcode-bridge-ws-"));
  const store = new TaskStore(dataRoot);
  const spawned: Array<{ dataRoot: string; taskId: string; pid: number }> = [];
  const pidsAlive = new Set<number>();
  const terminateCalls: number[] = [];
  const terminateExpected: Array<string | null> = [];
  const scanCalls: Array<Array<{ pid: number; fingerprint: string | null }>> = [];
  let terminateError: Error | null = null;
  let scanResult: { clean: boolean; livePids: readonly number[] } | Error = { clean: true, livePids: [] };
  const clockBaseMs = Date.UTC(2026, 8, 27, 0, 0, 0);
  let clockMs = 1_000;

  const terminate: TerminateProcessTree = async (pid, terminateOptions) => {
    terminateCalls.push(pid);
    terminateExpected.push(terminateOptions?.expectedRootFingerprint ?? null);
    if (terminateError) throw terminateError;
    pidsAlive.delete(pid);
    return { pid, signal: "SIGKILL", verified: true };
  };

  const verifyTreeClean = options.scanOpen
    ? async (targets: readonly { pid: number; fingerprint: string | null }[]) => {
      scanCalls.push([...targets]);
      return verifyWindowsRecordedTreeClaimants(targets, { open: options.scanOpen! });
    }
    : async (targets: readonly { pid: number; fingerprint: string | null }[]) => {
      scanCalls.push([...targets]);
      if (scanResult instanceof Error) throw scanResult;
      return scanResult;
    };

  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    spawnWorker: (root, taskId) => {
      const pid = 50_000 + spawned.length + 1;
      spawned.push({ dataRoot: root, taskId, pid });
      pidsAlive.add(pid);
      return { pid };
    },
    isProcessRunning: (pid) => pidsAlive.has(pid),
    terminateProcessTree: terminate,
    verifyTreeClean,
    pollIntervalMs: 0,
    maxConcurrentWorkers: options.maxConcurrentWorkers,
    workerStartGraceMs: options.workerStartGraceMs ?? 0,
    now: () => new Date(clockBaseMs + clockMs),
  });

  return {
    dataRoot,
    workspaceDir,
    store,
    manager,
    spawned,
    pidsAlive,
    terminateCalls,
    terminateExpected,
    setTerminateError: (error) => {
      terminateError = error;
    },
    scanCalls,
    setScanResult: (result) => {
      scanResult = result;
    },
    advanceMs: (ms) => {
      clockMs += ms;
    },
    makeTask: (overrides = {}) => ({
      task_id: "task_1",
      workspace: workspaceDir,
      objective: "Create bridge-smoke.txt containing ZCODE_HEADLESS_SMOKE_OK",
      requirements: ["One line only"],
      allowed_paths: ["bridge-smoke.txt"],
      forbidden_paths: [],
      acceptance_criteria: ["Content matches"],
      test_commands: [],
      ...overrides,
    }),
    runWorker: (taskId, adapter) => {
      const workerAdapter = adapter ?? new FakeAdapter();
      return runWorkerCompat(dataRoot, taskId, workerAdapter);
    },
    cleanup: async () => {
      manager.dispose();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

import { runWorkerTask } from "../src/worker/run-task.js";
async function runWorkerCompat(dataRoot: string, taskId: string, adapter: FakeAdapter): Promise<unknown> {
  return runWorkerTask({ dataRoot, taskId, attempt: new TaskStore(dataRoot).readStatus(taskId).attempt, adapter });
}
