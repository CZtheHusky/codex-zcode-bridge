// Deterministic regressions for evaluator/review-round-1 blockers R2/R3/R4.
// All cases run on scripted fake transactions — no OS processes, no signals.
import assert from "node:assert/strict";
import test from "node:test";
import {
  terminateWindowsProcessTree,
  verifyWindowsRecordedTreeClaimants,
  type HoldOutcome,
  type KillOutcome,
  type WindowsProcessRow,
  type WindowsTreeTransactionLike,
} from "../src/adapters/windows-process-cleanup.js";

const BASE = 134_367_000_000_000_000n;
const MICROS = 10n;
const FT = (value: bigint | number): string => value.toString();

function row(pid: number, parentPid: number, cimOffset: bigint, ticks?: string | null): WindowsProcessRow {
  return { pid, parentPid, creationFileTime: FT(BASE + cimOffset * MICROS), startTicks: ticks === undefined ? `${pid}-ticks` : ticks };
}

class FakeTransaction implements WindowsTreeTransactionLike {
  rows: WindowsProcessRow[];
  readonly holds: number[][] = [];
  readonly kills: Array<{ pid: number; ticks: string }> = [];
  closeCount = 0;
  holdBehavior: ((pids: readonly number[]) => Promise<readonly HoldOutcome[]>) | null = null;
  killBehavior: ((pid: number, ticks: string) => KillOutcome) = (pid) => {
    this.rows = this.rows.filter((r) => r.pid !== pid);
    return { status: "signaled", exitFileTime: FT(BASE + 1_000_000n) };
  };
  enumerateBehavior: (() => Promise<readonly WindowsProcessRow[]>) | null = null;
  closeBehavior: (() => Promise<void>) | null = null;

  constructor(rows: readonly WindowsProcessRow[]) {
    this.rows = [...rows];
  }

  async enumerate(): Promise<readonly WindowsProcessRow[]> {
    if (this.enumerateBehavior) return this.enumerateBehavior();
    return [...this.rows];
  }

  async hold(pids: readonly number[]): Promise<readonly HoldOutcome[]> {
    this.holds.push([...pids]);
    if (this.holdBehavior) return this.holdBehavior(pids);
    return pids.map((pid) => {
      const target = this.rows.find((r) => r.pid === pid);
      if (!target || !target.startTicks || !target.creationFileTime) return { pid, status: "absent" } as HoldOutcome;
      return { pid, status: "ok", creationFileTime: FT(BigInt(target.creationFileTime) + 3n), creationTicks: target.startTicks } as HoldOutcome;
    });
  }

  async kill(pid: number, expectedTicks: string, waitMs: number): Promise<KillOutcome> {
    void waitMs;
    this.kills.push({ pid, ticks: expectedTicks });
    return this.killBehavior(pid, expectedTicks);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeBehavior) await this.closeBehavior();
  }
}

function drive(fake: FakeTransaction, clock: { now: number } = { now: 0 }): Promise<unknown> {
  return terminateWindowsProcessTree(101, "101-ticks", 5_000, {
    open: async () => fake,
    now: () => clock.now,
    sleep: async () => undefined,
  });
}

test("R2: a permanently denied hold fails the round with every observed candidate, before any signal", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n), row(102, 101, 40n)]);
  fake.holdBehavior = async (pids) => pids.map((pid) => {
    if (pid === 102) return { pid, status: "denied", error: 5 } as HoldOutcome;
    const target = fake.rows.find((r) => r.pid === pid);
    if (!target || !target.startTicks) return { pid, status: "absent" } as HoldOutcome;
    return { pid, status: "ok", creationFileTime: FT(BigInt(target.creationFileTime!) + 3n), creationTicks: target.startTicks } as HoldOutcome;
  });
  await assert.rejects(drive(fake), (error: unknown) => {
    assert.match((error as Error).message, /process_tree_hold_unresolved/);
    const memberPids = (error as { memberPids?: number[] }).memberPids ?? [];
    assert.ok(memberPids.includes(102), "the denied candidate stays in the failure set");
    assert.ok(memberPids.includes(101), "the already-proven root stays in the failure set");
    return true;
  });
  assert.deepEqual(fake.kills, [], "no member is signalled while a candidate is unprovable");
  assert.equal(fake.closeCount, 1);
});

