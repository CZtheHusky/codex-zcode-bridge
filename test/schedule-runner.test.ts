// ADR-010 runner tests with a scripted manager and a REAL TaskStore: the
// scheduled start gates execution, committed results drive the goal policy
// (quiet continuation, review request, escalation), pending interactions
// wake once per request, and restart replays never duplicate execution.
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskResult, TaskStatusRecord } from "../src/interfaces.js";
import { TaskStore } from "../src/store/task-store.js";
import { ScheduleController } from "../src/schedule/controller.js";
import { runSchedulerRunner } from "../src/schedule/runner.js";
import { makeBoundedSleep, makeScheduleFixture, scheduleTaskPackage, THREAD_ID, VERIFIED_OBSERVATION } from "./schedule-helpers.js";

const START_AT = "2026-10-27T12:00:00+08:00";
const START_AT_MS = Date.parse(START_AT);


async function makeRunnerFixture() {
  const fixture = await makeScheduleFixture();
  const taskStore = new TaskStore(fixture.dataRoot);
  const createTask = fixture.manager.createTask.bind(fixture.manager);
  fixture.manager.createTask = async (task) => {
    const receipt = await createTask(task);
    taskStore.createTask(task, receipt.created_at);
    return receipt;
  };
  const sentMessages: string[] = [];
  const controller = new ScheduleController({
    store: fixture.store,
    manager: fixture.manager,
    supervisor: fixture.supervisor,
    runnerEntryPath: "/runner/schedule-runner.mjs",
    dataRoot: fixture.dataRoot,
    env: {},
    notifier: { send: async ({ message }) => { sentMessages.push(message); } },
  });
  fixture.store.writeRuntime({ app_pipe_path: "/tmp/fake.pipe", updated_at: new Date().toISOString() });
  const base: TaskStatusRecord = {
    task_id: "goal_1",
    status: "queued",
    attempt: 1,
    created_at: new Date(START_AT_MS).toISOString(),
    updated_at: new Date(START_AT_MS).toISOString(),
    started_at: null,
    finished_at: null,
    worker_pid: null,
    zcode_session_id: null,
    exit_code: null,
    observation: VERIFIED_OBSERVATION,
  };
  const run = async (ticks: number, nowMs: () => number) => {
    const bounded = makeBoundedSleep(ticks);
    try {
      const outcome = await runSchedulerRunner({
        dataRoot: fixture.dataRoot,
        taskId: "goal_1",
        manager: fixture.manager,
        controller,
        taskStore,
        now: () => new Date(nowMs()),
        sleep: bounded.sleep,
        pollIntervalMs: 0,
        waitTickMs: 0,
      });
      return { exit_reason: outcome.exit_reason };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("test-stop")) return { stoppedByTickLimit: true };
      throw error;
    }
  };
  return { fixture, controller, taskStore, sentMessages, base, run };
}

function result(overrides: Partial<TaskResult>): TaskResult {
  return {
    task_id: "goal_1",
    status: "completed",
    summary: "s",
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
    ...overrides,
  };
}

async function submit(controller: ScheduleController, startAt = START_AT): Promise<void> {
  await controller.submit({ task: scheduleTaskPackage(), start_at: startAt, thread_id: THREAD_ID });
}

test("the scheduled start gates all execution until start_at", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller);
    let nowMs = START_AT_MS - 5_000;
    const stopped = await harness.run(3, () => nowMs);
    assert.ok(stopped.stoppedByTickLimit);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "createTask").length, 0, "nothing dispatches before start_at");
    assert.equal(harness.controller.readState("goal_1").status, "scheduled");

    // Restart the runner after the deadline: dispatch happens exactly once.
    nowMs = START_AT_MS + 1_000;
    await harness.run(3, () => nowMs);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "createTask").length, 1);
    assert.equal(harness.controller.readState("goal_1").status, "dispatched");
  } finally {
    await harness.fixture.cleanup();
  }
});

