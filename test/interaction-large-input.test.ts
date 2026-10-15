// ADR-008 large approval input tests: the store persists sanitized params
// complete up to 1 MiB, the interaction_requested event degrades to a bounded
// explicitly-marked preview with a full-request reference (path, bytes,
// SHA256), approvals verify the full content is intact before counting as
// granted, and every failure path declines with an explicit recoverable
// reason instead of the old generic "reply unavailable".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InteractionRequestTooLargeError,
  MAX_INTERACTION_PARAMS_BYTES,
  TaskStore,
} from "../src/store/task-store.js";
import { publishInteractionRequest } from "../src/worker/run-task.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { TaskManagerError } from "../src/manager/errors.js";
import { makeManagerFixture } from "./manager-helpers.js";
import { validReport } from "./helpers.js";
import type { ZCodeInteractionRequest, ZCodeRuntimeConfig } from "../src/interfaces.js";

function padParams(totalBytes: number): Record<string, unknown> {
  const envelope = Buffer.byteLength(JSON.stringify({ input: { content: "" } }), "utf8");
  return { input: { content: "w".repeat(totalBytes - envelope) } };
}

function serializedBytes(params: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(params), "utf8");
}

function sha256(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

async function storeFixture(): Promise<{ store: TaskStore; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-large-input-"));
  const store = new TaskStore(root);
  store.createTask({
    task_id: "task_1",
    workspace: root,
    objective: "fixture",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  }, "2026-10-14T00:00:00.000Z");
  return { store, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function permissionRequest(params: Record<string, unknown>, requestId = "permission-1"): ZCodeInteractionRequest {
  return {
    request_id: requestId,
    method: "interaction/requestPermission",
    params: { sessionId: "sess-fixture", toolCallId: "call-1", toolName: "Write", ...params },
  };
}

test("a request over the 1 MiB limit is rejected with actual and limit bytes and no file is created", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const over = permissionRequest(padParams(MAX_INTERACTION_PARAMS_BYTES + 100));
    assert.ok(serializedBytes(over.params) > MAX_INTERACTION_PARAMS_BYTES);
    assert.throws(
      () => store.writeInteractionRequest("task_1", over),
      (error: unknown) => {
        assert.ok(error instanceof InteractionRequestTooLargeError);
        assert.equal(error.limitBytes, MAX_INTERACTION_PARAMS_BYTES);
        assert.equal(error.actualBytes, serializedBytes(over.params));
        assert.match(error.message, /split the tool input/i);
        return true;
      },
    );
    assert.equal(existsSync(store.interactionRequestPath("task_1", "permission-1")), false);
  } finally {
    await cleanup();
  }
});

test("duplicate ids compare the complete input, not a bounded preview", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const large = padParams(80 * 1024);
    const first = store.writeInteractionRequest("task_1", permissionRequest(large));
    assert.equal(first.created, true);
    const same = store.writeInteractionRequest("task_1", permissionRequest(large));
    assert.equal(same.created, false, "identical full input is a dedup, not a collision");
    // The difference sits at the very end of the payload; a truncated-preview
    // comparison would miss it.
    const edited = padParams(80 * 1024);
    (edited.input as Record<string, unknown>)["content"] = `${"w".repeat(80 * 1024 - 100)}DIFFERENT`;
    assert.throws(
      () => store.writeInteractionRequest("task_1", permissionRequest(edited)),
      /id collision/,
    );
  } finally {
    await cleanup();
  }
});

test("records carry byte count and SHA256 metadata and stay isolated per attempt", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const request = permissionRequest(padParams(40 * 1024));
    const { record } = store.writeInteractionRequest("task_1", request);
    assert.equal(record.params_bytes, serializedBytes(request.params));
    assert.equal(record.params_sha256, sha256(request.params));
    const file = store.interactionRequestPath("task_1", "permission-1");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { params: Record<string, unknown> };
    assert.deepEqual(onDisk.params, request.params, "the full input round-trips on disk");
    assert.equal(store.verifyInteractionRequestIntegrity("task_1", "permission-1").ok, true);

    // Attempt isolation: a new attempt writes its own record for the same id.
    store.writeStatus("task_1", { status: "running", attempt: 2, started_at: "2026-10-14T00:00:01.000Z" });
    const second = store.writeInteractionRequest("task_1", request);
    assert.equal(second.created, true);
    assert.notEqual(store.interactionRequestPath("task_1", "permission-1"), file);
  } finally {
    await cleanup();
  }
});

