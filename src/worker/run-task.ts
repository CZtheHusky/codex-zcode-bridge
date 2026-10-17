// Worker execution body: runs one attempt of one task against the adapter and
// persists all evidence via the TaskStore. The worker process shell
// (worker-main.ts) calls this with a real ZCodeAdapter; tests call it directly
// with a fake adapter. Only paths, statuses, bounded logs, and attempt
// metadata are persisted — never child environments or credentials.
import type {
  AgentHandle,
  CodingAgentAdapter,
  ExecutionProfile,
  NormalizedUsage,
  RuntimeResolver,
  TaskResult,
  WorkspaceRef,
  ZCodeInteractionRequest,
} from "../interfaces.js";
import { ZCodeAppServerAdapter } from "../adapters/zcode-app-server-adapter.js";
import type { ZCodeRunOutcome } from "../adapters/zcode-adapter.js";
import { BridgeError } from "../runtime/errors.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { buildTaskResult, type TaskFailure } from "../manager/normalize.js";
import { InteractionRequestTooLargeError, stableJson, TaskStore, type WorkerHeartbeat } from "../store/task-store.js";
import type { TaskProgressEvent } from "../interfaces.js";
import type { BridgeHostProfile } from "../host/profile.js";
import { createPlatformProbe, type ProcessProbe } from "../runtime/process-probe.js";
import { normalizeUsage, phaseDuration } from "../usage/normalize.js";

/**
 * The worker needs the frozen adapter contract except that getResult must
 * expose the adapter-normalization evidence (agentReport/errorCode/...).
 */
export type WorkerAdapter = Omit<CodingAgentAdapter, "getResult"> & {
  getResult(handle: AgentHandle): Promise<ZCodeRunOutcome>;
};

export interface ContinueSpec {
  readonly feedback: string;
  readonly additional_requirements?: string[];
  readonly previous_session_id: string | null;
  readonly previous_attempt: number;
}

export interface RunWorkerTaskOptions {
  readonly dataRoot: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly host?: BridgeHostProfile;
  adapter?: WorkerAdapter;
  resolver?: RuntimeResolver;
  now?: () => Date;
  /** Defaults to the platform probe; the worker persists its own and the
   * runtime's process identity so recovery never guesses (A2). */
  probe?: ProcessProbe;
}

export interface RunWorkerTaskResult {
  readonly status: TaskResult["status"];
  readonly result: TaskResult;
}

