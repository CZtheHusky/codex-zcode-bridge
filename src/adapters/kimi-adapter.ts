// Kimi Code 2.3.3 Server API: ACP loses non-authentication failed-turn errors.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { AgentHandle, AgentProcessStatus, CodingAgentAdapter, TaskPackage, WorkspaceRef } from "../interfaces.js";
import type { ZCodeAppServerAdapterOptions } from "./zcode-app-server-adapter.js";
import type { AdapterErrorCode, ZCodeRunOutcome } from "./zcode-adapter.js";
import { parseAgentReport } from "./agent-report.js";
import { buildTaskPrompt, buildContinuePrompt } from "../prompts/task-prompt.js";
import { createMinimalOsEnv } from "../runtime/child-env.js";
import { BridgeError } from "../runtime/errors.js";
import { resolveTaskTimeout } from "../runtime/task-timeout.js";
import { captureSpawnGenerationIdentity, childStillOnSpawnGeneration, terminateProcessTree, verifyProcessTreeClaimantsClean } from "./process-spawn.js";
import { createPlatformProbe } from "../runtime/process-probe.js";

// These schemas validate the actual external Kimi HTTP/WS boundary, never local artifacts.
const object = z.record(z.string(), z.unknown());
const envelope = z.object({ code: z.number(), data: z.unknown() });
const sessionSchema = z.object({ id: z.string(), metadata: z.object({ cwd: z.string() }), agent_config: z.object({ model: z.string(), thinking: z.string().optional() }), busy: z.boolean() });
const frameSchema = z.object({ type: z.string(), id: z.string().optional(), code: z.number().optional(), session_id: z.string().optional(), offset: z.number().optional(), payload: object.optional() });
const approvalSchema = z.object({ approval_id: z.string(), tool_name: z.string(), action: z.string(), tool_input_display: z.unknown(), turn_id: z.number().optional() });
const questionSchema = z.object({ question_id: z.string(), turn_id: z.number().optional(), questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), multi_select: z.boolean().optional(), allow_other: z.boolean().optional() })) });

export function kimiFailureCode(error: unknown): "kimi_usage_exhausted" | "kimi_nonzero_exit" {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional(), name: z.string().optional() }).safeParse(error);
  const text = parsed.success ? `${parsed.data.code ?? ""} ${parsed.data.message ?? ""}` : "";
  return (parsed.success && parsed.data.name === "APIProviderQuotaExhaustedError") || /(?:quota|balance|credits?).{0,60}(?:exhausted|exceeded|depleted|insufficient)|insufficient.{0,30}(?:quota|balance|credits?)|额度.{0,20}(?:耗尽|用完|不足|超限)/i.test(text)
    ? "kimi_usage_exhausted" : "kimi_nonzero_exit";
}

interface Run {
  controller: AbortController;
  child: ChildProcess | null;
  cancelled: boolean;
  timedOut: boolean;
  result: Promise<ZCodeRunOutcome>;
}

type Callbacks = Pick<ZCodeAppServerAdapterOptions, "onEvent" | "resolveInteraction" | "onOutcomeCheckpoint" | "onInteractionState">;

