// Bridge browser host: per-attempt scope state machine around a managed CDP
// backend port (ADR-007). The adapter validates session/workspace identity
// before dispatching here; this module owns the remaining protocol guardrails:
// default-off expression, duplicate requestId rejection, stale generation
// rejection, per-command timeout with honest sideEffect classification,
// cancelRequest interception, and bounded lifecycle close. Normal events never
// contain page content, URLs, titles, screenshots, or CDP endpoints.
import type { BrowserBackendDescriptor } from "./backend.js";
import type { BrowserErrorCode } from "./command-metadata.js";
import type { BrowserCommand } from "./commands.js";
import type { BrowserCommandResult } from "./result.js";
import type { BrowserListParams, BrowserExecuteParams } from "./params.js";
import type { BrowserControlPort } from "./contracts.js";
import { browserBackendListResultSchema } from "./backend.js";
import { hasSideEffects } from "./request.js";

export type BrowserHostMode = "off" | "headless";

export interface BrowserHostOptions {
  mode: BrowserHostMode;
  /** 显式指定的系统浏览器可执行文件（绝对路径）；缺省按已安装浏览器解析。 */
  executablePath?: string;
  /** 注入的 backend 工厂；生产由 loader 提供，测试注入假 backend。 */
  backendFactory: () => Promise<BrowserControlPort>;
  /** 单条命令预算（默认 30s，与桌面 host 一致）。 */
  commandTimeoutMs?: number;
  /** browserList（含首启）预算。 */
  listTimeoutMs?: number;
  /** backend.close 的 host 层预算（默认 5s）；超时按未验证清理上报。 */
  closeBudgetMs?: number;
}

export interface BrowserHostEvent {
  type: string;
  summary: string;
  details?: Record<string, unknown>;
}

export type BrowserHostSink = (event: BrowserHostEvent) => void;

export interface BrowserHost {
  readonly mode: BrowserHostMode;
  handleList(params: BrowserListParams, signal: AbortSignal): Promise<BrowserHostListOutcome>;
  handleExecute(params: BrowserExecuteParams, signal: AbortSignal): Promise<BrowserCommandResult>;
  close(): Promise<{ closed: boolean; error: string | null }>;
}

export type BrowserHostListOutcome =
  | { kind: "ok"; browsers: BrowserBackendDescriptor[] }
  | { kind: "error"; message: string };

