// ADR-009 deterministic unit tests: interval-exact membership resolution,
// the handle-transaction termination driver, and the recorded-tree claimant
// scan. Everything here runs on injected data — no OS processes, no signals.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWindowsTreeMembership,
  terminateWindowsProcessTree,
  verifyWindowsRecordedTreeClaimants,
  WindowsTreeCleanupError,
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

// -- PR #47 process-lock budget regressions ------------------------------------
//
// Measured on Windows (see the repair plan's stage-timing evidence): one
// full-table enumeration costs ~1.1-1.5s, so the two enumerations a normal
// reap needs already consume ~60% of the 5s kill budget. The old driver
// checked the deadline after EVERY kill pass unconditionally, so a slow
// enumeration plus a stale WMI row for an already-terminated member produced
// process_tree_cleanup_unverified — "not provably exited" — for members whose
// exit FILETIME had already been read from their held handles. These
// regressions pin the corrected semantics: the budget refuses only members
// WITHOUT a confirmed exit; confirmed members keep their proof.

test("driver budget: a stale row for a confirmed-exit member past the deadline completes the closure proof", async () => {
  const round1 = [row(101, 4, 0n), row(102, 101, 40n)];
  // Round 2 still lists both members (representation lag): each kill returns
  // already_exited WITH the exit FILETIME read on the held handle.
  const snapshots = [[...round1], [...round1], []];
  const kills: Array<{ pid: number; status: string }> = [];
  const clock = { now: 0 };
  const tx: WindowsTreeTransactionLike = {
    enumerate: async () => {
      const snapshot = snapshots.shift() ?? [];
      clock.now += 2_600; // each full-table enumeration outpaces the budget
      return snapshot;
    },
    hold: async (pids) => pids.map((pid) => {
      const target = round1.find((r) => r.pid === pid)!;
      return { pid, status: "ok", creationFileTime: FT(BigInt(target.creationFileTime!) + 3n), creationTicks: target.startTicks! } as HoldOutcome;
    }),
    kill: async (pid) => {
      kills.push({ pid, status: "already_exited" });
      return { status: "already_exited", exitFileTime: FT(BASE + 900_000n) };
    },
    close: async () => undefined,
  };
  const receipt = await terminateWindowsProcessTree(101, "101-ticks", 5_000, {
    open: async () => tx,
    now: () => clock.now,
    sleep: async () => undefined,
  });
  assert.equal(receipt.rounds, 3, "the stale-row round and the confirming round both ran");
  assert.deepEqual(receipt.signaled, [], "no signal is issued for an already-exited member");
  assert.ok(kills.length >= 4, "both members were re-checked across the stale round");
});

test("driver budget: an unconfirmed member past the deadline still refuses conservatively", async () => {
  const snapshots = [[row(101, 4, 0n)], []];
  const clock = { now: 0 };
  const tx: WindowsTreeTransactionLike = {
    enumerate: async () => {
      const snapshot = snapshots.shift() ?? [];
      clock.now += 6_000; // the very first enumeration already crosses the deadline
      return snapshot;
    },
    hold: async (pids) => pids.map((pid) => {
      const target = row(101, 4, 0n);
      return { pid, status: "ok", creationFileTime: FT(BigInt(target.creationFileTime!) + 3n), creationTicks: target.startTicks! } as HoldOutcome;
    }),
    kill: async () => ({ status: "wait_timeout", exitFileTime: null }), // exit NOT confirmed
    close: async () => undefined,
  };
  await assert.rejects(
    terminateWindowsProcessTree(101, "101-ticks", 5_000, {
      open: async () => tx,
      now: () => clock.now,
      sleep: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WindowsTreeCleanupError);
      assert.equal(error.code, "process_tree_cleanup_unverified");
      assert.match(error.message, /1 recorded member\(s\) not provably exited/);
      assert.deepEqual(error.memberPids, [101]);
      return true;
    },
  );
});

// -- recorded-tree claimant scan ----------------------------------------------

