// ADR-009 deterministic spawn-generation continuity tests (live-test safety
// gate 1). All cases use fake event state and injected probes — no real
// processes, no signals. They prove the two safety properties the gate
// demanded: (1) continuity is decided by the child's EXIT state, not by the
// later stdio close (Node delivers exit first and libuv releases the native
// handle at exit delivery, so a close flag alone leaves an exit→close window
// in which the PID can be recycled); (2) a fingerprint that arrives after
// the child exited — i.e. possibly describing a recycled generation — is
// discarded and never stored as the spawn identity, and without a stored
// identity the Windows terminator refuses to signal.
import assert from "node:assert/strict";
import test from "node:test";
import { captureSpawnGenerationIdentity, childStillOnSpawnGeneration, type ProcessProbe, type TerminateProcessTree } from "../src/adapters/process-spawn.js";
import { ZCodeAdapter } from "../src/adapters/zcode-adapter.js";
import { FakeSpawn, makeTask, makeWorkspace, stubResolver, successEnvelope, validReport, makeTempDir, removeTempDir } from "./helpers.js";

interface FakeChild {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  exitSeen: boolean;
}

function liveChild(pid = 4_321): FakeChild {
  return { pid, exitCode: null, signalCode: null, exitSeen: false };
}

test("continuity: a child that has not exited is on its original spawn generation", () => {
  assert.equal(childStillOnSpawnGeneration(liveChild()), true);
  assert.equal(childStillOnSpawnGeneration({ ...liveChild(), exitSeen: false }), true);
});

test("continuity: exit evidence ends the provable generation even before any close event", () => {
  // Node delivers 'exit' before stdio 'close': the close flag is still
  // false here, yet the exit already released the native handle.
  assert.equal(childStillOnSpawnGeneration({ ...liveChild(), exitCode: 0 }), false);
  assert.equal(childStillOnSpawnGeneration({ ...liveChild(), signalCode: "SIGTERM" }), false);
  assert.equal(childStillOnSpawnGeneration({ ...liveChild(), exitSeen: true }), false);
  // No pid means no provable object at all.
  assert.equal(childStillOnSpawnGeneration({ pid: undefined, exitCode: null, signalCode: null, exitSeen: false }), false);
});

test("capture: an identity that resolves after the child exited is discarded (recycled generation)", async () => {
  const child = liveChild();
  const probe = {
    // The probe's await straddles the exit: by the time the fingerprint is
    // available, the child has exited — the fingerprint may describe whoever
    // recycled the PID and must never be stored as the spawn identity.
    identityOf: async () => {
      child.exitCode = 0;
      return { fingerprint: "recycled-generation-ticks", fingerprint_precision: "exact" };
    },
  };
  const identity = await captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 1 });
  assert.equal(identity, null, "a post-exit fingerprint is never adopted");
});

test("capture: an exit during the bounded retry discards the second read too", async () => {
  const child = liveChild();
  let reads = 0;
  const probe = {
    identityOf: async () => {
      reads += 1;
      if (reads === 1) return { fingerprint: null };
      return { fingerprint: "late-ticks", fingerprint_precision: "exact" };
    },
  };
  const capture = captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 5 });
  child.exitSeen = true; // exit fires while the retry delay is pending
  assert.equal(await capture, null);
  assert.equal(reads, 1, "the second read never ran after the exit");
});

test("capture: a live child's fingerprint is adopted and returned", async () => {
  const child = liveChild(9_999);
  const probe = { identityOf: async () => ({ fingerprint: "original-ticks", fingerprint_precision: "exact" }) };
  const identity = await captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 1 });
  assert.deepEqual(identity, { pid: 9_999, fingerprint: "original-ticks" });
});

test("capture: a failed first read retries once on a still-live child", async () => {
  const child = liveChild();
  let reads = 0;
  const probe = {
    identityOf: async () => {
      reads += 1;
      return { fingerprint: reads === 1 ? null : "second-read-ticks", fingerprint_precision: "exact" };
    },
  };
  const identity = await captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 1 });
  assert.deepEqual(identity, { pid: child.pid, fingerprint: "second-read-ticks" });
});

