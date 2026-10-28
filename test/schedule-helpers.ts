// Shared fixtures for ADR-010 scheduling tests: a scripted TaskManager fake
// (no real workers) and a recording supervisor fake. All schedule tests use
// disposable directories under the system tmpdir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ContinueTaskInput,
  TaskManager,
  TaskObservation,
  TaskPackage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
} from "../src/interfaces.js";
import { TaskManagerError } from "../src/manager/errors.js";
import { ScheduleStore, schedulesRootFor } from "../src/schedule/store.js";
import type { Supervisor, SupervisorPlan } from "../src/schedule/supervisor.js";

export const THREAD_ID = "01a180cd-16ce-7e82-9741-5f467ff05a1a";

export const VERIFIED_OBSERVATION: TaskObservation = {
  schema_version: 1,
  worker: { state: "exited", reason_code: "fixture", observed_at: "2026-10-27T00:00:00.000Z" },
  runtime: { state: "exited", reason_code: "fixture", observed_at: "2026-10-27T00:00:00.000Z" },
  activity: { code: "unknown", reason_code: "fixture", observed_at: "2026-10-27T00:00:00.000Z" },
  result: "committed",
  cleanup: "verified",
  stalled: false,
  evidence: { heartbeat_age_ms: null, last_event_age_ms: null, last_event_seq: null, last_event_type: null, session_id: "sess_1", turn_id: null, attempt: 1, status_updated_at: null },
};

export class ScriptedManager implements TaskManager {
  readonly calls: Array<
    | { method: "createTask"; args: TaskPackage }
    | { method: "continueTask"; args: ContinueTaskInput }
    | { method: "getStatus" | "getResult" | "cancelTask"; args: string }
  > = [];
  status: TaskStatusRecord | null = null;
  result: TaskResult | null = null;
  createError: Error | null = null;
  continueError: Error | null = null;
  cancelError: Error | null = null;
  cancelCleanup: TaskObservation["cleanup"] = "verified";
  /** Invoked inside cancelTask so tests can assert persisted stop-intent ordering. */
  onCancelObserve: (() => void) | null = null;

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    this.calls.push({ method: "createTask", args: task });
    if (this.createError) throw this.createError;
    this.status = {
      task_id: task.task_id,
      status: "queued",
      attempt: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null,
    };
    return { task_id: task.task_id, status: "queued", created_at: this.status.created_at };
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    this.calls.push({ method: "getStatus", args: taskId });
    if (!this.status) throw new TaskManagerError("TASK_NOT_FOUND", `unknown task_id: ${taskId}`);
    return { ...this.status };
  }

  async getResult(taskId: string): Promise<TaskResult> {
    this.calls.push({ method: "getResult", args: taskId });
    if (!this.result) throw new TaskManagerError("TASK_NOT_FINISHED", `task ${taskId} is not finished`);
    return { ...this.result };
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    this.calls.push({ method: "continueTask", args: { ...input } });
    if (this.continueError) throw this.continueError;
    const attempt = (this.status?.attempt ?? 1) + 1;
    this.status = this.status
      ? { ...this.status, status: "queued", attempt, updated_at: new Date().toISOString() }
      : null;
    this.result = null;
    return { task_id: input.task_id, status: "queued", created_at: new Date().toISOString() };
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    this.calls.push({ method: "cancelTask", args: taskId });
    this.onCancelObserve?.();
    if (this.cancelError) throw this.cancelError;
    this.status = this.status
      ? { ...this.status, status: "cancelled", observation: { ...VERIFIED_OBSERVATION, cleanup: this.cancelCleanup }, finished_at: new Date().toISOString() }
      : null;
    return this.status ?? { task_id: taskId, status: "cancelled", attempt: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: null, finished_at: new Date().toISOString(), worker_pid: null, zcode_session_id: null, exit_code: null };
  }
}

export class RecordingSupervisor implements Supervisor {
  readonly plans: SupervisorPlan[] = [];
  readonly stopped: string[] = [];
  failStart: Error | null = null;

  async start(plan: SupervisorPlan): Promise<{ unit: string }> {
    this.plans.push(plan);
    if (this.failStart) throw this.failStart;
    return { unit: plan.unit };
  }

  async stop(unit: string): Promise<void> {
    this.stopped.push(unit);
  }
}

export interface ScheduleFixture {
  readonly dataRoot: string;
  readonly schedulesRoot: string;
  readonly store: ScheduleStore;
  readonly manager: ScriptedManager;
  readonly supervisor: RecordingSupervisor;
  cleanup: () => Promise<void>;
}

export async function makeScheduleFixture(): Promise<ScheduleFixture> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "zcode-bridge-sched-"));
  const schedulesRoot = schedulesRootFor(dataRoot);
  return {
    dataRoot,
    schedulesRoot,
    store: new ScheduleStore(schedulesRoot),
    manager: new ScriptedManager(),
    supervisor: new RecordingSupervisor(),
    cleanup: async () => { await rm(dataRoot, { recursive: true, force: true }); },
  };
}

export function scheduleTaskPackage(overrides: Partial<TaskPackage> = {}): TaskPackage {
  return {
    task_id: "goal_1",
    workspace: "/workspace/project",
    objective: "Implement the scheduled feature",
    requirements: ["Minimal changes"],
    allowed_paths: ["src/"],
    forbidden_paths: [],
    acceptance_criteria: ["All tests pass"],
    test_commands: ["npm test"],
    ...overrides,
  };
}

/** Bounded sleep for the runner loop: stops the infinite monitor after
 * maxTicks ticks by rejecting with a sentinel the test catches. */
export function makeBoundedSleep(maxTicks: number): { sleep: (ms: number) => Promise<void>; ticks: () => number } {
  let count = 0;
  return {
    sleep: (ms: number) => {
      count += 1;
      if (count > maxTicks) return Promise.reject(new Error(`test-stop after ${maxTicks} ticks`));
      return Promise.resolve();
    },
    ticks: () => count,
  };
}
