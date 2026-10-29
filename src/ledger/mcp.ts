// C1/C2/C3 MCP entry points for the project-task ledger. Registered ONLY when
// the host explicitly provides a LedgerStore (opt-in); the 12 frozen core
// tools are untouched and coding_agent_task never creates ledger data. The ledger
// tools are host-facing: review/complete/exempt require the controlled host
// actor, so a worker report can never close a task.
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BridgeTaskManager } from "../manager/task-manager.js";
import { TaskManagerError } from "../manager/errors.js";
import { LedgerBridgeLink } from "./bridge.js";
import { LedgerError } from "./types.js";
import type { LedgerStore } from "./store.js";

export interface LedgerToolOptions {
  readonly store: LedgerStore;
  readonly taskManager: BridgeTaskManager;
  /** The controlled authorization identity for review/complete/exempt. */
  readonly hostActorId?: string;
}

function errorResult(code: string, message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `${code}: ${message}` }], structuredContent: { error: { code, message } } };
}

function okResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function mapLedgerError(error: unknown) {
  if (error instanceof LedgerError) return errorResult(error.code, error.message);
  if (error instanceof TaskManagerError) return errorResult(error.code, error.message);
  throw error;
}

const hostActor = (options: LedgerToolOptions) => ({ source: "host" as const, id: options.hostActorId ?? "controlled-host-entry" });

const projectIdSchema = z.string().trim().min(1).optional();
const taskIdSchema = z.string().trim().min(1);
const acSchema = z.object({ id: z.string().trim().min(1), text: z.string().trim().min(1) });

/** Registers the opt-in ledger_* tools. Names never collide with the frozen
 * core tools; required parameters of existing tools are unchanged. */