test("runner recovery completes a pre-dispatch stop intent without starting the task", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller);
    harness.fixture.store.writeState({ ...harness.controller.readState("goal_1"), cancel_requested: true });
    const outcome = await harness.run(2, () => START_AT_MS + 1_000);
    assert.equal(outcome.exit_reason, "cancelled");
    assert.equal(harness.controller.readState("goal_1").status, "cancelled");
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "createTask").length, 0);
    assert.deepEqual(harness.sentMessages, []);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("runner reports a persisted cancellation failure without automatically retrying it", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller);
    await harness.run(1, () => START_AT_MS + 1_000);
    harness.fixture.manager.status = { ...harness.base, status: "failed", observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    harness.fixture.manager.result = result({ status: "failed", error_code: "cleanup_failed" });
    await harness.controller.escalate("goal_1", 1, "task_failed");
    harness.fixture.manager.cancelError = new Error("cleanup still unverified");
    await assert.rejects(harness.controller.cancel("goal_1"), /cleanup still unverified/);
    const outcome = await harness.run(2, () => START_AT_MS + 1_000);
    assert.equal(outcome.exit_reason, "schedule_failed");
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 1, "failed cleanup requires an explicit decision before another cancellation attempt");
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    assert.equal(harness.fixture.store.listNotifications("goal_1").find((event) => event.reason === "task_failed")!.delivery.state, "superseded");
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]!, /reason=cancel_failed/u);
    harness.fixture.manager.cancelError = null;
    await harness.controller.cancel("goal_1");
    assert.equal((await harness.run(2, () => START_AT_MS + 1_000)).exit_reason, "cancelled");
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 2);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("runner completes an interrupted cancellation before monitoring a dispatched task", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller);
    await harness.run(1, () => START_AT_MS + 1_000);
    harness.fixture.manager.status = { ...harness.base, status: "failed", observation: { ...VERIFIED_OBSERVATION, cleanup: "unverified" } };
    harness.fixture.store.writeState({ ...harness.controller.readState("goal_1"), cancel_requested: true });
    const outcome = await harness.run(2, () => START_AT_MS + 1_000);
    assert.equal(outcome.exit_reason, "cancelled");
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "cancelTask").length, 1);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    assert.deepEqual(harness.sentMessages, []);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("acceptance_met=false continues the same session quietly without wakeups", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    assert.equal(harness.controller.readState("goal_1").status, "dispatched");
    // Attempt 1 completes unmet.
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = result({ acceptance_met: false, attempt: 1 });
    await harness.run(6, () => now);
    const continues = harness.fixture.manager.calls.filter((call) => call.method === "continueTask");
    assert.equal(continues.length, 1, "exactly one quiet continuation");
    const input = continues[0]!.args;
    assert.equal(input.operation_id, "sched-goal_1-a1");
    assert.equal(harness.sentMessages.length, 0, "no wakeup on quiet continuation");
    assert.equal(harness.controller.readState("goal_1").attention, null);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("acceptance_met=true requests independent review and wakes the thread once", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = result({ acceptance_met: true, attempt: 1 });
    await harness.run(8, () => now);
    const state = harness.controller.readState("goal_1");
    assert.equal(state.status, "awaiting_review");
    assert.equal(state.attempt_under_review, 1);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]!, /coding_agent_schedule_review/);
    // Re-observing the same terminal result does not wake again.
    await harness.run(6, () => now);
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("a terminal status cannot drive a decision before its current result is committed", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller);
    await harness.run(1, () => START_AT_MS + 1_000);
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = null;
    await harness.run(2, () => START_AT_MS + 1_000);
    assert.equal(harness.controller.readState("goal_1").status, "dispatched");
    assert.deepEqual(harness.sentMessages, []);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    harness.fixture.manager.result = result({ acceptance_met: true });
    await harness.run(2, () => START_AT_MS + 1_000);
    assert.equal(harness.controller.readState("goal_1").status, "awaiting_review");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("missing self-assessment wakes the thread with uncertainty", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = result({ attempt: 1 });
    await harness.run(8, () => now);
    const state = harness.controller.readState("goal_1");
    assert.equal(state.attention?.reason, "missing_self_assessment");
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]!, /uncertain/);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0, "never silently continues");
  } finally {
    await harness.fixture.cleanup();
  }
});

test("usage exhaustion and cleanup failures escalate without retry", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    harness.fixture.manager.status = { ...harness.base, status: "failed" };
    harness.fixture.manager.result = result({ status: "failed", error_code: "zcode_usage_exhausted", attempt: 1 });
    await harness.run(6, () => now);
    assert.equal(harness.controller.readState("goal_1").attention?.reason, "usage_exhausted");
    assert.equal(harness.sentMessages.length, 1);

    // A cleanup failure also escalates (never a timeout continuation).
    const second = await makeRunnerFixture();
    try {
      await submit(second.controller, new Date(Date.now() - 1_000).toISOString());
      await second.run(2, () => now);
      second.fixture.manager.status = { ...second.base, status: "failed" };
      second.fixture.manager.result = result({ status: "failed", error_code: "cleanup_failed", session_id: "sess_1", attempt: 1 });
      await second.run(6, () => now);
      assert.equal(second.controller.readState("goal_1").attention?.reason, "task_failed");
      assert.equal(second.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    } finally {
      await second.fixture.cleanup();
    }
  } finally {
    await harness.fixture.cleanup();
  }
});

test("verified timeout with an existing session continues; without one it escalates", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    harness.fixture.manager.status = { ...harness.base, status: "failed" };
    harness.fixture.manager.result = result({ status: "failed", error_code: "timeout", session_id: "sess_1", attempt: 1 });
    await harness.run(6, () => now);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 1);

    const noSession = await makeRunnerFixture();
    try {
      await submit(noSession.controller, new Date(Date.now() - 1_000).toISOString());
      await noSession.run(2, () => now);
      noSession.fixture.manager.status = { ...noSession.base, status: "failed" };
      noSession.fixture.manager.result = result({ status: "failed", error_code: "timeout", session_id: null, attempt: 1 });
      await noSession.run(6, () => now);
      assert.equal(noSession.controller.readState("goal_1").attention?.reason, "task_failed");
      assert.equal(noSession.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    } finally {
      await noSession.fixture.cleanup();
    }
  } finally {
    await harness.fixture.cleanup();
  }
});

