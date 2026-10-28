// Frozen tool schemas per docs/INTERFACES.md (strict, snake_case, unknown
// fields rejected). Rendered with Zod 4 schemas, which the official
// MCP TypeScript SDK v2 accepts directly as tool input schemas; unknown or
// missing fields fail input validation before the TaskManager is invoked.
// Additive optional output fields (observation, scan cursor/metrics, usage)
// keep old clients working: they may ignore unknown optional keys.
import * as z from "zod/v4";

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, `task_id must match ${TASK_ID_PATTERN.source}`);

const stringArray = z.array(z.string());

export const zcodeTaskInputSchema = z
  .strictObject({
    task_id: taskIdSchema,
    workspace: z.string().min(1),
    worktree_path: z.string().min(1).optional(),
    model: z.strictObject({
      provider_id: z.string().trim().min(1),
      model_id: z.string().trim().min(1),
      reasoning_level: z.string().trim().min(1).optional(),
    }).optional(),
    timeout_ms: z.number().int().min(60_000).max(14_400_000).optional(),
    objective: z.string().min(1),
    requirements: stringArray,
    allowed_paths: stringArray,
    forbidden_paths: stringArray,
    acceptance_criteria: stringArray,
    test_commands: stringArray,
    context: z.string().optional(),
  })
  .describe("Full TaskPackage; workspace is the the calling host project root. Optional worktree_path is an existing execution directory selected and prepared by the calling host; the Bridge never creates or selects worktrees. The five array fields must be present (empty allowed), context is optional.");

export const taskIdOnlyInputSchema = z.strictObject({
  task_id: z.string().min(1),
});

export const zcodeFeedbackInputSchema = z.strictObject({
  task_id: taskIdSchema,
});

export const zcodeContinueInputSchema = z.strictObject({
  task_id: z.string().min(1),
  feedback: z.string().min(1),
  additional_requirements: z.array(z.string()).optional(),
  operation_id: z.string().trim().min(1).max(128).optional(),
});

export const zcodeEventsInputSchema = z.strictObject({
  task_id: taskIdSchema,
  after_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  wait_ms: z.number().int().min(0).max(25_000).optional(),
  view: z.enum(["raw", "summary"]).optional(),
  scan_cursor: z.string().max(2_048).optional(),
  max_bytes: z.number().int().min(1_024).max(33_554_432).optional(),
});

export const zcodeInteractionReplyInputSchema = z.strictObject({
  task_id: taskIdSchema,
  request_id: z.string().trim().min(1).max(512),
  decision: z.enum(["allow", "deny", "accept", "decline"]),
  answers: z.record(z.string(), z.string()).optional(),
  reason: z.string().max(2_000).optional(),
});

export const zcodeModelCatalogInputSchema = z.strictObject({
  workspace: z.string().trim().min(1),
});


export const zcodeDefaultModelInputSchema = z.strictObject({
  provider_id: z.string().trim().min(1),
  model_id: z.string().trim().min(1),
  reasoning_level: z.string().trim().min(1).optional(),
});

// ---- output schemas (structured content validation) ----

const testReportSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed", "not_run"]),
  details: z.string().optional(),
});

export const taskReceiptSchema = z.object({
  task_id: z.string(),
  status: z.enum(["queued", "running"]),
  created_at: z.string(),
});

const taskObservationSchema = z.object({
  schema_version: z.literal(1),
  worker: z.object({ state: z.enum(["alive", "exited", "unknown"]), reason_code: z.string(), observed_at: z.string() }),
  runtime: z.object({ state: z.enum(["alive", "exited", "unknown"]), reason_code: z.string(), observed_at: z.string() }),
  activity: z.object({ code: z.string(), reason_code: z.string(), observed_at: z.string() }),
  result: z.enum(["absent", "checkpointed", "committed"]),
  cleanup: z.enum(["not_started", "pending", "verified", "unverified"]),
  stalled: z.boolean(),
  evidence: z.object({
    heartbeat_age_ms: z.number().nullable(),
    last_event_age_ms: z.number().nullable(),
    last_event_seq: z.number().nullable(),
    last_event_type: z.string().nullable(),
    session_id: z.string().nullable(),
    turn_id: z.string().nullable(),
    attempt: z.number().int(),
    status_updated_at: z.string().nullable(),
  }),
});

