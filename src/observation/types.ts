// A1 unified observation contract (audit/2026-10-04-lifecycle-observability-plan.md).
// Additive, optional fields only: the frozen TaskStatus/TaskResult semantics are
// unchanged, and observation data must never override a committed business
// result or the cleanup contract. Unknown never counts as dead.
import type { TaskStatus } from "../interfaces.js";

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

export type ExecutorState = "alive" | "exited" | "unknown";

/** One probed/observed executor (Bridge worker process or ZCode runtime process). */
export interface ExecutorObservation {
  readonly state: ExecutorState;
  /** Controlled, enum-like reason; never free-form process output. */
  readonly reason_code: string;
  readonly observed_at: string;
}

export type ActivityCode =
  | "starting"
  | "executing"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "finalizing"
  | "stalled"
  | "unknown";

export type ResultPresence = "absent" | "checkpointed" | "committed";
export type CleanupState = "not_started" | "pending" | "verified" | "unverified";

/** Bounded evidence; never contains task bodies, prompts, or model output. */
export interface ObservationEvidence {
  readonly heartbeat_age_ms: number | null;
  readonly last_event_age_ms: number | null;
  readonly last_event_seq: number | null;
  readonly last_event_type: string | null;
  readonly session_id: string | null;
  readonly turn_id: string | null;
  readonly attempt: number;
  /** Persisted state version: the status record's updated_at, for staleness checks. */
  readonly status_updated_at: string | null;
}

/**
 * The full observation projection shared by coding_agent_status, coding_agent_events, and
 * doctor diagnostics. Produced by the single pure judger in judge.ts so all
 three consumers agree on one verdict for one snapshot (A1-06).
 */
export interface TaskObservation {
  readonly schema_version: typeof OBSERVATION_SCHEMA_VERSION;
  readonly worker: ExecutorObservation;
  readonly runtime: ExecutorObservation;
  readonly activity: { readonly code: ActivityCode; readonly reason_code: string; readonly observed_at: string };
  readonly result: ResultPresence;
  readonly cleanup: CleanupState;
  /** Advisory only: missing progress hint; never triggers retry/cancel/failure. */
  readonly stalled: boolean;
  readonly evidence: ObservationEvidence;
}

/** Persisted probe verdicts from the manager's recovery scan (A2). */
export interface PersistedProbeRecord {
  readonly task_id: string;
  readonly attempt: number;
  readonly worker_pid: number | null;
  readonly runtime_pid: number | null;
  readonly worker: { readonly state: ExecutorState; readonly reason_code: string };
  readonly runtime: { readonly state: ExecutorState; readonly reason_code: string };
  readonly probed_at: string;
}

/** Input snapshot consumed by the pure judger. All timestamps are RFC 3339. */
export interface JudgeInput {
  readonly status: {
    readonly status: TaskStatus;
    readonly attempt: number;
    readonly started_at: string | null;
    readonly finished_at: string | null;
    readonly worker_pid: number | null;
    readonly zcode_pid?: number | null;
    readonly zcode_session_id?: string | null;
    readonly cleanup_unverified?: boolean | null;
    readonly updated_at?: string;
  };
  /** Terminal TaskResult committed for the CURRENT attempt (store.readResult). */
  readonly result: { readonly attempt: number } | null;
  readonly checkpoint: { readonly recorded_at: string } | null;
  readonly heartbeat: {
    readonly attempt: number;
    readonly worker_pid: number;
    readonly heartbeat_at: string;
    readonly last_event_seq: number;
    readonly last_event_type: string | null;
    readonly session_id: string | null;
    readonly turn_id: string | null;
  } | null;
  readonly last_business_event: { readonly at: string; readonly type: string; readonly seq: number } | null;
  readonly pending_interaction: { readonly method: string; readonly created_at: string } | null;
  readonly probe_worker?: { readonly state: ExecutorState; readonly reason_code: string; readonly observed_at: string } | null;
  readonly probe_runtime?: { readonly state: ExecutorState; readonly reason_code: string; readonly observed_at: string } | null;
  readonly now_ms: number;
  readonly options?: Partial<JudgeOptions>;
}

export interface JudgeOptions {
  /** Existing startup grace: a missing/dead-looking worker right after start is not a loss. */
  readonly start_grace_ms: number;
  /** Heartbeat freshness window (existing default 15s). */
  readonly heartbeat_fresh_ms: number;
  /** Advisory stall hint threshold for business-event silence. */
  readonly stall_hint_ms: number;
  /** Wall-clock jumps beyond this magnitude downgrade time evidence to unknown. */
  readonly clock_jump_guard_ms: number;
}

export const DEFAULT_JUDGE_OPTIONS: JudgeOptions = {
  start_grace_ms: 10_000,
  heartbeat_fresh_ms: 15_000,
  stall_hint_ms: 120_000,
  clock_jump_guard_ms: 120_000,
};

export function judgeOptionsWith(overrides?: Partial<JudgeOptions>): JudgeOptions {
  const merged: JudgeOptions = { ...DEFAULT_JUDGE_OPTIONS };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
