import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProcessIdentity } from "../runtime/process-probe.js";

/** Best-effort self identity published with lock ownership. Initialized
 * asynchronously at startup; until then locks are written with a null
 * fingerprint, which stays readable for old records and never auto-binds a
 * recycled PID to the previous owner (A2). */
let selfIdentity: ProcessIdentity | null = null;

/** Errno codes that can appear while the lock directory's neighborhood is in
 * motion. Directly observed under real cross-process contention: EPERM on
 * the withdrawal rename. Plausible but not handle-level verified: a delete-
 * pending destination name, a competitor or scanner holding a handle inside
 * the directory (libuv maps sharing violations to EBUSY, access denial to
 * EPERM/EACCES). Node's own recursive rm documents EBUSY/EMFILE/ENFILE/
 * ENOTEMPTY/EPERM as retryable for the same family. Everything outside this
 * set fails immediately and visibly. */
const TRANSIENT_LOCK_FS_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
/** rename(2) produces these ONLY when the destination already existed as a
 * NON-EMPTY directory: POSIX specifies EEXIST/ENOTEMPTY for renaming onto
 * an existing non-empty directory (an existing EMPTY directory is instead
 * silently replaced — the independently reproduced issue that motivated the
 * existence precheck above). Their appearance therefore proves definite
 * namespace contention — a competing publication landed between the
 * existence precheck and the rename (and may already have withdrawn again
 * before any recheck). Contention is never an escaping error: the
 * acquisition hands off to the existing-owner policies, and the caller's
 * bounded outer loop (withEventLock/withProcessLock deadlines) retries.
 * This classification was added after a real Linux full-suite run let
 * ENOTEMPTY escape when rapid publish/withdraw cycles outlived the bounded
 * publication retries (2026-10-17 matrix review). */
const DESTINATION_PRESENT_CONTENTION_CODES = new Set(["EEXIST", "ENOTEMPTY"]);
/** Bounded budgets for the transient retries; exhaustion keeps the original
 * error visible instead of spinning. */
const PUBLICATION_RETRY_ATTEMPTS = 3;
const WITHDRAW_RETRY_MS = 2_000;
const SHARED_GUARD_RETRY_MS = 2_000;
const PRIVATE_CLEANUP_RETRY_MS = 1_000;
const RETRY_PAUSE_MS = 10;

function isTransientLockFsError(error: unknown): boolean {
  return TRANSIENT_LOCK_FS_CODES.has((error as NodeJS.ErrnoException)?.code ?? "");
}

function pauseBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_PAUSE_MS);
}

export function publishSelfIdentity(identity: ProcessIdentity): void {
  selfIdentity = identity;
}

export function currentSelfIdentity(): ProcessIdentity | null {
  return selfIdentity;
}

/** Cross-process exclusion. A live owner is never evicted by elapsed time. */
export async function withProcessLock<T>(directory: string, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(directory))) {
    if (Date.now() >= deadline) {
      const owner = describeLockOwner(directory);
      throw new Error(`timed out waiting for process lock: ${directory}${owner ? ` (live owner: ${owner})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { return await operation(); }
  finally { release(); }
}

function describeLockOwner(directory: string): string | null {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid?: number; started_at?: string };
    if (!Number.isSafeInteger(owner.pid)) return null;
    return `pid ${String(owner.pid)}${owner.started_at ? `, started ${owner.started_at}` : ""}`;
  } catch {
    return null;
  }
}

/** Shared by short synchronous store transactions and asynchronous managers. */
export function tryAcquireProcessLock(directory: string): (() => void) | null {
  return tryAcquireProcessLockWithRetry(directory, 0);
}

