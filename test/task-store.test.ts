// TaskStore tests: atomic JSON persistence, bounded separate logs, terminal
// results, attempt archives, and task-id path safety.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";

test("create/read roundtrip and duplicate rejection", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    const createdAt = "2026-09-27T00:00:00.000Z";
    store.createTask(makeTask(), createdAt);
    assert.equal(store.readTask("task_1").objective, makeTask().objective);
    const status = store.readStatus("task_1");
    assert.equal(status.status, "queued");
    assert.equal(status.attempt, 1);
    assert.equal(status.created_at, createdAt);
    assert.deepEqual(store.listTaskIds(), ["task_1"]);
    assert.throws(() => store.createTask(makeTask(), createdAt), /already exists/);
    assert.equal(store.readResult("task_1"), null);
  } finally {
    await removeTempDir(root);
  }
});

test("interaction requests are durable, deduplicated, and answered atomically", async () => {
  const root = await makeTempDir("store-interaction");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    const request = {
      request_id: "permission/request:1",
      method: "interaction/requestPermission" as const,
      params: { sessionId: "session-1", toolName: "Bash", input: { command: "npm test" } },
    };
    const created = store.writeInteractionRequest("task_1", request, "2026-09-27T00:00:01.000Z");
    assert.equal(created.created, true);
    assert.equal(created.record.state, "pending");
    const duplicate = store.writeInteractionRequest("task_1", request, "2026-09-27T00:00:02.000Z");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.created_at, "2026-09-27T00:00:01.000Z");
    assert.equal(store.answerInteractionRequest("task_1", request.request_id, { decision: "deny" }, "2026-09-27T00:00:03.000Z"), "answered");
    const persisted = store.readInteractionRequest("task_1", request.request_id);
    assert.deepEqual({
      request_id: persisted?.request_id,
      method: persisted?.method,
      params: persisted?.params,
      state: persisted?.state,
      created_at: persisted?.created_at,
      answer: persisted?.answer,
      answered_at: persisted?.answered_at,
    }, {
      ...request,
      state: "answered",
      created_at: "2026-09-27T00:00:01.000Z",
      answer: { decision: "deny" },
      answered_at: "2026-09-27T00:00:03.000Z",
    });
    // ADR-008 metadata: byte count and SHA256 over the serialized params.
    assert.equal(persisted?.params_bytes, Buffer.byteLength(JSON.stringify(request.params), "utf8"));
    assert.equal(
      persisted?.params_sha256,
      createHash("sha256").update(JSON.stringify(request.params)).digest("hex"),
    );
    assert.equal(store.answerInteractionRequest("task_1", request.request_id, { decision: "allow" }), "already_answered");
    assert.equal(store.readInteractionRequest("task_1", "missing"), null);
  } finally {
    await removeTempDir(root);
  }
});

test("interaction params persist complete up to 1 MiB (ADR-008); the old 32 KB limit is gone", async () => {
  const root = await makeTempDir("store-interaction-large");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    // A Write-tool permission payload above the old 32,000-byte limit (the
    // production failure: "exceeded the 32 KB persistence limit").
    const medium = { toolName: "Write", input: { path: "fixture.txt", content: "w".repeat(40 * 1024) } };
    const created = store.writeInteractionRequest("task_1", {
      request_id: "permission/40k",
      method: "interaction/requestPermission",
      params: medium,
    });
    assert.equal(created.created, true);
    assert.deepEqual(store.readInteractionRequest("task_1", "permission/40k")?.params, medium);
    // Exactly 1 MiB of serialized params is still accepted.
    const envelopeOverhead = Buffer.byteLength(JSON.stringify({ pad: "" }), "utf8");
    const atLimit = { pad: "x".repeat(1024 * 1024 - envelopeOverhead) };
    assert.equal(Buffer.byteLength(JSON.stringify(atLimit), "utf8"), 1024 * 1024);
    assert.equal(
      store.writeInteractionRequest("task_1", { request_id: "permission/limit", method: "interaction/requestPermission", params: atLimit }).created,
      true,
    );
  } finally {
    await removeTempDir(root);
  }
});

