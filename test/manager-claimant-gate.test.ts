// PR #47 consumption-path regressions: the REAL TaskManager release gate
// (cancel → fresh probe → latched cleanup_unverified → recorded-tree claimant
// scan → occupancy/pump) driven end to end. Per the repair plan, the fake
// transaction stands in ONLY for the OS scan transport; the claimant scan
// logic itself and every manager decision are production code. Review-round-1
// R3: the P1-A shape below drives the absent-hold branch through a recorded
// root WITH a persisted fingerprint (verified against the ORIGINAL defective
// scanner via the evaluator's baseline loader, where it fails); the P1-B shape
// was already baseline-RED. Numeric decimal ticks throughout: hold responses
// are validated against the transport contract before proving anything.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WindowsTreeCleanupError, type HoldOutcome, type KillOutcome, type WindowsProcessRow, type WindowsTreeTransactionLike } from "../src/adapters/windows-process-cleanup.js";
import { FakeAdapter, makeManagerFixture } from "./manager-helpers.js";

/** Scripted OS process table for the real scan: fixed rows, per-pid hold
 * overrides (absent/denied/replaced), and injectable transport failures. */
class ManagerScanTable implements WindowsTreeTransactionLike {
  rows: WindowsProcessRow[] = [];
  readonly holdOverrides = new Map<number, HoldOutcome>();
  enumerateError: Error | null = null;
  closeError: Error | null = null;
  readonly holds: number[][] = [];
  closeCount = 0;

  async enumerate(): Promise<readonly WindowsProcessRow[]> {
    if (this.enumerateError) throw this.enumerateError;
    return [...this.rows];
  }

  /** Pids whose hold request returns NO response at all (protocol gap). */
  readonly holdEmptyFor = new Set<number>();

  async hold(pids: readonly number[]): Promise<readonly HoldOutcome[]> {
    this.holds.push([...pids]);
    if (pids.length === 1 && this.holdEmptyFor.has(pids[0]!)) return [];
    return pids.map((pid) => {
      const override = this.holdOverrides.get(pid);
      if (override) return override;
      const target = this.rows.find((r) => r.pid === pid);
      if (!target) return { pid, status: "absent" } as HoldOutcome;
      if (!target.startTicks || !target.creationFileTime) return { pid, status: "denied", error: 5 } as HoldOutcome;
      return {
        pid,
        status: "ok",
        creationFileTime: String(BigInt(target.creationFileTime) + 3n),
        creationTicks: target.startTicks,
      } as HoldOutcome;
    });
  }

  async kill(): Promise<KillOutcome> {
    throw new Error("read-only scan must not signal");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError) throw this.closeError;
  }
}

/** 100ns-tick anchors: one unit = 100 ticks (10µs), so parent/child edges
 * stay far outside the 1µs CIM representation interval. Numeric ticks only. */
const BASE_FT = 134_367_000_000_000_000n;
const T = (units: number): string => String(BASE_FT + BigInt(units) * 100n);
const ORIG_TICKS = "100000000000000000"; // the worker's persisted startup fingerprint
const REUSER_TICKS = "300000000000000000"; // a foreign generation now owning the pid

/** Latches a terminal task_1 with recorded members [workerPid, 334455] and
 * leaves task_2 (same execution directory) queued behind the occupancy. The
 * persisted executor identity carries a NUMERIC fingerprint so the scan's
 * fingerprint comparison (not the null branch) drives every release probe. */
