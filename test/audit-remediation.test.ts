import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { runWorkerTask } from "../src/worker/run-task.js";
import { loadPersistedRuntimeEnvironment } from "../src/runtime/resolver.js";
import { buildContinuePrompt, buildTaskPrompt } from "../src/prompts/task-prompt.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import { FakeAdapter, fakeOutcome, makeManagerFixture } from "./manager-helpers.js";
import { withProcessLock } from "../src/store/process-lock.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { TaskStore } from "../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";
import type { ProcessIdentity, ProcessProbe, ProbeRequest, ProbeVerdict } from "../src/runtime/process-probe.js";
import type { TerminateProcessTree } from "../src/adapters/process-spawn.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
const workerUrl = new URL("../src/worker/run-task.js", import.meta.url).href;
const managerUrl = new URL("../src/manager/task-manager.js", import.meta.url).href;
const providerUrl = new URL("../src/workspace/direct-provider.js", import.meta.url).href;

test("cooperative cancellation waits for the verified worker result without a second termination", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    const finish = async () => {
      // Coordinate on the manager's persisted intent instead of a fixed
      // delay. What was observed in the Linux24 full-suite failure is only
      // the stale/terminal rejection at 104ms TAP duration; a delayed
      // delivery is one possible mechanism (demonstrated by the 600ms
      // diagnostic probe), not the proven original cause. Coordinating on
      // the cancel_requested record keeps the worker commit causally after
      // the manager's intent within this test's bounded timeout; the 5ms
      // poll is evented coordination, not a timing guarantee about the
      // manager's 500ms real-time window.
      const deadline = Date.now() + 5_000;
      while (fx.store.readStatus("task_1").cancel_requested !== true && Date.now() < deadline) await delay(5);
      assert.equal(fx.store.readStatus("task_1").cancel_requested, true, "the manager must record its cancellation intent before the worker result can be waited for");
      const result = buildTaskResult({ task: fx.makeTask(), attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: null, cancelled: true, sessionId: "cooperative-session" });
      fx.store.commitWorkerResult("task_1", 1, result, { status: "cancelled", worker_pid: null, zcode_pid: null });
      fx.pidsAlive.delete(pid);
    };
    const finishing = finish();
    assert.equal((await fx.manager.cancelTask("task_1")).status, "cancelled");
    await finishing;
    assert.deepEqual(fx.terminateCalls, []);
    assert.equal((await fx.manager.getResult("task_1")).session_id, "cooperative-session");
  } finally { await fx.cleanup(); }
});

test("a worker result arriving after the manager's verified cancellation is stale and cannot replace it", async () => {
  // Boundary pin for the same fixture family. A fixed timer cannot place the
  // worker commit after the manager's terminal result (Codex counterexample:
  // scheduling 600ms before cancelTask still landed inside the 500ms window
  // when cancellation started 188ms later). Instead the manager's verified
  // cancellation is awaited to completion first, and only then is the worker-
  // side commit attempted — deterministically stale by contract: rejected,
  // exactly one termination, no second one, and the manager's result stands.
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    const workerPidKeptAlive = () => fx.pidsAlive.has(pid);
    assert.equal(workerPidKeptAlive(), true, "the fake worker starts alive so the manager must go through its cooperative-then-terminate path");
    assert.equal((await fx.manager.cancelTask("task_1")).status, "cancelled");
    assert.deepEqual(fx.terminateCalls, [pid], "the worker outlived the cooperative window fixture-side, so exactly one verified termination happened");
    assert.equal(fx.pidsAlive.has(pid), false, "the terminated worker is no longer considered alive");
    // The worker-side commit happens strictly AFTER the manager's terminal
    // result; it must be rejected as stale and never replace that result.
    const result = buildTaskResult({ task: fx.makeTask(), attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: null, cancelled: true, sessionId: "late-session" });
    assert.throws(() => fx.store.commitWorkerResult("task_1", 1, result, { status: "cancelled", worker_pid: null, zcode_pid: null }), /stale or terminal worker attempt rejected/);
    assert.equal((await fx.manager.getResult("task_1")).session_id, null, "the manager's verified cancellation result stands over the late worker commit");
    assert.deepEqual(fx.terminateCalls, [pid], "no second termination was issued");
  } finally { await fx.cleanup(); }
});