test("integrity verification rejects missing, corrupt, and edited full records", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const params = padParams(40 * 1024);
    store.writeInteractionRequest("task_1", permissionRequest(params));
    const file = store.interactionRequestPath("task_1", "permission-1");

    // Edited content with intact structure: hash mismatch.
    const edited = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { params: Record<string, unknown> };
    (edited.params.input as Record<string, unknown>)["content"] = "tampered";
    writeFileSync(file, JSON.stringify(edited), "utf8");
    const mismatch = store.verifyInteractionRequestIntegrity("task_1", "permission-1");
    assert.equal(mismatch.ok, false);
    assert.match((mismatch as { reason: string }).reason, /SHA256|byte count/);

    // Corrupt file.
    writeFileSync(file, "{{{not json", "utf8");
    const corrupt = store.verifyInteractionRequestIntegrity("task_1", "permission-1");
    assert.equal(corrupt.ok, false);
    assert.match((corrupt as { reason: string }).reason, /unreadable|corrupt/i);

    // Missing file.
    const missing = store.verifyInteractionRequestIntegrity("task_1", "missing-request");
    assert.equal(missing.ok, false);
    assert.match((missing as { reason: string }).reason, /missing/i);
  } finally {
    await cleanup();
  }
});

test("publishing a small request keeps the compatible full-detail event shape", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const params = { input: { command: "npm run build" }, options: [{ kind: "allow_once" }, { kind: "deny" }] };
    const request = permissionRequest(params, "permission-small");
    const { record } = store.writeInteractionRequest("task_1", request);
    const published = publishInteractionRequest(store, "task_1", request, record);
    assert.ok(published.event);
    const stored = store.readEvents("task_1", published.event!.seq - 1).events.find((event) => event.type === "interaction_requested");
    assert.ok(stored);
    assert.equal(stored.details?.["preview"], undefined);
    assert.deepEqual(stored.details?.["input"], params.input);
    assert.deepEqual(stored.details?.["options"], params.options);
  } finally {
    await cleanup();
  }
});

test("publishing a large request emits one bounded preview event with a full-request reference", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    const params = padParams(80 * 1024); // over the 64,000-byte single-event line limit
    const request = permissionRequest(params, "permission-large");
    const { record } = store.writeInteractionRequest("task_1", request);
    const published = publishInteractionRequest(store, "task_1", request, record);
    assert.ok(published.event, `the preview event must publish (line must stay under 64,000 bytes): ${published.declineReason}`);
    const stored = store.readEvents("task_1", published.event!.seq - 1).events.find((event) => event.type === "interaction_requested");
    assert.ok(stored);
    const line = readFileSync(path.join(store.taskDir("task_1"), "events.jsonl"), "utf8")
      .trim().split("\n").find((entry) => entry.includes("\"interaction_requested\""));
    assert.ok(Buffer.byteLength(line ?? "", "utf8") <= 64_000, "the preview event line must respect the single-event byte limit");
    assert.equal(stored.details?.["preview"], true, "the event must be explicitly marked as a preview");
    assert.equal(stored.details?.["input"], undefined, "the preview must not impersonate the full input field");
    const preview = String(stored.details?.["input_preview"]);
    assert.ok(preview.includes("[preview truncated"));
    assert.ok(Buffer.byteLength(preview, "utf8") < 22_000);
    assert.equal(stored.details?.["input_bytes"], serializedBytes(params["input"] as Record<string, unknown>));
    assert.equal(stored.details?.["questions"], undefined, "a questions array inside input is not duplicated into the event");
    const fullRequest = stored.details?.["full_request"] as Record<string, unknown>;
    assert.equal(fullRequest["task_id"], "task_1");
    assert.equal(fullRequest["request_id"], "permission-large");
    assert.equal(fullRequest["bytes"], serializedBytes(request.params));
    assert.equal(fullRequest["sha256"], sha256(request.params));
    // The reference points at the real full record.
    const referenced = JSON.parse(readFileSync(String(fullRequest["file"]), "utf8")) as { params: Record<string, unknown>; params_sha256?: string };
    assert.deepEqual(referenced.params, request.params);
    assert.equal(referenced.params_sha256, sha256(request.params));
  } finally {
    await cleanup();
  }
});

