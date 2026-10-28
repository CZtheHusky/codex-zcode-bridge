// Real TaskManager continuation/recovery with fake workers; no model or service calls.
import assert from "node:assert/strict";
import test from "node:test";
import { TaskManagerError } from "../src/manager/errors.js";
import { ScheduleController } from "../src/schedule/controller.js";
import { ScheduleError } from "../src/schedule/errors.js";
import { buildReviewContinueFeedback, reviewContinueOperationId } from "../src/schedule/policy.js";
import { ScheduleStore, schedulesRootFor } from "../src/schedule/store.js";
import { FakeAdapter, makeManagerFixture } from "./manager-helpers.js";
import { RecordingSupervisor, THREAD_ID } from "./schedule-helpers.js";

async function completedScheduledFixture() {
  const fixture = await makeManagerFixture();
  const store = new ScheduleStore(schedulesRootFor(fixture.dataRoot));
  const controller = new ScheduleController({
    store, manager: fixture.manager, supervisor: new RecordingSupervisor(),
    runnerEntryPath: "/runner/schedule-runner.mjs", dataRoot: fixture.dataRoot, env: {},
  });
  await controller.submit({ task: fixture.makeTask(), start_at: "2026-10-27T00:00:00Z", thread_id: THREAD_ID });
  await controller.dispatch("task_1");
  await fixture.runWorker("task_1", new FakeAdapter());
  await fixture.manager.recoverTasks();
  await controller.requestReview("task_1", 1);
  return { fixture, store, controller };
}

test("persisted rejected review resumes once in the same session after its caller disappears", async () => {
  const { fixture, store, controller } = await completedScheduledFixture();
  try {
    const feedback = "Fix the failing acceptance test";
    const operationId = reviewContinueOperationId("task_1", 1);
    store.writeState({ ...store.readState("task_1"), review_intent: {
      attempt: 1, accepted: false, feedback, operation_id: operationId, set_at: "2026-10-27T00:01:00Z",
    } });
    await controller.recoverReview("task_1");
    await controller.recoverReview("task_1");
    assert.equal(fixture.store.readStatus("task_1").attempt, 2);
    assert.equal(fixture.spawned.length, 2, "recovery must create exactly one continuation worker");
    assert.equal(store.readState("task_1").review_intent, null);
    assert.equal(store.readState("task_1").review?.outcome, "continued");
    const adapter = new FakeAdapter();
    await fixture.runWorker("task_1", adapter);
    assert.equal(adapter.calls[0]!.kind, "continue");
    assert.equal(adapter.calls[0]!.previousSessionId, fixture.store.readArchivedResult("task_1", 1)?.session_id);
    assert.equal(adapter.calls[0]!.feedback, buildReviewContinueFeedback(feedback, 1));
  } finally {
    await fixture.cleanup();
  }
});

test("recovery replays a committed continuation when its schedule receipt was lost", async () => {
  const { fixture, store, controller } = await completedScheduledFixture();
  try {
    const feedback = "Address the review";
    const operationId = reviewContinueOperationId("task_1", 1);
    store.writeState({ ...store.readState("task_1"), review_intent: {
      attempt: 1, accepted: false, feedback, operation_id: operationId, set_at: "2026-10-27T00:01:00Z",
    } });
    const receipt = await fixture.manager.continueTask({
      task_id: "task_1", feedback: buildReviewContinueFeedback(feedback, 1), operation_id: operationId, expected_attempt: 1,
    });
    await controller.recoverReview("task_1");
    const outcome = await controller.review({ task_id: "task_1", attempt: 1, accepted: false, feedback });
    assert.deepEqual(outcome, { task_id: "task_1", attempt: 1, accepted: false, action: "continued", receipt });
    assert.equal(fixture.store.readStatus("task_1").attempt, 2);
    assert.equal(fixture.spawned.length, 2, "an already committed continuation must replay before the expected-attempt check");
    assert.equal(store.readState("task_1").review_intent, null);
  } finally {
    await fixture.cleanup();
  }
});

test("an ordinary continuation makes old review feedback stale without starting another attempt", async () => {
  const { fixture, store, controller } = await completedScheduledFixture();
  try {
    await fixture.manager.continueTask({ task_id: "task_1", feedback: "A newer human instruction", operation_id: "human-continue" });
    await fixture.runWorker("task_1", new FakeAdapter());
    await fixture.manager.recoverTasks();
    await assert.rejects(controller.review({ task_id: "task_1", attempt: 1, accepted: false, feedback: "Old review" }), (error: unknown) => error instanceof ScheduleError && error.code === "SCHEDULE_STALE_REVIEW");
    await assert.rejects(fixture.manager.continueTask({ task_id: "task_1", feedback: "Old review", expected_attempt: 1 }), (error: unknown) => error instanceof TaskManagerError && error.code === "TASK_STATE");
    for (const accepted of [false, true]) {
      store.writeState({ ...store.readState("task_1"), review_intent: {
        attempt: 1, accepted, feedback: "Old review", operation_id: reviewContinueOperationId("task_1", 1), set_at: "2026-10-27T00:01:00Z",
      } });
      await controller.recoverReview("task_1");
      assert.equal(store.readState("task_1").review_intent, null, "a permanently stale verdict must not cause an endless supervisor restart loop");
      assert.equal(store.readState("task_1").status, "dispatched");
    }
    assert.equal(fixture.store.readStatus("task_1").attempt, 2);
    assert.equal(fixture.spawned.length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("a persisted acceptance completes after restart without continuing the task", async () => {
  const { fixture, store, controller } = await completedScheduledFixture();
  try {
    store.writeState({ ...store.readState("task_1"), review_intent: {
      attempt: 1, accepted: true, operation_id: reviewContinueOperationId("task_1", 1), set_at: "2026-10-27T00:01:00Z",
    } });
    await controller.recoverReview("task_1");
    await controller.recoverReview("task_1");
    assert.equal(store.readState("task_1").status, "accepted");
    assert.equal(store.readState("task_1").review_intent, null);
    assert.equal(fixture.store.readStatus("task_1").attempt, 1);
    assert.equal(fixture.spawned.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling after a real clean completion preserves the execution result", async () => {
  const { fixture, controller } = await completedScheduledFixture();
  try {
    const result = await fixture.manager.getResult("task_1");
    assert.deepEqual(await controller.cancel("task_1"), { schedule_status: "cancelled", task_status: "completed" });
    assert.deepEqual(await fixture.manager.getResult("task_1"), result);
    assert.equal(controller.readState("task_1").cancel_requested, true);
  } finally {
    await fixture.cleanup();
  }
});