export async function runWorkerTask(options: RunWorkerTaskOptions): Promise<RunWorkerTaskResult> {
  const store = new TaskStore(options.dataRoot);
  const now = options.now ?? (() => new Date());
  const probe = options.probe ?? createPlatformProbe();
  const taskId = options.taskId;
  const task = store.readTask(taskId);
  const initialStatus = store.readStatus(taskId);
  const attempt = options.attempt;
  if (!store.claimWorkerExecution(taskId, attempt)) throw new Error("worker attempt already claimed, stale, or terminal");

  let observationRevision = 0;
  let activityPhase = "preparing";
  const writePhase = (): void => {
    observationRevision += 1;
    try {
      store.writeWorkerObservation(taskId, attempt, process.pid, { activity_phase: activityPhase }, observationRevision, now().toISOString());
    } catch { /* observation is advisory; never blocks execution */ }
  };

  // Defensive: the manager normally cancels before the worker starts; if the
  // intent was recorded first, finish as cancelled without touching the agent.
  if (initialStatus.cancel_requested === true) {
    const finishedAt = now().toISOString();
    const result = buildTaskResult({
      task,
      attempt,
      startedAt: initialStatus.started_at,
      finishedAt,
      outcome: null,
      failure: { code: "cancelled", message: "cancelled by request before the worker started the agent" },
      cancelled: true,
    });
    store.commitWorkerResult(taskId, attempt, result, { status: "cancelled", finished_at: finishedAt, worker_pid: null });
    return { status: result.status, result };
  }

  const startedAt = initialStatus.started_at ?? now().toISOString();
  store.writeStatus(taskId, { status: "running", started_at: startedAt, worker_pid: process.pid }, attempt);
  store.appendEvent(taskId, "worker_running", "Task worker is preparing the ZCode runtime");
  store.writeAttemptMeta(taskId, attempt, "started.json", {
    worker_pid: process.pid,
    started_at: startedAt,
  });
  writePhase();

  // Late-identity lifecycle (2026-10-17 review): the identity probes are
  // advisory, but their store writes are NOT allowed to outlive this attempt.
  // A promise resolving after the caller tore the fixture/store down would
  // recreate the directory tree (writeAttemptMeta mkdirs) — an observed
  // resurrection defect, not a theoretical one. Every identity write is
  // tracked and reaped with a bounded budget before the attempt's terminal
  // artifacts are committed; anything still pending after the budget is
  // dropped (a null identity is documented, valid state per A2) so it can
  // never write again. The Windows platform probe resolves in roughly half a
  // second (batch PowerShell Get-Process), so the budget is generous.
  const IDENTITY_WRITE_REAP_MS = 2_000;
  const identityWrites = new Set<Promise<void>>();
  let identityWritesClosed = false;
  const trackIdentityWrite = (write: Promise<void>): void => {
    identityWrites.add(write);
    void write.then(() => identityWrites.delete(write), () => identityWrites.delete(write));
  };
  const reapIdentityWrites = async (): Promise<void> => {
    if (identityWritesClosed) return;
    const deadline = Date.now() + IDENTITY_WRITE_REAP_MS;
    while (identityWrites.size > 0 && Date.now() < deadline) await sleep(25);
    identityWritesClosed = true;
  };

  // Persist this executor's OS identity so recovery probes can distinguish a
  // dead worker from a recycled PID (A2). Best effort and asynchronous.
  trackIdentityWrite(probe.selfIdentity().then(
    (identity) => {
      if (identityWritesClosed) return;
      store.writeExecutorIdentity(taskId, attempt, { worker: identity as unknown as Record<string, unknown> });
      observationRevision += 1;
      try {
        store.writeWorkerObservation(taskId, attempt, process.pid, { worker_identity: identity as unknown as Record<string, unknown> }, observationRevision, now().toISOString());
      } catch { /* advisory */ }
    },
    () => undefined,
  ));

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let persistCorrelationTimer: ReturnType<typeof setInterval> | undefined;
  try {

    const heartbeat: WorkerHeartbeat = {
      attempt,
      worker_pid: process.pid,
      started_at: startedAt,
      heartbeat_at: now().toISOString(),
      heartbeat_seq: 0,
      session_id: initialStatus.zcode_session_id ?? null,
      turn_id: null,
      last_event_seq: 0,
      last_event_type: "worker_running",
      zcode_event_seq: 0,
    };
    const persistHeartbeat = (): void => {
      heartbeat.heartbeat_at = now().toISOString();
      heartbeat.heartbeat_seq += 1;
      store.writeWorkerHeartbeat(taskId, attempt, heartbeat);
      writePhase(); // B3 snapshot rides the heartbeat cadence; heartbeats never touch events
    };
    persistHeartbeat();
    heartbeatTimer = setInterval(() => {
      try { persistHeartbeat(); }
      catch { /* the attempt is already stale/terminal; its owner must stop */ }
    }, 3_000);
    heartbeatTimer.unref();

    const continueSpec = store.readAttemptMeta<ContinueSpec>(taskId, attempt, "continue.json");
    const previousResult = continueSpec
      ? store.readArchivedResult(taskId, continueSpec.previous_attempt ?? attempt - 1)
      : null;

    // Archive the exact prompt for this attempt (pure rebuild from the same
    // inputs the adapter uses).
    const promptText = continueSpec
      ? buildContinuePrompt({
          task,
          feedback: continueSpec.feedback,
          additionalRequirements: continueSpec.additional_requirements ?? [],
          previousSessionId: continueSpec.previous_session_id,
          previousResult,
        })
      : buildTaskPrompt(task);
    store.writeAttemptFile(taskId, attempt, "prompt.txt", promptText);

    // B2 correlation record: persisted timestamps for RPC accept, turn start,
    // and turn completion, written as the events arrive.
    const correlation: { rpc_accepted_at: string | null; turn_started_at: string | null; turn_completed_at: string | null; turn_id: string | null; session_id: string | null } = {
      rpc_accepted_at: null,
      turn_started_at: null,
      turn_completed_at: null,
      turn_id: null,
      session_id: initialStatus.zcode_session_id ?? null,
    };
    const persistCorrelation = (): void => {
      try { store.writeAttemptMeta(taskId, attempt, "turn-correlation.json", { ...correlation }); }
      catch { /* advisory evidence */ }
    };
    persistCorrelationTimer = setInterval(persistCorrelation, 5_000);
    persistCorrelationTimer.unref();

    // B4 runtime-confirmed execution profile (model / reasoning depth).
    const modelProfile: ExecutionProfile = {
      executor: "zcode",
      provider_id: null,
      model_id: null,
      requested_model: task.model ? `${task.model.provider_id}/${task.model.model_id}` : null,
      requested_reasoning_level: task.model?.reasoning_level ?? null,
      effective_reasoning_level: null,
      effective_reasoning_level_source: "not_reported",
      selection_source: null,
      effective_at: null,
      session_id: initialStatus.zcode_session_id ?? null,
      turn_id: null,
    };

    let outcome: ZCodeRunOutcome | null = null;
    let failure: TaskFailure | null = null;
    let pendingModelOutput = "";
    let lastModelOutputAt = 0;
    const flushModelOutput = (): void => {
      if (!pendingModelOutput) return;
      store.assertWorkerAttempt(taskId, attempt);
      for (let offset = 0; offset < pendingModelOutput.length; offset += 2_000) store.appendEvent(taskId, "model_output", pendingModelOutput.slice(offset, offset + 2_000));
      pendingModelOutput = "";
      lastModelOutputAt = Date.now();
    };
    try {
      if (options.resolver) {
        // Surface configuration problems before spending an adapter run; the
        // real adapter resolves internally as well.
        await options.resolver.resolve();
      }
      const adapter = options.adapter ?? new ZCodeAppServerAdapter({
        host: options.host,
        ...(options.resolver ? { resolver: options.resolver } : {}),
        onEvent: (event) => {
          store.assertWorkerAttempt(taskId, attempt);
          if (event.type === "model_output") {
            pendingModelOutput += event.summary;
            if (pendingModelOutput.length >= 4_000 || Date.now() - lastModelOutputAt >= 500) flushModelOutput();
            return;
          }
          flushModelOutput();
          const persistedEvent = store.appendEvent(taskId, event.type, event.summary, event.details);
          if (persistedEvent) {
            heartbeat.last_event_seq = persistedEvent.seq;
            heartbeat.last_event_type = event.type;
          }
          const sessionId = event.type === "session_ready" ? event.details?.["session_id"] : undefined;
          if (typeof sessionId === "string") {
            heartbeat.session_id = sessionId;
            correlation.session_id = sessionId;
            modelProfile.session_id = sessionId;
            store.writeStatus(taskId, { zcode_session_id: sessionId }, attempt);
          }
          if (event.type === "turn_started") {
            correlation.rpc_accepted_at = correlation.rpc_accepted_at ?? now().toISOString();
            correlation.turn_started_at = now().toISOString();
            if (typeof event.details?.["turn_id"] === "string") {
              heartbeat.turn_id = event.details["turn_id"];
              correlation.turn_id = event.details["turn_id"];
              modelProfile.turn_id = event.details["turn_id"];
            }
            activityPhase = "executing";
            writePhase();
          }
          if (event.type === "turn_completed") {
            correlation.turn_completed_at = now().toISOString();
            activityPhase = "finalizing";
            writePhase();
          }
          if (event.type === "model_selected") {
            // Runtime-confirmed model evidence; requested values never impersonate it.
            if (typeof event.details?.["provider_id"] === "string") modelProfile.provider_id = event.details["provider_id"];
            if (typeof event.details?.["model_id"] === "string") modelProfile.model_id = event.details["model_id"];
            if (typeof event.details?.["selected_model"] === "string" && modelProfile.model_id === null) {
              modelProfile.model_id = event.details["selected_model"];
            }
            if (typeof event.details?.["reasoning_level"] === "string") {
              modelProfile.effective_reasoning_level = event.details["reasoning_level"];
              modelProfile.effective_reasoning_level_source = "runtime";
            }
            if (typeof event.details?.["model_source"] === "string") modelProfile.selection_source = event.details["model_source"];
            modelProfile.effective_at = now().toISOString();
          }
          if (typeof event.details?.["event_seq"] === "number") heartbeat.zcode_event_seq = event.details["event_seq"];
          if (event.type === "app_server_started" && typeof event.details?.["pid"] === "number") {
            store.writeStatus(taskId, { zcode_pid: event.details["pid"] }, attempt);
            trackIdentityWrite(probe.identityOf(event.details["pid"]).then(
              (identity) => {
                // Advisory evidence; a store that vanished after the attempt
                // ended must not surface as an unhandled rejection, and a late
                // resolve after the reap budget must never resurrect it.
                if (identityWritesClosed) return;
                try {
                  store.writeExecutorIdentity(taskId, attempt, { runtime: identity as unknown as Record<string, unknown> });
                  observationRevision += 1;
                  store.writeWorkerObservation(taskId, attempt, process.pid, { runtime_identity: identity as unknown as Record<string, unknown> }, observationRevision, now().toISOString());
                } catch { /* advisory */ }
              },
              () => undefined,
            ));
          }
        },
        onInteractionState: (state) => {
          activityPhase = state === "waiting" ? "waiting_for_permission" : "executing";
          writePhase();
        },
        onOutcomeCheckpoint: (checkpoint) => {
          store.writeAttemptMeta(taskId, attempt, "outcome-checkpoint.json", {
            recorded_at: now().toISOString(),
            exit_code: checkpoint.exitCode,
            signal: checkpoint.signal,
            session_id: checkpoint.sessionId,
            response: checkpoint.response,
            usage: checkpoint.usage,
            error_code: checkpoint.errorCode,
            report_error: checkpoint.reportError,
            agent_report: checkpoint.agentReport,
            report_candidate: checkpoint.reportCandidate,
            cleanup_error: checkpoint.cleanupError ?? null,
            cleanup_verified: checkpoint.cleanupVerified === true,
            usage_normalized: normalizeUsage(checkpoint.usage, { source: "zcode_runtime_turn", scope: checkpoint.sessionId ? `session:${checkpoint.sessionId}` : null, observedAt: now().toISOString() }),
            model_profile: modelProfile,
          });
        },
        resolveInteraction: async (request, signal) => {
          store.assertWorkerAttempt(taskId, attempt);
          const safeRequest = sanitizeInteractionRequest({ ...request, request_id: `${attempt}:${request.request_id}` });
          // ADR-008: persistence failures get an explicit recoverable reason and
          // never masquerade as a generic "reply unavailable" denial. Nothing is
          // executed and no approval is left pending.
          let record: ReturnType<TaskStore["writeInteractionRequest"]>["record"];
          let created = false;
          try {
            const written = store.writeInteractionRequest(taskId, safeRequest, now().toISOString());
            record = written.record;
            created = written.created;
          } catch (error) {
            if (error instanceof InteractionRequestTooLargeError) {
              store.appendEvent(taskId, "interaction_request_oversized", `ZCode requested approval of a tool input too large to deliver: ${error.actualBytes} UTF-8 bytes, over the ${error.limitBytes}-byte limit; the request was declined and nothing was executed`, {
                error_code: "interaction_params_over_limit",
                request_id: safeRequest.request_id,
                method: safeRequest.method,
                actual_bytes: error.actualBytes,
                limit_bytes: error.limitBytes,
              }, now().toISOString());
              return interactionDecline(request.method,
                `Bridge cannot deliver this approval request: the tool input is ${error.actualBytes} UTF-8 bytes, over the ${error.limitBytes}-byte limit. Split the input into smaller parts (for example write the file in multiple Write or append steps) and retry. Nothing was executed.`);
            }
            store.appendEvent(taskId, "interaction_request_undeliverable", "ZCode requested approval but the Bridge could not persist the request for the calling host; the request was declined and nothing was executed", {
              error_code: "interaction_persist_failed",
              request_id: safeRequest.request_id,
              method: safeRequest.method,
            }, now().toISOString());
            return interactionDecline(request.method,
              `Bridge could not persist this approval request for the calling host (${safeErrorSummary(error)}); the request was declined and nothing was executed. Split the input into smaller parts and retry.`);
          }
          activityPhase = request.method === "interaction/requestPermission" ? "waiting_for_permission" : "waiting_for_user";
          writePhase();
          if (created) {
            const published = publishInteractionRequest(store, taskId, safeRequest, record!);
            if (!published.event) {
              store.appendEvent(taskId, "interaction_request_undeliverable", `ZCode requested approval but the Bridge could not publish it to the calling host (${published.declineReason}); the request was declined and nothing was executed`, {
                error_code: "interaction_publish_failed",
                request_id: safeRequest.request_id,
                method: safeRequest.method,
              }, now().toISOString());
              const fallback = interactionDecline(request.method, published.declineReason);
              store.answerInteractionRequest(taskId, safeRequest.request_id, fallback, now().toISOString());
              activityPhase = "executing";
              writePhase();
              return fallback;
            }
          }
          let answer: Record<string, unknown> | null = null;
          while (!signal.aborted) {
            store.assertWorkerAttempt(taskId, attempt);
            let current: ReturnType<TaskStore["readInteractionRequest"]>;
            try {
              current = store.readInteractionRequest(taskId, safeRequest.request_id);
            } catch (error) {
              // The full record became unreadable mid-wait; a corrupted request
              // must not hang or count as authorization (ADR-008).
              activityPhase = "executing";
              writePhase();
              store.appendEvent(taskId, "interaction_request_undeliverable", "The persisted ZCode interaction request became unreadable while waiting for the calling host; the request was declined and nothing was executed", {
                error_code: "interaction_record_unreadable",
                request_id: safeRequest.request_id,
                method: safeRequest.method,
              }, now().toISOString());
              return interactionDecline(request.method,
                `Bridge can no longer read the full content of this approval request (${safeErrorSummary(error)}); the request was declined and nothing was executed.`);
            }
            if (!current) {
              // The full record vanished mid-wait; waiting can never resolve, so
              // decline explicitly instead of polling forever (ADR-008).
              activityPhase = "executing";
              writePhase();
              store.appendEvent(taskId, "interaction_request_undeliverable", "The persisted ZCode interaction request disappeared while waiting for the calling host; the request was declined and nothing was executed", {
                error_code: "interaction_record_missing",
                request_id: safeRequest.request_id,
                method: safeRequest.method,
              }, now().toISOString());
              return interactionDecline(request.method,
                "Bridge can no longer read the full content of this approval request (the persisted record disappeared); the request was declined and nothing was executed.");
            }
            if (current.state === "answered" && current.answer) {
              // An answer may only be consumed while the persisted request is
              // still the one this worker received from ZCode; an edited record
              // never counts as authorization, even with self-consistent
              // metadata (ADR-008).
              if (current.method !== safeRequest.method || stableJson(current.params) !== stableJson(safeRequest.params)) {
                activityPhase = "executing";
                writePhase();
                store.appendEvent(taskId, "interaction_request_undeliverable", "The persisted ZCode interaction request no longer matches the request ZCode sent; the request was declined and nothing was executed", {
                  error_code: "interaction_record_mismatch",
                  request_id: safeRequest.request_id,
                  method: safeRequest.method,
                }, now().toISOString());
                return interactionDecline(request.method,
                  "Bridge can no longer read the full content of this approval request (the persisted record no longer matches the request ZCode sent); the request was declined and nothing was executed.");
              }
              answer = current.answer;
              break;
            }
            await sleep(250);
          }
          activityPhase = "executing";
          writePhase();
          if (answer) return answer;
          return interactionDecline(request.method, "The task attempt ended before the calling host replied; nothing was executed");
        },
      });
      const workspaceRef: WorkspaceRef = store.readWorkspaceRef(taskId) ?? {
        requestedPath: task.workspace,
        canonicalPath: task.worktree_path ?? task.workspace,
        mode: task.worktree_path ? "worktree" : "direct",
        ...(task.worktree_path ? { sourcePath: task.workspace } : {}),
      };
      const handle = continueSpec
        ? await adapter.continueTask({
            task,
            workspace: workspaceRef,
            attempt,
            feedback: continueSpec.feedback,
            additionalRequirements: [...(continueSpec.additional_requirements ?? [])],
            previousSessionId: continueSpec.previous_session_id,
            previousResult,
          })
        : await adapter.startTask({ task, workspace: workspaceRef, attempt });
      // The manager persists cancellation intent before its bounded fallback
      // kill. Observe it while the runtime is active so the adapter can abort
      // pending interactions and classify the exit as cancellation first.
      let cancelTimer: ReturnType<typeof setInterval> | undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancelTimer = setInterval(() => {
          try {
            const current = store.readStatus(taskId);
            if (current.attempt !== attempt || !current.cancel_requested) return;
            clearInterval(cancelTimer);
            void adapter.cancelTask(handle).catch(reject);
          } catch (error) {
            clearInterval(cancelTimer);
            reject(error);
          }
        }, 50);
      });
      try { outcome = await Promise.race([adapter.getResult(handle), cancellation]); }
      finally { clearInterval(cancelTimer); }
      if (outcome.cleanupError) failure = { code: "cleanup_failed", message: `ZCode returned a turn result, but process cleanup could not be verified: ${outcome.cleanupError}` };
      flushModelOutput();
    } catch (error) {
      flushModelOutput();
      failure = {
        code: error instanceof BridgeError ? error.code : "worker_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await reapIdentityWrites(); // land identity evidence before terminal artifacts; bounded, then closed
    activityPhase = "finalizing";
    writePhase();

    const finishedAt = now().toISOString();
    store.assertWorkerAttempt(taskId, attempt);
    const stdoutLog = store.appendLog(taskId, "stdout", outcome?.stdout ? `${outcome.stdout}\n` : "");
    const stderrLog = store.appendLog(
      taskId,
      "stderr",
      outcome?.stderr
        ? `${outcome.stderr}\n`
        : failure
          ? `${failure.code}: ${failure.message}\n`
          : "",
    );

    // The event-driven profile is authoritative; when the runtime reported the
    // selection through the outcome only (no model_selected event reached us),
    // adopt that evidence instead of leaving nulls (B4-12).
    if (modelProfile.model_id === null && outcome?.modelProfile?.model_id) {
      Object.assign(modelProfile, outcome.modelProfile);
    }
    // Turn boundaries likewise fall back to the outcome's correlation record.
    correlation.rpc_accepted_at = correlation.rpc_accepted_at ?? outcome?.phaseTimestamps?.rpc_accepted_at ?? null;
    correlation.turn_started_at = correlation.turn_started_at ?? outcome?.phaseTimestamps?.turn_started_at ?? null;
    correlation.turn_completed_at = correlation.turn_completed_at ?? outcome?.phaseTimestamps?.turn_completed_at ?? null;
    if (modelProfile.turn_id === null && correlation.turn_id) modelProfile.turn_id = correlation.turn_id;
    // B4 timing with explicit boundaries; a regressed/missing clock yields null
    // notes instead of negative or fabricated values.
    const timingNotes: string[] = [];
    const timing = {
      queued_ms: phaseDuration(initialStatus.created_at, startedAt, timingNotes),
      execution_ms: phaseDuration(startedAt, finishedAt, timingNotes),
      turn_ms: phaseDuration(correlation.turn_started_at, correlation.turn_completed_at, timingNotes),
      finalize_ms: phaseDuration(correlation.turn_completed_at, finishedAt, timingNotes),
      wall_ms: phaseDuration(startedAt, finishedAt, timingNotes),
      derived: false,
      notes: timingNotes,
    };
    const usage: NormalizedUsage | null = normalizeUsage(outcome?.usage ?? null, {
      source: "zcode_runtime_turn",
      scope: outcome?.sessionId ? `session:${outcome.sessionId}` : null,
      observedAt: finishedAt,
    });
    persistCorrelation();

    store.writeAttemptMeta(taskId, attempt, "outcome.json", {
      started_at: startedAt,
      finished_at: finishedAt,
      failure,
      outcome: outcome
        ? {
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            sessionId: outcome.sessionId,
            response: outcome.response,
            usage: outcome.usage,
            timedOut: outcome.timedOut,
            cancelled: outcome.cancelled,
            attempts: outcome.attempts,
            errorCode: outcome.errorCode,
            reportError: outcome.reportError,
            stdoutTruncated: outcome.stdoutTruncated,
            stderrTruncated: outcome.stderrTruncated,
            agentReport: outcome.agentReport,
            reportCandidate: outcome.reportCandidate,
            cleanupError: outcome.cleanupError ?? null,
            cleanupVerified: outcome.cleanupVerified === true,
          }
        : null,
      usage_normalized: usage,
      model_profile: modelProfile,
      timing,
      correlation: { ...correlation },
      logs: { stdout_truncated: stdoutLog.truncated, stderr_truncated: stderrLog.truncated },
    });

    const result = buildTaskResult({
      task,
      attempt,
      startedAt,
      finishedAt,
      outcome,
      failure,
      cancelled: outcome?.cancelled === true || failure?.code === "cancelled",
      sessionId: store.readStatus(taskId).zcode_session_id ?? continueSpec?.previous_session_id,
      usage,
      model: modelProfile,
      timing,
    });
    store.appendEvent(taskId, "task_finished", `Task reached terminal status: ${result.status}`, {
      status: result.status,
      needs_master_decision: result.needs_master_decision,
    }, finishedAt);
    store.commitWorkerResult(taskId, attempt, result, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      zcode_session_id: result.session_id,
      error_code: result.error_code ?? null,
      error: result.status === "failed" ? result.summary : null,
      worker_pid: null,
      cleanup_unverified: failure?.code === "cleanup_failed",
      zcode_pid: failure?.code === "cleanup_failed" ? store.readStatus(taskId).zcode_pid : null,
    });
    return { status: result.status, result };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (persistCorrelationTimer) clearInterval(persistCorrelationTimer);
    await reapIdentityWrites();
  }
}

