// Windows process-tree ownership and termination (ADR-009).
//
// Strategy: one hidden PowerShell helper process runs the WHOLE termination
// transaction. It Add-Type's a Win32 helper that opens one process handle
// per verified member and keeps every handle open from identity verification
// until the final scan. Per the documented Windows contract (Process Handles
// and Identifiers / PROCESS_INFORMATION), a PID cannot be reused while any
// handle to the process object remains open, so held PIDs are
// generation-stable for the transaction's lifetime. Signals are issued only
// through those held handles, after GetProcessTimes on the SAME handle
// confirms the recorded startup identity; TerminateProcess therefore can
// never reach a recycled generation. Tree ownership (parent/child edges) is
// decided from exact kernel creation/exit times read from held handles; CIM
// CreationDate (a microsecond representation) is used only to exclude
// clearly-stale rows without touching them and to check that a handle and
// its enumeration row describe the same generation. Anything that cannot be
// proven — indistinguishable same-tick ordering, naturally-exited parents,
// unknown identities, protocol failures — fails conservatively and keeps
// occupancy; it is never reported as verified cleanup.
import { spawn } from "node:child_process";

/** CIM Win32_Process.CreationDate has microsecond representation: the true
 * creation time lies in the closed interval [cim, cim + 1us] (observed
 * truncation, never rounding up; see ADR-009 verification notes). */
export const CIM_REPRESENTATION_INTERVAL_TICKS = 10n;

export interface WindowsProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  /** CIM CreationDate.ToFileTimeUtc(), decimal string (100ns ticks since
   * 1601 UTC); null when the CIM value was unreadable (protected system
   * processes expose a null CreationDate). */
  readonly creationFileTime: string | null;
  /** Get-Process StartTime.Ticks, decimal string; null when unreadable. */
  readonly startTicks: string | null;
}

export interface HeldProcessInfo {
  readonly pid: number;
  /** Exact creation FILETIME read from the held handle. */
  readonly creationFileTime: string;
  /** The same creation time in DateTime .Ticks frame (matches StartTime.Ticks). */
  readonly creationTicks: string;
}

export interface KilledProcessRecord {
  readonly pid: number;
  readonly creationFileTime: string;
  /** Kernel exit FILETIME captured on the held handle; null when the exit
   * wait timed out (unconfirmed exit). */
  readonly exitFileTime: string | null;
}

export interface MemberResolution {
  readonly pid: number;
  readonly parentPid: number;
  /** CIM creation of the row (representation-interval anchor). */
  readonly creationFileTime: string;
  readonly startTicks: string;
}

export type MembershipResolution =
  | { readonly kind: "success" }
  | {
      readonly kind: "members";
      readonly members: readonly MemberResolution[];
      readonly holdRequired: readonly number[];
    }
  | { readonly kind: "refuse"; readonly code: string; readonly pid?: number };

export interface MembershipInput {
  readonly rows: readonly WindowsProcessRow[];
  readonly rootPid: number;
  /** Caller-bound root identity (persisted/spawn-captured StartTime.Ticks). */
  readonly expectedRootTicks: string | null;
  readonly held: ReadonlyMap<number, HeldProcessInfo>;
  readonly killed: ReadonlyMap<number, KilledProcessRecord>;
  /** Pids of earlier-round members that vanished without our signal. */
  readonly naturalGonePids: ReadonlySet<number>;
  /** Last observed CIM creation for naturally-gone pids (stale-row exclusion). */
  readonly naturalGoneCreation: ReadonlyMap<number, string>;
}

function withinCimInterval(exactFileTime: string, cimFileTime: string): boolean {
  const exact = BigInt(exactFileTime);
  const cim = BigInt(cimFileTime);
  return exact >= cim && exact <= cim + CIM_REPRESENTATION_INTERVAL_TICKS;
}

function cimIntervalWithin(cimFileTime: string, lowExact: string, highExact: string): boolean {
  const cim = BigInt(cimFileTime);
  return cim >= BigInt(lowExact) && cim + CIM_REPRESENTATION_INTERVAL_TICKS <= BigInt(highExact);
}

function cimClearlyBefore(cimFileTime: string, exactFileTime: string): boolean {
  return BigInt(cimFileTime) + CIM_REPRESENTATION_INTERVAL_TICKS < BigInt(exactFileTime);
}

function cimClearlyAfter(cimFileTime: string, exactFileTime: string): boolean {
  return BigInt(cimFileTime) > BigInt(exactFileTime);
}

function acceptMember(
  row: WindowsProcessRow,
  input: MembershipInput,
  held: ReadonlyMap<number, HeldProcessInfo>,
  members: MemberResolution[],
  memberPids: Set<number>,
  decidedIrrelevant: Set<number>,
  holdRequired: Set<number>,
  refuse: (code: string, pid?: number) => void,
): void {
  if (row.startTicks === null || row.creationFileTime === null) {
    refuse("process_tree_member_identity_unknown", row.pid);
    return;
  }
  const child = held.get(row.pid);
  if (!child) {
    holdRequired.add(row.pid); // the driver holds and re-resolves
    return;
  }
  if (!withinCimInterval(child.creationFileTime, row.creationFileTime)) {
    refuse("process_tree_generation_mismatch", row.pid);
    return;
  }
  if (child.creationTicks !== row.startTicks) {
    refuse("process_tree_member_generation_mismatch", row.pid);
    return;
  }
  memberPids.add(row.pid);
  members.push({ pid: row.pid, parentPid: row.parentPid, creationFileTime: row.creationFileTime, startTicks: row.startTicks });
}

/**
 * Pure, deterministic membership resolution over one enumeration round.
 * Seeds: the root row (identity-checked against the caller's expected
 * fingerprint), or — once the transaction itself killed the root — candidate
 * rows attributed through killed members' exact lifetime windows. Edges are
 * accepted only with proof:
 *  - live parent: exact handle creation times of both sides, child strictly
 *    later than parent; equal ticks are indistinguishable and refused;
 *  - killed parent (exact creation and exit times held from our signal):
 *    child creation within the closed [creation, exit] window proves
 *    membership (the PID belonged exclusively to that process during its
 *    lifetime); creation clearly before the parent (stale record) or after
 *    its confirmed exit proves the row is not that parent's child;
 *  - naturally-exited parent: no proof is possible; a live candidate under
 *    it that does not predate the parent's first observation refuses the
 *    round (conservative failure).
 * Stale rows are excluded by CIM-vs-exact time comparison BEFORE any handle
 * is opened on them.
 */