export class KimiAdapter implements CodingAgentAdapter {
  readonly #options: Callbacks;
  readonly #runs = new WeakMap<AgentHandle, Run>();
  constructor(options: Callbacks = {}) { this.#options = options; }

  async startTask(input: Parameters<CodingAgentAdapter["startTask"]>[0]): Promise<AgentHandle> {
    return this.#start(input.task, input.workspace, buildTaskPrompt(input.task), null, input.attempt);
  }
  async continueTask(input: Parameters<CodingAgentAdapter["continueTask"]>[0]): Promise<AgentHandle> {
    return this.#start(input.task, input.workspace, buildContinuePrompt(input), input.previousSessionId, input.attempt);
  }
  async getStatus(handle: AgentHandle): Promise<AgentProcessStatus> {
    const run = this.#runs.get(handle)!;
    return { state: run.child && childStillOnSpawnGeneration(run.child) ? "running" : "exited", workerPid: process.pid, zcodePid: run.child?.pid ?? null, exitCode: run.child?.exitCode ?? null, signal: run.child?.signalCode ?? null };
  }
  async getResult(handle: AgentHandle): Promise<ZCodeRunOutcome> { return this.#runs.get(handle)!.result; }
  async cancelTask(handle: AgentHandle): Promise<void> {
    const run = this.#runs.get(handle)!;
    run.cancelled = true;
    run.controller.abort();
    await run.result;
  }
  #start(task: TaskPackage, workspace: WorkspaceRef, prompt: string, previousSessionId: string | null, attempt: number): AgentHandle {
    const controller = new AbortController();
    const run: Run = { controller, child: null, cancelled: false, timedOut: false, result: Promise.resolve().then(() => this.#execute(run, task, workspace, prompt, previousSessionId)) };
    const handle: AgentHandle = { taskId: task.task_id, attempt, workerPid: process.pid, zcodePid: null, startedAt: new Date().toISOString() };
    this.#runs.set(handle, run);
    return handle;
  }
  async #execute(run: Run, task: TaskPackage, workspace: WorkspaceRef, prompt: string, previousSessionId: string | null): Promise<ZCodeRunOutcome> {
    const emit = this.#options.onEvent;
    const signal = run.controller.signal;
    const timer = setTimeout(() => { run.timedOut = true; run.controller.abort(); }, resolveTaskTimeout(task, process.env));
    let sessionId: string | null = previousSessionId;
    let response = "";
    let truncated = false;
    let ws: WebSocket | undefined;
    let identity: { pid: number; fingerprint: string } | null = null;
    let errorCode: AdapterErrorCode | null = null;
    let reportError: string | null = null;
    let cleanupError: string | null = null;
    let usage: Record<string, unknown> | null = null;
    try {
      signal.throwIfAborted();
      const env = createMinimalOsEnv(process.env);
      if (process.env["KIMI_CODE_HOME"]) env["KIMI_CODE_HOME"] = process.env["KIMI_CODE_HOME"];
      const executable = process.env["KIMI_BRIDGE_EXECUTABLE"] || "kimi";
      const args = ["web", "--no-open", "--host", "127.0.0.1", "--port", "0", "--log-level", "error"];
      const nodeEntrypoint = /\.(?:mjs|cjs|js)$/i.test(executable);
      const child = spawn(nodeEntrypoint ? process.execPath : executable, nodeEntrypoint ? [executable, ...args] : args, {
        cwd: workspace.canonicalPath, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      run.child = child;
      // The banner contains a bearer token. Never persist stdout/stderr from this server.
      const address = await new Promise<URL>((resolve, reject) => {
        let banner = "";
        const startupTimer = setTimeout(() => reject(new BridgeError("kimi_nonzero_exit", "Kimi server startup timed out")), 30_000);
        const abort = () => { finish(); reject(new BridgeError("kimi_nonzero_exit", "Kimi attempt aborted")); };
        signal.addEventListener("abort", abort, { once: true });
        const finish = () => { clearTimeout(startupTimer); signal.removeEventListener("abort", abort); };
        child.once("error", () => { finish(); reject(new BridgeError("spawn_failed", "Unable to start Kimi; check KIMI_BRIDGE_EXECUTABLE")); });
        child.once("exit", () => { finish(); reject(new BridgeError("kimi_nonzero_exit", "Kimi server exited before it was ready")); });
        child.stdout!.on("data", (data: Buffer) => {
          banner = (banner + data.toString()).slice(-16_000);
          const match = banner.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/);
          if (match) { finish(); resolve(new URL(match[0])); }
        });
        child.stderr!.resume();
        if (signal.aborted) abort();
      });
      identity = await captureSpawnGenerationIdentity(child, createPlatformProbe());
      emit?.({ type: "app_server_started", summary: "Kimi authenticated loopback server started", details: { pid: child.pid, executor: "kimi" } });
      const token = new URLSearchParams(address.hash.slice(1)).get("token");
      if (!token) throw new BridgeError("kimi_nonzero_exit", "Kimi server did not provide authentication");
      const request = async <T>(route: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
        const result = await fetch(new URL(`/api/v1/${route}`, address), {
          method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        const value = envelope.parse(await result.json());
        if (!result.ok || value.code !== 0) throw new BridgeError("kimi_nonzero_exit", `Kimi API rejected request (code ${value.code}); check local Kimi configuration or session ownership`);
        return schema.parse(value.data);
      };
      const initialSession = previousSessionId
        ? await request(`sessions/${encodeURIComponent(previousSessionId)}`, sessionSchema)
        : await request("sessions", sessionSchema, { title: `Bridge ${task.task_id}`, metadata: { cwd: workspace.canonicalPath } });
      // GET session reads only the cold index; snapshot actually resumes the runtime.
      const snapshot = await request(`sessions/${encodeURIComponent(initialSession.id)}/snapshot`, z.object({ session: sessionSchema, as_of_seq: z.number(), epoch: z.string() }));
      const session = snapshot.session;
      sessionId = session.id;
      if (session.metadata.cwd !== workspace.canonicalPath || session.busy) throw new BridgeError("kimi_nonzero_exit", "Kimi session workspace mismatch or session busy; no takeover performed");
      emit?.({ type: "session_ready", summary: "Kimi session ready", details: { session_id: sessionId, executor: "kimi" } });
      const config = await request("config", z.object({ default_model: z.string().optional() }));
      const selectedModel = task.kimi?.model ?? (session.agent_config.model || config.default_model);
      const promptId = randomUUID();
      let turnId: number | undefined;
      let resolveTurn: (payload: Record<string, unknown>) => void;
      let rejectTurn: (error: Error) => void;
      const ended = new Promise<Record<string, unknown>>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      // A rejection can precede prompt acceptance; attach immediately to avoid unhandled rejection.
      void ended.catch(() => undefined);
      ws = new WebSocket(new URL("/api/v1/ws", address).href.replace("http:", "ws:"), [`kimi-code.bearer.${token}`]);
      const socket = ws;
      const abort = () => rejectTurn(new BridgeError("kimi_nonzero_exit", "Kimi attempt aborted"));
      signal.addEventListener("abort", abort, { once: true });
      const interactionIds = new Set<string>();
      const interact = async (question: boolean): Promise<void> => {
        const base = `sessions/${encodeURIComponent(session.id)}/${question ? "questions" : "approvals"}`;
        if (question) {
          const pending = await request(`${base}?status=pending`, z.object({ items: z.array(questionSchema) }));
          for (const item of pending.items) {
            if (interactionIds.has(item.question_id) || item.turn_id !== turnId) continue;
            interactionIds.add(item.question_id);
            this.#options.onInteractionState?.("waiting");
            const answer = await this.#options.resolveInteraction?.({ request_id: item.question_id, method: "interaction/requestUserInput", params: { sessionId: session.id, toolName: "AskUserQuestion", questions: item.questions } }, signal);
            if (signal.aborted) return;
            if (answer?.action === "accept") {
              const content = z.object({ answers: z.record(z.string(), z.string()) }).parse(answer.content);
              const answers: Record<string, unknown> = {};
              for (const q of item.questions) {
                const value = content.answers[q.question];
                const option = q.options.find(o => o.label === value || o.id === value);
                answers[q.id] = option ? (q.multi_select ? { kind: "multi", option_ids: [option.id] } : { kind: "single", option_id: option.id }) : value !== undefined ? { kind: "other", text: value } : { kind: "skipped" };
              }
              await request(`${base}/${encodeURIComponent(item.question_id)}`, object, { answers });
            } else await request(`${base}/${encodeURIComponent(item.question_id)}:dismiss`, object, {});
            this.#options.onInteractionState?.("resumed");
          }
        } else {
          const pending = await request(`${base}?status=pending`, z.object({ items: z.array(approvalSchema) }));
          for (const item of pending.items) {
            if (interactionIds.has(item.approval_id) || item.turn_id !== turnId) continue;
            interactionIds.add(item.approval_id);
            this.#options.onInteractionState?.("waiting");
            const answer = await this.#options.resolveInteraction?.({ request_id: item.approval_id, method: "interaction/requestPermission", params: { sessionId: session.id, toolName: item.tool_name, reason: item.action, input: item.tool_input_display, options: [{ kind: "allow_once" }, { kind: "deny" }] } }, signal);
            if (signal.aborted) return;
            await request(`${base}/${encodeURIComponent(item.approval_id)}`, object, { decision: answer?.decision === "allow" ? "approved" : "rejected" });
            this.#options.onInteractionState?.("resumed");
          }
        }
      };
      await new Promise<void>((resolve, reject) => {
        const subscribeTimer = setTimeout(() => reject(new BridgeError("kimi_nonzero_exit", "Kimi event subscription timed out")), 15_000);
        const ready = () => { clearTimeout(subscribeTimer); resolve(); };
        socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe", id: "bridge", payload: { session_ids: [session.id], cursors: { [session.id]: { seq: snapshot.as_of_seq, epoch: snapshot.epoch } }, agent_filter: { [session.id]: ["main"] } } }));
        socket.onerror = () => { clearTimeout(subscribeTimer); const error = new BridgeError("kimi_nonzero_exit", "Kimi event connection failed"); reject(error); rejectTurn(error); };
        socket.onclose = () => { clearTimeout(subscribeTimer); const error = new BridgeError("kimi_nonzero_exit", "Kimi event connection closed before completion"); reject(error); rejectTurn(error); };
        socket.onmessage = event => {
          try {
            const frame = frameSchema.parse(JSON.parse(String(event.data)));
            if (frame.type === "ack" && frame.id === "bridge") {
              if (frame.code !== 0 || !z.object({ accepted: z.array(z.string()) }).parse(frame.payload).accepted.includes(session.id)) throw new BridgeError("kimi_nonzero_exit", "Kimi event subscription rejected");
              ready(); return;
            }
            if (frame.type === "ping") { socket.send(JSON.stringify({ type: "pong", payload: frame.payload })); return; }
            if (frame.type === "resync_required") throw new BridgeError("kimi_nonzero_exit", "Kimi event stream requires resynchronization; completion unverified");
            if (frame.session_id !== session.id || !frame.payload) return;
            const p = frame.payload;
            if (p.agentId !== "main") return;
            if (frame.type === "turn.started" && p.promptId === promptId) {
              turnId = z.number().parse(p.turnId);
              response = "";
              emit?.({ type: "turn_started", summary: "Kimi turn started", details: { turn_id: String(turnId) } });
            }
            if (turnId === undefined || (p.turnId !== undefined && p.turnId !== turnId)) return;
            if (frame.type === "assistant.delta") {
              const delta = z.string().parse(p.delta);
              // Volatile text gaps/duplicates must fail, never create a misleading report.
              if (frame.offset !== undefined && frame.offset !== response.length) throw new BridgeError("kimi_nonzero_exit", "Kimi visible output stream offset mismatch");
              if (response.length + delta.length > 2_000_000) { truncated = true; throw new BridgeError("kimi_nonzero_exit", "Kimi visible output exceeded capture limit"); }
              response += delta;
              emit?.({ type: "model_output", summary: delta });
            }
            if (frame.type === "tool.call.started") emit?.({ type: "model_tool_call", summary: `Kimi tool: ${z.string().parse(p.name)}`, details: { tool_name: p.name, tool_call_id: p.toolCallId } });
            if (frame.type === "tool.result") emit?.({ type: "tool_status", summary: p.isError ? "Kimi tool failed" : "Kimi tool completed", details: { tool_call_id: p.toolCallId, status: p.isError ? "failed" : "completed" } });
            if (frame.type === "event.approval.requested" || frame.type === "event.question.requested") void interact(frame.type === "event.question.requested").catch(rejectTurn);
            if (frame.type === "turn.ended" && p.turnId === turnId) resolveTurn(p);
          } catch (cause) { const error = cause instanceof BridgeError ? cause : new BridgeError("kimi_nonzero_exit", "Kimi protocol or event stream invalid; completion unverified"); clearTimeout(subscribeTimer); reject(error); rejectTurn(error); }
        };
      });
      await request(`sessions/${encodeURIComponent(session.id)}/prompts`, object, {
        content: [{ type: "text", text: prompt }], prompt_id: promptId, permission_mode: task.kimi?.permission_mode ?? "yolo", ...(selectedModel ? { model: selectedModel } : {}), ...(task.kimi?.reasoning_level !== undefined ? { thinking: task.kimi.reasoning_level } : {}),
      });
      const turn = await ended;
      signal.removeEventListener("abort", abort);
      if (turn.reason !== "completed") {
        errorCode = turn.reason === "cancelled" ? "cancelled" : kimiFailureCode(turn.error);
        reportError = errorCode === "kimi_usage_exhausted" ? "Kimi 用量额度已耗尽，当前执行已中断；停止任务并告知用户，不自动重试或续作，等待用户确认额度恢复。" : "Kimi turn did not complete successfully; inspect local Kimi configuration and task evidence";
        emit?.({ type: "error", summary: reportError, details: { error_code: errorCode } });
      } else emit?.({ type: "turn_completed", summary: "Kimi execution completed; host review required" });
      const final = await request(`sessions/${encodeURIComponent(session.id)}`, sessionSchema.extend({ usage: object }));
      usage = Object.fromEntries(Object.entries(final.usage).filter(([k, v]) => ["input_tokens", "output_tokens", "cache_read_tokens"].includes(k) && typeof v === "number"));
      emit?.({ type: "model_selected", summary: "Kimi runtime model", details: { model_id: final.agent_config.model, ...(final.agent_config.thinking ? { reasoning_level: final.agent_config.thinking } : {}) } });
    } catch (error) {
      if (!errorCode) {
        errorCode = run.cancelled ? "cancelled" : run.timedOut ? "timeout" : error instanceof BridgeError && error.code === "spawn_failed" ? "spawn_failed" : "kimi_nonzero_exit";
        reportError = run.cancelled ? "Kimi task cancelled" : run.timedOut ? "Kimi task timed out" : error instanceof BridgeError ? error.message : "Kimi execution or protocol failed; check executable, login, model configuration and session ownership";
      }
    } finally {
      clearTimeout(timer);
      run.controller.abort();
      ws?.close();
      const child = run.child;
      if (child?.pid) {
        try {
          if (childStillOnSpawnGeneration(child)) await terminateProcessTree(child.pid, { expectedRootFingerprint: identity?.fingerprint });
          else if (!(await verifyProcessTreeClaimantsClean([{ pid: child.pid, fingerprint: identity?.fingerprint ?? null }])).clean) throw new BridgeError("kimi_nonzero_exit", "Kimi descendants remain after server exit");
        } catch { cleanupError = "Kimi process-tree cleanup could not be verified"; }
      }
    }
    const parsed = parseAgentReport(response);
    if (!errorCode && parsed.error) { errorCode = "invalid_agent_report"; reportError = parsed.error; }
    const outcome: ZCodeRunOutcome = {
      exitCode: errorCode ? 1 : 0, signal: null, stdout: response, stderr: reportError ?? "", sessionId, response, usage,
      timedOut: run.timedOut, cancelled: run.cancelled || errorCode === "cancelled", errorCode, reportError,
      agentReport: errorCode ? null : parsed.report, reportCandidate: parsed.candidate,
      stdoutTruncated: truncated, stderrTruncated: false, attempts: 1, cleanupError, cleanupVerified: cleanupError === null,
    };
    this.#options.onOutcomeCheckpoint?.(outcome);
    return outcome;
  }
}
