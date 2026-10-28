// ADR-010 App pipe adapter tests against a REAL Unix domain socket fixture
// (skipped on platforms without AF_UNIX support in the test environment).
// Verifies the length-prefixed JSON-RPC framing under arbitrarily chunked
// writes, request identity, error surfaces, size guards, and timeouts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import {
  APP_PIPE_REQUEST_ID,
  APP_PIPE_TURN_ID,
  buildAppPipeRequest,
  encodeAppPipeFrame,
} from "../src/schedule/app-protocol.js";
import { sendAppPipeNotification } from "../src/schedule/app-notify.js";

const THREAD_ID = "01a180cd-16ce-7e82-9741-5f467ff05a1a";

function buildAppPipeSuccessResponse(threadId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: APP_PIPE_REQUEST_ID,
    result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ threadId }) }] },
  });
}

test("request body matches the verified codex-app-tools call shape", () => {
  const request = buildAppPipeRequest({ threadId: THREAD_ID, prompt: "hello", callId: "call-1" });
  assert.equal(request.jsonrpc, "2.0");
  assert.equal(request.id, APP_PIPE_REQUEST_ID);
  assert.equal(request.method, "tools/call");
  assert.deepEqual(request.params, {
    arguments: { threadId: THREAD_ID, hostId: "local", prompt: "hello" },
    callerSource: "codex",
    callId: "call-1",
    namespace: "codex_app",
    threadId: THREAD_ID,
    tool: "send_message_to_thread",
    turnId: APP_PIPE_TURN_ID,
  });
});

test("frame encodes a uint32-LE length prefix over the UTF-8 payload", () => {
  const payload = JSON.stringify(buildAppPipeRequest({ threadId: THREAD_ID, prompt: "hello", callId: "c" }));
  const frame = encodeAppPipeFrame(payload);
  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(payload, "utf8"));
  assert.equal(frame.subarray(4).toString("utf8"), payload);
});

interface Fixture {
  readonly socketPath: string;
  respond: (handler: (request: string, socket: net.Socket) => void) => void;
  requests: string[];
}

async function withPipeServer(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-app-pipe-"));
  const socketPath = path.join(dir, "tools.sock");
  const requests: string[] = [];
  let handler: ((request: string, socket: net.Socket) => void) | null = null;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (expected === null && buffer.length >= 4) {
        expected = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }
      if (expected !== null && buffer.length >= expected) {
        const request = buffer.subarray(0, expected).toString("utf8");
        requests.push(request);
        buffer = Buffer.alloc(0);
        expected = null;
        handler?.(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run({
      socketPath,
      requests,
      respond: (next) => { handler = next; },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (fixture: Fixture, timeoutMs = 2_000) =>
  sendAppPipeNotification({ pipePath: fixture.socketPath, threadId: THREAD_ID, callId: "call-test", prompt: "wakeup", timeoutMs });

// Chunked writes emulate the App flushing partial frames; identity checks
// need the full body regardless of chunk boundaries.
function writeChunked(socket: net.Socket, text: string): void {
  const payload = Buffer.from(text, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  const whole = Buffer.concat([prefix, payload]);
  for (let i = 0; i < whole.length; i += 3) socket.write(whole.subarray(i, i + 3));
}

const socketTest = (name: string, run: (fixture: Fixture) => Promise<void>) =>
  test(name, { skip: process.platform === "win32" ? "AF_UNIX fixture not run on Windows CI" : false }, async () => withPipeServer(run));

socketTest("success receipt accepted across a fragmented response", async (fixture) => {
  fixture.respond((_request, socket) => {
    writeChunked(socket, buildAppPipeSuccessResponse(THREAD_ID));
  });
  await send(fixture);
  assert.equal(fixture.requests.length, 1);
  const sent = JSON.parse(fixture.requests[0]!);
  assert.equal(sent.params.arguments.threadId, THREAD_ID);
  assert.equal(sent.params.tool, "send_message_to_thread");
});

socketTest("response with a mismatched JSON-RPC id is rejected", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: THREAD_ID }) }] } })));
  });
  await assert.rejects(send(fixture), /response id does not match/);
});

socketTest("JSON-RPC error does not count as delivery", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(JSON.stringify({ jsonrpc: "2.0", id: APP_PIPE_REQUEST_ID, error: { code: -32000, message: "thread not found" } })));
  });
  await assert.rejects(send(fixture), /rejected the wakeup request/);
});

socketTest("success=false is not delivery", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(JSON.stringify({ jsonrpc: "2.0", id: APP_PIPE_REQUEST_ID, result: { success: false } })));
  });
  await assert.rejects(send(fixture), /did not confirm successful delivery/);
});

socketTest("receipt for another thread is rejected", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(buildAppPipeSuccessResponse("00000000-0000-0000-0000-000000000000")));
  });
  await assert.rejects(send(fixture), /different target thread/);
});

socketTest("a foreign receipt mentioning the target elsewhere is not delivery confirmation", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(JSON.stringify({
      jsonrpc: "2.0", id: APP_PIPE_REQUEST_ID,
      result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: "different-thread", note: THREAD_ID }) }] },
    })));
  });
  await assert.rejects(send(fixture), /different target thread/);
});

socketTest("receipt without the target thread echo is rejected", async (fixture) => {
  fixture.respond((_request, socket) => {
    socket.write(encodeAppPipeFrame(JSON.stringify({ jsonrpc: "2.0", id: APP_PIPE_REQUEST_ID, result: { success: true } })));
  });
  await assert.rejects(send(fixture), /does not echo the target thread id/);
});

socketTest("zero length prefix is an invalid frame", async (fixture) => {
  fixture.respond((_request, socket) => socket.write(Buffer.from([0, 0, 0, 0])));
  await assert.rejects(send(fixture), /invalid response length/);
});

socketTest("connection closing before a complete response fails", async (fixture) => {
  fixture.respond((_request, socket) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(40, 0);
    socket.write(prefix);
    socket.end();
  });
  await assert.rejects(send(fixture), /closed before a complete response/);
});

socketTest("a silent pipe times out visibly", async (fixture) => {
  fixture.respond(() => undefined);
  await assert.rejects(send(fixture, 200), /timed out/);
});

test("connecting to a missing pipe path fails with a connect error", { skip: process.platform === "win32" ? "AF_UNIX fixture not run on Windows CI" : false }, async () => {
  await assert.rejects(
    sendAppPipeNotification({ pipePath: path.join(tmpdir(), `bridge-missing-${Date.now()}.sock`), threadId: THREAD_ID, callId: "c", prompt: "p", timeoutMs: 500 }),
    /cannot connect to the Codex App tools pipe/,
  );
});
