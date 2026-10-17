// ADR-009 deterministic unit tests: interval-exact membership resolution,
// the handle-transaction termination driver, and the recorded-tree claimant
// scan. Everything here runs on injected data — no OS processes, no signals.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWindowsTreeMembership,
  terminateWindowsProcessTree,
  verifyWindowsRecordedTreeClaimants,
  type HeldProcessInfo,
  type HoldOutcome,
  type KillOutcome,
  type MembershipInput,
  type WindowsProcessRow,
  type WindowsTreeTransactionLike,
} from "../src/adapters/windows-process-cleanup.js";

// Realistic 100ns FILETIME-scale anchors (values only need internal
// consistency). CIM values are microsecond-truncated (last digit 0); exact
// handle times sit inside [cim, cim + 1us].
const FT = (value: bigint | number): string => value.toString();
const BASE = 134_367_000_000_000_000n; // arbitrary in-range filetime
const MICROS = 10n;

function row(pid: number, parentPid: number, cimOffset: bigint, ticks?: string | null): WindowsProcessRow {
  return { pid, parentPid, creationFileTime: FT(BASE + cimOffset * MICROS), startTicks: ticks === undefined ? `${pid}-ticks` : ticks };
}
function heldFor(rows: readonly WindowsProcessRow[], pid: number, exactOffset: bigint): HeldProcessInfo {
  const target = rows.find((r) => r.pid === pid);
  if (!target || !target.startTicks) throw new Error(`fixture: row ${String(pid)} missing`);
  return { pid, creationFileTime: FT(BASE + exactOffset * MICROS + 3n), creationTicks: target.startTicks };
}
function input(overrides: Partial<MembershipInput> & { rows: readonly WindowsProcessRow[] }): MembershipInput {
  return {
    rootPid: 101,
    expectedRootTicks: "101-ticks",
    held: new Map(),
    killed: new Map(),
    naturalGonePids: new Set(),
    naturalGoneCreation: new Map(),
    ...overrides,
  };
}

test("membership: a fresh transaction refuses a root without a caller-bound identity", () => {
  const rows = [row(101, 4, 0n)];
  const resolution = resolveWindowsTreeMembership(input({ rows, expectedRootTicks: null }));
  assert.equal(resolution.kind, "refuse");
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_root_identity_required");
});

test("membership: a root missing from a fresh transaction refuses conservatively (no provable tree state)", () => {
  const resolution = resolveWindowsTreeMembership(input({ rows: [row(102, 101, 900n)] }));
  assert.equal(resolution.kind, "refuse");
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_root_exited");
});

test("membership: a root owned by a different generation (PID reuse) is never expanded", () => {
  const rows = [row(101, 4, 0n, "reuser-ticks")];
  const resolution = resolveWindowsTreeMembership(input({ rows }));
  assert.equal(resolution.kind, "refuse");
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_root_identity_changed");
});

test("membership: a root whose identity cannot be read refuses (unknown is never trusted)", () => {
  const rows = [row(101, 4, 0n, null)];
  const resolution = resolveWindowsTreeMembership(input({ rows }));
  assert.equal(resolution.kind, "refuse");
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_root_identity_unknown");
});

test("membership: an unheld root requests a hold before any membership decision", () => {
  const resolution = resolveWindowsTreeMembership(input({ rows: [row(101, 4, 0n)] }));
  assert.equal(resolution.kind, "members");
  assert.deepEqual(resolution.kind === "members" ? resolution.holdRequired : [], [101]);
});

test("membership: root handle generation mismatch with its row refuses", () => {
  const rows = [row(101, 4, 0n)];
  const bad = new Map([[101, { pid: 101, creationFileTime: FT(BASE + 5_000n), creationTicks: "101-ticks" }]]);
  const resolution = resolveWindowsTreeMembership(input({ rows, held: bad }));
  assert.equal(resolution.kind, "refuse");
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_root_generation_mismatch");
});

test("membership: a stale row that predates the parent is excluded without being held", () => {
  // The old-record PID-reuse shape: an unrelated process created long before
  // the root whose ParentProcessId equals the root pid.
  const rows = [row(101, 4, 0n), row(909, 101, -50_000n)];
  const held = new Map([[101, heldFor(rows, 101, 0n)]]);
  const resolution = resolveWindowsTreeMembership(input({ rows, held }));
  assert.equal(resolution.kind, "members");
  assert.deepEqual(resolution.kind === "members" ? resolution.members.map((m) => m.pid) : [], [101]);
  // The stale row was never asked to be held: no handle was opened on it.
  assert.equal(resolution.kind === "members" && resolution.holdRequired.includes(909), false);
});

