// ADR-010 MCP registration for the four scheduling tools. Registered ONLY
// when the host explicitly injects a ScheduleController (opt-in, like the
// project ledger); the frozen core tools behave exactly as before without it.
// These tools are host-facing: zcode_schedule_review records the independent
// Codex verdict; a worker self-assessment can never accept a goal.
import type { McpServer } from "@modelcontextprotocol/server";
import { TaskManagerError } from "../manager/errors.js";
import type { ScheduleController } from "./controller.js";
import { ScheduleError } from "./errors.js";
import {
  scheduleCancelResultSchema,
  scheduleReceiptSchema,
  scheduleReviewResultSchema,
  scheduleStatusSchema,
  zcodeScheduleCancelInputSchema,
  zcodeScheduleInputSchema,
  zcodeScheduleReviewInputSchema,
  zcodeScheduleStatusInputSchema,
} from "../mcp/schemas.js";

export interface ScheduleToolOptions {
  readonly controller: ScheduleController;
  /** Reads the host-owned App tools pipe location at call time so an MCP
   * host reconnect can refresh it; absent means not configured. */
  readonly appPipeSource?: () => string | null;
}

function okResult(data: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: { ...data } };
}

function errorResult(code: string, message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `${code}: ${message}` }], structuredContent: { error: { code, message } } };
}

function mapScheduleError(error: unknown) {
  if (error instanceof ScheduleError) return errorResult(error.code, error.message);
  if (error instanceof TaskManagerError) return errorResult(error.code, error.message);
  throw error;
}

const SCHEDULE_QUIET_NOTE =
  "Scheduled goals run quietly: normal progress and a false self-assessment continue the SAME ZCode session without model wakeups; only review requests, blocked interactions, failures, quota exhaustion, unverified cleanup, or a missing self-assessment wake the original chat.";

export function registerScheduleTools(server: McpServer, options: ScheduleToolOptions): void {
  const controller = options.controller;
  const refreshPipe = (): void => {
    const pipe = options.appPipeSource?.();
    if (pipe) controller.noteAppPipePath(pipe);
  };

  server.registerTool("zcode_schedule", {
    title: "Schedule one ZCode goal for autonomous execution",
    description: `Submit one bounded goal to start at an absolute time (ISO datetime WITH timezone) on this Linux host, supervised by the user's systemd manager. task_id is the schedule key: an identical resubmission replays the schedule receipt; a different request with the same id returns SCHEDULE_CONFLICT. thread_id MUST be the UUID of the current original Codex chat, captured from host context (for example CODEX_THREAD_ID when the host provides it) — never guessed from unrelated environment. The scheduled prompt additionally requires the agent's boolean acceptance_met self-assessment: false continues the same session quietly, true wakes thread_id for independent review, and a missing/invalid assessment wakes it with uncertainty. Requires user-level systemd; a missing supervisor or App pipe fails visibly for scheduling only while the ordinary tools keep working. ${SCHEDULE_QUIET_NOTE}`,
    inputSchema: zcodeScheduleInputSchema,
    outputSchema: scheduleReceiptSchema,
  }, async (args: { task: Parameters<ScheduleController["submit"]>[0]["task"]; start_at: string; thread_id: string }) => {
    try {
      refreshPipe();
      if (options.appPipeSource && !options.appPipeSource()) throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", "Codex App tools pipe is not configured; cannot schedule a goal with a completion wakeup");
      return okResult(await controller.submit({ task: args.task, start_at: args.start_at, thread_id: args.thread_id }));
    } catch (error) { return mapScheduleError(error); }
  });

  server.registerTool("zcode_schedule_status", {
    title: "Read scheduled goal status",
    description: `Read one schedule's goal state (scheduled/dispatched/awaiting_review/accepted/cancelled/failed), the live Bridge execution state for its task, any attention reason, the pending review window, and wakeup delivery states. Execution status and goal review are reported separately; a sent wakeup is never task acceptance. ${SCHEDULE_QUIET_NOTE}`,
    inputSchema: zcodeScheduleStatusInputSchema,
    outputSchema: scheduleStatusSchema,
  }, async (args: { task_id: string }) => {
    try {
      refreshPipe();
      return okResult(await controller.status(args.task_id));
    } catch (error) { return mapScheduleError(error); }
  });

  server.registerTool("zcode_schedule_review", {
    title: "Record the independent review verdict for a scheduled goal",
    description: `After zcode_schedule_status shows awaiting_review, verify the work independently, then record the verdict for exactly that attempt. accepted=true ends the goal. accepted=false REQUIRES concrete feedback and resumes the SAME ZCode session through a stable continuation; address every feedback point. Stale attempts, cancelled goals, and conflicting verdicts are rejected; retrying the identical verdict replays the recorded outcome.`,
    inputSchema: zcodeScheduleReviewInputSchema,
    outputSchema: scheduleReviewResultSchema,
  }, async (args: { task_id: string; attempt: number; accepted: boolean; feedback?: string }) => {
    try {
      refreshPipe();
      return okResult(await controller.review(args));
    } catch (error) { return mapScheduleError(error); }
  });

  server.registerTool("zcode_schedule_cancel", {
    title: "Cancel a scheduled goal",
    description: "Cancel one scheduled goal: the stop intent is persisted FIRST (blocking any further automatic continuation), then any existing task is cancelled through the verified process-tree path. Idempotent; cancelling an accepted goal is rejected. Obsolete undelivered wakeup events are superseded.",
    inputSchema: zcodeScheduleCancelInputSchema,
    outputSchema: scheduleCancelResultSchema,
  }, async (args: { task_id: string }) => {
    try {
      refreshPipe();
      return okResult({ task_id: args.task_id, ...await controller.cancel(args.task_id) });
    } catch (error) { return mapScheduleError(error); }
  });
}