test("capture: a throwing or empty probe result never yields an identity", async () => {
  const child = liveChild();
  assert.equal(await captureSpawnGenerationIdentity(child, { identityOf: async () => { throw new Error("query failed"); } }, { retryDelayMs: 1 }), null);
  assert.equal(await captureSpawnGenerationIdentity(child, { identityOf: async () => ({ fingerprint: null }) }, { retryDelayMs: 1 }), null);
  assert.equal(await captureSpawnGenerationIdentity({ pid: undefined, exitCode: null, signalCode: null, exitSeen: false }, { identityOf: async () => ({ fingerprint: "x" }) }, { retryDelayMs: 1 }), null);
});

test("continuity: missing exit state is unknown, never trusted continuity", () => {
  // A fake/legacy child object without exitCode/signalCode cannot prove the
  // generation; unknown fields must fail closed (gate 2: undefined must not
  // be coerced into a trusted null).
  assert.equal(childStillOnSpawnGeneration({ pid: 5, exitCode: undefined, signalCode: undefined, exitSeen: false }), false);
  assert.equal(childStillOnSpawnGeneration({ pid: 5, exitCode: null, signalCode: undefined, exitSeen: false }), false);
  assert.equal(childStillOnSpawnGeneration({ pid: 5, exitCode: undefined, signalCode: null, exitSeen: false }), false);
});

test("capture: a coarse-precision fingerprint is never adopted as a termination identity", async () => {
  const child = liveChild();
  const probe = { identityOf: async () => ({ fingerprint: "coarse-lstart", fingerprint_precision: "coarse" }) };
  assert.equal(await captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 1 }), null);
});
test("capture: close flags are irrelevant to continuity — only exit state decides", async () => {
  // A child whose stdio close flag would say "still open" but whose exit
  // already happened must NOT pass continuity: exit-before-close ordering.
  const child = liveChild();
  assert.equal(childStillOnSpawnGeneration(child), true);
  const probe = {
    identityOf: async () => {
      child.exitCode = 1; // exit delivered; stdio close still pending
      return { fingerprint: "whoever-owns-the-pid-now", fingerprint_precision: "exact" };
    },
  };
  assert.equal(await captureSpawnGenerationIdentity(child, probe, { retryDelayMs: 1 }), null);
  assert.equal(childStillOnSpawnGeneration(child), false);
});

// -- Consumer-level regression: the real adapter call chain (gate 2) --------
//
// Exercises the LEGACY ZCodeAdapter with its fake spawn infrastructure, an
// injected probe, and an injected terminator. This proves the shared capture
// and the exit-based guard are actually wired through the adapter's real
// spawn → identity capture → cancel → terminate path, not only correct in
// isolation. Fake events only; the injected terminator never signals.

interface TerminateRecord { pid: number; expectedRootFingerprint: string | null }

async function waitForSpawn(adapter: ZCodeAdapter, handle: Parameters<ZCodeAdapter["getStatus"]>[0]): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const status = await adapter.getStatus(handle);
    if (status.zcodePid !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the adapter never spawned a child process");
}

function scriptedProbe(behavior: (pid: number) => Promise<{ fingerprint: string | null; fingerprint_precision?: string | null }>): ProcessProbe {
  return {
    platform: process.platform,
    identityOf: behavior as ProcessProbe["identityOf"],
    selfIdentity: behavior.bind(null, process.pid) as ProcessProbe["selfIdentity"],
    probe: async () => [],
  };
}

