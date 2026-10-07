// TaskManager: validates requests, owns the configured global worker slots, persists
// state via the TaskStore, launches and
// reconciles detached workers, and enforces state transitions.
//
// Concurrency model: all state mutations run through a single promise-chain
// mutex, and an interval tick (recoverTasks) reconciles non-terminal tasks:
// a persisted worker PID that is gone without a terminal result becomes
// failed/worker_lost; a terminal result.json whose status lags aligns the
// status record; queued tasks start FIFO while the slot is free.
import type {
  ContinueTaskInput,
  ProgressTaskManager,
  TaskPackage,
  TaskProgressPage,
  TaskProgressEvent,
  TaskFeedbackSnapshotV01,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  WorkspaceProvider,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { isTerminalStatus, TaskStore, toPublicStatus } from "../store/task-store.js";
import { buildTaskResult, type TaskFailure } from "./normalize.js";
import type { ZCodeRunOutcome } from "../adapters/zcode-adapter.js";
import { TaskManagerError } from "./errors.js";
import { defaultSpawnWorker, type SpawnWorker } from "./spawn-worker.js";
import { isProcessRunning, terminateProcessTree, type TerminateProcessTree } from "../adapters/process-spawn.js";
import { validateTaskTimeout } from "../runtime/task-timeout.js";
import { tryAcquireProcessLock, withProcessLock } from "../store/process-lock.js";
import { buildTaskPrompt, buildContinuePrompt } from "../prompts/task-prompt.js";
import { buildTaskFeedbackSnapshotV01 } from "../feedback/task-feedback.js";

export interface TaskManagerOptions {
  store: TaskStore;
  workspaceProvider: WorkspaceProvider;
  /** Defaults to spawning the detached worker-main.js process. */
  spawnWorker?: SpawnWorker;
  /** Defaults to a real PID liveness check. */
  isProcessRunning?: (pid: number) => boolean;
  /** Defaults to real process-tree termination with verification. */
  terminateProcessTree?: TerminateProcessTree;
  /** Reconcile/pump interval; 0 disables the timer (tests drive manually). */
  pollIntervalMs?: number;
  now?: () => Date;
  /**
   * Grace window after an attempt starts during which a missing or dead
   * worker pid must not finalize worker_lost. Defaults to 10,000 ms; 0
   * restores immediate finalization.
   */
  workerStartGraceMs?: number;
  /** Maximum simultaneous detached workers in this Bridge process. Defaults to 8. */
  maxConcurrentWorkers?: number;
}

export class BridgeTaskManager implements ProgressTaskManager {
  /** How long a respawn claim counts as in-flight across Bridge processes. */
  static readonly RESPAWN_IN_FLIGHT_MS = 10_000;
  readonly #store: TaskStore;
  readonly #workspaceProvider: WorkspaceProvider;
  readonly #spawnWorker: SpawnWorker;
  readonly #isProcessRunning: (pid: number) => boolean;
  readonly #terminateProcessTree: TerminateProcessTree;
  readonly #now: () => Date;
  readonly #dataRoot: string;
  readonly #maxConcurrentWorkers: number;
  readonly #workerStartGraceMs: number;
  readonly #recoveryCooldownMs: number;
  #timer: NodeJS.Timeout | null = null;
  #mutex: Promise<unknown> = Promise.resolve();
  #queuedOperations = 0;
  #recoveryPromise: Promise<void> | null = null;

  constructor(options: TaskManagerOptions) {
    this.#store = options.store;
    this.#workspaceProvider = options.workspaceProvider;
    this.#spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.#isProcessRunning = options.isProcessRunning ?? isProcessRunning;
    this.#terminateProcessTree = options.terminateProcessTree ?? terminateProcessTree;
    this.#now = options.now ?? (() => new Date());
    this.#dataRoot = options.store.dataRoot;
    this.#maxConcurrentWorkers = options.maxConcurrentWorkers ?? 8;
    if (!Number.isInteger(this.#maxConcurrentWorkers) || this.#maxConcurrentWorkers < 1 || this.#maxConcurrentWorkers > 8) {
      throw new RangeError("maxConcurrentWorkers must be an integer from 1 to 8");
    }
    this.#workerStartGraceMs = options.workerStartGraceMs ?? 10_000;
    if (!Number.isInteger(this.#workerStartGraceMs) || this.#workerStartGraceMs < 0) {
      throw new RangeError("workerStartGraceMs must be a non-negative integer");
    }
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#recoveryCooldownMs = pollIntervalMs;
    if (pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.recoverTasks().catch((error) => console.error("Bridge recovery failed:", error instanceof Error ? error.message : String(error)));
      }, pollIntervalMs);
      this.#timer.unref();
    }
  }

  /** Stops the reconcile timer; safe to call repeatedly. */
  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Scans all non-terminal tasks and reconciles them, then pumps the queue. */
  async recoverTasks(): Promise<void> {
    if (this.#recoveryPromise) return this.#recoveryPromise;
    const releaseRecovery = tryAcquireProcessLock(path.join(this.#store.tasksRoot, ".recovery.lock"));
    if (!releaseRecovery) return;
    const lastRunFile = path.join(this.#store.tasksRoot, ".recovery-last-run");
    if (this.#recoveryCooldownMs > 0 && existsSync(lastRunFile) && Date.now() - statSync(lastRunFile).mtimeMs < this.#recoveryCooldownMs) {
      releaseRecovery();
      return;
    }
    const run = this.#exclusive(async () => {
      for (const taskId of this.#store.listTaskIds()) {
        try {
          const status = this.#safeStatus(taskId);
          if (!status) continue;
          if (isTerminalStatus(status.status)) continue;
          if (status.status === "running") {
            this.#reconcileRunningLocked(taskId, status);
          }
        } catch (error) { console.error(`Bridge could not reconcile task ${taskId}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      this.#pumpLocked();
    });
    this.#recoveryPromise = run;
    try { await run; }
    finally {
      try {
        if (this.#recoveryCooldownMs > 0) {
          writeFileSync(lastRunFile, String(Date.now()), { mode: 0o600 });
        }
      } finally {
        releaseRecovery();
        this.#recoveryPromise = null;
      }
    }
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      this.#validateTaskPackage(task);
      if (this.#store.hasTask(task.task_id)) {
        const existing = this.#store.readTask(task.task_id);
        const ref = this.#store.readWorkspaceRef(task.task_id);
        const sameWorkspace = path.resolve(task.workspace) === path.resolve(ref?.requestedPath ?? existing.workspace);
        const sameExecutionPath = task.worktree_path === undefined
          ? existing.worktree_path === undefined
          : existing.worktree_path !== undefined && path.resolve(task.worktree_path) === path.resolve(ref?.canonicalPath ?? existing.worktree_path);
        const normalizedRetry: TaskPackage = {
          ...task,
          workspace: existing.workspace,
          ...(existing.worktree_path === undefined ? { worktree_path: undefined } : { worktree_path: existing.worktree_path }),
        };
        const fingerprint = createHash("sha256").update(stableJson(normalizedRetry)).digest("hex");
        const previous = this.#store.readSubmission<{ fingerprint: string; receipt: TaskReceipt }>(task.task_id);
        const existingFingerprint = previous?.fingerprint ?? createHash("sha256").update(stableJson(existing)).digest("hex");
        if (!sameWorkspace || !sameExecutionPath || existingFingerprint !== fingerprint) {
          throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already belongs to a different request: ${task.task_id}`);
        }
        const status = this.#store.readStatus(task.task_id);
        const receipt = previous?.receipt ?? {
          task_id: task.task_id,
          status: status.status === "running" ? "running" as const : "queued" as const,
          created_at: status.created_at,
        };
        this.#store.writeSubmission(task.task_id, { fingerprint, receipt });
        return receipt;
      }
      let workspaceRef;
      try {
        workspaceRef = await this.#workspaceProvider.resolve(task.workspace, task.task_id, task.worktree_path);
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const createdAt = this.#now().toISOString();
      try { buildTaskPrompt(task); } catch (error) { throw new TaskManagerError("TASK_INVALID", String(error)); }
      const normalizedTask: TaskPackage = {
        ...task,
        workspace: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
        ...(workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : { worktree_path: undefined }),
      };
      const fingerprint = createHash("sha256").update(stableJson(normalizedTask)).digest("hex");
      try {
        this.#store.createTask(normalizedTask, createdAt);
        this.#store.writeWorkspaceRef(task.task_id, workspaceRef);
      } catch (error) {
        await this.#workspaceProvider.release(workspaceRef).catch(() => undefined);
        throw error;
      }
      this.#store.appendEvent(task.task_id, "queued", "Task accepted and queued", undefined, createdAt);
      this.#store.appendEvent(task.task_id, "workspace_ready", workspaceRef.mode === "worktree"
        ? "Using the the calling host-selected worktree for execution under the requested project"
        : "Using the requested project directory for execution", {
          project_path: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
          execution_path: workspaceRef.canonicalPath,
          ...(workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : {}),
          mode: workspaceRef.mode,
          ...(workspaceRef.branchName ? { branch_name: workspaceRef.branchName } : {}),
        }, createdAt);
      // Commit an accepted receipt before dispatch so a crash or lost MCP
      // response cannot turn a retry into a second execution.
      const acceptedReceipt: TaskReceipt = { task_id: task.task_id, status: "queued", created_at: createdAt };
      this.#store.writeSubmission(task.task_id, { fingerprint, receipt: acceptedReceipt });
      this.#pumpLocked();
      const status = this.#store.readStatus(task.task_id);
      const receipt: TaskReceipt = status.status === "running" ? {
        task_id: task.task_id,
        status: "running",
        created_at: createdAt,
      } : acceptedReceipt;
      if (receipt !== acceptedReceipt) this.#store.writeSubmission(task.task_id, { fingerprint, receipt });
      return receipt;
    });
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    // Status is an atomic persisted snapshot. Do not make callers wait behind
    // a recovery scan or a slow worker cleanup operation.
    this.#requireTask(taskId);
    return toPublicStatus(this.#store.readStatus(taskId));
  }

  async getEvents(input: {
    task_id: string;
    after_seq?: number;
    limit?: number;
    wait_ms?: number;
    view?: "raw" | "summary";
  }): Promise<TaskProgressPage> {
    const afterSeq = input.after_seq ?? 0;
    const limit = input.limit ?? 100;
    const waitMs = input.wait_ms ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new TaskManagerError("TASK_INVALID", "after_seq must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskManagerError("TASK_INVALID", "limit must be an integer from 1 to 200");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new TaskManagerError("TASK_INVALID", "wait_ms must be an integer from 0 to 25000");
    }
    if (input.view !== undefined && input.view !== "raw" && input.view !== "summary") {
      throw new TaskManagerError("TASK_INVALID", "view must be raw or summary");
    }
    const deadline = Date.now() + waitMs;
    while (true) {
      const page = await (async () => {
        this.#requireTask(input.task_id);
        const status = this.#store.readStatus(input.task_id);
        const read = this.#store.readEvents(input.task_id, afterSeq, limit, input.view ?? "raw");
        return {
          task_id: input.task_id,
          status: status.status,
          events: read.events,
          next_seq: read.nextSeq,
          has_more: read.hasMore,
          ...(read.omittedEvents ? { omitted_events: read.omittedEvents } : {}),
        } satisfies TaskProgressPage;
      })();
      if (page.events.length || isTerminalStatus(page.status) || Date.now() >= deadline) return page;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    this.#requireTask(taskId);
    const status = this.#store.readStatus(taskId);
    const startTime = status.started_at ? Date.parse(status.started_at) : Number.NaN;
    const relevantTypes = new Set(["model_selected", "model_tool_call", "tool_status", "report_ready", "worker_started"]);
    const attemptEvents = [];
    let afterSeq = 0;
    while (true) {
      const previousSeq = afterSeq;
      const page = this.#store.readEvents(taskId, afterSeq, 200, "raw");
      for (const event of page.events) {
        const eventTime = Date.parse(event.at);
        if (!Number.isFinite(startTime) || !Number.isFinite(eventTime) || eventTime < startTime) continue;
        if (relevantTypes.has(event.type)) attemptEvents.push(event);
      }
      afterSeq = page.nextSeq;
      if (!page.hasMore || page.nextSeq <= previousSeq) break;
    }
    let currentWorkerStarted: TaskProgressEvent | null = null;
    for (const event of attemptEvents) {
      if (event.type === "worker_started" && event.details?.["attempt"] === status.attempt) currentWorkerStarted = event;
    }
    const events = attemptEvents.filter((event) => {
      if (event.type === "worker_started") return false;
      if (!currentWorkerStarted) return true; // Legacy events lack attempt on worker_started; timestamp scoped above.
      return event.seq > currentWorkerStarted.seq;
    });
    const result = isTerminalStatus(status.status) ? this.#store.readResult(taskId) : null;
    return buildTaskFeedbackSnapshotV01({ status: toPublicStatus(status), events, result });
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return (async () => {
      this.#requireTask(taskId);
      const status = this.#store.readStatus(taskId);
      if (!isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} is not finished (status: ${status.status})`,
        );
      }
      const result = this.#store.readResult(taskId);
      if (!result) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} has terminal status ${status.status} but no persisted result`,
        );
      }
      return result;
    })();
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    return this.#exclusive(async () => {
      this.#requireTask(input.task_id);
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 512) {
        throw new TaskManagerError("TASK_INVALID", "request_id must be a non-empty string up to 512 characters");
      }
      const status = this.#store.readStatus(input.task_id);
      if (status.status !== "running") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction can only be answered while the task is running (status: ${status.status})`);
      }
      const record = this.#store.readInteractionRequest(input.task_id, input.request_id);
      if (!record) throw new TaskManagerError("TASK_NOT_FOUND", `unknown ZCode interaction request: ${input.request_id}`);
      if (record.state === "answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      const answer = buildInteractionAnswer(record, input);
      const state = this.#store.answerInteractionRequest(input.task_id, input.request_id, answer, this.#now().toISOString());
      if (state !== "answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      this.#store.appendEvent(input.task_id, "interaction_reply_submitted", "the calling host submitted a response to the ZCode interaction", {
        request_id: input.request_id,
        method: record.method,
        decision: input.decision,
      });
      return { task_id: input.task_id, request_id: input.request_id, state: "answered" };
    });
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      const taskId = input.task_id;
      this.#requireTask(taskId);
      if (typeof input.feedback !== "string" || input.feedback.trim().length === 0) {
        throw new TaskManagerError("TASK_INVALID", "feedback must be a non-empty string");
      }
      if (
        input.additional_requirements !== undefined &&
        (!Array.isArray(input.additional_requirements) ||
          input.additional_requirements.some((item) => typeof item !== "string"))
      ) {
        throw new TaskManagerError("TASK_INVALID", "additional_requirements must be an array of strings");
      }
      const status = this.#store.readStatus(taskId);
      const continueFingerprint = createHash("sha256").update(stableJson({ feedback: input.feedback, additional_requirements: input.additional_requirements ?? [] })).digest("hex");
      if (input.operation_id !== undefined && (typeof input.operation_id !== "string" || !input.operation_id.trim() || input.operation_id.length > 128)) {
        throw new TaskManagerError("TASK_INVALID", "operation_id must be a non-empty string up to 128 characters");
      }
      if (input.operation_id) {
        for (let attempt = 2; attempt <= status.attempt; attempt += 1) {
          const prior = this.#store.readAttemptMeta<{ operation_id?: string; fingerprint?: string; receipt?: TaskReceipt }>(taskId, attempt, "continue.json");
          if (prior?.operation_id !== input.operation_id) continue;
          if (prior.fingerprint !== continueFingerprint) throw new TaskManagerError("CONTINUE_OPERATION_CONFLICT", "operation_id already belongs to different continuation input");
          if (prior.receipt) return prior.receipt;
          return { task_id: taskId, status: status.status === "running" ? "running" : "queued", created_at: status.created_at };
        }
      }
      if (!["completed", "failed", "waiting_for_master"].includes(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_continue is not allowed from status ${status.status}`,
        );
      }
      if (status.cleanup_unverified) throw new TaskManagerError("TASK_STATE", "Cannot continue until unverified ZCode process cleanup is resolved");
      const task = this.#store.readTask(taskId);
      // The continuation reuses the original workspace; it must still resolve
      // to the same canonical directory.
      try {
        const ref = await this.#workspaceProvider.resolve(task.workspace, taskId, task.worktree_path);
        const recorded = this.#store.readWorkspaceRef(taskId);
        if (recorded && (ref.canonicalPath !== recorded.canonicalPath || ref.requestedPath !== recorded.requestedPath)) {
          throw new Error(`project or execution workspace no longer resolves to its recorded path`);
        }
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const previousAttempt = status.attempt;
      const previousResult = this.#store.readResult(taskId);
      try { buildContinuePrompt({ task, feedback: input.feedback, additionalRequirements: input.additional_requirements ?? [], previousSessionId: previousResult?.session_id ?? status.zcode_session_id, previousResult }); }
      catch (error) { throw new TaskManagerError("TASK_INVALID", String(error)); }
      const nextAttempt = previousAttempt + 1;
      const createdAt = this.#now().toISOString();
      const continuationReceipt: TaskReceipt = { task_id: taskId, status: "queued", created_at: createdAt };

      // Preserve prior evidence: the previous terminal result is archived into
      // its attempt directory before the new attempt starts.
      this.#store.archiveResultToAttempt(taskId, previousAttempt);
      this.#store.writeAttemptMeta(taskId, nextAttempt, "continue.json", {
        ...(input.operation_id ? { operation_id: input.operation_id, fingerprint: continueFingerprint, receipt: continuationReceipt } : {}),
        feedback: input.feedback,
        additional_requirements: [...(input.additional_requirements ?? [])],
        previous_session_id: previousResult?.session_id ?? status.zcode_session_id,
        previous_attempt: previousAttempt,
      });
      this.#store.writeStatus(taskId, {
        status: "queued",
        attempt: nextAttempt,
        started_at: null,
        finished_at: null,
        worker_pid: null,
        zcode_session_id: null,
        exit_code: null,
        error_code: null,
        error: null,
        cancel_requested: null,
        zcode_pid: null,
        cleanup_unverified: null,
      });
      this.#pumpLocked();
      const after = this.#store.readStatus(taskId);
      const receipt: TaskReceipt = {
        task_id: taskId,
        status: after.status === "running" ? "running" : "queued",
        created_at: after.updated_at,
      };
      if (input.operation_id) this.#store.writeAttemptMeta(taskId, nextAttempt, "continue.json", {
        ...this.#store.readAttemptMeta(taskId, nextAttempt, "continue.json"),
        receipt,
      });
      return receipt;
    });
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    return this.#exclusive(async () => {
      this.#requireTask(taskId);
      const status = this.#store.readStatus(taskId);
      if (status.cleanup_unverified) {
        if (!status.zcode_pid) throw new TaskManagerError("CANCEL_FAILED", "No ZCode process identity is available to verify cleanup");
        try {
          await this.#terminateProcessTree(status.zcode_pid, { graceMs: 500, killWaitMs: 5_000 });
          if (status.status === "running" && status.worker_pid && this.#isProcessRunning(status.worker_pid)) await this.#terminateProcessTree(status.worker_pid, { graceMs: 500, killWaitMs: 5_000 });
        }
        catch (error) { throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: ${String(error)}`); }
        if (status.status === "running") {
          const finishedAt = this.#now().toISOString();
          const result = buildTaskResult({ task: this.#store.readTask(taskId), attempt: status.attempt, startedAt: status.started_at, finishedAt, outcome: null, cancelled: true, sessionId: status.zcode_session_id });
          this.#store.writeResult(taskId, result);
          this.#store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt, worker_pid: null, cleanup_unverified: null, zcode_pid: null, error: null, error_code: null, cancel_requested: null });
        } else this.#store.writeStatus(taskId, { cleanup_unverified: null, zcode_pid: null });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      if (isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_cancel is not allowed from status ${status.status}`,
        );
      }
      const task = this.#store.readTask(taskId);

      if (status.status === "running" && this.#store.readResult(taskId)) {
        this.#reconcileOneLocked(taskId);
        return toPublicStatus(this.#store.readStatus(taskId));
      }

      if (status.status === "queued") {
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: null,
          finishedAt,
          outcome: null,
          failure: { code: "cancelled", message: "cancelled by request before the task started" },
          cancelled: true,
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt });
        this.#store.appendEvent(taskId, "cancelled", "Queued task cancelled before worker start", undefined, finishedAt);
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }

      // Running: persist the intent, then terminate and verify the worker
      // process tree before recording the cancelled terminal state.
      this.#store.writeStatus(taskId, { cancel_requested: true });
      this.#store.appendEvent(taskId, "cancel_requested", "Cancellation requested; waiting for process-tree confirmation");
      const pid = status.worker_pid;
      if (pid === null) {
        // No worker process was recorded; nothing to terminate, record loss.
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt,
          outcome: null,
          failure: { code: "worker_lost", message: "running task had no worker pid recorded" },
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, {
          status: "failed",
          finished_at: finishedAt,
          error_code: "worker_lost",
          error: result.summary,
        });
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      const finishedSafely = (): boolean => {
        const result = this.#store.readResult(taskId);
        return result !== null && result.error_code !== "cleanup_failed"
          && !this.#store.readStatus(taskId).cleanup_unverified
          && !this.#isProcessRunning(pid)
          && (!status.zcode_pid || !this.#isProcessRunning(status.zcode_pid));
      };
      const waitForSafeExit = async (): Promise<boolean> => {
        const deadline = Date.now() + 500;
        do {
          if (finishedSafely()) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return finishedSafely();
      };
      // Let the worker abort its interaction/RPC and verify its own runtime
      // cleanup first. Concurrent taskkill calls can race an ordinary exit.
      try {
        if (!(await waitForSafeExit())) {
          if (process.platform !== "win32" && status.zcode_pid && this.#isProcessRunning(status.zcode_pid)) {
            await this.#terminateProcessTree(status.zcode_pid, { graceMs: 500, killWaitMs: 5_000 });
          }
          await this.#terminateProcessTree(pid, { graceMs: 500, killWaitMs: 5_000 });
        }
      } catch (error) {
        if (!(await waitForSafeExit())) {
          const message = error instanceof Error ? error.message : String(error);
          this.#store.writeStatus(taskId, {
            error: `cancellation could not be verified: ${message}`,
          });
          this.#store.appendEvent(taskId, "cancel_failed", message);
          throw new TaskManagerError(
            "CANCEL_FAILED",
            `process-tree termination for task ${taskId} (pid ${pid}) could not be verified: ${message}`,
          );
        }
      }
      // The worker may have completed while termination was in flight; a
      // persisted terminal result always wins over our cancellation.
      const raced = this.#store.readResult(taskId);
      if (raced) {
        this.#store.writeStatus(taskId, {
          status: raced.status,
          finished_at: raced.finished_at,
          exit_code: raced.exit_code,
          zcode_session_id: raced.session_id,
          error_code: raced.error_code ?? null,
          error: raced.status === "failed" ? raced.summary : null,
          worker_pid: null,
          cancel_requested: null,
          cleanup_unverified: null,
          zcode_pid: null,
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      const finishedAt = this.#now().toISOString();
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: status.started_at,
        finishedAt,
        outcome: null,
        failure: {
          code: "cancelled",
          message: `cancelled by request; worker process tree (pid ${pid}) was terminated and verified`,
        },
        cancelled: true,
        sessionId: status.zcode_session_id,
      });
      this.#store.writeResult(taskId, result);
      this.#store.appendEvent(taskId, "cancelled", "Worker process tree terminated and cancellation confirmed", undefined, finishedAt);
      this.#store.writeStatus(taskId, {
        status: "cancelled",
        finished_at: finishedAt,
        worker_pid: null,
        cleanup_unverified: null,
        zcode_pid: null,
        cancel_requested: null,
      });
      this.#pumpLocked();
      return toPublicStatus(this.#store.readStatus(taskId));
    });
  }

  // ---- internals (must be called under the mutex) ----

  #reconcileOneLocked(taskId: string): void {
    const status = this.#store.readStatus(taskId);
    if (status.status === "running") {
      this.#reconcileRunningLocked(taskId, status);
    }
  }

  #reconcileRunningLocked(taskId: string, status: { worker_pid: number | null; attempt: number; started_at: string | null; zcode_pid?: number | null; zcode_session_id?: string | null }): void {
    const persistedResult = this.#store.readResult(taskId);
    if (persistedResult && persistedResult.attempt === status.attempt) {
      // The worker wrote the result but died before updating the status file.
      this.#store.writeStatus(taskId, {
        status: persistedResult.status,
        finished_at: persistedResult.finished_at,
        exit_code: persistedResult.exit_code,
        zcode_session_id: persistedResult.session_id,
        error_code: persistedResult.error_code ?? null,
        error: persistedResult.status === "failed" ? persistedResult.summary : null,
        worker_pid: null,
        cleanup_unverified: persistedResult.error_code === "cleanup_failed",
      });
      return;
    }
    const pid = status.worker_pid;
    const heartbeat = this.#store.readWorkerHeartbeat(taskId, status.attempt);
    const heartbeatAt = heartbeat ? Date.parse(heartbeat.heartbeat_at) : Number.NaN;
    const heartbeatAgeMs = this.#now().getTime() - heartbeatAt;
    // A fresh heartbeat is attempt- and PID-bound. Prefer this live worker
    // evidence over a single negative OS liveness probe; a dead worker merely
    // delays recovery by at most the heartbeat freshness window.
    if (pid !== null && heartbeat?.worker_pid === pid && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 15_000) return;
    const alive = pid !== null && this.#isProcessRunning(pid);
    if (alive) return; // still running (possibly from before a manager restart)
    const runtimePid = status.zcode_pid ?? null;
    if (runtimePid && this.#isProcessRunning(runtimePid)) {
      if (this.#recoverOutcomeCheckpoint(taskId, status, runtimePid, false)) return;
      this.#store.writeStatus(taskId, { cleanup_unverified: true, error_code: "cleanup_failed", error: "Worker exited while ZCode remains alive; cancel to verify runtime cleanup" });
      return;
    }
    if (this.#recoverOutcomeCheckpoint(taskId, status, runtimePid, true)) return;
    // Cold-start grace. Several Bridge processes may share one data root, and
    // any of them can reconcile a task between the "running" status write and
    // the pid write in #startWorkerLocked (worker_pid null), while a freshly
    // spawned worker may die or look dead before it wrote started.json. A
    // state this fresh must not finalize worker_lost; the next tick
    // re-checks, so a genuine loss is reported once the grace expires.
    const startedAtMs = status.started_at === null ? Number.NaN : Date.parse(status.started_at);
    const withinGrace = Number.isFinite(startedAtMs) && this.#now().getTime() - startedAtMs < this.#workerStartGraceMs;
    const workerBegan = this.#store.readAttemptMeta(taskId, status.attempt, "started.json") !== null;
    if (pid === null && withinGrace) return; // possibly still inside the spawn window
    if (pid !== null && workerBegan && withinGrace) return; // outcome may still be in flight
    // A worker that exited before writing started.json never ran the task.
    // Spawn one replacement for the same attempt, claim-gated so the Bridge
    // processes sharing this data root cannot double-spawn; a replacement
    // that is still in flight (fresh claim) is left alone for the next tick.
    // A worker that did start is never auto-respawned: its attempt may have
    // already touched the workspace, so only the master decides to retry.
    if (!workerBegan) {
      if (this.#store.claimAttemptRespawn(taskId, status.attempt)) {
        const respawned = this.#spawnWorker(this.#dataRoot, taskId, status.attempt);
        this.#store.writeStatus(taskId, { worker_pid: respawned.pid });
        this.#store.appendEvent(
          taskId,
          "worker_respawned",
          `Bridge respawned the worker: previous pid ${String(pid)} exited before writing any task state`,
          { worker_pid: respawned.pid, previous_pid: pid, attempt: status.attempt },
        );
        return;
      }
      const claimedAt = this.#store.respawnClaimedAt(taskId, status.attempt);
      if (claimedAt && Date.now() - claimedAt.getTime() < BridgeTaskManager.RESPAWN_IN_FLIGHT_MS) return; // another process's respawn is in flight
      // Stale claim and still no started.json: the replacement died too.
    }
    const task = this.#store.readTask(taskId);
    const finishedAt = this.#now().toISOString();
    const workerStderr = this.#store.readAttemptText(taskId, status.attempt, "worker-stderr.log") ?? "";
    const failure: TaskFailure = {
      code: "worker_lost",
      message: `worker pid ${String(pid)} is gone without a terminal result${workerStderr.trim() ? "; diagnostic stderr is available in private attempt evidence" : "; worker stderr was empty"}`,
    };
    const result = buildTaskResult({
      task,
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome: null,
      failure,
      sessionId: status.zcode_session_id,
    });
    this.#store.writeResult(taskId, result);
    this.#store.writeStatus(taskId, {
      status: "failed",
      finished_at: finishedAt,
      error_code: "worker_lost",
      error: result.summary,
      worker_pid: null,
    });
    this.#store.appendEvent(taskId, "error", result.summary, { error_code: "worker_lost" }, finishedAt);
  }

  #recoverOutcomeCheckpoint(
    taskId: string,
    status: { attempt: number; started_at: string | null; zcode_session_id?: string | null },
    runtimePid: number | null,
    runtimeExited: boolean,
  ): boolean {
    const checkpoint = this.#store.readAttemptMeta<Record<string, unknown>>(taskId, status.attempt, "outcome-checkpoint.json");
    if (!checkpoint || typeof checkpoint.response !== "string") return false;
    const outcome = {
      attempts: 1,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdout: checkpoint.response,
      stderr: "",
      exitCode: typeof checkpoint.exit_code === "number" ? checkpoint.exit_code : null,
      signal: typeof checkpoint.signal === "string" ? checkpoint.signal : null,
      sessionId: typeof checkpoint.session_id === "string" ? checkpoint.session_id : null,
      response: checkpoint.response,
      usage: checkpoint.usage && typeof checkpoint.usage === "object" ? checkpoint.usage : null,
      timedOut: false,
      agentReport: checkpoint.agent_report ?? null,
      reportCandidate: checkpoint.report_candidate && typeof checkpoint.report_candidate === "object" ? checkpoint.report_candidate : null,
      reportError: typeof checkpoint.report_error === "string" ? checkpoint.report_error : null,
      errorCode: typeof checkpoint.error_code === "string" ? checkpoint.error_code : null,
      cleanupError: typeof checkpoint.cleanup_error === "string" ? checkpoint.cleanup_error : null,
      cleanupVerified: checkpoint.cleanup_verified === true,
    } as ZCodeRunOutcome;
    const cleanupVerified = outcome.cleanupVerified && runtimeExited;
    const failure: TaskFailure | null = cleanupVerified ? null : {
      code: "cleanup_failed",
      message: outcome.cleanupError ?? "Worker exited before process cleanup could be verified; the ZCode result was recovered from its private checkpoint",
    };
    const finishedAt = this.#now().toISOString();
    const result = buildTaskResult({
      task: this.#store.readTask(taskId),
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome,
      failure,
      sessionId: status.zcode_session_id ?? outcome.sessionId,
    });
    this.#store.commitWorkerResult(taskId, status.attempt, result, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      zcode_session_id: result.session_id,
      error_code: result.error_code ?? null,
      error: result.status === "failed" ? result.summary : null,
      worker_pid: null,
      cleanup_unverified: !cleanupVerified,
      zcode_pid: cleanupVerified ? null : runtimePid,
    });
    this.#store.appendEvent(taskId, "outcome_recovered", cleanupVerified
      ? "Recovered the completed ZCode report after the worker exited before committing its result"
      : "Recovered the ZCode report, but process cleanup could not be verified",
    { status: result.status, cleanup_verified: cleanupVerified }, finishedAt);
    return true;
  }

  #runningTaskIdsLocked(): string[] {
    return this.#store.listTaskIds().filter((taskId) => { const status = this.#safeStatus(taskId); return status?.status === "running" || status?.cleanup_unverified === true; });
  }

  #queuedTaskIdsLocked(): string[] {
    return this.#store
      .listTaskIds()
      .map((taskId) => ({ taskId, status: this.#safeStatus(taskId) }))
      .filter((entry) => entry.status?.status === "queued")
      .sort((a, b) => a.status!.created_at.localeCompare(b.status!.created_at))
      .map((entry) => entry.taskId);
  }

  #pumpLocked(): void {
    const running = this.#runningTaskIdsLocked();
    if (running.length >= this.#maxConcurrentWorkers) return;

    const occupiedPaths = running.map((taskId) => this.#executionPathKeyLocked(taskId));
    for (const taskId of this.#store.listTaskIds()) {
      if (this.#safeStatus(taskId)) continue;
      try { occupiedPaths.push(this.#executionPathKeyLocked(taskId)); }
      catch { return; } // Unknown execution scope cannot be safely released.
    }
    let slots = this.#maxConcurrentWorkers - running.length;
    for (const taskId of this.#queuedTaskIdsLocked()) {
      if (slots <= 0) break;
      const executionPath = this.#executionPathKeyLocked(taskId);
      // Never run two ZCode sessions against the same mutable directory.
      // Separate the calling host-prepared worktrees and separate project roots can run
      // concurrently, subject to the global worker limit.
      if (occupiedPaths.some((occupied) => pathsOverlap(occupied, executionPath))) continue;
      this.#startWorkerLocked(taskId);
      if (this.#store.readStatus(taskId).status === "running") {
        occupiedPaths.push(executionPath);
        slots -= 1;
      }
    }
  }

  #executionPathKeyLocked(taskId: string): string {
    const recorded = this.#store.readWorkspaceRef(taskId)?.canonicalPath;
    const task = recorded ? null : this.#store.readTask(taskId);
    const resolved = path.resolve(recorded ?? task!.worktree_path ?? task!.workspace);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  }

  #startWorkerLocked(taskId: string): void {
    const status = this.#store.readStatus(taskId);
    if (status.status !== "queued") return;
    this.#store.writeStatus(taskId, {
      status: "running",
      started_at: this.#now().toISOString(),
      worker_pid: null,
    });
    let pid: number;
    try {
      const spawned = this.#spawnWorker(this.#dataRoot, taskId, status.attempt);
      pid = spawned.pid;
    } catch (error) {
      const finishedAt = this.#now().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const task = this.#store.readTask(taskId);
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: null,
        finishedAt,
        outcome: null,
        failure: { code: "spawn_failed", message },
      });
      this.#store.writeResult(taskId, result);
      this.#store.writeStatus(taskId, {
        status: "failed",
        finished_at: finishedAt,
        error_code: "spawn_failed",
        error: result.summary,
      });
      this.#store.appendEvent(taskId, "error", result.summary, { error_code: "spawn_failed" }, finishedAt);
      return;
    }
    this.#store.patchRunningAttempt(taskId, status.attempt, { worker_pid: pid });
    this.#store.appendEvent(taskId, "worker_started", "Bridge worker started", { worker_pid: pid, attempt: status.attempt });
  }

  #requireTask(taskId: string): void {
    if (!this.#store.hasTask(taskId)) {
      throw new TaskManagerError("TASK_NOT_FOUND", `unknown task_id: ${taskId}`);
    }
  }

  #validateTaskPackage(task: TaskPackage): void {
    if (typeof task !== "object" || task === null) {
      throw new TaskManagerError("TASK_INVALID", "task package must be an object");
    }
    if (typeof task.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.task_id)) {
      throw new TaskManagerError(
        "TASK_INVALID",
        "task_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}",
      );
    }
    if (typeof task.objective !== "string" || task.objective.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "objective must be a non-empty string");
    }
    for (const field of [
      "requirements",
      "allowed_paths",
      "forbidden_paths",
      "acceptance_criteria",
      "test_commands",
    ] as const) {
      const value = task[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new TaskManagerError("TASK_INVALID", `${field} must be an array of strings (may be empty)`);
      }
    }
    if (task.context !== undefined && typeof task.context !== "string") {
      throw new TaskManagerError("TASK_INVALID", "context must be a string when present");
    }
    if (task.timeout_ms !== undefined) {
      try {
        validateTaskTimeout(task.timeout_ms);
      } catch (error) {
        throw new TaskManagerError("TASK_INVALID", error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof task.workspace !== "string" || task.workspace.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "workspace is required");
    }
    if (task.worktree_path !== undefined && (typeof task.worktree_path !== "string" || task.worktree_path.trim().length === 0)) {
      throw new TaskManagerError("TASK_INVALID", "worktree_path must be a non-empty absolute path when present");
    }
    if (task.model !== undefined && (
      typeof task.model !== "object" || task.model === null ||
      typeof task.model.provider_id !== "string" || task.model.provider_id.trim().length === 0 ||
      typeof task.model.model_id !== "string" || task.model.model_id.trim().length === 0 ||
      (task.model.reasoning_level !== undefined &&
        (typeof task.model.reasoning_level !== "string" || task.model.reasoning_level.trim().length === 0))
    )) {
      throw new TaskManagerError("TASK_INVALID", "model must include non-empty provider_id and model_id strings");
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queuedOperations >= 32) return Promise.reject(new TaskManagerError("BRIDGE_BUSY", "Bridge operation queue is full; retry with the same task_id"));
    this.#queuedOperations += 1;
    let started = false;
    let expired = false;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeout = setTimeout(() => {
      if (started) return;
      expired = true;
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      rejectTimeout?.(new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not start within 5 seconds; retry with the same task_id"));
    }, 5_000);
    const locked = async () => {
      if (expired) throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation expired before it started");
      started = true;
      clearTimeout(timeout);
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      try {
        return await withProcessLock(path.join(this.#store.tasksRoot, ".manager.lock"), operation, 5_000);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("timed out waiting for process lock:")) {
          throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not acquire the shared scheduling lock within 5 seconds; retry with the same task_id");
        }
        throw error;
      }
    };
    const run = this.#mutex.then(locked, locked);
    const bounded = new Promise<T>((resolve, reject) => {
      rejectTimeout = reject;
      run.then(resolve, reject);
    });
    this.#mutex = run.catch(() => undefined);
    return bounded;
  }

  #safeStatus(taskId: string): ReturnType<TaskStore["readStatus"]> | null {
    try {
      const status = this.#store.readStatus(taskId);
      this.#store.readTask(taskId);
      this.#store.readWorkspaceRef(taskId);
      this.#store.readResult(taskId);
      this.#store.readAttemptMeta(taskId, status.attempt, "started.json");
      this.#store.readAttemptMeta(taskId, status.attempt, "continue.json");
      return status;
    } catch (error) {
      console.error(`Bridge skipped corrupt task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  const inside = (value: string): boolean => value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
  return inside(relative) || inside(reverse);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function buildInteractionAnswer(
  record: import("../interfaces.js").ZCodeInteractionRecord,
  input: ZCodeInteractionReplyInput,
): Record<string, unknown> {
  const params = record.params;
  if (record.method === "interaction/requestPermission") {
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new TaskManagerError("TASK_INVALID", "permission requests require decision allow or deny");
    }
    if (input.decision === "allow") {
      const options = Array.isArray(params.options) ? params.options : [];
      const canAllow = options.some((option) => {
        const item = asRecord(option);
        return typeof item.kind === "string" && item.kind.startsWith("allow");
      });
      if (!canAllow) throw new TaskManagerError("TASK_INVALID", "ZCode did not offer an allow option for this request");
    }
    return {
      decision: input.decision,
      ...(input.decision === "deny" ? { reason: boundedReason(input.reason) } : {}),
    };
  }

  if (input.decision !== "accept" && input.decision !== "decline") {
    throw new TaskManagerError("TASK_INVALID", "user input requests require decision accept or decline");
  }
  if (input.decision === "decline") return { action: "decline" };
  if (asRecord(params.schema).interaction === "plan_approval") {
    return { action: "accept", content: { answer_0: "approve" } };
  }

  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(asRecord(params.input).questions) ? asRecord(params.input).questions as unknown[] : [];
  const validQuestions = rawQuestions
    .map(asRecord)
    .filter((question) => typeof question.question === "string")
    .map((question) => question.question as string);
  if (!validQuestions.length) throw new TaskManagerError("TASK_INVALID", "ZCode request has no supported questions");
  const answers = input.answers ?? {};
  const answerKeys = Object.keys(answers);
  if (!answerKeys.length) throw new TaskManagerError("TASK_INVALID", "accepting an AskUserQuestion requires answers");
  if (answerKeys.some((question) => !validQuestions.includes(question))) {
    throw new TaskManagerError("TASK_INVALID", "answers must be keyed by the exact ZCode question text");
  }
  for (const [question, value] of Object.entries(answers)) {
    if (!value.trim() || value.length > 4_000) {
      throw new TaskManagerError("TASK_INVALID", `answer for '${question.slice(0, 80)}' must be non-empty and at most 4000 characters`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(answers), "utf8") > 16_000) {
    throw new TaskManagerError("TASK_INVALID", "combined ZCode answers exceed the 16 KB limit");
  }
  return { action: "accept", content: { answers } };
}

function boundedReason(reason: string | undefined): string {
  return (reason?.trim() || "the calling host declined this request").slice(0, 2_000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
