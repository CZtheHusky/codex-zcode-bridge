import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KimiAdapter, kimiFailureCode } from "../src/adapters/kimi-adapter.js";
import type { TaskPackage } from "../src/interfaces.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { TaskStore } from "../src/store/task-store.js";
import { makeManagerFixture } from "./manager-helpers.js";
import { createWorkerEnv } from "../src/runtime/child-env.js";
import { zcodeTaskInputSchema } from "../src/mcp/schemas.js";

function fixture(kind = "success", message?: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), "bridge-kimi-test-"));
  writeFileSync(path.join(cwd, "scenario.json"), JSON.stringify({ kind, message }));
  const executable = path.join(cwd, "kimi.cjs");
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(path.resolve("test/fixtures/fake-kimi.cjs"), "utf8")}`);
  chmodSync(executable, 0o700);
  const previous = process.env["KIMI_BRIDGE_EXECUTABLE"];
  process.env["KIMI_BRIDGE_EXECUTABLE"] = executable;
  const task: TaskPackage = { task_id: "kimi-test", executor: "kimi", workspace: cwd, objective: "fixture", requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] };
  const workspace = { requestedPath: cwd, canonicalPath: cwd, mode: "direct" as const };
  return { cwd, task, workspace, requests: () => JSON.parse(readFileSync(path.join(cwd, "requests.json"), "utf8")), cleanup: () => { if (previous === undefined) delete process.env["KIMI_BRIDGE_EXECUTABLE"]; else process.env["KIMI_BRIDGE_EXECUTABLE"] = previous; rmSync(cwd, { recursive: true, force: true }); } };
}

test("Kimi task contract is additive; worker env forwards only explicit Kimi configuration", () => {
  const env = createWorkerEnv({ KIMI_BRIDGE_EXECUTABLE: "/bin/kimi", KIMI_CODE_HOME: "/tmp/kimi", KIMI_API_KEY: "secret" });
  assert.equal(env.KIMI_BRIDGE_EXECUTABLE, "/bin/kimi"); assert.equal(env.KIMI_CODE_HOME, "/tmp/kimi"); assert.equal(env.KIMI_API_KEY, undefined);
  const f = fixture(); try { assert.equal(zcodeTaskInputSchema.parse({ ...f.task, kimi: { permission_mode: "manual", model: "local/alias" } }).executor, "kimi"); } finally { f.cleanup(); }
});

test("Kimi native completion requires current prompt/main turn and emits no token or reasoning", async () => {
  const f = fixture(); const events: unknown[] = [];
  try {
    const adapter = new KimiAdapter({ onEvent: e => events.push(e) });
    const handle = await adapter.startTask({ ...f, attempt: 1 }); const result = await adapter.getResult(handle);
    assert.equal(result.errorCode, null); assert.equal(result.agentReport?.summary, "fixture success"); assert.equal(result.cleanupVerified, true);
    assert.doesNotMatch(JSON.stringify({ events, result }), /private-fixture-token|HIDDEN_REASONING|HIDDEN_SUBAGENT/);
    const prompt = f.requests().find((r: { route: string }) => r.route.endsWith("/prompts"));
    assert.equal(prompt.body.thinking, undefined, "omitting the override must preserve native defaults");
    assert.equal(prompt.body.model, "fixture/default"); assert.equal(prompt.body.permission_mode, "yolo");
    assert.equal((await adapter.getStatus(handle)).state, "exited");
    const next = await adapter.continueTask({ ...f, attempt: 2, feedback: "continue", additionalRequirements: [], previousSessionId: result.sessionId, previousResult: null });
    assert.equal((await adapter.getResult(next)).sessionId, result.sessionId);
    assert.equal(f.requests().filter((r: { route: string; body?: unknown }) => r.route === "/api/v1/sessions" && r.body).length, 1, "continuation must not create a replacement session");
  } finally { f.cleanup(); }
});

for (const [kind, expected] of [["failure", "kimi_usage_exhausted"], ["invalid", "invalid_agent_report"], ["disconnect", "kimi_nonzero_exit"], ["gap", "kimi_nonzero_exit"], ["envelope_error", "kimi_nonzero_exit"]] as const) {
  test(`Kimi ${kind} never becomes completed, even with an apparently valid report`, async () => {
    const f = fixture(kind); try {
      const adapter = new KimiAdapter(); const result = await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 }));
      assert.equal(result.errorCode, expected); assert.equal(result.agentReport, null); assert.equal(result.cleanupVerified, true);
      assert.doesNotMatch(JSON.stringify(result), /SECRET_MUST_NOT_LEAK|private-fixture-token/);
    } finally { f.cleanup(); }
  });
}

test("ordinary rate limiting stays distinct from exhausted quota", async () => {
  assert.equal(kimiFailureCode({ code: "provider.rate_limit", message: "Too many requests; retry later" }), "kimi_nonzero_exit");
  assert.equal(kimiFailureCode({ code: "provider.rate_limit", message: "Usage rate limit exceeded" }), "kimi_nonzero_exit");
  assert.equal(kimiFailureCode({ code: "provider.rate_limit", message: "Usage quota exhausted" }), "kimi_usage_exhausted");
  assert.equal(kimiFailureCode({ code: "provider.api_error", message: "Insufficient balance" }), "kimi_usage_exhausted");
  assert.equal(kimiFailureCode({ name: "APIProviderQuotaExhaustedError", message: "HTTP 429" }), "kimi_usage_exhausted");
  const f = fixture("failure", "HTTP 429 rate limit"); try {
    const adapter = new KimiAdapter(); const result = await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 }));
    assert.equal(result.errorCode, "kimi_nonzero_exit");
  } finally { f.cleanup(); }
});

for (const allow of [true, false]) test(`Kimi permission ${allow ? "allow" : "deny"} requires the host reply`, async () => {
  const f = fixture("permission"); let called = false;
  try {
    const adapter = new KimiAdapter({ resolveInteraction: async request => { called = true; assert.equal(request.method, "interaction/requestPermission"); return { decision: allow ? "allow" : "deny" }; } });
    await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 })); assert.equal(called, true);
    assert.equal(f.requests().find((r: { route: string }) => r.route.endsWith("/approvals/approval_1")).body.decision, allow ? "approved" : "rejected");
  } finally { f.cleanup(); }
});

test("Kimi questions preserve exact question keys and translate selected option IDs", async () => {
  const f = fixture("question"); try {
    const adapter = new KimiAdapter({ resolveInteraction: async () => ({ action: "accept", content: { answers: { "Which color?": "Blue" } } }) });
    await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 }));
    assert.deepEqual(f.requests().find((r: { route: string }) => r.route.endsWith("/questions/question_1")).body.answers, { q1: { kind: "single", option_id: "blue" } });
  } finally { f.cleanup(); }
});

test("cancellation kills the owned runtime and records a verified cancellation", async () => {
  const f = fixture("hang"); let ready!: () => void; const started = new Promise<void>(resolve => ready = resolve);
  try {
    const adapter = new KimiAdapter({ onEvent: e => { if (e.type === "turn_started") ready(); } });
    const handle = await adapter.startTask({ ...f, attempt: 1 }); await started; await adapter.cancelTask(handle);
    const result = await adapter.getResult(handle); assert.equal(result.cancelled, true); assert.equal(result.errorCode, "cancelled"); assert.equal(result.cleanupVerified, true);
  } finally { f.cleanup(); }
});

test("worker selects Kimi without resolving ZCode and persists quota failure", async () => {
  const f = fixture("failure"); const dataRoot = path.join(f.cwd, "data"); const store = new TaskStore(dataRoot);
  try {
    store.createTask(f.task, new Date().toISOString());
    const result = await runWorkerTask({ dataRoot, taskId: f.task.task_id, attempt: 1, resolver: { resolve: async () => { throw new Error("must not invoke ZCode resolver"); } } });
    assert.equal(result.status, "failed"); assert.equal(result.result.error_code, "kimi_usage_exhausted"); assert.equal(result.result.model?.executor, "kimi");
    assert.equal(store.readStatus(f.task.task_id).zcode_session_id, "session_fixture");
    assert.equal(store.readResult(f.task.task_id)?.error_code, "kimi_usage_exhausted");
    assert.doesNotMatch(store.readLog(f.task.task_id, "stderr"), /SECRET_MUST_NOT_LEAK|private-fixture-token/);
  } finally { f.cleanup(); }
});

test("MCP rejects mixed runtime options; manager preserves executor in submission identity", async () => {
  const f = await makeManagerFixture();
  try {
    const original = { ...f.makeTask(), executor: "kimi" as const };
    assert.equal(zcodeTaskInputSchema.safeParse({ ...original, model: { provider_id: "zcode", model_id: "x" } }).success, false);
    assert.equal(zcodeTaskInputSchema.safeParse({ ...original, executor: "zcode", kimi: { model: "x" } }).success, false);
    await f.manager.createTask(original);
    await assert.rejects(f.manager.createTask({ ...original, executor: "zcode" }), /different request/);
  } finally { await f.cleanup(); }
});

test("cancelling during startup leaves no session and verifies runtime cleanup", async () => {
  const f = fixture(); const events: unknown[] = [];
  try {
    const adapter = new KimiAdapter({ onEvent: event => events.push(event) });
    const handlePromise = adapter.startTask({ ...f, attempt: 1 });
    const handle = await handlePromise;
    await adapter.cancelTask(handle);
    const result = await adapter.getResult(handle);
    assert.equal(result.errorCode, "cancelled"); assert.equal(result.cleanupVerified, true);
    assert.equal(events.length, 0);
  } finally { f.cleanup(); }
});

for (const level of ["low", "high", "max"]) test(`Kimi ${level} is forwarded and retained on same-session continuation`, async () => {
  const f = fixture(); const confirmed: unknown[] = [];
  try {
    f.task.kimi = { reasoning_level: level };
    assert.equal(zcodeTaskInputSchema.parse(f.task).kimi?.reasoning_level, level);
    const adapter = new KimiAdapter({ onEvent: e => { if (e.type === "model_selected") confirmed.push(e.details?.reasoning_level); } });
    const first = await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 }));
    assert.equal(first.errorCode, null);
    const second = await adapter.getResult(await adapter.continueTask({ ...f, attempt: 2, feedback: "continue", additionalRequirements: [], previousSessionId: first.sessionId, previousResult: null }));
    assert.equal(second.errorCode, null);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.cleanupVerified, true);
    const prompts = f.requests().filter((r: { route: string }) => r.route.endsWith("/prompts"));
    assert.deepEqual(prompts.map((r: { body: { thinking: string } }) => r.body.thinking), [level, level]);
    assert.deepEqual(confirmed, [level, level]);
  } finally { f.cleanup(); }
});

test("Kimi reports the runtime-confirmed effort rather than the requested effort", async () => {
  const f = fixture("thinking_fallback"); const confirmed: unknown[] = [];
  try {
    f.task.kimi = { reasoning_level: "max" };
    const adapter = new KimiAdapter({ onEvent: e => { if (e.type === "model_selected") confirmed.push(e.details?.reasoning_level); } });
    const result = await adapter.getResult(await adapter.startTask({ ...f, attempt: 1 }));
    assert.equal(result.errorCode, null);
    assert.deepEqual(confirmed, ["high"]);
  } finally { f.cleanup(); }
});
