import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { TaskStore } from "../src/store/task-store.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { captureSpawnGenerationIdentity, createPlatformProbe, terminateProcessTree } from "../src/adapters/process-spawn.js";
import { ZCodeModelSettings } from "../src/runtime/model-settings.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { makeTask, makeWorkspace } from "./helpers.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const workerEntry = fileURLToPath(new URL("../src/worker/worker-main.js", import.meta.url));

test("replayed, foreign-session and foreign-turn events cannot complete a run; usage is projected", async () => {
  const fixture = await runtimeFixture({ replay: true });
  try {
    const events: unknown[] = [];
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000, onEvent: (event) => events.push(event) });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.agentReport?.summary, "Created the requested file");
    assert.deepEqual(result.usage, { totalTokens: 9 });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  } finally { await fixture.cleanup(); }
});

test("interaction timeout aborts the resolver rather than leaving a pending polling loop", async () => {
  const fixture = await runtimeFixture({ interaction: true });
  try {
    let ended = false;
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000,
      resolveInteraction: async (_request, signal) => { while (!signal.aborted) await delay(10); ended = true; return { decision: "deny" }; } });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), /budget/);
    await delay(50);
    assert.equal(ended, true);
  } finally { await fixture.cleanup(); }
});

test("raw runtime failure messages never enter public progress", async () => {
  const fixture = await runtimeFixture({ fail: true });
  try {
    const events: unknown[] = [];
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000, onEvent: (event) => events.push(event) });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), /turn failed/);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RUNTIME_ERROR/);
  } finally { await fixture.cleanup(); }
});

test("five-hour quota failure reaches the worker result, status and events with a stop instruction", async () => {
  const fixture = await runtimeFixture({ failure: {
    type: "MODEL_RATE_LIMITED", message: "Model request failed", code: "1308",
    attribution: { providerId: "account:bigmodel-individual-coding-plan", providerErrorCode: "1308" },
    underlyingErrorDetail: "PRIVATE_PROVIDER_DETAIL",
  } });
  try {
    const store = new TaskStore(fixture.root);
    store.createTask(makeTask({ workspace: fixture.root }), new Date().toISOString());
    const envBefore = { ...process.env };
    Object.assign(process.env, fixture.env);
    try { await runWorkerTask({ dataRoot: fixture.root, taskId: "task_1", attempt: 1, host: fixture.host }); }
    finally { for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]; Object.assign(process.env, envBefore); }
    const result = store.readResult("task_1");
    const status = store.readStatus("task_1");
    const events = store.readEvents("task_1", 0, 200).events;
    assert.equal(result?.status, "failed");
    assert.equal(result.error_code, "zcode_usage_exhausted");
    assert.equal(result.needs_master_decision, true);
    assert.match(result.summary, /不要继续工作、自动重试或续作/);
    assert.match(result.summary, /等待用户确认额度恢复/);
    assert.equal(status.error_code, "zcode_usage_exhausted");
    assert.equal(status.worker_pid, null);
    assert.ok(events.some((event) => event.type === "turn_failed" && event.details?.error_code === "zcode_usage_exhausted"));
    assert.doesNotMatch(JSON.stringify({ result, status, events }), /PRIVATE_PROVIDER_DETAIL/);
    const requests = (await readFile(fixture.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((request) => request.method === "session/send").length, 1, "exhaustion never causes an automatic retry");
  } finally { await fixture.cleanup(); }
});

test("worker preserves every visible output character across multiple bounded events", async () => {
  const output = "可见输出🙂".repeat(1_000);
  const fixture = await runtimeFixture({ output });
  try {
    const store = new TaskStore(fixture.root);
    store.createTask(makeTask({ workspace: fixture.root }), new Date().toISOString());
    // Use the production adapter and its worker callbacks, with only discovery isolated.
    const envBefore = { ...process.env };
    Object.assign(process.env, fixture.env);
    try { await runWorkerTask({ dataRoot: fixture.root, taskId: "task_1", attempt: 1, host: fixture.host }); }
    finally { for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]; Object.assign(process.env, envBefore); }
    const chunks = store.readEvents("task_1", 0, 200).events.filter((event) => event.type === "model_output");
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((event) => event.summary).join(""), output);
  } finally { await fixture.cleanup(); }
});