test("a taskkill exit race requires a verified terminal result and dead recorded processes", async () => {
  for (const cleanupFailed of [false, true]) {
    const fx = await makeManagerFixture();
    let manager: BridgeTaskManager | undefined;
    try {
      await fx.manager.createTask(fx.makeTask());
      const pid = fx.spawned[0]!.pid;
      let finishing: Promise<void> | undefined;
      manager = new BridgeTaskManager({ store: fx.store, workspaceProvider: new DirectWorkspaceProvider(), pollIntervalMs: 0, isProcessRunning: (p) => fx.pidsAlive.has(p),
        terminateProcessTree: async () => {
          finishing = (async () => {
            await delay(30);
            const result = buildTaskResult({ task: fx.makeTask(), attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: null, cancelled: !cleanupFailed,
              ...(cleanupFailed ? { failure: { code: "cleanup_failed", message: "runtime still live" } } : {}) });
            fx.store.commitWorkerResult("task_1", 1, result, { status: result.status, worker_pid: null, cleanup_unverified: cleanupFailed, zcode_pid: cleanupFailed ? 4444 : null });
            fx.pidsAlive.delete(pid);
            if (cleanupFailed) fx.pidsAlive.add(4444);
          })();
          throw new Error("taskkill raced process exit");
        } });
      // ADR-009: a termination failure propagates regardless of the worker
      // result arriving meanwhile — root exit never replaces verified tree
      // cleanup, so both variants keep occupancy (the RED-C swallow shape).
      await assert.rejects(manager.cancelTask("task_1"), /could not be verified/);
      assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
      assert.equal(fx.store.readStatus("task_1").status, "running");
      await finishing;
    } finally { manager?.dispose(); await fx.cleanup(); }
  }
});

// ---- A2-04: the Windows cleanup race between the cancel identity probe and taskkill ----

/** Scriptable identity probe: one verdict answer per pid, alive by default. */
class ScriptedProbe {
  readonly answers = new Map<number, { state: ProbeVerdict["state"]; reason_code: string }>();

  identityOf(pid: number): Promise<ProcessIdentity> {
    return Promise.resolve({
      pid,
      fingerprint: `fp-${String(pid)}`,
      fingerprint_precision: "exact",
      identity_version: 1,
      platform: process.platform,
      captured_at: new Date().toISOString(),
    });
  }

  selfIdentity(): Promise<ProcessIdentity> {
    return this.identityOf(process.pid);
  }