test("R2: the review timeline — denied child vanishes while its grandchild lives — never yields success", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n), row(102, 101, 40n)]);
  let rounds = 0;
  fake.enumerateBehavior = async () => {
    rounds += 1;
    fake.rows = rounds === 1 ? [row(101, 4, 0n), row(102, 101, 40n)] : [row(103, 102, 2_000n)];
    return [...fake.rows];
  };
  fake.holdBehavior = async (pids) => pids.map((pid) => {
    if (pid === 102) return { pid, status: "denied", error: 5 } as HoldOutcome;
    const target = fake.rows.find((r) => r.pid === pid);
    if (!target || !target.startTicks || !target.creationFileTime) return { pid, status: "absent" } as HoldOutcome;
    return { pid, status: "ok", creationFileTime: FT(BigInt(target.creationFileTime) + 3n), creationTicks: target.startTicks } as HoldOutcome;
  });
  await assert.rejects(drive(fake), /process_tree_hold_unresolved/);
});

test("R2: hold responses that are missing, duplicated, or unexpected are protocol failures with the known set", async () => {
  for (const variant of ["missing", "duplicate", "unexpected"] as const) {
    const fake = new FakeTransaction([row(101, 4, 0n)]);
    fake.holdBehavior = async (pids) => {
      const outcomes = await new FakeTransaction(fake.rows).hold(pids);
      if (variant === "missing") return outcomes.slice(0, -1);
      if (variant === "duplicate") return [...outcomes, outcomes[0]!];
      return [...outcomes, { pid: 9_999, status: "ok" } as HoldOutcome];
    };
    await assert.rejects(drive(fake), (error: unknown) => {
      assert.match((error as Error).message, /process_tree_hold_invalid/);
      assert.deepEqual((error as { memberPids?: number[] }).memberPids, [101]);
      return true;
    });
    assert.equal(fake.kills.length, 0, `variant ${variant}: nothing is signalled`);
    assert.equal(fake.closeCount, 1, `variant ${variant}: the helper still closes`);
  }
});

test("R2 addendum: a candidate that vanishes between enumeration and hold fails closed with its subtree unattributable", async () => {
  // The candidate was live microseconds ago; if it exited just now, its own
  // descendants may survive and can no longer be attributed to a proven
  // parent identity. Dropping the row silently could return success while a
  // grandchild lives — the round must fail and keep the candidate recorded.
  const fake = new FakeTransaction([row(101, 4, 0n), row(104, 101, 60n)]);
  fake.holdBehavior = async (pids) => {
    const outcomes = await new FakeTransaction(fake.rows).hold(pids);
    return outcomes.map((outcome) => (outcome.pid === 104 ? { pid: 104, status: "absent" } as HoldOutcome : outcome));
  };
  await assert.rejects(drive(fake), (error: unknown) => {
    assert.match((error as Error).message, /process_tree_candidate_absent/);
    const memberPids = (error as { memberPids?: number[] }).memberPids ?? [];
    assert.ok(memberPids.includes(104), "the vanished candidate stays recorded");
    return true;
  });
  assert.equal(fake.kills.length, 0, "nothing is signalled for an unattributable subtree");
  assert.equal(fake.closeCount, 1);
});

test("R2: a deep tree terminates children-first with a complete receipt regardless of row order", async () => {
  // Review-round-1 addendum (test quality): a true three-plus-level chain,
  // asserted PAIRWISE — every member is signalled strictly before its own
  // parent — and converged within a single round even when enumeration
  // delivers rows before their parents.
  const chain = [row(101, 4, 0n), row(102, 101, 40n), row(103, 102, 80n), row(104, 103, 120n)];
  const parentOf = new Map<number, number>([[102, 101], [103, 102], [104, 103]]);
  const orders: Record<string, WindowsProcessRow[]> = {
    forward: [...chain],
    reverse: [...chain].reverse(),
    shuffled: [chain[2]!, chain[0]!, chain[3]!, chain[1]!],
  };
  for (const [name, rows] of Object.entries(orders)) {
    const fake = new FakeTransaction(rows);
    let enumerateCalls = 0;
    const killEnumerationCycles: number[] = [];
    const originalKill = fake.kill.bind(fake);
    fake.kill = async (pid: number, ticks: string, waitMs: number) => {
      killEnumerationCycles.push(enumerateCalls);
      return originalKill(pid, ticks, waitMs);
    };
    fake.enumerateBehavior = async () => {
      enumerateCalls += 1;
      return [...fake.rows];
    };
    const receipt = await drive(fake) as { signaled: number[]; members: unknown[] };
    assert.deepEqual([...receipt.signaled].sort((a, b) => a - b), [101, 102, 103, 104], `${name}: every level is signalled exactly once`);
    for (const [child, parent] of parentOf) {
      assert.ok(
        receipt.signaled.indexOf(child) < receipt.signaled.indexOf(parent),
        `${name}: pid ${String(child)} is signalled strictly before its own parent ${String(parent)}`,
      );
    }
    assert.equal(receipt.members.length, 4, `${name}: the receipt records every member identity`);
    assert.deepEqual(killEnumerationCycles, [1, 1, 1, 1], `${name}: every row was resolved in the first enumeration despite delivery order`);
  }
});