test("membership: a live child created after its parent joins; equal exact ticks refuse", () => {
  const rows = [row(101, 4, 0n), row(102, 101, 40n)];
  const held = new Map([
    [101, heldFor(rows, 101, 0n)],
    [102, heldFor(rows, 102, 40n)],
  ]);
  const member = resolveWindowsTreeMembership(input({ rows, held }));
  assert.deepEqual(member.kind === "members" ? member.members.map((m) => m.pid) : [], [101, 102]);

  // Same 100ns creation instant (representation intervals overlap): ordering
  // is indistinguishable; refuse.
  const sameInstant = new Map<number, HeldProcessInfo>(held);
  sameInstant.set(102, { pid: 102, creationFileTime: FT(BASE + 3n), creationTicks: "102-ticks" });
  const refused = resolveWindowsTreeMembership(input({ rows: [row(101, 4, 0n), row(102, 101, 0n, "102-ticks")], held: sameInstant }));
  assert.equal(refused.kind === "refuse" && refused.code, "process_tree_edge_indistinguishable");
});

test("membership: a candidate overlapping but provably older than the parent is excluded as stale", () => {
  // Overlapping representation intervals: the exact times must decide.
  const rows = [row(101, 4, 0n), row(103, 101, 0n, "103-ticks")]; // both cims anchor at BASE
  const held = new Map([
    [101, { pid: 101, creationFileTime: FT(BASE + 8n), creationTicks: "101-ticks" }], // parent exact at BASE+8
    [103, { pid: 103, creationFileTime: FT(BASE + 6n), creationTicks: "103-ticks" }], // child exact at BASE+6: older
  ]);
  const resolution = resolveWindowsTreeMembership(input({ rows, held }));
  assert.equal(resolution.kind, "members");
  assert.deepEqual(resolution.kind === "members" ? resolution.members.map((m) => m.pid) : [], [101]);
});

test("membership: children of a killed member are decided by the exact [creation, exit] window", () => {
  const parentCreation = FT(BASE + 3n);
  const parentExit = FT(BASE + 90_000n);
  const killed = new Map([[201, { pid: 201, creationFileTime: parentCreation, exitFileTime: parentExit }]]);
  const inside = [row(301, 201, 2_000n)];
  const heldInside = new Map([[301, heldFor(inside, 301, 2_000n)]]);
  const member = resolveWindowsTreeMembership(input({ rows: inside, rootPid: 201, expectedRootTicks: null, killed, held: heldInside }));
  assert.deepEqual(member.kind === "members" ? member.members.map((m) => m.pid) : [], [301]);

  const stale = [row(302, 201, -2_000n)];
  const excluded = resolveWindowsTreeMembership(input({ rows: stale, rootPid: 201, expectedRootTicks: null, killed }));
  assert.deepEqual(excluded.kind === "members" ? excluded.members.map((m) => m.pid) : [], []);

  const afterExit = [row(303, 201, 500_000n)];
  const foreign = resolveWindowsTreeMembership(input({ rows: afterExit, rootPid: 201, expectedRootTicks: null, killed }));
  assert.deepEqual(foreign.kind === "members" ? foreign.members.map((m) => m.pid) : [], []);
});

test("membership: a killed member without a confirmed exit time makes candidates refuse", () => {
  const killed = new Map([[201, { pid: 201, creationFileTime: FT(BASE + 3n), exitFileTime: null }]]);
  const resolution = resolveWindowsTreeMembership(input({
    rows: [row(301, 201, 2_000n)],
    rootPid: 201,
    expectedRootTicks: null,
    killed,
  }));
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_parent_exit_unconfirmed");
});

test("membership: a naturally-exited member's candidates refuse unless provably older", () => {
  // The root is alive and held; mid-tree member 102 vanished without our
  // signal; a live process now claims 102 as its parent.
  const rows = [row(101, 4, 0n), row(301, 102, 2_000n)];
  const held = new Map([[101, heldFor(rows, 101, 0n)]]);
  const naturalGone = new Set([102]);
  const naturalCreation = new Map([[102, FT(BASE + 400n)]]);
  const candidate = resolveWindowsTreeMembership(input({ rows, held, naturalGonePids: naturalGone, naturalGoneCreation: naturalCreation }));
  assert.equal(candidate.kind === "refuse" && candidate.code, "process_tree_parent_unprovable");

  const stale = resolveWindowsTreeMembership(input({
    rows: [row(101, 4, 0n), row(302, 102, -20_000n)],
    held,
    naturalGonePids: naturalGone,
    naturalGoneCreation: naturalCreation,
  }));
  assert.deepEqual(stale.kind === "members" ? stale.members.map((m) => m.pid) : [], [101]);
});

