// ADR-010 ScheduleController: the shared facade behind the four scheduling
// tools and the supervised runner. It composes the existing TaskManager —
// never replacing its queue/attempt/cleanup logic — and serializes every
// schedule-state mutation through a per-schedule process lock (ordering is
// always schedule lock → manager lock; nothing takes them the other way).
// Wakeup events are persisted to the outbox BEFORE any send; delivery is
// at-least-once (a lost receipt may duplicate) and failures keep retry state.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TaskManager, TaskReceipt, TaskStatusRecord, TaskResult } from "../interfaces.js";
import { TaskManagerError } from "../manager/errors.js";
import { boundedErrorMessage } from "../observation/diagnostics.js";
import { stableJson } from "../store/task-store.js";
import { withProcessLock } from "../store/process-lock.js";
import { ScheduleError } from "./errors.js";
import {
  buildEventId,
  buildNotificationMessage,
  buildReviewContinueFeedback,
  deriveScheduledTask,
  reviewContinueOperationId,
} from "./policy.js";
import type { ScheduleStore } from "./store.js";
import type { Supervisor } from "./supervisor.js";
import { planSystemdRunUnit } from "./supervisor.js";
import type {
  ScheduleAttentionReason,
  ScheduleNotification,
  ScheduleSpec,
  ScheduleState,
} from "./types.js";
import { START_AT_PATTERN, THREAD_ID_PATTERN } from "./types.js";

export interface ScheduleNotifier {
  send(input: { pipePath: string; threadId: string; callId: string; message: string }): Promise<void>;
}

export interface ScheduleControllerOptions {
  readonly store: ScheduleStore;
  readonly manager: TaskManager;
  readonly supervisor: Supervisor;
  readonly runnerEntryPath: string;
  readonly dataRoot: string;
  readonly env: NodeJS.ProcessEnv;
  /** Delivering side (the supervised runner); absent on MCP-only controllers. */
  readonly notifier?: ScheduleNotifier;
  readonly nodeExecutable?: string;
  readonly now?: () => Date;
}

export interface SubmitScheduleInput {
  readonly task: ScheduleSpec["task"];
  readonly start_at: string;
  readonly thread_id: string;
}

export interface ScheduleSubmitReceipt {
  readonly task_id: string;
  readonly status: ScheduleState["status"];
  readonly start_at: string;
  readonly thread_id: string;
  readonly created_at: string;
  readonly supervisor: { unit: string; log_path: string } | null;
}

export interface ScheduleExecutionView {
  readonly status: TaskStatusRecord["status"];
  readonly attempt: number;
  readonly error_code?: string;
  readonly needs_master_decision: boolean | null;
  readonly acceptance_met?: boolean;
}

export interface ScheduleStatusView {
  readonly task_id: string;
  readonly schedule: {
    readonly status: ScheduleState["status"];
    readonly start_at: string;
    readonly thread_id: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly cancel_requested: boolean;
    readonly supervisor: { unit: string; log_path: string } | null;
    readonly failure_reason: string | null;
  };
  readonly execution: ScheduleExecutionView | null;
  readonly goal: {
    readonly attention: ScheduleState["attention"];
    readonly attempt_under_review: number | null;
    readonly review: ScheduleState["review"];
  };
  readonly notifications: Array<{
    readonly event_id: string;
    readonly reason: ScheduleAttentionReason;
    readonly attempt: number;
    readonly delivery: ScheduleNotification["delivery"];
  }>;
}

export interface ReviewScheduleInput {
  readonly task_id: string;
  readonly attempt: number;
  readonly accepted: boolean;
  readonly feedback?: string;
}

export type ReviewOutcome =
  | { readonly task_id: string; readonly attempt: number; readonly accepted: true; readonly action: "accepted" }
  | { readonly task_id: string; readonly attempt: number; readonly accepted: false; readonly action: "continued"; readonly receipt: TaskReceipt };

