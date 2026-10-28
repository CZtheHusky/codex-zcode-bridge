// ADR-010 ScheduleController tests with a scripted manager and recording
// supervisor: start-record-before-execution, idempotent/conflicting submits,
// dispatch failure, review accept/reject/replay/stale/feedback rules, stop
// intent ordering, outbox idempotence, and at-least-once delivery retries.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, writeFileSync } from "node:fs";
import { ScheduleController } from "../src/schedule/controller.js";
import { ScheduleError } from "../src/schedule/errors.js";
import { SCHEDULE_SELF_ASSESSMENT_REQUIREMENT } from "../src/schedule/policy.js";
import { makeScheduleFixture, scheduleTaskPackage, THREAD_ID, VERIFIED_OBSERVATION } from "./schedule-helpers.js";

const START_AT = "2026-10-27T12:00:00+08:00";

function makeController(fixture: Awaited<ReturnType<typeof makeScheduleFixture>>, notifier?: { send: (input: { pipePath: string; threadId: string; callId: string; message: string }) => Promise<void> }) {
  return new ScheduleController({
    store: fixture.store,
    manager: fixture.manager,
    supervisor: fixture.supervisor,
    runnerEntryPath: "/runner/schedule-runner.mjs",
    dataRoot: fixture.dataRoot,
    env: { PATH: "/usr/bin" },
    ...(notifier ? { notifier } : {}),
  });
}

async function submitted(fixture: Awaited<ReturnType<typeof makeScheduleFixture>>, controller: ScheduleController) {
  return controller.submit({ task: scheduleTaskPackage(), start_at: START_AT, thread_id: THREAD_ID });
}

test("submit persists the start record before the supervisor starts", async () => {
  const fixture = await makeScheduleFixture();
  try {
    let sawStartRecord = false;
    fixture.supervisor.failStart = null;
    const originalStart = fixture.supervisor.start.bind(fixture.supervisor);
    fixture.supervisor.start = async (plan) => {
      // Inside start(): spec and state must already be durable.
      sawStartRecord = fixture.store.hasSchedule("goal_1") && fixture.store.readState("goal_1").status === "scheduled";
      return originalStart(plan);
    };
    const controller = makeController(fixture);
    const receipt = await controller.submit({ task: scheduleTaskPackage(), start_at: START_AT, thread_id: THREAD_ID });
    assert.ok(sawStartRecord, "spec/state must be persisted before systemd-run");
    assert.equal(receipt.status, "scheduled");
    assert.equal(receipt.supervisor?.unit, fixture.store.readSpec("goal_1").supervisor_unit);
    assert.match(receipt.supervisor?.unit ?? "", /^zcode-bridge-schedule-[0-9a-f-]{36}$/u);
    assert.ok(receipt.supervisor?.log_path.endsWith("runner.log"));
    const state = fixture.store.readState("goal_1");
    assert.equal(state.status, "scheduled");
    assert.equal(state.cancel_requested, false);
    assert.equal(fixture.store.readSpec("goal_1").thread_id, THREAD_ID);
  } finally {
    await fixture.cleanup();
  }
});

