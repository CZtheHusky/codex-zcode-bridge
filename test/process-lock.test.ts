import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { tryAcquireProcessLock } from "../src/store/process-lock.js";
import { captureSpawnGenerationIdentity, createPlatformProbe, terminateProcessTree } from "../src/adapters/process-spawn.js";

// Windows filesystem timing (2026-10-17 investigation): under real
// cross-process contention the lock's directory renames can fail transiently —
// publication onto a delete-pending name (EEXIST/EPERM/ENOTEMPTY) and
// withdrawal-stage EPERM (the competitor-handle explanation is a working
// hypothesis, not handle-level verified). These regressions pin the contract:
// whitelisted codes are retried within bounded budgets, non-transient errors
// and budget exhaustion stay visible, and a failed withdrawal keeps a complete
// readable lock that is never evicted while its owner lives.
import fs from "node:fs";

/** Patches one fs builtin for the duration of `body` so the compiled
 * process-lock module (which imports the same builtin) observes the wrapper;
 * syncBuiltinESMExports keeps the ESM view aligned. The wrapper closes over
 * the real implementation it receives. */
function withPatchedFs<K extends "renameSync" | "unlinkSync" | "rmdirSync" | "readFileSync">(
  fnName: K,
  makeWrapper: (real: typeof fs[K]) => typeof fs[K],
  body: () => void,
): void {
  const real = fs[fnName] as typeof fs[K];
  fs[fnName] = makeWrapper(real);
  syncBuiltinESMExports();
  try { body(); }
  finally { fs[fnName] = real; syncBuiltinESMExports(); }
}

function withPatchedRenameSync(fail: (source: string, target: string) => NodeJS.ErrnoException | null, body: () => void): void {
  withPatchedFs("renameSync", (real) => ((source: fs.PathLike, target: fs.PathLike) => {
    const injected = fail(String(source), String(target));
    if (injected) throw injected;
    return real(source, target);
  }) as typeof fs.renameSync, body);
}

function withPatchedUnlinkSync(fail: (target: string) => NodeJS.ErrnoException | null, body: () => void): void {
  withPatchedFs("unlinkSync", (real) => ((target: fs.PathLike) => {
    const injected = fail(String(target));
    if (injected) throw injected;
    return real(target);
  }) as typeof fs.unlinkSync, body);
}

function withPatchedRmdirSync(fail: (target: string) => NodeJS.ErrnoException | null, body: () => void): void {
  withPatchedFs("rmdirSync", (real) => ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const injected = fail(String(target));
    if (injected) throw injected;
    return real(target, options);
  }) as typeof fs.rmdirSync, body);
}

/** Sequence-controlled owner.json reads: the Nth read of a path can return a
 * different buffer or fail, reproducing records that change or vanish between
 * acquireExistingLock's read and the guarded recheck inside reclaim. */
function withSequencedOwnerReads(path: string, outcomes: Array<Buffer | NodeJS.ErrnoException>, body: () => void): void {
  let reads = 0;
  withPatchedFs("readFileSync", (real) => ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(target) === path && reads < outcomes.length) {
      const outcome = outcomes[reads]!;
      reads += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    return real(target, options as undefined);
  }) as typeof fs.readFileSync, body);
}

/** Sequence-controlled liveness probes: the Nth kill(pid, 0) can be forced to
 * ESRCH or success, reproducing an owner that is dead at first sight and live
 * again at the guarded recheck. */
function withSequencedKill(pid: number, outcomes: Array<"esrch" | "alive">, body: () => void): void {
  let probes = 0;
  const real = process.kill.bind(process);
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid && probes < outcomes.length) {
      const outcome = outcomes[probes]!;
      probes += 1;
      if (outcome === "esrch") {
        const error = new Error("injected ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }
    return real(target, signal);
  }) as typeof process.kill;
  try { body(); }
  finally { process.kill = real as typeof process.kill; }
}

const errnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(`injected ${code} (deterministic Windows-race regression)`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

// Dead owners use the suite's fixed high-pid fixture (the same convention as
// observation-lifecycle A2-07). The fixture's premise — process.kill(pid, 0)
// reporting ESRCH — is asserted before each use instead of assumed, and no
// claim is made about why the pid is unused on any platform.
const IMPOSSIBLE_DEAD_PID = 987654;
const assertDeadPidFixture = (): void => {
  assert.throws(() => process.kill(IMPOSSIBLE_DEAD_PID, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    "the fixed dead-owner pid fixture requires ESRCH on this platform; pick another value if this platform ever allocates it");
};
const seedDeadOwner = (lock: string): void => {
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: IMPOSSIBLE_DEAD_PID, token: "dead-owner", started_at: new Date().toISOString() }));
};