const DELIVERY_BACKOFF_BASE_MS = 30_000;
const DELIVERY_BACKOFF_MAX_MS = 10 * 60_000;

export class ScheduleController {
  readonly #store: ScheduleStore;
  readonly #manager: TaskManager;
  readonly #supervisor: Supervisor;
  readonly #runnerEntryPath: string;
  readonly #dataRoot: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #notifier: ScheduleNotifier | null;
  readonly #nodeExecutable: string | undefined;
  readonly #now: () => Date;

  constructor(options: ScheduleControllerOptions) {
    this.#store = options.store;
    this.#manager = options.manager;
    this.#supervisor = options.supervisor;
    this.#runnerEntryPath = options.runnerEntryPath;
    this.#dataRoot = options.dataRoot;
    this.#env = options.env;
    this.#notifier = options.notifier ?? null;
    this.#nodeExecutable = options.nodeExecutable;
    this.#now = options.now ?? (() => new Date());
  }

  get store(): ScheduleStore {
    return this.#store;
  }

  readSpec(taskId: string): ScheduleSpec {
    return this.#store.readSpec(taskId);
  }

  readState(taskId: string): ScheduleState {
    return this.#store.readState(taskId);
  }

  /** The MCP host refreshes the App pipe location on reconnection; the
   * runner resolves it from this record per send. */
  noteAppPipePath(pipePath: string | null): void {
    this.#store.writeRuntime({ app_pipe_path: pipePath, updated_at: this.#now().toISOString() });
  }

  async submit(input: SubmitScheduleInput): Promise<ScheduleSubmitReceipt> {
    // Boundary: core hosts and MCP supply an absolute, timezone-qualified start and explicit chat UUID.
    if (!Number.isFinite(Date.parse(input.start_at)) || !START_AT_PATTERN.test(input.start_at)) {
      throw new ScheduleError("SCHEDULE_INVALID", "start_at must be an ISO 8601 datetime with a timezone offset");
    }
    if (!THREAD_ID_PATTERN.test(input.thread_id)) {
      throw new ScheduleError("SCHEDULE_INVALID", "thread_id must be a UUID identifying the original Codex chat");
    }
    const taskId = input.task.task_id;
    mkdirSync(this.#store.scheduleDir(taskId), { recursive: true, mode: 0o700 });
    return withProcessLock(path.join(this.#store.scheduleDir(taskId), "state.lock"), async () => {
      let spec: ScheduleSpec;
      if (this.#store.hasSchedule(taskId)) {
        spec = this.#store.readSpec(taskId);
        if (stableJson({ task: spec.task, start_at: spec.start_at, thread_id: spec.thread_id })
          !== stableJson({ task: input.task, start_at: input.start_at, thread_id: input.thread_id })) {
          throw new ScheduleError("SCHEDULE_CONFLICT", `schedule ${taskId} already exists with a different request`);
        }
      } else {
        const existing = await this.#manager.getStatus(taskId).catch((error: unknown) => {
          if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
          throw error;
        });
        if (existing !== null) throw new ScheduleError("SCHEDULE_CONFLICT", `task_id ${taskId} already belongs to a non-scheduled Bridge task`);
        spec = { task_id: taskId, task: input.task, start_at: input.start_at, thread_id: input.thread_id,
          created_at: this.#now().toISOString(), supervisor_unit: `zcode-bridge-schedule-${randomUUID()}` };
        this.#store.writeSpec(spec);
      }
      // A crash between spec/state writes is recoverable from the committed spec.
      let state = this.#store.hasState(taskId) ? this.#store.readState(taskId) : initialState(taskId, spec.created_at);
      this.#store.writeState(state);
      if (!["accepted", "cancelled", "failed"].includes(state.status)) state = await this.#startLocked(spec, state);
      return this.#receiptFrom(spec, state);
    }, 60_000);
  }