test("when the event log is out of capacity, publishing fails with an explicit recoverable reason", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-large-input-cap-"));
  try {
    const store = new TaskStore(root, { maxEventBytes: 2048 });
    store.createTask({
      task_id: "task_1",
      workspace: root,
      objective: "fixture",
      requirements: [],
      allowed_paths: [],
      forbidden_paths: [],
      acceptance_criteria: [],
      test_commands: [],
    }, "2026-10-14T00:00:00.000Z");
    // Exhaust both the regular budget and the critical reserve: large filler
    // lines first, then tiny ones until nothing at all fits.
    let guard = 0;
    while (store.appendEvent("task_1", "error", "f".repeat(60_000)) && guard < 100) guard += 1;
    guard = 0;
    while (store.appendEvent("task_1", "error", "filler") && guard < 100_000) guard += 1;
    assert.ok(guard > 0);
    assert.equal(store.appendEvent("task_1", "error", "probe"), null, "precondition: the log must be full");
    const params = { input: { command: "npm run build" } };
    const request = permissionRequest(params, "permission-full-log");
    const { record } = store.writeInteractionRequest("task_1", request);
    const published = publishInteractionRequest(store, "task_1", request, record);
    assert.equal(published.event, null);
    assert.match(published.declineReason, /event log is out of capacity/i);
    assert.match(published.declineReason, /declined and nothing was executed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- End-to-end worker chain: real app-server adapter over a fake runtime,
// real TaskStore, and host replies through the manager. ----

interface InteractionRuntime {
  root: string;
  requestLog: string;
  artifactPath: string;
  config: ZCodeRuntimeConfig;
  content: string;
}

async function makeInteractionRuntime(contentBytes: number): Promise<InteractionRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-interaction-e2e-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const artifactPath = path.join(root, "artifact.txt");
  const content = "A".repeat(contentBytes);
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const requestLog = ${JSON.stringify(requestLog)};
const artifactPath = ${JSON.stringify(artifactPath)};
const content = ${JSON.stringify(content)};
const report = ${JSON.stringify(validReport())};
function snapshot() {
  return {
    session: { sessionId: "sess-e2e-1" },
    settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [{ ref: { providerId: "provider-default", modelId: "model-default" }, label: "Test Model" }] } },
    runtime: { eventSeq: 0 },
  };
}
function line(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
let requested = false;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (text) => {
  const message = JSON.parse(text);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "session/create" || message.method === "session/setModel" || message.method === "session/setMode") {
    line({ id: message.id, result: snapshot() });
  } else if (message.method === "session/subscribe") {
    line({ id: message.id, result: {} });
  } else if (message.method === "session/send") {
    line({ id: message.id, result: {} });
    if (!requested) {
      requested = true;
      line({ id: "perm-rpc-1", method: "interaction/requestPermission", params: {
        requestId: "write-large", sessionId: "sess-e2e-1", toolCallId: "call-1", toolName: "Write",
        reason: "Write a fixture file", input: { path: artifactPath, content },
        options: [{ kind: "allow_once" }, { kind: "deny" }]
      } });
    } else {
      line({ method: "session/event", params: { seq: 1000, type: "turn.completed", payload: { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" } } });
    }
  } else if (message.id === "perm-rpc-1") {
    const decision = message.result && message.result.decision;
    if (decision === "allow") {
      // Simulated tool execution happens only after the approval round trip.
      fs.writeFileSync(artifactPath, content);
    }
    fs.appendFileSync(requestLog, JSON.stringify({ reply: message.result }) + "\n");
    line({ method: "session/event", params: { seq: 1000, type: "turn.completed", payload: { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" } } });
  } else if (message.id !== undefined) {
    line({ id: message.id, result: {} });
  }
});
input.on("close", () => process.exit(0));
`;
  await writeFile(entrypoint, script, "utf8");
  return {
    root,
    requestLog,
    artifactPath,
    content,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
  };
}

async function waitForInteractionEvent(store: TaskStore, taskId: string): Promise<{ seq: number; details?: Record<string, unknown> }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = store.readEvents(taskId, 0, 200);
    const found = page.events.find((event) => event.type === "interaction_requested");
    if (found) return { seq: found.seq, details: found.details };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("interaction_requested event never appeared");
}

/** Windows: the spawned fake runtime uses the workspace as cwd; teardown may
 * race its exit, so directory removal retries and never fails the test. */
async function cleanupE2E(fx: { cleanup: () => Promise<void> }, runtimeRoot: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fx.cleanup().catch(() => undefined);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(runtimeRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

test("a 40 KiB Write approval round-trips through the store with the full input in the event", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(40 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    assert.equal(event.details?.["preview"], undefined, "40 KiB fits the single-event budget: full detail shape");
    assert.equal((event.details?.["input"] as { content?: string })?.content?.length, 40 * 1024);
    const requestId = String(event.details?.["request_id"]);
    const record = fx.store.readInteractionRequest("task_1", requestId);
    assert.equal(record?.params_bytes, serializedBytes(record!.params));
    assert.equal(fx.store.verifyInteractionRequestIntegrity("task_1", requestId).ok, true);
    await fx.manager.replyToInteraction({ task_id: "task_1", request_id: requestId, decision: "allow" });
    const { result } = await run;
    assert.equal(result.status, "completed");
    assert.equal(fx.store.readInteractionRequest("task_1", requestId)?.state, "answered");
    // The simulated Write executed only after the allow reply, with the exact
    // full content carried by the approval request.
    assert.equal(readFileSync(runtime.artifactPath, "utf8"), runtime.content);
    const replies = (await readFile(runtime.requestLog, "utf8")).trim().split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry["reply"]);
    assert.deepEqual(replies.map((entry) => (entry["reply"] as { decision?: string }).decision), ["allow"]);
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("an 80 KiB Write approval publishes a bounded preview with a full-request reference and still round-trips", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(80 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    assert.equal(event.details?.["preview"], true);
    assert.equal(typeof event.details?.["input_preview"], "string");
    const expectedInputBytes = Buffer.byteLength(JSON.stringify({ path: runtime.artifactPath, content: runtime.content }), "utf8");
    assert.equal(event.details?.["input_bytes"], expectedInputBytes);
    const fullRequest = event.details?.["full_request"] as Record<string, unknown>;
    assert.ok(fullRequest);
    assert.equal(fullRequest["sha256"], fx.store.readInteractionRequest("task_1", String(event.details?.["request_id"]))?.params_sha256);
    // The host reads the complete input from the referenced private record.
    const referenced = JSON.parse(readFileSync(String(fullRequest["file"]), "utf8")) as { params: { input: { content: string } } };
    assert.equal(referenced.params.input.content, runtime.content);
    await fx.manager.replyToInteraction({ task_id: "task_1", request_id: String(event.details?.["request_id"]), decision: "allow" });
    const { result } = await run;
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(runtime.artifactPath, "utf8"), runtime.content, "the full 80 KiB content reached the tool after approval");
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("an over-1MiB Write approval is declined with actual/limit and split advice; nothing executes and no approval hangs", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(MAX_INTERACTION_PARAMS_BYTES + 5_000);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const { result } = await run;
    assert.equal(result.status, "completed", "the turn itself finishes; the oversized tool request is declined, not hung");
    const events = fx.store.readEvents("task_1", 0, 200).events;
    const oversized = events.find((event) => event.type === "interaction_request_oversized");
    assert.ok(oversized, "an explicit oversized event must be published");
    assert.equal(oversized?.details?.["error_code"], "interaction_params_over_limit");
    assert.equal(oversized?.details?.["limit_bytes"], MAX_INTERACTION_PARAMS_BYTES);
    assert.ok(typeof oversized?.details?.["actual_bytes"] === "number" && (oversized?.details?.["actual_bytes"] as number) > MAX_INTERACTION_PARAMS_BYTES);
    assert.equal(events.some((event) => event.type === "interaction_requested"), false, "no approval event is published for the rejected request");
    // No record, no pending approval.
    assert.equal(fx.store.readInteractionRequest("task_1", "1:write-large"), null);
    // The runtime received an explicit deny with the recoverable reason.
    const replies = (await readFile(runtime.requestLog, "utf8")).trim().split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry["reply"]) as Array<{ reply: { decision?: string; reason?: string } }>;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.reply.decision, "deny");
    assert.match(replies[0]!.reply.reason ?? "", /over the 1048576-byte limit/);
    assert.match(replies[0]!.reply.reason ?? "", /Split the input into smaller parts/);
    assert.equal(existsSync(runtime.artifactPath), false, "nothing may execute before a grant");
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("approving against a corrupt full record is refused; the worker declines explicitly and nothing executes", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(80 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    const requestId = String(event.details?.["request_id"]);
    const file = fx.store.interactionRequestPath("task_1", requestId);
    writeFileSync(file, "{{{corrupt", "utf8");
    // The host's approval cannot count as granted against a corrupt record.
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: requestId, decision: "allow" }),
      (error: unknown) => {
        if (!(error instanceof TaskManagerError)) return false;
        assert.equal(error.code, "TASK_STATE");
        assert.match(error.message, /unreadable|corrupt/i);
        assert.match(error.message, /could not be read|not recorded as granted/);
        return true;
      },
    );
    // The worker's poll notices the unreadable record, declines explicitly,
    // and the run finishes without executing the tool.
    const { result } = await run;
    assert.equal(result.status, "completed");
    const replies = (await readFile(runtime.requestLog, "utf8")).trim().split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry["reply"]) as Array<{ reply: { decision?: string; reason?: string } }>;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.reply.decision, "deny");
    assert.match(replies[0]!.reply.reason ?? "", /can no longer read the full content/);
    assert.equal(existsSync(runtime.artifactPath), false);
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("an approval against an edited (hash-mismatched) full record is refused", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(40 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    const requestId = String(event.details?.["request_id"]);
    const file = fx.store.interactionRequestPath("task_1", requestId);
    const edited = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { params: { input: { content: string } } };
    edited.params.input.content = "tampered-but-valid-json";
    writeFileSync(file, JSON.stringify(edited), "utf8");
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: requestId, decision: "allow" }),
      (error: unknown) => {
        if (!(error instanceof TaskManagerError)) return false;
        assert.equal(error.code, "TASK_STATE");
        assert.match(error.message, /SHA256|byte count|does not match/);
        return true;
      },
    );
    // The unapproved request is still pending; end the run deterministically.
    fx.store.answerInteractionRequest("task_1", requestId, { decision: "deny", reason: "test teardown" });
    const { result } = await run;
    assert.equal(result.status, "completed");
    assert.equal(existsSync(runtime.artifactPath), false);
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

// ---- Review R2 regressions: stripped metadata, wrong types, the 1 MiB guard
// at verification time, and worker-side original-vs-persisted comparison. ----

function readRecordFile(store: TaskStore, taskId: string, requestId: string): Record<string, unknown> & { params: Record<string, unknown> } {
  return JSON.parse(readFileSync(store.interactionRequestPath(taskId, requestId), "utf8")) as Record<string, unknown> & { params: Record<string, unknown> };
}

function writeRecordFile(store: TaskStore, taskId: string, requestId: string, record: Record<string, unknown>): void {
  writeFileSync(store.interactionRequestPath(taskId, requestId), JSON.stringify(record), "utf8");
}

test("a large record with its integrity metadata stripped cannot pass verification as legacy (review probe)", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    store.writeInteractionRequest("task_1", permissionRequest(padParams(40 * 1024)));
    // The independent review probe: edit the content AND delete
    // params_bytes/params_sha256 — the old verifier called this ok. The
    // edited content stays large, so the record cannot hide in the legacy
    // small-record compatibility window.
    const record = readRecordFile(store, "task_1", "permission-1");
    (record.params.input as Record<string, unknown>)["content"] = "t".repeat(40 * 1024);
    delete record.params_bytes;
    delete record.params_sha256;
    writeRecordFile(store, "task_1", "permission-1", record);
    const verdict = store.verifyInteractionRequestIntegrity("task_1", "permission-1");
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /no integrity metadata|legacy/i);
  } finally {
    await cleanup();
  }
});

test("partial or wrong-type integrity metadata fails verification; genuinely legacy small records stay compatible", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    // Legacy shape: no metadata at all, within the old 32,000-byte limit.
    store.writeInteractionRequest("task_1", permissionRequest({ input: { command: "npm test" } }, "permission-legacy"));
    const legacy = readRecordFile(store, "task_1", "permission-legacy");
    delete legacy.params_bytes;
    delete legacy.params_sha256;
    writeRecordFile(store, "task_1", "permission-legacy", legacy);
    assert.equal(store.verifyInteractionRequestIntegrity("task_1", "permission-legacy").ok, true, "a small legacy record without metadata stays compatible");

    // Partial metadata: only the byte count survives.
    store.writeInteractionRequest("task_1", permissionRequest({ input: { command: "npm run build" } }, "permission-partial"));
    const partial = readRecordFile(store, "task_1", "permission-partial");
    delete partial.params_sha256;
    writeRecordFile(store, "task_1", "permission-partial", partial);
    const partialVerdict = store.verifyInteractionRequestIntegrity("task_1", "permission-partial");
    assert.equal(partialVerdict.ok, false);
    assert.match((partialVerdict as { reason: string }).reason, /incomplete integrity metadata/i);

    // Wrong types: byte count as a string, SHA256 as a number.
    store.writeInteractionRequest("task_1", permissionRequest({ input: { command: "npm run check" } }, "permission-wrongtypes"));
    const wrong = readRecordFile(store, "task_1", "permission-wrongtypes");
    wrong.params_bytes = String(wrong.params_bytes);
    wrong.params_sha256 = Number.parseInt(String(wrong.params_sha256).slice(0, 8), 16);
    writeRecordFile(store, "task_1", "permission-wrongtypes", wrong);
    const wrongVerdict = store.verifyInteractionRequestIntegrity("task_1", "permission-wrongtypes");
    assert.equal(wrongVerdict.ok, false);
    assert.match((wrongVerdict as { reason: string }).reason, /not a valid non-negative integer|not a valid 64-character hex digest/i);

    // A large no-metadata record is not legacy.
    store.writeInteractionRequest("task_1", permissionRequest(padParams(33 * 1024), "permission-stripped-large"));
    const stripped = readRecordFile(store, "task_1", "permission-stripped-large");
    delete stripped.params_bytes;
    delete stripped.params_sha256;
    writeRecordFile(store, "task_1", "permission-stripped-large", stripped);
    const strippedVerdict = store.verifyInteractionRequestIntegrity("task_1", "permission-stripped-large");
    assert.equal(strippedVerdict.ok, false);
    assert.match((strippedVerdict as { reason: string }).reason, /no integrity metadata|legacy/i);
  } finally {
    await cleanup();
  }
});

test("verification still enforces the 1 MiB persistence limit even with self-consistent metadata", async () => {
  const { store, cleanup } = await storeFixture();
  try {
    // writeInteractionRequest would reject this size, so the over-limit record
    // is produced the way an editor would: start from a persisted record, then
    // swap in larger params with recomputed, internally consistent metadata.
    store.writeInteractionRequest("task_1", permissionRequest({ input: { command: "npm test" } }, "permission-over-limit"));
    const params = padParams(MAX_INTERACTION_PARAMS_BYTES + 512);
    const serialized = JSON.stringify(params);
    const record: Record<string, unknown> = {
      request_id: "permission-over-limit",
      method: "interaction/requestPermission",
      params,
      state: "pending",
      created_at: "2026-10-14T00:00:00.000Z",
      params_bytes: Buffer.byteLength(serialized, "utf8"),
      params_sha256: createHash("sha256").update(serialized).digest("hex"),
    };
    writeRecordFile(store, "task_1", "permission-over-limit", record);
    const verdict = store.verifyInteractionRequestIntegrity("task_1", "permission-over-limit");
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /over the 1048576-byte persistence limit/i);
  } finally {
    await cleanup();
  }
});

test("approving a large record whose metadata was stripped is refused and never recorded as granted", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(40 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    const requestId = String(event.details?.["request_id"]);
    const record = readRecordFile(fx.store, "task_1", requestId);
    delete record.params_bytes;
    delete record.params_sha256;
    writeRecordFile(fx.store, "task_1", requestId, record);
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: requestId, decision: "allow" }),
      (error: unknown) => {
        if (!(error instanceof TaskManagerError)) return false;
        assert.equal(error.code, "TASK_STATE");
        assert.match(error.message, /cannot be approved/);
        assert.match(error.message, /not recorded as granted/);
        return true;
      },
    );
    // The refusal left the record pending with no answer at all.
    const after = fx.store.readInteractionRequest("task_1", requestId);
    assert.equal(after?.state, "pending");
    assert.equal(after?.answer, undefined);
    // End the run deterministically; nothing may have executed.
    await fx.manager.replyToInteraction({ task_id: "task_1", request_id: requestId, decision: "deny", reason: "test teardown" });
    const { result } = await run;
    assert.equal(result.status, "completed");
    assert.equal(existsSync(runtime.artifactPath), false);
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("the full record disappearing mid-wait declines explicitly instead of polling forever", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(40 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    const requestId = String(event.details?.["request_id"]);
    rmSync(fx.store.interactionRequestPath("task_1", requestId));
    // The run must finish on its own with an explicit decline — no pending
    // approval hangs waiting for a record that no longer exists.
    const { result } = await run;
    assert.equal(result.status, "completed");
    const events = fx.store.readEvents("task_1", 0, 200).events;
    const missing = events.find((item) => item.type === "interaction_request_undeliverable" && item.details?.["error_code"] === "interaction_record_missing");
    assert.ok(missing, "an explicit interaction_record_missing event must be published");
    const replies = (await readFile(runtime.requestLog, "utf8")).trim().split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry["reply"]) as Array<{ reply: { decision?: string; reason?: string } }>;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.reply.decision, "deny");
    assert.match(replies[0]!.reply.reason ?? "", /disappeared|can no longer read the full content/);
    assert.equal(existsSync(runtime.artifactPath), false);
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});

test("an answered record whose params were edited (self-consistent metadata) is not consumed as authorization", { timeout: 60_000 }, async () => {
  const fx = await makeManagerFixture();
  const runtime = await makeInteractionRuntime(40 * 1024);
  try {
    await fx.manager.createTask(fx.makeTask());
    const attempt = fx.store.readStatus("task_1").attempt;
    const run = runWorkerTask({
      dataRoot: fx.dataRoot,
      taskId: "task_1",
      attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const event = await waitForInteractionEvent(fx.store, "task_1");
    const requestId = String(event.details?.["request_id"]);
    // Simulate a thorough edit: different params with recomputed metadata and
    // an allow answer. The file is internally consistent, so only comparison
    // against the worker's original safeRequest can catch it.
    const record = readRecordFile(fx.store, "task_1", requestId);
    record.params = { ...record.params, input: { path: runtime.artifactPath, content: "TAMPERED-BUT-CONSISTENT" } };
    const serialized = JSON.stringify(record.params);
    record.params_bytes = Buffer.byteLength(serialized, "utf8");
    record.params_sha256 = createHash("sha256").update(serialized).digest("hex");
    record.state = "answered";
    record.answer = { decision: "allow" };
    record.answered_at = "2026-10-14T00:00:00.000Z";
    writeRecordFile(fx.store, "task_1", requestId, record);
    const { result } = await run;
    assert.equal(result.status, "completed");
    const events = fx.store.readEvents("task_1", 0, 200).events;
    const mismatch = events.find((item) => item.type === "interaction_request_undeliverable" && item.details?.["error_code"] === "interaction_record_mismatch");
    assert.ok(mismatch, "an explicit interaction_record_mismatch event must be published");
    const replies = (await readFile(runtime.requestLog, "utf8")).trim().split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry["reply"]) as Array<{ reply: { decision?: string; reason?: string } }>;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.reply.decision, "deny");
    assert.match(replies[0]!.reply.reason ?? "", /no longer matches the request ZCode sent/);
    assert.equal(existsSync(runtime.artifactPath), false, "the edited input must not execute even though the file claimed an allow");
  } finally {
    await cleanupE2E(fx, runtime.root);
  }
});