test("ambiguous absent-destination publication failures (EPERM/EACCES/EBUSY) are retried and publish exactly one owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-publish-"));
  try {
    const lock = path.join(root, "state.lock");
    let injected: string[] = [];
    withPatchedRenameSync((_source, target) => {
      if (target !== lock || injected.length >= 2) return null;
      // Ambiguous transient codes only: with no destination these may be
      // delete-pending races or scanner handles, which is what the bounded
      // publication retry exists for. EEXIST/ENOTEMPTY are NOT injected here
      // — they are definite destination-present contention (see the next
      // test) and must never consume the retry budget.
      const code = injected.length === 0 ? "EPERM" : "EBUSY";
      injected.push(code);
      return errnoError(code);
    }, () => {
      const release = tryAcquireProcessLock(lock);
      assert.ok(release, "publication must succeed after bounded transient retries");
      assert.equal(existsSync(lock), true, "lock must be published");
      const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid, "the single owner must be this process");
      release();
    });
    assert.deepEqual(injected, ["EPERM", "EBUSY"], "both injected failures must have occurred");
    assert.equal(existsSync(lock), false, "release must withdraw the published lock");
    assert.deepEqual(readdirSync(root), [], "no staging or retired garbage may remain");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("definite destination-present contention (EEXIST/ENOTEMPTY) is never an escaping error, even when the destination already withdrew", { timeout: 15_000 }, () => {
  // Deterministic reproduction of the Linux22 full-suite escape: a competing
  // owner publishes between the existence precheck and the rename, and
  // withdraws again before any recheck — so the destination is ABSENT when
  // the failed rename is inspected. rename(2) only produces EEXIST/ENOTEMPTY
  // for a destination that existed at rename time, so the errno itself is
  // the contention evidence. The acquisition must report busy (null) without
  // burning the publication retry budget; the previous implementation burned
  // all four attempts and let the errno escape (worker/probe-red-enotempty-
  // contention-node22.json).
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-contention-errno-"));
  try {
    for (const code of ["ENOTEMPTY", "EEXIST"]) {
      const lock = path.join(root, `state-${code}.lock`);
      let renameAttempts = 0;
      withPatchedRenameSync((_source, target) => {
        if (target !== lock) return null;
        renameAttempts += 1;
        return errnoError(code);
      }, () => {
        assert.equal(tryAcquireProcessLock(lock), null, `${code} from a publication rename is contention, reported as busy`);
      });
      assert.equal(renameAttempts, 1, `${code} must hand off on the first attempt instead of consuming publication retries`);
    }
    // And when the competing destination is still present, the existence
    // precheck routes to the existing-owner policies before any rename is
    // attempted at all — the live owner stays put and nothing is published.
    const held = path.join(root, "state-held.lock");
    const owner = tryAcquireProcessLock(held);
    assert.ok(owner);
    let heldAttempts = 0;
    withPatchedRenameSync((_source, target) => {
      if (target !== held) return null;
      heldAttempts += 1;
      return errnoError("ENOTEMPTY");
    }, () => {
      assert.equal(tryAcquireProcessLock(held), null, "a held destination reports busy");
    });
    assert.equal(heldAttempts, 0, "the precheck must keep a held destination away from the publication rename entirely");
    owner();
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("publication budget exhaustion fails visibly with the original code and leaves no artifacts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-budget-"));
  try {
    const lock = path.join(root, "state.lock");
    let attempts = 0;
    assert.throws(() => withPatchedRenameSync((_source, target) => {
      if (target !== lock) return null;
      attempts += 1;
      return errnoError("EPERM");
    }, () => tryAcquireProcessLock(lock)), (error: NodeJS.ErrnoException) => error.code === "EPERM");
    assert.ok(attempts >= 2 && attempts <= 4, `retry must be bounded (attempts: ${attempts})`);
    assert.equal(existsSync(lock), false, "nothing may be published on exhaustion");
    assert.deepEqual(readdirSync(root), [], "staging directories must be cleaned between attempts");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("non-transient publication errors are not retried", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-nontransient-"));
  try {
    const lock = path.join(root, "state.lock");
    let attempts = 0;
    assert.throws(() => withPatchedRenameSync((_source, target) => {
      if (target !== lock) return null;
      attempts += 1;
      return errnoError("EINVAL");
    }, () => tryAcquireProcessLock(lock)), (error: NodeJS.ErrnoException) => error.code === "EINVAL");
    assert.equal(attempts, 1, "a non-transient code must fail on the first attempt");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a transient EPERM during withdrawal is retried and the lock is released", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-withdraw-"));
  try {
    const lock = path.join(root, "state.lock");
    const release = tryAcquireProcessLock(lock);
    assert.ok(release);
    let failedOnce = false;
    withPatchedRenameSync((source, target) => {
      if (source === lock && target.endsWith(".retired") && !failedOnce) {
        failedOnce = true;
        return errnoError("EPERM");
      }
      return null;
    }, () => {
      release();
      assert.equal(failedOnce, true, "the injected withdrawal failure must have occurred");
    });
    assert.equal(existsSync(lock), false, "the lock must be withdrawn after the retry");
    assert.deepEqual(readdirSync(root), [], "retired directory must be cleaned");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("exhausted withdrawal retries keep a complete lock and never evict the live owner", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-withdraw-budget-"));
  try {
    const lock = path.join(root, "state.lock");
    const release = tryAcquireProcessLock(lock);
    assert.ok(release);
    assert.throws(() => withPatchedRenameSync((_source, target) => (target.endsWith(".retired") ? errnoError("EPERM") : null), () => {
      release();
    }), (error: NodeJS.ErrnoException) => error.code === "EPERM");
    assert.equal(existsSync(lock), true, "the shared lock must survive a failed withdrawal");
    const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid, "the lock record must stay complete and readable");
    assert.equal(tryAcquireProcessLock(lock), null, "a live owner must not be evicted");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

/** A tracked child for the contention scenarios: listeners attach at spawn
 * time so no close/error event can be lost, and every child can be reaped
 * (terminated and awaited) even when an assertion fails mid-test. */
interface TrackedChild {
  readonly child: ReturnType<typeof spawn>;
  readonly closed: Promise<number | null>;
  stdout: () => string;
}

function spawnTracked(script: string, argv: string[] = []): TrackedChild {
  const child = spawn(process.execPath, [script, ...argv], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk); });
  child.once("error", () => { /* recorded via the close promise */ });
  return { child, closed: new Promise<number | null>((resolve) => child.once("close", resolve)), stdout: () => stdout };
}

/** Terminates every still-running child of this test and CONFIRMS the close
 * event for each before cleanup may run — a leftover prober holding the lock
 * tree is exactly the teardown race this task fixes. A termination failure or
 * a close that never arrives within the bound is reported by throwing, never
 * by silently proceeding (2026-10-17 review: swallowed errors and timeout
 * races were false successes). "Closed" means the close event fired; on POSIX
 * a signal exit legitimately leaves exitCode null while signalCode is set.
 * The terminator is injectable so the failure branches are testable. */
async function reapTrackedChildren(
  tracked: readonly TrackedChild[],
  terminate: (child: import("node:child_process").ChildProcess) => Promise<unknown> = async (child) => {
    // ADR-009: hold the ORIGINAL ChildProcess. The shared capture
    // re-verifies the spawn generation after every await (exit state, never
    // the close flag), so a fingerprint read after an exit-and-recycle race
    // is discarded and the Windows terminator refuses to signal.
    if (child.pid === undefined) throw new Error("a running child has no pid to terminate");
    const identity = await captureSpawnGenerationIdentity(child, createPlatformProbe());
    return terminateProcessTree(child.pid, { expectedRootFingerprint: identity?.fingerprint ?? null, killWaitMs: 5_000 });
  },
): Promise<void> {
  const failures: string[] = [];
  await Promise.all(tracked.map(async ({ child, closed }) => {
    const running = child.exitCode === null && child.signalCode === null;
    if (running) {
      if (child.pid === undefined) {
        failures.push("a running child has no pid to terminate");
      } else {
        try { await terminate(child); }
        catch (error) { failures.push(`terminating pid ${child.pid} failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    let closedInTime = false;
    const deadline = new Promise<"deadline">((resolve) => {
      const timer = setTimeout(() => resolve("deadline"), 5_000);
      if (typeof timer.unref === "function") timer.unref();
    });
    const winner = await Promise.race([closed.then(() => "closed" as const), deadline]);
    if (winner === "closed") closedInTime = true;
    if (!closedInTime) failures.push(`pid ${child.pid ?? "?"} did not report close within 5s of reaping`);
    else await closed; // drain the promise so a rejection can never surface later
  }));
  if (failures.length > 0) throw new Error(`child reap failed: ${failures.join("; ")}`);
}

test("real cross-process contention never lets a lock error escape and the lock stays exclusive", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-contention-"));
  const tracked: TrackedChild[] = [];
  try {
    const lock = path.join(root, "state.lock");
    const ledger = path.join(root, "holders.log");
    const script = path.join(root, "contend.mjs");
    writeFileSync(script, [
      "const fs = await import(\"node:fs\");",
      `const { tryAcquireProcessLock } = await import(${JSON.stringify(new URL("../src/store/process-lock.js", import.meta.url).href)});`,
      `const lock = ${JSON.stringify(lock)};`,
      `const ledger = ${JSON.stringify(ledger)};`,
      "let escaped = 0; let acquired = 0; const sample = [];",
      "for (let i = 0; i < 800; i++) {",
      "  try {",
      "    const release = tryAcquireProcessLock(lock);",
      "    if (release) {",
      "      acquired += 1;",
      // The ledger append happens INSIDE the critical section: if the lock
      // ever admits two owners, a \"+\" row appears before the previous
      // holder's \"-\" and the prefix count exceeds one.
      "      fs.appendFileSync(ledger, `+${process.pid}\\n`);",
      "      fs.appendFileSync(ledger, `-${process.pid}\\n`);",
      "      release();",
      "    }",
      "  } catch (error) { escaped += 1; if (sample.length < 3) sample.push({ code: error?.code, message: String(error?.message) }); }",
      "}",
      "process.stdout.write(JSON.stringify({ pid: process.pid, escaped, acquired, sample }));",
    ].join("\n"));
    tracked.push(...[1, 2, 3].map(() => spawnTracked(script)));
    const summaries = [];
    for (const tracker of tracked) {
      assert.equal(await tracker.closed, 0, `a contention prober crashed: ${tracker.stdout().slice(0, 400)}`);
      summaries.push(JSON.parse(tracker.stdout()));
    }
    for (const summary of summaries) {
      assert.equal(summary.escaped, 0, `lock errors must never escape contention: ${JSON.stringify(summary.sample)}`);
    }
    // Fairness is not a contract of tryAcquireProcessLock: no prober is
    // guaranteed to win within a fixed iteration count. What the contract
    // does promise is exclusivity whenever wins happen, verified by the
    // ledger below plus meaningful total activity.
    const totalAcquired = summaries.reduce((sum: number, summary: { acquired?: number }) => sum + (summary.acquired ?? 0), 0);
    assert.ok(totalAcquired >= 3, `contention must exercise the critical section (total wins: ${totalAcquired})`);
    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;
    let ledgerRows = 0;
    for (const row of readFileSync(ledger, "utf8").split("\n")) {
      if (!row) continue;
      ledgerRows += 1;
      concurrentHolders += row.startsWith("+") ? 1 : -1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
    }
    assert.equal(ledgerRows, totalAcquired * 2, "every win must be ledgered exactly once (+ and -)");
    assert.equal(maxConcurrentHolders, 1, "the lock must admit at most one owner at a time");
    assert.equal(existsSync(lock), false, "every winner released; the shared lock must be withdrawn at the end");
  } finally {
    await reapTrackedChildren(tracked);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a crashing or hung prober is reaped before cleanup leaves no residue", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-reap-"));
  const tracked: TrackedChild[] = [];
  try {
    const crashScript = path.join(root, "crash.mjs");
    const hangScript = path.join(root, "hang.mjs");
    writeFileSync(crashScript, "process.exit(7);\n");
    writeFileSync(hangScript, "setInterval(() => undefined, 1_000);\n");
    tracked.push(spawnTracked(crashScript));
    const crash = tracked[0]!;
    tracked.push(spawnTracked(hangScript));
    const hang = tracked[1]!;
    assert.equal(await crash.closed, 7, "the sacrificial crasher must fail first");
    const hungStillRunning = hang.child.exitCode === null && hang.child.signalCode === null;
    assert.equal(hungStillRunning, true, "the hanger must still be alive to exercise the reap path");
    await reapTrackedChildren(tracked);
    // Closed means the close event fired; per the Node 22.18 docs a POSIX
    // signal exit legitimately leaves exitCode null while signalCode is set,
    // so either combination proves termination and closing.
    const hangClosed = hang.child.exitCode !== null || hang.child.signalCode !== null;
    assert.equal(hangClosed, true, "the hung child must have been terminated and closed (exitCode xor signalCode set)");
  } finally {
    await reapTrackedChildren(tracked);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    assert.equal(existsSync(root), false, "cleanup only after every child of this test has closed");
  }
});

test("a failing terminator or a child that never closes makes the reap fail visibly before any cleanup", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-reap-fail-"));
  const tracked: TrackedChild[] = [];
  let hang: TrackedChild | null = null;
  try {
    const hangScript = path.join(root, "hang.mjs");
    writeFileSync(hangScript, "setInterval(() => undefined, 1_000);\n");
    hang = spawnTracked(hangScript);
    tracked.push(hang);
    // Branch 1: the terminator itself fails — the reap must throw, and the
    // caller's cleanup must not have deleted the tree under the live child.
    await assert.rejects(
      reapTrackedChildren(tracked, async () => { throw new Error("terminate refused (injected)"); }),
      /terminating pid .* failed: terminate refused/,
    );
    assert.equal(hang.child.exitCode === null && hang.child.signalCode === null, true, "the child is still alive after the failed reap");
    assert.equal(existsSync(root), true, "no cleanup may run while this test's child is still alive");
    // Branch 2: the terminator "succeeds" without killing anything — the
    // missing close event must surface as a bounded, visible reap failure.
    await assert.rejects(
      reapTrackedChildren(tracked, async () => undefined),
      /did not report close within 5s/,
    );
    assert.equal(existsSync(root), true, "still no cleanup under a live child");
  } finally {
    // Real reaping so this test never leaks its own child.
    await reapTrackedChildren(tracked);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an existing lock path is never renamed onto, so a live owner sees plain contention without publication attempts", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-liveowner-"));
  try {
    const lock = path.join(root, "state.lock");
    const owner = tryAcquireProcessLock(lock);
    assert.ok(owner);
    let renameAttempts = 0;
    withPatchedRenameSync((_source, target) => {
      if (target === lock) renameAttempts += 1;
      return null;
    }, () => {
      assert.equal(tryAcquireProcessLock(lock), null, "contention with a live owner reports busy");
    });
    assert.equal(renameAttempts, 0, "publication must not even attempt a rename onto an existing lock path");
    const ownerRecord = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
    assert.equal(ownerRecord.pid, process.pid, "the live owner's lock stays complete");
    owner();
    assert.equal(existsSync(lock), false);
    // With the path genuinely free again, a non-transient publication error
    // still throws instead of being reported as busy.
    assert.throws(
      () => withPatchedRenameSync((_source, target) => (target === lock ? errnoError("EIO") : null), () => {
        tryAcquireProcessLock(lock);
      }),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
      "an I/O error during publication onto a free path must stay visible",
    );
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an existing empty, foreign, or non-directory lock path is never silently taken over (Linux overwrite guard)", { timeout: 15_000 }, () => {
  // Rootless Linux reproduced (2026-10-17 review): POSIX rename replaces an
  // existing EMPTY directory, so the old publication path consumed an unknown
  // owner's empty lock. The pre-publication existence check must route every
  // existing shape — empty dir, foreign content, plain file — through the
  // acquireExistingLock policies and leave it byte-for-byte untouched.
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-unknown-"));
  try {
    const lock = path.join(root, "state.lock");
    mkdirSync(lock, { recursive: true });
    assert.equal(tryAcquireProcessLock(lock), null, "an empty unknown lock must block, not be replaced");
    assert.deepEqual(readdirSync(lock), [], "the empty lock directory stays untouched");
    writeFileSync(path.join(lock, "foreign.txt"), "unknown owner marker");
    assert.equal(tryAcquireProcessLock(lock), null, "a foreign unknown lock must block");
    assert.deepEqual(readdirSync(lock), ["foreign.txt"], "foreign content stays and no owner record is added");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  const fileRoot = mkdtempSync(path.join(tmpdir(), "bridge-lock-unknown-file-"));
  try {
    const fileLock = path.join(fileRoot, "state.lock");
    writeFileSync(fileLock, "not a directory");
    assert.equal(tryAcquireProcessLock(fileLock), null, "a plain file at the lock path must block");
    assert.equal(readFileSync(fileLock, "utf8"), "not a directory", "the file stays untouched");
  } finally { rmSync(fileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an owner turning live during the guarded recheck leaves no reclaim guard behind", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-relive-"));
  try {
    const lock = path.join(root, "state.lock");
    mkdirSync(lock, { recursive: true });
    // This record names THIS process, but the first liveness probe is forced
    // to ESRCH so the recheck path runs; the guarded second probe then sees
    // the owner live again — the deterministic reproduction of the stranded
    // guard from the attempt-2 review.
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "reliving", started_at: new Date().toISOString() }));
    withSequencedKill(process.pid, ["esrch", "alive"], () => {
      assert.equal(tryAcquireProcessLock(lock), null, "a re-living owner means plain contention");
    });
    assert.equal(existsSync(`${lock}.reclaim`), false, "the recheck exit must remove the shared guard");
    const ownerRecord = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
    assert.equal(ownerRecord.pid, process.pid, "the re-living owner's lock stays complete");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an owner record that turns invalid inside the guarded recheck blocks without stranding the guard", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-reinvalid-"));
  try {
    assertDeadPidFixture();
    const lock = path.join(root, "state.lock");
    seedDeadOwner(lock);
    assertDeadPidFixture();
    const ownerPath = path.join(lock, "owner.json");
    withSequencedOwnerReads(ownerPath, [Buffer.from(JSON.stringify({ pid: IMPOSSIBLE_DEAD_PID, token: "t" })), Buffer.from(JSON.stringify({ pid: 0 }))], () => {
      assert.equal(tryAcquireProcessLock(lock), null, "an invalid record at recheck means busy, never a reclaim");
    });
    assert.equal(existsSync(`${lock}.reclaim`), false, "the invalid-record exit must remove the shared guard");
    assert.equal(existsSync(lock), true, "the unknown lock is preserved for explicit diagnosis");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a lock vanishing at recheck returns to contention, and a guard cleanup failure there stays visible", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-renotempty-"));
  try {
    assertDeadPidFixture();
    const lock = path.join(root, "state.lock");
    const vanished = path.join(root, "vanished.lock");
    seedDeadOwner(vanished);
    const ownerPath = path.join(vanished, "owner.json");
    // Read #1 (acquireExistingLock) sees the dead owner; read #2 (guarded
    // recheck) hits ENOENT because the lock vanished — a normal race.
    withSequencedOwnerReads(ownerPath, [readFileSync(ownerPath), errnoError("ENOENT")], () => {
      assert.equal(tryAcquireProcessLock(vanished), null, "a vanished lock is a lost race, not an error");
    });
    assert.equal(existsSync(`${vanished}.reclaim`), false, "the ENOENT exit removes its guard");

    // Same race, but the shared guard's cleanup fails: the failure must not
    // be silently swallowed just to return the busy result.
    seedDeadOwner(lock);
    assertDeadPidFixture();
    const secondOwnerPath = path.join(lock, "owner.json");
    withPatchedRmdirSync((target) => (target.endsWith(".reclaim") ? errnoError("EIO") : null), () => {
      withSequencedOwnerReads(secondOwnerPath, [readFileSync(secondOwnerPath), errnoError("ENOENT")], () => {
        assert.throws(() => tryAcquireProcessLock(lock), /reclaim guard/u,
          "a guard cleanup failure must surface even when the reclaim itself raced to nothing");
      });
    });
    assert.equal(existsSync(`${lock}.reclaim`), true, "the stuck guard stays diagnosable");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("dead-owner reclaim with a non-removable shared guard fails visibly and diagnosably", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-guard-eio-"));
  try {
    const lock = path.join(root, "state.lock");
    seedDeadOwner(lock);
    assertDeadPidFixture();
    let guardAttempts = 0;
    assert.throws(
      () => withPatchedRmdirSync((target) => {
        if (target.endsWith(".reclaim")) { guardAttempts += 1; return errnoError("EIO"); }
        return null;
      }, () => {
        tryAcquireProcessLock(lock);
      }),
      (error: Error) => {
        assert.match(error.message, /reclaim guard/u, "the failure must name the shared guard");
        assert.match(error.message, /state\.lock\.reclaim/u, "the failure must spell out the diagnosable path");
        return true;
      },
      "a reclaim reported successful while the guard survives must not stand",
    );
    assert.ok(guardAttempts >= 1, "the injected guard failure must have occurred");
    assert.equal(existsSync(lock), false, "the dead owner's lock itself was still retired");
    assert.equal(existsSync(`${lock}.reclaim`), true, "the stuck guard remains visible for manual diagnosis");
    // Recovery: once the guard is manually removed, acquisition works again.
    rmSync(`${lock}.reclaim`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const release = tryAcquireProcessLock(lock);
    assert.ok(release, "acquisition recovers after manual guard removal");
    release();
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a transient guard cleanup failure is retried and the reclaim completes cleanly", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-guard-transient-"));
  try {
    const lock = path.join(root, "state.lock");
    seedDeadOwner(lock);
    assertDeadPidFixture();
    let guardFailuresLeft = 2;
    const acquired: { release: (() => void) | null } = { release: null };
    withPatchedRmdirSync((target) => {
      if (target.endsWith(".reclaim") && guardFailuresLeft > 0) { guardFailuresLeft -= 1; return errnoError("EBUSY"); }
      return null;
    }, () => {
      acquired.release = tryAcquireProcessLock(lock);
    });
    assert.ok(acquired.release, "the reclaim must succeed after transient guard retries");
    assert.equal(existsSync(`${lock}.reclaim`), false, "no guard residue");
    acquired.release();
    assert.deepEqual(readdirSync(root), [], "no lock residue of any kind after release");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("guard cleanup budget exhaustion stays visible instead of spinning", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-guard-budget-"));
  try {
    const lock = path.join(root, "state.lock");
    seedDeadOwner(lock);
    assertDeadPidFixture();
    const startedAt = Date.now();
    assert.throws(
      () => withPatchedRmdirSync((target) => (target.endsWith(".reclaim") ? errnoError("EBUSY") : null), () => {
        tryAcquireProcessLock(lock);
      }),
      /reclaim guard/u,
      "budget exhaustion must surface the guard failure",
    );
    assert.ok(Date.now() - startedAt < 5_000, "the retry budget must be bounded");
    assert.equal(existsSync(`${lock}.reclaim`), true, "the stuck guard stays diagnosable");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a transiently blocked owner.json unlink inside retirement leaves no residue", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-unlink-"));
  try {
    const lock = path.join(root, "state.lock");
    const release = tryAcquireProcessLock(lock);
    assert.ok(release);
    let unlinkFailedOnce = false;
    withPatchedUnlinkSync((target) => {
      if (target.endsWith("owner.json") && target.includes(".retired") && !unlinkFailedOnce) {
        unlinkFailedOnce = true;
        return errnoError("EPERM");
      }
      return null;
    }, () => {
      release();
    });
    assert.equal(unlinkFailedOnce, true, "the injected unlink failure must have occurred");
    assert.equal(existsSync(lock), false, "the lock itself must be withdrawn");
    assert.equal(readdirSync(root).filter((name) => name.includes("state.lock")).length, 0, "no retired or staging residue may survive release");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("crashing during lock retirement cannot strand an ownerless shared lock", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-retire-"));
  try {
    const lock = path.join(root, "recovery.lock");
    const script = path.join(root, "crash-on-unlink.mjs");
    writeFileSync(script, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const { tryAcquireProcessLock } = await import(${JSON.stringify(new URL("../src/store/process-lock.js", import.meta.url).href)});`,
      `const release = tryAcquireProcessLock(${JSON.stringify(lock)});`,
      'if (!release) process.exit(2);',
      // Exit immediately before deleting owner.json. With unlink-before-rename
      // this leaves the shared lock stranded; retirement keeps it private.
      'fs.unlinkSync = () => process.exit(0);',
      'syncBuiltinESMExports();',
      'release();',
      'process.exit(3);',
    ].join("\n"));
    const crashed = spawnSync(process.execPath, [script], { timeout: 10_000, windowsHide: true });
    assert.equal(crashed.status, 0, crashed.stderr.toString());
    assert.equal(existsSync(lock), false, "complete lock must be withdrawn before owner deletion");
    assert.ok(readdirSync(root).some((name) => name.endsWith(".retired")), "interrupted cleanup stays private");
    const release = tryAcquireProcessLock(lock);
    assert.ok(release, "a new owner can acquire after the crash");
    release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