test("membership: a member whose identity cannot be read refuses instead of being signalled", () => {
  const rows = [row(101, 4, 0n), row(102, 101, 40n, null)];
  const held = new Map([
    [101, heldFor(rows, 101, 0n)],
    [102, { pid: 102, creationFileTime: FT(BASE + 403n), creationTicks: "whatever" }],
  ]);
  const resolution = resolveWindowsTreeMembership(input({ rows, held }));
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_member_identity_unknown");
});

test("membership: duplicate rows refuse the snapshot as invalid", () => {
  const rows = [row(101, 4, 0n), row(101, 4, 0n)];
  const resolution = resolveWindowsTreeMembership(input({ rows }));
  assert.equal(resolution.kind === "refuse" && resolution.code, "process_tree_snapshot_invalid");
});

test("membership: a transaction that killed the whole tree succeeds when nothing new claims it", () => {
  const killed = new Map([
    [101, { pid: 101, creationFileTime: FT(BASE + 3n), exitFileTime: FT(BASE + 500n) }],
  ]);
  const resolution = resolveWindowsTreeMembership(input({ rows: [], killed }));
  assert.equal(resolution.kind, "success");
});

// -- driver over a scripted fake transaction ---------------------------------

class FakeTransaction implements WindowsTreeTransactionLike {
  rows: WindowsProcessRow[];
  readonly holds: number[][] = [];
  readonly kills: Array<{ pid: number; ticks: string; waitMs: number }> = [];
  closeCount = 0;
  killBehavior: (pid: number, ticks: string) => KillOutcome = (pid) => {
    this.rows = this.rows.filter((r) => r.pid !== pid);
    return { status: "signaled", exitFileTime: FT(BASE + 1_000_000n) };
  };

  constructor(rows: readonly WindowsProcessRow[]) {
    this.rows = [...rows];
  }

  async enumerate(): Promise<readonly WindowsProcessRow[]> {
    return [...this.rows];
  }

  async hold(pids: readonly number[]): Promise<readonly HoldOutcome[]> {
    this.holds.push([...pids]);
    return pids.map((pid) => {
      const target = this.rows.find((r) => r.pid === pid);
      if (!target) return { pid, status: "absent" } as HoldOutcome;
      if (!target.startTicks || !target.creationFileTime) return { pid, status: "denied", error: 5 } as HoldOutcome;
      return {
        pid,
        status: "ok",
        creationFileTime: FT(BigInt(target.creationFileTime) + 3n),
        creationTicks: target.startTicks,
      } as HoldOutcome;
    });
  }