test("identical resubmission replays the receipt; a different request conflicts", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    const first = await submitted(fixture, controller);
    const replay = await controller.submit({ task: scheduleTaskPackage(), start_at: START_AT, thread_id: THREAD_ID });
    assert.equal(replay.created_at, first.created_at);
    assert.deepEqual(fixture.supervisor.plans.map((plan) => plan.unit), [first.supervisor!.unit, first.supervisor!.unit], "supervisor retries must reuse the persisted unit");
    await assert.rejects(
      controller.submit({ task: scheduleTaskPackage({ objective: "different" }), start_at: START_AT, thread_id: THREAD_ID }),
      (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_CONFLICT",
    );
    await assert.rejects(
      controller.submit({ task: scheduleTaskPackage(), start_at: "2026-10-28T12:00:00+08:00", thread_id: THREAD_ID }),
      (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_CONFLICT",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("separate data roots can schedule the same task id without sharing a supervisor unit", async () => {
  const first = await makeScheduleFixture();
  const second = await makeScheduleFixture();
  try {
    const a = await submitted(first, makeController(first));
    const b = await submitted(second, makeController(second));
    assert.notEqual(a.supervisor?.unit, b.supervisor?.unit, "the systemd user namespace is shared by both hosts");
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("submit rejects malformed start_at/thread_id and an id owned by a plain task", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await assert.rejects(controller.submit({ task: scheduleTaskPackage(), start_at: "2026-10-27T12:00:00", thread_id: THREAD_ID }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_INVALID");
    await assert.rejects(controller.submit({ task: scheduleTaskPackage(), start_at: START_AT, thread_id: "not-a-uuid" }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_INVALID");
    await fixture.manager.createTask(scheduleTaskPackage());
    await assert.rejects(controller.submit({ task: scheduleTaskPackage(), start_at: START_AT, thread_id: THREAD_ID }), /already belongs to a non-scheduled Bridge task/);
  } finally {
    await fixture.cleanup();
  }
});

test("supervisor start failure leaves the scheduled goal retryable with the same unit", async () => {
  const fixture = await makeScheduleFixture();
  try {
    fixture.supervisor.failStart = new Error("no user systemd");
    const controller = makeController(fixture);
    await assert.rejects(submitted(fixture, controller), /no user systemd/);
    const state = fixture.store.readState("goal_1");
    assert.equal(state.status, "scheduled");
    assert.match(state.failure_reason ?? "", /no user systemd/);
    assert.deepEqual(fixture.supervisor.stopped, [], "a lost start receipt is not proof that the supervised runner stopped");
    fixture.supervisor.failStart = null;
    const replay = await submitted(fixture, controller);
    assert.equal(replay.status, "scheduled");
    assert.equal(replay.supervisor?.unit, state.supervisor?.unit);
    assert.equal(controller.readState("goal_1").failure_reason, null);
    assert.equal(fixture.manager.calls.filter((call) => call.method === "createTask").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("dispatch derives the scheduled task once and marks the goal dispatched", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await controller.dispatch("goal_1"); // idempotent replay
    const created = fixture.manager.calls.filter((call) => call.method === "createTask");
    assert.equal(created.length, 1);
    const task = created[0]!.args;
    assert.deepEqual(task.requirements.slice(0, -1), scheduleTaskPackage().requirements);
    assert.equal(task.requirements.at(-1), SCHEDULE_SELF_ASSESSMENT_REQUIREMENT);
    assert.equal(fixture.store.readState("goal_1").status, "dispatched");
  } finally {
    await fixture.cleanup();
  }
});

test("dispatch failure fails the goal and enqueues a wakeup", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    fixture.manager.createError = new Error("TASK_ID_CONFLICT: task_id already belongs to a different request");
    await assert.rejects(controller.dispatch("goal_1"), /could not be dispatched/);
    const state = fixture.store.readState("goal_1");
    assert.equal(state.status, "failed");
    const notifications = fixture.store.listNotifications("goal_1");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.reason, "dispatch_failed");
    assert.equal(notifications[0]!.thread_id, THREAD_ID);
    assert.equal(notifications[0]!.delivery.state, "pending");
  } finally {
    await fixture.cleanup();
  }
});

async function reviewingFixture(run: (controller: ScheduleController, fixture: Awaited<ReturnType<typeof makeScheduleFixture>>) => Promise<void>): Promise<void> {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    fixture.manager.status = { ...fixture.manager.status!, status: "completed", observation: VERIFIED_OBSERVATION };
    fixture.manager.result = emptyResult();
    await controller.requestReview("goal_1", 1);
    await run(controller, fixture);
  } finally {
    await fixture.cleanup();
  }
}

test("review acceptance replays without continuation, ends the goal, and blocks cancellation", async () => {
  await reviewingFixture(async (controller, fixture) => {
    const outcome = await controller.review({ task_id: "goal_1", attempt: 1, accepted: true });
    assert.deepEqual(outcome, { task_id: "goal_1", attempt: 1, accepted: true, action: "accepted" });
    assert.equal(controller.readState("goal_1").status, "accepted");
    assert.deepEqual(await controller.review({ task_id: "goal_1", attempt: 1, accepted: true }), outcome);
    assert.equal(fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    await assert.rejects(controller.cancel("goal_1"), /accepted; nothing to cancel/);
  });
});

test("review rejection requires feedback, resumes the same session, and replays", async () => {
  await reviewingFixture(async (controller, fixture) => {
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted: false }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_FEEDBACK_REQUIRED");
    const outcome = await controller.review({ task_id: "goal_1", attempt: 1, accepted: false, feedback: "Tests fail on Windows" });
    assert.equal(outcome.action, "continued");
    const continues = fixture.manager.calls.filter((call) => call.method === "continueTask");
    assert.equal(continues.length, 1);
    const input = continues[0]!.args;
    assert.equal(input.operation_id, "sched-review-goal_1-a1");
    assert.equal(input.expected_attempt, 1, "review feedback must be bound to the independently reviewed attempt");
    assert.match(input.feedback, /Tests fail on Windows/);
    assert.equal(controller.readState("goal_1").status, "dispatched");
    assert.equal(controller.readState("goal_1").attempt_under_review, null);
    const replay = await controller.review({ task_id: "goal_1", attempt: 1, accepted: false, feedback: "Tests fail on Windows" });
    assert.equal(replay.action, "continued");
    assert.equal(fixture.manager.calls.filter((call) => call.method === "continueTask").length, 1, "replay must not continue twice");
    await controller.deliverPending("goal_1");
    assert.equal(fixture.store.listNotifications("goal_1")[0]!.delivery.state, "superseded", "a resumed attempt must not later receive the obsolete review wakeup");
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted: true }), /different review/);
  });
});

test("stale attempts and non-reviewing states are rejected", async () => {
  await reviewingFixture(async (controller) => {
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 2, accepted: true }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_STALE_REVIEW");
  });
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted: true }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_STALE_REVIEW");
    await assert.rejects(controller.review({ task_id: "ghost", attempt: 1, accepted: true }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_NOT_FOUND");
  } finally {
    await fixture.cleanup();
  }
});

test("a completed newer attempt cannot receive an older review", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.status = { ...fixture.manager.status!, attempt: 2 };
    for (const accepted of [true, false]) {
      await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted, feedback: "Fix attempt one" }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_STALE_REVIEW");
    }
    assert.equal(fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0, "old feedback must never continue a newer session attempt");
    assert.equal(controller.readState("goal_1").review_intent, null);
  });
});