  async probe(requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> {
    return requests.map((request) => {
      const answer = this.answers.get(request.pid);
      return {
        state: answer?.state ?? "alive",
        reason_code: answer?.reason_code ?? "scripted_alive",
        observed_at: new Date().toISOString(),
      };
    });
  }

  set(pid: number, state: ProbeVerdict["state"], reason: string): void {
    this.answers.set(pid, { state, reason_code: reason });
  }
}

interface CleanupRaceFixture {
  store: TaskStore;
  manager: BridgeTaskManager;
  probe: ScriptedProbe;
  pidsAlive: Set<number>;
  terminateCalls: number[];
  workerPid: number;
  runtimePid: number;
  workspaceDir: string;
  setTerminate: (impl: TerminateProcessTree) => void;
  /** Recorded-tree claimant scans requested by the manager (ADR-009). */
  scanCalls: Array<Array<{ pid: number; fingerprint: string | null }>>;
  setScanResult: (result: { clean: boolean; livePids: readonly number[] } | Error) => void;
  dispose: () => Promise<void>;
}

/** Seeds the field incident (audit-remediation-20261005-zcode-worktree): a
 * running task holds cleanup_unverified with worker pid 22696 and runtime pid
 * 26188 recorded, both identities persisted, and both probed alive. */
async function makeCleanupRaceFixture(options: { persistIdentity?: boolean } = {}): Promise<CleanupRaceFixture> {
  const dataRoot = await makeTempDir("a204-race");
  const workspaceDir = await makeTempDir("a204-race-ws");
  const store = new TaskStore(dataRoot);
  const probe = new ScriptedProbe();
  const pidsAlive = new Set<number>();
  const terminateCalls: number[] = [];
  const scanCalls: Array<Array<{ pid: number; fingerprint: string | null }>> = [];
  const workerPid = 22696;
  const runtimePid = 26188;
  let scanResult: { clean: boolean; livePids: readonly number[] } | Error = { clean: true, livePids: [] };
  let terminateImpl: TerminateProcessTree = async () => {
    throw new Error("the test must install a terminate script before cancelling");
  };
  const verifyTreeClean = async (targets: readonly { pid: number; fingerprint: string | null }[]) => {
    scanCalls.push([...targets]);
    if (scanResult instanceof Error) throw scanResult;
    return scanResult;
  };
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    spawnWorker: () => {
      pidsAlive.add(workerPid);
      return { pid: workerPid };
    },
    isProcessRunning: (pid) => pidsAlive.has(pid),
    terminateProcessTree: (pid, options) => {
      terminateCalls.push(pid);
      return terminateImpl(pid, options);
    },
    verifyTreeClean,
    probe: probe as unknown as ProcessProbe,
    pollIntervalMs: 0,
  });
  try {
    await manager.createTask(makeTask({ workspace: workspaceDir }));
  } catch (error) {
    manager.dispose();
    await removeTempDir(dataRoot);
    await removeTempDir(workspaceDir);
    throw error;
  }
  store.writeStatus("task_1", { cleanup_unverified: true, zcode_pid: runtimePid });
  if (options.persistIdentity !== false) {
    store.writeExecutorIdentity("task_1", 1, {
      worker: (await probe.identityOf(workerPid)) as unknown as Record<string, unknown>,
      runtime: (await probe.identityOf(runtimePid)) as unknown as Record<string, unknown>,
    });
  }
  pidsAlive.add(runtimePid);
  return {
    store,
    manager,
    probe,
    pidsAlive,
    terminateCalls,
    workerPid,
    runtimePid,
    workspaceDir,
    setTerminate: (impl) => { terminateImpl = impl; },
    scanCalls,
    setScanResult: (result) => { scanResult = result; },
    dispose: async () => {
      manager.dispose();
      await removeTempDir(dataRoot);
      await removeTempDir(workspaceDir);
    },
  };
}

test("a termination failure stays occupied; a later cancel releases only after probes AND the recorded-tree scan", async () => {
  const fx = await makeCleanupRaceFixture();
  try {
    // Both recorded processes exit naturally while the terminator is in
    // flight and it reports failure. ADR-009: the failure is never cleared
    // by executor-only exit evidence — the first cancel keeps occupancy.
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "exited", "pid_absent");
      fx.probe.set(fx.workerPid, "exited", "pid_absent");
      fx.pidsAlive.delete(pid);
      fx.pidsAlive.delete(fx.workerPid);
      throw new Error(`taskkill: 没有找到进程 ${String(pid)}。`);
    });
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    let persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running", "the tree failure keeps the task occupied");
    assert.equal(persisted.cleanup_unverified, true);
    // The retry sees both executors conclusively exited; nothing is
    // signalled again, and the release is gated by the read-only claimant
    // scan over the recorded pids.
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "cancelled");
    persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.cleanup_unverified ?? false, false, "the scan-gated release clears the flag");
    assert.equal(persisted.zcode_pid, null);
    assert.deepEqual(fx.terminateCalls, [fx.runtimePid], "only the alive-at-probe runtime was ever signalled; the exited retry probes and scans instead");
    assert.equal(fx.scanCalls.length, 1, "the retry release consulted the recorded-tree scan once");
    assert.ok(fx.scanCalls[0]!.some((t) => t.pid === fx.runtimePid), "the recorded runtime pid is scanned");
    assert.equal((await fx.manager.getResult("task_1")).status, "cancelled");
  } finally { await fx.dispose(); }
});