export function resolveWindowsTreeMembership(input: MembershipInput): MembershipResolution {
  const rowsByPid = new Map<number, WindowsProcessRow>();
  for (const row of input.rows) {
    if (rowsByPid.has(row.pid)) return { kind: "refuse", code: "process_tree_snapshot_invalid", pid: row.pid };
    rowsByPid.set(row.pid, row);
  }
  const members: MemberResolution[] = [];
  const memberPids = new Set<number>();
  const decidedIrrelevant = new Set<number>();
  const holdRequired = new Set<number>();
  const state: { refusal: { code: string; pid?: number } | null } = { refusal: null };
  const refuse = (code: string, pid?: number): void => {
    if (!state.refusal) state.refusal = { code, pid };
  };

  const rootRow = rowsByPid.get(input.rootPid);
  if (rootRow) {
    if (input.expectedRootTicks === null) {
      return { kind: "refuse", code: "process_tree_root_identity_required", pid: input.rootPid };
    }
    if (rootRow.startTicks === null || rootRow.creationFileTime === null) {
      return { kind: "refuse", code: "process_tree_root_identity_unknown", pid: input.rootPid };
    }
    if (rootRow.startTicks !== input.expectedRootTicks) {
      return { kind: "refuse", code: "process_tree_root_identity_changed", pid: input.rootPid };
    }
    const heldRoot = input.held.get(input.rootPid);
    if (!heldRoot) {
      holdRequired.add(input.rootPid);
    } else if (heldRoot.creationTicks !== rootRow.startTicks || !withinCimInterval(heldRoot.creationFileTime, rootRow.creationFileTime)) {
      return { kind: "refuse", code: "process_tree_root_generation_mismatch", pid: input.rootPid };
    } else {
      memberPids.add(rootRow.pid);
      members.push({ pid: rootRow.pid, parentPid: rootRow.parentPid, creationFileTime: rootRow.creationFileTime, startTicks: rootRow.startTicks });
    }
  } else if (!input.killed.has(input.rootPid)) {
    if (input.expectedRootTicks === null) {
      return { kind: "refuse", code: "process_tree_root_identity_required", pid: input.rootPid };
    }
    // Fresh transaction and the root is already gone: no provable complete
    // tree state exists (children of the dead root cannot be attributed).
    return { kind: "refuse", code: "process_tree_root_exited", pid: input.rootPid };
  }

  // Fixpoint: admitting a member can make its own children attributable.
  for (let changed = true; changed && !state.refusal;) {
    changed = false;
    for (const row of input.rows) {
      if (state.refusal) break;
      if (memberPids.has(row.pid) || decidedIrrelevant.has(row.pid)) continue;
      const parentPid = row.parentPid;
      if (parentPid === row.pid) {
        decidedIrrelevant.add(row.pid);
        changed = true;
        continue;
      }
      const parentRow = memberPids.has(parentPid) ? rowsByPid.get(parentPid) : undefined;
      if (parentRow) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        if (parentRow.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", parentPid);
          continue;
        }
        const parent = input.held.get(parentPid);
        if (!parent) {
          holdRequired.add(parentPid);
          continue;
        }
        if (cimClearlyBefore(row.creationFileTime, parent.creationFileTime)) {
          decidedIrrelevant.add(row.pid); // predates the parent: stale row
          changed = true;
          continue;
        }
        const child = input.held.get(row.pid);
        if (!child) {
          holdRequired.add(row.pid);
          continue;
        }
        if (!withinCimInterval(child.creationFileTime, row.creationFileTime) || !withinCimInterval(parent.creationFileTime, parentRow.creationFileTime)) {
          refuse("process_tree_generation_mismatch", row.pid);
          continue;
        }
        const childCreation = BigInt(child.creationFileTime);
        const parentCreation = BigInt(parent.creationFileTime);
        if (childCreation === parentCreation) {
          refuse("process_tree_edge_indistinguishable", row.pid);
          continue;
        }
        if (childCreation < parentCreation) {
          decidedIrrelevant.add(row.pid); // predates the parent
          changed = true;
          continue;
        }
        acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
        if (memberPids.has(row.pid)) changed = true;
        continue;
      }
      const killedParent = input.killed.get(parentPid);
      if (killedParent) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        if (cimClearlyBefore(row.creationFileTime, killedParent.creationFileTime)) {
          decidedIrrelevant.add(row.pid); // stale record predating the parent
          changed = true;
          continue;
        }
        if (killedParent.exitFileTime === null) {
          refuse("process_tree_parent_exit_unconfirmed", parentPid);
          continue;
        }
        if (cimClearlyAfter(row.creationFileTime, killedParent.exitFileTime)) {
          decidedIrrelevant.add(row.pid); // created after the confirmed exit
          changed = true;
          continue;
        }
        if (cimIntervalWithin(row.creationFileTime, killedParent.creationFileTime, killedParent.exitFileTime)) {
          acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
          if (memberPids.has(row.pid)) changed = true;
          continue;
        }
        // Interval straddles a window boundary: the exact time decides.
        const child = input.held.get(row.pid);
        if (!child) {
          holdRequired.add(row.pid);
          continue;
        }
        if (!withinCimInterval(child.creationFileTime, row.creationFileTime)) {
          refuse("process_tree_generation_mismatch", row.pid);
          continue;
        }
        const creation = BigInt(child.creationFileTime);
        if (creation >= BigInt(killedParent.creationFileTime) && creation <= BigInt(killedParent.exitFileTime)) {
          acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
          if (memberPids.has(row.pid)) changed = true;
        } else {
          decidedIrrelevant.add(row.pid); // outside the parent's lifetime
          changed = true;
        }
        continue;
      }
      if (input.naturalGonePids.has(parentPid)) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        const lastCim = input.naturalGoneCreation.get(parentPid) ?? null;
        if (lastCim !== null && cimClearlyBefore(row.creationFileTime, lastCim)) {
          decidedIrrelevant.add(row.pid); // predates the parent's first observation
          changed = true;
          continue;
        }
        refuse("process_tree_parent_unprovable", parentPid);
        continue;
      }
      // Review-round-1 addendum (test-quality): a row whose parent is a
      // still-UNDECIDED live row must stay pending for the next fixpoint
      // sweep — marking it irrelevant now would drop enumerated descendants
      // whenever rows arrive before their parent is admitted (reverse or
      // shuffled enumeration order). Only a parent that can provably never
      // join this tree (no row, not killed, not naturally gone, not the
      // root, or already decided irrelevant) makes the row irrelevant.
      const parentUndecidedLiveRow = rowsByPid.has(parentPid) && !memberPids.has(parentPid) && !decidedIrrelevant.has(parentPid);
      if (parentUndecidedLiveRow || parentPid === input.rootPid) continue; // pending: re-evaluate after the parent is decided
      decidedIrrelevant.add(row.pid); // parent outside this tree
      changed = true;
    }
  }
  if (state.refusal) return { kind: "refuse", code: state.refusal.code, pid: state.refusal.pid };
  if (holdRequired.size > 0) return { kind: "members", members, holdRequired: [...holdRequired] };
  if (members.length === 0) return { kind: "success" };
  return { kind: "members", members, holdRequired: [] };
}

// -- Transaction transport ------------------------------------------------

export interface HoldOutcome {
  readonly pid: number;
  readonly status: "ok" | "absent" | "denied" | "error";
  readonly creationFileTime?: string;
  readonly creationTicks?: string;
  readonly error?: number;
  readonly detail?: string;
}

export interface KillOutcome {
  readonly status: "signaled" | "identity_changed" | "not_held" | "wait_timeout" | "already_exited" | "error";
  readonly exitFileTime: string | null;
  readonly detail?: string;
}

export interface WindowsTreeTransactionLike {
  enumerate(): Promise<readonly WindowsProcessRow[]>;
  hold(pids: readonly number[]): Promise<readonly HoldOutcome[]>;
  kill(pid: number, expectedTicks: string, waitMs: number): Promise<KillOutcome>;
  close(): Promise<void>;
}

export interface WindowsCleanupDependencies {
  open: () => Promise<WindowsTreeTransactionLike>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class WindowsTreeCleanupError extends Error {
  readonly code: string;
  readonly memberPids: readonly number[];
  constructor(code: string, message: string, memberPids: readonly number[] = []) {
    super(message);
    this.name = "WindowsTreeCleanupError";
    this.code = code;
    this.memberPids = memberPids;
  }
}

export interface WindowsTerminationReceipt {
  readonly rootPid: number;
  readonly rounds: number;
  readonly members: readonly { pid: number; fingerprint: string; creationFileTime: string }[];
  readonly kills: readonly { pid: number; status: string; exitFileTime: string | null }[];
  readonly signaled: readonly number[];
}

interface MemberRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTicks: string;
  readonly creationFileTime: string;
}

