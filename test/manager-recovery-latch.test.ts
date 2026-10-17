// Deterministic consumer-level regressions for evaluator/review-round-1 R1/R3:
// a latched descendant-cleanup failure must survive recovery (persisted
// worker results, outcome checkpoints, worker_lost finalization, terminal
// probe recovery) and a corrupt failure record must fail closed instead of
// narrowing the recorded-tree scan. No real processes; injected terminator.
import assert from "node:assert/strict";
import test from "node:test";
import { WindowsTreeCleanupError } from "../src/adapters/windows-process-cleanup.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import { FakeAdapter, makeManagerFixture } from "./manager-helpers.js";

test("R1: recoverTasks cannot release a task whose latched cleanup failure carries known members", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    // A failed manager termination observed a surviving descendant (334455).
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", [pid, 334455]));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    assert.deepEqual(fx.store.readAttemptMeta("task_1", 1, "cleanup-failure.json")?.member_pids, [pid, 334455]);

    // The worker now commits a terminal result and exits before its own
    // status update — the exact R1 timeline. Recovery must NOT adopt it.
    const result = buildTaskResult({ task: fx.makeTask(), attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: null, cancelled: true, sessionId: "session-x" });
    fx.store.writeResult("task_1", result);
    fx.pidsAlive.delete(pid);
    await fx.manager.recoverTasks();
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "running", "the latched task stays occupied");
    assert.equal(after.cleanup_unverified, true, "the latch survives recovery");
    assert.equal(fx.scanCalls.length, 0, "no scan-gated release happened outside cancel");

    // The eventual release still works: fresh probes see the executors gone
    // and the claimant scan covers the recorded members (334455 included).
    fx.setTerminateError(null);
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "cancelled");
    assert.equal(fx.scanCalls.length, 1);
    assert.ok(fx.scanCalls[0]!.some((t) => t.pid === 334455), "the recorded member pid is scanned");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified ?? false, false);
  } finally {
    await fx.cleanup();
  }
});

test("R1/R3: a corrupt failure record fails the later cancel closed instead of narrowing the scan", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", [pid, 334455]));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    fx.pidsAlive.delete(pid); // the worker later exits naturally

    // The record is damaged: the member list is no longer a valid pid array.
    fx.store.writeAttemptMeta("task_1", 1, "cleanup-failure.json", { member_pids: "corrupt-known-member-list", last_error: "known descendant still alive" });
    await assert.rejects(fx.manager.cancelTask("task_1"), /corrupt/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "running");
    assert.equal(after.cleanup_unverified, true, "the latch stays");
    assert.equal(fx.scanCalls.length, 0, "a corrupt record never reaches a release scan");
  } finally {
    await fx.cleanup();
  }
});

test("R1 boundary: a latched terminal task WITHOUT a member-bearing failure record still recovers via probes", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter()); // completes normally
    // Legacy shape: cleanup_unverified latched by an older code path with no
    // cleanup-failure.json at all. Probe-verified recovery keeps working.
    fx.store.writeStatus("task_1", { cleanup_unverified: true });
    await fx.manager.recoverTasks();
    const after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified ?? false, false, "no recorded members: the probe path still releases");
    assert.equal(fx.scanCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("R3: the durable status marker recovers the member set when the failure record is missing", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", [pid, 334455]));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.match(String(fx.store.readStatus("task_1").error), /\[cleanup-members: .*\b334455\b/, "the latch text carries the member set durably");
    fx.pidsAlive.delete(pid);
    // The record file disappears (loss/corruption-by-absence after the
    // latch): the marker in the latched status still expands the scan.
    fx.store.writeAttemptMeta("task_1", 1, "cleanup-failure.json", { member_pids: [], last_error: "known descendant still alive" });
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "cancelled");
    assert.equal(fx.scanCalls.length, 1);
    assert.ok(fx.scanCalls[0]!.some((t) => t.pid === 334455), "the marker-recording member pid is scanned");
  } finally {
    await fx.cleanup();
  }
});