test("legacy cleanup without executor identities releases through the same scan gate", async () => {
  const fx = await makeCleanupRaceFixture({ persistIdentity: false });
  try {
    assert.equal(fx.store.readExecutorIdentity("task_1", 1), null);
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "exited", "pid_absent");
      fx.probe.set(fx.workerPid, "exited", "pid_absent");
      fx.pidsAlive.delete(pid);
      fx.pidsAlive.delete(fx.workerPid);
      throw new Error(`taskkill: 没有找到进程 ${String(pid)}。`);
    });
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "cancelled");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified ?? false, false);
    assert.equal(fx.store.readStatus("task_1").zcode_pid, null);
    assert.equal(fx.scanCalls.length, 1);
  } finally { await fx.dispose(); }
});

test("a scan that still observes live claimants keeps the retry occupied", async () => {
  const fx = await makeCleanupRaceFixture();
  try {
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "exited", "pid_absent");
      fx.probe.set(fx.workerPid, "exited", "pid_absent");
      fx.pidsAlive.delete(pid);
      fx.pidsAlive.delete(fx.workerPid);
      throw new Error("terminator failed");
    });
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    fx.setTerminate(async () => { throw new Error("unreachable: nothing is alive to terminate"); });
    fx.setScanResult({ clean: false, livePids: [31_337] });
    await assert.rejects(fx.manager.cancelTask("task_1"), /still alive/);
    const persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.cleanup_unverified, true);
    fx.setScanResult({ clean: true, livePids: [] });
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "cancelled");
  } finally { await fx.dispose(); }
});

test("legacy cleanup without executor identities stays occupied when the probe cannot verify exit", async () => {
  const fx = await makeCleanupRaceFixture({ persistIdentity: false });
  try {
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "unknown", "query_timeout");
      throw new Error(`taskkill: 没有找到进程 ${String(pid)}。`);
    });
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    const persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.cleanup_unverified, true);
    assert.equal(persisted.zcode_pid, fx.runtimePid);
    await fx.manager.createTask(makeTask({ task_id: "later", workspace: fx.workspaceDir }));
    assert.equal((await fx.manager.getStatus("later")).status, "queued");
  } finally { await fx.dispose(); }
});

test("a cleanup race recheck that answers unknown keeps cleanup_unverified and the occupation", async () => {
  const fx = await makeCleanupRaceFixture();
  try {
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "unknown", "query_timeout");
      fx.probe.set(fx.workerPid, "exited", "pid_absent");
      throw new Error(`taskkill: 没有找到进程 ${String(pid)}。`);
    });
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    const persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.cleanup_unverified, true);
    assert.equal(persisted.zcode_pid, fx.runtimePid);
    assert.deepEqual(fx.terminateCalls, [fx.runtimePid]);
  } finally { await fx.dispose(); }
});

test("a cleanup race recheck that answers alive keeps cleanup_unverified and reserves the directory", async () => {
  const fx = await makeCleanupRaceFixture();
  try {
    // taskkill fails for a reason other than a natural exit (access denied)
    // and the runtime is still there on re-verification.
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "alive", "pid_and_fingerprint_match");
      throw new Error("taskkill: 拒绝访问。");
    });
    await fx.manager.createTask(makeTask({ task_id: "later", workspace: fx.workspaceDir }));
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    const persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.cleanup_unverified, true);
    assert.equal(persisted.zcode_pid, fx.runtimePid);
    assert.equal((await fx.manager.getStatus("later")).status, "queued", "the execution directory stays reserved");
  } finally { await fx.dispose(); }
});