function interactionSummary(request: ZCodeInteractionRequest): string {
  const params = request.params;
  if (request.method === "interaction/requestPermission") {
    const toolName = typeof params.toolName === "string" ? params.toolName : "tool";
    const reason = typeof params.reason === "string" ? `: ${params.reason}` : "";
    return `ZCode is waiting for the calling host to decide whether ${toolName} may proceed${reason}`;
  }
  if (asRecord(params.schema).interaction === "plan_approval") {
    return "ZCode is waiting for the calling host to approve or reject its plan";
  }
  return "ZCode is waiting for the calling host to answer a question";
}

function publicInteractionDetails(request: ZCodeInteractionRequest): Record<string, unknown> {
  const params = request.params;
  const details: Record<string, unknown> = {
    request_id: request.request_id,
    method: request.method,
    ...(typeof params.sessionId === "string" ? { session_id: params.sessionId } : {}),
    ...(typeof params.toolCallId === "string" ? { tool_call_id: params.toolCallId } : {}),
  };
  for (const key of ["toolName", "reason", "input", "options", "schema", "questions"] as const) {
    if (params[key] !== undefined) details[key] = params[key];
  }
  if (details["questions"] === undefined && Array.isArray(asRecord(params.input).questions)) {
    details["questions"] = asRecord(params.input).questions;
  }
  return details;
}