test("acceptance waits for verified process cleanup", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.status = { ...fixture.manager.status!, observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted: true }), /cleanup must be verified/);
    assert.equal(controller.readState("goal_1").status, "awaiting_review");
    fixture.manager.status = { ...fixture.manager.status!, observation: VERIFIED_OBSERVATION };
    await controller.recoverReview("goal_1");
    assert.equal(controller.readState("goal_1").status, "accepted", "the already authorized verdict survives the failed cleanup gate");
  });
});

test("cancel persists the stop intent before the manager cancels the task", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    fixture.manager.status = { ...fixture.manager.status!, status: "running" };
    const observed: boolean[] = [];
    fixture.manager.onCancelObserve = () => {
      observed.push(fixture.store.readState("goal_1").cancel_requested);
    };
    const outcome = await controller.cancel("goal_1");
    assert.deepEqual(outcome, { schedule_status: "cancelled", task_status: "cancelled" });
    assert.deepEqual(observed, [true], "stop intent must be durable before TaskManager cancellation");
    assert.equal(fixture.store.readState("goal_1").status, "cancelled");
    // Idempotent replay without another manager cancel.
    const again = await controller.cancel("goal_1");
    assert.equal(again.schedule_status, "cancelled");
    assert.equal(fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 1);
    // A cancelled schedule can no longer be reviewed or revived.
    await controller.requestReview("goal_1", 1);
    assert.notEqual(fixture.store.readState("goal_1").status, "awaiting_review");
    await assert.rejects(controller.review({ task_id: "goal_1", attempt: 1, accepted: true }), /stop intent/);
  } finally {
    await fixture.cleanup();
  }
});