test("a cleanup race that proves only the runtime exited keeps the occupation while the worker is alive", async () => {
  const fx = await makeCleanupRaceFixture();
  try {
    fx.setTerminate(async (pid) => {
      fx.probe.set(pid, "exited", "pid_absent");
      fx.probe.set(fx.workerPid, "alive", "pid_and_fingerprint_match");
      throw new Error(`taskkill: 没有找到进程 ${String(pid)}。`);
    });
    // ADR-009: the terminate failure itself propagates; the worker-alive
    // evidence only keeps occupancy (it never clears a known failure).
    await assert.rejects(fx.manager.cancelTask("task_1"), /could not be verified/);
    const persisted = fx.store.readStatus("task_1");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.cleanup_unverified, true);
    assert.deepEqual(fx.terminateCalls, [fx.runtimePid], "a probe-alive worker pid is only ever signalled by an explicit terminate step");
  } finally { await fx.dispose(); }
});

function childScript(source: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("two real workers can enter an attempt only once; terminal and stale attempts never execute", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const calls = path.join(fx.dataRoot, "calls.jsonl");
    const source = `import {runWorkerTask} from ${JSON.stringify(workerUrl)}; import {appendFileSync} from 'node:fs';
      const adapter = { startTask: async x => { appendFileSync(${JSON.stringify(calls)}, JSON.stringify(x.attempt)+'\\n'); return {}; }, getResult: async () => { await new Promise(r=>setTimeout(r,200)); return ${JSON.stringify(fakeOutcome())}; } };
      try { await runWorkerTask({dataRoot:${JSON.stringify(fx.dataRoot)},taskId:'task_1',attempt:1,adapter}); } catch(e) { if (!/claimed|stale|terminal/.test(String(e))) throw e; }`;
    const outcomes = await Promise.all([childScript(source), childScript(source)]);
    for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    const adapter = new FakeAdapter();
    await assert.rejects(runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter }), /claimed|terminal/);
    fx.store.writeStatus("task_1", { status: "queued", attempt: 2 });
    await assert.rejects(runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter }), /stale/);
    assert.equal(adapter.calls.length, 0);
    assert.throws(() => fx.store.writeResult("task_1", { ...fx.store.readArchivedResult("task_1", 1)!, attempt: 1 }), /stale/);
  } finally { await fx.cleanup(); }
});

test("separate manager processes serialize submissions sharing an execution directory", async () => {
  const fx = await makeManagerFixture();
  try {
    const calls = path.join(fx.dataRoot, "spawns.jsonl");
    const source = (taskId: string) => `import {TaskStore} from ${JSON.stringify(storeUrl)}; import {BridgeTaskManager} from ${JSON.stringify(managerUrl)}; import {DirectWorkspaceProvider} from ${JSON.stringify(providerUrl)}; import {appendFileSync} from 'node:fs';
      const manager=new BridgeTaskManager({store:new TaskStore(${JSON.stringify(fx.dataRoot)}),workspaceProvider:new DirectWorkspaceProvider(),pollIntervalMs:0,isProcessRunning:()=>true,spawnWorker:()=>{appendFileSync(${JSON.stringify(calls)},'spawn\\n');return {pid:process.pid};}});
      await manager.createTask(${JSON.stringify(fx.makeTask({ task_id: taskId }))}); manager.dispose();`;
    const outcomes = await Promise.all([childScript(source("one")), childScript(source("two"))]);
    for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    assert.deepEqual([fx.store.readStatus("one").status, fx.store.readStatus("two").status].sort(), ["queued", "running"]);
  } finally { await fx.cleanup(); }
});

test("interaction answers are attempt-scoped and parameter collisions are refused", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const request = { request_id: "rpc-1", method: "interaction/requestPermission" as const, params: { sessionId: "session-one", input: { command: "safe" } } };
    fx.store.writeInteractionRequest("task_1", request);
    fx.store.answerInteractionRequest("task_1", "rpc-1", { decision: "allow" });
    assert.throws(() => fx.store.writeInteractionRequest("task_1", { ...request, params: { sessionId: "other" } }), /collision/);
    fx.store.writeStatus("task_1", { attempt: 2 });
    assert.equal(fx.store.readInteractionRequest("task_1", "rpc-1"), null);
    const next = fx.store.writeInteractionRequest("task_1", { ...request, params: { input: { command: "different" } } });
    assert.equal(next.created, true);
    assert.equal(next.record.state, "pending");
    assert.equal(next.record.answer, undefined);
  } finally { await fx.cleanup(); }
});