export function registerLedgerTools(server: McpServer, options: LedgerToolOptions): void {
  const link = new LedgerBridgeLink(options.store);

  server.registerTool("coding_agent_ledger_project_create", {
    title: "Create a project task ledger project",
    description: "Opt-in project ledger: create a project bound to an explicit absolute workspace. The ledger is independent of Bridge execution state.",
    inputSchema: z.strictObject({ project_id: z.string().trim().min(1).optional(), title: z.string().trim().min(1), workspace: z.string().trim().min(1) }),
  }, async (args: { project_id?: string; title: string; workspace: string }) => {
    try {
      return okResult({ project: options.store.createProject(args, `mcp:project:${args.project_id ?? args.title}:${fingerprintOf(args)}`) } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_summary", {
    title: "Read the project ledger summary",
    description: "Read-only: task list with statuses, review verdicts, and a coverage note. Task-count ratios are never overall engineering completion.",
    inputSchema: z.strictObject({ project_id: projectIdSchema }),
  }, async (args: { project_id?: string }) => {
    try { return okResult(options.store.summary(args.project_id) as unknown as Record<string, unknown>); }
    catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_task_create", {
    title: "Create a ledger project task",
    description: "Create a long-lived ProjectTask with numbered acceptance criteria, constraints, dependencies (cycles refused), and an explicit workspace binding.",
    inputSchema: z.strictObject({
      task_id: z.string().trim().regex(/^[a-z][a-z0-9_-]{2,63}$/u).optional(),
      project_id: projectIdSchema,
      goal: z.string().trim().min(1),
      acceptance_criteria: z.array(acSchema).min(1),
      workspace: z.string().trim().min(1),
      dependencies: z.array(z.string()).optional(),
      epic_id: z.string().trim().min(1).nullable().optional(),
      assignee: z.string().trim().min(1).nullable().optional(),
    }),
  }, async (args) => {
    try {
      return okResult({ task: options.store.createTask({ ...args, constraints: { allowed_paths: [], forbidden_paths: [] } }, `mcp:task:${args.task_id ?? args.goal}:${fingerprintOf(args)}`) } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_task_update", {
    title: "Update a ledger project task definition",
    description: "Update goal/AC/dependencies. A definition change bumps the definition version and invalidates prior approvals.",
    inputSchema: z.strictObject({
      task_id: taskIdSchema,
      goal: z.string().trim().min(1).optional(),
      acceptance_criteria: z.array(acSchema).optional(),
      dependencies: z.array(z.string()).optional(),
      assignee: z.string().trim().min(1).nullable().optional(),
      open_decisions: z.array(z.string()).optional(),
      expected_revision: z.number().int().nonnegative().optional(),
    }),
  }, async (args: { task_id: string; expected_revision?: number } & Record<string, unknown>) => {
    try {
      const { task_id, expected_revision, ...patch } = args;
      return okResult({ task: options.store.updateTask(task_id, patch, `mcp:update:${task_id}:${String(expected_revision ?? options.store.revision)}`, hostActor(options), expected_revision) } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_task_get", {
    title: "Read one ledger task",
    description: "Read-only task detail: definition, ACs, exemptions, runs, and latest review.",
    inputSchema: z.strictObject({ task_id: taskIdSchema }),
  }, async (args: { task_id: string }) => {
    try {
      const task = options.store.getTask(args.task_id);
      const runs = options.store.listRuns({ task_id: args.task_id });
      const review = options.store.latestReview(args.task_id);
      return okResult({ task, runs, latest_review: review } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_task_history", {
    title: "Read ledger task history",
    description: "Read-only journal history for one task (change authority).",
    inputSchema: z.strictObject({ task_id: taskIdSchema }),
  }, async (args: { task_id: string }) => {
    try { return okResult({ task_id: args.task_id, history: options.store.taskHistory(args.task_id) } as Record<string, unknown>); }
    catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_run_start", {
    title: "Start a ledger run and dispatch to the Bridge",
    description: "Persists the run intent with a deterministic executor task id BEFORE dispatching, then calls coding_agent_task internally. A lost receipt recovers the same execution; retries reuse the same operation_id. executor 'manual' records external work with evidence instead of dispatching.",
    inputSchema: z.strictObject({
      task_id: taskIdSchema,
      operation_id: z.string().trim().min(1).max(100),
      executor: z.enum(["zcode-bridge", "manual"]),
      manual_evidence: z.string().trim().min(1).optional(),
      task_package: z.object({
        objective: z.string().min(1),
        requirements: z.array(z.string()),
        allowed_paths: z.array(z.string()),
        forbidden_paths: z.array(z.string()),
        acceptance_criteria: z.array(z.string()),
        test_commands: z.array(z.string()),
        context: z.string().optional(),
        timeout_ms: z.number().int().min(60_000).max(14_400_000).optional(),
      }).optional(),
    }),
  }, async (args) => {
    try {
      if (args.executor === "manual") {
        const run = options.store.startRun({ task_id: args.task_id, executor: { kind: "manual" }, manual_evidence: args.manual_evidence }, `mcp:run:${args.operation_id}`, hostActor(options));
        return okResult({ run_id: run.run_id, status: "recorded" } as Record<string, unknown>);
      }
      if (!args.task_package) {
        return errorResult("LEDGER_INVALID", "executor zcode-bridge requires task_package (the workspace/worktree come from the ledger task binding)");
      }
      const task = options.store.getTask(args.task_id);
      const outcome = await link.dispatchTask(options.taskManager, {
        project_task_id: args.task_id,
        operation_id: args.operation_id,
        buildTaskPackage: (executorTaskId) => ({
          task_id: executorTaskId,
          workspace: task.workspace,
          objective: args.task_package!.objective,
          requirements: args.task_package!.requirements,
          allowed_paths: args.task_package!.allowed_paths,
          forbidden_paths: args.task_package!.forbidden_paths,
          acceptance_criteria: args.task_package!.acceptance_criteria,
          test_commands: args.task_package!.test_commands,
          ...(args.task_package!.context !== undefined ? { context: args.task_package!.context } : {}),
          ...(args.task_package!.timeout_ms !== undefined ? { timeout_ms: args.task_package!.timeout_ms } : {}),
        }),
        actor: hostActor(options),
      });
      return okResult(outcome as unknown as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_run_link", {
    title: "Project Bridge evidence onto a ledger run",
    description: "Reads the Bridge task's events and result, projects accepted/started/model-confirmation/finished facts onto the run (idempotent). Never derives the business status: DONE requires the review gate.",
    inputSchema: z.strictObject({ run_id: z.string().trim().min(1) }),
  }, async (args: { run_id: string }) => {
    try { return okResult(await link.syncRunFromBridge(options.taskManager, args.run_id) as unknown as Record<string, unknown>); }
    catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_review", {
    title: "Record a per-AC review",
    description: "Controlled host entry: records per-acceptance-criterion verdicts with evidence and binds deliverable fingerprints to the current definition version. Rejection returns the task to ready. Worker self-reports cannot call this.",
    inputSchema: z.strictObject({
      task_id: taskIdSchema,
      results: z.array(z.object({ ac_id: z.string().trim().min(1), verdict: z.enum(["pass", "fail", "not_verified"]), evidence: z.string().trim().min(1) })).min(1),
      deliverable_fingerprints: z.array(z.object({ path: z.string().trim().min(1), sha256: z.string().trim().min(1) })).min(1),
      verdict: z.enum(["approved", "rejected"]),
      reason: z.string().trim().min(1).nullable().optional(),
    }),
  }, async (args) => {
    try {
      const outcome = options.store.recordReview(args, `mcp:review:${args.task_id}:${fingerprintOf(args)}`, hostActor(options));
      return okResult(outcome as unknown as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_complete", {
    title: "Complete a project task (DONE gate)",
    description: "Controlled host entry: DONE requires a current approved review bound to the current definition version, every AC passed or explicitly exempted, and a delivery receipt for the bound workspace. Refuses otherwise.",
    inputSchema: z.strictObject({
      task_id: taskIdSchema,
      delivery: z.object({ accepted: z.literal(true), workspace: z.string().trim().min(1), evidence: z.string().trim().min(1) }),
      deliverable_fingerprints: z.array(z.object({ path: z.string().trim().min(1), sha256: z.string().trim().min(1) })).optional(),
    }),
  }, async (args: { task_id: string; delivery: { accepted: true; workspace: string; evidence: string }; deliverable_fingerprints?: Array<{ path: string; sha256: string }> }) => {
    try {
      return okResult({ task: options.store.completeTask(args, `mcp:complete:${args.task_id}:${fingerprintOf(args)}`, hostActor(options)) } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });

  server.registerTool("coding_agent_ledger_reopen", {
    title: "Reopen a done project task",
    description: "Explicit reopen event with a reason; prior DONE/review history is preserved, never overwritten.",
    inputSchema: z.strictObject({ task_id: taskIdSchema, reason: z.string().trim().min(1) }),
  }, async (args: { task_id: string; reason: string }) => {
    try {
      return okResult({ task: options.store.reopenTask(args.task_id, args.reason, `mcp:reopen:${args.task_id}:${fingerprintOf(args)}`, hostActor(options)) } as Record<string, unknown>);
    } catch (error) { return mapLedgerError(error); }
  });
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