// Scan-section rows use NUMERIC startup ticks, matching the real transport
// contract (decimal strings): hold responses are validated against that
// shape before any identity proof is drawn from them (review-round-1 R2).
const SCAN_TICKS = (off: bigint): string => FT(BASE + off * MICROS + 7n);
function srow(pid: number, parentPid: number, cimOffset: bigint, ticks?: string): WindowsProcessRow {
  return { pid, parentPid, creationFileTime: FT(BASE + cimOffset * MICROS), startTicks: ticks ?? SCAN_TICKS(cimOffset) };
}

test("scan: clean when nothing claims the recorded pids", async () => {
  const fake = new FakeTransaction([srow(700, 4, 0n), srow(701, 700, 10n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.livePids, []);
  assert.equal(fake.closeCount, 1);
});

test("scan: a live recorded pid with a matching fingerprint is a claimant", async () => {
  const fake = new FakeTransaction([srow(101, 4, 0n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan: a proven foreign generation of a recorded pid does not inherit the recorded pid's old children", async () => {
  // The reuser currently owns pid 101; row 155 was created AFTER the reuser's
  // exact creation, so it provably belongs to the foreign generation and is
  // excluded. This is the ONLY subtree the foreign parent can exclude.
  const fake = new FakeTransaction([srow(101, 4, 0n, "1"), srow(155, 101, 40n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, true, "the reuser and its provably-new child are not ours");
});

test("scan: children of a dead recorded pid stay claimants (attribution is impossible)", async () => {
  const fake = new FakeTransaction([srow(180, 101, 40n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [180]);
});

test("scan: a live recorded pid without a fingerprint stays a claimant (unknown is never clean)", async () => {
  const fake = new FakeTransaction([srow(101, 4, 0n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: null }], {
    open: async () => fake,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(scan.clean, false);
});

// -- PR #47 P1-A/P1-B: recorded-tree scan attribution regressions -------------
//
// Scripted scan fixture: a fixed process table plus per-pid hold overrides,
// so a row can vanish between enumeration and hold (P1-A) or expose a
// foreign generation with an exact creation time (P1-B). No OS, no signals.

class ScriptedScan implements WindowsTreeTransactionLike {
  rows: WindowsProcessRow[];
  readonly holds: number[][] = [];
  readonly holdOverrides = new Map<number, HoldOutcome>();
  readonly holdResults = new Map<number, readonly HoldOutcome[]>();
  closeCount = 0;
  closeError: Error | null = null;

  constructor(rows: readonly WindowsProcessRow[]) {
    this.rows = [...rows];
  }

  async enumerate(): Promise<readonly WindowsProcessRow[]> {
    return [...this.rows];
  }

  async hold(pids: readonly number[]): Promise<readonly HoldOutcome[]> {
    this.holds.push([...pids]);
    const scripted = this.holdResults.get(pids.length);
    if (scripted) return scripted;
    return pids.map((pid) => {
      const override = this.holdOverrides.get(pid);
      if (override) return override;
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

  async kill(): Promise<KillOutcome> {
    throw new Error("read-only scan must not signal");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError) throw this.closeError;
  }
}

const scanDeps = (tx: ScriptedScan) => ({ open: async () => tx, now: () => 0, sleep: async () => undefined });

test("scan P1-A (maintainer counterexample): a recorded pid vanishing between enumeration and hold keeps its live child occupied", async () => {
  // Exact maintainer shape: rows use raw small filetime values; hold for the
  // enumerated parent returns absent. The child claims the vanished parent.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "100", startTicks: "100" },
    { pid: 102, parentPid: 101, creationFileTime: "200", startTicks: "200" },
  ]);
  tx.holdResults.set(1, [{ pid: 101, status: "absent" }]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, false, "a vanished parent's live child is never provably clean");
  assert.deepEqual(scan.livePids, [102]);
  assert.equal(tx.closeCount, 1);
});

test("scan P1-A: an absent parent's whole live subtree stays occupied (multi-level)", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n), srow(102, 101, 40n), srow(103, 102, 80n)]);
  tx.holdOverrides.set(101, { pid: 101, status: "absent" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

test("scan P1-B (maintainer counterexample): an old-generation child under a reused recorded pid stays a claimant", async () => {
  // Exact maintainer shape: the recorded fingerprint is 100 but pid 101 is now
  // generation 300 (foreign); the child was created at 200, BEFORE the
  // reuser's exact creation — the foreign generation cannot own it.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 101, creationFileTime: "200", startTicks: "200" },
  ]);
  tx.holdResults.set(1, [{ pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" }]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, false, "a foreign parent never proves its old-generation children foreign");
  assert.deepEqual(scan.livePids, [102]);
});

test("scan P1-B: old and provably-new children under one foreign parent are decided per edge", async () => {
  // Foreign exact creation F = BASE+3 (hold adds 3 to the row's CIM).
  const tx = new ScriptedScan([srow(101, 4, 0n, "1"), srow(102, 101, -20n), srow(103, 101, 40n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102], "the old child stays; the provably-new child is excluded");
});

test("scan P1-B boundary: a child whose CIM interval straddles the foreign creation is not provably foreign", async () => {
  // Child CIM = BASE (same anchor as the parent row) while F = BASE+3: the
  // child's true creation lies in [BASE, BASE+1us] and could be before F.
  // Zero tolerance: only a representation wholly at/after F is excluded.
  const tx = new ScriptedScan([srow(101, 4, 0n, "1"), srow(102, 101, 0n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102]);
});

test("scan P1-B boundary: a child whose representation equals the foreign creation is indistinguishable, not foreign", async () => {
  // Hold returns the exact foreign creation; a child anchored exactly there
  // could have been created in the same 100ns instant as the reuser. The
  // ADR-009 same-precision rule applies to exclusions too: only STRICTLY
  // later representations prove the foreign edge (review-round-1 R1).
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 101, creationFileTime: "300", startTicks: "300c" },
  ]);
  tx.holdResults.set(1, [{ pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" }]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102]);
  assert.deepEqual(tx.holds, [[101]], "an unprovable child is never held");
});

test("scan P1-B boundary: a child strictly after the foreign creation is excluded only through its own held identity", async () => {
  // The positive counterpart: the edge is strictly proven AND the child's
  // own hold is row-consistent — the child is held before being excluded,
  // so its descendants can be judged against ITS held exact creation.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 101, creationFileTime: "400", startTicks: "400" },
  ]);
  tx.holdOverrides.set(101, { pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.livePids, []);
  assert.deepEqual(tx.holds, [[101], [102]], "the excluded child was itself held and verified");
});

test("scan P1-B: a foreign descendant's own children are excluded only when created clearly after it", async () => {
  // 102 is excluded as a provable foreign child (held, row-consistent);
  // grandchild 103 created strictly after 102's HELD exact creation is
  // excluded transitively through its own held identity, while a grandchild
  // 104 predating that creation cannot be proven foreign and stays occupied.
  const after = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 100n),
  ]);
  const cleanScan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(after));
  assert.equal(cleanScan.clean, true, "the whole provably-foreign chain is excluded, each member held");
  assert.deepEqual(after.holds, [[101], [102], [103]], "every excluded member was individually held and verified");

  const before = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(104, 102, 20n),
  ]);
  const dirtyScan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(before));
  assert.equal(dirtyScan.clean, false);
  assert.deepEqual(dirtyScan.livePids, [104]);
});

test("scan P1-B: a same-precision grandchild under an excluded foreign child stays a claimant", async () => {
  // 103's CIM equals its excluded parent 102's CIM; 102's held exact creation
  // sits at CIM+3 ticks, so 103's representation does not lie strictly after
  // it — the edge direction is indistinguishable, refuse.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 40n),
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [103]);
});

// -- review-round-1 R1: intermediate foreign-lineage members need held proof --

test("scan R1: an intermediate foreign descendant that vanishes before its hold keeps its subtree occupied", async () => {
  // 101 is a proven foreign generation; 102 is created strictly after it and
  // would be excludable, but it disappears between enumeration and hold: it
  // is dead, unattributable, and its live grandchild 103 stays a claimant.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 100n),
  ]);
  tx.holdOverrides.set(102, { pid: 102, status: "absent" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [103], "the vanished intermediate itself is gone; its child stays occupied");
  assert.ok(tx.holds.some((h) => h.length === 1 && h[0] === 102), "the intermediate was actually held");
});

test("scan R1: an intermediate foreign descendant whose identity read is denied stays occupied with its subtree", async () => {
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 100n),
  ]);
  tx.holdOverrides.set(102, { pid: 102, status: "denied", error: 5 });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

test("scan R1: an intermediate whose held generation replaced its enumerated row stays occupied with its subtree", async () => {
  // The row says generation 400, but the held handle reports ticks 600: the
  // enumerated row and the current owner are different generations, so the
  // grandchild (created 500, before the 600 generation began) cannot be
  // attributed to the held one — everything stays occupied.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 100n),
  ]);
  tx.holdOverrides.set(102, { pid: 102, status: "ok", creationFileTime: FT(BASE + 600n), creationTicks: "600" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

test("scan R1: an intermediate whose held exact time contradicts its row interval stays occupied", async () => {
  // Ticks match the row but the held exact creation sits far outside the
  // row's CIM representation interval: row and handle disagree about the
  // generation; nothing under the contradiction is excludable.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, 40n),
    srow(103, 102, 100n),
  ]);
  tx.holdOverrides.set(102, { pid: 102, status: "ok", creationFileTime: FT(BASE + 5_000n), creationTicks: SCAN_TICKS(40n) });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

// -- review-round-1 R2: malformed hold evidence can never prove clean ---------

test("scan R2: a hold response for a different pid refuses the scan", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.holdResults.set(1, [{ pid: 999, status: "ok", creationFileTime: "300", creationTicks: "300" }]);
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    (error: unknown) => {
      assert.ok(error instanceof WindowsTreeCleanupError);
      assert.equal(error.code, "process_tree_hold_invalid");
      assert.match(error.message, /unexpected pid 999/);
      return true;
    },
  );
  assert.equal(tx.closeCount, 1, "the scan helper is closed on refusal");
});

test("scan R2: more hold responses than requested refuse the scan", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.holdResults.set(1, [
    { pid: 101, status: "ok", creationFileTime: "100", creationTicks: "100" },
    { pid: 101, status: "ok", creationFileTime: "100", creationTicks: "100" },
  ]);
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    /2 responses for 1 requested pid/,
  );
});

test("scan R2: an ok hold response without the exact creation filetime refuses the scan", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n), srow(102, 101, 40n)]);
  tx.holdResults.set(1, [{ pid: 101, status: "ok", creationTicks: "300" }]);
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    /lacks usable exact identity fields/,
  );
  assert.equal(tx.closeCount, 1);
});