test("invalid existing runtime settings fail closed while missing settings permit discovery", async () => {
  const fx = await makeManagerFixture();
  try {
    const host = { name: "test-host", settingsDirectory: path.join(fx.dataRoot, "settings") };
    assert.equal(loadPersistedRuntimeEnvironment({ ZCODE_BRIDGE_MODE: "build" }, fx.dataRoot, host).ZCODE_BRIDGE_MODE, "build");
    mkdirSync(host.settingsDirectory);
    for (const invalid of ["{broken", "[]", JSON.stringify({ ZCODE_BRIDGE_MODE: 42 }), " ".repeat(65_537)]) {
      writeFileSync(path.join(host.settingsDirectory, "runtime-config.json"), invalid);
      assert.throws(() => loadPersistedRuntimeEnvironment({}, fx.dataRoot, host), /runtime setting|runtime settings/);
    }
  } finally { await fx.cleanup(); }
});

test("oversized constraints are rejected before accepting a task or continuation", async () => {
  const fx = await makeManagerFixture();
  try {
    const task = fx.makeTask({ requirements: ["r".repeat(65_000)], forbidden_paths: ["never-touch"] });
    assert.throws(() => buildTaskPrompt(task), /exceeds/);
    await assert.rejects(fx.manager.createTask(task), /exceeds/);
    assert.equal(fx.store.hasTask("task_1"), false);
    assert.throws(() => buildContinuePrompt({ task: fx.makeTask(), feedback: "f".repeat(65_000), additionalRequirements: [], previousSessionId: null, previousResult: null }), /exceeds/);
  } finally { await fx.cleanup(); }
});

test("corrupt status is isolated and does not block a healthy unrelated task", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask({ task_id: "corrupt" }), new Date().toISOString());
    writeFileSync(path.join(fx.store.taskDir("corrupt"), "status.json"), "{invalid");
    await fx.manager.createTask(fx.makeTask({ task_id: "healthy", workspace: fx.dataRoot }));
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("healthy")).status, "running");
    await assert.rejects(fx.manager.getStatus("corrupt"), /JSON/);
  } finally { await fx.cleanup(); }
});

test("continuation preparation survives interruption and old results cannot finish new attempts", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    const original = await fx.manager.getResult("task_1");
    fx.store.archiveResultToAttempt("task_1", 1);
    await fx.manager.recoverTasks();
    assert.deepEqual(await fx.manager.getResult("task_1"), original);
    fx.store.writeStatus("task_1", { status: "queued", attempt: 2 });
    assert.equal(fx.store.readResult("task_1"), null);
  } finally { await fx.cleanup(); }
});

test("runtime cancellation normalizes to cancelled without an invalid-report failure", () => {
  const result = buildTaskResult({ task: { task_id: "cancelled" } as never, attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: { ...fakeOutcome("adapterFailed"), cancelled: true, errorCode: "cancelled" } });
  assert.equal(result.status, "cancelled");
  assert.equal(result.needs_master_decision, false);
});

test("a known session survives adapter failure and is supplied to continuation", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const adapter = new FakeAdapter();
    adapter.getResult = async () => { fx.store.writeStatus("task_1", { zcode_session_id: "known-session" }); throw new Error("turn failed"); };
    await fx.runWorker("task_1", adapter);
    assert.equal((await fx.manager.getResult("task_1")).session_id, "known-session");
    await fx.manager.continueTask({ task_id: "task_1", feedback: "retry safely" });
    assert.equal(fx.store.readAttemptMeta("task_1", 2, "continue.json")?.previous_session_id, "known-session");
  } finally { await fx.cleanup(); }
});