test("R3: a mid-transaction enumeration failure escapes with every known member identity", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n), row(102, 101, 40n)]);
  fake.killBehavior = (pid) => {
    if (pid === 102) return { status: "wait_timeout", exitFileTime: null };
    fake.rows = fake.rows.filter((r) => r.pid !== pid);
    return { status: "signaled", exitFileTime: FT(BASE + 1_000_000n) };
  };
  let rounds = 0;
  fake.enumerateBehavior = async () => {
    rounds += 1;
    if (rounds === 1) return [row(101, 4, 0n), row(102, 101, 40n)];
    throw new Error("synthetic incomplete query after partial termination");
  };
  await assert.rejects(drive(fake), (error: unknown) => {
    assert.match((error as Error).message, /process_tree_transaction_error: synthetic incomplete query/);
    const memberPids = (error as { memberPids?: number[] }).memberPids ?? [];
    assert.ok(memberPids.includes(102), "the still-unconfirmed child is preserved for later coverage");
    assert.ok(memberPids.includes(101), "the terminated root is preserved");
    return true;
  });
});

test("R3: a transport hold failure is wrapped with the known member set", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n), row(102, 101, 40n)]);
  fake.holdBehavior = async (pids) => {
    if (pids.includes(102)) throw new Error("synthetic hold transport failure");
    return new FakeTransaction(fake.rows).hold(pids);
  };
  await assert.rejects(drive(fake), (error: unknown) => {
    assert.match((error as Error).message, /process_tree_transaction_error: synthetic hold transport failure/);
    assert.ok(((error as { memberPids?: number[] }).memberPids ?? []).includes(101));
    return true;
  });
});

test("R4: a helper close failure after a clean body fails the whole transaction", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n)]);
  fake.closeBehavior = async () => {
    throw new Error("synthetic helper close failure");
  };
  await assert.rejects(drive(fake), (error: unknown) => {
    assert.match((error as Error).message, /process_tree_close_failed: synthetic helper close failure/);
    assert.deepEqual((error as { memberPids?: number[] }).memberPids, [101]);
    return true;
  });
});

test("R4: a helper close failure after a body failure keeps both visible", async () => {
  const fake = new FakeTransaction([row(101, 4, 0n)]);
  fake.killBehavior = () => ({ status: "wait_timeout", exitFileTime: null });
  fake.closeBehavior = async () => {
    throw new Error("synthetic helper close failure");
  };
  const clock = { now: 0 };
  await assert.rejects(terminateWindowsProcessTree(101, "101-ticks", 1_000, {
    open: async () => fake,
    now: () => clock.now,
    sleep: async () => {
      clock.now += 600;
    },
  }), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /process_tree_cleanup_unverified/);
    assert.match(message, /process_tree_close_failed/);
    return true;
  });
});

test("R4: the recorded-tree scan fails visibly when its helper close fails", async () => {
  const fake = new FakeTransaction([]);
  fake.closeBehavior = async () => {
    throw new Error("synthetic scan close failure");
  };
  await assert.rejects(
    verifyWindowsRecordedTreeClaimants([{ pid: 101, fingerprint: "101-ticks" }], { open: async () => fake, now: () => 0, sleep: async () => undefined }),
    /process_tree_close_failed: synthetic scan close failure/,
  );
});