/** ADR-008 bounded preview budgets; the composed event line stays far below
 * the 64,000-byte single-event limit. */
const PREVIEW_INPUT_BUDGET_BYTES = 20_000;
const PREVIEW_SECONDARY_BUDGET_BYTES = 4_000;
const PREVIEW_REASON_CHARS = 1_500;

export interface InteractionPublishResult {
  /** The persisted interaction_requested event, or null when undeliverable. */
  event: TaskProgressEvent | null;
  /** Explicit recoverable decline reason when the event could not be published. */
  declineReason: string;
}

/**
 * ADR-008: publish one interaction_requested event for a persisted request.
 * Small requests keep the compatible full-detail shape; large ones fall back
 * to a bounded preview that is clearly marked and references the same
 * task/attempt's private full request (path, bytes, SHA256). The large body
 * is never written into the event twice.
 */
export function publishInteractionRequest(
  store: TaskStore,
  taskId: string,
  request: ZCodeInteractionRequest,
  record: { created_at: string; params_bytes?: number; params_sha256?: string },
): InteractionPublishResult {
  const full = store.appendEvent(taskId, "interaction_requested", interactionSummary(request), publicInteractionDetails(request), record.created_at);
  if (full) return { event: full, declineReason: "" };
  const preview = store.appendEvent(taskId, "interaction_requested", interactionSummary(request), previewInteractionDetails(store, taskId, request, record), record.created_at);
  if (preview) return { event: preview, declineReason: "" };
  return {
    event: null,
    declineReason: "Bridge could not publish this request to the calling host because the task event log is out of capacity; the request was declined and nothing was executed. Retry with a smaller input after freeing task history.",
  };
}