async function latchTerminalTask(table: ManagerScanTable, options: { maxConcurrentWorkers?: number; task2Workspace?: string } = {}) {
  const fx = await makeManagerFixture({ scanOpen: async () => table, maxConcurrentWorkers: options.maxConcurrentWorkers });
  await fx.manager.createTask(fx.makeTask());
  await fx.manager.createTask(fx.makeTask({ task_id: "task_2", ...(options.task2Workspace ? { workspace: options.task2Workspace } : {}) }));
  const workerPid = fx.spawned[0]!.pid;
  // A failed termination latches cleanup_unverified with known members.
  fx.setTerminateError(new WindowsTreeCleanupError("process_tree_cleanup_unverified", "known descendant still alive", [workerPid, 334_455]));
  await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
  assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
  // The worker later exits naturally and commits its terminal result; the
  // store must preserve the latch through commitWorkerResult.
  fx.pidsAlive.delete(workerPid);
  await fx.runWorker("task_1", new FakeAdapter());
  const committed = fx.store.readStatus("task_1");
  assert.equal(committed.status, "cancelled", "the raced worker commit finishes the task");
  assert.equal(committed.cleanup_unverified, true, "the worker commit cannot dissolve the latch");
  assert.match(String(committed.error), /\[cleanup-members: /, "the member marker survives the commit");
  // Deterministic release-probe identity: the recorded worker pid with its
  // original startup fingerprint (real flows persist this from the worker).
  fx.store.writeExecutorIdentity("task_1", 1, { worker: { pid: workerPid, fingerprint: ORIG_TICKS, precision: "exact" } });
  // The pump must NOT start task_2 while the latched task holds its slot/path.
  await fx.manager.recoverTasks();
  assert.equal(fx.store.readStatus("task_2").status, "queued", "a queued task stays queued behind the latch");
  assert.equal(fx.spawned.length, 1);
  return fx;
}

test("manager gate P1-B: a foreign-reused worker pid with an old-generation child keeps the task and directory occupied", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    // P1-B table shape: pid workerPid is alive as a FOREIGN generation and a
    // child created BEFORE the reuser still claims it. Before the scan fix
    // this returned clean=true and the manager released the directory.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(3), startTicks: REUSER_TICKS },
      { pid: workerPid + 1, parentPid: workerPid, creationFileTime: T(1), startTicks: "200000000000000000" },
    ];
    table.holdOverrides.set(workerPid, { pid: workerPid, status: "ok", creationFileTime: T(3), creationTicks: REUSER_TICKS });

    await assert.rejects(fx.manager.cancelTask("task_1"), /1 recorded-tree process\(es\) still alive/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.status, "cancelled", "the terminal result is preserved");
    assert.equal(after.cleanup_unverified, true, "a false scan never releases the latch");
    assert.equal(fx.store.readStatus("task_2").status, "queued", "the same-directory task stays blocked");
    assert.equal(fx.spawned.length, 1, "no second worker started");
    assert.ok(table.holds.some((h) => h.length === 1 && h[0] === workerPid), "the fingerprinted recorded root was actually held");
    assert.ok(fx.scanCalls.some((targets) => targets.some((t) => t.pid === workerPid && t.fingerprint === ORIG_TICKS)), "the scan saw the recorded fingerprint");
    // The provably-clean variant of the SAME lineage releases: the observed
    // old-generation child is gone (its S2-persisted fingerprint-less record
    // scans it as a dead member) and only the provably-foreign reuser with a
    // strictly-later, held, row-consistent new child remains.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(3), startTicks: REUSER_TICKS },
      { pid: workerPid + 2, parentPid: workerPid, creationFileTime: T(9), startTicks: "900000000000000000" },
    ];
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified ?? false, false, "a provably-clean scan releases the latch");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running", "the blocked same-directory task starts after the release");
    assert.equal(fx.spawned.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("manager gate P1-A: the recorded root vanishing between enumeration and hold keeps occupancy through its live child", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    // P1-A table shape, driven through the FINGERPRINTED recorded root: the
    // root was enumerated alive but vanishes before its hold; its live child
    // stays occupied. The fingerprint comparison makes the scan actually call
    // hold (the null-fingerprint shortcut never runs); the original defective
    // scanner kept the stale live entry, proved clean, and released.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(1), startTicks: "100000000000000001" },
      { pid: workerPid + 1, parentPid: workerPid, creationFileTime: T(2), startTicks: "200000000000000000" },
    ];
    table.holdOverrides.set(workerPid, { pid: workerPid, status: "absent" });

    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified, true, "the vanished root's live child keeps the latch");
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);
    assert.ok(table.holds.some((h) => h.length === 1 && h[0] === workerPid), "the absent hold on the fingerprinted root actually happened");

    // The root is fully gone (not even enumerated): dead recorded pid, its
    // child still lives — attribution stays impossible, occupancy stays.
    table.rows = [{ pid: workerPid + 1, parentPid: workerPid, creationFileTime: T(2), startTicks: "200000000000000000" }];
    table.holdOverrides.clear();
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");

    // Everything provably gone: the release works and the queue moves.
    table.rows = [];
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running");
    assert.equal(fx.spawned.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("manager gate: a latched task retains the worker SLOT against a different execution directory at max concurrency 1", async () => {
  const table = new ManagerScanTable();
  const otherDir = mkdtempSync(path.join(tmpdir(), "zcode-bridge-slot-"));
  const fx = await latchTerminalTask(table, { maxConcurrentWorkers: 1, task2Workspace: otherDir });
  try {
    const workerPid = fx.spawned[0]!.pid;
    // Different directory: only the worker SLOT (not path overlap) can keep
    // task_2 queued while the latched task_1 holds the single slot.
    assert.notEqual(path.resolve(fx.workspaceDir), path.resolve(otherDir));
    assert.equal(fx.store.readStatus("task_2").status, "queued", "the different-directory task is slot-blocked");
    assert.equal(fx.spawned.length, 1);

    // A false scan (foreign reuse with an old-generation child) keeps the slot.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(3), startTicks: REUSER_TICKS },
      { pid: workerPid + 1, parentPid: workerPid, creationFileTime: T(1), startTicks: "200000000000000000" },
    ];
    table.holdOverrides.set(workerPid, { pid: workerPid, status: "ok", creationFileTime: T(3), creationTicks: REUSER_TICKS });
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "queued", "the slot stays retained while the latch holds");
    assert.equal(fx.spawned.length, 1);

    // Provable clean releases the slot and the different-directory task starts.
    table.rows = [];
    table.holdOverrides.clear();
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running", "the slot frees after the verified release");
    assert.equal(fx.spawned.length, 2);
  } finally {
    await fx.cleanup();
    rmSync(otherDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("manager gate: a rejected scan keeps the latch instead of releasing or narrowing", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    table.rows = [{ pid: workerPid, parentPid: 4, creationFileTime: T(1), startTicks: "300000000000000000" }];
    table.enumerateError = new Error("process_tree_transport_timeout: enum begin");
    await assert.rejects(fx.manager.cancelTask("task_1"), /ZCode cleanup verification failed: process_tree_scan_failed: process_tree_transport_timeout/);
    let after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified, true, "a rejected scan never releases");
    assert.equal(fx.store.readStatus("task_2").status, "queued");

    // A malformed hold response (wrong pid for the request) refuses the scan
    // through the same manager path — never a false clean.
    table.enumerateError = null;
    table.rows = [{ pid: workerPid, parentPid: 4, creationFileTime: T(1), startTicks: "300000000000000000" }];
    const originalHold = table.hold.bind(table);
    table.hold = async (pids: readonly number[]) => {
      const outcomes = await originalHold(pids);
      return outcomes.map((o) => (o.pid === pids[0] ? { pid: 999, status: "ok", creationFileTime: T(3), creationTicks: "300000000000000000" } as HoldOutcome : o));
    };
    await assert.rejects(fx.manager.cancelTask("task_1"), /ZCode cleanup verification failed: process_tree_hold_invalid/);
    after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);

    // A helper close failure on an otherwise-clean table is equally visible.
    table.hold = originalHold;
    table.rows = [];
    table.closeError = new Error("synthetic scan close failure");
    await assert.rejects(fx.manager.cancelTask("task_1"), /verification failed/);
    after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("manager gate S1: a pid foreign to its own record but a live child of another dead recorded member keeps occupancy", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    // workerPid currently holds a FOREIGN generation relative to its own
    // recorded fingerprint, but its row claims the OTHER recorded member
    // 334455 (dead) as parent: claimant evidence from that root wins over
    // the foreign exclusion (review-round-2 S1). The attempt-2 scanner
    // skipped it as foreign and wrongly proved clean.
    table.rows = [
      { pid: workerPid, parentPid: 334_455, creationFileTime: T(3), startTicks: REUSER_TICKS },
      { pid: workerPid + 1, parentPid: workerPid, creationFileTime: T(4), startTicks: "400000000000000000" },
    ];
    table.holdOverrides.set(workerPid, { pid: workerPid, status: "ok", creationFileTime: T(3), creationTicks: REUSER_TICKS });

    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    const after = fx.store.readStatus("task_1");
    assert.equal(after.cleanup_unverified, true, "cross-root claimant evidence keeps the latch");
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);
    assert.ok(table.holds.some((h) => h.length === 1 && h[0] === workerPid), "the reused pid was held and proven foreign relative to its own record");

    // With the cross-root row gone the same lineage is provably foreign and
    // the release works again.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(3), startTicks: REUSER_TICKS },
    ];
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running");
    assert.equal(fx.spawned.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("manager gate S2: a false scan persists its observed members and later cancels keep scanning them", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    const child = workerPid + 1_000;
    const grand = child + 1;
    // First scan: the dead root's live child and grandchild are claimants.
    table.rows = [
      { pid: child, parentPid: workerPid, creationFileTime: T(2), startTicks: "200000000000000000" },
      { pid: grand, parentPid: child, creationFileTime: T(3), startTicks: "300000000000000000" },
    ];
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    const record = fx.store.readAttemptMeta<{ member_pids?: number[] }>("task_1", 1, "cleanup-failure.json");
    assert.ok(record?.member_pids?.includes(child), "the observed child joined the durable member record");
    assert.ok(record?.member_pids?.includes(grand), "the observed grandchild joined the durable member record");

    // The OBSERVED intermediate disappears; its still-live child must not
    // become an unobserved-ancestor exception: the next cancel scans the
    // persisted union and stays occupied.
    table.rows = [{ pid: grand, parentPid: child, creationFileTime: T(3), startTicks: "300000000000000000" }];
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);
    const laterTargets = fx.scanCalls.at(-1) ?? [];
    assert.ok(laterTargets.some((t) => t.pid === child), "the persisted observed pid is scanned again");

    // Once every observed pid is truly gone the release works and the queue
    // moves again.
    table.rows = [];
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running");
    assert.equal(fx.spawned.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("manager gate S2: a rejected scan after observing a candidate retains it across later cancels", async () => {
  const table = new ManagerScanTable();
  const fx = await latchTerminalTask(table);
  try {
    const workerPid = fx.spawned[0]!.pid;
    const child = workerPid + 1_000;
    const grand = child + 1;
    // The root is alive as a foreign generation; the strictly-later child is
    // requested and its hold returns no response: the scan rejects, and the
    // requested candidate (plus the root) must persist before the cancel
    // fails.
    table.rows = [
      { pid: workerPid, parentPid: 4, creationFileTime: T(3), startTicks: REUSER_TICKS },
      { pid: child, parentPid: workerPid, creationFileTime: T(4), startTicks: "400000000000000000" },
    ];
    table.holdOverrides.set(workerPid, { pid: workerPid, status: "ok", creationFileTime: T(3), creationTicks: REUSER_TICKS });
    table.holdEmptyFor.add(child);
    await assert.rejects(fx.manager.cancelTask("task_1"), /ZCode cleanup verification failed: process_tree_hold_invalid/);
    const record = fx.store.readAttemptMeta<{ member_pids?: number[] }>("task_1", 1, "cleanup-failure.json");
    assert.ok(record?.member_pids?.includes(child), "the requested-but-unresolved candidate joined the durable record");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");

    // The candidate disappears while its own child stays live: the persisted
    // observation keeps the grandchild covered (no unobserved-ancestor gap).
    table.rows = [{ pid: grand, parentPid: child, creationFileTime: T(5), startTicks: "500000000000000000" }];
    table.holdEmptyFor.clear();
    table.holdOverrides.clear();
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    assert.equal(fx.store.readStatus("task_2").status, "queued");
    assert.equal(fx.spawned.length, 1);

    // Empty closure releases normally.
    table.rows = [];
    const released = await fx.manager.cancelTask("task_1");
    assert.equal(released.status, "cancelled");
    await fx.manager.recoverTasks();
    assert.equal(fx.store.readStatus("task_2").status, "running");
  } finally {
    await fx.cleanup();
  }
});