test("scan R2: an ok hold response with a non-numeric creation time refuses the scan", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.holdResults.set(1, [{ pid: 101, status: "ok", creationFileTime: "not-a-number", creationTicks: "300" }]);
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    /lacks usable exact identity fields/,
  );
});

test("scan P1-B: a child with unknown creation time under a foreign parent stays a claimant", async () => {
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    { pid: 102, parentPid: 101, creationFileTime: null, startTicks: "102-ticks" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102]);
});

test("scan: a foreign parent's child with unknown creation time stays a claimant with its whole subtree", async () => {
  // 102 under the foreign parent has no CIM: it cannot be excluded, so it is
  // a claimant, and its live child 103 propagates through it.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    { pid: 102, parentPid: 101, creationFileTime: null, startTicks: "102-ticks" },
    srow(103, 102, 40n),
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

test("scan: a claimant under a foreign parent propagates to its own subtree", async () => {
  // Mixed lineage: 102 is an old-generation child (claimant); its live child
  // 103 is a claimant through it even though 103 was created after F.
  const tx = new ScriptedScan([
    srow(101, 4, 0n, "1"),
    srow(102, 101, -20n),
    srow(103, 102, 60n),
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103]);
});

test("scan: multi-level claimant propagation under a dead recorded pid", async () => {
  const tx = new ScriptedScan([srow(102, 101, 40n), srow(103, 102, 80n), srow(104, 103, 120n)]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [102, 103, 104]);
});

test("scan: a denied identity read of a live recorded pid stays a claimant and propagates to children", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n), srow(102, 101, 40n)]);
  tx.holdOverrides.set(101, { pid: 101, status: "denied", error: 5 });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101, 102]);
});

