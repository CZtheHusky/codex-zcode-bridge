// ADR-010 Codex App wakeup adapter over the VERIFIED local tools pipe
// (observed Linux App 26.1016.61520 / codex-app-tools 0.1.6; an App-internal
// interface, not a published contract). Framing helpers live in
// app-protocol.ts. The pipe path comes from the MCP host's
// CODEX_APP_TOOLS_PIPE_PATH environment (host-owned; never forwarded to ZCode
// workers) and may be refreshed by the host between connections.
import { createConnection, type Socket } from "node:net";
import { APP_PIPE_REQUEST_ID, buildAppPipeRequest, encodeAppPipeFrame } from "./app-protocol.js";

export { buildAppPipeRequest, encodeAppPipeFrame } from "./app-protocol.js";

export const APP_PIPE_DEFAULT_TIMEOUT_MS = 10_000;
export const APP_PIPE_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface AppPipeSendInput {
  readonly pipePath: string;
  readonly threadId: string;
  readonly callId: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
}

export type AppPipeConnector = (pipePath: string, timeoutMs: number) => Promise<Socket>;

export const defaultAppPipeConnector: AppPipeConnector = (pipePath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out connecting to the Codex App tools pipe"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`cannot connect to the Codex App tools pipe (${error.code ?? "connection error"})`));
    });
  });

/**
 * Sends one send_message_to_thread wakeup and awaits its framed response.
 * Boundary checks against the real external App protocol: response identity
 * (the JSON-RPC id must match the request), the success flag, and the echoed
 * thread id inside the first content item. Any violation, transport error, or
 * timeout fails visibly; nothing counts as delivered without the App's
 * success receipt.
 */
export async function sendAppPipeNotification(
  input: AppPipeSendInput,
  connect: AppPipeConnector = defaultAppPipeConnector,
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? APP_PIPE_DEFAULT_TIMEOUT_MS;
  const request = buildAppPipeRequest({ threadId: input.threadId, prompt: input.prompt, callId: input.callId });
  const frame = encodeAppPipeFrame(JSON.stringify(request));
  const socket = await connect(input.pipePath, timeoutMs);
  try {
    const responseText = await readFramedResponse(socket, frame, timeoutMs);
    let response: unknown;
    try {
      response = JSON.parse(responseText);
    } catch {
      throw new Error("Codex App tools pipe returned a non-JSON response");
    }
    if (typeof response !== "object" || response === null) {
      throw new Error("Codex App tools pipe response is not a JSON-RPC object");
    }
    if (!("id" in response) || response.id !== APP_PIPE_REQUEST_ID) {
      throw new Error("Codex App tools pipe response id does not match the request");
    }
    if ("error" in response) throw new Error("Codex App tools pipe rejected the wakeup request");
    if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
      throw new Error("Codex App tools pipe response has no result object");
    }
    const result = response.result;
    if (!("success" in result) || result.success !== true) {
      throw new Error("Codex App tools pipe did not confirm successful delivery");
    }
    const firstItem: unknown = "contentItems" in result && Array.isArray(result.contentItems) ? result.contentItems[0] : undefined;
    if (typeof firstItem !== "object" || firstItem === null || !("text" in firstItem) || typeof firstItem.text !== "string") {
      throw new Error("Codex App tools pipe receipt does not echo the target thread id; delivery identity is unconfirmed");
    }
    // Boundary: the external App receipt is JSON text containing the exact target UUID.
    const receipt: unknown = JSON.parse(firstItem.text);
    if (typeof receipt !== "object" || receipt === null || !("threadId" in receipt) || receipt.threadId !== input.threadId) {
      throw new Error("Codex App tools pipe receipt has a different target thread; delivery identity is unconfirmed");
    }
  } finally {
    socket.destroy();
  }
}

/** Incremental frame reader: accepts arbitrarily chunked input and returns
 * the complete UTF-8 payload once the announced length has arrived. */
function readFramedResponse(socket: Socket, frame: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expected: number | null = null;
    let done = false;
    const finish = (error: Error | null, text?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(text!);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Codex App tools pipe response timed out after ${String(timeoutMs)}ms`));
      socket.destroy();
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      while (expected === null && buffered.length >= 4) {
        expected = buffered.readUInt32LE(0);
        if (expected === 0 || expected > APP_PIPE_MAX_RESPONSE_BYTES) {
          finish(new Error(`Codex App tools pipe announced an invalid response length ${String(expected)}`));
          socket.destroy();
          return;
        }
        buffered = buffered.subarray(4);
      }
      if (expected !== null && buffered.length >= expected) {
        finish(null, buffered.subarray(0, expected).toString("utf8"));
      }
    };
    const onError = (error: Error): void => finish(new Error(`Codex App tools pipe transport failed: ${error.message}`));
    const onClose = (): void => finish(new Error("Codex App tools pipe closed before a complete response arrived"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(frame);
  });
}