/**
 * Terminates the process tree rooted at `pid` using ONLY identity-bound
 * signals through held handles. `expectedRootTicks` is the caller-bound root
 * identity (persisted executor fingerprint or spawn-time capture); the
 * Windows path never builds trust from a bare current PID. Resolves with a
 * receipt when the closure provably contains no live members; throws
 * WindowsTreeCleanupError on any unprovable or failed state (occupancy must
 * be retained). EVERY exception exit — including transport/query failures,
 * unresolved holds, and helper-close failures — carries the transaction's
 * known member pids plus any observed-but-unverified candidate pids, so a
 * caller can never lose the set it must keep occupied (review-round-1 R2/R3).
 */
export async function terminateWindowsProcessTree(
  pid: number,
  expectedRootTicks: string | null,
  killWaitMs: number,
  dependencies: WindowsCleanupDependencies,
): Promise<WindowsTerminationReceipt> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new WindowsTreeCleanupError("process_tree_invalid_pid", `a positive integer PID is required, got: ${String(pid)}`);
  }
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const transaction = await dependencies.open();
  const killed = new Map<number, KilledProcessRecord>();
  const held = new Map<number, HeldProcessInfo>();
  const naturalGone = new Set<number>();
  const naturalGoneCreation = new Map<number, string>();
  const memberReceipts = new Map<number, { pid: number; fingerprint: string; creationFileTime: string }>();
  const killReceipts: { pid: number; status: string; exitFileTime: string | null }[] = [];
  /** Candidates observed but never proven (unresolved holds): they stay in
   * every failure's pid set until the transaction fails or proves them. */
  const unverifiedCandidates = new Set<number>();
  let rounds = 0;
  let bodyError: unknown = null;
  let succeeded = false;
  const knownPids = (): number[] => [...new Set([...memberReceipts.keys(), ...unverifiedCandidates])];
  try {
    const deadline = now() + Math.max(0, killWaitMs);
    for (;;) {
      rounds += 1;
      const rows = await transaction.enumerate();
      const resolution = await resolveRound(rows);
      if (resolution.kind === "refuse") {
        throw new WindowsTreeCleanupError(resolution.code, `${resolution.code}: process tree cleanup refused`, knownPids());
      }
      if (resolution.kind === "success") break;
      const members: MemberRecord[] = resolution.members.map((m) => ({ pid: m.pid, parentPid: m.parentPid, startTicks: m.startTicks, creationFileTime: m.creationFileTime }));
      const livePids = new Set(resolution.members.map((m) => m.pid));
      for (const previous of memberReceipts.keys()) {
        if (!livePids.has(previous) && !killed.has(previous) && !naturalGone.has(previous)) {
          naturalGone.add(previous);
          naturalGoneCreation.set(previous, memberReceipts.get(previous)!.creationFileTime);
        }
      }
      for (const member of members) {
        unverifiedCandidates.delete(member.pid); // proven member this round
        if (!memberReceipts.has(member.pid)) {
          memberReceipts.set(member.pid, { pid: member.pid, fingerprint: member.startTicks, creationFileTime: member.creationFileTime });
        }
      }
      const ordered = orderChildrenFirst(members);
      const remaining = Math.max(120, deadline - now());
      const perMemberWait = Math.min(2_000, Math.max(120, Math.floor(remaining / Math.max(1, ordered.length))));
      for (const member of ordered) {
        const heldInfo = held.get(member.pid);
        const kill = await transaction.kill(member.pid, member.startTicks, perMemberWait);
        killReceipts.push({ pid: member.pid, status: kill.status, exitFileTime: kill.exitFileTime });
        if (kill.status === "signaled" || kill.status === "already_exited") {
          killed.set(member.pid, {
            pid: member.pid,
            creationFileTime: heldInfo?.creationFileTime ?? member.creationFileTime,
            exitFileTime: kill.exitFileTime,
          });
        } else if (kill.status === "identity_changed" || kill.status === "not_held") {
          // The recorded executor no longer owns the held handle/PID: it
          // changed hands outside our signal; further attribution for its
          // children is unprovable.
          naturalGone.add(member.pid);
          naturalGoneCreation.set(member.pid, member.creationFileTime);
        }
        // wait_timeout / error: the member stays unresolved; the next round
        // retries until the deadline refuses.
      }
      // The kill budget bounds WAITING for exits, not exits already proven on
      // held handles (PR #47 process-lock investigation): a member whose exit
      // FILETIME was read from its held handle IS provably exited, and a
      // full-table enumeration that ran slow must not turn that proof into a
      // false "not provably exited" failure. Only members WITHOUT a confirmed
      // exit trip the deadline; confirmation rounds for confirmed members
      // continue until the closure provably empties, still bounded end-to-end
      // by the transport session budget.
      const unconfirmedMembers = members.filter((m) => {
        const record = killed.get(m.pid);
        return record === undefined || record.exitFileTime === null;
      });
      if (now() >= deadline && unconfirmedMembers.length > 0) {
        throw new WindowsTreeCleanupError(
          "process_tree_cleanup_unverified",
          `process_tree_cleanup_unverified: ${String(unconfirmedMembers.length)} recorded member(s) not provably exited`,
          knownPids(),
        );
      }
      await sleep(20);
    }
    succeeded = true;
    return {
      rootPid: pid,
      rounds,
      members: [...memberReceipts.values()],
      kills: killReceipts,
      signaled: killReceipts.filter((k) => k.status === "signaled").map((k) => k.pid),
    };
  } catch (error) {
    bodyError = error;
    // Every exit carries the known member + unverified candidate set; a raw
    // transport/query error is wrapped so no caller ever sees a memberless
    // failure for a transaction that had observed members (R3).
    if (error instanceof WindowsTreeCleanupError) {
      throw error.memberPids.length > 0 ? error : new WindowsTreeCleanupError(error.code, error.message, knownPids());
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WindowsTreeCleanupError("process_tree_transaction_error", `process_tree_transaction_error: ${detail}`, knownPids());
  } finally {
    // R4: a helper-close failure is never swallowed. On success it fails the
    // whole transaction; on failure it is chained into the thrown error so
    // both remain visible.
    let closeError: unknown = null;
    try {
      await transaction.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== null) {
      const closeText = closeError instanceof Error ? closeError.message : String(closeError);
      if (bodyError !== null) {
        const original = bodyError instanceof WindowsTreeCleanupError
          ? new WindowsTreeCleanupError(bodyError.code, `${bodyError.message}; process_tree_close_failed: ${closeText}`, bodyError.memberPids.length > 0 ? bodyError.memberPids : knownPids())
          : new WindowsTreeCleanupError("process_tree_transaction_error", `process_tree_transaction_error: ${String(bodyError instanceof Error ? bodyError.message : bodyError)}; process_tree_close_failed: ${closeText}`, knownPids());
        throw original;
      }
      throw new WindowsTreeCleanupError("process_tree_close_failed", `process_tree_close_failed: ${closeText}`, knownPids());
    }
  }

  async function resolveRound(rows: readonly WindowsProcessRow[]): Promise<MembershipResolution> {
    let workingRows = [...rows];
    const resolve = (): MembershipResolution =>
      resolveWindowsTreeMembership({
        rows: workingRows,
        rootPid: pid,
        expectedRootTicks,
        held,
        killed,
        naturalGonePids: naturalGone,
        naturalGoneCreation,
      });
    let resolution = resolve();
    for (let attempt = 0; attempt < 6 && resolution.kind === "members" && resolution.holdRequired.length > 0; attempt += 1) {
      const requested = [...new Set(resolution.holdRequired)];
      for (const candidate of resolution.holdRequired) unverifiedCandidates.add(candidate);
      const outcomes = await transaction.hold(requested);
      // R2: missing, duplicate, or unexpected hold responses are explicit
      // protocol failures, never silently ignored members.
      if (outcomes.length !== requested.length) {
        throw new WindowsTreeCleanupError(
          "process_tree_hold_invalid",
          `process_tree_hold_invalid: ${String(outcomes.length)} responses for ${String(requested.length)} requested pids`,
          knownPids(),
        );
      }
      const seen = new Set<number>();
      for (const outcome of outcomes) {
        if (seen.has(outcome.pid)) {
          throw new WindowsTreeCleanupError("process_tree_hold_invalid", `process_tree_hold_invalid: duplicate response for pid ${String(outcome.pid)}`, knownPids());
        }
        seen.add(outcome.pid);
        if (!requested.includes(outcome.pid)) {
          throw new WindowsTreeCleanupError("process_tree_hold_invalid", `process_tree_hold_invalid: unexpected pid ${String(outcome.pid)} in hold response`, knownPids());
        }
        if (outcome.status === "ok") {
          held.set(outcome.pid, { pid: outcome.pid, creationFileTime: outcome.creationFileTime!, creationTicks: outcome.creationTicks! });
        } else if (outcome.status === "absent") {
          // Review-round-1 addendum (R2): an absent candidate is NOT
          // forgettable. The enumeration saw it live microseconds ago; its
          // own descendants may still be alive and can no longer be
          // attributed (the parent vanished before we proved its identity).
          // The round fails, keeping the candidate and every known member.
          throw new WindowsTreeCleanupError(
            "process_tree_candidate_absent",
            `process_tree_candidate_absent: candidate pid ${String(outcome.pid)} vanished between enumeration and hold; its subtree cannot be attributed`,
            [...new Set([...requested, ...knownPids()])],
          );
        }
        // denied / error stay unresolved and remain in unverifiedCandidates.
      }
      resolution = resolve();
    }
    if (resolution.kind === "members" && resolution.holdRequired.length > 0) {
      // R2: the bounded hold budget is exhausted with unprovable candidates.
      // The round is NOT an executable set: fail explicitly, keeping every
      // observed-but-unverified candidate (and this round's already-proven
      // members) in the failure's pid set.
      for (const candidate of resolution.holdRequired) unverifiedCandidates.add(candidate);
      const roundMemberPids = resolution.members.map((m) => m.pid);
      throw new WindowsTreeCleanupError(
        "process_tree_hold_unresolved",
        `process_tree_hold_unresolved: cannot prove identity/ownership for pids ${resolution.holdRequired.join(",")}`,
        [...new Set([...roundMemberPids, ...knownPids()])],
      );
    }
    return resolution;
  }
}

