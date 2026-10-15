// ADR-008 regression tests: newline-delimited JSON-RPC frame transport on the
// app-server stdout stream. The old code applied the 2,000,000-character model
// text capture limit to the whole stdout buffer, so a legal ~2.1 MB
// session/resume frame (observed 2,139,927 UTF-8 bytes in production) rejected
// only the turn while the pending RPC waited for its 30 s timeout, and
// invalid lines kept the stream parsing. These tests pin the new contract:
// per-frame 16 MiB UTF-8 byte limit, frame-by-frame consumption, immediate
// fatal failure that ends pending RPCs and the turn wait, and bounded text
// capture that keeps its 2,000,000-character boundary.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { isProcessRunning } from "../src/adapters/process-spawn.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { makeWorkspace, SESSION_ID, validReport } from "./helpers.js";

const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
const CAPTURE_CHARS = 2_000_000;

const task: TaskPackage = {
  task_id: "frame_transport_test",
  workspace: "C:\\unused",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

type FrameMode =
  | { kind: "plain" }
  | { kind: "split"; chunkBytes: number };

interface ProtocolRuntimeOptions {
  /** session/resume result snapshot padding, in characters. */
  resumePadChars?: number;
  /** After session/send: coalesce this many padded session/event frames plus
   * turn.completed into one stdout write (each frame stays far below 16 MiB
   * while the total exceeds it). */
  coalescePaddedEvents?: number;
  /** Reply to session/subscribe with an over-limit frame instead of a result. */
  oversizeInsteadOfSubscribeReply?: number;
  /** Write an invalid JSON line when this method arrives, then a valid reply. */
  badJsonOn?: "subscribe";
  /** Write this literal line in the SAME stdout write as the legal
   * session/resume reply (review R1: valid response and fatal frame in one
   * chunk). The line must be a fatal wire defect, e.g. "{" or "null". */
  fatalLineAfterResume?: string;
  /** Reply to session/subscribe with a tiny JSON frame padded past the frame
   * limit by trailing spaces: trimmed it is small, raw it is over the limit. */
  paddedOversizeSubscribeReply?: boolean;
  /** turn.completed payload.response length in characters. */
  responseChars?: number;
  /** All writes are split into fixed byte chunks with yields between them. */
  writeMode?: FrameMode;
}

interface ProtocolRuntime {
  root: string;
  requestLog: string;
  config: ZCodeRuntimeConfig;
}

async function makeProtocolRuntime(options: ProtocolRuntimeOptions = {}): Promise<ProtocolRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-frames-test-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const sessionId = ${JSON.stringify(SESSION_ID)};
const requestLog = ${JSON.stringify(requestLog)};
const resumePadChars = ${JSON.stringify(options.resumePadChars ?? 0)};
const coalescePaddedEvents = ${JSON.stringify(options.coalescePaddedEvents ?? 0)};
const oversizeBytes = ${JSON.stringify(options.oversizeInsteadOfSubscribeReply ?? 0)};
const badJsonOn = ${JSON.stringify(options.badJsonOn ?? "")};
const fatalLineAfterResume = ${JSON.stringify(options.fatalLineAfterResume ?? "")};
const paddedOversizeSubscribe = ${JSON.stringify(options.paddedOversizeSubscribeReply ?? false)};
const responseChars = ${JSON.stringify(options.responseChars ?? 0)};
const writeMode = ${JSON.stringify(options.writeMode ?? { kind: "plain" })};
const frameLimitBytes = ${JSON.stringify(FRAME_LIMIT_BYTES)};
const captureChars = ${JSON.stringify(CAPTURE_CHARS)};
const report = ${JSON.stringify(validReport())};
let turnFinished = false;
// Serialized write queue: split-mode writes must not interleave frames.
const pendingWrites = [];
let writing = false;
function writeRaw(text) { process.stdout.write(text); }
function write(text) {
  pendingWrites.push(text);
  if (writing) return;
  writing = true;
  const drain = () => {
    const next = pendingWrites.shift();
    if (next === undefined) { writing = false; return; }
    if (writeMode.kind !== "split") { writeRaw(next); setImmediate(drain); return; }
    const buf = Buffer.from(next, "utf8");
    let offset = 0;
    const step = () => {
      if (offset >= buf.length) { setImmediate(drain); return; }
      const end = Math.min(buf.length, offset + writeMode.chunkBytes);
      process.stdout.write(buf.subarray(offset, end));
      offset = end;
      setImmediate(step);
    };
    step();
  };
  drain();
}
function line(value) { write(JSON.stringify(value) + "\n"); }
function snapshot(padChars) {
  const base = {
    session: { sessionId },
    settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [{ ref: { providerId: "provider-default", modelId: "model-default" }, label: "Test Model" }] } },
    runtime: { eventSeq: 0 },
  };
  if (padChars > 0) base.padding = "p".repeat(padChars);
  return base;
}
function finishTurn() {
  if (turnFinished) return;
  turnFinished = true;
  const response = responseChars > 0 ? "r".repeat(responseChars) : JSON.stringify(report);
  line({ method: "session/event", params: { seq: 1000, type: "turn.completed", payload: { response, usage: { totalTokens: 4 }, resultType: "success" } } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (text) => {
  const message = JSON.parse(text);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "provider/updateAccountConfig") {
    line({ id: message.id, result: { status: "accepted" } });
  } else if (message.method === "session/create") {
    line({ id: message.id, result: snapshot(0) });
  } else if (message.method === "session/resume") {
    if (fatalLineAfterResume) {
      // One stdout write: the legal resume reply frame, then the fatal line.
      // The pending resume resolves from the first frame; the second must
      // latch a fatal protocol reason before the adapter can issue more RPCs.
      write(JSON.stringify({ id: message.id, result: snapshot(resumePadChars) }) + "\n" + fatalLineAfterResume + "\n");
      return;
    }
    line({ id: message.id, result: snapshot(resumePadChars) });
  } else if (message.method === "session/setMode" || message.method === "session/setModel") {
    line({ id: message.id, result: snapshot(0) });
  } else if (message.method === "session/subscribe") {
    if (oversizeBytes > 0) {
      // A frame whose buffered tail crosses the limit before any newline.
      write("x".repeat(oversizeBytes));
      return;
    }
    if (paddedOversizeSubscribe) {
      // Trimmed this frame is tiny; its raw untrimmed bytes are over the limit.
      write(JSON.stringify({ id: message.id, result: {} }) + " ".repeat(frameLimitBytes + 65536) + "\n");
      return;
    }
    if (badJsonOn === "subscribe") {
      write('{"id":' + message.id + ',"res\n');
      line({ id: message.id, result: {} });
      return;
    }
    line({ id: message.id, result: {} });
  } else if (message.method === "session/send") {
    line({ id: message.id, result: {} });
    if (coalescePaddedEvents > 0) {
      // One write whose total exceeds the frame limit while every individual
      // frame stays below it.
      let blob = "";
      for (let index = 1; index <= coalescePaddedEvents; index += 1) {
        blob += JSON.stringify({ method: "session/event", params: { sessionId, seq: index, type: "notification", payload: { pad: "n".repeat(2_500_000) } } }) + "\n";
      }
      blob += JSON.stringify({ method: "session/event", params: { sessionId, seq: 1000, type: "turn.completed", payload: { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" } } }) + "\n";
      turnFinished = true;
      write(blob);
      return;
    }
    finishTurn();
  } else if (message.id !== undefined) {
    line({ id: message.id, result: {} });
  }
});
input.on("close", () => process.exit(0));
void frameLimitBytes; void captureChars;
`;
  await writeFile(entrypoint, script, "utf8");
  return {
    root,
    requestLog,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
  };
}

function makeAdapter(
  runtime: ProtocolRuntime,
  events: Array<{ type: string; summary: string; details?: Record<string, unknown> }>,
  timeoutMs = 12_000,
): ZCodeAppServerAdapter {
  return new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    onEvent: (event) => events.push(event),
    timeoutMs,
    childEnvBase: { PATH: process.env.PATH },
    homeDir: runtime.root,
  });
}

test("a legal session/resume frame larger than the old 2M-char capture limit completes instead of masquerading as a timeout", { timeout: 30_000 }, async () => {
  // 2,100,000 chars reproduces the production resume frame (2,139,927 UTF-8
  // bytes / 2,039,924 chars) that the old whole-buffer 2,000,000-char check
  // turned into a fake 30 s RPC timeout.
  const runtime = await makeProtocolRuntime({ resumePadChars: 2_100_000 });
  try {
    const adapter = makeAdapter(runtime, []);
    const startedAt = Date.now();
    const handle = await adapter.continueTask({
      task,
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
      feedback: "diagnostic only",
      additionalRequirements: [],
      previousSessionId: SESSION_ID,
      previousResult: null,
    });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, SESSION_ID);
    assert.ok(Date.now() - startedAt < 10_000, "resume must complete promptly, not wait for the 30 s RPC timeout");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("many legal frames coalesced into one write are consumed frame by frame; their sum is never treated as one oversized frame", { timeout: 60_000 }, async () => {
  const runtime = await makeProtocolRuntime({ coalescePaddedEvents: 8 }); // 8 x ~2.5 MB > 16 MiB total
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = makeAdapter(runtime, events, 60_000);
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.ok(events.some((event) => event.type === "turn_completed"), "the final turn.completed frame must still be parsed after the large coalesced write");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a frame over the 16 MiB limit fails immediately, ends the pending RPC with the protocol reason, and stops buffering", { timeout: 30_000 }, async () => {
  const runtime = await makeProtocolRuntime({ oversizeInsteadOfSubscribeReply: FRAME_LIMIT_BYTES + 65_536 });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  let runtimePid: number | undefined;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "app_server_started") runtimePid = event.details?.["pid"] as number;
      },
      timeoutMs: 12_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const startedAt = Date.now();
    await assert.rejects(
      adapter.getResult(handle),
      (error: unknown) => {
        // The pending session/subscribe RPC must end with the protocol reason,
        // not a 30 s timeout, and the message must carry safe size fields.
        assert.ok(error instanceof BridgeError);
        assert.match(error.message, /frame exceeded the 16 MiB/i);
        assert.match(error.message, /16777216/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 10_000, "the over-limit frame must fail well before the 30 s RPC timeout");
    const protocolError = events.find((event) => event.type === "protocol_error");
    assert.ok(protocolError, "a protocol_error event with a stable reason must be published");
    assert.equal(protocolError?.details?.["error_code"], "frame_over_limit");
    assert.equal(protocolError?.details?.["limit_bytes"], FRAME_LIMIT_BYTES);
    const observedBytes = protocolError?.details?.["frame_bytes"];
    assert.ok(typeof observedBytes === "number" && observedBytes > FRAME_LIMIT_BYTES, "the observed frame byte count must be reported");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(runtimePid);
    assert.equal(isProcessRunning(runtimePid), false, "the runtime process must be cleaned up after the fatal protocol error");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("an invalid JSON frame fails immediately; frames after it are not parsed and pending RPCs end with the protocol reason", { timeout: 30_000 }, async () => {
  const runtime = await makeProtocolRuntime({ badJsonOn: "subscribe" });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = makeAdapter(runtime, events);
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const startedAt = Date.now();
    await assert.rejects(
      adapter.getResult(handle),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.match(error.message, /invalid JSON frame/i);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 10_000, "the invalid frame must fail well before the 30 s RPC timeout");
    const protocolError = events.find((event) => event.type === "protocol_error");
    assert.ok(protocolError);
    assert.equal(protocolError?.details?.["error_code"], "invalid_frame");
    // The valid subscribe reply written after the garbage line must never be
    // consumed, so the run cannot proceed to session/send.
    const requests = (await readFile(runtime.requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/send"), false, "the turn prompt must not be sent after a fatal frame");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("frames fragmented across chunk boundaries, including multi-byte UTF-8 split mid-sequence, reassemble exactly", { timeout: 30_000 }, async () => {
  const multibyte = "帧边界🚀中文テスト — payload with multi-byte characters";
  const root = await mkdtemp(path.join(tmpdir(), "bridge-frames-split-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const report = validReport({ summary: multibyte });
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const sessionId = ${JSON.stringify(SESSION_ID)};
const requestLog = ${JSON.stringify(requestLog)};
const report = ${JSON.stringify(report)};
function snapshot() {
  return {
    session: { sessionId },
    settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [{ ref: { providerId: "provider-default", modelId: "model-default" }, label: "Test Model" }] } },
    runtime: { eventSeq: 0 },
  };
}
// Byte-level 7-byte chunks split multi-byte UTF-8 sequences across data
// events on purpose. Writes are serialized so frames never interleave.
const writeQueue = [];
let draining = false;
function write(text) {
  writeQueue.push(text);
  if (draining) return;
  draining = true;
  const drain = () => {
    const next = writeQueue.shift();
    if (next === undefined) { draining = false; return; }
    const buf = Buffer.from(next, "utf8");
    let offset = 0;
    const step = () => {
      if (offset >= buf.length) { drain(); return; }
      const end = Math.min(buf.length, offset + 7);
      process.stdout.write(buf.subarray(offset, end));
      offset = end;
      setImmediate(step);
    };
    step();
  };
  drain();
}
function line(value) { write(JSON.stringify(value) + "\n"); }
const input = readline.createInterface({ input: process.stdin });
input.on("line", (text) => {
  const message = JSON.parse(text);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "session/create" || message.method === "session/setMode" || message.method === "session/setModel") {
    line({ id: message.id, result: snapshot() });
  } else if (message.method === "session/subscribe") {
    line({ id: message.id, result: {} });
  } else if (message.method === "session/send") {
    line({ id: message.id, result: {} });
    line({ method: "session/event", params: { seq: 1, type: "model.streaming", payload: { kind: "text_delta", delta: ${JSON.stringify(multibyte)} } } });
    line({ method: "session/event", params: { seq: 2, type: "turn.completed", payload: { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" } } });
  } else if (message.id !== undefined) {
    line({ id: message.id, result: {} });
  }
});
input.on("close", () => process.exit(0));
`;
  await writeFile(entrypoint, script, "utf8");
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: {
        resolve: async () => ({
          nodeExecutable: process.execPath,
          zcodeEntrypoint: entrypoint,
          providerBuiltinConfigFile: path.join(root, "builtin.json"),
          providerPersonalConfigFile: path.join(root, "personal.json"),
          dataRoot: root,
        }),
      },
      onEvent: (event) => events.push(event),
      timeoutMs: 12_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: root,
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.agentReport?.summary, multibyte);
    const output = events.find((event) => event.type === "model_output");
    assert.equal(output?.summary, multibyte, "streamed deltas split mid-codepoint must reassemble exactly");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured turn text keeps the 2,000,000-character boundary and reports truncation", { timeout: 30_000 }, async () => {
  const runtime = await makeProtocolRuntime({ responseChars: CAPTURE_CHARS + 500_000 });
  try {
    const adapter = makeAdapter(runtime, []);
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    // The oversized response cannot parse as a report; the bounded capture and
    // the truncation flag are the contract here.
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.response?.length, CAPTURE_CHARS);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a response under the capture boundary is never marked truncated", { timeout: 30_000 }, async () => {
  const runtime = await makeProtocolRuntime({});
  try {
    const adapter = makeAdapter(runtime, []);
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutTruncated, false);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

// ---- Review R1 regressions: fatal latching must survive past a resolved RPC,
// non-object frames are wire defects, and the limit uses raw untrimmed bytes. ----

async function readRequestMethods(runtime: ProtocolRuntime): Promise<string[]> {
  const log = await readFile(runtime.requestLog, "utf8");
  return log.trim().split("\n").filter((line) => line.trim()).map((line) => (JSON.parse(line) as { method?: string }).method ?? "");
}

test("a bad-JSON frame in the same chunk as a legal resume reply latches the fatal reason and blocks every later request", { timeout: 30_000 }, async () => {
  // Review R1 case 1: the resume RPC already resolved from the legal frame in
  // the same chunk; the old code still issued session/setMode afterwards and
  // the latched reason was finally masked by the wall-clock budget.
  const runtime = await makeProtocolRuntime({ fatalLineAfterResume: "{" });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = makeAdapter(runtime, events);
    const handle = await adapter.continueTask({
      task,
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
      feedback: "diagnostic only",
      additionalRequirements: [],
      previousSessionId: SESSION_ID,
      previousResult: null,
    });
    const startedAt = Date.now();
    await assert.rejects(
      adapter.getResult(handle),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.match(error.message, /invalid JSON frame/i);
        assert.doesNotMatch(error.message, /wall-clock|timed out/i, "the latched protocol reason must not be masked by a timeout");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 10_000, "the fatal frame must fail fast, not at the wall-clock budget");
    const protocolError = events.find((event) => event.type === "protocol_error");
    assert.ok(protocolError);
    assert.equal(protocolError?.details?.["error_code"], "invalid_frame");
    const methods = await readRequestMethods(runtime);
    assert.equal(methods.includes("session/setMode"), false, "no request may be issued after the fatal frame");
    assert.equal(methods.includes("session/subscribe"), false, "no request may be issued after the fatal frame");
    assert.equal(methods.includes("session/send"), false, "the turn prompt must not be sent after the fatal frame");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("null, array, and scalar top-level frames are invalid frames; the fatal latch blocks later requests", { timeout: 60_000 }, async () => {
  // Review R1 case 2: JSON.parse succeeds on these values, but a JSON-RPC
  // frame's top level must be an object. The old code threw a handler
  // TypeError and kept issuing setMode, subscribe, and session/send.
  for (const fatalLine of ["null", "[]", "42"]) {
    const runtime = await makeProtocolRuntime({ fatalLineAfterResume: fatalLine });
    const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
    try {
      const adapter = makeAdapter(runtime, events);
      const handle = await adapter.continueTask({
        task,
        workspace: makeWorkspace(runtime.root),
        attempt: 1,
        feedback: "diagnostic only",
        additionalRequirements: [],
        previousSessionId: SESSION_ID,
        previousResult: null,
      });
      await assert.rejects(
        adapter.getResult(handle),
        (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.match(error.message, /invalid JSON frame/i);
          assert.match(error.message, /top-level frame value must be a JSON object/i);
          return true;
        },
      );
      const protocolError = events.find((event) => event.type === "protocol_error");
      assert.equal(protocolError?.details?.["error_code"], "invalid_frame");
      const methods = await readRequestMethods(runtime);
      assert.equal(methods.includes("session/setMode"), false, `no request after a fatal ${fatalLine} frame`);
      assert.equal(methods.includes("session/send"), false, `no request after a fatal ${fatalLine} frame`);
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  }
});

test("the frame limit is judged on raw untrimmed frame bytes; whitespace padding cannot shrink a frame below the limit", { timeout: 30_000 }, async () => {
  // Review R1 case 3: a tiny JSON frame padded past 16 MiB with trailing
  // spaces trims to a few bytes; the raw frame must still be rejected.
  const runtime = await makeProtocolRuntime({ paddedOversizeSubscribeReply: true });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = makeAdapter(runtime, events);
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const startedAt = Date.now();
    await assert.rejects(
      adapter.getResult(handle),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.match(error.message, /frame exceeded the 16 MiB/i);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 10_000, "the padded over-limit frame must fail well before the RPC timeout");
    const protocolError = events.find((event) => event.type === "protocol_error");
    assert.ok(protocolError);
    assert.equal(protocolError?.details?.["error_code"], "frame_over_limit");
    const observedBytes = protocolError?.details?.["frame_bytes"];
    assert.ok(typeof observedBytes === "number" && observedBytes > FRAME_LIMIT_BYTES, "the raw untrimmed byte count must be reported over the limit");
    const methods = await readRequestMethods(runtime);
    assert.equal(methods.includes("session/send"), false, "the turn prompt must not be sent after the fatal frame");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});
