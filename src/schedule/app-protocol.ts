// Pure Codex App tools-pipe protocol helpers (ADR-010). The wire shape was
// verified against codex-app-tools 0.1.6: uint32-LE length-prefixed UTF-8
// JSON-RPC over the CODEX_APP_TOOLS_PIPE_PATH Unix socket, calling
// send_message_to_thread in the codex_app namespace. Pure functions only so
// tests can exercise framing without a socket.

export const APP_PIPE_REQUEST_ID = 1;
export const APP_PIPE_TURN_ID = "mcp-turn-zcode-schedule";

export interface AppPipeRequestParams {
  readonly threadId: string;
  readonly hostId: "local";
  readonly prompt: string;
}

export interface AppPipeRequest {
  readonly jsonrpc: "2.0";
  readonly id: typeof APP_PIPE_REQUEST_ID;
  readonly method: "tools/call";
  readonly params: {
    readonly arguments: AppPipeRequestParams;
    readonly callerSource: "codex";
    readonly callId: string;
    readonly namespace: "codex_app";
    readonly threadId: string;
    readonly tool: "send_message_to_thread";
    readonly turnId: typeof APP_PIPE_TURN_ID;
  };
}

export function buildAppPipeRequest(input: { threadId: string; prompt: string; callId: string }): AppPipeRequest {
  return {
    jsonrpc: "2.0",
    id: APP_PIPE_REQUEST_ID,
    method: "tools/call",
    params: {
      arguments: { threadId: input.threadId, hostId: "local", prompt: input.prompt },
      callerSource: "codex",
      callId: input.callId,
      namespace: "codex_app",
      threadId: input.threadId,
      tool: "send_message_to_thread",
      turnId: APP_PIPE_TURN_ID,
    },
  };
}

/** uint32-LE byte count + UTF-8 payload. */
export function encodeAppPipeFrame(payloadJson: string): Buffer {
  const payload = Buffer.from(payloadJson, "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