function orderChildrenFirst(members: readonly MemberRecord[]): MemberRecord[] {
  // True postorder (review-round-1 addendum): a member is emitted only after
  // every one of its own descendants inside this round's member set. Members
  // whose subtree relation is cyclic (corrupt data) fall back to
  // creation-descending order instead of blocking the bounded kill pass.
  const remaining = [...members];
  const ordered: MemberRecord[] = [];
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const member = remaining[index]!;
      const hasPendingChild = remaining.some((other) => other !== member && other.parentPid === member.pid);
      if (!hasPendingChild) {
        ordered.push(member);
        remaining.splice(index, 1);
        progress = true;
      }
    }
  }
  const leftovers = remaining.sort((a, b) => (BigInt(a.creationFileTime) > BigInt(b.creationFileTime) ? -1 : 1));
  return [...ordered, ...leftovers];
}

/**
 * Read-only recorded-tree scan: reports live processes that currently claim
 * any of the recorded pids as their parent, transitively. A recorded pid that
 * is alive with a MATCHING startup fingerprint is itself a claimant; one
 * alive with a different fingerprint is treated as a foreign generation ONLY
 * after its enumeration row and held handle prove to describe the SAME
 * generation, and even then it stays subject to the all-recorded-roots
 * incoming-edge proof below (review-round-3 T1) — a mismatch alone neither
 * excludes the pid nor certifies its row's lineage. A foreign-generation pid
 * is excluded, and a descendant is excluded with it ONLY when every edge of
 * its lineage is proven on held handles:
 *  - the parent of the edge is HELD (native handle, exact creation FILETIME
 *    and ticks from that same handle) and therefore provably owned its pid
 *    continuously from that creation until now, so a child whose CIM
 *    representation lies STRICTLY after the parent's exact creation was
 *    created during that ownership — equal, earlier, boundary-straddling, or
 *    unknown times are unproven and stay claimants (ADR-009 same-100ns rule;
 *    PR #47 review-round-1 R1: an unheld enumeration row alone proves
 *    nothing about pid ownership across the descendant's creation);
 *  - the excluded member itself must then be held with a row-consistent
 *    identity (same-generation handle) before ITS descendants may be
 *    classified — absent, denied, replaced-generation, or malformed evidence
 *    at any intermediate level keeps the subtree occupied.
 * Evidence from ALL recorded roots combines MONOTONICALLY (review-round-2
 * S1): a pid excluded as foreign relative to one recorded identity can still
 * be ours-or-unattributable relative to another (e.g. a live child of a dead
 * recorded member that happens to reuse another recorded pid). Claimant
 * evidence from any root always wins over foreign exclusion; the exclusion
 * only ever applies to pids with no claimant path from any root. A recorded
 * target's own foreign classification is held to the SAME proof as any
 * candidate (review-round-3 T1): the fingerprint mismatch must be backed by
 * a row/handle generation-consistent hold before the row may vouch for the
 * replacement, and the row's incoming edge is judged against foreign-held
 * parents like anyone else's — a cached foreign status is never a global
 * exclusion certificate, and strictly-later proven edges reuse the cached
 * hold without repeating it.
 * A recorded pid without a fingerprint that is alive stays a claimant
 * (unprovable, conservative). A recorded pid that vanishes between
 * enumeration and hold is dead: its live children count as claimants exactly
 * like children of any other dead recorded pid (PR #47 P1-A). Children of
 * dead recorded pids count as claimants: their creator is unattributable
 * after the fact, and releasing while one is alive could orphan our own
 * process. Hold responses are validated against the request (count, pid,
 * mandatory identity fields) before any proof is drawn from them
 * (review-round-1 R2); malformed evidence refuses the scan instead of
 * proving a false clean. This proves "nothing provably-ours-or-unattributable
 * is alive right now"; it does NOT prove no process ever descended from the
 * recorded pids (unobserved intermediate ancestors remain outside any
 * proof), and callers must log that boundary instead of claiming
 * completeness.
 *
 * Observation evidence (review-round-2 S2): `observedPids` (and the member
 * set carried by every exception) reports the TASK-RELEVANT pids this scan
 * actually involved — the recorded targets, every pid it asked the helper to
 * hold (foreign-lineage edge candidates), and the claimants — so a caller
 * can persist them before keeping occupancy and cover them on later scans.
 * Pids taken from response payloads are never trusted as observations. The
 * ORIGINAL recorded targets stay in the evidence even when their current
 * generation is proven foreign (later scans re-judge them under their
 * recorded identity); only NEWLY proven-foreign descendant candidates are
 * omitted from the added evidence — persisting those would make a later
 * fingerprint-less scan count them as claimants forever. A pid already
 * observed here is not an "unobserved ancestor" for later scans.
 */