function tryAcquireProcessLockWithRetry(directory: string, retries: number): (() => void) | null {
  const token = randomUUID();
  // Publishing must never overwrite an existing lock path, whatever it holds.
  // POSIX rename silently REPLACES an existing empty directory (observed in
  // the rootless Linux sandbox: an empty unknown-owner lock was consumed,
  // 2026-10-17 review). An empty, foreign, or unreadable lock is an unknown
  // owner that only the explicit acquireExistingLock policies may resolve —
  // never a silent takeover. The staged rename below stays the atomic
  // publication point for a genuinely free path; a lock that appears inside
  // the check-to-rename window still routes through the rename's error path.
  if (existsSync(directory)) return acquireExistingLock(directory);
  // Publish only a complete owner record. If the process exits during the
  // write, its private staging directory is harmless and the shared lock
  // path remains absent. Directory rename is the single publication point.
  const staging = `${directory}.${process.pid}.${token}.pending`;
  const ownerRecord = {
    pid: process.pid,
    token,
    started_at: new Date().toISOString(),
    // Fingerprint may be null before the async self-identity probe finishes;
    // null never authorizes binding a recycled PID to a prior owner.
    identity: selfIdentity
      ? { fingerprint: selfIdentity.fingerprint, identity_version: selfIdentity.identity_version, platform: selfIdentity.platform }
      : null,
  };
  try {
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, "owner.json"), JSON.stringify(ownerRecord), { mode: 0o600, flag: "wx" });
    try {
      renameSync(staging, directory);
    } catch (error) {
      removeStagedLock(staging);
      const code = (error as NodeJS.ErrnoException).code;
      // Any code outside the transient set (EIO, EINVAL, ...) is a real
      // failure and must stay visible even when a live owner exists —
      // swallowing it here turned an I/O error into a silent "busy"
      // (2026-10-17 review).
      if (!isTransientLockFsError(error)) throw error;
      // EEXIST/ENOTEMPTY definitively describe an intervening competing
      // destination (see DESTINATION_PRESENT_CONTENTION_CODES); a destination
      // that still exists does too. Either way this is contention, not an
      // acquisition failure: hand off to the existing-owner policies — a lock
      // that already withdrew again reads as busy there, and the caller's
      // bounded outer loop retries. Only the ambiguous absent-destination
      // codes (EPERM/EACCES/EBUSY — possibly persistent access failures)
      // consume the bounded publication retries and then throw visibly.
      if (DESTINATION_PRESENT_CONTENTION_CODES.has(code ?? "") || existsSync(directory)) {
        return acquireExistingLock(directory);
      }
      if (retries < PUBLICATION_RETRY_ATTEMPTS) {
        pauseBriefly();
        return tryAcquireProcessLockWithRetry(directory, retries + 1);
      }
      throw error;
    }
  } catch (error) {
    removeStagedLock(staging);
    throw error;
  }
  return () => {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { token?: string };
    if (owner.token !== token) throw new Error("process lock ownership changed");
    // Withdraw the complete owner atomically before deleting anything. A
    // crash during private cleanup must not leave an unreadable shared lock.
    const retired = `${directory}.${token}.retired`;
    renameWithTransientRetry(directory, retired);
    removeStagedLock(retired);
  };
}

/** Observed (real cross-process contention, 2026-10-17): the withdrawal
 * rename of the held lock directory fails transiently with EPERM. The
 * mechanism is a working hypothesis, not handle-level verified: a competitor
 * inspecting owner.json (acquireExistingLock) or a scanner plausibly holds a
 * handle inside the directory for milliseconds, which Windows refuses to
 * rename across. Retry only the whitelisted codes within a bounded budget;
 * on exhaustion the error stays visible and the shared lock keeps its
 * complete owner record, so the next acquisition still sees a live owner
 * instead of an unreadable or half-deleted lock. */
function renameWithTransientRetry(source: string, target: string): void {
  const deadline = Date.now() + WITHDRAW_RETRY_MS;
  while (true) {
    try { renameSync(source, target); return; }
    catch (error) {
      if (!isTransientLockFsError(error) || Date.now() >= deadline) throw error;
      pauseBriefly();
    }
  }
}

function acquireExistingLock(directory: string): (() => void) | null {
  // Reading the owner is one concern; acting on it is another. Only a failure
  // to READ a well-formed owner may fall back to the unreadable-lock policy
  // below — errors raised while reclaiming a verified-dead owner (for example
  // a shared guard that cannot be removed) must propagate, not be swallowed
  // by a catch-all (2026-10-17 review).
  let owner: { pid: number };
  try {
    owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid lock owner");
  } catch {
    // Never reclaim an unreadable legacy lock by age. It needs explicit
    // diagnosis; new acquisitions cannot create this state after staged publish.
    try {
      if (Date.now() - statSync(directory).mtimeMs > 30_000) throw new Error(`unreadable lock owner: ${directory}`);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
    return null;
  }
  try { process.kill(owner.pid, 0); }
  catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ESRCH") {
      if (reclaimDeadOwner(directory)) return tryAcquireProcessLock(directory);
    }
  }
  return null;
}