test("consumer: a live child's exact identity is handed to the terminator through the adapter chain", { timeout: 20_000 }, async () => {
  const fake = new FakeSpawn();
  fake.script.push(() => {
    // The child stays alive until the close emitted in the finally cleanup.
  });
  const terminations: TerminateRecord[] = [];
  const terminate: TerminateProcessTree = async (pid, options) => {
    terminations.push({ pid, expectedRootFingerprint: options?.expectedRootFingerprint ?? null });
    return { pid, signal: "SIGKILL", verified: true };
  };
  const promptDir = await makeTempDir("consumer-identity");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: terminate,
    probe: scriptedProbe(async () => ({ fingerprint: "consumer-exact-ticks", fingerprint_precision: "exact" })),
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\Windows" },
  });
  try {
    const handle = await adapter.startTask({ task: makeTask(), workspace: makeWorkspace(), attempt: 1 });
    await waitForSpawn(adapter, handle);
    await adapter.cancelTask(handle);
    if (process.platform === "win32") {
      assert.equal(terminations.length, 1, "exactly one termination request on Windows");
      assert.equal(terminations[0]!.expectedRootFingerprint, "consumer-exact-ticks", "the captured exact identity is handed to the terminator");
    } else {
      assert.equal(terminations.length, 1, "POSIX keeps its termination behaviour");
      assert.equal(terminations[0]!.expectedRootFingerprint, null, "POSIX does not consume the fingerprint");
    }
    fake.records[0]!.child.emitStdout(successEnvelope(validReport()));
    fake.records[0]!.child.emitClose(0, null);
    await adapter.getResult(handle);
  } finally {
    fake.records[0]?.child.emitClose(0, null);
    await removeTempDir(promptDir);
  }
});

test("consumer: an identity that raced the child's exit is never handed over (null expected, refused in production)", { timeout: 20_000 }, async () => {
  const fake = new FakeSpawn();
  fake.script.push(() => {
    // Alive until the cancel below.
  });
  const terminations: TerminateRecord[] = [];
  const terminate: TerminateProcessTree = async (pid, options) => {
    terminations.push({ pid, expectedRootFingerprint: options?.expectedRootFingerprint ?? null });
    return { pid, signal: "SIGKILL", verified: true };
  };
  const promptDir = await makeTempDir("consumer-race");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: terminate,
    probe: scriptedProbe(async () => {
      // The probe's await straddles the child's exit: the fingerprint that
      // comes back may describe a recycled PID generation.
      fake.records[0]!.child.emitExit(0, null);
      return { fingerprint: "recycled-generation-ticks", fingerprint_precision: "exact" };
    }),
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\Windows" },
  });
  try {
    const handle = await adapter.startTask({ task: makeTask(), workspace: makeWorkspace(), attempt: 1 });
    await waitForSpawn(adapter, handle);
    // Give the capture's retry path a moment to observe the exit, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await adapter.cancelTask(handle).catch(() => undefined);
    fake.records[0]!.child.emitClose(0, null);
    await adapter.getResult(handle).catch(() => undefined);
    for (const record of terminations) {
      assert.notEqual(record.expectedRootFingerprint, "recycled-generation-ticks", "a raced post-exit fingerprint is never handed to the terminator");
    }
  } finally {
    fake.records[0]?.child.emitClose(0, null);
    await removeTempDir(promptDir);
  }
});

test("consumer: an already-exited child is never terminated (exit ends the provable generation)", { timeout: 20_000 }, async () => {
  const fake = new FakeSpawn();
  fake.script.push((child) => {
    child.emitExit(0, null);
    child.emitClose(0, null);
  });
  const terminations: TerminateRecord[] = [];
  const terminate: TerminateProcessTree = async (pid, options) => {
    terminations.push({ pid, expectedRootFingerprint: options?.expectedRootFingerprint ?? null });
    return { pid, signal: "SIGKILL", verified: true };
  };
  const promptDir = await makeTempDir("consumer-exited");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: terminate,
    probe: scriptedProbe(async () => ({ fingerprint: "late-ticks", fingerprint_precision: "exact" })),
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\Windows" },
  });
  try {
    const handle = await adapter.startTask({ task: makeTask(), workspace: makeWorkspace(), attempt: 1 });
    await adapter.getResult(handle).catch(() => undefined);
    if (process.platform === "win32") {
      assert.deepEqual(terminations, [], "an exited child's PID is never signalled on Windows");
    }
  } finally {
    await removeTempDir(promptDir);
  }
});
