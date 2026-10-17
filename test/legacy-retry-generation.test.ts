// Review-round-2 C1 regressions: the legacy adapter REUSES its RunEntry
// across retry generations. Every spawn-local field must reset per
// generation so a closed first generation can neither short-circuit the
// second generation's termination nor leak its identity. Fake spawns and an
// injected terminator only — zero OS signals.
import assert from "node:assert/strict";
import test from "node:test";
import { ZCodeAdapter } from "../src/adapters/zcode-adapter.js";
import type { ProcessProbe } from "../src/adapters/process-spawn.js";
import { FakeSpawn, TRANSIENT_STDERR, makeTask, makeWorkspace, makeTempDir, removeTempDir, stubResolver } from "./helpers.js";

/** Full-shape fake probe: exact per-pid fingerprints, identity_version and
 * captured_at included, so the ProcessProbe contract is honestly satisfied. */
function generationProbe(behavior: (pid: number) => Promise<{ fingerprint: string | null }>): ProcessProbe {
  const identityOf = async (pid: number) => {
    const answer = await behavior(pid);
    return {
      pid,
      fingerprint: answer.fingerprint,
      fingerprint_precision: "exact" as const,
      identity_version: 1 as const,
      platform: process.platform,
      captured_at: new Date().toISOString(),
    };
  };
  return {
    platform: process.platform,
    identityOf,
    selfIdentity: () => identityOf(process.pid),
    probe: async () => [],
  };
}

test("C1: after a transient first generation, cancelling the live second generation really terminates it with its own identity", { timeout: 20_000 }, async () => {
  const fake = new FakeSpawn();
  const terminations: Array<{ pid: number; expectedRootFingerprint: string | null }> = [];
  const probe = generationProbe(async (pid) => ({ fingerprint: `exact-${String(pid)}` }));
  const promptDir = await makeTempDir("legacy-retry-cancel");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: async (pid, options) => {
      terminations.push({ pid, expectedRootFingerprint: options?.expectedRootFingerprint ?? null });
      return { pid, signal: "SIGKILL", verified: true };
    },
    probe,
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\\Windows" },
    retryBackoffMs: 1,
    timeoutMs: 60_000,
  });
  try {
    // Generation 1 dies with the known transient error; the retry policy
    // spawns generation 2, which stays alive.
    fake.script.push((child) => {
      child.emitStderr(TRANSIENT_STDERR);
      child.emitClose(1, null);
    });
    fake.script.push(() => {
      // Generation 2 keeps running until cancelled.
    });
    const handle = await adapter.startTask({ task: makeTask(), workspace: makeWorkspace(), attempt: 1 });
    for (let index = 0; index < 400 && fake.records.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.records.length, 2, "the retry policy spawned a second generation");
    await new Promise((resolve) => setTimeout(resolve, 30)); // let captures settle
    await adapter.cancelTask(handle);
    const second = fake.records[1]!.child;
    assert.equal(terminations.length, 1, "exactly one termination — against the live generation");
    assert.equal(terminations[0]!.pid, second.pid, "the SECOND generation is terminated");
    if (process.platform === "win32") {
      assert.equal(terminations[0]!.expectedRootFingerprint, `exact-${String(second.pid)}`, "the termination carries the second generation's exact identity");
    }
    fake.records[1]!.child.emitStdout(JSON.stringify({}));
    fake.records[1]!.child.emitClose(0, null);
    await adapter.getResult(handle).catch(() => undefined);
  } finally {
    for (const record of fake.records) record.child.emitClose(0, null);
    await removeTempDir(promptDir);
  }
});

test("C1: a late identity capture from generation 1 never overwrites generation 2's identity", { timeout: 20_000 }, async () => {
  const fake = new FakeSpawn();
  const terminations: Array<{ pid: number; expectedRootFingerprint: string | null }> = [];
  let identityOfCalls = 0;
  // Generation 1's first read fails (null) so its capture enters the 250 ms
  // retry window; the delayed second read resolves AFTER generation 2 has
  // spawned and captured its own identity.
  const probe = generationProbe(async (pid) => {
    identityOfCalls += 1;
    if (pid === fake.records[0]?.child.pid && identityOfCalls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { fingerprint: null };
    }
    return { fingerprint: `exact-${String(pid)}` };
  });
  const promptDir = await makeTempDir("legacy-retry-stale");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: async (pid, options) => {
      terminations.push({ pid, expectedRootFingerprint: options?.expectedRootFingerprint ?? null });
      return { pid, signal: "SIGKILL", verified: true };
    },
    probe,
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\\Windows" },
    retryBackoffMs: 1,
    timeoutMs: 60_000,
  });
  try {
    fake.script.push((child) => {
      child.emitStderr(TRANSIENT_STDERR);
      child.emitClose(1, null);
    });
    fake.script.push(() => {
      // Generation 2 stays alive.
    });
    const handle = await adapter.startTask({ task: makeTask(), workspace: makeWorkspace(), attempt: 1 });
    for (let index = 0; index < 400 && fake.records.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.records.length, 2, "generation 2 spawned");
    // Wait long enough that generation 1's delayed capture has resolved.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await adapter.cancelTask(handle);
    const second = fake.records[1]!.child;
    assert.equal(terminations.length, 1);
    assert.equal(terminations[0]!.pid, second.pid);
    if (process.platform === "win32") {
      assert.equal(terminations[0]!.expectedRootFingerprint, `exact-${String(second.pid)}`, "generation 2's identity survived generation 1's late capture");
    }
    fake.records[1]!.child.emitClose(0, null);
    await adapter.getResult(handle).catch(() => undefined);
  } finally {
    for (const record of fake.records) record.child.emitClose(0, null);
    await removeTempDir(promptDir);
  }
});