function removeStagedLock(directory: string): void {
  removePrivateFile(path.join(directory, "owner.json"));
  removePrivateDirectory(directory);
}

/** Best-effort removal of a lock's private owner record. A transiently
 * blocked unlink (EPERM observed) must be retried, or the surviving
 * owner.json keeps the retired directory non-empty forever — retrying only
 * the rmdir cannot fix an undeleted file (2026-10-17 review). Exhaustion
 * stays silent and private (ADR-005); it must never mask the original
 * acquisition error. */
function removePrivateFile(file: string): void {
  const deadline = Date.now() + PRIVATE_CLEANUP_RETRY_MS;
  while (true) {
    try { unlinkSync(file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || !isTransientLockFsError(error) || Date.now() >= deadline) return;
      pauseBriefly();
    }
  }
}

/** Best-effort removal of a lock's PRIVATE residue directories (staging and
 * retired). Retries the transient set briefly so Windows handle timing does
 * not leave garbage behind, but never surfaces or replaces an error: those
 * leftovers are private (ADR-005). The reclaim guard is deliberately NOT
 * handled here — it is shared state whose removal failure must stay visible
 * (removeSharedGuard above). */
function removePrivateDirectory(directory: string): void {
  const deadline = Date.now() + PRIVATE_CLEANUP_RETRY_MS;
  while (true) {
    try { rmdirSync(directory); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || !isTransientLockFsError(error) || Date.now() >= deadline) return;
      pauseBriefly();
    }
  }
}

function reclaimDeadOwner(directory: string): boolean {
  const guard = `${directory}.reclaim`;
  try { mkdirSync(guard); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  // Every exit after the guard exists funnels through exactly one removal so
  // no path strands it: the guard is shared coordination state and a leftover
  // blocks all future dead-owner reclaims of this lock path (the owner-turns-
  // live recheck deterministically stranded one, 2026-10-17 review). Removal
  // failure is visible on every outcome; when the reclaim operation itself
  // failed, that original error wins over the cleanup error.
  let outcome: { kind: "reclaimed" } | { kind: "busy" } | { kind: "error"; error: unknown };
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      outcome = { kind: "busy" }; // invalid owner record: needs explicit diagnosis, never reclaimed here
    } else {
      try {
        process.kill(owner.pid, 0);
        outcome = { kind: "busy" }; // owner is live again: plain contention, not death
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") {
          outcome = { kind: "busy" }; // unknown liveness is never treated as death
        } else {
          const retired = `${directory}.${randomUUID()}.retired`;
          renameWithTransientRetry(directory, retired);
          removeStagedLock(retired);
          outcome = { kind: "reclaimed" };
        }
      }
    }
  } catch (error) {
    outcome = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "busy" } // the lock vanished mid-recheck: a normal race, not an error
      : { kind: "error", error };
  }
  let guardCleanupError: unknown = null;
  try { removeSharedGuard(guard); }
  catch (error) { guardCleanupError = error; }
  if (outcome.kind === "error") throw outcome.error;
  if (guardCleanupError !== null) throw guardCleanupError;
  return outcome.kind === "reclaimed";
}

/** Removes the reclaim guard. Non-transient failures and budget exhaustion
 * throw with the guard path spelled out for manual diagnosis; unlike private
 * retired/staging residue this shared directory cannot be silently abandoned. */
function removeSharedGuard(guard: string): void {
  const deadline = Date.now() + SHARED_GUARD_RETRY_MS;
  while (true) {
    try { rmdirSync(guard); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      if (!isTransientLockFsError(error) || Date.now() >= deadline) {
        throw new Error(
          `could not remove the lock reclaim guard at ${guard} (${code ?? "unknown error"}); `
            + "a leftover guard blocks all future dead-owner reclaims of this lock and needs manual diagnosis",
          { cause: error },
        );
      }
      pauseBriefly();
    }
  }
}