  async kill(pid: number, expectedTicks: string, waitMs: number): Promise<KillOutcome> {
    this.kills.push({ pid, ticks: expectedTicks, waitMs });
    return this.killBehavior(pid, expectedTicks);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

test("driver: signals exactly the verified members, children first, then verifies an empty closure", async () => {
  const rows = [row(101, 4, 0n), row(102, 101, 40n)];
  const fake = new FakeTransaction(rows);
  let opened = 0;
  const receipt = await terminateWindowsProcessTree(101, "101-ticks", 5_000, {
    open: async () => {
      opened += 1;
      return fake;
    },
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(opened, 1);
  assert.deepEqual(receipt.signaled, [102, 101], "leaf first, root last");
  assert.deepEqual(receipt.members.map((m) => m.pid), [101, 102]);
  assert.equal(receipt.kills.every((k) => k.status === "signaled"), true);
  assert.equal(fake.closeCount, 1, "the transaction helper is closed exactly once");
  // Every signal carried the member's captured startup identity.
  assert.deepEqual(fake.kills.map((k) => k.ticks), ["102-ticks", "101-ticks"]);
});

test("driver: a reused member PID is never signalled again; its candidates refuse conservatively", async () => {
  const rows = [row(101, 4, 0n), row(102, 101, 40n)];
  const fake = new FakeTransaction(rows);
  fake.killBehavior = (pid) => {
    if (pid === 102) return { status: "identity_changed", exitFileTime: null, detail: "other-ticks" };
    fake.rows = fake.rows.filter((r) => r.pid !== pid);
    return { status: "signaled", exitFileTime: FT(BASE + 1_000_000n) };
  };
  // Round 2: the vanished member's child appears; ownership is unprovable.
  let rounds = 0;
  fake.enumerate = async () => {
    rounds += 1;
    if (rounds === 1) return [row(101, 4, 0n), row(102, 101, 40n)];
    if (rounds === 2) return [row(103, 102, 2_000n)];
    return [];
  };
  await assert.rejects(
    terminateWindowsProcessTree(101, "101-ticks", 5_000, {
      open: async () => fake,
      now: () => 0,
      sleep: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /process_tree_parent_unprovable/);
      assert.deepEqual((error as { memberPids?: number[] }).memberPids, [101, 102]);
      return true;
    },
  );
  assert.equal(fake.kills.some((k) => k.pid === 103), false, "the unattributable candidate is never signalled");
  assert.equal(fake.closeCount, 1);
});

test("driver: a member that cannot be confirmed exited fails with its recorded member set", async () => {
  const rows = [row(101, 4, 0n)];
  const fake = new FakeTransaction(rows);
  fake.killBehavior = () => ({ status: "wait_timeout", exitFileTime: null });
  let clock = 0;
  await assert.rejects(
    terminateWindowsProcessTree(101, "101-ticks", 1_000, {
      open: async () => fake,
      now: () => clock,
      sleep: async () => {
        clock += 600;
      },
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /process_tree_cleanup_unverified/);
      assert.deepEqual((error as { memberPids?: number[] }).memberPids, [101]);
      return true;
    },
  );
  assert.equal(fake.closeCount, 1);
});

test("driver: an absent root refuses immediately and signals nothing", async () => {
  const fake = new FakeTransaction([row(555, 4, 0n)]);
  await assert.rejects(
    terminateWindowsProcessTree(101, "101-ticks", 1_000, { open: async () => fake, now: () => 0, sleep: async () => undefined }),
    /process_tree_root_exited/,
  );
  assert.deepEqual(fake.kills, []);
  assert.equal(fake.closeCount, 1);
});

test("driver: a wrong expected root fingerprint refuses before any signal", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n, "actual-ticks")]);
  await assert.rejects(
    terminateWindowsProcessTree(101, "different-ticks", 1_000, { open: async () => fake, now: () => 0, sleep: async () => undefined }),
    /process_tree_root_identity_changed/,
  );
  assert.deepEqual(fake.kills, []);
});

test("driver: dynamic descendants inside a killed parent's window are terminated identity-bound", async () => {
  // Round 1 sees only the root; a child spawns before the root's death and
  // is discovered in round 2 through the killed root's exact window.
  const fake = new FakeTransaction([row(101, 4, 0n)]);
  let rounds = 0;
  fake.enumerate = async () => {
    rounds += 1;
    if (rounds === 1) fake.rows = [row(101, 4, 0n)];
    else if (rounds === 2) fake.rows = [row(102, 101, 40n)];
    else fake.rows = [];
    return [...fake.rows];
  };
  const receipt = await terminateWindowsProcessTree(101, "101-ticks", 5_000, {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.deepEqual(receipt.signaled, [101, 102]);
  assert.deepEqual(receipt.members.map((m) => m.pid), [101, 102]);
});

// -- recorded-tree claimant scan ----------------------------------------------

test("scan: clean when nothing claims the recorded pids", async () => {
  const fake = new FakeTransaction([row(700, 4, 0n), row(701, 700, 10n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "101-ticks" }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.livePids, []);
  assert.equal(fake.closeCount, 1);
});

test("scan: a live recorded pid with a matching fingerprint is a claimant", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "101-ticks" }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan: a proven foreign generation of a recorded pid is excluded together with its subtree", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n, "reuser-ticks"), row(155, 101, 40n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "101-ticks" }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, true, "the reuser and its own child are not ours");
});

test("scan: children of a dead recorded pid stay claimants (attribution is impossible)", async () => {
  const fake = new FakeTransaction([row(180, 101, 40n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "101-ticks" }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [180]);
});

test("scan: a live recorded pid without a fingerprint stays a claimant (unknown is never clean)", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: null }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
});