test("task evidence uses private POSIX permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows access is controlled by inherited ACLs rather than POSIX mode bits");
    return;
  }
  const root = await makeTempDir("store-private");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask({ task_id: "private_task" }), new Date().toISOString());
    store.appendLog("private_task", "stdout", "private evidence");
    assert.equal(statSync(path.join(root, ".tasks")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, ".tasks", "private_task")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, ".tasks", "private_task", "task.json")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(root, ".tasks", "private_task", "stdout.log")).mode & 0o777, 0o600);
  } finally {
    await removeTempDir(root);
  }
});

test("invalid task ids are rejected before touching the filesystem", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    for (const bad of ["../evil", "a/b", ".hidden", "x".repeat(65), ""]) {
      assert.throws(
        () => store.taskDir(bad),
        /invalid task_id/,
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () => store.createTask(makeTask({ task_id: "../evil" }), "2026-09-27T00:00:00.000Z"),
      /invalid task_id/,
    );
    assert.deepEqual(store.listTaskIds(), []);
  } finally {
    await removeTempDir(root);
  }
});

test("writeStatus merges patches, bumps updated_at, and leaves no temp files", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    const updated = store.writeStatus("task_1", {
      status: "running",
      worker_pid: 4242,
      started_at: "2026-09-27T00:00:01.000Z",
    });
    assert.equal(updated.status, "running");
    assert.equal(updated.worker_pid, 4242);
    assert.equal(updated.attempt, 1, "unpatched fields survive the merge");
    const reread = store.readStatus("task_1");
    assert.equal(reread.worker_pid, 4242);
    // Nulls clear optional fields.
    store.writeStatus("task_1", { worker_pid: null });
    assert.equal(store.readStatus("task_1").worker_pid, null);
    // No *.tmp leftovers anywhere in the task dir.
    const leftovers = readdirSync(path.join(root, ".tasks", "task_1"), { recursive: true })
      .filter((name) => String(name).endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await removeTempDir(root);
  }
});

test("corrupt status records are reported, not silently accepted", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(root, ".tasks", "task_1", "status.json"), "{{{", "utf8");
    assert.throws(() => store.readStatus("task_1"));
  } finally {
    await removeTempDir(root);
  }
});

test("logs are append-only, separate, and byte-bounded", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root, { maxLogBytes: 64 });
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    assert.equal(store.appendLog("task_1", "stdout", "o".repeat(200)).truncated, true);
    assert.equal(store.appendLog("task_1", "stderr", "e".repeat(10)).truncated, false);
    const stdout = store.readLog("task_1", "stdout");
    const stderr = store.readLog("task_1", "stderr");
    assert.ok(Buffer.byteLength(stdout, "utf8") <= 64);
    assert.equal(stderr, "e".repeat(10), "stderr must not be affected by the stdout cap");
    // Further appends beyond the cap are dropped.
    store.appendLog("task_1", "stdout", "more");
    assert.equal(Buffer.byteLength(store.readLog("task_1", "stdout"), "utf8"), 64);
  } finally {
    await removeTempDir(root);
  }
});

test("archive preserves the current result until the continuation status is committed", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    assert.equal(store.readResult("task_1"), null);
    const result = {
      task_id: "task_1",
      status: "completed" as const,
      summary: "done",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
      zcode_output: "",
      exit_code: 0,
      session_id: "sess_x",
      attempt: 1,
      started_at: null,
      finished_at: "2026-09-27T00:00:05.000Z",
    };
    store.writeResult("task_1", result);
    assert.equal(store.readResult("task_1")?.summary, "done");
    store.writeAttemptMeta("task_1", 1, "outcome.json", { ok: true });
    store.writeAttemptFile("task_1", 1, "prompt.txt", "PROMPT TEXT");
    store.archiveResultToAttempt("task_1", 1);
    assert.equal(store.readResult("task_1")?.summary, "done", "the previous result remains recoverable before status commit");
    store.writeStatus("task_1", { status: "queued", attempt: 2 });
    assert.equal(store.readResult("task_1"), null, "a previous attempt result cannot complete the new attempt");
    assert.equal(store.readArchivedResult("task_1", 1)?.summary, "done");
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "outcome.json"), { ok: true });
    assert.equal(store.readAttemptText("task_1", 1, "prompt.txt"), "PROMPT TEXT");
    assert.ok(existsSync(path.join(root, ".tasks", "task_1", "attempts", "1", "result.json")));
  } finally {
    await removeTempDir(root);
  }
});
