// ADR-010 scheduling types: one scheduled goal is one Bridge task id with an
// absolute start time and an explicit original Codex chat thread to wake.
// The schedule layer composes the existing TaskManager; it never changes task
// lifecycle semantics. Execution state stays on the task; goal/review state
// stays here, deliberately separate.
import type { TaskPackage, TaskReceipt } from "../interfaces.js";

/** Absolute start time: ISO 8601 datetime that MUST carry a timezone offset. */
export const START_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

export const THREAD_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface ScheduleSpec {
  readonly supervisor_unit: string;
  readonly task_id: string;
  /** Absolute start time with timezone; the supervised runner waits for it. */
  readonly start_at: string;
  /** The original Codex chat thread that receives wakeup notifications. */
  readonly thread_id: string;
  /** The task package exactly as submitted (before scheduler derivation). */
  readonly task: TaskPackage;
  readonly created_at: string;
}

export type ScheduleGoalStatus =
  | "scheduled"
  | "dispatched"
  | "awaiting_review"
  | "accepted"
  | "cancelled"
  | "failed";

/** Why the scheduler stopped advancing and woke (or tried to wake) the
 * original thread. Execution facts stay on the task record; this marker only
 * says which condition requires an external decision. */
export type ScheduleAttentionReason =
  | "pending_interaction"
  | "review_requested"
  | "needs_decision"
  | "task_failed"
  | "usage_exhausted"
  | "task_cancelled"
  | "missing_self_assessment"
  | "dispatch_failed"
  | "continue_failed"
  | "cancel_failed";

export interface ScheduleAttention {
  readonly reason: ScheduleAttentionReason;
  readonly attempt: number;
  /** Stable event id (task/attempt/reason, plus request id when applicable). */
  readonly event_id: string;
  readonly set_at: string;
  readonly detail?: string;
}

export interface ScheduleReviewRecord {
  readonly attempt: number;
  readonly accepted: boolean;
  readonly feedback?: string;
  readonly reviewed_at: string;
  readonly operation_id: string;
  readonly outcome: "accepted" | "continued";
  readonly receipt?: TaskReceipt;
}

export interface ScheduleSupervisorInfo {
  readonly unit: string;
  readonly log_path: string;
  readonly started_at: string | null;
}

export interface ScheduleReviewIntent {
  readonly attempt: number;
  readonly accepted: boolean;
  readonly feedback?: string;
  readonly operation_id: string;
  readonly set_at: string;
}

export interface ScheduleState {
  readonly task_id: string;
  readonly status: ScheduleGoalStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly dispatched_at: string | null;
  readonly attempt_under_review: number | null;
  readonly attention: ScheduleAttention | null;
  readonly cancel_requested: boolean;
  /** Durable intent persisted BEFORE the review's continueTask call, so a
   * crash mid-review resumes the same continuation instead of a second one. */
  readonly review_intent: ScheduleReviewIntent | null;
  readonly review: ScheduleReviewRecord | null;
  /** Interaction request ids already woken (once per request, no auto reply). */
  readonly notified_interactions: readonly string[];
  readonly supervisor: ScheduleSupervisorInfo | null;
  readonly failure_reason: string | null;
}

/** A persisted, at-least-once wakeup notification. Delivery state is part of
 * the record: a send whose receipt was lost may be delivered twice. */
export interface ScheduleNotification {
  readonly event_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly reason: ScheduleAttentionReason;
  readonly thread_id: string;
  /** Stable ids and inspection instructions only — never worker prompts,
   * summaries, tool inputs, or secrets. */
  readonly message: string;
  readonly created_at: string;
  readonly delivery: {
    state: "pending" | "sent" | "failed" | "superseded";
    attempts: number;
    last_error?: string;
    last_attempt_at?: string;
    next_retry_at?: string;
    sent_at?: string;
  };
}

export interface ScheduleRuntimeInfo {
  readonly app_pipe_path: string | null;
  readonly updated_at: string;
}