/** Bounded, explicitly-marked preview details with a full-request reference. */
export function previewInteractionDetails(
  store: TaskStore,
  taskId: string,
  request: ZCodeInteractionRequest,
  record: { params_bytes?: number; params_sha256?: string },
): Record<string, unknown> {
  const params = request.params;
  const inputBytes = Buffer.byteLength(JSON.stringify(params.input ?? null), "utf8");
  const details: Record<string, unknown> = {
    request_id: request.request_id,
    method: request.method,
    ...(typeof params.sessionId === "string" ? { session_id: params.sessionId } : {}),
    ...(typeof params.toolCallId === "string" ? { tool_call_id: params.toolCallId } : {}),
    ...(typeof params.toolName === "string" ? { tool_name: params.toolName } : {}),
    preview: true,
  };
  if (params.reason !== undefined) {
    const bounded = boundedUtf8Text(typeof params.reason === "string" ? params.reason : JSON.stringify(params.reason), PREVIEW_REASON_CHARS);
    details["reason"] = bounded.text;
    if (bounded.truncated) details["reason_preview_truncated"] = true;
  }
  if (params.input !== undefined) {
    details["input_preview"] = boundedJsonPreview(params.input, PREVIEW_INPUT_BUDGET_BYTES);
    details["input_bytes"] = inputBytes;
  }
  // A questions array duplicated inside input is not written again (ADR-008);
  // standalone questions get their own bounded preview.
  if (params.questions !== undefined && !Array.isArray(asRecord(params.input).questions)) {
    details["questions_preview"] = boundedJsonPreview(params.questions, PREVIEW_SECONDARY_BUDGET_BYTES);
  }
  for (const key of ["options", "schema"] as const) {
    if (params[key] === undefined) continue;
    const serialized = JSON.stringify(params[key]) ?? "null";
    if (Buffer.byteLength(serialized, "utf8") <= PREVIEW_SECONDARY_BUDGET_BYTES) details[key] = params[key];
    else details[`${key}_preview`] = boundedJsonPreview(params[key], PREVIEW_SECONDARY_BUDGET_BYTES);
  }
  details["full_request"] = {
    task_id: taskId,
    request_id: request.request_id,
    file: store.interactionRequestPath(taskId, request.request_id),
    ...(typeof record.params_bytes === "number" ? { bytes: record.params_bytes } : {}),
    ...(record.params_sha256 ? { sha256: record.params_sha256 } : {}),
  };
  return details;
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

/** Bounded UTF-8 text that never splits a multi-byte sequence mid-character. */
function boundedUtf8Text(text: string, budgetBytes: number): BoundedText {
  if (Buffer.byteLength(text, "utf8") <= budgetBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, "utf8").subarray(0, budgetBytes);
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buffer[end - 1]! & 0xc0) === 0xc0) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