test("scan: a hold error outcome for a live recorded pid stays a claimant", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.holdOverrides.set(101, { pid: 101, status: "error", error: 87 });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan: a missing hold outcome fails the scan instead of proving clean", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.holdResults.set(1, []);
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    (error: unknown) => {
      assert.ok(error instanceof WindowsTreeCleanupError);
      assert.equal(error.code, "process_tree_hold_invalid");
      assert.match(error.message, /0 responses for 1 requested pid/);
      return true;
    },
  );
  assert.equal(tx.closeCount, 1, "the scan helper is still closed exactly once");
});

test("scan: an enumerate failure rejects and never reports clean", async () => {
  const tx = new ScriptedScan([srow(101, 4, 0n)]);
  tx.rows = [srow(101, 4, 0n)];
  const original = tx.enumerate.bind(tx);
  tx.enumerate = async () => {
    await original();
    throw new Error("process_tree_transport_timeout: enum begin");
  };
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: SCAN_TICKS(0n) }], scanDeps(tx)),
    /process_tree_transport_timeout/,
  );
});

// -- review-round-2 S1: evidence from multiple recorded roots combines --------

test("scan S1: a pid foreign to one recorded root but a live child of another dead recorded member stays occupied", async () => {
  // Recorded roots 101 (old fp 100) and 102 (no fingerprint). 102 is dead;
  // the current 101 (parent 102, generation 300) is proven foreign relative
  // to the OLD 101 record, but it is a live child of dead recorded 102 —
  // ours-or-unattributable under the contract. Claimant evidence wins.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants(
    [{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: null }],
    scanDeps(tx),
  );
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
  assert.ok(scan.observedPids.includes(101), "the claimant is reported as observed evidence");
});