test("a real worker delivers a permission reply and exits; a continuation gets a fresh request ID", async () => {
  const fixture = await runtimeFixture({ interaction: true });
  const store = new TaskStore(fixture.root);
  const manager = new BridgeTaskManager({ store, workspaceProvider: new DirectWorkspaceProvider(), pollIntervalMs: 0, spawnWorker: () => ({ pid: process.pid }) });
  try {
    store.createTask(makeTask({ workspace: fixture.root }), new Date().toISOString());
    let priorId = "";
    for (const attempt of [1, 2]) {
      if (attempt === 2) { store.archiveResultToAttempt("task_1", 1); store.writeStatus("task_1", { status: "queued", attempt: 2, finished_at: null }); }
      const child = spawn(process.execPath, [workerEntry, fixture.root, "task_1", String(attempt)], { env: { ...fixture.env, ZCODE_BRIDGE_HOST_PROFILE: JSON.stringify(fixture.host) }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
      try {
        const deadline = Date.now() + 5_000;
        let id = "";
        while (!id && Date.now() < deadline) {
          id = String(store.readEvents("task_1", 0, 200).events.find((event) => event.type === "interaction_requested" && String(event.details?.request_id).startsWith(`${attempt}:`))?.details?.request_id ?? "");
          if (!id) await delay(25);
        }
        assert.ok(id, stderr);
        assert.notEqual(id, priorId);
        assert.equal(store.readInteractionRequest("task_1", id)?.state, "pending");
        await manager.replyToInteraction({ task_id: "task_1", request_id: id, decision: "allow" });
        const exit = await Promise.race([exited, delay(5_000).then(() => "hung")]);
        assert.equal(exit, 0, stderr);
        assert.equal(store.readResult("task_1")?.status, "completed");
        priorId = id;
      } finally { if (child.exitCode === null && child.signalCode === null && child.pid) await terminateFixtureChild(child); }
    }
  } finally { manager.dispose(); await fixture.cleanup(); }
});

/** ADR-009: holds the ORIGINAL ChildProcess. The shared capture re-verifies
 * the spawn generation after every await (exit state, not the close flag),
 * so a fingerprint read after an exit-and-recycle race is discarded and the
 * Windows terminator then refuses to signal. */
async function terminateFixtureChild(child: import("node:child_process").ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const identity = await captureSpawnGenerationIdentity(child, createPlatformProbe());
  await terminateProcessTree(child.pid, { expectedRootFingerprint: identity?.fingerprint ?? null, killWaitMs: 5_000 });
}

test("real worker reaches its 60-second timeout and exits with an unanswered interaction", { timeout: 80_000 }, async () => {
  const fixture = await runtimeFixture({ interaction: true });
  const store = new TaskStore(fixture.root);
  store.createTask(makeTask({ workspace: fixture.root, timeout_ms: 60_000 }), new Date().toISOString());
  const child = spawn(process.execPath, [workerEntry, fixture.root, "task_1", "1"], { env: { ...fixture.env, ZCODE_BRIDGE_HOST_PROFILE: JSON.stringify(fixture.host) }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const exit = await Promise.race([exited, delay(70_000).then(() => "hung")]);
    assert.equal(exit, 0, stderr);
    assert.equal(store.readResult("task_1")?.error_code, "timeout");
    assert.equal(store.readStatus("task_1").worker_pid, null);
    assert.equal(store.readStatus("task_1").zcode_pid, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) await terminateFixtureChild(child);
    await fixture.cleanup();
  }
});

test("model catalog uses yolo by default and shares its cache with explicit yolo while respecting build", async () => {
  const fixture = await runtimeFixture();
  try {
    const env: NodeJS.ProcessEnv = { ...fixture.env };
    delete env["ZCODE_BRIDGE_MODE"];
    const settings = new ZCodeModelSettings(env, { homeDir: fixture.home, host: fixture.host });
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    let requests = (await readFile(fixture.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.find((request) => request.method === "session/create").params.mode, "yolo");
    const initialLog = await readFile(fixture.log, "utf8");
    for (const mode of ["yolo", "", "   "]) {
      env["ZCODE_BRIDGE_MODE"] = mode;
      assert.equal((await settings.listModels(fixture.root)).cache_status, "fresh");
      assert.equal(await readFile(fixture.log, "utf8"), initialLog);
    }
    env["ZCODE_BRIDGE_MODE"] = "build";
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    requests = (await readFile(fixture.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.filter((request) => request.method === "session/create").map((request) => request.params.mode), ["yolo", "build"]);
    assert.equal(requests.some((request) => request.method === "session/send"), false);
  } finally { await fixture.cleanup(); }
});

test("host-specific defaults and cache remain isolated, preserve unknown settings, and refresh on provider change", async () => {
  const fixture = await runtimeFixture();
  try {
    const settings = new ZCodeModelSettings(fixture.env, { homeDir: fixture.home, host: fixture.host });
    const configPath = path.join(fixture.host.settingsDirectory, "runtime-config.json");
    await writeFile(configPath, JSON.stringify({ ZCODE_BRIDGE_MODE: "build", ZCODE_BRIDGE_TIMEOUT_MS: "60000", extension: { kept: true } }));
    await settings.setDefaultModel({ provider_id: "fake", model_id: "fake" });
    const other = new ZCodeModelSettings({}, { homeDir: fixture.home, host: { name: "other-host", settingsDirectory: path.join(fixture.home, ".other", "bridge") } });
    assert.equal((await other.getDefaultModel()).configured, false);
    assert.equal((await settings.getDefaultModel()).model?.model_id, "fake");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.extension, { kept: true });
    assert.equal(config.ZCODE_BRIDGE_TIMEOUT_MS, "60000");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    const initialLog = await readFile(fixture.log, "utf8");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "fresh");
    assert.equal(await readFile(fixture.log, "utf8"), initialLog);
    await writeFile(fixture.config.providerBuiltinConfigFile, JSON.stringify({ config: { revision: 2 } }));
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    const cacheDirectory = path.join(fixture.host.settingsDirectory, "model-catalog");
    const cache = (await readdir(cacheDirectory))[0]!;
    const originalCache = JSON.parse(await readFile(path.join(cacheDirectory, cache), "utf8"));
    originalCache.models[0].private_metadata = { secret: "PRIVATE_CACHE" };
    await writeFile(path.join(cacheDirectory, cache), JSON.stringify(originalCache));
    assert.doesNotMatch(JSON.stringify(await settings.listModels(fixture.root)), /PRIVATE_CACHE|private_metadata/);
    await writeFile(path.join(cacheDirectory, cache), "{broken");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    await settings.clearDefaultModel();
    assert.equal((await settings.getDefaultModel()).configured, false);
  } finally { await fixture.cleanup(); }
});
