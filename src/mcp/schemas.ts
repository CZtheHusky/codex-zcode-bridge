// Frozen tool schemas per docs/INTERFACES.md (strict, snake_case, unknown
// fields rejected). Rendered with Zod 4 schemas, which the official
// MCP TypeScript SDK v2 accepts directly as tool input schemas; unknown or
// missing fields fail input validation before the TaskManager is invoked.
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
  }).optional(),
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