test("cancel of a never-dispatched schedule skips task cancellation", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    const outcome = await controller.cancel("goal_1");
    assert.equal(outcome.schedule_status, "cancelled");
    assert.equal(outcome.task_status, null);
    assert.equal(fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling a clean terminal task ends only the scheduled goal", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.cancelError = new Error("clean terminal tasks cannot be cancelled by TaskManager");
    assert.deepEqual(await controller.cancel("goal_1"), { schedule_status: "cancelled", task_status: "completed" });
    assert.equal(fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 0);
    assert.equal(fixture.store.listNotifications("goal_1")[0]!.delivery.state, "superseded");
  });
});

test("failed terminal cleanup keeps the stop intent, suppresses wakeups, and retries cancellation", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.status = { ...fixture.manager.status!, status: "failed", observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    fixture.manager.cancelError = new Error("cleanup still unverified");
    await assert.rejects(controller.cancel("goal_1"), /cleanup still unverified/);
    assert.equal(controller.readState("goal_1").cancel_requested, true);
    assert.equal(fixture.supervisor.stopped.length, 0, "failed cleanup must leave the supervised recovery path running");
    const sent: string[] = [];
    const restarted = makeController(fixture, { send: async ({ message }) => { sent.push(message); } });
    restarted.noteAppPipePath("/tmp/fake.pipe");
    await restarted.deliverPending("goal_1");
    assert.equal(sent.length, 1, "the cancellation failure itself still requires attention");
    assert.match(sent[0]!, /reason=cancel_failed/u);
    assert.equal(fixture.store.listNotifications("goal_1").find((event) => event.reason === "review_requested")!.delivery.state, "superseded");
    assert.equal(restarted.readState("goal_1").status, "failed");
    assert.equal(restarted.readState("goal_1").attention?.reason, "cancel_failed");
    const continued = await restarted.autoContinue("goal_1", 1, "old feedback", "sched-goal_1-a1");
    assert.equal(continued.continued, false);
    fixture.manager.cancelError = null;
    await restarted.cancel("goal_1");
    assert.equal(fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 2, "terminal status must not prevent retrying unresolved cleanup");
    assert.equal(restarted.readState("goal_1").status, "cancelled");
  });
});

test("cancellation cannot report success when the manager returns with unverified cleanup", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.status = { ...fixture.manager.status!, status: "failed", observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    fixture.manager.cancelCleanup = "unverified";
    await assert.rejects(controller.cancel("goal_1"), /without verified process cleanup/u);
    assert.equal(controller.readState("goal_1").status, "failed");
    assert.equal(controller.readState("goal_1").cancel_requested, true);
    assert.equal(controller.readState("goal_1").attention?.reason, "cancel_failed");
    assert.equal(fixture.supervisor.stopped.length, 0);
    fixture.manager.cancelCleanup = "verified";
    await controller.cancel("goal_1");
    assert.equal(controller.readState("goal_1").status, "cancelled");
    assert.equal(fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 2);
  });
});