function boundedJsonPreview(value: unknown, budgetBytes: number): string {
  const serialized = JSON.stringify(value) ?? "null";
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  const bounded = boundedUtf8Text(serialized, budgetBytes);
  if (!bounded.truncated) return serialized;
  return `${bounded.text}…[preview truncated; showing at most ${budgetBytes} of ${totalBytes} UTF-8 bytes — read full_request.file for the complete input]`;
}

/** Operational failure summary safe for model-facing decline reasons: keeps
 * errno codes and messages, never paths or payloads. */
function safeErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code) return code;
    return error.message.split(/\r?\n/u)[0]!.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

function sanitizeInteractionRequest(request: ZCodeInteractionRequest): ZCodeInteractionRequest {
  const params: Record<string, unknown> = {};
  for (const key of ["sessionId", "toolCallId", "toolName", "reason", "input", "options", "schema", "questions"] as const) {
    if (request.params[key] !== undefined) params[key] = request.params[key];
  }
  if (params["questions"] === undefined && Array.isArray(asRecord(params["input"]).questions)) {
    params["questions"] = asRecord(params["input"]).questions;
  }
  return { request_id: request.request_id, method: request.method, params };
}

function interactionDecline(method: ZCodeInteractionRequest["method"], reason: string): Record<string, unknown> {
  return method === "interaction/requestPermission"
    ? { decision: "deny", reason }
    : { action: "decline", reason };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