interface PendingRequest {
  controller: AbortController;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_BUDGET_MS = 5_000;

export function createBrowserHost(options: BrowserHostOptions, onEvent?: BrowserHostSink): BrowserHost {
  const commandTimeoutMs = Math.max(1_000, Math.trunc(options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS));
  const listTimeoutMs = Math.max(1_000, Math.trunc(options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS));
  const closeBudgetMs = Math.max(1_000, Math.trunc(options.closeBudgetMs ?? DEFAULT_CLOSE_BUDGET_MS));
  const pending = new Map<string, PendingRequest>();
  let backendPromise: Promise<BrowserControlPort> | null = null;
  let startedReported = false;
  let launchFailedReported = false;
  let closed = false;
  // Close is attempted at most once; a failed outcome stays recorded so
  // repeated close() calls cannot repaint an unverified teardown as verified.
  let closeOutcome: { closed: boolean; error: string | null } | null = null;

  const errorResult = (
    code: BrowserErrorCode,
    message: string,
    startedAt: number,
    sideEffect?: "none" | "uncertain",
  ): BrowserCommandResult => ({
    ok: false,
    error: { code, message, ...(sideEffect ? { sideEffect } : {}) },
    elapsedMs: Date.now() - startedAt,
  });

  const reportLaunchFailure = (error: unknown): void => {
    if (launchFailedReported) return;
    launchFailedReported = true;
    onEvent?.({
      type: "browser_host_launch_failed",
      summary: "Bridge managed headless browser could not start; browser requests will fail until it recovers",
      details: { reason: boundedReason(error) },
    });
  };

  const ensureBackend = (): Promise<BrowserControlPort> => {
    backendPromise ??= (async () => {
      const backend = await options.backendFactory();
      if (closed) {
        await backend.close?.();
        throw new Error("Browser host is closed");
      }
      return backend;
    })().catch((error: unknown) => {
      backendPromise = null;
      throw error;
    });
    return backendPromise;
  };

  /**
   * 每次发现都重新向 backend 查询 descriptor：后端崩溃重启会递增
   * generation，缓存会让 discovery 谎报一个已不可用的 backend。stale
   * generation 的 execute 会被拒绝，agent 重新 discovery 后拿到新代次。
   */
  const discoverDescriptor = async (params: BrowserListParams | BrowserExecuteParams, signal: AbortSignal): Promise<BrowserBackendDescriptor> => {
    const backend = await ensureBackend();
    const outcome = await withTimeout(
      backend.list({ sessionId: params.sessionId, signal }),
      listTimeoutMs,
    );
    if (outcome.timedOut) throw new Error("Managed headless browser discovery timed out");
    const parsed = browserBackendListResultSchema.safeParse({ browsers: outcome.value });
    if (!parsed.success) throw new Error("Managed headless browser returned an invalid descriptor");
    if (parsed.data.browsers.length !== 1) {
      throw new Error("Managed headless browser must expose exactly one backend descriptor");
    }
    const descriptor = parsed.data.browsers[0]!;
    if (!startedReported) {
      startedReported = true;
      onEvent?.({
        type: "browser_host_started",
        summary: "Bridge managed headless browser backend started for this task attempt",
        details: { backend_type: descriptor.type, generation: descriptor.generation, headless: true },
      });
    }
    return descriptor;
  };

  const host: BrowserHost = {
    mode: options.mode,

    async handleList(params, signal) {
      if (options.mode === "off") {
        // 默认关闭的表达是“没有可达 backend”，不是协议错误。
        return { kind: "ok", browsers: [] };
      }
      if (closed || signal.aborted) return { kind: "error", message: "Browser host is closed" };
      try {
        const found = await discoverDescriptor(params, signal);
        return { kind: "ok", browsers: [found] };
      } catch (error) {
        reportLaunchFailure(error);
        return { kind: "error", message: `Managed headless browser is unavailable: ${boundedReason(error)}` };
      }
    },

    async handleExecute(params, signal) {
      const startedAt = Date.now();
      if (options.mode === "off") {
        return errorResult(
          "backend_unavailable",
          "Bridge browser host is disabled (ZCODE_BRIDGE_BROWSER_USE=off); no browser backend exists for this task",
          startedAt,
        );
      }
      if (closed || signal.aborted) {
        return errorResult("backend_unavailable", "Browser host is closed", startedAt);
      }
      let current: BrowserBackendDescriptor;
      try {
        current = await discoverDescriptor(params, signal);
      } catch (error) {
        reportLaunchFailure(error);
        return errorResult("backend_unavailable", `Managed headless browser is unavailable: ${boundedReason(error)}`, startedAt);
      }
      if (params.browserId !== current.id || params.browserGeneration !== current.generation) {
        return errorResult(
          "backend_unavailable",
          `Browser backend '${params.browserId}' generation ${params.browserGeneration} is stale`,
          startedAt,
        );
      }
      const command = params.command;
      if (command.method === "cancelRequest") {
        // 幂等取消：中止仍在本 host 内等待的协议 requestId；已结算的取消无事可做。
        pending.get(command.requestId)?.controller.abort();
        return { ok: true, elapsedMs: Date.now() - startedAt };
      }
      if (command.method === "turnEnded" || command.method === "closeSession") {
        const backend = await ensureBackend();
        if (command.method === "turnEnded") await backend.turnEnded?.({ sessionId: params.sessionId, ...(params.turnId ? { turnId: params.turnId } : {}) });
        else await backend.closeSession?.({ sessionId: params.sessionId });
        return { ok: true, elapsedMs: Date.now() - startedAt };
      }
      if (pending.has(params.requestId)) {
        return errorResult(
          "duplicate_request_id",
          `Browser requestId '${params.requestId}' is already running`,
          startedAt,
          "none",
        );
      }
      const controller = new AbortController();
      const forwardAbort = (): void => { controller.abort(); };
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      pending.set(params.requestId, { controller });
      const budgetMs = commandBudgetMs(command, commandTimeoutMs);
      const timeoutResult = (): BrowserCommandResult => errorResult(
        "timeout",
        `Browser command '${command.method}' exceeded its ${budgetMs}ms budget`,
        startedAt,
        hasSideEffects(command) ? "uncertain" : "none",
      );
      // Host-owned deadline: even a backend that ignores its AbortSignal gets
      // a timeout result at the budget; the dangling execution promise has a
      // rejection handler attached so a late failure cannot crash the worker.
      let deadlineFired = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimeout(() => {
          deadlineFired = true;
          controller.abort();
          resolve("deadline");
        }, budgetMs);
        deadlineTimer.unref();
      });
      try {
        const backend = await ensureBackend();
        const execution = backend.execute({
          browserId: params.browserId,
          browserGeneration: params.browserGeneration,
          sessionId: params.sessionId,
          ...(params.turnId ? { turnId: params.turnId } : {}),
          command,
          signal: controller.signal,
        }).then(
          (result): { kind: "result"; result: BrowserCommandResult } => ({ kind: "result", result }),
          (error: unknown): { kind: "error"; error: unknown } => ({ kind: "error", error }),
        );
        const winner = await Promise.race([execution, deadline]);
        // The deadline's abort may settle the execution promise first; any
        // outcome at or after the deadline is still classified as timeout.
        if (deadlineFired || winner === "deadline") return timeoutResult();
        if (winner.kind === "error") return errorResult("execution_error", boundedReason(winner.error), startedAt);
        return winner.result;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal.removeEventListener("abort", forwardAbort);
        pending.delete(params.requestId);
      }
    },