  async #startLocked(spec: ScheduleSpec, state: ScheduleState): Promise<ScheduleState> {
    const plan = planSystemdRunUnit({ unit: spec.supervisor_unit, runnerEntryPath: this.#runnerEntryPath,
      scheduleDir: this.#store.scheduleDir(spec.task_id), dataRoot: this.#dataRoot,
      taskId: spec.task_id, env: this.#env, nodeExecutable: this.#nodeExecutable });
    // Persist supervisor identity before starting; a lost receipt reuses the same unit.
    const prepared: ScheduleState = { ...state, supervisor: state.supervisor ?? {
      unit: spec.supervisor_unit, log_path: plan.logPath, started_at: null }, updated_at: this.#now().toISOString() };
    this.#store.writeState(prepared);
    try {
      await this.#supervisor.start(plan);
    } catch (error) {
      this.#store.writeState({ ...prepared, failure_reason: boundedErrorMessage(error, 500), updated_at: this.#now().toISOString() });
      throw error;
    }
    const started: ScheduleState = { ...prepared, failure_reason: null, supervisor: {
      unit: plan.unit, log_path: plan.logPath, started_at: prepared.supervisor!.started_at ?? this.#now().toISOString() }, updated_at: this.#now().toISOString() };
    this.#store.writeState(started);
    return started;
  }

  async status(taskId: string): Promise<ScheduleStatusView> {
    const spec = this.#store.readSpec(taskId);
    const state = this.#store.readState(taskId);
    return {
      task_id: taskId,
      schedule: {
        status: state.status,
        start_at: spec.start_at,
        thread_id: spec.thread_id,
        created_at: spec.created_at,
        updated_at: state.updated_at,
        cancel_requested: state.cancel_requested,
        supervisor: state.supervisor ? { unit: state.supervisor.unit, log_path: state.supervisor.log_path } : null,
        failure_reason: state.failure_reason,
      },
      execution: await this.#executionView(taskId),
      goal: {
        attention: state.attention,
        attempt_under_review: state.attempt_under_review,
        review: state.review,
      },
      notifications: this.#store.listNotifications(taskId).map((notification) => ({
        event_id: notification.event_id,
        reason: notification.reason,
        attempt: notification.attempt,
        delivery: notification.delivery,
      })),
    };
  }

  /** Idempotent dispatch of the derived task (runner + recovery entry). The
   * TaskManager's own submission idempotency prevents a second execution. */
  async dispatch(taskId: string): Promise<{ dispatched: boolean }> {
    return this.#locked(taskId, async (state, spec) => {
      if (state.status === "dispatched" || state.status === "awaiting_review") return { dispatched: true };
      if (state.cancel_requested || state.status !== "scheduled") return { dispatched: false };
      let receipt: TaskReceipt;
      try {
        receipt = await this.#manager.createTask(deriveScheduledTask(spec.task));
      } catch (error) {
        this.#failLocked(taskId, state, "dispatch_failed", boundedErrorMessage(error, 500));
        this.#enqueueLocked(taskId, spec, { attempt: 1, reason: "dispatch_failed", eventId: buildEventId(taskId, 1, "dispatch_failed"), errorCode: "dispatch_failed" });
        throw new ScheduleError("SCHEDULE_STATE", `scheduled task ${taskId} could not be dispatched: ${boundedErrorMessage(error, 300)}`);
      }
      this.#store.writeState({
        ...state,
        status: "dispatched",
        dispatched_at: this.#now().toISOString(),
        attention: null,
        updated_at: this.#now().toISOString(),
      });
      void receipt;
      return { dispatched: true };
    });
  }

  /** Quiet same-session continuation (acceptance_met=false or verified
   * timeout). Guarded against a persisted stop intent; operation_id makes a
   * crash-retry replay the same continuation. */
  async autoContinue(taskId: string, attempt: number, feedback: string, operationId: string): Promise<{ continued: boolean; reason?: string }> {
    return this.#locked(taskId, async (state) => {
      if (state.cancel_requested || ["cancelled", "accepted", "failed"].includes(state.status)) return { continued: false, reason: `schedule is ${state.status}` };
      const current = await this.#manager.getStatus(taskId);
      if (current.attempt > attempt) return { continued: true };
      if (current.observation?.cleanup !== "verified") return { continued: false, reason: "process cleanup is not verified" };
      const result = await this.#manager.getResult(taskId);
      if (result.session_id === null) return { continued: false, reason: "no saved ZCode session to resume" };
      try {
        await this.#manager.continueTask({ task_id: taskId, feedback, operation_id: operationId, expected_attempt: attempt });
      } catch (error) {
        return { continued: false, reason: boundedErrorMessage(error, 300) };
      }
      this.#store.writeState({ ...state, status: "dispatched", attempt_under_review: null, attention: null, updated_at: this.#now().toISOString() });
      return { continued: true };
    });
  }

  /** A new attempt began (also when the Codex host continued the task itself):
   * attention and a stale review window give way to active monitoring. */
  async noteActiveAttempt(taskId: string, attempt: number): Promise<void> {
    await this.#locked(taskId, async (state) => {
      if (state.status === "accepted" || state.status === "cancelled" || state.status === "failed") return;
      const reference = Math.max(state.attention?.attempt ?? 0, state.attempt_under_review ?? 0);
      if (attempt <= reference) return;
      this.#store.writeState({
        ...state,
        status: state.status === "awaiting_review" ? "dispatched" : state.status,
        attempt_under_review: null,
        attention: null,
        updated_at: this.#now().toISOString(),
      });
    });
  }

  /** Terminal attempt with acceptance_met=true: wake the original thread for
   * independent review; the goal now waits for zcode_schedule_review. */
  async requestReview(taskId: string, attempt: number): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      if (state.status === "awaiting_review" && state.attempt_under_review === attempt) return;
      const eventId = buildEventId(taskId, attempt, "review_requested");
      this.#enqueueLocked(taskId, spec, { attempt, reason: "review_requested", eventId });
      this.#store.writeState({
        ...state,
        status: "awaiting_review",
        attempt_under_review: attempt,
        attention: { reason: "review_requested", attempt, event_id: eventId, set_at: this.#now().toISOString() },
        updated_at: this.#now().toISOString(),
      });
    });
  }

  /** Persist the escalation and its wakeup event; no automatic retry or
   * approval ever follows. Idempotent per (attempt, reason, suffix). */
  async escalate(taskId: string, attempt: number, reason: ScheduleAttentionReason, options: { requestId?: string; errorCode?: string; detail?: string } = {}): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      const eventId = buildEventId(taskId, attempt, reason, options.requestId ?? "");
      if (state.attention?.event_id === eventId) return;
      this.#enqueueLocked(taskId, spec, { attempt, reason, eventId, requestId: options.requestId, errorCode: options.errorCode });
      this.#store.writeState({
        ...state,
        attention: { reason, attempt, event_id: eventId, set_at: this.#now().toISOString(), ...(options.detail !== undefined ? { detail: options.detail } : {}) },
        updated_at: this.#now().toISOString(),
      });
    });
  }

  /** Wake once per still-pending interaction request; never auto-replies. */
  async notifyPendingInteraction(taskId: string, attempt: number, request: { request_id: string; method: string }): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      if (state.notified_interactions.includes(request.request_id)) return;
      const eventId = buildEventId(taskId, attempt, "pending_interaction", request.request_id);
      this.#enqueueLocked(taskId, spec, { attempt, reason: "pending_interaction", eventId, requestId: request.request_id });
      this.#store.writeState({
        ...state,
        notified_interactions: [...state.notified_interactions, request.request_id],
        attention: { reason: "pending_interaction", attempt, event_id: eventId, set_at: this.#now().toISOString(), detail: request.request_id },
        updated_at: this.#now().toISOString(),
      });
    });
  }

  /** Independent Codex review of the attempt that requested it. Rejection
   * requires feedback and resumes the SAME session via continueTask under a
   * stable operation id; acceptance ends the goal. */
  async review(input: ReviewScheduleInput): Promise<ReviewOutcome> {
    return this.#locked(input.task_id, async (state) => {
      if (state.cancel_requested || state.status === "cancelled") throw new ScheduleError("SCHEDULE_STATE", "schedule has a persisted stop intent");
      const prior = state.review;
      if (prior?.attempt === input.attempt) {
        if (prior.accepted !== input.accepted || prior.feedback !== input.feedback) throw new ScheduleError("SCHEDULE_STATE", "this attempt already has a different review");
        return prior.accepted
          ? { task_id: input.task_id, attempt: input.attempt, accepted: true, action: "accepted" }
          : { task_id: input.task_id, attempt: input.attempt, accepted: false, action: "continued", receipt: prior.receipt! };
      }
      if (state.review_intent?.attempt === input.attempt) {
        const intent = state.review_intent;
        if (intent.accepted !== input.accepted || intent.feedback !== input.feedback) throw new ScheduleError("SCHEDULE_STATE", "a different review is already in flight");
        return this.#finishReviewLocked(input.task_id, state, input, intent.operation_id);
      }
      if (state.status !== "awaiting_review" || input.attempt !== state.attempt_under_review) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "this attempt is not awaiting review");
      if (!input.accepted && !input.feedback?.trim()) throw new ScheduleError("SCHEDULE_FEEDBACK_REQUIRED", "rejecting a review requires concrete feedback");
      const current = await this.#manager.getStatus(input.task_id);
      if (current.attempt !== input.attempt || !["completed", "failed", "waiting_for_master"].includes(current.status)) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "execution has advanced since this review was requested");
      const intent = { attempt: input.attempt, accepted: input.accepted, feedback: input.feedback,
        operation_id: reviewContinueOperationId(input.task_id, input.attempt), set_at: this.#now().toISOString() };
      const prepared = { ...state, review_intent: intent, updated_at: intent.set_at };
      this.#store.writeState(prepared);
      return this.#finishReviewLocked(input.task_id, prepared, input, intent.operation_id);
    });
  }

  /** Complete an authorized review after its MCP caller disappears. */
  async recoverReview(taskId: string): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      if (!state.review_intent || state.cancel_requested || ["accepted", "cancelled", "failed"].includes(state.status)) return;
      const intent = state.review_intent;
      try {
        await this.#finishReviewLocked(taskId, state, { task_id: taskId, attempt: intent.attempt,
          accepted: intent.accepted, feedback: intent.feedback }, intent.operation_id);
      } catch (error) {
        const current = await this.#manager.getStatus(taskId);
        // A concurrent ordinary continuation makes this old verdict permanently stale.
        if (current.attempt > intent.attempt) {
          this.#store.writeState({ ...state, status: "dispatched", attempt_under_review: null, attention: null,
            review_intent: null, failure_reason: "The saved review was superseded by a newer task attempt.", updated_at: this.#now().toISOString() });
          return;
        }
        if (!(error instanceof ScheduleError || error instanceof TaskManagerError)) throw error;
        const eventId = buildEventId(taskId, intent.attempt, "needs_decision", "review_recovery");
        this.#enqueueLocked(taskId, spec, { attempt: intent.attempt, reason: "needs_decision", eventId });
        this.#store.writeState({ ...state, review_intent: null, failure_reason: boundedErrorMessage(error, 300),
          attention: { reason: "needs_decision", attempt: intent.attempt, event_id: eventId, set_at: this.#now().toISOString() }, updated_at: this.#now().toISOString() });
      }
    });
  }

  async #finishReviewLocked(taskId: string, state: ScheduleState, input: ReviewScheduleInput, operationId: string): Promise<ReviewOutcome> {
    if (input.accepted) {
      // The ordinary continuation API shares this lock; acceptance and a new
      // attempt therefore have a definite order even across MCP processes.
      const tasksRoot = path.join(this.#dataRoot, ".tasks");
      mkdirSync(tasksRoot, { recursive: true, mode: 0o700 });
      return withProcessLock(path.join(tasksRoot, ".manager.lock"), async () => {
        const current = await this.#manager.getStatus(taskId);
        if (current.attempt !== input.attempt || !["completed", "failed", "waiting_for_master"].includes(current.status)) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "execution has advanced since this review was requested");
        if (current.observation?.cleanup !== "verified") throw new ScheduleError("SCHEDULE_STATE", "process cleanup must be verified before acceptance");
        const reviewedAt = this.#now().toISOString();
        this.#store.writeState({ ...state, status: "accepted", attempt_under_review: null, attention: null, review_intent: null,
          review: { attempt: input.attempt, accepted: true, feedback: input.feedback, reviewed_at: reviewedAt, operation_id: operationId, outcome: "accepted" }, updated_at: reviewedAt });
        return { task_id: taskId, attempt: input.attempt, accepted: true, action: "accepted" };
      });
    }
    const receipt = await this.#manager.continueTask({
      task_id: taskId,
      feedback: buildReviewContinueFeedback(input.feedback ?? "", input.attempt),
      operation_id: operationId,
      expected_attempt: input.attempt,
    });
    const reviewedAt = this.#now().toISOString();
    this.#store.writeState({
      ...state,
      status: "dispatched",
      attempt_under_review: null,
      attention: null,
      review_intent: null,
      review: { attempt: input.attempt, accepted: false, feedback: input.feedback, reviewed_at: reviewedAt, operation_id: operationId, outcome: "continued", receipt },
      updated_at: reviewedAt,
    });
    return { task_id: taskId, attempt: input.attempt, accepted: false, action: "continued", receipt };
  }

  /** Stop intent persists FIRST, then the existing TaskManager cancellation
   * verifies cleanup; a cleanup failure surfaces and keeps the stop intent. */
  async cancel(taskId: string): Promise<{ schedule_status: ScheduleState["status"]; task_status: TaskStatusRecord["status"] | null }> {
    return this.#locked(taskId, async (state, spec) => {
      if (state.status === "cancelled") {
        if (state.supervisor) await this.#supervisor.stop(state.supervisor.unit);
        return { schedule_status: "cancelled", task_status: await this.#taskStatusOrNull(taskId) };
      }
      if (state.status === "accepted") throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId} was accepted; nothing to cancel`);
      this.#store.writeState({ ...state, cancel_requested: true, updated_at: this.#now().toISOString() });
      const tasksRoot = path.join(this.#dataRoot, ".tasks");
      mkdirSync(tasksRoot, { recursive: true, mode: 0o700 });
      let attempt = state.attempt_under_review ?? state.attention?.attempt ?? 1;
      try {
        while (true) {
          // Linearize the final stop with ordinary continueTask, which uses this same lock.
          const committed = await withProcessLock(path.join(tasksRoot, ".manager.lock"), async () => {
            const execution = await this.#manager.getStatus(taskId).catch((error: unknown) => {
              if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
              throw error;
            });
            attempt = execution?.attempt ?? attempt;
            if (execution && (!["completed", "failed", "cancelled", "waiting_for_master"].includes(execution.status) || execution.observation?.cleanup !== "verified")) return false;
            this.#store.writeState({ ...this.#store.readState(taskId), status: "cancelled", attention: null,
              attempt_under_review: null, review_intent: null, failure_reason: null, updated_at: this.#now().toISOString() });
            for (const notification of this.#store.listNotifications(taskId)) {
              if (!["sent", "superseded"].includes(notification.delivery.state)) {
                this.#store.writeNotification(taskId, { ...notification, delivery: { state: "superseded", attempts: notification.delivery.attempts } });
              }
            }
            return true;
          });
          if (committed) break;
          try {
            await this.#manager.cancelTask(taskId);
          } catch (error) {
            // A worker can finish between the snapshot and cancel; recheck its terminal cleanup.
            if (!(error instanceof TaskManagerError && error.code === "TASK_STATE")) throw error;
          }
          const after = await this.#manager.getStatus(taskId);
          // Manager cancellation can return while a runtime cleanup latch remains set.
          if (after.observation?.cleanup !== "verified") throw new ScheduleError("SCHEDULE_STATE", "cancellation returned without verified process cleanup");
        }
      } catch (error) {
        const eventId = buildEventId(taskId, attempt, "cancel_failed");
        this.#enqueueLocked(taskId, spec, { attempt, reason: "cancel_failed", eventId });
        this.#store.writeState({ ...this.#store.readState(taskId), status: "failed", cancel_requested: true,
          failure_reason: boundedErrorMessage(error, 300), attention: { reason: "cancel_failed", attempt,
            event_id: eventId, set_at: this.#now().toISOString() }, updated_at: this.#now().toISOString() });
        throw error;
      }
      if (state.supervisor) await this.#supervisor.stop(state.supervisor.unit);
      return { schedule_status: "cancelled", task_status: await this.#taskStatusOrNull(taskId) };
    });
  }

  async fail(taskId: string, reason: ScheduleAttentionReason, detail: string): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      if (state.cancel_requested || ["accepted", "cancelled", "failed"].includes(state.status)) return;
      this.#failLocked(taskId, state, reason, detail);
      this.#enqueueLocked(taskId, spec, { attempt: state.attempt_under_review ?? 1, reason,
        eventId: buildEventId(taskId, state.attempt_under_review ?? 1, reason) });
    });
  }

  /** Sends every undelivered outbox event (at-least-once); failures persist
   * bounded errors and a retry deadline. */
  async deliverPending(taskId: string): Promise<void> {
    await this.#locked(taskId, async (state, spec) => {
      // Repair the crash window between marking attention and writing its outbox event.
      const attention = state.attention;
      if (attention && !this.#store.hasNotification(taskId, attention.event_id)) {
        this.#enqueueLocked(taskId, spec, { attempt: attention.attempt, reason: attention.reason, eventId: attention.event_id,
          requestId: attention.reason === "pending_interaction" ? attention.detail : undefined });
      }
      const pipePath = this.#store.readRuntime()?.app_pipe_path ?? null;
      const current = await this.#manager.getStatus(taskId).catch((error: unknown) => {
        if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
        throw error;
      });
      for (const notification of this.#store.listNotifications(taskId)) {
        if (["sent", "superseded"].includes(notification.delivery.state)) continue;
        if ((state.cancel_requested && notification.reason !== "cancel_failed") || ["cancelled", "accepted"].includes(state.status) || (current && notification.attempt < current.attempt)) {
          this.#store.writeNotification(taskId, { ...notification, delivery: { state: "superseded", attempts: notification.delivery.attempts } });
          continue;
        }
        if (!this.#notifier) continue;
        if (notification.delivery.next_retry_at && Date.parse(notification.delivery.next_retry_at) > this.#now().getTime()) continue;
        const attempts = notification.delivery.attempts + 1;
        const attemptedAt = this.#now().toISOString();
        try {
          if (pipePath === null) throw new Error("Codex App tools pipe is not configured");
          await this.#notifier.send({ pipePath, threadId: notification.thread_id,
            callId: `${randomUUID()}`, message: notification.message });
          this.#store.writeNotification(taskId, { ...notification, delivery: { state: "sent", attempts, last_attempt_at: attemptedAt, sent_at: attemptedAt } });
        } catch (error) {
          this.#store.writeNotification(taskId, { ...notification, delivery: { state: "failed", attempts,
            last_error: boundedErrorMessage(error, 300), last_attempt_at: attemptedAt,
            next_retry_at: new Date(this.#now().getTime() + Math.min(DELIVERY_BACKOFF_BASE_MS * attempts, DELIVERY_BACKOFF_MAX_MS)).toISOString() } });
        }
      }
    });
  }

  hasUndeliveredNotifications(taskId: string): boolean {
    return this.#store.listNotifications(taskId).some((notification) => !["sent", "superseded"].includes(notification.delivery.state));
  }

  async #taskStatusOrNull(taskId: string): Promise<TaskStatusRecord["status"] | null> {
    try {
      return (await this.#manager.getStatus(taskId)).status;
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    }
  }

  async #executionView(taskId: string): Promise<ScheduleExecutionView | null> {
    let status: TaskStatusRecord;
    try {
      status = await this.#manager.getStatus(taskId);
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    }
    let result: TaskResult | null = null;
    if (["completed", "failed", "cancelled", "waiting_for_master"].includes(status.status)) {
      result = await this.#manager.getResult(taskId).catch((error: unknown) => {
        if (error instanceof TaskManagerError && error.code === "TASK_NOT_FINISHED") return null;
        throw error;
      });
    }
    return {
      status: status.status,
      attempt: status.attempt,
      ...(result?.error_code !== undefined ? { error_code: result.error_code } : {}),
      needs_master_decision: result?.needs_master_decision ?? null,
      ...(result?.acceptance_met !== undefined ? { acceptance_met: result.acceptance_met } : {}),
    };
  }

  #failLocked(taskId: string, state: ScheduleState, reason: ScheduleAttentionReason, detail: string): void {
    this.#store.writeState({
      ...state,
      status: "failed",
      failure_reason: detail,
      attention: { reason, attempt: state.attempt_under_review ?? 1, event_id: buildEventId(taskId, state.attempt_under_review ?? 1, reason), set_at: this.#now().toISOString(), detail },
      updated_at: this.#now().toISOString(),
    });
  }

  #enqueueLocked(
    taskId: string,
    spec: ScheduleSpec,
    event: { attempt: number; reason: ScheduleAttentionReason; eventId: string; requestId?: string; errorCode?: string },
  ): void {
    if (this.#store.hasNotification(taskId, event.eventId)) return;
    this.#store.writeNotification(taskId, {
      event_id: event.eventId,
      task_id: taskId,
      attempt: event.attempt,
      reason: event.reason,
      thread_id: spec.thread_id,
      message: buildNotificationMessage({ eventId: event.eventId, taskId, attempt: event.attempt, reason: event.reason, requestId: event.requestId, errorCode: event.errorCode }),
      created_at: this.#now().toISOString(),
      delivery: { state: "pending", attempts: 0 },
    });
  }

  #receiptFrom(spec: ScheduleSpec, state: ScheduleState): ScheduleSubmitReceipt {
    return {
      task_id: spec.task_id,
      status: state.status,
      start_at: spec.start_at,
      thread_id: spec.thread_id,
      created_at: spec.created_at,
      supervisor: state.supervisor ? { unit: state.supervisor.unit, log_path: state.supervisor.log_path } : null,
    };
  }

  async #locked<T>(taskId: string, operation: (state: ScheduleState, spec: ScheduleSpec) => Promise<T>): Promise<T> {
    this.#store.readSpec(taskId);
    return withProcessLock(path.join(this.#store.scheduleDir(taskId), "state.lock"), async () => {
      const spec = this.#store.readSpec(taskId);
      return operation(this.#store.readState(taskId), spec);
    }, 60_000);
  }
}

function initialState(taskId: string, createdAt: string): ScheduleState {
  return {
    task_id: taskId,
    status: "scheduled",
    created_at: createdAt,
    updated_at: createdAt,
    dispatched_at: null,
    attempt_under_review: null,
    attention: null,
    cancel_requested: false,
    review_intent: null,
    review: null,
    notified_interactions: [],
    supervisor: null,
    failure_reason: null,
  };
}