test("cleanup failure reserves the execution path until termination is verified", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    fx.store.writeStatus("task_1", { cleanup_unverified: true, zcode_pid: 4444 });
    await fx.manager.createTask(fx.makeTask({ task_id: "later" }));
    assert.equal((await fx.manager.getStatus("later")).status, "queued");
    await assert.rejects(fx.manager.continueTask({ task_id: "task_1", feedback: "retry" }), /cleanup/);
    // A live orphaned runtime must be terminated and verified: a failed
    // termination keeps the unverified state and the reserved execution path.
    fx.pidsAlive.add(4444);
    fx.setTerminateError(new Error("kill failed"));
    await assert.rejects(fx.manager.cancelTask("task_1"), /cleanup/);
    assert.equal((await fx.manager.getStatus("later")).status, "queued");
    fx.setTerminateError(null);
    await fx.manager.cancelTask("task_1");
    assert.equal((await fx.manager.getStatus("later")).status, "running");
  } finally { await fx.cleanup(); }
});

test("an already-exited runtime makes cleanup verification idempotent without a kill", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    // The runtime pid is gone, but its exit was never verified in-band.
    fx.store.writeStatus("task_1", { cleanup_unverified: true, zcode_pid: 4444 });
    await assert.doesNotReject(fx.manager.cancelTask("task_1"));
    assert.equal(fx.terminateCalls.length, 0, "a probe-confirmed exit must not be signalled again");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified ?? false, false);
  } finally { await fx.cleanup(); }
});

test("process lock protects asynchronous sections across manager instances", async () => {
  const fx = await makeManagerFixture();
  try {
    const events: string[] = [];
    const lock = path.join(fx.dataRoot, "test.lock");
    await Promise.all([1, 2].map((id) => withProcessLock(lock, async () => { events.push(`begin${id}`); await delay(50); events.push(`end${id}`); })));
    assert.deepEqual(events, ["begin1", "end1", "begin2", "end2"]);
  } finally { await fx.cleanup(); }
});

test("cancelling an orphaned live runtime reaches a terminal state before releasing queued work", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.store.writeStatus("task_1", { zcode_pid: 4444, zcode_session_id: "orphan-session" });
    fx.pidsAlive.delete(fx.spawned[0]!.pid);
    fx.pidsAlive.add(4444);
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "running");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    await fx.manager.createTask(fx.makeTask({ task_id: "later" }));
    const result = await fx.manager.cancelTask("task_1");
    assert.equal(result.status, "cancelled");
    assert.equal((await fx.manager.getResult("task_1")).session_id, "orphan-session");
    assert.equal((await fx.manager.getStatus("later")).status, "running");
    assert.deepEqual(fx.terminateCalls, [4444]);
  } finally { await fx.cleanup(); }
});

test("a worker already in flight cannot overwrite a later attempt", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = new FakeAdapter();
    adapter.getResult = async () => { await waiting; return fakeOutcome(); };
    const run = runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter });
    await delay(20);
    fx.store.writeStatus("task_1", { status: "running", attempt: 2, worker_pid: 2222 });
    finish();
    await assert.rejects(run, /stale/);
    assert.equal(fx.store.readResult("task_1"), null);
    assert.equal(fx.store.readStatus("task_1").worker_pid, 2222);
  } finally { await fx.cleanup(); }
});

test("event append reads only a tail byte and paged Unicode events remain complete", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {TaskStore} from ${JSON.stringify(storeUrl)};
      let fullReads=0;const original=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).endsWith('events.jsonl'))fullReads++;return original.call(this,file,...args);};syncBuiltinESMExports();
      const store=new TaskStore(${JSON.stringify(fx.dataRoot)});for(let i=0;i<250;i++)store.appendEvent('task_1','model_output','文字🙂'.repeat(200));console.log(fullReads);`;
    const result = await childScript(source);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output.trim(), "0");
    let cursor = 0;
    const sequences: number[] = [];
    while (true) {
      const page = fx.store.readEvents("task_1", cursor, 37);
      for (const event of page.events) { assert.equal(event.summary, "文字🙂".repeat(200)); sequences.push(event.seq); }
      cursor = page.nextSeq;
      if (!page.hasMore) break;
    }
    assert.deepEqual(sequences, Array.from({ length: 250 }, (_, index) => index + 1));
  } finally { await fx.cleanup(); }
});
