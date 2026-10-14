// Streaming ZCode Protocol adapter. The wire protocol is versioned with the
// installed ZCode runtime; docs/INTERFACES.md records the event cursor and
// replay boundary, and docs/ZCODE_RUNTIME.md the runtime configuration edge.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import type {
  AgentHandle,
  AgentProcessStatus,
  CodingAgentAdapter,
  RuntimeResolver,
  TaskPackage,
  TaskResult,
  WorkspaceRef,
  ZCodeInteractionRequest,
  ZCodeRuntimeConfig,
} from "../interfaces.js";
import { parseAgentReport } from "./agent-report.js";
import type { ZCodeRunOutcome } from "./zcode-adapter.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { BridgeError } from "../runtime/errors.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver } from "../runtime/resolver.js";
import { isProcessRunning, terminateProcessTree } from "./process-spawn.js";
import { createMinimalOsEnv } from "../runtime/child-env.js";
import { catalogProviderId, buildAccountProviderPayload, runtimeAuthReply, zcodeDataBaseDir, zcodeTasksIndexPath } from "../runtime/account-provider.js";
import { resolveSessionPreferences } from "../runtime/session-preferences.js";
import { resolveTaskTimeout } from "../runtime/task-timeout.js";
import { registerDesktopTask, updateDesktopTaskStatus, type DesktopTaskIndexEntry, type DesktopTaskStatus } from "./task-index-sync.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../host/profile.js";

type ProgressEvent = { type: string; summary: string; details?: Record<string, unknown> };
type ProgressSink = (event: ProgressEvent) => void;
type JsonRecord = Record<string, unknown>;

function publicUsage(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "input_tokens", "output_tokens", "total_tokens", "cost"]) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}

interface PendingRpc {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingInteraction {
  readonly requestIds: Array<string | number>;
  readonly method: ZCodeInteractionRequest["method"];
  readonly paramsSignature: string;
  response?: Record<string, unknown>;
  resolving: boolean;
}

interface AppServerClient {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params: JsonRecord): Promise<unknown>;
  replayEvents(events: unknown[]): void;
  close(): Promise<void>;
  readonly stderr: string;
}

interface RunEntry {
  handle: AgentHandle;
  child: ChildProcessWithoutNullStreams | null;
  client: AppServerClient | null;
  sessionId: string | null;
  finished: boolean;
  timedOut: boolean;
  cancelRequested: boolean;
  outcome: ZCodeRunOutcome | null;
  error: unknown;
  runPromise: Promise<ZCodeRunOutcome>;
  resolveTurn: (value: TurnResult) => void;
  rejectTurn: (error: Error) => void;
  onEvent: ProgressSink;
  textOutputStarted: boolean;
  selectedModel: string | null;
  selectedModelSelection: { providerId: string; modelId: string } | null;
  selectedReasoningLevel: string | null;
  reasoningLevelSource: "runtime" | "not_reported";
  modelSource: string | null;
  requestedModel: string | null;
  requestedReasoningLevel: string | null;
  lastEventSeq: number;
  lastEventAt: number;
  readonly interactions: Map<string, PendingInteraction>;
  readonly abort: AbortController;
  acceptingTurn: boolean;
  turnId: string | null;
  awaitingTurnStart: boolean;
  // B2 correlation state: one pending completion at most, settled only after
  // the turn binding exists or the bounded compat window expires.
  rpcAcceptedAt: string | null;
  turnStartedAt: string | null;
  turnCompletedAt: string | null;
  turnBinding: "strict" | "compat" | "pending";
  pendingCompletion: { payload: JsonRecord; event: JsonRecord; heldAt: number } | null;
  bindingTimer: NodeJS.Timeout | null;
  pendingTimer: NodeJS.Timeout | null;
  replayConsecutiveFailures: number;
}

interface TurnResult {
  response: string;
  usage: Record<string, unknown> | null;
  resultType: string | null;
  binding: "strict" | "compat";
  startedAt: string | null;
  completedAt: string;
  rpcAcceptedAt: string | null;
}

export interface ZCodeAppServerAdapterOptions {
  resolver?: RuntimeResolver;
  onEvent?: ProgressSink;
  timeoutMs?: number;
  childEnvBase?: NodeJS.ProcessEnv;
  /**
   * Home directory for persisted Bridge settings discovery. Defaults to the
   * real home; tests point it at an empty directory to stay hermetic against
   * machine-level runtime-config.json state.
   */
  homeDir?: string;
  host?: BridgeHostProfile;
  now?: () => Date;
  resolveInteraction?: (request: ZCodeInteractionRequest, signal: AbortSignal) => Promise<Record<string, unknown>>;
  onOutcomeCheckpoint?: (outcome: ZCodeRunOutcome) => void;
  /** Worker-facing interaction activity hint (waiting → resumed). */
  onInteractionState?: (state: "waiting" | "resumed") => void;
  /** Bounded pending-completion window when completion races turn binding. */
  turnBindingCompatMs?: number;
  /** Idle time before a replay poll (default 10_000); tests lower it. */
  replayIdleMs?: number;
}

const RPC_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_CHARS = 2_000_000;

/**
 * Runs one task in a ZCode app-server session and persists safe progress
 * events through onEvent. Only visible text deltas and bounded interaction
 * requests are emitted; hidden reasoning and tool outputs are excluded.
 */
export class ZCodeAppServerAdapter implements CodingAgentAdapter {
  readonly #resolver: RuntimeResolver;
  readonly #onEvent: ProgressSink;
  readonly #timeoutMs: number | null;
  readonly #childEnvBase: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #host: BridgeHostProfile;
  readonly #now: () => Date;
  readonly #resolveInteraction: ZCodeAppServerAdapterOptions["resolveInteraction"];
  readonly #onOutcomeCheckpoint: ZCodeAppServerAdapterOptions["onOutcomeCheckpoint"];
  readonly #onInteractionState: ZCodeAppServerAdapterOptions["onInteractionState"];
  readonly #turnBindingCompatMs: number;
  readonly #replayIdleMs: number;
  readonly #runs = new Map<AgentHandle, RunEntry>();
  readonly #workspaceByTask = new Map<string, string>();