export const taskStatusRecordSchema = z.object({
  task_id: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "waiting_for_master",
  ]),
  attempt: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  worker_pid: z.number().int().nullable(),
  zcode_session_id: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  error_code: z.string().optional(),
  error: z.string().optional(),
  observation: taskObservationSchema.optional(),
});

const normalizedUsageSchema = z.object({
  source: z.string().nullable(),
  scope: z.string().nullable(),
  observed_at: z.string().nullable(),
  finality: z.enum(["reported", "derived", "partial"]),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  cached_input_tokens: z.number().int().nullable(),
  reasoning_tokens: z.number().int().nullable(),
  conflicts: z.array(z.string()),
  dropped_unknown_keys: z.number().int(),
});

const executionProfileSchema = z.object({
  executor: z.string(),
  provider_id: z.string().nullable(),
  model_id: z.string().nullable(),
  requested_model: z.string().nullable(),
  requested_reasoning_level: z.string().nullable(),
  effective_reasoning_level: z.string().nullable(),
  effective_reasoning_level_source: z.enum(["runtime", "not_reported"]),
  selection_source: z.string().nullable(),
  effective_at: z.string().nullable(),
  session_id: z.string().nullable(),
  turn_id: z.string().nullable(),
});

const attemptTimingSchema = z.object({
  queued_ms: z.number().int().nullable(),
  execution_ms: z.number().int().nullable(),
  turn_ms: z.number().int().nullable(),
  finalize_ms: z.number().int().nullable(),
  wall_ms: z.number().int().nullable(),
  derived: z.boolean(),
  notes: z.array(z.string()),
});

export const taskResultSchema = z.object({
  task_id: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "waiting_for_master"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  tests: z.array(testReportSchema),
  issues: z.array(z.string()),
  needs_master_decision: z.boolean(),
  zcode_output: z.string(),
  exit_code: z.number().int().nullable(),
  session_id: z.string().nullable(),
  attempt: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_code: z.string().optional(),
  report_candidate: z.object({
    summary: z.string().optional(),
    files_changed: z.array(z.string()).optional(),
    tests: z.array(testReportSchema).optional(),
    issues: z.array(z.string()).optional(),
    needs_master_decision: z.boolean().optional(),
    acceptance_met: z.boolean().optional(),
  }).optional(),
  usage: normalizedUsageSchema.nullable().optional(),
  model: executionProfileSchema.nullable().optional(),
  timing: attemptTimingSchema.nullable().optional(),
  acceptance_met: z.boolean().optional(),
});

const taskProgressEventSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  type: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const taskProgressPageSchema = z.object({
  task_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]),
  events: z.array(taskProgressEventSchema),
  next_seq: z.number().int().nonnegative(),
  has_more: z.boolean(),
  omitted_events: z.number().int().nonnegative().optional(),
  observation: taskObservationSchema.optional(),
  scan_incomplete: z.boolean().optional(),
  scan_cursor: z.string().optional(),
  scan_metrics: z.object({
    bytes_read: z.number().int(),
    records_scanned: z.number().int(),
    invalid_lines: z.number().int(),
    corrupt_count: z.number().int(),
    first_corrupt_offset: z.number().int().nullable(),
    index_fallback: z.number().int(),
  }).optional(),
});

export const taskFeedbackSnapshotV01Schema = z.strictObject({
  schema_version: z.literal("0.1"),
  task_id: z.string(),
  attempt: z.number().int(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]),
  model: z.strictObject({
    provider_id: z.string().nullable(),
    model_id: z.string().nullable(),
    reasoning_level: z.string().nullable(),
    source: z.literal("runtime"),
  }).nullable(),
  phase: z.null(),
  progress: z.null(),
  activity: z.strictObject({
    kind: z.enum(["tool_call", "tool_update"]),
    summary: z.string(),
    observed_at: z.string(),
    currentness: z.literal("last_observed"),
  }).nullable(),
  interaction: z.strictObject({
    state: z.enum(["not_observed", "pending", "answered"]),
    kind: z.enum(["permission", "user_input"]).nullable(),
  }).nullable(),
  result: z.strictObject({
    source: z.literal("agent_report"),
    summary: z.string(),
    issues: stringArray,
    files_changed: stringArray,
    tests: z.array(testReportSchema),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
  }).nullable(),
});

export const toolErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const doctorReportSchema = z.object({
  checked_at: z.string(),
  execution_mode: z.string(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["ok", "warning", "error", "unknown"]),
    summary: z.string(),
  })),
});

