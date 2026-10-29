// Shared observation assembly: reads bounded persisted evidence from the
// TaskStore and feeds the pure judger. coding_agent_status, coding_agent_events, and doctor
// all go through buildTaskObservation so one snapshot always yields one
// verdict (A1-06). No OS queries happen here — getStatus stays fast and
// recovery probes reach this path only through persisted verdict records.
import type { InternalTaskStatus, TaskStore } from "../store/task-store.js";
import type { TaskObservation } from "./types.js";
import { judgeOptionsWith } from "./types.js";
import { judgeTaskObservation } from "./judge.js";
import type { PersistedProbeRecord } from "./types.js";

export interface BuildObservationOptions {
  readonly now?: () => Date;
  readonly startGraceMs?: number;
  readonly heartbeatFreshMs?: number;
  readonly stallHintMs?: number;
  /** Fresh persisted probe verdicts (A2 recovery); ignored when stale/mismatched. */
  readonly probes?: PersistedProbeRecord | null;
}

/** Maximum age for persisted probe verdicts used on the read path. */
const PROBE_RECORD_MAX_AGE_MS = 60_000;

export function buildTaskObservation(
  store: TaskStore,
  taskId: string,
  status: InternalTaskStatus,
  options: BuildObservationOptions = {},
): TaskObservation {
  const now = (options.now ?? (() => new Date()))().getTime();
  const evidence = store.readObservationEvidence(taskId, status.attempt);
  let probeWorker: { state: "alive" | "exited" | "unknown"; reason_code: string; observed_at: string } | null = null;
  let probeRuntime: { state: "alive" | "exited" | "unknown"; reason_code: string; observed_at: string } | null = null;
  const probes = options.probes;
  if (probes && probes.task_id === taskId && probes.attempt === status.attempt) {
    const probedAt = Date.parse(probes.probed_at);
    if (Number.isFinite(probedAt) && now - probedAt >= 0 && now - probedAt <= PROBE_RECORD_MAX_AGE_MS) {
      const pidMatch = (recorded: number | null, current: number | null): boolean => recorded === null || current === null || recorded === current;
      if (pidMatch(probes.worker_pid, status.worker_pid)) probeWorker = { ...probes.worker, observed_at: probes.probed_at };
      if (pidMatch(probes.runtime_pid, status.zcode_pid ?? null)) probeRuntime = { ...probes.runtime, observed_at: probes.probed_at };
    }
  }
  return judgeTaskObservation({
    status: {
      status: status.status,
      attempt: status.attempt,
      started_at: status.started_at,
      finished_at: status.finished_at,
      worker_pid: status.worker_pid,
      zcode_pid: status.zcode_pid ?? null,
      zcode_session_id: status.zcode_session_id ?? null,
      cleanup_unverified: status.cleanup_unverified === true,
      updated_at: status.updated_at,
    },
    result: store.readResult(taskId),
    checkpoint: evidence.checkpoint,
    heartbeat: evidence.heartbeat,
    last_business_event: evidence.last_business_event,
    pending_interaction: evidence.pending_interaction,
    probe_worker: probeWorker,
    probe_runtime: probeRuntime,
    now_ms: now,
    options: judgeOptionsWith({
      start_grace_ms: options.startGraceMs,
      heartbeat_fresh_ms: options.heartbeatFreshMs,
      stall_hint_ms: options.stallHintMs,
    }),
  });
}

/** A3-01: localize where a task last made progress, purely from persisted
 * evidence. Answers "worker, runtime, event channel, or cleanup?" without
 * guessing from tool names or model text. */
export function inferExecutionStage(
  store: TaskStore,
  taskId: string,
  status: InternalTaskStatus,
): string {
  const eventTypes = new Set<string>(store.listRecentEventTypes(taskId, 64));
  if (status.cleanup_unverified === true) return "cleanup";
  if (status.status === "queued") return "queue";
  if (!eventTypes.has("worker_started") && !eventTypes.has("worker_running")) return "worker_spawn";
  if (!eventTypes.has("app_server_started")) return "worker";
  if (status.zcode_pid === null && !eventTypes.has("app_server_started")) return "worker";
  if (!eventTypes.has("session_ready")) return "runtime";
  if (!eventTypes.has("turn_started")) return "event_channel";
  if (store.readResult(taskId) === null && status.status === "running") return "execution";
  if (status.status !== "running" && !isTerminalDone(status)) return "cleanup";
  return "execution";
}

function isTerminalDone(status: InternalTaskStatus): boolean {
  return status.status === "completed" || status.status === "failed" || status.status === "cancelled" || status.status === "waiting_for_master";
}