    async close() {
      if (closeOutcome) return closeOutcome;
      closed = true;
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
      const backendWait = await withTimeout(
        backendPromise?.then(
          (port) => port,
          () => null,
        ) ?? Promise.resolve(null),
        closeBudgetMs,
      );
      if (backendWait.timedOut) {
        closeOutcome = { closed: false, error: "Browser backend factory did not settle within the close budget" };
      } else {
        const backend = backendWait.value;
        if (!backend) {
          closeOutcome = { closed: true, error: null };
        } else {
          try {
            const closeWait = await withTimeout(backend.close?.() ?? Promise.resolve(), closeBudgetMs);
            if (closeWait.timedOut) {
              closeOutcome = { closed: false, error: "Browser backend close did not settle within the close budget" };
            } else {
              closeOutcome = { closed: true, error: null };
            }
          } catch (error) {
            closeOutcome = { closed: false, error: boundedReason(error) };
          }
        }
      }
      if (closeOutcome.closed) {
        onEvent?.({
          type: "browser_host_closed",
          summary: "Bridge managed headless browser backend closed",
          details: { cleanup: "verified" },
        });
      } else {
        onEvent?.({
          type: "browser_cleanup_unverified",
          summary: "Bridge managed headless browser close could not be verified",
          details: { cleanup: "unverified", reason: closeOutcome.error ?? "unknown" },
        });
      }
      return closeOutcome;
    },
  };
  return host;
}

/** 与桌面 host 一致的预算规则：固定等待与显式超时按请求时长加传输余量。 */
function commandBudgetMs(command: BrowserCommand, defaultMs: number): number {
  if (command.method === "playwrightWaitForTimeout") return command.timeoutMs + 2_000;
  if (command.method === "playwright" && "timeoutMs" in command.action && typeof command.action.timeoutMs === "number") {
    return command.action.timeoutMs + 2_000;
  }
  return defaultMs;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ value: T | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: null, timedOut: true });
    }, timeoutMs);
    timer.unref();
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 启动错误可能携带临时 profile/endpoint；对外只保留有界原因文本。 */
function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/gu, " ").slice(0, 300);
}