  constructor(options: ZCodeAppServerAdapterOptions = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver({ env: options.childEnvBase, homeDir: options.homeDir, host: options.host });
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? null;
    this.#childEnvBase = options.childEnvBase ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#host = validateHostProfile(options.host ?? codexHostProfile(this.#homeDir));
    this.#now = options.now ?? (() => new Date());
    this.#resolveInteraction = options.resolveInteraction;
    this.#onOutcomeCheckpoint = options.onOutcomeCheckpoint;
    this.#onInteractionState = options.onInteractionState;
    this.#turnBindingCompatMs = options.turnBindingCompatMs ?? 5_000;
    this.#replayIdleMs = options.replayIdleMs ?? 10_000;
  }

  async startTask(input: { task: TaskPackage; workspace: WorkspaceRef; attempt: number }): Promise<AgentHandle> {
    return this.#launch(input.task, input.workspace, input.attempt, buildTaskPrompt(input.task), null);
  }

  async continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle> {
    const priorWorkspace = this.#workspaceByTask.get(input.task.task_id);
    if (priorWorkspace !== undefined && priorWorkspace !== input.workspace.canonicalPath) {
      throw new Error(`continuation workspace mismatch for task ${input.task.task_id}`);
    }
    return this.#launch(
      input.task,
      input.workspace,
      input.attempt,
      buildContinuePrompt({
        task: input.task,
        feedback: input.feedback,
        additionalRequirements: input.additionalRequirements,
        previousSessionId: input.previousSessionId,
        previousResult: input.previousResult,
      }),
      input.previousSessionId,
    );
  }

  async getStatus(handle: AgentHandle): Promise<AgentProcessStatus> {
    const entry = this.#require(handle, "getStatus");
    return {
      state: entry.finished ? "exited" : entry.child ? "running" : "starting",
      workerPid: handle.workerPid,
      zcodePid: entry.child?.pid ?? null,
      exitCode: entry.outcome?.exitCode ?? null,
      signal: entry.outcome?.signal ?? null,
    };
  }

  async getResult(handle: AgentHandle): Promise<ZCodeRunOutcome> {
    const entry = this.#require(handle, "getResult");
    if (entry.error) throw entry.error;
    if (entry.outcome) return entry.outcome;
    return entry.runPromise;
  }

  async cancelTask(handle: AgentHandle): Promise<void> {
    const entry = this.#require(handle, "cancelTask");
    if (entry.finished) return;
    entry.cancelRequested = true;
    entry.abort.abort();
    entry.rejectTurn(new Error("ZCode task cancelled"));
    // #execute owns process cleanup. Killing here as well races its close()
    // path and can turn a verified cancellation into cleanup_failed.
    try { await entry.runPromise; }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "cancelled") throw error;
    }
  }

  async #launch(
    task: TaskPackage,
    workspace: WorkspaceRef,
    attempt: number,
    prompt: string,
    resumeSessionId: string | null,
  ): Promise<AgentHandle> {
    const handle: AgentHandle = {
      taskId: task.task_id,
      attempt,
      workerPid: process.pid,
      zcodePid: null,
      startedAt: this.#now().toISOString(),
    };
    let resolveTurn!: RunEntry["resolveTurn"];
    let rejectTurn!: RunEntry["rejectTurn"];
    const turn = new Promise<TurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void turn.catch(() => undefined);
    const entry: RunEntry = {
      handle,
      child: null,
      client: null,
      sessionId: resumeSessionId,
      finished: false,
      timedOut: false,
      cancelRequested: false,
      outcome: null,
      error: null,
      runPromise: Promise.resolve(null as unknown as ZCodeRunOutcome),
      resolveTurn,
      rejectTurn,
      onEvent: this.#onEvent,
      textOutputStarted: false,
      selectedModel: null,
      selectedModelSelection: null,
      selectedReasoningLevel: null,
      reasoningLevelSource: "not_reported",
      modelSource: null,
      requestedModel: null,
      requestedReasoningLevel: null,
      lastEventSeq: 0,
      lastEventAt: Date.now(),
      interactions: new Map(),
      abort: new AbortController(),
      acceptingTurn: false,
      turnId: null,
      awaitingTurnStart: false,
      rpcAcceptedAt: null,
      turnStartedAt: null,
      turnCompletedAt: null,
      turnBinding: "pending",
      pendingCompletion: null,
      bindingTimer: null,
      pendingTimer: null,
      replayConsecutiveFailures: 0,
    };
    this.#runs.set(handle, entry);
    this.#workspaceByTask.set(task.task_id, workspace.canonicalPath);
    entry.runPromise = this.#execute(entry, task, workspace, prompt, resumeSessionId, turn);
    void entry.runPromise.then(
      (outcome) => { entry.outcome = outcome; entry.finished = true; },
      (error) => { entry.error = error; entry.finished = true; },
    );
    return handle;
  }

  async #execute(
    entry: RunEntry,
    task: TaskPackage,
    workspace: WorkspaceRef,
    prompt: string,
    resumeSessionId: string | null,
    turn: Promise<TurnResult>,
  ): Promise<ZCodeRunOutcome> {
    const startedAt = this.#now();
    const projectPath = workspace.sourcePath ?? workspace.canonicalPath;
    let timer: NodeJS.Timeout | undefined;
    let warningTimer: NodeJS.Timeout | undefined;
    let desktopTask: DesktopTaskIndexEntry | null = null;
    try {
      const runtimeEnv = loadPersistedRuntimeEnvironment(this.#childEnvBase, this.#homeDir, this.#host);
      const timeoutMs = this.#timeoutMs ?? resolveTaskTimeout(task, runtimeEnv);
      const config = await this.#resolver.resolve();
      const preferences = resolveSessionPreferences(task.model, runtimeEnv);
      const childEnv = this.#buildChildEnv(config, runtimeEnv);
      entry.onEvent({ type: "zcode_starting", summary: "Starting ZCode streaming runtime" });
      const client = this.#startAppServer(config, workspace.canonicalPath, childEnv, entry);
      entry.client = client;
      entry.child = client.child;
      entry.onEvent({ type: "app_server_started", summary: "ZCode app-server process started", details: { pid: client.child.pid } });
      timer = setTimeout(() => {
        entry.timedOut = true;
        entry.abort.abort();
        entry.rejectTurn(new Error(`ZCode run exceeded ${timeoutMs}ms wall-clock budget`));
      }, timeoutMs);
      timer.unref();
      warningTimer = setTimeout(() => {
        entry.onEvent({
          type: "timeout_warning",
          summary: `Task is approaching its ${timeoutMs}ms execution limit`,
          details: { timeout_ms: timeoutMs, remaining_ms: Math.min(300_000, Math.floor(timeoutMs / 2)) },
        });
      }, Math.max(15_000, timeoutMs - Math.min(300_000, Math.floor(timeoutMs / 2))));
      warningTimer.unref();

      const accountProviderPayload = buildAccountProviderPayload(config);
      if (accountProviderPayload) {
        try {
          const syncResult = asRecord(await client.request(
            "provider/updateAccountConfig",
            accountProviderPayload as unknown as JsonRecord,
          ));
          entry.onEvent({
            type: "account_provider_sync",
            summary: `Synchronized ${Object.keys(accountProviderPayload.providers).length} ZCode account provider(s)`,
            details: {
              provider_count: Object.keys(accountProviderPayload.providers).length,
              entitled_provider_count: Object.values(accountProviderPayload.states).filter((state) => state.entitled).length,
              runtime_status: typeof syncResult.status === "string" ? syncResult.status : "accepted",
            },
          });
        } catch (error) {
          entry.onEvent({
            type: "account_provider_sync_failed",
            summary: error instanceof Error ? error.message : "ZCode account provider synchronization failed",
          });
        }
      }

      let snapshot: JsonRecord;
      if (resumeSessionId) {
        snapshot = asRecord(await client.request("session/resume", {
          sessionId: resumeSessionId,
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath },
        }));
        const returnedId = nestedString(snapshot, ["session", "sessionId"]);
        if (returnedId && returnedId !== resumeSessionId) {
          throw new Error(`resume session mismatch: requested ${resumeSessionId}, runtime returned ${returnedId}`);
        }
        await client.request("session/setMode", { sessionId: resumeSessionId, mode: preferences.mode });
      } else {
        snapshot = asRecord(await client.request("session/create", {
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath },
          mode: preferences.mode,
          persistence: "immediate",
        }));
      }
      const sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new Error("ZCode app-server session snapshot did not contain session.sessionId");
      entry.sessionId = sessionId;
      let selectedReasoningLevel: string | null = null;
      if (preferences.model) {
        const availableModels = readAvailableModels(snapshot);
        const requestedProviderId = catalogProviderId(preferences.model.provider_id, preferences.model.model_id, availableModels, config);
        const requested = `${requestedProviderId}/${preferences.model.model_id}`;
        entry.onEvent({
          type: "model_catalog",
          summary: `ZCode runtime advertised ${availableModels.length} selectable model${availableModels.length === 1 ? "" : "s"}`,
          details: {
            session_id: sessionId,
            project_path: projectPath,
            execution_path: workspace.canonicalPath,
            requested_model: { provider_id: requestedProviderId, model_id: preferences.model.model_id },
            available_models: availableModels.slice(0, 100),
            truncated: availableModels.length > 100,
          },
        });
        // The initial list is advisory: ZCode may accept a configured model
        // through session/setModel even when it is absent from this snapshot.
        // Let the runtime validate the actual selection and report its exact
        // error rather than rejecting a model that the registry can resolve.
        // session/create already selected this exact model. Keeping its
        // effective options is important for models requiring reasoningLevel.
        const current = readSelectedModelSelection(snapshot);
        const reasoningLevel = preferences.model.reasoning_level ?? readModelReasoningDefault(
          snapshot,
          requestedProviderId,
          preferences.model.model_id,
        );
        const modelState = current?.providerId === requestedProviderId && current.modelId === preferences.model.model_id && !preferences.model.reasoning_level
          ? snapshot
          : asRecord(await client.request("session/setModel", {
              sessionId,
              model: {
                providerId: requestedProviderId,
                modelId: preferences.model.model_id,
                ...(reasoningLevel
                  ? { options: { reasoningLevel } }
                  : {}),
              },
              // Keep the override scoped to this session; do not change the
              // user's project-wide last-used model.
              persistAsWorkspaceLastUsed: false,
            }));
        const selected = readSelectedModelSelection(modelState);
        if (!selected) {
          throw new Error(`ZCode accepted model override ${requested} but did not report the selected model`);
        }
        if (
          selected.providerId !== requestedProviderId ||
          selected.modelId !== preferences.model.model_id
        ) {
          throw new Error(
            `ZCode model override mismatch: requested ${requested}, runtime selected ${selected.providerId}/${selected.modelId}`,
          );
        }
        snapshot = modelState;
        entry.selectedModel = readSelectedModel(modelState) ?? requested;
        entry.selectedModelSelection = selected;
        entry.modelSource = preferences.modelSource;
        entry.requestedModel = `${preferences.model.provider_id}/${preferences.model.model_id}`;
        entry.requestedReasoningLevel = reasoningLevel;
        selectedReasoningLevel = readEffectiveReasoningLevel(modelState);
        entry.selectedReasoningLevel = selectedReasoningLevel;
        entry.reasoningLevelSource = selectedReasoningLevel ? "runtime" : "not_reported";
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode selected requested model ${entry.selectedModel}${selectedReasoningLevel ? ` with reasoning level ${selectedReasoningLevel}` : "; runtime did not report its reasoning level"}`,
          details: {
            requested_model: entry.requestedModel,
            selected_model: entry.selectedModel,
            provider_id: selected.providerId,
            model_id: selected.modelId,
            model_source: preferences.modelSource,
            ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
            ...(reasoningLevel ? { requested_reasoning_level: reasoningLevel } : {}),
          },
        });
      }
      const model = readSelectedModel(snapshot);
      entry.selectedModel = entry.selectedModel ?? model;
      const defaultSelection = readSelectedModelSelection(snapshot);
      entry.selectedModelSelection = entry.selectedModelSelection ?? defaultSelection;
      if (!entry.selectedModel) {
        const availableModels = readAvailableModels(snapshot);
        entry.onEvent({
          type: "model_unresolved",
          summary: "ZCode runtime did not report a selected model; task was stopped before sending the prompt",
          details: { session_id: sessionId, available_model_count: availableModels.length },
        });
        throw new BridgeError(
          "provider_config_invalid",
          "ZCode runtime did not report its selected model; refusing to start a task whose model cannot be identified.",
        );
      }
      if (!preferences.model) {
        const selected = readSelectedModelSelection(snapshot);
        selectedReasoningLevel = readEffectiveReasoningLevel(snapshot);
        entry.selectedReasoningLevel = selectedReasoningLevel;
        entry.reasoningLevelSource = selectedReasoningLevel ? "runtime" : "not_reported";
        entry.modelSource = preferences.modelSource;
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode runtime selected its session model ${entry.selectedModel}${selectedReasoningLevel ? ` with reasoning level ${selectedReasoningLevel}` : ""}`,
          details: {
            selected_model: entry.selectedModel,
            model_source: preferences.modelSource,
            ...(selected ? { provider_id: selected.providerId, model_id: selected.modelId } : {}),
            ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
          },
        });
      }
      entry.onEvent({
        type: "session_ready",
        summary: `ZCode session ready; selected model ${entry.selectedModel}${selectedReasoningLevel ? `; reasoning level ${selectedReasoningLevel}` : "; reasoning level not reported"}`,
        details: {
          session_id: sessionId,
          project_path: projectPath,
          execution_path: workspace.canonicalPath,
          ...(workspace.mode === "worktree" ? { worktree_path: workspace.canonicalPath } : {}),
          execution_mode: preferences.mode,
          model_source: preferences.modelSource,
          ...(entry.selectedModel ? { selected_model: entry.selectedModel } : {}),
          ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
        },
      });
      const indexPath = zcodeTasksIndexPath(config.providerPersonalConfigFile);
      if (indexPath) {
        const selected = readSelectedModelSelection(snapshot);
        desktopTask = {
          databasePath: indexPath,
          workspaceKey: projectPath,
          workspacePath: workspace.canonicalPath,
          sessionId,
          bridgeTaskId: task.task_id,
          title: task.task_id,
          model: selected ? `${selected.providerId}/${selected.modelId}` : null,
          provider: "glm",
          mode: preferences.mode,
        };
        try {
          await registerDesktopTask(desktopTask);
          entry.onEvent({
            type: "desktop_task_registered",
            summary: "ZCode session registered in Desktop task index; refresh the task list to see it",
            details: { session_id: sessionId, project_path: projectPath, execution_path: workspace.canonicalPath },
          });
        } catch (error) {
          reportDesktopIndexIssue(entry.onEvent, error);
          desktopTask = null;
        }
      }
      const runtimeSeq = nestedNumber(snapshot, ["runtime", "eventSeq"]) ?? 0;
      entry.lastEventSeq = runtimeSeq;
      entry.awaitingTurnStart = runtimeSeq > 0;
      await client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: runtimeSeq,
      });
      entry.acceptingTurn = true;
      await client.request("session/send", { sessionId, content: prompt });
      entry.rpcAcceptedAt = this.#now().toISOString();
      entry.onEvent({ type: "turn_started", summary: "ZCode accepted the task and started a turn", details: { rpc_accepted: true, ...(entry.turnId ? { turn_id: entry.turnId } : {}) } });
      // B2: if the runtime does not deliver turn.started for the accepted
      // send within a bounded window, degrade to the documented compat path
      // (session exclusivity + replay boundary), visibly — never silently.
      entry.bindingTimer = setTimeout(() => {
        if (!entry.awaitingTurnStart) return;
        entry.awaitingTurnStart = false;
        entry.turnBinding = "compat";
        entry.onEvent({
          type: "turn_binding_compat",
          summary: "turn.started did not arrive after the accepted send; binding degraded to session-exclusivity compatibility mode",
        });
        this.#settlePendingCompletion(entry);
      }, Math.max(this.#turnBindingCompatMs, 5_000));
      entry.bindingTimer.unref();
      let replayInFlight = false;
      let replayDisabled = false;
      const replayTimer = setInterval(() => {
        if (!entry.acceptingTurn || replayInFlight || replayDisabled || Date.now() - entry.lastEventAt < this.#replayIdleMs) return;
        void 0;
        replayInFlight = true;
        void client.request("session/events", { sessionId, afterSeq: entry.lastEventSeq, limit: 500 })
          .then((value) => {
            entry.replayConsecutiveFailures = 0;
            const events = asRecord(value).events;
            if (Array.isArray(events)) client.replayEvents(events);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("Unsupported ZCode app-server request")) {
              replayDisabled = true;
              entry.onEvent({ type: "session_event_replay_unavailable", summary: "ZCode session event replay is unsupported by this runtime; continuing with live event subscription" });
              return;
            }
            // Transient replay failures must not permanently condemn the
            // capability (B2-05): retry, and only give up after several
            // consecutive failures, with the degradation visible.
            entry.replayConsecutiveFailures += 1;
            if (entry.replayConsecutiveFailures >= 3) {
              replayDisabled = true;
              entry.onEvent({ type: "session_event_replay_unavailable", summary: `ZCode session event replay failed ${String(entry.replayConsecutiveFailures)} times consecutively; continuing with live subscription` });
            }
          })
          .finally(() => { replayInFlight = false; });
      }, Math.max(50, Math.min(5_000, this.#replayIdleMs)));
      replayTimer.unref();
      let turnResult: TurnResult;
      try { turnResult = await turn; }
      finally {
        clearInterval(replayTimer);
        if (entry.bindingTimer) { clearTimeout(entry.bindingTimer); entry.bindingTimer = null; }
        if (entry.pendingTimer) { clearTimeout(entry.pendingTimer); entry.pendingTimer = null; }
      }
      entry.turnCompletedAt = turnResult.completedAt;
      const desktopStatus: DesktopTaskStatus = turnResult.resultType === "cancelled"
        ? null
        : turnResult.resultType && turnResult.resultType !== "success" ? "error" : "completed";
      let outcome: ZCodeRunOutcome;
      if (turnResult.resultType && turnResult.resultType !== "success") {
        outcome = {
          attempts: 1,
          cancelled: turnResult.resultType === "cancelled",
          stdout: turnResult.response,
          stderr: "",
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          agentReport: null,
          reportCandidate: null,
          reportError: `ZCode turn ended with resultType ${turnResult.resultType}`,
          errorCode: turnResult.resultType === "cancelled" ? "cancelled" : "zcode_nonzero_exit",
          phaseTimestamps: {
            rpc_accepted_at: turnResult.rpcAcceptedAt,
            turn_started_at: turnResult.startedAt,
            turn_completed_at: turnResult.completedAt,
          },
          modelProfile: this.#modelProfile(entry),
        };
      } else if (turnResult.resultType === null) {
        // Unknown terminal: event name alone never proves success (B2).
        const parsedUnknown = parseAgentReport(turnResult.response);
        outcome = {
          attempts: 1,
          cancelled: false,
          stdout: turnResult.response,
          stderr: "",
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          agentReport: null,
          reportCandidate: parsedUnknown.candidate,
          reportError: `ZCode turn completed without a resultType (binding: ${turnResult.binding}); treated as an unknown terminal state, not a success`,
          errorCode: "unknown_turn_terminal",
          phaseTimestamps: {
            rpc_accepted_at: turnResult.rpcAcceptedAt,
            turn_started_at: turnResult.startedAt,
            turn_completed_at: turnResult.completedAt,
          },
          modelProfile: this.#modelProfile(entry),
        };
      } else {
        const parsed = parseAgentReport(turnResult.response);
        const stdout = turnResult.response;
        const base = {
        attempts: 1,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdout,
        stderr: "",
        exitCode: 0,
        signal: null,
        sessionId,
        response: turnResult.response,
        usage: turnResult.usage,
        timedOut: false,
        reportCandidate: parsed.candidate,
        };
        if (!parsed.report) {
          outcome = {
            ...base,
            agentReport: null,
            reportCandidate: parsed.candidate,
            reportError: parsed.error,
            errorCode: "invalid_agent_report",
            phaseTimestamps: {
              rpc_accepted_at: turnResult.rpcAcceptedAt,
              turn_started_at: turnResult.startedAt,
              turn_completed_at: turnResult.completedAt,
            },
            modelProfile: this.#modelProfile(entry),
          };
        } else {
          entry.onEvent({
            type: "report_ready",
            summary: "ZCode produced its structured execution report",
            details: { needs_master_decision: parsed.report.needs_master_decision },
          });
          outcome = {
            ...base,
            agentReport: parsed.report,
            reportCandidate: parsed.report,
            reportError: null,
            errorCode: null,
            phaseTimestamps: {
              rpc_accepted_at: turnResult.rpcAcceptedAt,
              turn_started_at: turnResult.startedAt,
              turn_completed_at: turnResult.completedAt,
            },
            modelProfile: this.#modelProfile(entry),
          };
        }
      }
      // Persist the complete, bounded response and normalized report before
      // cleanup. A taskkill race must not erase work already completed by ZCode.
      outcome = { ...outcome, cleanupVerified: false };
      try { this.#onOutcomeCheckpoint?.(outcome); }
      catch (error) {
        entry.onEvent({ type: "outcome_checkpoint_failed", summary: error instanceof Error ? error.message : String(error) });
      }
      try {
        await syncDesktopStatus(desktopTask, desktopStatus, entry.onEvent);
      } catch (error) {
        entry.onEvent({ type: "desktop_status_sync_failed", summary: error instanceof Error ? error.message : String(error) });
      }
      try {
        await client.close();
        entry.child = null;
        outcome = { ...outcome, cleanupVerified: true };
        try { this.#onOutcomeCheckpoint?.(outcome); }
        catch (error) {
          entry.onEvent({ type: "outcome_checkpoint_failed", summary: error instanceof Error ? error.message : String(error) });
        }
      } catch (error) {
        const cleanupError = error instanceof Error ? error.message : String(error);
        entry.onEvent({ type: "cleanup_unverified", summary: cleanupError.slice(0, 1_500), details: { pid: client.child.pid } });
        outcome = { ...outcome, cleanupError, cleanupVerified: false };
        try { this.#onOutcomeCheckpoint?.(outcome); }
        catch (checkpointError) {
          entry.onEvent({ type: "outcome_checkpoint_failed", summary: checkpointError instanceof Error ? checkpointError.message : String(checkpointError) });
        }
      }
      return outcome;
    } catch (error) {
      await syncDesktopStatus(desktopTask, entry.cancelRequested ? null : "error", entry.onEvent);
      entry.abort.abort();
      try {
        if (entry.client) await entry.client.close();
        else if (entry.child?.pid) await terminateProcessTree(entry.child.pid);
      } catch (cleanupError) {
        throw new BridgeError("cleanup_failed", "ZCode process termination could not be verified; workspace remains occupied", { cause: cleanupError });
      }
      entry.child = null;
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message = entry.timedOut ? "ZCode run exceeded its wall-clock budget" : entry.cancelRequested ? "ZCode task cancelled" : baseMessage;
      const code = entry.timedOut ? "timeout" : entry.cancelRequested ? "cancelled" : error instanceof BridgeError ? error.code : "zcode_nonzero_exit";
      entry.onEvent({ type: "error", summary: message.slice(0, 1_500), details: { error_code: code } });
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(code, message);
    } finally {
      if (timer) clearTimeout(timer);
      if (warningTimer) clearTimeout(warningTimer);
      entry.abort.abort();
      entry.finished = true;
      void startedAt;
    }
  }

  #startAppServer(
    config: ZCodeRuntimeConfig,
    cwd: string,
    env: NodeJS.ProcessEnv,
    entry: RunEntry,
  ): AppServerClient {
    const child = spawn(config.nodeExecutable, [config.zcodeEntrypoint, "app-server", "--stdio"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdoutBuffer = "";
    let rpcId = 0;
    let closed = false;
    const pending = new Map<string | number, PendingRpc>();
    entry.abort.signal.addEventListener("abort", () => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("ZCode task attempt ended")); }
      pending.clear();
    }, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_CAPTURE_CHARS) { entry.rejectTurn(new Error("ZCode protocol frame exceeded size limit")); return; }
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as JsonRecord;
          this.#handleMessage(message, entry, pending, config, (reply) => {
            child.stdin.write(`${JSON.stringify(reply)}\n`);
          });
        } catch (error) {
          entry.rejectTurn(new Error("invalid ZCode app-server protocol message", { cause: error }));
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length);
    });
    child.on("error", (error) => {
      closed = true;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
      pending.clear();
      entry.rejectTurn(error);
    });
    child.on("close", (code, signal) => {
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error(`ZCode app-server exited (${String(code)}${signal ? `, ${signal}` : ""})`));
      }
      pending.clear();
      if (!entry.finished && !entry.timedOut && !entry.cancelRequested) {
        entry.rejectTurn(new Error(`ZCode app-server exited before turn completion (${String(code)})`));
      }
    });

    const request = (method: string, params: JsonRecord): Promise<unknown> => {
      if (entry.abort.signal.aborted) return Promise.reject(new Error("ZCode task attempt ended"));
      if (closed) return Promise.reject(new Error(`ZCode app-server is closed before ${method}`));
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ZCode app-server request timed out: ${method}`));
        }, RPC_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { method, resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    };
    const replayEvents = (events: unknown[]): void => {
      for (const event of events) {
        const params = asRecord(event);
        if (typeof params.type !== "string") continue;
        this.#handleMessage({ method: "session/event", params }, entry, pending, config, (reply) => {
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        });
      }
    };
    const close = async (): Promise<void> => {
      if (closed) {
        if (process.platform !== "win32" && child.pid) await terminateProcessTree(child.pid);
        return;
      }
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1_000);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      // The close event is authoritative for this direct child. If it races
      // the grace timer, check the PID before taskkill to avoid turning an
      // already-exited app-server into a cleanup failure on Windows.
      if (closed) {
        if (process.platform !== "win32" && child.pid) await terminateProcessTree(child.pid);
        return;
      }
      if (child.pid && isProcessRunning(child.pid)) await terminateProcessTree(child.pid);
    };
    return { child, request, replayEvents, close, get stderr() { return stderr; } };
  }

  #handleMessage(
    message: JsonRecord,
    entry: RunEntry,
    pending: Map<string | number, PendingRpc>,
    config: ZCodeRuntimeConfig,
    write: (message: JsonRecord) => void,
  ): void {
    if (message.method === "session/requestRuntimePreferences") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        write({
          id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          },
        });
      }
      return;
    }
    if (message.method === "interaction/requestProviderRuntimeHeaders") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        const params = asRecord(message.params);
        const selection = asRecord(params.modelSelection);
        const providerId = typeof selection.providerId === "string"
          ? selection.providerId
          : typeof params.providerId === "string" ? params.providerId : undefined;
        write({ id, result: runtimeAuthReply(providerId, config) });
      }
      return;
    }
    if (message.method === "interaction/requestPermission" || message.method === "interaction/requestUserInput") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        this.#handleInteractionRequest(message, entry, write);
      }
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const id = message.id as string | number;
      const call = pending.get(id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRecord;
        call.reject(new Error(`ZCode app-server request failed for ${call.method}${typeof error.code === "number" ? ` (code ${error.code})` : ""}`));
      } else {
        call.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/event") {
      const params = asRecord(message.params);
      if (params.sessionId !== undefined && params.sessionId !== entry.sessionId) return;
      if (!entry.acceptingTurn) return;
      const type = typeof params.type === "string" ? params.type : "";
      const payload = asRecord(params.payload);
      const turnId = typeof params.turnId === "string" ? params.turnId : typeof payload.turnId === "string" ? payload.turnId : null;
      if (entry.awaitingTurnStart && type !== "turn.started") return;
      if (entry.turnId && turnId && entry.turnId !== turnId) return;
      if (typeof params.seq === "number") {
        if (!Number.isSafeInteger(params.seq) || params.seq <= entry.lastEventSeq) return;
        entry.lastEventSeq = params.seq;
      }
      entry.lastEventAt = Date.now();
      if (type === "turn.started") {
        // Strict binding wins: the send-accepted turn is now identified. A
        // completion held in the pending boundary settles only after this
        // binding is in place (B2-01).
        if (turnId) entry.turnId = turnId;
        entry.awaitingTurnStart = false;
        entry.turnStartedAt = this.#now().toISOString();
        if (entry.bindingTimer) { clearTimeout(entry.bindingTimer); entry.bindingTimer = null; }
      }
      if (type === "turn.completed") {
        if (entry.awaitingTurnStart) {
          // Completion before binding: hold a bounded pending boundary.
          entry.pendingCompletion = { payload, event: params, heldAt: Date.now() };
          entry.acceptingTurn = false;
          if (!entry.pendingTimer) {
            entry.pendingTimer = setTimeout(() => this.#settlePendingCompletion(entry), this.#turnBindingCompatMs);
            entry.pendingTimer.unref();
          }
          return;
        }
        entry.acceptingTurn = false;
        entry.turnCompletedAt = this.#now().toISOString();
        entry.turnBinding = entry.turnId ? "strict" : "compat";
        // Publish first so the worker persists the turn correlation, then
        // settle the turn exactly once.
        this.#publishSessionEvent(type, payload, entry, params);
        this.#resolveTurnCompleted(entry, payload, params);
        return;
      }
      if (type === "turn.failed") {
        entry.acceptingTurn = false;
        entry.turnCompletedAt = this.#now().toISOString();
        const quotaExhausted = providerReportedUsageExhaustion(payload.error);
        const failure = quotaExhausted
          ? new BridgeError(
              "zcode_usage_exhausted",
              "ZCode 提供方明确报告用量额度已耗尽；当前执行已中断。请立即停止当前任务并告知用户；不要继续工作、自动重试或续作，等待用户确认额度恢复后再继续。",
            )
          : new Error("ZCode turn failed");
        this.#publishSessionEvent(type, payload, entry, params, quotaExhausted ? "zcode_usage_exhausted" : "zcode_nonzero_exit");
        entry.rejectTurn(failure);
        return;
      }
      this.#publishSessionEvent(type, payload, entry, params);
      if (type === "turn.started" && entry.pendingCompletion) {
        // Binding landed after a held completion; correlation is now
        // persisted by the worker, so settle the held completion (B2-01).
        this.#settlePendingCompletion(entry);
      }
    }
    if (message.method === "state.updated") {
      const params = asRecord(message.params);
      const patch = asRecord(params.patch);
      const state = typeof patch.status === "string" ? patch.status : undefined;
      if (state) entry.onEvent({ type: "runtime_state", summary: `ZCode runtime state: ${state}` });
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
    }
  }

  #handleInteractionRequest(
    message: JsonRecord,
    entry: RunEntry,
    write: (message: JsonRecord) => void,
  ): void {
    const rpcId = message.id as string | number;
    const method = message.method as ZCodeInteractionRequest["method"];
    const params = asRecord(message.params);
    if (entry.abort.signal.aborted || (params.sessionId !== undefined && params.sessionId !== entry.sessionId)) {
      write({ id: rpcId, result: interactionDecline(method, "Interaction does not belong to the active task session") });
      return;
    }
    const suppliedId = typeof params.requestId === "string" ? params.requestId : "";
    const requestId = suppliedId || `rpc-${String(rpcId)}`;
    const paramsSignature = stableSerialize(params);
    let pending = entry.interactions.get(requestId);
    if (pending) {
      if (pending.method !== method || pending.paramsSignature !== paramsSignature) {
        write({ id: rpcId, result: interactionDecline(method, "Conflicting ZCode interaction request id") });
        entry.onEvent({
          type: "interaction_request_conflict",
          summary: "ZCode reused an interaction request id with different request data; the conflicting request was declined",
          details: { request_id: requestId, method },
        });
        return;
      }
      if (!pending.requestIds.includes(rpcId)) pending.requestIds.push(rpcId);
      if (pending.response) write({ id: rpcId, result: pending.response });
      return;
    }
    pending = { requestIds: [rpcId], method, paramsSignature, resolving: true };
    entry.interactions.set(requestId, pending);
    this.#onInteractionState?.("waiting");
    const request: ZCodeInteractionRequest = { request_id: requestId, method, params };
    const fallback = interactionDecline(method, "Bridge interaction reply is unavailable");
    void (async () => {
      let response = fallback;
      try {
        if (this.#resolveInteraction) response = await this.#resolveInteraction(request, entry.abort.signal);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        entry.onEvent({
          type: "interaction_reply_failed",
          summary: `Could not deliver the calling host's response to ZCode: ${messageText}`.slice(0, 1_500),
          details: { request_id: requestId, method },
        });
      }
      pending!.response = response;
      pending!.resolving = false;
      if (entry.abort.signal.aborted) return;
      this.#onInteractionState?.("resumed");
      for (const id of pending!.requestIds) write({ id, result: response });
      entry.onEvent({
        type: "interaction_replied",
        summary: `the calling host replied to ZCode ${method === "interaction/requestPermission" ? "permission request" : "user input request"}`,
        details: { request_id: requestId, method },
      });
      while (entry.interactions.size > 128) {
        const oldest = entry.interactions.keys().next().value as string | undefined;
        if (!oldest || entry.interactions.get(oldest)?.resolving) break;
        entry.interactions.delete(oldest);
      }
    })().catch(() => entry.rejectTurn(new Error("ZCode interaction delivery failed")));
  }

  /** Settles a completion that was held in the pending boundary. */
  #settlePendingCompletion(entry: RunEntry): void {
    if (entry.pendingTimer) { clearTimeout(entry.pendingTimer); entry.pendingTimer = null; }
    const held = entry.pendingCompletion;
    if (!held) return;
    entry.pendingCompletion = null;
    if (entry.awaitingTurnStart) {
      entry.awaitingTurnStart = false;
      entry.turnBinding = "compat";
      entry.onEvent({
        type: "turn_binding_compat",
        summary: "turn.started never arrived for the accepted send; completion settled through the bounded compatibility window",
      });
    }
    entry.turnCompletedAt = this.#now().toISOString();
    this.#resolveTurnCompleted(entry, held.payload, held.event);
  }

  /** Single settle path for turn completions; resultType is validated here so
   * an unknown terminal is never mistaken for success (B2). */
  #resolveTurnCompleted(entry: RunEntry, payload: JsonRecord, event: JsonRecord): void {
    if (entry.turnBinding === "pending") entry.turnBinding = entry.turnId ? "strict" : "compat";
    entry.resolveTurn({
      response: typeof payload.response === "string" ? payload.response : "",
      usage: publicUsage(payload.usage),
      resultType: typeof payload.resultType === "string" ? payload.resultType : null,
      binding: entry.turnBinding,
      startedAt: entry.turnStartedAt,
      completedAt: entry.turnCompletedAt ?? this.#now().toISOString(),
      rpcAcceptedAt: entry.rpcAcceptedAt,
    });
    void event;
  }

  #modelProfile(entry: RunEntry): import("../interfaces.js").ExecutionProfile | null {
    if (!entry.selectedModel && !entry.selectedModelSelection) return null;
    return {
      executor: "zcode",
      provider_id: entry.selectedModelSelection?.providerId ?? null,
      model_id: entry.selectedModelSelection?.modelId ?? entry.selectedModel,
      requested_model: entry.requestedModel,
      requested_reasoning_level: entry.requestedReasoningLevel,
      effective_reasoning_level: entry.selectedReasoningLevel,
      effective_reasoning_level_source: entry.reasoningLevelSource,
      selection_source: entry.modelSource ?? "runtime",
      effective_at: entry.turnStartedAt ?? entry.rpcAcceptedAt ?? null,
      session_id: entry.sessionId,
      turn_id: entry.turnId,
    };
  }

  #publishSessionEvent(type: string, payload: JsonRecord, entry: RunEntry, event: JsonRecord, failureCode?: string): void {
    if (type === "turn.started") {
      entry.onEvent({
        type: "turn_started",
        summary: `ZCode turn started${entry.selectedModel ? ` with selected model ${entry.selectedModel}` : ""}`,
        details: {
          ...(typeof event.turnId === "string" ? { turn_id: event.turnId } : typeof payload.turnId === "string" ? { turn_id: payload.turnId } : {}),
          ...(typeof event.seq === "number" ? { event_seq: event.seq } : {}),
        },
      });
    } else if (type === "model.streaming") {
      const kind = payload.kind;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if ((kind === "text_start" || kind === "text_delta") && !entry.textOutputStarted) {
        entry.textOutputStarted = true;
        entry.onEvent({
          type: "model_output_started",
          summary: `ZCode began returning visible model output${entry.selectedModel ? ` (${entry.selectedModel})` : ""}`,
          details: entry.selectedModel ? { selected_model: entry.selectedModel } : undefined,
        });
      }
      if (kind === "text_delta" && delta) {
        entry.onEvent({ type: "model_output", summary: delta });
      } else if (kind === "tool_call") {
        const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        entry.onEvent({
          type: "model_tool_call",
          summary: `Model requested tool ${name}`,
          details: { tool_name: name, ...(callId ? { tool_call_id: callId } : {}) },
        });
      }
    } else if (type === "tool.updated") {
      const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const state = typeof payload.kind === "string" ? payload.kind : "updated";
      const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      entry.onEvent({
        type: "tool_status",
        summary: `${name}: ${state}`,
        details: { tool_name: name, state, ...(callId ? { tool_call_id: callId } : {}) },
      });
    } else if (type === "turn.completed") {
      entry.onEvent({
        type: "turn_completed",
        summary: "ZCode turn completed",
        details: {
          ...(typeof payload.tokenCount === "number" ? { token_count: payload.tokenCount } : {}),
          ...(typeof payload.toolCallCount === "number" ? { tool_call_count: payload.toolCallCount } : {}),
          ...(typeof event.seq === "number" ? { event_seq: event.seq } : {}),
          ...(typeof event.turnId === "string" ? { turn_id: event.turnId } : {}),
          ...(publicUsage(payload.usage) ? { usage: publicUsage(payload.usage) } : {}),
        },
      });
    } else if (type === "turn.failed") {
      entry.onEvent({
        type: "turn_failed",
        summary: failureCode === "zcode_usage_exhausted"
          ? "ZCode 提供方报告用量额度已耗尽；当前执行已中断。请立即停止当前任务并告知用户，等待用户确认额度恢复。"
          : "ZCode turn failed",
        ...(failureCode ? { details: { error_code: failureCode } } : {}),
      });
    }
  }

  #buildChildEnv(config: ZCodeRuntimeConfig, source = this.#childEnvBase): NodeJS.ProcessEnv {
    const env = createMinimalOsEnv(source);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    if (source.ZCODE_HOME) env.ZCODE_HOME = source.ZCODE_HOME;
    const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
    if (dataBaseDir) env.ZCODE_DATA_BASE_DIR = dataBaseDir;
    return env;
  }

  #require(handle: AgentHandle, method: string): RunEntry {
    const entry = this.#runs.get(handle);
    if (!entry) throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    return entry;
  }
}

