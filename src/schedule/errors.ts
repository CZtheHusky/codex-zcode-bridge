// ADR-010 scheduling error taxonomy, mapped onto MCP tool-error results by
// the schedule tool registration (src/schedule/mcp.ts). TaskManagerError from
// composed manager calls propagates unchanged so existing task error codes
// keep their meaning.
export type ScheduleErrorCode =
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_INVALID"
  | "SCHEDULE_CONFLICT"
  | "SCHEDULE_STATE"
  | "SCHEDULE_STALE_REVIEW"
  | "SCHEDULE_FEEDBACK_REQUIRED"
  | "SCHEDULE_SUPERVISOR_UNAVAILABLE";

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}
