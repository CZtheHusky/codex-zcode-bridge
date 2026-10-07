// Frozen contract projection of docs/INTERFACES.md (V0.1, FROZEN).
// The documents are authoritative; keep this file mechanically in sync.
// Do not change tool names, required fields, status names, or result semantics.

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_master";

export interface TaskPackage {
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
}

export interface TaskProgressPage {
  task_id: string;
  status: TaskStatus;
  events: TaskProgressEvent[];
  next_seq: number;
  has_more: boolean;
  /** Events omitted by summary view; cursor still advances across all scanned events. */
  omitted_events?: number;
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
  getEvents(input: { task_id: string; after_seq?: number; limit?: number; wait_ms?: number; view?: "raw" | "summary" }): Promise<TaskProgressPage>;
  getFeedback?(taskId: string): Promise<TaskFeedbackSnapshotV01>;
  replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }>;
}

export interface WorkspaceProvider {
  resolve(workspacePath: string, taskId?: string, executionPath?: string): Promise<WorkspaceRef>;
  release(workspace: WorkspaceRef): Promise<void>;
}
