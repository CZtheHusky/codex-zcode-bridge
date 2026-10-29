// Contract projection of docs/INTERFACES.md, which is authoritative; keep this
// file in sync with it. The V0.1 "frozen" wording is historical: later additive
// features are documented in INTERFACES.md, not here.
// Public tool names, required fields, status names and result semantics are
// compatibility commitments. Change them only through a decision under
// docs/decisions/, as required by AGENTS.md.
// Additive optional fields (observation, usage/timing/model, scan cursor) are
// backward compatible: old clients ignore them, old records read as absent.

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_master";

/** A1 unified observation projection. Advisory evidence only: never a
 * terminal verdict, never a substitute for the committed result or cleanup
 * contract. Unknown never means dead. */
export interface TaskObservation {
  schema_version: 1;
  worker: { state: "alive" | "exited" | "unknown"; reason_code: string; observed_at: string };
  runtime: { state: "alive" | "exited" | "unknown"; reason_code: string; observed_at: string };
  activity: { code: "starting" | "executing" | "waiting_for_permission" | "waiting_for_user" | "finalizing" | "stalled" | "unknown"; reason_code: string; observed_at: string };
  result: "absent" | "checkpointed" | "committed";
  cleanup: "not_started" | "pending" | "verified" | "unverified";
  stalled: boolean;
  evidence: {
    heartbeat_age_ms: number | null;
    last_event_age_ms: number | null;
    last_event_seq: number | null;
    last_event_type: string | null;
    session_id: string | null;
    turn_id: string | null;
    attempt: number;
    status_updated_at: string | null;
  };
}

/** B4 usage figures: runtime-reported values only, normalized from a strict
 * numeric whitelist. Missing is null/not_reported; a real zero only comes
 * from a real statistic. Totals are never recomputed behind the caller's back. */
export interface NormalizedUsage {
  source: string | null;
  scope: string | null;
  observed_at: string | null;
  finality: "reported" | "derived" | "partial";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  /** Controlled conflict markers (e.g. total_mismatch, duplicate_synonyms). */
  conflicts: string[];
  /** Number of unknown usage keys dropped from the provider payload. */
  dropped_unknown_keys: number;
}

/** B4 execution profile: requested vs runtime-confirmed model and reasoning
 * depth. Only runtime-confirmed values may be displayed as effective. */
export interface ExecutionProfile {
  executor: string;
  provider_id: string | null;
  model_id: string | null;
  requested_model: string | null;
  requested_reasoning_level: string | null;
  effective_reasoning_level: string | null;
  effective_reasoning_level_source: "runtime" | "not_reported";
  selection_source: string | null;
  effective_at: string | null;
  session_id: string | null;
  turn_id: string | null;
}

/** B4 timing phases with explicit boundaries; derived values are labelled. */
export interface AttemptTiming {
  queued_ms: number | null;
  execution_ms: number | null;
  turn_ms: number | null;
  finalize_ms: number | null;
  wall_ms: number | null;
  /** True when wall/execution values are reconstructed across a restart. */
  derived: boolean;
  notes: string[];
}

export interface TaskPackage {
  /** Persisted executor; omitted keeps existing ZCode tasks compatible. */
  executor?: "zcode" | "kimi";
  kimi?: { model?: string; reasoning_level?: string; permission_mode?: "manual" | "yolo" | "auto" };
  task_id: string;
  workspace: string; // absolute the calling host project path; also the ZCode Desktop project identity
  /** Optional actual execution directory chosen and prepared by the calling host. Bridge never creates or selects it. */
  worktree_path?: string;
  /** Optional per-task ZCode model override. Omitted means use ZCode defaults. */
  model?: ZCodeModelSelection;
  /** Optional execution wall-clock limit in milliseconds (60 seconds to 4 hours). */
  timeout_ms?: number;
  objective: string;
  requirements: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  test_commands: string[];
  context?: string;
}

