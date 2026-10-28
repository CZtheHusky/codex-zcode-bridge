// ADR-010 scheduling policy: pure functions only. The scheduler derives the
// dispatched TaskPackage deterministically (so retries fingerprint identically
// through TaskManager.createTask), decides what a committed terminal result
// means for the goal, and renders wakeup messages that carry stable ids and
// inspection instructions only — never worker prompts, summaries, tool
// inputs, or secrets.
import type { TaskPackage, TaskResult } from "../interfaces.js";
import type { ScheduleAttentionReason } from "./types.js";

/** Appended to requirements so ONLY scheduled tasks must self-assess; generic
 * zcode_task submissions are untouched and may omit acceptance_met. */
export const SCHEDULE_SELF_ASSESSMENT_REQUIREMENT =
  "This task runs under a scheduled autonomous loop. Your final JSON response must additionally include the boolean field acceptance_met: your honest assessment of whether this task's acceptance criteria are met by the completed work. This self-assessment is not the master's acceptance; the master still verifies independently. Set acceptance_met=false when the criteria are not yet met, and never set it true merely because work stopped.";

export function deriveScheduledTask(task: TaskPackage): TaskPackage {
  return { ...task, requirements: [...task.requirements, SCHEDULE_SELF_ASSESSMENT_REQUIREMENT] };
}

export function autoContinueOperationId(taskId: string, attempt: number): string {
  return `sched-${taskId}-a${String(attempt)}`;
}

export function reviewContinueOperationId(taskId: string, attempt: number): string {
  return `sched-review-${taskId}-a${String(attempt)}`;
}

/** Stable event id from task/attempt/reason (+ request id when applicable). */
export function buildEventId(taskId: string, attempt: number, reason: ScheduleAttentionReason, suffix = ""): string {
  return `${taskId}:${attempt}:${reason}${suffix ? `:${suffix}` : ""}`;
}

export type TerminalDecision =
  | { action: "continue"; feedback: string; operation_id: string }
  | { action: "request_review" }
  | { action: "escalate"; reason: ScheduleAttentionReason; detail?: string }
  | { action: "none" };

/** Decides one COMMITTED current-attempt TaskResult (ADR-010 #4). Escalation
 * cases never auto-approve and never retry on their own; only an
 * acceptance_met=false completion or a verified-cleanup timeout with a live
 * session continues automatically. */
export function evaluateTerminalResult(taskId: string, result: TaskResult): TerminalDecision {
  switch (result.status) {
    case "completed":
      if (result.acceptance_met === true) return { action: "request_review" };
      if (result.acceptance_met === false) {
        return {
          action: "continue",
          feedback: "Scheduled self-assessment continuation: the previous attempt ended with acceptance_met=false. Continue the SAME task in this session toward the acceptance criteria, then finish with the required JSON report including the honest acceptance_met self-assessment. Do not repeat verification work that already passed.",
          operation_id: autoContinueOperationId(taskId, result.attempt),
        };
      }
      return { action: "escalate", reason: "missing_self_assessment", detail: "acceptance_met absent" };
    case "waiting_for_master":
      return { action: "escalate", reason: "needs_decision" };
    case "failed":
      if (result.error_code === "zcode_usage_exhausted") return { action: "escalate", reason: "usage_exhausted" };
      // A timeout outcome only survives with a verified process-tree cleanup;
      // an unverified cleanup surfaces as error_code "cleanup_failed" instead.
      // Continuation additionally requires an existing session to resume.
      if (result.error_code === "timeout" && result.session_id !== null) {
        return {
          action: "continue",
          feedback: "The previous attempt hit its wall-clock timeout with the session preserved and cleanup verified. Continue the SAME task in this session from where it stopped, then finish with the required JSON report including the honest acceptance_met self-assessment.",
          operation_id: autoContinueOperationId(taskId, result.attempt),
        };
      }
      return { action: "escalate", reason: "task_failed", detail: result.error_code };
    case "cancelled":
      return { action: "escalate", reason: "task_cancelled" };
    default:
      return { action: "none" };
  }
}

const REASON_HEADLINES: Record<ScheduleAttentionReason, string> = {
  pending_interaction: "ZCode is blocked waiting for a permission or input decision",
  review_requested: "attempt finished with acceptance_met=true; independent review required",
  needs_decision: "the agent flagged needs_master_decision",
  task_failed: "the attempt failed",
  usage_exhausted: "provider usage quota is exhausted",
  task_cancelled: "the task was cancelled outside the schedule",
  missing_self_assessment: "the attempt completed without the required acceptance_met self-assessment; treat the outcome as uncertain",
  dispatch_failed: "the scheduler could not start the task",
  continue_failed: "the scheduler could not continue the session automatically",
  cancel_failed: "cancellation cleanup is unverified; the stop intent is preserved and a human decision is required",
};

export interface NotificationMessageInput {
  readonly eventId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly reason: ScheduleAttentionReason;
  readonly requestId?: string;
  readonly errorCode?: string;
}

/** Stable ids + instructions only; no result content is interpolated. */
export function buildNotificationMessage(input: NotificationMessageInput): string {
  const lines = [
    `Event ID: ${JSON.stringify(input.eventId)}`,
    `[ZCode Bridge schedule] task "${input.taskId}" attempt ${String(input.attempt)}: ${REASON_HEADLINES[input.reason]}.`,
    "This is a scheduler wakeup, not task acceptance; execution status and goal review are separate.",
    `- Inspect the authoritative state yourself with zcode_schedule_status (task_id "${input.taskId}"), then zcode_status / zcode_result / zcode_events on the task.`,
    "- If the agent self-assessed acceptance_met=true: independently verify the work, then call zcode_schedule_review with accepted=true, or accepted=false plus concrete feedback to resume the SAME ZCode session.",
    "- For a pending permission or input request: decide with the user and reply via zcode_interaction_reply using the exact request_id; the scheduler never auto-approves.",
    "- If provider quota is exhausted or cleanup is unverified: stop, inform the user, and do not auto-retry or continue.",
    "- Notify the human only when you accept the outcome or a human decision is required.",
  ];
  const parts = [`reason=${input.reason}`];
  if (input.requestId) parts.push(`request_id=${input.requestId}`);
  if (input.errorCode) parts.push(`error_code=${input.errorCode}`);
  lines.push(parts.join(" "));
  return lines.join("\n");
}

export function buildReviewContinueFeedback(feedback: string, attempt: number): string {
  return [
    `Independent review of attempt ${String(attempt)} rejected the work. Address every point below, continue the SAME task in this session, then finish with the required JSON report including the honest acceptance_met self-assessment.`,
    `REVIEW FEEDBACK:\n${feedback}`,
  ].join("\n\n");
}