test("pending interaction requests wake exactly once per request", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    const writePending = (requestId: string, created: string): void => {
      harness.taskStore.writeInteractionRequest("goal_1", {
        request_id: requestId,
        method: "interaction/requestPermission",
        params: { sessionId: "sess_1", toolName: "Bash", options: [] },
      }, created);
    };
    writePending("1:perm-1", new Date(now - 60_000).toISOString());
    await harness.run(8, () => now);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]!, /request_id=1:perm-1/);
    assert.equal(harness.controller.readState("goal_1").attention?.reason, "pending_interaction");
    // Same request pending again: no duplicate wakeup.
    await harness.run(4, () => now);
    assert.equal(harness.sentMessages.length, 1);
    // A second request on the same attempt wakes once more.
    writePending("1:perm-2", new Date(now - 30_000).toISOString());
    await harness.run(4, () => now);
    assert.equal(harness.sentMessages.length, 2);
    // Older requests cannot occupy the scan limit and hide a current request.
    for (let index = 0; index < 18; index += 1) writePending(`1:perm-old-${index}`, new Date(now - 90_000).toISOString());
    harness.fixture.manager.status = { ...harness.base, status: "running", attempt: 2 };
    harness.taskStore.writeStatus("goal_1", { attempt: 2 });
    writePending("2:current", new Date(now).toISOString());
    await harness.run(4, () => now);
    assert.equal(harness.sentMessages.length, 3);
    assert.match(harness.sentMessages[2]!, /request_id=2:current/);
    assert.deepEqual(harness.taskStore.listPendingInteractions("goal_1").map((request) => request.request_id), ["2:current"]);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("a committed result of a STALE attempt never drives decisions", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    // Status advanced to terminal attempt 2 while a stale attempt-1 result
    // is still readable: the runner must neither continue nor wake.
    harness.fixture.manager.status = { ...harness.base, attempt: 2, status: "completed" };
    harness.fixture.manager.result = result({ acceptance_met: false, attempt: 1 });
    await harness.run(6, () => now);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 0);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.controller.readState("goal_1").attention, null);
  } finally {
    await harness.fixture.cleanup();
  }
});

test("accepted goals supersede stale review wakeups and exit without sending them", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    // Review request enqueued but the pipe send now fails; then the goal is
    // accepted externally: its obsolete review wakeup must not be sent later.
    let failSend = true;
    const controller = new ScheduleController({
      store: harness.fixture.store,
      manager: harness.fixture.manager,
      supervisor: harness.fixture.supervisor,
      runnerEntryPath: "/runner/schedule-runner.mjs",
      dataRoot: harness.fixture.dataRoot,
      env: {},
      notifier: { send: async () => { if (failSend) throw new Error("pipe down"); } },
    });
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = result({ acceptance_met: true, attempt: 1 });
    const bounded = makeBoundedSleep(6);
    await assert.rejects(runSchedulerRunner({
      dataRoot: harness.fixture.dataRoot,
      taskId: "goal_1",
      manager: harness.fixture.manager,
      controller,
      taskStore: harness.taskStore,
      now: () => new Date(now),
      sleep: bounded.sleep,
      pollIntervalMs: 0,
      waitTickMs: 0,
    }), /test-stop/, "undelivered event keeps the runner alive");
    const event = harness.fixture.store.listNotifications("goal_1")[0]!;
    assert.equal(event.delivery.state, "failed");
    assert.ok(event.delivery.next_retry_at);
    await controller.review({ task_id: "goal_1", attempt: 1, accepted: true });
    failSend = false;
    harness.fixture.store.writeNotification("goal_1", { ...harness.fixture.store.listNotifications("goal_1")[0]!, delivery: { ...event.delivery, next_retry_at: undefined } });
    const outcome = await runSchedulerRunner({
      dataRoot: harness.fixture.dataRoot,
      taskId: "goal_1",
      manager: harness.fixture.manager,
      controller,
      taskStore: harness.taskStore,
      now: () => new Date(now),
      sleep: async () => undefined,
      pollIntervalMs: 0,
      waitTickMs: 0,
    });
    assert.equal(outcome.exit_reason, "accepted");
    assert.equal(harness.fixture.store.listNotifications("goal_1")[0]!.delivery.state, "superseded");
  } finally {
    await harness.fixture.cleanup();
  }
});

test("restart replay after a continuation never duplicates execution", async () => {
  const harness = await makeRunnerFixture();
  try {
    await submit(harness.controller, new Date(Date.now() - 1_000).toISOString());
    const now = Date.now();
    await harness.run(2, () => now);
    harness.fixture.manager.status = { ...harness.base, status: "completed" };
    harness.fixture.manager.result = result({ acceptance_met: false, attempt: 1 });
    await harness.run(4, () => now);
    // Simulate a runner crash right after the continuation: attempt 2 runs.
    harness.fixture.manager.status = { ...harness.base, attempt: 2, status: "running" };
    harness.fixture.manager.result = null;
    await harness.run(6, () => now);
    assert.equal(harness.fixture.manager.calls.filter((call) => call.method === "continueTask").length, 1);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await harness.fixture.cleanup();
  }
});