export interface ZCodeModelSelection {
  provider_id: string;
  model_id: string;
  /** Required only by ZCode models that need an explicit reasoning option. */
  reasoning_level?: string;
}

export interface TestReport {
  command: string;
  status: "passed" | "failed" | "not_run";
  details?: string;
}

export interface TaskResult {
  task_id: string;
  status: "completed" | "failed" | "cancelled" | "waiting_for_master";
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
  zcode_output: string;
  exit_code: number | null;
  session_id: string | null;
  attempt: number;
  started_at: string | null; // RFC 3339 UTC
  finished_at: string | null; // RFC 3339 UTC
  error_code?: string;
  /** Parsed but incomplete report, retained for Master review after schema failure. */
  report_candidate?: Partial<AgentReport>;
  /** B4 additive: runtime-reported usage for this attempt, when reported. */
  usage?: NormalizedUsage | null;
  /** B4 additive: runtime-confirmed model / reasoning depth for this attempt. */
  model?: ExecutionProfile | null;
  /** B4 additive: bounded phase timings with explicit boundaries. */
  timing?: AttemptTiming | null;
  /** ADR-010 additive: the agent's own acceptance self-assessment from the
   * report, when the report provided one. Absent means not assessed; this is
   * never the calling host's independent acceptance decision. */
  acceptance_met?: boolean;
}

export interface WorkspaceRef {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly mode: "direct" | "worktree";
  /** Canonical source repository path when canonicalPath is an isolated worktree. */
  readonly sourcePath?: string;
  /** Per-task branch created by the worktree provider. */
  readonly branchName?: string;
}

export interface AgentHandle {
  readonly taskId: string;
  readonly attempt: number;
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly startedAt: string;
}

export interface AgentRunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly sessionId: string | null;
  readonly response: string | null;
  readonly usage: Record<string, unknown> | null;
  readonly timedOut: boolean;
}

export interface AgentProcessStatus {
  readonly state: "starting" | "running" | "exited" | "unknown";
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface CodingAgentAdapter {
  startTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
  }): Promise<AgentHandle>;
  continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle>;
  getStatus(handle: AgentHandle): Promise<AgentProcessStatus>;
  getResult(handle: AgentHandle): Promise<AgentRunOutcome>;
  cancelTask(handle: AgentHandle): Promise<void>;
}

export interface RuntimeResolver {
  resolve(): Promise<ZCodeRuntimeConfig>;
}

export interface ZCodeRuntimeConfig {
  readonly nodeExecutable: string;
  readonly zcodeEntrypoint: string;
  readonly providerBuiltinConfigFile: string;
  readonly providerPersonalConfigFile: string;
  readonly dataRoot: string;
}

export interface AgentReport {
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
  /** ADR-010 additive: the subordinate's own boolean assessment of whether
   * the task's acceptance criteria are met. Optional and never synthesized:
   * absent means "not assessed" (old tasks, infrastructure failures). This is
   * a self-assessment, never the calling host's independent PASS. */
  acceptance_met?: boolean;
}

export interface TaskReceipt {
  task_id: string;
  status: "queued" | "running";
  created_at: string;
}

export interface TaskStatusRecord {
  task_id: string;
  status: TaskStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_pid: number | null;
  zcode_session_id: string | null;
  exit_code: number | null;
  error_code?: string;
  error?: string;
  /** A1 additive: unified observation; advisory evidence, never a verdict override. */
  observation?: TaskObservation;
}

/** Append-only, user-visible execution evidence. Never includes hidden reasoning; interaction requests may expose bounded tool input for a decision. */
export interface TaskProgressEvent {
  seq: number;
  at: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
}

export type ZCodeInteractionMethod =
  | "interaction/requestPermission"
  | "interaction/requestUserInput";

export interface ZCodeInteractionRequest {
  readonly request_id: string;
  readonly method: ZCodeInteractionMethod;
  readonly params: Record<string, unknown>;
}