export async function verifyWindowsRecordedTreeClaimants(
  targets: readonly { pid: number; fingerprint: string | null }[],
  dependencies: WindowsCleanupDependencies,
): Promise<{ clean: boolean; livePids: readonly number[]; observedPids: readonly number[] }> {
  const transaction = await dependencies.open();
  let bodyError: unknown = null;
  const targetPids = targets.map((t) => t.pid).filter((p) => Number.isInteger(p) && p > 0);
  const claimantPids = new Set<number>();
  /** Members whose foreign lineage is proven on a HELD, row-consistent
   * handle: `exact` is the held handle's exact creation FILETIME. */
  const foreignHeld = new Map<number, { readonly exact: string }>();
  /** Lineage members that are dead (absent at hold) but unattributable:
   * not occupied themselves, but their live children cannot be proven
   * foreign and stay claimants. */
  const unattributableLineagePids = new Set<number>();
  /** Pids whose incoming parent edge has been PROVEN strictly-later against
   * a held, row-consistent foreign parent (their cached hold evidence needs
   * no re-verification in later sweeps). */
  const edgeVerifiedForeignPids = new Set<number>();
  /** Every pid this scan asked the helper to hold — observation evidence
   * only ever comes from our own requests, never from response payloads. */
  const requestedPids = new Set<number>();
  /** Task-relevant observation evidence: targets + claimants + requested
   * pids that were not proven foreign (proven-foreign pids are omitted so a
   * later fingerprint-less scan cannot count them as claimants forever). */
  const evidencePids = (): number[] => [
    ...new Set([...targetPids, ...claimantPids, ...[...requestedPids].filter((pid) => !foreignHeld.has(pid))]),
  ];
  const DECIMAL = /^\d{1,25}$/u;
  /** A hold response whose shape was validated: ok outcomes carry both
   * exact identity fields as well-formed decimal strings. */
  type ValidatedHold =
    | { readonly status: "ok"; readonly creationFileTime: string; readonly creationTicks: string }
    | { readonly status: "absent" | "denied" | "error" };
  /** Holds exactly one pid and validates the response shape before any
   * caller draws identity evidence from it (review-round-1 R2): the count,
   * the pid, and — for ok outcomes — both exact identity fields must be
   * present and well-formed. Anything else is a protocol failure, never a
   * proof of anything; the failure carries the observation evidence
   * gathered so far (review-round-2 S2). */
  const holdOneValidated = async (pid: number): Promise<ValidatedHold> => {
    requestedPids.add(pid);
    const outcomes = await transaction.hold([pid]);
    if (outcomes.length !== 1) {
      throw new WindowsTreeCleanupError(
        "process_tree_hold_invalid",
        `process_tree_hold_invalid: ${String(outcomes.length)} responses for 1 requested pid`,
        evidencePids(),
      );
    }
    const outcome = outcomes[0];
    if (outcome === undefined || outcome.pid !== pid) {
      throw new WindowsTreeCleanupError(
        "process_tree_hold_invalid",
        `process_tree_hold_invalid: unexpected pid ${String(outcome?.pid ?? "missing")} in hold response`,
        evidencePids(),
      );
    }
    if (outcome.status === "ok") {
      if (typeof outcome.creationFileTime !== "string" || !DECIMAL.test(outcome.creationFileTime) ||
        typeof outcome.creationTicks !== "string" || !DECIMAL.test(outcome.creationTicks)) {
        throw new WindowsTreeCleanupError(
          "process_tree_hold_invalid",
          `process_tree_hold_invalid: ok hold response for pid ${String(pid)} lacks usable exact identity fields`,
          evidencePids(),
        );
      }
      return { status: "ok", creationFileTime: outcome.creationFileTime, creationTicks: outcome.creationTicks };
    }
    return { status: outcome.status };
  };
  try {
    const rows = await transaction.enumerate();
    const live = new Set<number>();
    for (const row of rows) live.add(row.pid);
    const rowsByPid = new Map<number, WindowsProcessRow>();
    for (const row of rows) {
      if (!rowsByPid.has(row.pid)) rowsByPid.set(row.pid, row);
    }
    const recorded = new Set<number>();
    for (const target of targets) {
      if (!Number.isInteger(target.pid) || target.pid <= 0) continue;
      recorded.add(target.pid);
      if (!live.has(target.pid)) continue;
      if (target.fingerprint === null) {
        claimantPids.add(target.pid);
        continue;
      }
      const outcome = await holdOneValidated(target.pid);
      if (outcome.status === "ok") {
        if (outcome.creationTicks === target.fingerprint) claimantPids.add(target.pid);
        else {
          // Review-round-3 T1(B): a fingerprint mismatch only proves the
          // CURRENT holder differs from the RECORD — it says nothing about
          // the enumerated row's lineage. The row may vouch for the held
          // generation only when row and handle describe the SAME generation
          // (ticks equal AND the exact time inside the row's representation
          // interval), exactly as required of excluded intermediates. An
          // inconsistent or unknown row cannot prove the replacement's
          // parentage: keep the pid occupied.
          const row = rowsByPid.get(target.pid);
          if (
            row !== undefined && row.startTicks !== null && row.creationFileTime !== null &&
            outcome.creationTicks === row.startTicks &&
            withinCimInterval(outcome.creationFileTime, row.creationFileTime)
          ) {
            foreignHeld.set(target.pid, { exact: outcome.creationFileTime });
          } else {
            claimantPids.add(target.pid);
          }
        }
      } else if (outcome.status === "absent") {
        // Vanished between enumeration and hold: it is dead now, so its live
        // children are children of a dead recorded pid — claimants. Dropping
        // it from the live set is what makes parentRecordedDead fire for them
        // (PR #47 P1-A); keeping it would leave the stale enumeration snapshot
        // vouching for a process that no longer exists.
        live.delete(target.pid);
      } else {
        // denied/error: identity unreadable; never treat as provably gone.
        claimantPids.add(target.pid);
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      // Claimant-path sweep (review-round-2 S1): evaluated for EVERY row —
      // a pid already excluded as foreign relative to one recorded root can
      // still be ours-or-unattributable relative to another (a live child of
      // a dead recorded member that reused another recorded pid, a descendant
      // of a claimant, or of an unattributable lineage member). Claimant
      // evidence from ANY root wins over foreign exclusion; exclusion only
      // ever applies to pids with no claimant path at all.
      for (const row of rows) {
        if (claimantPids.has(row.pid)) continue;
        if (
          claimantPids.has(row.parentPid) ||
          unattributableLineagePids.has(row.parentPid) ||
          (recorded.has(row.parentPid) && !live.has(row.parentPid) && !foreignHeld.has(row.parentPid))
        ) {
          claimantPids.add(row.pid);
          changed = true;
        }
      }
      // Foreign-lineage exclusion sweep (review-round-3 T1: a cached
      // foreign-held status — including one initialized from a recorded
      // target — is NOT a global exclusion certificate). Every row whose
      // incoming edge has not yet been proven is judged against a
      // foreign-held parent with the SAME strict edge rule, recorded targets
      // included: a row created at-or-before the parent's held exact creation
      // is an old-generation child of the recorded parent pid or
      // unattributable, and is demoted to a claimant even if it was already
      // foreign relative to its OWN record.
      for (const row of rows) {
        if (claimantPids.has(row.pid) || unattributableLineagePids.has(row.pid) || edgeVerifiedForeignPids.has(row.pid)) continue;
        const foreignParent = foreignHeld.get(row.parentPid);
        if (foreignParent === undefined) continue; // parent outside this tree or still pending a later sweep
        // The held foreign parent provably owned its pid continuously since
        // its exact creation F. A row created STRICTLY after F (whole CIM
        // representation interval beyond F; equality is the ADR-009
        // indistinguishable case, earlier rows are old-generation children)
        // is a candidate foreign descendant — but the candidate itself must
        // be held and row-consistent before it, in turn, may be excluded: an
        // unheld snapshot row proves nothing about pid ownership across its
        // own descendants (review-round-1 R1).
        if (row.creationFileTime === null || BigInt(row.creationFileTime) <= BigInt(foreignParent.exact)) {
          claimantPids.add(row.pid);
          foreignHeld.delete(row.pid);
          edgeVerifiedForeignPids.delete(row.pid);
          changed = true;
          continue;
        }
        if (foreignHeld.has(row.pid)) {
          // Already held and row-consistent (target initialization above or a
          // previous sweep pass): the strictly-later edge is proven with the
          // CACHED evidence — no repeat hold is issued.
          edgeVerifiedForeignPids.add(row.pid);
          changed = true;
          continue;
        }
        const outcome = await holdOneValidated(row.pid);
        if (outcome.status === "absent") {
          unattributableLineagePids.add(row.pid);
        } else if (
          outcome.status === "ok" &&
          row.startTicks !== null &&
          outcome.creationTicks === row.startTicks &&
          withinCimInterval(outcome.creationFileTime, row.creationFileTime)
        ) {
          // Same-generation handle and row: excluded as a proven foreign
          // descendant, and its own children will be judged against ITS held
          // exact creation in a later sweep.
          foreignHeld.set(row.pid, { exact: outcome.creationFileTime });
          edgeVerifiedForeignPids.add(row.pid);
        } else {
          // denied/error, or a replaced generation (handle ticks or exact
          // time inconsistent with the enumerated row): alive but unprovable.
          claimantPids.add(row.pid);
        }
        changed = true;
      }
    }
    const liveList = [...claimantPids].sort((a, b) => a - b);
    return { clean: liveList.length === 0, livePids: liveList, observedPids: evidencePids().sort((a, b) => a - b) };
  } catch (error) {
    bodyError = error;
    // Review-round-2 S2: EVERY exception exit carries the task-relevant
    // observation evidence (targets + claimants + requested-but-unproven
    // candidates), never pids taken from response payloads.
    if (error instanceof WindowsTreeCleanupError) {
      throw error.memberPids.length > 0 ? error : new WindowsTreeCleanupError(error.code, error.message, evidencePids());
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WindowsTreeCleanupError("process_tree_scan_failed", `process_tree_scan_failed: ${detail}`, evidencePids());
  } finally {
    // R4: the read-only scan must not claim a result through a silently
    // failed helper close either; a close failure is chained onto a body
    // failure or fails an otherwise-successful scan.
    let closeError: unknown = null;
    try {
      await transaction.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== null) {
      const closeText = closeError instanceof Error ? closeError.message : String(closeError);
      if (bodyError !== null) {
        const originalText = bodyError instanceof Error ? bodyError.message : String(bodyError);
        throw new WindowsTreeCleanupError("process_tree_scan_failed", `process_tree_scan_failed: ${originalText}; process_tree_close_failed: ${closeText}`, evidencePids());
      }
      throw new WindowsTreeCleanupError("process_tree_close_failed", `process_tree_close_failed: ${closeText}`, evidencePids());
    }
  }
}

// -- Real PowerShell transport --------------------------------------------
//
// One persistent hidden powershell.exe process runs the whole transaction so
// opened handles stay open across rounds (blocking PID reuse for held pids).
// Line protocol over stdio; every response ends with an explicit terminator
// line. Any deviation — unknown command, malformed row, early exit, timeout —
// is a hard failure: the transport throws and the driver reports unverified
// cleanup. Protocol text is ASCII only; localized stderr never surfaces.

export function windowsTreeTransactionScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Runtime.InteropServices;",
    "public static class BridgeTreeTx {",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint exitCode);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool CloseHandle(IntPtr h);",
    "  public static readonly Dictionary<int, IntPtr> Held = new Dictionary<int, IntPtr>();",
    "  public static string Hold(int pid) {",
    "    IntPtr existing;",
    "    if (Held.TryGetValue(pid, out existing) && existing != IntPtr.Zero) { return \"already_held|\"; }",
    "    IntPtr h = OpenProcess(0x00101001u, false, pid);",
    "    if (h == IntPtr.Zero) { int err = Marshal.GetLastWin32Error(); return (err == 87 ? \"absent|\" : (err == 5 ? \"denied|\" : \"error|\")) + err.ToString(); }",
    "    long c, e, k, u;",
    "    if (!GetProcessTimes(h, out c, out e, out k, out u)) { int err = Marshal.GetLastWin32Error(); CloseHandle(h); return \"error|\" + err.ToString(); }",
    "    Held[pid] = h;",
    "    return \"ok|\" + c.ToString() + \"|\" + DateTime.FromFileTime(c).Ticks.ToString();",
    "  }",
    "  public static string Kill(int pid, string expectTicks, int waitMs) {",
    "    IntPtr h;",
    "    if (!Held.TryGetValue(pid, out h) || h == IntPtr.Zero) { return \"not_held|\"; }",
    "    long c, e, k, u;",
    "    if (!GetProcessTimes(h, out c, out e, out k, out u)) { return \"error|\" + Marshal.GetLastWin32Error().ToString(); }",
    "    string current = DateTime.FromFileTime(c).Ticks.ToString();",
    "    if (current != expectTicks) { return \"identity_changed|\" + current; }",
    "    if (e != 0) { return \"already_exited|\" + e.ToString(); }",
    "    if (!TerminateProcess(h, 1)) { return \"error|\" + Marshal.GetLastWin32Error().ToString(); }",
    "    uint wait = WaitForSingleObject(h, (uint)waitMs);",
    "    if (!GetProcessTimes(h, out c, out e, out k, out u)) { return \"error|\" + Marshal.GetLastWin32Error().ToString(); }",
    "    if (wait != 0) { return \"wait_timeout|\" + e.ToString(); }",
    "    return \"signaled|\" + e.ToString();",
    "  }",
    "  public static string CloseAll() {",
    "    int closed = 0;",
    "    int failed = 0;",
    "    foreach (KeyValuePair<int, IntPtr> entry in Held) { if (entry.Value != IntPtr.Zero) { if (CloseHandle(entry.Value)) { closed++; } else { failed++; } } }",
    "    Held.Clear();",
    "    return closed.ToString() + \"|\" + failed.ToString();",
    "  }",
    "}",
    "'@",
    "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { [void][BridgeTreeTx]::CloseAll(); exit 0 }",
    "  $parts = $line.Trim().Split(' ')",
    "  if ($parts[0] -eq 'enum') {",
    "    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "    [Console]::Out.WriteLine('ENUM_BEGIN')",
    "    $ids = @(); foreach ($p in $all) { $ids += [int]$p.ProcessId }",
    "    $byId = @{}",
    "    if ($ids.Count -gt 0) { foreach ($g in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $byId[[int]$g.Id] = $g } }",
    "    foreach ($p in $all) {",
    "      $ticks = 'unknown'",
    "      $cim = 'unknown'",
    "      if ($null -ne $p.CreationDate) { $cim = [string]$p.CreationDate.ToFileTimeUtc() }",
    "      $g = $byId[[int]$p.ProcessId]",
    "      if ($null -ne $g) { try { $st = $g.StartTime; if ($null -ne $st) { $ticks = [string]$st.Ticks } } catch { $ticks = 'unknown' } }",
    "      if ([string]::IsNullOrEmpty($ticks)) { $ticks = 'unknown' }",
    "      [Console]::Out.WriteLine(('R {0} {1} {2} {3}' -f [int]$p.ProcessId, [int]$p.ParentProcessId, $cim, $ticks))",
    "    }",
    "    [Console]::Out.WriteLine('ENUM_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'hold') {",
    "    for ($i = 1; $i -lt $parts.Count; $i++) {",
    "      $hp = 0",
    "      if (-not [int]::TryParse($parts[$i], [ref]$hp)) { [Console]::Out.WriteLine('H 0 error 22'); continue }",
    "      $r = [BridgeTreeTx]::Hold($hp).Split('|')",
    "      if ($r[0] -eq 'already_held') { [Console]::Out.WriteLine(('H {0} held' -f $hp)) }",
    "      elseif ($r[0] -eq 'ok') { [Console]::Out.WriteLine(('H {0} ok {1} {2}' -f $hp, $r[1], $r[2])) }",
    "      else { [Console]::Out.WriteLine(('H {0} {1} {2}' -f $hp, $r[0], $r[1])) }",
    "    }",
    "    [Console]::Out.WriteLine('HOLD_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'kill') {",
    "    $kpid = [int]$parts[1]; $kticks = [string]$parts[2]; $kwait = [int]$parts[3]",
    "    $r = [BridgeTreeTx]::Kill($kpid, $kticks, $kwait).Split('|')",
    "    if ($r[0] -eq 'signaled' -or $r[0] -eq 'already_exited') { [Console]::Out.WriteLine(('K {0} {1} {2}' -f $kpid, $r[0], $r[1])) }",
    "    elseif ($r[0] -eq 'identity_changed') { [Console]::Out.WriteLine(('K {0} identity_changed 0' -f $kpid)) }",
    "    elseif ($r[0] -eq 'wait_timeout') { [Console]::Out.WriteLine(('K {0} wait_timeout {1}' -f $kpid, $r[1])) }",
    "    elseif ($r[0] -eq 'not_held') { [Console]::Out.WriteLine(('K {0} not_held 0' -f $kpid)) }",
    "    else { [Console]::Out.WriteLine(('K {0} error {1}' -f $kpid, $r[1])) }",
    "    [Console]::Out.WriteLine('KILL_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'close') {",
    "    $r = [BridgeTreeTx]::CloseAll().Split('|')",
    "    [Console]::Out.WriteLine(('CLOSED {0} {1}' -f $r[0], $r[1])); [Console]::Out.Flush()",
    "    exit 0",
    "  } else {",
    "    [Console]::Out.WriteLine('FATAL unknown_command'); [Console]::Out.Flush(); exit 1",
    "  }",
    "}",
  ].join("\n");
}

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SpawnedChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream & { setEncoding(encoding: string): void };
  readonly stderr: NodeJS.ReadableStream & { setEncoding(encoding: string): void };
  readonly stdin: NodeJS.WritableStream;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Transport bounds (review-round-1 addendum R4): a single protocol line is
 * tiny, so 1 MiB is already generous; the total buffered stream is capped so
 * an endless writer cannot grow memory forever; an enumeration beyond 4096
 * rows is not a plausible process table and fails the snapshot; and the
 * whole session has one total wait budget so repeated small chunks can never
 * extend a stalled helper indefinitely. */
