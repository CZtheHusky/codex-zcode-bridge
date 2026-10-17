// Late-identity lifecycle regressions (2026-10-17 reviews): the worker's
// advisory identity probes must never outlive the attempt. The attempt-1
// review proved an injected 250ms probe resurrected a deleted fixture tree;
// the attempt-2 review then showed these tests only used timers and asserted
// before the promises settled (a mutant dropping both callback fences still
// passed and left three executor-identity.json files behind). Every deferred
// probe here is settled EXPLICITLY after the fixture is removed, and the
// assertions wait until the worker's callbacks have provably run
// (whenSelfSettled/whenRuntimeSettled resolve after the worker's own .then,
// which attached first, plus one macrotask). Removing either fence makes the
// corresponding test fail with a resurrected tree.
import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { ProcessIdentity, ProcessProbe, ProbeRequest, ProbeVerdict } from "../src/runtime/process-probe.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { TaskStore } from "../src/store/task-store.js";
import { FakeAdapter, makeManagerFixture, type ManagerFixture } from "./manager-helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { TEMP_TREE_REMOVE_OPTIONS } from "./helpers.js";

const removeTree = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS });
};

const stubIdentity = (pid: number): ProcessIdentity => ({
  pid,
  fingerprint: `fingerprint-${pid}`,
  fingerprint_precision: "exact",
  identity_version: 1,
  platform: process.platform,
  captured_at: new Date().toISOString(),
});

interface DeferredIdentityProbe extends ProcessProbe {
  /** Resolves (or rejects, with an error) the pending selfIdentity probe. */
  settleSelf: (error?: Error) => void;
  /** Resolves (or rejects, with an error) the pending runtime identity probe. */
  settleRuntime: (error?: Error) => void;
  /** Resolves after the worker's selfIdentity callback has run (or errored). */
  whenSelfSettled: () => Promise<void>;
  /** Resolves after the worker's runtime-identity callback has run (or errored). */
  whenRuntimeSettled: () => Promise<void>;
}

function deferredProbe(options: { autoSelfMs?: number } = {}): DeferredIdentityProbe {
  let settleSelf: (error?: Error) => void = () => undefined;
  let settleRuntime: (error?: Error) => void = () => undefined;
  const self = new Promise<ProcessIdentity>((resolve, reject) => {
    settleSelf = (error?: Error) => { if (error) reject(error); else resolve(stubIdentity(process.pid)); };
    if (options.autoSelfMs !== undefined) setTimeout(() => settleSelf(), options.autoSelfMs);
  });
  const runtime = new Promise<ProcessIdentity>((resolve, reject) => {
    settleRuntime = (error?: Error) => { if (error) reject(error); else resolve(stubIdentity(41_000)); };
  });
  // The worker attaches its own .then to `self`/`runtime` during the run,
  // BEFORE these derived promises attach, so awaiting one of these plus a
  // macrotask guarantees the worker's callback has already executed.
  const drain = async (promise: Promise<unknown>): Promise<void> => {
    await promise.then(() => undefined, () => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    platform: process.platform,
    selfIdentity: () => self,
    identityOf: (_pid: number) => runtime,
    probe: (_requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> => Promise.resolve([]),
    settleSelf,
    settleRuntime,
    whenSelfSettled: () => drain(self),
    whenRuntimeSettled: () => drain(runtime),
  };
}

async function workerFixture(): Promise<{ fixture: ManagerFixture; store: TaskStore }> {
  const fixture = await makeManagerFixture();
  const store = new TaskStore(fixture.dataRoot);
  store.createTask(fixture.makeTask(), "2026-09-27T00:00:00.000Z");
  return { fixture, store };
}

const tasksRootOf = (dataRoot: string): string => path.join(dataRoot, ".tasks");

test("identity resolving within the reap budget is persisted before the worker returns", { timeout: 15_000 }, async () => {
  const { fixture, store } = await workerFixture();
  const probe = deferredProbe({ autoSelfMs: 250 });
  try {
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter: new FakeAdapter(), probe });
    assert.equal(run.status, "completed");
    await probe.whenSelfSettled();
    const identity = store.readExecutorIdentity("task_1", 1);
    assert.equal(identity?.worker?.fingerprint, `fingerprint-${process.pid}`, "the identity write must land before the terminal result");
  } finally {
    removeTree(fixture.dataRoot);
    await fixture.cleanup();
  }
});

test("identity settled explicitly after removal is dropped and never resurrects the store (kills the self-identity fence mutant)", { timeout: 20_000 }, async () => {
  const { fixture } = await workerFixture();
  // No timer: the probe stays pending past the worker's 2s reap budget.
  const probe = deferredProbe();
  try {
    const startedAt = Date.now();
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter: new FakeAdapter(), probe });
    assert.equal(run.status, "completed");
    assert.ok(Date.now() - startedAt >= 1_900, "the worker must wait out the bounded reap budget before returning");
    removeTree(fixture.dataRoot);
    assert.equal(existsSync(tasksRootOf(fixture.dataRoot)), false, "fixture removed before the late settle");
    probe.settleSelf();
    await probe.whenSelfSettled();
    assert.equal(existsSync(tasksRootOf(fixture.dataRoot)), false, "a late identity write must not recreate the store tree");
  } finally {
    removeTree(fixture.dataRoot);
    await fixture.cleanup();
  }
});

test("a genuinely rejecting identity probe on the failure path has no unhandled rejection and no resurrection (kills the fence mutant too)", { timeout: 20_000 }, async () => {
  const { fixture } = await workerFixture();
  const probe = deferredProbe();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const adapter = new FakeAdapter();
    adapter.behavior = "adapterFailed";
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter, probe });
    assert.equal(run.status, "failed");
    removeTree(fixture.dataRoot);
    // A REAL rejection, delivered only after the fixture is gone.
    probe.settleSelf(new Error("late identity probe failure"));
    await probe.whenSelfSettled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(tasksRootOf(fixture.dataRoot)), false, "no resurrection from the rejecting failure-path probe");
    assert.deepEqual(unhandled, [], "a rejected advisory identity probe must stay handled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    removeTree(fixture.dataRoot);
    await fixture.cleanup();
  }
});

test("the real adapter's late runtime identity settled after removal is reaped identically (kills the runtime fence mutant)", { timeout: 30_000 }, async () => {
  const fixture = await runtimeFixture();
  const probe = deferredProbe({ autoSelfMs: 0 });
  const store = new TaskStore(fixture.root);
  store.createTask({
    task_id: "task_1",
    workspace: fixture.root,
    objective: "probe runtime identity lifecycle",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  }, new Date().toISOString());
  const envBefore = { ...process.env };
  Object.assign(process.env, fixture.env);
  try {
    const run = await runWorkerTask({ dataRoot: fixture.root, taskId: "task_1", attempt: 1, host: fixture.host, probe });
    assert.equal(run.status, "completed");
    removeTree(fixture.root);
    probe.settleRuntime();
    await probe.whenRuntimeSettled();
    assert.equal(existsSync(tasksRootOf(fixture.root)), false, "a late runtime identity write must not recreate the store tree");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    removeTree(fixture.root);
    await fixture.cleanup();
  }
});