export const modelCatalogSchema = z.object({
  workspace: z.string(),
  current_model: z.object({ provider_id: z.string(), model_id: z.string() }).nullable(),
  models: z.array(z.object({
    provider_id: z.string(),
    model_id: z.string(),
    label: z.string(),
    provider_label: z.string().optional(),
    context_window: z.number().optional(),
    max_output_tokens: z.number().optional(),
    reasoning_levels: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    reasoning_default_level: z.string().optional(),
    disabled_reason: z.string().optional(),
  })),
  account_provider_sync: z.enum(["not_needed", "applied", "failed"]),
  cache_status: z.enum(["fresh", "refreshed"]).optional(),
  cached_at: z.string().optional(),
  warning: z.string().optional(),
});

const modelSelectionSchema = z.object({
  provider_id: z.string(),
  model_id: z.string(),
  reasoning_level: z.string().optional(),
});

export const defaultModelSchema = z.object({
  configured: z.boolean(),
  model: modelSelectionSchema.nullable(),
});

// ---- ADR-010 scheduling tools (opt-in via createBridgeServer options) ----

const START_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const THREAD_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export const zcodeScheduleInputSchema = z.strictObject({
  task: zcodeTaskInputSchema,
  start_at: z.string().regex(START_AT_PATTERN, "start_at must be an ISO 8601 datetime carrying a timezone offset (Z or ±HH:MM)"),
  thread_id: z.string().regex(THREAD_ID_PATTERN, "thread_id must be the UUID of the original Codex chat that will receive wakeups"),
});

export const zcodeScheduleStatusInputSchema = z.strictObject({
  task_id: taskIdSchema,
});

export const zcodeScheduleReviewInputSchema = z.strictObject({
  task_id: taskIdSchema,
  attempt: z.number().int().positive(),
  accepted: z.boolean(),
  feedback: z.string().min(1).max(8_000).optional(),
});

export const zcodeScheduleCancelInputSchema = z.strictObject({
  task_id: taskIdSchema,
});

const scheduleSupervisorInfoSchema = z.object({
  unit: z.string(),
  log_path: z.string(),
});

const scheduleGoalStatusSchema = z.enum([
  "scheduled",
  "dispatched",
  "awaiting_review",
  "accepted",
  "cancelled",
  "failed",
]);

export const scheduleReceiptSchema = z.object({
  task_id: z.string(),
  status: scheduleGoalStatusSchema,
  start_at: z.string(),
  thread_id: z.string(),
  created_at: z.string(),
  supervisor: scheduleSupervisorInfoSchema.nullable(),
});

export const scheduleStatusSchema = z.object({
  task_id: z.string(),
  schedule: z.object({
    status: scheduleGoalStatusSchema,
    start_at: z.string(),
    thread_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    cancel_requested: z.boolean(),
    supervisor: scheduleSupervisorInfoSchema.nullable(),
    failure_reason: z.string().nullable(),
  }),
  execution: z.object({
    status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]),
    attempt: z.number().int(),
    error_code: z.string().optional(),
    needs_master_decision: z.boolean().nullable(),
    acceptance_met: z.boolean().optional(),
  }).nullable(),
  goal: z.object({
    attention: z.object({
      reason: z.string(),
      attempt: z.number().int(),
      event_id: z.string(),
      set_at: z.string(),
      detail: z.string().optional(),
    }).nullable(),
    attempt_under_review: z.number().int().nullable(),
    review: z.object({
      attempt: z.number().int(),
      accepted: z.boolean(),
      feedback: z.string().optional(),
      reviewed_at: z.string(),
      operation_id: z.string(),
      outcome: z.enum(["accepted", "continued"]),
    }).nullable(),
  }),
  notifications: z.array(z.object({
    event_id: z.string(),
    reason: z.string(),
    attempt: z.number().int(),
    delivery: z.object({
      state: z.enum(["pending", "sent", "failed", "superseded"]),
      attempts: z.number().int(),
      last_error: z.string().optional(),
      last_attempt_at: z.string().optional(),
      next_retry_at: z.string().optional(),
      sent_at: z.string().optional(),
    }),
  })),
});

export const scheduleReviewResultSchema = z.object({
  task_id: z.string(),
  attempt: z.number().int().positive(),
  accepted: z.boolean(),
  action: z.enum(["accepted", "continued"]),
  receipt: taskReceiptSchema.optional(),
});

export const scheduleCancelResultSchema = z.object({
  task_id: z.string(),
  schedule_status: scheduleGoalStatusSchema,
  task_status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]).nullable(),
});