export const TRANSPORT_MAX_LINE_BYTES = 1_048_576;
export const TRANSPORT_MAX_BUFFERED_BYTES = 8_388_608;
export const TRANSPORT_MAX_BUFFERED_LINES = 65_536;
export const TRANSPORT_MAX_ENUM_ROWS = 4_096;
export const TRANSPORT_TOTAL_SESSION_MS_DEFAULT = 120_000;

export interface TransportBounds {
  maxLineBytes?: number;
  maxBufferedBytes?: number;
  maxBufferedLines?: number;
  maxEnumRows?: number;
  totalSessionMs?: number;
}

export class PowerShellTreeTransaction implements WindowsTreeTransactionLike {
  readonly #child: SpawnedChild;
  readonly #bounds: Required<TransportBounds>;
  #lines: string[] = [];
  #waiters: LineWaiter[] = [];
  #exitWaiters: Array<() => void> = [];
  #closed = false;
  #bufferedBytes = 0;
  #sessionDeadline: number;
  #exitCode: number | null = null;
  #exitSignal: string | null = null;
  /** True once the helper's own exit is expected (receipt processed or
   * fallback initiated); its close event is then not a transport failure. */
  #closeHandled = false;
  #failure: Error | null = null;

  /** Test seam: attach to an externally spawned/controlled child so the
   * bounded-stream behaviours are testable with fake streams (no OS). */
  static attach(child: SpawnedChild, bounds: TransportBounds = {}): PowerShellTreeTransaction {
    return new PowerShellTreeTransaction(child, bounds);
  }