test("scan S1: the same cross-root claim with target order reversed stays occupied", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants(
    [{ pid: 102, fingerprint: null }, { pid: 101, fingerprint: "100" }],
    scanDeps(tx),
  );
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan S1: the reused pid's descendants stay occupied with it (dead recorded ancestor)", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
    { pid: 103, parentPid: 101, creationFileTime: "400", startTicks: "400" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants(
    [{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }],
    scanDeps(tx),
  );
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101, 103]);
});

test("scan S1: when every recorded generation is proven foreign the tree releases (positive)", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 101, creationFileTime: "400", startTicks: "400" },
    { pid: 103, parentPid: 102, creationFileTime: "500", startTicks: "500" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants(
    [{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }],
    scanDeps(tx),
  );
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.livePids, []);
});

// -- review-round-2 S2: observation evidence survives the scan exit ----------

test("scan S2: a false result reports claimants and requested candidates as observed evidence, proven-foreign excluded", async () => {
  // Root 50001 is dead; child 51001 and grandchild 51002 are live claimants.
  // The scan never holds them (dead-root propagation needs no hold), yet both
  // must appear in observedPids for durable retention; the original target is
  // included as well.
  const tx = new ScriptedScan([
    { pid: 51001, parentPid: 50001, creationFileTime: "200", startTicks: "200" },
    { pid: 51002, parentPid: 51001, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 50001, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [51001, 51002]);
  assert.deepEqual(scan.observedPids, [50001, 51001, 51002]);
});

test("scan S2: a rejected scan carries the requested-but-unresolved candidate, not just the roots", async () => {
  // The foreign root is held and proven foreign (excluded from evidence);
  // the strictly-later child is requested, and its hold returns nothing —
  // the protocol failure must carry [root, child] so the manager can retain
  // the observation.
  const tx = new ScriptedScan([
    { pid: 50001, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 51001, parentPid: 50001, creationFileTime: "400", startTicks: "400" },
  ]);
  tx.holdOverrides.set(51001, undefined as unknown as HoldOutcome);
  tx.hold = async (pids: readonly number[]) => {
    tx.holds.push([...pids]);
    if (pids[0] === 51001) return [];
    return [{ pid: pids[0]!, status: "ok", creationFileTime: "300", creationTicks: "300" }];
  };
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 50001, fingerprint: "100" }], scanDeps(tx)),
    (error: unknown) => {
      assert.ok(error instanceof WindowsTreeCleanupError);
      assert.equal(error.code, "process_tree_hold_invalid");
      assert.deepEqual(error.memberPids, [50001, 51001], "the requested candidate joins the roots in the evidence");
      return true;
    },
  );
});