test("R3 addendum: a failure record with a missing member_pids field fails closed", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", [pid, 334455]));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    fx.pidsAlive.delete(pid);
    // last_error survives but member_pids is gone: missing must never read
    // as an empty member set.
    fx.store.writeAttemptMeta("task_1", 1, "cleanup-failure.json", { last_error: "known descendant still alive" });
    await assert.rejects(fx.manager.cancelTask("task_1"), /corrupt/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "running");
    assert.equal(after.cleanup_unverified, true);
    assert.equal(fx.scanCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("R3 addendum: a truncated member marker cannot restore the full set and fails closed", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    // Enough members that the durable marker must truncate (>1600 chars).
    const manyMembers = [pid, ...Array.from({ length: 260 }, (_, index) => 330_000 + index), 334_455];
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", manyMembers));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    fx.pidsAlive.delete(pid);
    assert.match(String(fx.store.readStatus("task_1").error), /cleanup-members: .*,…]/, "the marker is truncated for an over-long set");
    // The structural record is then lost (the evaluator probe writes a
    // literal JSON null): only the truncated marker remains.
    fx.store.writeAttemptMeta("task_1", 1, "cleanup-failure.json", null as unknown as Parameters<typeof fx.store.writeAttemptMeta>[3]);
    await assert.rejects(fx.manager.cancelTask("task_1"), /incomplete/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "running");
    assert.equal(after.cleanup_unverified, true);
    assert.equal(fx.scanCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("R3 addendum 13:39: three consecutive terminator failures never wash an incomplete member set back to complete", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    // The worker stays ALIVE through all three terminator failures so every
    // cancel really invokes the terminator and #recordCleanupFailure; it
    // only exits before the fourth cancel (the evaluator probe's shape).
    const manyMembers = [pid, ...Array.from({ length: 260 }, (_, index) => 330_000 + index), 334_455];

    // Failure 1: the full set truncates the durable marker; the structural
    // record is written with complete:false.
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "first known descendant failure", manyMembers));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.match(String(fx.store.readStatus("task_1").error), /cleanup-members: .*,…]/);
    assert.equal(fx.store.readAttemptMeta("task_1", 1, "cleanup-failure.json")?.complete, false);

    // The structural record is then lost; only the truncated marker remains.
    fx.store.writeAttemptMeta("task_1", 1, "cleanup-failure.json", null as unknown as Parameters<typeof fx.store.writeAttemptMeta>[3]);

    // Failure 2 (worker still alive, terminator really called): a
    // member-less failure recovers the partial marker and must keep both
    // the marker and the rewritten record explicitly incomplete.
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "second failure", []));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.match(String(fx.store.readStatus("task_1").error), /cleanup-members: .*,…]/);
    assert.equal(fx.store.readAttemptMeta("task_1", 1, "cleanup-failure.json")?.complete, false, "the recovered record stays explicitly partial");

    // Failure 3 (worker STILL alive, terminator really called again): the
    // partial structural record now reads back VALID — exactly the case the
    // previous code washed clean. The incomplete state must survive this
    // successful read: no fresh summary may claim completeness.
    fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "third failure", []));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.match(String(fx.store.readStatus("task_1").error), /cleanup-members: .*,…]/, "the marker stays truncated after a third failure");
    assert.equal(fx.store.readAttemptMeta("task_1", 1, "cleanup-failure.json")?.complete, false, "the record stays explicitly partial after a third failure");

    // The worker now exits naturally; the fourth cancel cannot invoke the
    // terminator any more. The partial state must still refuse the release:
    // member 334455 (beyond the marker's first 200 entries) must never be
    // scanned away by a narrowed set.
    fx.pidsAlive.delete(pid);
    await assert.rejects(fx.manager.cancelTask("task_1"), /incomplete/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "running");
    assert.equal(after.cleanup_unverified, true);
    assert.equal(fx.scanCalls.length, 0, "no release scan runs on a partial member record");
  } finally {
    await fx.cleanup();
  }
});