test("a stop intent left before dispatch prevents all task creation", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    fixture.store.writeState({ ...controller.readState("goal_1"), cancel_requested: true });
    assert.deepEqual(await controller.dispatch("goal_1"), { dispatched: false });
    assert.equal(fixture.manager.calls.filter((call) => call.method === "createTask").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("autoContinue skips when a stop intent is persisted", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await controller.cancel("goal_1");
    const outcome = await controller.autoContinue("goal_1", 1, "feedback", "sched-goal_1-a1");
    assert.equal(outcome.continued, false);
    assert.match(outcome.reason ?? "", /cancelled/);
    assert.equal(fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("automatic continuation requires a saved session and verified cleanup", async () => {
  await reviewingFixture(async (controller, fixture) => {
    fixture.manager.status = { ...fixture.manager.status!, observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    assert.equal((await controller.autoContinue("goal_1", 1, "continue", "sched-goal_1-a1")).continued, false);
    fixture.manager.status = { ...fixture.manager.status!, observation: VERIFIED_OBSERVATION };
    fixture.manager.result = { ...emptyResult(), session_id: null };
    assert.equal((await controller.autoContinue("goal_1", 1, "continue", "sched-goal_1-a1")).continued, false);
    assert.equal(fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
  });
});

test("escalation and pending-interaction wakeups are idempotent per event", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await controller.escalate("goal_1", 1, "usage_exhausted");
    await controller.escalate("goal_1", 1, "usage_exhausted");
    assert.equal(fixture.store.listNotifications("goal_1").length, 1);
    assert.equal(fixture.store.readState("goal_1").attention?.reason, "usage_exhausted");
    await controller.notifyPendingInteraction("goal_1", 1, { request_id: "1:perm-7", method: "interaction/requestPermission" });
    await controller.notifyPendingInteraction("goal_1", 1, { request_id: "1:perm-7", method: "interaction/requestPermission" });
    await controller.notifyPendingInteraction("goal_1", 1, { request_id: "1:perm-9", method: "interaction/requestPermission" });
    const notifications = fixture.store.listNotifications("goal_1");
    assert.equal(notifications.length, 3);
    assert.deepEqual(notifications.map((entry) => entry.reason).sort(), ["pending_interaction", "pending_interaction", "usage_exhausted"]);
    const permissions = notifications.filter((entry) => entry.reason === "pending_interaction");
    assert.equal(new Set(permissions.map((entry) => entry.event_id)).size, 2);
    assert.ok(permissions.some((entry) => entry.message.includes("request_id=1:perm-7")));
  } finally {
    await fixture.cleanup();
  }
});

test("noteActiveAttempt clears attention once a newer attempt runs", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await controller.escalate("goal_1", 1, "task_failed");
    await controller.noteActiveAttempt("goal_1", 1);
    assert.equal(fixture.store.readState("goal_1").attention?.reason, "task_failed", "same attempt keeps the attention");
    await controller.noteActiveAttempt("goal_1", 2);
    assert.equal(fixture.store.readState("goal_1").attention, null);
  } finally {
    await fixture.cleanup();
  }
});

test("status view separates goal, execution, and notifications", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = makeController(fixture);
    await submitted(fixture, controller);
    const before = await controller.status("goal_1");
    assert.equal(before.schedule.status, "scheduled");
    assert.equal(before.execution, null);
    await controller.dispatch("goal_1");
    assert.equal((await controller.status("goal_1")).execution?.needs_master_decision, null, "an uncommitted result cannot establish a decision verdict");
    fixture.manager.status = { ...fixture.manager.status!, status: "completed" };
    fixture.manager.result = {
      ...emptyResult(),
      status: "completed",
      acceptance_met: true,
    };
    const view = await controller.status("goal_1");
    assert.equal(view.execution?.status, "completed");
    assert.equal(view.execution?.acceptance_met, true);
    assert.equal(view.notifications.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("delivery marks sent events, retries failures with persisted state, and reports a missing pipe", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const sent: string[] = [];
    let failures = 1;
    const controller = new ScheduleController({
      store: fixture.store,
      manager: fixture.manager,
      supervisor: fixture.supervisor,
      runnerEntryPath: "/runner/schedule-runner.mjs",
      dataRoot: fixture.dataRoot,
      env: {},
      notifier: {
        send: async ({ message }) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("pipe connect timeout");
          }
          sent.push(message);
        },
      },
    });
    await submitted(fixture, controller);
    await controller.dispatch("goal_1");
    await controller.escalate("goal_1", 1, "task_failed", { errorCode: "zcode_nonzero_exit" });

    // No pipe configured: the failure is persisted, never dropped.
    await controller.deliverPending("goal_1");
    let [event] = fixture.store.listNotifications("goal_1");
    assert.equal(event!.delivery.state, "failed");
    assert.match(event!.delivery.last_error ?? "", /pipe is not configured/);
    assert.ok(event!.delivery.next_retry_at, "a retry deadline is persisted");

    // Pipe configured but the first send fails: attempts increment once the
    // persisted retry deadline passes (simulated by clearing it).
    fixture.store.writeRuntime({ app_pipe_path: "/tmp/fake.pipe", updated_at: new Date().toISOString() });
    fixture.store.writeNotification("goal_1", { ...fixture.store.listNotifications("goal_1")[0]!, delivery: { ...fixture.store.listNotifications("goal_1")[0]!.delivery, next_retry_at: undefined } });
    await controller.deliverPending("goal_1");
    [event] = fixture.store.listNotifications("goal_1");
    assert.equal(event!.delivery.state, "failed");
    assert.equal(event!.delivery.attempts, 2);
    assert.match(event!.delivery.last_error ?? "", /pipe connect timeout/);

    // Next_retry_at not yet due: skipped this round.
    await controller.deliverPending("goal_1");
    [event] = fixture.store.listNotifications("goal_1");
    assert.equal(event!.delivery.attempts, 2);

    // After the deadline the send succeeds and is marked sent once.
    fixture.store.writeNotification("goal_1", { ...event!, delivery: { ...event!.delivery, next_retry_at: undefined } });
    await controller.deliverPending("goal_1");
    [event] = fixture.store.listNotifications("goal_1");
    assert.equal(event!.delivery.state, "sent");
    assert.equal(sent.length, 1);
    assert.equal(controller.hasUndeliveredNotifications("goal_1"), false);
    await controller.deliverPending("goal_1"); // sent events are never resent
    assert.equal(sent.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("delivery reconstructs a missing outbox from durable attention after restart", async () => {
  await reviewingFixture(async (_controller, fixture) => {
    const original = fixture.store.listNotifications("goal_1")[0]!;
    rmSync(fixture.store.notificationPath("goal_1"));
    const sent: string[] = [];
    const restarted = makeController(fixture, { send: async ({ message }) => { sent.push(message); } });
    restarted.noteAppPipePath("/tmp/fake.pipe");
    await restarted.deliverPending("goal_1");
    const rebuilt = fixture.store.listNotifications("goal_1");
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]!.event_id, original.event_id, "reconstruction preserves the at-least-once event identity");
    assert.equal(rebuilt[0]!.delivery.state, "sent");
    assert.equal(sent.length, 1);
    await restarted.deliverPending("goal_1");
    assert.equal(sent.length, 1);
  });
});

test("a corrupt persisted outbox is reported instead of silently dropping a wakeup", async () => {
  await reviewingFixture(async (controller, fixture) => {
    writeFileSync(fixture.store.notificationPath("goal_1"), "{truncated");
    await assert.rejects(controller.status("goal_1"), SyntaxError);
    await assert.rejects(controller.deliverPending("goal_1"), SyntaxError);
    assert.equal(controller.readState("goal_1").status, "awaiting_review");
  });
});

function emptyResult() {
  return {
    task_id: "goal_1",
    status: "completed" as const,
    summary: "done",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "",
    exit_code: 0,
    session_id: "sess_1",
    attempt: 1,
    started_at: null,
    finished_at: new Date().toISOString(),
  };
}