function interactionDecline(
  method: ZCodeInteractionRequest["method"],
  reason: string,
): Record<string, unknown> {
  return method === "interaction/requestPermission"
    ? { decision: "deny", reason }
    : { action: "decline", reason };
}

function readSelectedModel(snapshot: JsonRecord): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  const modelId = typeof current.modelId === "string" ? current.modelId : null;
  const providerId = typeof current.providerId === "string" ? current.providerId : null;
  if (!modelId) return null;
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const match = available.find((entry) => {
    const ref = asRecord(asRecord(entry).ref);
    return ref.modelId === modelId && (providerId === null || ref.providerId === providerId);
  });
  const label = match && typeof asRecord(match).label === "string" ? asRecord(match).label as string : modelId;
  return providerId ? `${label} (${providerId}/${modelId})` : label;
}

function readSelectedModelSelection(snapshot: JsonRecord): { providerId: string; modelId: string } | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  if (typeof current.providerId !== "string" || typeof current.modelId !== "string") return null;
  return { providerId: current.providerId, modelId: current.modelId };
}

function readAvailableModels(snapshot: JsonRecord): Array<{ providerId: string; modelId: string }> {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const refs = new Map<string, { providerId: string; modelId: string }>();
  for (const entry of available) {
    const ref = asRecord(asRecord(entry).ref);
    if (typeof ref.providerId !== "string" || typeof ref.modelId !== "string") continue;
    const key = `${ref.providerId}\u0000${ref.modelId}`;
    refs.set(key, { providerId: ref.providerId, modelId: ref.modelId });
  }
  return [...refs.values()];
}