  private constructor(child: SpawnedChild, bounds: TransportBounds = {}) {
    this.#child = child;
    this.#bounds = {
      maxLineBytes: bounds.maxLineBytes ?? TRANSPORT_MAX_LINE_BYTES,
      maxBufferedBytes: bounds.maxBufferedBytes ?? TRANSPORT_MAX_BUFFERED_BYTES,
      maxBufferedLines: bounds.maxBufferedLines ?? TRANSPORT_MAX_BUFFERED_LINES,
      maxEnumRows: bounds.maxEnumRows ?? TRANSPORT_MAX_ENUM_ROWS,
      totalSessionMs: bounds.totalSessionMs ?? TRANSPORT_TOTAL_SESSION_MS_DEFAULT,
    };
    this.#sessionDeadline = Date.now() + this.#bounds.totalSessionMs;
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      // After a failure the transport stops receiving: no further buffering,
      // no further queueing (addendum 13:13 — overflow must also bound the
      // receiver, not just report once).
      if (this.#failure) {
        buffer = "";
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > this.#bounds.maxLineBytes) {
          this.#failAndDrain();
          this.#fail(new Error(`process_tree_transport_overflow: line of ${String(lineBytes)} bytes exceeds ${String(this.#bounds.maxLineBytes)}`));
          return;
        }
        this.#bufferedBytes += lineBytes;
        if (this.#bufferedBytes > this.#bounds.maxBufferedBytes || this.#lines.length >= this.#bounds.maxBufferedLines) {
          this.#failAndDrain();
          this.#fail(new Error(`process_tree_transport_overflow: buffered stream exceeded its byte or line budget (${String(this.#bufferedBytes)} bytes, ${String(this.#lines.length)} lines)`));
          return;
        }
        const waiter = this.#waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(line);
          this.#bufferedBytes -= lineBytes;
        } else {
          this.#lines.push(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > this.#bounds.maxLineBytes) {
        this.#failAndDrain();
        this.#fail(new Error(`process_tree_transport_overflow: unterminated line exceeds ${String(this.#bounds.maxLineBytes)} bytes`));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // The helper sets $ProgressPreference='SilentlyContinue', so the
      // progress/CLIXML noise PowerShell otherwise redirects here is
      // suppressed at the source. Anything that still arrives on stderr is
      // treated as a genuine error record (R4): never surfaced verbatim —
      // localized text stays private — but never silently ignored either.
      void chunk;
      this.#fail(new Error("process_tree_transport_stderr"));
    });
    child.on("error", (error) => this.#fail(new Error(`process_tree_transport_error: ${String(error.message)}`)));
    child.on("close", (code, signal) => {
      this.#closed = true;
      this.#exitCode = code;
      this.#exitSignal = signal;
      if (!this.#closeHandled) this.#fail(new Error("process_tree_transport_closed"));
      for (const waiter of this.#exitWaiters.splice(0)) waiter();
    });
  }

  /** Clears buffered receive state; used when a budget trips so a failed
   * transport neither accumulates nor serves stale lines afterwards. */
  #failAndDrain(): void {
    for (const line of this.#lines) this.#bufferedBytes -= Buffer.byteLength(line, "utf8");
    this.#lines = [];
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #nextLine(timeoutMs: number, what: string): Promise<string> {
    if (this.#failure) return Promise.reject(this.#failure);
    // R4 addendum 13:13: EVERY line-taking path is bounded by the total
    // session budget — a buffered line is not served after expiry, and its
    // bytes return to the budget when taken.
    const remainingSession = this.#sessionDeadline - Date.now();
    if (remainingSession <= 0) {
      const error = new Error(`process_tree_transport_session_timeout: ${what}`);
      this.#failAndDrain();
      this.#fail(error);
      return Promise.reject(error);
    }
    const buffered = this.#lines.shift();
    if (buffered !== undefined) {
      this.#bufferedBytes -= Buffer.byteLength(buffered, "utf8");
      return Promise.resolve(buffered);
    }
    if (this.#closed) return Promise.reject(new Error("process_tree_transport_closed"));
    const boundedTimeout = Math.min(timeoutMs, remainingSession);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        // Distinguish which budget expired: the total session cap vs the
        // individual command wait.
        const reason = remainingSession < timeoutMs ? "process_tree_transport_session_timeout" : "process_tree_transport_timeout";
        reject(new Error(`${reason}: ${what}`));
        this.#fail(new Error(`${reason}: ${what}`));
      }, boundedTimeout);
      if (typeof timer.unref === "function") timer.unref();
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  static async start(timeoutMs = 20_000): Promise<PowerShellTreeTransaction> {
    const encoded = Buffer.from(windowsTreeTransactionScript(), "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as SpawnedChild;
    const transaction = PowerShellTreeTransaction.attach(child);
    try {
      const ready = await transaction.#nextLine(timeoutMs, "helper startup");
      if (ready !== "READY") throw new Error("process_tree_transport_protocol: startup marker missing");
      return transaction;
    } catch (error) {
      // R4 addendum: a failed startup must converge its OWN helper — the
      // kill is issued and the exit is awaited within bounds; an unconfirmed
      // exit is reported, never assumed.
      transaction.#closeHandled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      const exited = await transaction.#waitForExit(3_000);
      if (!exited) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; process_tree_close_failed: startup helper did not exit within bounds`);
      }
      throw error;
    }
  }

  async enumerate(): Promise<readonly WindowsProcessRow[]> {
    this.#child.stdin.write("enum\n");
    const begin = await this.#nextLine(20_000, "enum begin");
    if (begin !== "ENUM_BEGIN") throw new Error("process_tree_snapshot_invalid: protocol missing");
    const rows: WindowsProcessRow[] = [];
    for (;;) {
      const line = await this.#nextLine(20_000, "enum row");
      if (line === "ENUM_END") break;
      const match = /^R (\d{1,12}) (\d{1,12}) (\d{1,25}|unknown) (\d{1,25}|unknown)$/u.exec(line);
      if (!match) throw new Error("process_tree_snapshot_invalid: malformed identity");
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      // Structurally valid but never signalable rows (e.g. System Idle
      // Process pid 0) are skipped; the snapshot itself stays valid.
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
      if (rows.length >= this.#bounds.maxEnumRows) {
        throw new Error(`process_tree_snapshot_invalid: enumeration exceeded ${String(this.#bounds.maxEnumRows)} rows`);
      }
      rows.push({ pid, parentPid, creationFileTime: match[3] === "unknown" ? null : match[3]!, startTicks: match[4] === "unknown" ? null : match[4]! });
    }
    return rows;
  }

  async hold(pids: readonly number[]): Promise<readonly HoldOutcome[]> {
    if (pids.length === 0) return [];
    this.#child.stdin.write(`hold ${pids.join(" ")}\n`);
    const outcomes: HoldOutcome[] = [];
    for (;;) {
      const line = await this.#nextLine(20_000, "hold response");
      if (line === "HOLD_END") break;
      const match = /^H (\d{1,12}) (ok (\d{1,25}) (\d{1,25})|held|absent (\d{1,6})|denied (\d{1,6})|error (\d{1,6}))$/u.exec(line);
      if (!match) throw new Error("process_tree_hold_invalid: malformed response");
      const pid = Number(match[1]);
      if (match[2]!.startsWith("ok")) {
        outcomes.push({ pid, status: "ok", creationFileTime: match[3], creationTicks: match[4] });
      } else if (match[2] === "held") {
        outcomes.push({ pid, status: "error", detail: "already_held" });
      } else if (match[2]!.startsWith("absent")) {
        outcomes.push({ pid, status: "absent", error: Number(match[5] ?? 0) });
      } else if (match[2]!.startsWith("denied")) {
        outcomes.push({ pid, status: "denied", error: Number(match[6] ?? 0) });
      } else {
        outcomes.push({ pid, status: "error", error: Number(match[7] ?? 0) });
      }
    }
    return outcomes;
  }

  async kill(pid: number, expectedTicks: string, waitMs: number): Promise<KillOutcome> {
    this.#child.stdin.write(`kill ${String(pid)} ${expectedTicks} ${String(Math.max(0, Math.floor(waitMs)))}\n`);
    const line = await this.#nextLine(waitMs + 25_000, "kill response");
    const end = await this.#nextLine(5_000, "kill terminator");
    if (end !== "KILL_END") throw new Error("process_tree_kill_invalid: terminator missing");
    const match = /^K (\d{1,12}) (signaled|identity_changed|not_held|wait_timeout|already_exited|error) (\d{1,25})$/u.exec(line);
    if (!match || Number(match[1]) !== pid) throw new Error("process_tree_kill_invalid: malformed response");
    const status = match[2] as KillOutcome["status"];
    const value = match[3]!;
    return {
      status,
      exitFileTime: status === "signaled" || status === "already_exited" || status === "wait_timeout" ? (value === "0" ? null : value) : null,
      detail: status === "identity_changed" ? value : undefined,
    };
  }

  async close(): Promise<void> {
    // R4: closing is verified, not assumed. The helper must acknowledge with
    // a CLOSED <closed> <failed> receipt where failed==0 (every CloseHandle
    // succeeded), and then actually exit within bounds. A forced-kill
    // fallback converges the process but stays VISIBLE as a failure — the
    // verified path never depends on it.
    let failure: Error | null = this.#failure;
    if (!failure && !this.#closed) {
      try {
        this.#child.stdin.write("close\n");
        const ack = await this.#nextLine(10_000, "close acknowledgement");
        const match = /^CLOSED (\d{1,9}) (\d{1,9})$/u.exec(ack);
        if (!match) throw new Error(`process_tree_close_invalid: unexpected close receipt ${JSON.stringify(ack.slice(0, 60))}`);
        const failedHandles = Number(match[2]);
        if (failedHandles > 0) throw new Error(`process_tree_close_failed: ${String(failedHandles)} CloseHandle call(s) failed`);
        this.#closeHandled = true;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        this.#closeHandled = true; // its exit below is expected; report `failure`
      }
    }
    const exited = await this.#waitForExit(5_000);
    if (!exited) {
      this.#closeHandled = true;
      try { this.#child.kill("SIGKILL"); } catch { /* already gone */ }
      try { this.#child.stdin.end(); } catch { /* already closed */ }
      const exitedAfterKill = await this.#waitForExit(3_000);
      if (!exitedAfterKill) {
        throw new Error(failure ? `${failure.message}; process_tree_close_failed: helper did not exit within bounds` : "process_tree_close_failed: helper did not exit within bounds");
      }
      throw new Error(failure ? `${failure.message}; process_tree_close_forced: helper exited only after a forced kill` : "process_tree_close_forced: helper exited only after a forced kill");
    }
    // R4 addendum 13:13: a natural close must also be a CLEAN exit — a
    // non-zero exit code or a signal on the helper is an explicit failure.
    if (this.#exitCode !== 0 || this.#exitSignal !== null) {
      const abnormal = `process_tree_close_abnormal: helper exited with code ${String(this.#exitCode)}${this.#exitSignal ? `, signal ${this.#exitSignal}` : ""}`;
      throw new Error(failure ? `${failure.message}; ${abnormal}` : abnormal);
    }
    if (failure) throw failure;
    if (this.#failure) throw this.#failure; // e.g. an error record hit stderr during shutdown
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.#exitWaiters.indexOf(waiter);
        if (index >= 0) this.#exitWaiters.splice(index, 1);
        resolve(value);
      };
      const waiter = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#exitWaiters.push(waiter);
    });
  }
}

/** Opens the real hidden PowerShell transaction helper. */
export async function openPowerShellTreeTransaction(): Promise<WindowsTreeTransactionLike> {
  return PowerShellTreeTransaction.start();
}