export interface ZCodeInteractionReplyInput {
  readonly task_id: string;
  readonly request_id: string;
  readonly decision: "allow" | "deny" | "accept" | "decline";
  /** AskUserQuestion answers keyed by the exact question text. */
  readonly answers?: Record<string, string>;
  readonly reason?: string;
}

export interface ZCodeInteractionRecord extends ZCodeInteractionRequest {
  readonly state: "pending" | "answered";
  readonly created_at: string;
  readonly answer?: Record<string, unknown>;
  readonly answered_at?: string;
  /** ADR-008 additive metadata over the serialized sanitized params; written
   * with the record so approvals can verify the full content is intact. */
  readonly params_bytes?: number;
  readonly params_sha256?: string;
}

export interface TaskProgressPage {
  task_id: string;
  status: TaskStatus;
  events: TaskProgressEvent[];
  next_seq: number;
  has_more: boolean;
  /** Events omitted by summary view; cursor still advances across all scanned events. */
  omitted_events?: number;
  /** A1 additive: the same unified observation returned by coding_agent_status. */
  observation?: TaskObservation;
  /** B1 additive: byte budget exhausted before the log end. */
  scan_incomplete?: boolean;
  /** B1 additive: opaque continuation cursor for the bounded scan path. */
  scan_cursor?: string;
  /** B1 additive: bounded-scan metrics (bytes read, corrupt lines, index fallback). */
  scan_metrics?: Record<string, number | null>;
}

/** Compact, provenance-aware view of one Bridge task attempt. */
export interface TaskFeedbackSnapshotV01 {
  schema_version: "0.1";
  task_id: string;
  attempt: number;
  status: TaskStatus;
  model: {
    provider_id: string | null;
    model_id: string | null;
    reasoning_level: string | null;
    source: "runtime";
  } | null;
  phase: null;
  progress: null;
  activity: {
    kind: "tool_call" | "tool_update";
    summary: string;
    observed_at: string;
    currentness: "last_observed";
  } | null;
  interaction: {
    state: "not_observed" | "pending" | "answered";
    kind: "permission" | "user_input" | null;
  } | null;
  result: {
    source: "agent_report";
    summary: string;
    issues: string[];
    files_changed: string[];
    tests: TestReport[];
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
  } | null;
}

export interface ContinueTaskInput {
  task_id: string;
  feedback: string;
  additional_requirements?: string[];
  /** Stable id for retrying one continuation after a lost response. */
  operation_id?: string;
  /** Scheduled feedback must apply to the attempt that was actually reviewed. */
  expected_attempt?: number;
}

export interface GetEventsInput {
  task_id: string;
  after_seq?: number;
  limit?: number;
  wait_ms?: number;
  view?: "raw" | "summary";
  /** B1 additive: opaque cursor from a previous bounded page. */
  scan_cursor?: string;
  /** B1 additive: byte budget for the bounded scan path (ignored without scan_cursor semantics). */
  max_bytes?: number;
}

export interface TaskManager {
  createTask(task: TaskPackage): Promise<TaskReceipt>;
  getStatus(taskId: string): Promise<TaskStatusRecord>;
  getResult(taskId: string): Promise<TaskResult>;
  continueTask(input: ContinueTaskInput): Promise<TaskReceipt>;
  cancelTask(taskId: string): Promise<TaskStatusRecord>;
}

/** Additive Phase 7 capability; the frozen V0.1 TaskManager contract stays intact. */
export interface ProgressTaskManager extends TaskManager {
  getEvents(input: GetEventsInput): Promise<TaskProgressPage>;
  getFeedback?(taskId: string): Promise<TaskFeedbackSnapshotV01>;
  replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }>;
}

export interface WorkspaceProvider {
  resolve(workspacePath: string, taskId?: string, executionPath?: string): Promise<WorkspaceRef>;
  release(workspace: WorkspaceRef): Promise<void>;
}