function readModelReasoningDefault(snapshot: JsonRecord, providerId: string, modelId: string): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  for (const item of available) {
    const entry = asRecord(item);
    const ref = asRecord(entry.ref);
    if (ref.providerId !== providerId || ref.modelId !== modelId) continue;
    const reasoning = asRecord(entry.reasoning);
    if (typeof reasoning.defaultLevel === "string" && reasoning.defaultLevel.trim()) {
      return reasoning.defaultLevel;
    }
    const levels = Array.isArray(reasoning.levels) ? reasoning.levels : [];
    if (levels.length === 1) {
      const value = asRecord(levels[0]).value;
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

/** Read the active level reported by the session, never substitute catalog defaults. */
function readEffectiveReasoningLevel(snapshot: JsonRecord): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  const options = asRecord(current.options);
  const currentOption = options.reasoningLevel;
  if (typeof currentOption === "string" && currentOption.trim()) return currentOption.trim();
  const thoughtLevel = asRecord(settings.thoughtLevel);
  const level = thoughtLevel.current;
  return typeof level === "string" && level.trim() ? level.trim() : null;
}

function nestedString(record: JsonRecord, path: string[]): string | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "string" ? value : null;
}

function nestedNumber(record: JsonRecord, path: string[]): number | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** Classify only explicit quota-exhaustion claims from allowlisted provider fields. */
function providerReportedUsageExhaustion(value: unknown): boolean {
  const error = asRecord(value);
  const candidates = [
    typeof value === "string" ? value : null,
    typeof error.code === "string" ? error.code : null,
    typeof error.type === "string" ? error.type : null,
    typeof error.message === "string" ? error.message : null,
  ].filter((candidate): candidate is string => candidate !== null)
    .map((candidate) => candidate.slice(0, 2_048));
  if (candidates.length === 0) return false;

  const text = candidates.join("\n").normalize("NFKC").toLowerCase();
  return [
    /\binsufficient[_\s-]+quota\b/,
    /\bquota[_\s-]+(?:(?:has[_\s-]+been)[_\s-]+)?(?:exceeded|exhausted|depleted)\b/,
    /\b(?:usage|token)[_\s-]+quota[_\s-]+(?:exceeded|exhausted|depleted)\b/,
    /\b(?:usage|token)[_\s-]+limit[_\s-]+(?:exceeded|exhausted|reached)\b/,
    /\b(?:out[_\s-]+of|no[_\s-]+remaining|insufficient[_\s-]+)(?:[_\s-]+)?credits?\b/,
    /\bcredits?[_\s-]+(?:exhausted|depleted)\b/,
    /\bbilling[_\s-]+hard[_\s-]+limit[_\s-]+reached\b/,
    /(?:用量|额度|配额)(?:已|已经)?(?:用尽|耗尽|用完|不足)/,
    /(?:用尽|耗尽|用完|不足)(?:了)?(?:用量|额度|配额)/,
    /(?:超出|超过)(?:了)?(?:当前)?(?:用量|额度|配额)/,
    /(?:当前)?(?:用量|额度|配额)(?:已经)?(?:超出|不足)/,
  ].some((pattern) => pattern.test(text));
}

async function syncDesktopStatus(
  entry: DesktopTaskIndexEntry | null,
  status: DesktopTaskStatus,
  onEvent: ProgressSink,
): Promise<void> {
  if (!entry) return;
  try {
    await updateDesktopTaskStatus(entry, status);
  } catch (error) {
    reportDesktopIndexIssue(onEvent, error);
  }
}

function reportDesktopIndexIssue(onEvent: ProgressSink, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  onEvent({
    type: "desktop_task_index_warning",
    summary: `ZCode Desktop task index could not be updated: ${message.slice(0, 500)}`,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
