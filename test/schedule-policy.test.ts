// ADR-010 scheduling policy: terminal decisions from COMMITTED results only,
// derived task determinism, stable event ids, and notification messages that
// carry stable ids + instructions but never result content.
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskResult } from "../src/interfaces.js";
import {
  SCHEDULE_SELF_ASSESSMENT_REQUIREMENT,
  autoContinueOperationId,
  buildEventId,
  buildNotificationMessage,
  buildReviewContinueFeedback,
  deriveScheduledTask,
  evaluateTerminalResult,
  reviewContinueOperationId,
} from "../src/schedule/policy.js";
import { scheduleTaskPackage } from "./schedule-helpers.js";

function result(overrides: Partial<TaskResult>): TaskResult {
  return {
    task_id: "task_1",
    status: "completed",
    summary: "s",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "",
    exit_code: 0,
    session_id: "sess_x",
    attempt: 1,
    started_at: null,
    finished_at: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

test("completed + acceptance_met=true requests independent review", () => {
  const decision = evaluateTerminalResult("task_1", result({ acceptance_met: true }));
  assert.deepEqual(decision, { action: "request_review" });
});

test("completed + acceptance_met=false continues the same task quietly", () => {
  const decision = evaluateTerminalResult("task_1", result({ acceptance_met: false }));
  assert.equal(decision.action, "continue");
  if (decision.action !== "continue") return;
  assert.match(decision.feedback, /acceptance_met=false/);
  assert.equal(decision.operation_id, autoContinueOperationId("task_1", 1));
  assert.equal(decision.operation_id, "sched-task_1-a1");
});

test("completed without a self-assessment escalates uncertainty", () => {
  const decision = evaluateTerminalResult("task_1", result({}));
  assert.deepEqual(decision, { action: "escalate", reason: "missing_self_assessment", detail: "acceptance_met absent" });
});

test("waiting_for_master escalates a decision request", () => {
  const decision = evaluateTerminalResult("task_1", result({ status: "waiting_for_master", needs_master_decision: true }));
  assert.deepEqual(decision, { action: "escalate", reason: "needs_decision" });
});

test("usage exhaustion always escalates and never retries", () => {
  const decision = evaluateTerminalResult("task_1", result({ status: "failed", error_code: "zcode_usage_exhausted", session_id: "sess_x" }));
  assert.deepEqual(decision, { action: "escalate", reason: "usage_exhausted" });
});

test("timeout continues only with an existing session", () => {
  const withSession = evaluateTerminalResult("task_1", result({ status: "failed", error_code: "timeout", session_id: "sess_x" }));
  assert.equal(withSession.action, "continue");
  const withoutSession = evaluateTerminalResult("task_1", result({ status: "failed", error_code: "timeout", session_id: null }));
  assert.deepEqual(withoutSession, { action: "escalate", reason: "task_failed", detail: "timeout" });
});

test("cleanup failure and other failures escalate with the error code", () => {
  const cleanup = evaluateTerminalResult("task_1", result({ status: "failed", error_code: "cleanup_failed", session_id: "sess_x" }));
  assert.deepEqual(cleanup, { action: "escalate", reason: "task_failed", detail: "cleanup_failed" });
  const invalid = evaluateTerminalResult("task_1", result({ status: "failed", error_code: "invalid_agent_report" }));
  assert.deepEqual(invalid, { action: "escalate", reason: "task_failed", detail: "invalid_agent_report" });
});

test("external cancellation escalates", () => {
  const decision = evaluateTerminalResult("task_1", result({ status: "cancelled" }));
  assert.deepEqual(decision, { action: "escalate", reason: "task_cancelled" });
});

test("deriveScheduledTask is deterministic and only adds the requirement", () => {
  const task = scheduleTaskPackage();
  const first = deriveScheduledTask(task);
  const second = deriveScheduledTask(task);
  assert.deepEqual(first, second);
  assert.deepEqual(first.requirements, [...task.requirements, SCHEDULE_SELF_ASSESSMENT_REQUIREMENT]);
  assert.equal(first.task_id, task.task_id);
});

test("event ids preserve distinct permission request ids across retries", () => {
  assert.equal(buildEventId("task_1", 2, "task_failed"), buildEventId("task_1", 2, "task_failed"));
  assert.notEqual(buildEventId("task_1", 2, "pending_interaction", "2:permission/a"), buildEventId("task_1", 2, "pending_interaction", "2:permission:a"));
  assert.notEqual(buildEventId("task_1", 2, "pending_interaction", `2:${"a".repeat(80)}1`), buildEventId("task_1", 2, "pending_interaction", `2:${"a".repeat(80)}2`));
  assert.notEqual(buildEventId("task_1", 3, "task_failed"), buildEventId("task_1", 2, "task_failed"));
});

test("notification messages reference tools and ids only, never result content", () => {
  const eventId = buildEventId("task_1", 2, "task_failed");
  const message = buildNotificationMessage({ eventId, taskId: "task_1", attempt: 2, reason: "task_failed", errorCode: "zcode_nonzero_exit" });
  assert.ok(message.includes(`Event ID: ${JSON.stringify(eventId)}`), "the host can identify repeated delivery of one persisted event");
  assert.match(message, /"task_1"/);
  assert.match(message, /attempt 2/);
  assert.match(message, /reason=task_failed/);
  assert.match(message, /error_code=zcode_nonzero_exit/);
  assert.match(message, /zcode_schedule_review/);
  assert.match(message, /zcode_interaction_reply/);
  assert.match(message, /never auto-approves/);
  assert.doesNotMatch(message, /zcode_output|files_changed/);
  const withRequest = buildNotificationMessage({ eventId: buildEventId("task_1", 1, "pending_interaction", "1:perm-9"), taskId: "task_1", attempt: 1, reason: "pending_interaction", requestId: "1:perm-9" });
  assert.match(withRequest, /request_id=1:perm-9/);
});

test("review continuation feedback embeds the reviewer's feedback verbatim", () => {
  const feedback = buildReviewContinueFeedback("Fix the off-by-one in parser.ts", 3);
  assert.match(feedback, /attempt 3 rejected the work/);
  assert.match(feedback, /REVIEW FEEDBACK:\nFix the off-by-one in parser.ts/);
  assert.match(feedback, /acceptance_met/);
  assert.equal(reviewContinueOperationId("task_1", 3), "sched-review-task_1-a3");
});