// -- review-round-3 T1: recorded foreign targets obey the same proof ---------

test("scan T1-A: a recorded child replaced OLDER than its recorded parent's replacement stays occupied", async () => {
  // Both 101 and 102 are recorded; both current holders match their rows but
  // differ from the recorded fingerprints. Current 101 (300) predates current
  // 102 (500): it is an old-generation child of recorded 102 or
  // unattributable — being a replacement of old 101 does not erase that.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 4, creationFileTime: "500", startTicks: "500" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan T1-A: equal-precision replacements across recorded roots stay occupied", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
    { pid: 102, parentPid: 4, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan T1-A: the demoted recorded child propagates claimants to later grandchildren", async () => {
  const tx = new ScriptedScan([
    { pid: 103, parentPid: 101, creationFileTime: "700", startTicks: "700" },
    { pid: 102, parentPid: 4, creationFileTime: "500", startTicks: "500" },
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101, 103]);
});

test("scan T1-A: target order reversal keeps the same cross-root occupancy", async () => {
  const tx = new ScriptedScan([
    { pid: 102, parentPid: 4, creationFileTime: "500", startTicks: "500" },
    { pid: 101, parentPid: 102, creationFileTime: "300", startTicks: "300" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 102, fingerprint: "200" }, { pid: 101, fingerprint: "100" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101]);
});

test("scan T1-A positive: a strictly-later proven edge between replaced recorded pids releases", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 102, creationFileTime: "600", startTicks: "600" },
    { pid: 102, parentPid: 4, creationFileTime: "500", startTicks: "500" },
  ]);
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.livePids, []);
  assert.deepEqual(tx.holds, [[101], [102]], "both replacements verified once; cached evidence, no repeat holds");
});

test("scan T1-B: a recorded root replaced between row and hold cannot use the row's lineage", async () => {
  // Row says generation 100 (parent 4); the held handle reports 300: the row
  // describes the OLD process and cannot vouch for the replacement — the
  // pid stays occupied and its row-child 400 is not excluded through it.
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "100", startTicks: "100" },
    { pid: 103, parentPid: 101, creationFileTime: "400", startTicks: "400" },
  ]);
  tx.holdOverrides.set(101, { pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101, 103]);
});

test("scan T1-B: a mixed-generation row (old CIM, new ticks) cannot vouch for the replacement either", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "100", startTicks: "300" },
    { pid: 103, parentPid: 101, creationFileTime: "400", startTicks: "400" },
  ]);
  tx.holdOverrides.set(101, { pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.livePids, [101, 103]);
});

test("scan T1-B positive: a row/handle-consistent foreign replacement keeps proving its lineage", async () => {
  const tx = new ScriptedScan([
    { pid: 101, parentPid: 4, creationFileTime: "300", startTicks: "300" },
    { pid: 103, parentPid: 101, creationFileTime: "400", startTicks: "400" },
  ]);
  tx.holdOverrides.set(101, { pid: 101, status: "ok", creationFileTime: "300", creationTicks: "300" });
  const scan = await verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "100" }, { pid: 102, fingerprint: "200" }], scanDeps(tx));
  assert.equal(scan.clean, true);
  assert.deepEqual(tx.holds, [[101], [103]]);
});
