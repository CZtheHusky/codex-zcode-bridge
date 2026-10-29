// TaskStore per docs/ARCHITECTURE.md (frozen): file-backed records under
// <dataRoot>/.tasks/<task_id>/ — task.json, status.json, append-only bounded
// stdout.log / stderr.log, terminal result.json, and immutable per-attempt
// records under attempts/. JSON writes are atomic (temp file + rename). Full
// child environments and provider config files are never persisted; bounded
// task evidence and pending interaction decisions live here. Permission
// request details may contain tool inputs and are persisted so the Master can
// inspect them and answer after a worker restart.
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TaskPackage, TaskProgressEvent, TaskResult, TaskStatus, TaskStatusRecord, WorkspaceRef, ZCodeInteractionRecord, ZCodeInteractionRequest } from "../interfaces.js";
import { tryAcquireProcessLock } from "./process-lock.js";
import { atomicRenameSync } from "./atomic-rename.js";

/** status.json shape: the frozen TaskStatusRecord plus internal fields. */
export interface InternalTaskStatus extends Omit<TaskStatusRecord, "error_code" | "error"> {
  /** Null in JSON clears the optional frozen fields on merge. */
  error_code?: string | null;
  error?: string | null;
  cancel_requested?: boolean | null;
  cleanup_unverified?: boolean | null;
  zcode_pid?: number | null;
}

/** A1 evidence bundle read for the observation judger. Never contains task bodies. */
export interface ObservationEvidence {
  checkpoint: { recorded_at: string } | null;
  heartbeat: WorkerHeartbeat | null;
  last_business_event: { at: string; type: string; seq: number } | null;
  pending_interaction: { method: string; created_at: string } | null;
}

/** B3 attempt-scoped observation snapshot: worker-owned execution phases and
 * manager-owned probe verdicts, merged by field ownership with per-writer
 * revisions. Observation only — never a substitute for result.json/claim. */
export interface AttemptObservationSnapshot {
  schema_version: 1;
  task_id: string;
  attempt: number;
  session_id?: string | null;
  turn_id?: string | null;
  last_runtime_seq?: number | null;
  activity_phase?: string;
  worker_identity?: Record<string, unknown>;
  runtime_identity?: Record<string, unknown> | null;
  worker_probe?: { state: string; reason_code: string };
  runtime_probe?: { state: string; reason_code: string };
  writers: { worker?: number; manager?: number };
  updated_at: string;
  /** AttemptMeta compatibility for atomic persistence. */
  [field: string]: unknown;
}

/** Shape of a persisted process identity (structurally, to avoid a store→probe import cycle). */
export interface ProcessIdentityLike {
  pid: number;
  fingerprint: string | null;
  fingerprint_precision: string;
  identity_version: number;
  platform: string;
  captured_at: string;
}

/** B1 opaque scan cursor: bound to the task and log generation plus a byte
 * offset and the first sequence, so a replaced or truncated log can never
 * serve another attempt's data through an old cursor. */
export interface EventsScanCursor {
  v: 1;
  task_id: string;
  generation: string;
  offset: number;
  first_seq: number | null;
}

export interface EventsScanMetrics {
  bytes_read: number;
  records_scanned: number;
  invalid_lines: number;
  corrupt_count: number;
  first_corrupt_offset: number | null;
  index_fallback: boolean;
}

export interface BoundedEventsRead {
  events: TaskProgressEvent[];
  nextSeq: number;
  hasMore: boolean;
  omittedEvents: number;
  /** Budget exhausted before the log end; continue via scan_cursor. */
  scan_incomplete: boolean;
  scan_cursor: EventsScanCursor | null;
  /** The provided cursor no longer matches the log; nothing was read from it. */
  cursor_invalid: boolean;
  metrics: EventsScanMetrics;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
/**
 * ADR-008: sanitized interaction params persist completely up to 1 MiB UTF-8
 * bytes (serialized params unit). Above it the write is rejected with the
 * actual and limit sizes so the caller can split the input; the old 32,000
 * byte limit silently undeliverable >32KB Write approvals.
 */
export const MAX_INTERACTION_PARAMS_BYTES = 1024 * 1024;
/** ADR-008: records written before the integrity metadata existed carry no
 * params_bytes/params_sha256 and were bounded by the old store limit; only
 * that exact small shape stays legacy-compatible during verification. */
const LEGACY_INTERACTION_PARAMS_BYTES = 32_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** ADR-008: explicit, recoverable rejection for interaction params over the
 * persistence limit. Carries safe size fields only, never the payload. */
export class InteractionRequestTooLargeError extends Error {
  readonly actualBytes: number;
  readonly limitBytes: number;
  constructor(actualBytes: number, limitBytes: number) {
    super(
      `ZCode interaction request exceeded the ${limitBytes}-byte persistence limit `
        + `(actual ${actualBytes} UTF-8 bytes); split the tool input into smaller parts and retry`,
    );
    this.name = "InteractionRequestTooLargeError";
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}
const MAX_CRITICAL_EVENT_RESERVE_BYTES = 256 * 1024;
const CRITICAL_EVENT_TYPES = new Set([
  "error", "task_finished", "turn_completed", "report_ready", "session_ready",
  "turn_started", "worker_started", "workspace_ready", "timeout_warning", "model_catalog",
  "account_provider_sync_failed", "interaction_requested", "interaction_reply_submitted", "cancelled", "cancel_failed",
  "cleanup_unverified", "outcome_checkpoint_failed", "outcome_recovered",
  // ADR-008: fatal frame failures and undeliverable approvals must survive
  // event-log capacity pressure.
  "protocol_error", "interaction_request_oversized", "interaction_request_undeliverable",
]);

export interface TaskStoreOptions {
  maxLogBytes?: number;
  maxEventBytes?: number;
}

export interface AttemptMeta {
  [key: string]: unknown;
}

export interface WorkerHeartbeat {
  attempt: number;
  worker_pid: number;
  started_at: string;
  heartbeat_at: string;
  heartbeat_seq: number;
  session_id: string | null;
  turn_id: string | null;
  last_event_seq: number;
  last_event_type: string | null;
  zcode_event_seq: number;
}

export class TaskStore {
  readonly #dataRoot: string;
  readonly #tasksRoot: string;
  readonly #maxLogBytes: number;
  readonly #maxEventBytes: number;

  constructor(dataRoot: string, options: TaskStoreOptions = {}) {
    this.#dataRoot = dataRoot;
    this.#tasksRoot = path.join(dataRoot, ".tasks");
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_LOG_BYTES;
    privateMkdir(this.#tasksRoot);
  }

  get dataRoot(): string {
    return this.#dataRoot;
  }

  get tasksRoot(): string {
    return this.#tasksRoot;
  }

  assertValidTaskId(taskId: string): void {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`invalid task_id (must match ${TASK_ID_PATTERN.source}): ${String(taskId)}`);
    }
  }

  taskDir(taskId: string): string {
    this.assertValidTaskId(taskId);
    return path.join(this.#tasksRoot, taskId);
  }

  hasTask(taskId: string): boolean {
    try {
      return existsSync(path.join(this.taskDir(taskId), "status.json"));
    } catch {
      return false;
    }
  }

  listTaskIds(): string[] {
    if (!existsSync(this.#tasksRoot)) return [];
    return readdirSync(this.#tasksRoot).filter((entry) =>
      existsSync(path.join(this.#tasksRoot, entry, "status.json")),
    );
  }

  createTask(task: TaskPackage, createdAt: string): void {
    this.assertValidTaskId(task.task_id);
    const dir = this.taskDir(task.task_id);
    if (existsSync(path.join(dir, "task.json"))) {
      throw new Error(`task already exists: ${task.task_id}`);
    }
    privateMkdir(path.join(dir, "attempts"));
    this.#writeJsonAtomic(path.join(dir, "task.json"), task);
    const status: InternalTaskStatus = {
      task_id: task.task_id,
      status: "queued",
      attempt: 1,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null,
    };
    this.#writeJsonAtomic(path.join(dir, "status.json"), status);
  }

  readTask(taskId: string): TaskPackage {
    const file = path.join(this.taskDir(taskId), "task.json");
    const parsed = this.#readJson(file);
    const task = parsed as TaskPackage;
    if (!task || task.task_id !== taskId || typeof task.workspace !== "string" || !task.workspace || typeof task.objective !== "string" || [task.requirements, task.allowed_paths, task.forbidden_paths, task.acceptance_criteria, task.test_commands].some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))) throw new Error(`corrupt task record: ${file}`);
    return task;
  }

  readSubmission<T = { fingerprint: string; receipt: { task_id: string; status: "queued" | "running"; created_at: string } }>(taskId: string): T | null {
    const file = path.join(this.taskDir(taskId), "submission.json");
    if (!existsSync(file)) return null;
    return this.#readJson(file) as T;
  }

  writeSubmission(taskId: string, submission: unknown): void {
    this.#writeJsonAtomic(path.join(this.taskDir(taskId), "submission.json"), submission);
  }

  writeWorkspaceRef(taskId: string, workspace: WorkspaceRef): void {
    this.#writeJsonAtomic(path.join(this.taskDir(taskId), "workspace.json"), workspace);
  }

  readWorkspaceRef(taskId: string): WorkspaceRef | null {
    const file = path.join(this.taskDir(taskId), "workspace.json");
    if (!existsSync(file)) return null;
    const workspace = this.#readJson(file) as WorkspaceRef;
    if (!workspace || typeof workspace.canonicalPath !== "string" || typeof workspace.requestedPath !== "string" || !["direct", "worktree"].includes(workspace.mode)) throw new Error(`corrupt workspace record: ${file}`);
    return workspace;
  }

  readStatus(taskId: string): InternalTaskStatus {
    const file = path.join(this.taskDir(taskId), "status.json");
    const parsed = this.#readJson(file) as InternalTaskStatus;
    if (!parsed || parsed.task_id !== taskId || !["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"].includes(parsed.status) || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || typeof parsed.created_at !== "string") {
      throw new Error(`corrupt status record: ${file}`);
    }
    return parsed;
  }

  /** Read-merge-write with an updated timestamp; atomic via temp file + rename. */
  writeStatus(taskId: string, patch: Partial<InternalTaskStatus>, expectedAttempt?: number): InternalTaskStatus {
    return withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const current = this.readStatus(taskId);
      if (expectedAttempt !== undefined && (current.attempt !== expectedAttempt || isTerminalStatus(current.status))) throw new Error("stale or terminal worker status rejected");
      const next: InternalTaskStatus = {
        ...current,
        ...patch,
        task_id: current.task_id,
        updated_at: new Date().toISOString(),
      };
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), next);
      return next;
    });
  }

  readResult(taskId: string): TaskResult | null {
    const file = path.join(this.taskDir(taskId), "result.json");
    if (!existsSync(file)) return null;
    const result = this.#readJson(file) as TaskResult;
    if (!result || result.task_id !== taskId || !Number.isSafeInteger(result.attempt) || !isTerminalStatus(result.status)) throw new Error(`corrupt result record: ${file}`);
    return result.attempt === this.readStatus(taskId).attempt ? result : null;
  }

  writeResult(taskId: string, result: TaskResult): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      if (this.readStatus(taskId).attempt !== result.attempt) throw new Error("stale worker attempt result rejected");
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "result.json"), result);
    });
  }

  commitWorkerResult(taskId: string, attempt: number, result: TaskResult, patch: Partial<InternalTaskStatus>): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      this.assertWorkerAttempt(taskId, attempt);
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "result.json"), result);
      const current = this.readStatus(taskId);
      // ADR-009 / review-round-1 R1 (worker-commit addendum): the worker's
      // final commit always records its result, but while a cleanup failure
      // is latched it can NEVER dissolve it or overwrite its evidence — no
      // matter whether the patch clears, re-asserts, or omits
      // cleanup_unverified, and no matter what error text it carries. The
      // worker's own failure detail stays available in result.json; only a
      // manager-verified, scan-gated release clears the latch.
      let effective = patch;
      if (current.cleanup_unverified === true) {
        effective = { ...patch, cleanup_unverified: true };
        if (typeof current.error === "string" && current.error.includes("[cleanup-members:")) {
          effective = { ...effective, error: current.error };
        }
      }
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), { ...current, ...effective, task_id: taskId, attempt, updated_at: new Date().toISOString() });
    });
  }

  patchRunningAttempt(taskId: string, attempt: number, patch: Partial<InternalTaskStatus>): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const current = this.readStatus(taskId);
      if (current.attempt !== attempt || current.status !== "running") return;
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), { ...current, ...patch, updated_at: new Date().toISOString() });
    });
  }

  /** Copies evidence before the continuation status commit; the old result remains recoverable. */
  archiveResultToAttempt(taskId: string, attempt: number): void {
    const dir = this.taskDir(taskId);
    const source = path.join(dir, "result.json");
    if (!existsSync(source)) return;
    const targetDir = this.attemptDir(taskId, attempt);
    privateMkdir(targetDir);
    copyFileSync(source, path.join(targetDir, "result.json"));
    privateFile(path.join(targetDir, "result.json"));
  }

  /** A claim is permanent: a started attempt must never execute again. */
  claimWorkerExecution(taskId: string, attempt: number): boolean {
    return withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const status = this.readStatus(taskId);
      if (status.attempt !== attempt || isTerminalStatus(status.status)) return false;
      privateMkdir(this.attemptDir(taskId, attempt));
      try {
        writeFileSync(path.join(this.attemptDir(taskId, attempt), "execution.claim"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    });
  }

  assertWorkerAttempt(taskId: string, attempt: number): void {
    const status = this.readStatus(taskId);
    if (status.attempt !== attempt || isTerminalStatus(status.status)) throw new Error("stale or terminal worker attempt rejected");
  }

  readArchivedResult(taskId: string, attempt: number): TaskResult | null {
    const file = path.join(this.attemptDir(taskId, attempt), "result.json");
    if (!existsSync(file)) return null;
    return this.#readJson(file) as TaskResult;
  }

  attemptDir(taskId: string, attempt: number): string {
    return path.join(this.taskDir(taskId), "attempts", String(attempt));
  }

  writeAttemptFile(taskId: string, attempt: number, fileName: string, content: string): void {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    this.#writeTextAtomic(path.join(dir, fileName), content);
  }

  writeAttemptMeta(taskId: string, attempt: number, fileName: string, meta: AttemptMeta): void {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    this.#writeJsonAtomic(path.join(dir, fileName), meta);
  }

  readAttemptMeta<T = AttemptMeta>(taskId: string, attempt: number, fileName: string): T | null {
    const file = path.join(this.attemptDir(taskId, attempt), fileName);
    if (!existsSync(file)) return null;
    return this.#readJson(file) as T;
  }

  writeWorkerHeartbeat(taskId: string, attempt: number, heartbeat: WorkerHeartbeat): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const status = this.readStatus(taskId);
      const claim = this.readAttemptMeta<{ pid?: number }>(taskId, attempt, "execution.claim");
      if (status.attempt !== attempt || status.status !== "running" || status.worker_pid !== heartbeat.worker_pid || claim?.pid !== heartbeat.worker_pid) {
        throw new Error("stale or unowned worker heartbeat rejected");
      }
      this.#writeJsonAtomic(path.join(this.attemptDir(taskId, attempt), "heartbeat.json"), heartbeat);
    });
  }

  readWorkerHeartbeat(taskId: string, attempt: number): WorkerHeartbeat | null {
    const value = this.readAttemptMeta<WorkerHeartbeat>(taskId, attempt, "heartbeat.json");
    if (!value || value.attempt !== attempt || !Number.isSafeInteger(value.worker_pid) || typeof value.heartbeat_at !== "string") return null;
    return value;
  }

  readAttemptText(taskId: string, attempt: number, fileName: string): string | null {
    const file = path.join(this.attemptDir(taskId, attempt), fileName);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  // ---- A1 observation evidence (bounded reads, no task bodies) ----

  /** Bounded persisted evidence for the observation judger. */
  readObservationEvidence(taskId: string, attempt: number): ObservationEvidence {
    const checkpointRaw = this.readAttemptMeta<{ recorded_at?: unknown }>(taskId, attempt, "outcome-checkpoint.json");
    const checkpoint = checkpointRaw && typeof checkpointRaw.recorded_at === "string" ? { recorded_at: checkpointRaw.recorded_at } : null;
    const heartbeat = this.readWorkerHeartbeat(taskId, attempt);
    return {
      checkpoint,
      heartbeat,
      last_business_event: this.readLastBusinessEvent(taskId),
      pending_interaction: this.readPendingInteraction(taskId),
    };
  }

  /** Last complete event line, read from a bounded tail window. */
  readLastBusinessEvent(taskId: string): { at: string; type: string; seq: number } | null {
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    if (!existsSync(file)) return null;
    let size = 0;
    try { size = statSync(file).size; } catch { return null; }
    if (size === 0) return null;
    const window = Math.min(8_192, size);
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try { read = readSync(fd, buffer, 0, window, size - window); }
      finally { closeSync(fd); }
    } catch { return null; }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    // Skip the first line only when the window starts mid-file (it may be a
    // partial line); a window covering the file start needs no skip.
    const body = newline >= 0 && window < size ? text.slice(newline + 1) : text;
    const lines = body.split("\n").filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = parseProgressEvent(lines[index]!);
      if (event) return { at: event.at, type: event.type, seq: event.seq };
    }
    return null;
  }

  /** Distinct event types from a bounded tail window (A3 stage inference). */
  listRecentEventTypes(taskId: string, maxLines: number): string[] {
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    if (!existsSync(file)) return [];
    let size = 0;
    try { size = statSync(file).size; } catch { return []; }
    const window = Math.min(256 * 1024, size);
    if (window === 0) return [];
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try { read = readSync(fd, buffer, 0, window, size - window); }
      finally { closeSync(fd); }
    } catch { return []; }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    // Same partial-first-line rule as readLastBusinessEvent.
    const body = newline >= 0 && window < size ? text.slice(newline + 1) : text;
    const types = new Set<string>();
    for (const line of body.split("\n").slice(-maxLines)) {
      const event = parseProgressEvent(line);
      if (event) types.add(event.type);
    }
    return [...types];
  }

  /** Newest unanswered interaction request (bounded directory scan). */
  readPendingInteraction(taskId: string): { method: string; created_at: string } | null {
    const directory = path.join(this.taskDir(taskId), "interactions");
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return null; }
    const files = entries.filter((entry) => entry.endsWith(".json")).slice(0, 64);
    let newest: { method: string; created_at: string } | null = null;
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as ZCodeInteractionRecord;
        if (record.state === "pending" && typeof record.method === "string" && typeof record.created_at === "string") {
          if (!newest || record.created_at > newest.created_at) newest = { method: record.method, created_at: record.created_at };
        }
      } catch { /* skip unreadable interaction record */ }
    }
    return newest;
  }

  /** Pending interaction requests for the current attempt, oldest first.
   * Public request ids are attempt-prefixed ("<attempt>:<runtime id>"), so a
   * monitor can wake a host exactly once per still-pending request. */
  listPendingInteractions(taskId: string, max = 16): Array<{ request_id: string; method: string; created_at: string }> {
    const directory = path.join(this.taskDir(taskId), "interactions");
    const prefix = `${this.readStatus(taskId).attempt}-`;
    let entries: string[];
    try { entries = readdirSync(directory); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const records: Array<{ request_id: string; method: string; created_at: string }> = [];
    for (const file of entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))) {
      const record: ZCodeInteractionRecord = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      if (record.state === "pending") records.push({ request_id: record.request_id, method: record.method, created_at: record.created_at });
    }
    records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return records.slice(0, max);
  }

  // ---- B3 attempt-scoped observation snapshot (fenced writer) ----

  /**
   * Writes worker-owned snapshot fields. Fenced twice: the attempt must still
   * be the current one, and the writer must own the attempt's execution claim,
   * so a replaced or stale worker can never overwrite current facts. Revision
   * is per writer and must strictly increase within one writer identity.
   */
  writeWorkerObservation(
    taskId: string,
    attempt: number,
    writerPid: number,
    patch: {
      session_id?: string | null;
      turn_id?: string | null;
      last_runtime_seq?: number | null;
      activity_phase?: string;
      worker_identity?: Record<string, unknown> | null;
      runtime_identity?: Record<string, unknown> | null;
    },
    revision: number,
    updatedAt = new Date().toISOString(),
  ): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const status = this.readStatus(taskId);
      if (status.attempt !== attempt) throw new Error("stale attempt observation rejected");
      const claim = this.readAttemptMeta<{ pid?: number }>(taskId, attempt, "execution.claim");
      if (claim?.pid !== writerPid) throw new Error("observation writer does not own the execution claim");
      this.#mergeObservationSnapshot(taskId, attempt, "worker", revision, patch, updatedAt);
    });
  }

  /** Writes manager-owned snapshot fields (probe verdicts); worker business
   * phases are never overwritten from the manager side. */
  writeManagerObservation(
    taskId: string,
    attempt: number,
    patch: {
      worker_probe?: { state: string; reason_code: string } | null;
      runtime_probe?: { state: string; reason_code: string } | null;
    },
    revision: number,
    updatedAt = new Date().toISOString(),
  ): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const status = this.readStatus(taskId);
      if (status.attempt !== attempt) throw new Error("stale attempt observation rejected");
      this.#mergeObservationSnapshot(taskId, attempt, "manager", revision, patch, updatedAt);
    });
  }

  readObservationSnapshot(taskId: string, attempt: number): { snapshot: AttemptObservationSnapshot | null; corrupt: boolean } {
    const file = path.join(this.attemptDir(taskId, attempt), "observation.json");
    if (!existsSync(file)) return { snapshot: null, corrupt: false };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as AttemptObservationSnapshot;
      if (parsed.schema_version !== 1 || parsed.task_id !== taskId || parsed.attempt !== attempt) {
        return { snapshot: null, corrupt: true };
      }
      return { snapshot: parsed, corrupt: false };
    } catch {
      return { snapshot: null, corrupt: true };
    }
  }

  #mergeObservationSnapshot(
    taskId: string,
    attempt: number,
    writer: "worker" | "manager",
    revision: number,
    patch: Record<string, unknown>,
    updatedAt: string,
  ): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("observation revision must be a non-negative integer");
    const current: AttemptObservationSnapshot | null = this.readObservationSnapshot(taskId, attempt).snapshot;
    const previousRevision = current?.writers?.[writer] ?? -1;
    if (revision <= previousRevision) throw new Error("stale observation revision rejected");
    const carried: Partial<AttemptObservationSnapshot> = current ?? {};
    const next: AttemptObservationSnapshot = {
      schema_version: 1,
      task_id: taskId,
      attempt,
      writers: { ...carried.writers, [writer]: revision },
      updated_at: updatedAt,
    };
    // Manager patches may only fill manager-owned fields; worker patches only
    // worker-owned fields. The other side's persisted facts are carried over.
    const workerOwned = ["session_id", "turn_id", "last_runtime_seq", "activity_phase", "worker_identity", "runtime_identity"] as const;
    const managerOwned = ["worker_probe", "runtime_probe"] as const;
    for (const key of workerOwned) {
      if (key in patch) (next as Record<string, unknown>)[key] = patch[key];
      else if (key in carried) (next as Record<string, unknown>)[key] = (carried as Record<string, unknown>)[key];
    }
    for (const key of managerOwned) {
      if (key in patch) (next as Record<string, unknown>)[key] = patch[key];
      else if (key in carried) (next as Record<string, unknown>)[key] = (carried as Record<string, unknown>)[key];
    }
    this.writeAttemptMeta(taskId, attempt, "observation.json", next);
  }

  // ---- A2 executor identity evidence ----

  writeExecutorIdentity(taskId: string, attempt: number, identity: { worker?: Record<string, unknown>; runtime?: Record<string, unknown> | null }): void {
    const current = this.readAttemptMeta<{ worker?: Record<string, unknown>; runtime?: Record<string, unknown> | null }>(taskId, attempt, "executor-identity.json") ?? {};
    this.writeAttemptMeta(taskId, attempt, "executor-identity.json", {
      ...current,
      ...identity,
    });
  }

  readExecutorIdentity(taskId: string, attempt: number): { worker?: ProcessIdentityLike; runtime?: ProcessIdentityLike | null } | null {
    return this.readAttemptMeta<{ worker?: ProcessIdentityLike; runtime?: ProcessIdentityLike | null }>(taskId, attempt, "executor-identity.json");
  }

  /**
   * Atomically claims the single worker-respawn slot for an attempt by
   * creating the marker file with an exclusive flag, so several Bridge
   * processes sharing this data root can never spawn two replacement
   * workers. Returns false when the slot is already claimed.
   */
  claimAttemptRespawn(taskId: string, attempt: number): boolean {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    try {
      closeSync(openSync(path.join(dir, "respawn.claim"), "wx"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  /** File time of the respawn claim, or null when the attempt is unclaimed. */
  respawnClaimedAt(taskId: string, attempt: number): Date | null {
    try {
      return statSync(path.join(this.attemptDir(taskId, attempt), "respawn.claim")).mtime;
    } catch {
      return null;
    }
  }

  /** Append-only, byte-bounded. Returns whether the chunk was truncated. */
  appendLog(taskId: string, kind: "stdout" | "stderr", text: string): { truncated: boolean } {
    if (!text) return { truncated: false };
    const dir = this.taskDir(taskId);
    privateMkdir(dir);
    const file = path.join(dir, `${kind}.log`);
    let currentBytes = 0;
    try {
      currentBytes = statSync(file).size;
    } catch {
      currentBytes = 0;
    }
    const bytes = Buffer.from(text, "utf8");
    const room = this.#maxLogBytes - currentBytes;
    if (room <= 0) return { truncated: true };
    appendFileSync(file, bytes.length <= room ? bytes : bytes.subarray(0, room), { mode: 0o600 });
    privateFile(file);
    return { truncated: bytes.length > room };
  }

  readLog(taskId: string, kind: "stdout" | "stderr"): string {
    const file = path.join(this.taskDir(taskId), `${kind}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  appendEvent(
    taskId: string,
    type: string,
    summary: string,
    details?: Record<string, unknown>,
    at = new Date().toISOString(),
  ): TaskProgressEvent | null {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, "events.lock");
    return withEventLock(lockDir, () => {
      const file = path.join(dir, "events.jsonl");
      const seqFile = path.join(dir, "events.seq");
      let bytes = 0;
      let previousSeq = 0;
      let needsSeparator = false;
      try {
        const info = statSync(file);
        bytes = info.size;
        let lastByte: number | undefined;
        if (bytes > 0) {
          const fd = openSync(file, "r");
          try { const tail = Buffer.alloc(1); readSync(fd, tail, 0, 1, bytes - 1); lastByte = tail[0]; }
          finally { closeSync(fd); }
        }
        needsSeparator = bytes > 0 && lastByte !== 0x0a;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        bytes = 0;
      }
      try {
        previousSeq = Number(readFileSync(seqFile, "utf8"));
        if (!Number.isSafeInteger(previousSeq) || previousSeq < 0) previousSeq = readLastEventSeq(file);
      } catch {
        previousSeq = readLastEventSeq(file);
      }
      const event: TaskProgressEvent = {
        seq: previousSeq + 1,
        at,
        type: type.slice(0, 80),
        summary: summary.length <= 2_000 ? summary : `${summary.slice(0, 1_970)}…[output truncated]`,
        ...(details && Object.keys(details).length ? { details } : {}),
      };
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8") + (needsSeparator ? 1 : 0);
      const critical = CRITICAL_EVENT_TYPES.has(type);
      const capacity = this.#maxEventBytes + (critical ? MAX_CRITICAL_EVENT_RESERVE_BYTES : 0);
      if (lineBytes > 64_000 || bytes + lineBytes > capacity) return null;
      // Advance the durable cursor before append. A crash can leave a harmless
      // sequence gap, but can never cause two writers to reuse one sequence.
      this.#writeTextAtomic(seqFile, String(event.seq));
      const eventOffset = bytes + (needsSeparator ? 1 : 0);
      appendFileSync(file, `${needsSeparator ? "\n" : ""}${line}`, { encoding: "utf8", mode: 0o600 });
      privateFile(file);
      // Generation marker: created once per log lifetime, detects wholesale
      // replacement or truncation for byte cursors. Rewriting the log without
      // rotating this file invalidates every outstanding cursor (by design).
      const genFile = path.join(dir, "events.gen");
      if (!existsSync(genFile)) {
        this.#writeTextAtomic(genFile, randomUUID());
      }
      if (event.seq % 100 === 0) {
        const index = path.join(dir, "events.index");
        appendFileSync(index, `${event.seq}\t${eventOffset}\n`, { encoding: "utf8", mode: 0o600 });
        privateFile(index);
      }
      return event;
    });
  }

  readEvents(taskId: string, afterSeq = 0, limit = 100, view: "raw" | "summary" = "raw"): { events: TaskProgressEvent[]; nextSeq: number; hasMore: boolean; omittedEvents: number } {
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    if (!existsSync(file)) return { events: [], nextSeq: afterSeq, hasMore: false, omittedEvents: 0 };
    let offset = 0;
    const indexFile = path.join(this.taskDir(taskId), "events.index");
    if (existsSync(indexFile)) {
      for (const row of readFileSync(indexFile, "utf8").split(/\r?\n/u)) {
        const [seqText, offsetText] = row.split("\t");
        const seq = Number(seqText);
        const candidateOffset = Number(offsetText);
        if (Number.isInteger(seq) && Number.isSafeInteger(candidateOffset) && seq <= afterSeq) offset = candidateOffset;
        if (seq > afterSeq) break;
      }
    }
    const fd = openSync(file, "r");
    const page: TaskProgressEvent[] = [];
    let hasMore = false;
    let position = offset;
    let pending = "";
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (count <= 0) break;
        position += count;
        const lines = `${pending}${decoder.write(buffer.subarray(0, count))}`.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseProgressEvent(line);
          if (!event || event.seq <= afterSeq) continue;
          if (page.length === limit) { hasMore = true; break; }
          page.push(event);
        }
        if (hasMore) break;
      }
      pending += decoder.end();
      if (!hasMore && pending) {
        const event = parseProgressEvent(pending);
        if (event && event.seq > afterSeq) {
          if (page.length === limit) hasMore = true;
          else page.push(event);
        }
      }
    } finally {
      closeSync(fd);
    }
    let events = page;
    let omittedEvents = 0;
    if (view === "summary") {
      events = [];
      for (const event of page) {
        const previous = events.at(-1);
        if (event.type === "model_output" && previous?.type === "model_output") {
          const combined = previous.summary + event.summary;
          events[events.length - 1] = {
            ...previous,
            seq: event.seq,
            at: event.at,
            summary: combined.length <= 5_000 ? combined : `${combined.slice(0, 4_950)}…[output compacted]`,
          };
          omittedEvents += 1;
        } else {
          events.push(event);
        }
      }
    }
    return {
      events,
      nextSeq: page.at(-1)?.seq ?? afterSeq,
      hasMore,
      omittedEvents,
    };
  }

  /**
   * B1 bounded scan: parses complete byte lines only; an unfinished trailing
   * line is not consumed and the cursor never passes it. Complete corrupt
   * lines are skipped but counted. The byte budget covers at most the
   * configured budget plus one read block; exhaustion reports scan_incomplete
   * and never a has_more=true page with an unchanged after_seq.
   */
  readEventsBounded(taskId: string, input: {
    afterSeq?: number;
    limit?: number;
    view?: "raw" | "summary";
    maxBytes?: number;
    cursor?: EventsScanCursor | null;
  } = {}): BoundedEventsRead {
    const afterSeq = input.afterSeq ?? 0;
    const limit = input.limit ?? 100;
    const view = input.view ?? "raw";
    const budget = input.maxBytes ?? this.#maxEventBytes;
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    const empty: BoundedEventsRead = {
      events: [],
      nextSeq: afterSeq,
      hasMore: false,
      omittedEvents: 0,
      scan_incomplete: false,
      scan_cursor: null,
      cursor_invalid: false,
      metrics: { bytes_read: 0, records_scanned: 0, invalid_lines: 0, corrupt_count: 0, first_corrupt_offset: null, index_fallback: false },
    };
    let size = 0;
    try { size = statSync(file).size; } catch { return empty; }
    if (size === 0) return empty;

    let startOffset = 0;
    let cursorInvalid = false;
    if (input.cursor) {
      const generation = this.readEventGeneration(taskId);
      const valid = input.cursor.v === 1
        && input.cursor.task_id === taskId
        && generation !== null
        && input.cursor.generation === generation
        && Number.isSafeInteger(input.cursor.offset)
        && input.cursor.offset >= 0
        && input.cursor.offset <= size;
      if (!valid) {
        return { ...empty, cursor_invalid: true };
      }
      startOffset = input.cursor.offset;
      if (input.cursor.first_seq !== null) {
        const firstSeq = this.readFirstEventSeq(file, size);
        if (firstSeq === null || firstSeq !== input.cursor.first_seq) {
          return { ...empty, cursor_invalid: true };
        }
      }
    }

    // Index is an accelerator only: validate bounds and monotonicity; any
    // doubt falls back to a safe full scan from offset 0 with a diagnostic.
    let indexFallback = false;
    if (startOffset === 0) {
      const indexFile = path.join(this.taskDir(taskId), "events.index");
      if (existsSync(indexFile)) {
        try {
          let lastSeq = 0;
          let lastOffset = 0;
          for (const row of readFileSync(indexFile, "utf8").split(/\r?\n/u)) {
            if (!row.trim()) continue;
            const [seqText, offsetText] = row.split("\t");
            const seq = Number(seqText);
            const offset = Number(offsetText);
            if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(offset) || seq <= lastSeq || offset < lastOffset || offset > size) {
              throw new Error("invalid index row");
            }
            lastSeq = seq;
            lastOffset = offset;
          }
          for (const row of readFileSync(indexFile, "utf8").split(/\r?\n/u)) {
            const [seqText, offsetText] = row.split("\t");
            const seq = Number(seqText);
            const offset = Number(offsetText);
            if (Number.isSafeInteger(seq) && Number.isSafeInteger(offset) && seq <= afterSeq && offset <= size) startOffset = offset;
            if (Number.isSafeInteger(seq) && seq > afterSeq) break;
          }
        } catch {
          indexFallback = true;
          startOffset = 0;
        }
      }
    }

    const events: TaskProgressEvent[] = [];
    let scanned = 0;
    let bytesRead = 0;
    let invalidLines = 0;
    let corruptCount = 0;
    let firstCorruptOffset: number | null = null;
    let hasMore = false;
    let position = startOffset;
    let lastCompleteOffset = startOffset;
    let pending = "";
    // pendingStartOffset is always a BYTE offset into the file.
    let pendingStartOffset = startOffset;
    let reachedEnd = false;
    const maxRead = budget + 64 * 1024;
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const fd = openSync(file, "r");
    // String indices are character-based while cursors are byte-based; every
    // consumed line therefore adds its exact UTF-8 byte length.
    const processLine = (line: string, lineOffset: number, lineEndOffset: number): boolean => {
      // Returns false when the page filled on this event.
      lastCompleteOffset = lineEndOffset;
      if (!line.trim()) return true;
      const event = parseProgressEvent(line);
      if (!event) {
        invalidLines += 1;
        corruptCount += 1;
        if (firstCorruptOffset === null) firstCorruptOffset = lineOffset;
        return true;
      }
      scanned += 1;
      if (event.seq <= afterSeq) return true;
      if (events.length === limit) {
        // Page full: the cursor rewinds to the start of this unconsumed
        // event so a byte-cursor continuation re-reads exactly it.
        hasMore = true;
        lastCompleteOffset = lineOffset;
        return false;
      }
      events.push(event);
      return true;
    };
    try {
      while (bytesRead < maxRead) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (count <= 0) { reachedEnd = true; break; }
        position += count;
        bytesRead += count;
        const text = pending + decoder.write(buffer.subarray(0, count));
        let searchFrom = 0;
        let consumedBytes = 0;
        let stopped = false;
        while (true) {
          const newline = text.indexOf("\n", searchFrom);
          if (newline < 0) break;
          const line = text.slice(searchFrom, newline).replace(/\r$/u, "");
          const lineBytes = Buffer.byteLength(text.slice(searchFrom, newline + 1), "utf8");
          const lineOffset = pendingStartOffset + consumedBytes;
          consumedBytes += lineBytes;
          searchFrom = newline + 1;
          if (!processLine(line, lineOffset, pendingStartOffset + consumedBytes)) { stopped = true; break; }
        }
        if (stopped) {
          pending = "";
          break;
        }
        pending = text.slice(searchFrom);
        pendingStartOffset += consumedBytes;
      }
      if (!hasMore) {
        // Finish the tail block: parse only complete lines. A trailing partial
        // line is uncommitted — never consumed, never counted corrupt, and
        // byte cursors stop before it so it can be read once it completes.
        const tail = pending + decoder.end();
        let searchFrom = 0;
        let consumedBytes = 0;
        while (true) {
          const newline = tail.indexOf("\n", searchFrom);
          if (newline < 0) break; // a partial trailing line stops the cursor
          const line = tail.slice(searchFrom, newline).replace(/\r$/u, "");
          const lineBytes = Buffer.byteLength(tail.slice(searchFrom, newline + 1), "utf8");
          const lineOffset = pendingStartOffset + consumedBytes;
          consumedBytes += lineBytes;
          searchFrom = newline + 1;
          if (!processLine(line, lineOffset, pendingStartOffset + consumedBytes)) break;
        }
        if (!hasMore && !reachedEnd && bytesRead >= maxRead) {
          // Budget exhausted with an unconsumed remainder: the cursor stays at
          // the end of the last complete line so no byte is read twice, and
          // the response reports the incomplete scan instead of pretending a
          // full read.
          lastCompleteOffset = pendingStartOffset + consumedBytes;
        }
      }
    } finally {
      closeSync(fd);
    }

    let page = events;
    let omittedEvents = 0;
    if (view === "summary") {
      page = [];
      for (const event of events) {
        const previous = page.at(-1);
        if (event.type === "model_output" && previous?.type === "model_output") {
          const combined = previous.summary + event.summary;
          page[page.length - 1] = {
            ...previous,
            seq: event.seq,
            at: event.at,
            summary: combined.length <= 5_000 ? combined : `${combined.slice(0, 4_950)}…[output compacted]`,
          };
          omittedEvents += 1;
        } else {
          page.push(event);
        }
      }
    }

    // scan_incomplete means the byte budget ran out before the log end while
    // returning a full page is not possible; bounded clients continue via the
    // byte cursor, after_seq clients via has_more (which always advances).
    const scanIncomplete = !reachedEnd && !hasMore;
    const nextSeq = page.at(-1)?.seq ?? afterSeq;
    // Loop guard: never report has_more with an unchanged cursor for old
    // clients. Progress is carried by the byte cursor for bounded clients.
    if (hasMore && nextSeq === afterSeq && !input.cursor) hasMore = false;
    const cursor: EventsScanCursor | null = this.readEventGeneration(taskId)
      ? { v: 1, task_id: taskId, generation: this.readEventGeneration(taskId)!, offset: lastCompleteOffset, first_seq: input.cursor?.first_seq ?? this.readFirstEventSeq(file, size) }
      : null;
    return {
      events: page,
      nextSeq,
      hasMore,
      omittedEvents,
      scan_incomplete: scanIncomplete,
      scan_cursor: cursor,
      cursor_invalid: false,
      metrics: { bytes_read: bytesRead, records_scanned: scanned, invalid_lines: invalidLines, corrupt_count: corruptCount, first_corrupt_offset: firstCorruptOffset, index_fallback: indexFallback },
    };
  }

  /** Generation marker detecting log replacement/truncation across reads. */
  readEventGeneration(taskId: string): string | null {
    try {
      const value = readFileSync(path.join(this.taskDir(taskId), "events.gen"), "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private readFirstEventSeq(file: string, size: number): number | null {
    const window = Math.min(64 * 1024, size);
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try { read = readSync(fd, buffer, 0, window, 0); }
      finally { closeSync(fd); }
    } catch { return null; }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) return null;
    const event = parseProgressEvent(text.slice(0, newline).replace(/\r$/u, ""));
    return event ? event.seq : null;
  }

  writeInteractionRequest(
    taskId: string,
    request: ZCodeInteractionRequest,
    createdAt = new Date().toISOString(),
  ): { record: ZCodeInteractionRecord; created: boolean } {
    const directory = path.join(this.taskDir(taskId), "interactions");
    privateMkdir(directory);
    const file = this.interactionFile(taskId, request.request_id);
    return withEventLock(path.join(this.taskDir(taskId), "interactions.lock"), () => {
      if (existsSync(file)) {
        const record = this.#readJson(file) as ZCodeInteractionRecord;
        // Duplicate ids compare the complete normalized input, never a
        // bounded preview (ADR-008).
        if (record.request_id !== request.request_id || record.method !== request.method || stableJson(record.params) !== stableJson(request.params)) {
          throw new Error("interaction request id collision");
        }
        return { record, created: false };
      }
      // Byte count and hash use the serialized sanitized params — the same
      // unit as the limit and as the full-request reference published to the
      // calling host.
      const serialized = JSON.stringify(request.params);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_INTERACTION_PARAMS_BYTES) {
        throw new InteractionRequestTooLargeError(bytes, MAX_INTERACTION_PARAMS_BYTES);
      }
      const record: ZCodeInteractionRecord = {
        ...request,
        state: "pending",
        created_at: createdAt,
        params_bytes: bytes,
        params_sha256: createHash("sha256").update(serialized).digest("hex"),
      };
      this.#writeJsonAtomic(file, record);
      return { record, created: true };
    });
  }

  readInteractionRequest(taskId: string, requestId: string): ZCodeInteractionRecord | null {
    const file = this.interactionFile(taskId, requestId);
    if (!existsSync(file)) return null;
    const record = this.#readJson(file) as ZCodeInteractionRecord;
    if (record.request_id !== requestId) throw new Error("interaction request id hash mismatch");
    return record;
  }

  /** Absolute path of one attempt's private full-request record; referenced
   * by bounded interaction_requested preview events (ADR-008). */
  interactionRequestPath(taskId: string, requestId: string): string {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    return this.interactionFile(taskId, requestId);
  }

  /**
   * ADR-008 approval guard: the full request behind an approval must be
   * readable and consistent with its persisted byte count and SHA256 before
   * the reply may be treated as authorization. Corrupt, missing, edited, or
   * metadata-stripped records are reported, never accepted. Only genuinely
   * legacy small records (no metadata at all, within the old 32,000-byte
   * store limit) stay compatible; anything larger or partially annotated must
   * carry complete, well-typed, matching metadata, and verification still
   * enforces the 1 MiB persistence limit.
   */
  verifyInteractionRequestIntegrity(taskId: string, requestId: string): { ok: true } | { ok: false; reason: string } {
    const file = this.interactionFile(taskId, requestId);
    try {
      if (!existsSync(file)) return { ok: false, reason: "the full request record is missing" };
      const record = this.#readJson(file) as ZCodeInteractionRecord;
      if (record.request_id !== requestId) return { ok: false, reason: "the persisted request id does not match this request" };
      if (record.state !== "pending" && record.state !== "answered") return { ok: false, reason: "the persisted request state is unreadable" };
      const serialized = JSON.stringify(record.params);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_INTERACTION_PARAMS_BYTES) {
        return { ok: false, reason: `the full request content is ${bytes} UTF-8 bytes, over the ${MAX_INTERACTION_PARAMS_BYTES}-byte persistence limit` };
      }
      const hasBytes = record.params_bytes !== undefined;
      const hasHash = record.params_sha256 !== undefined;
      if (!hasBytes && !hasHash) {
        if (bytes <= LEGACY_INTERACTION_PARAMS_BYTES) return { ok: true };
        return { ok: false, reason: `the full request record carries no integrity metadata but is ${bytes} UTF-8 bytes, over the legacy ${LEGACY_INTERACTION_PARAMS_BYTES}-byte limit; it cannot be treated as a legacy record` };
      }
      if (!hasBytes || !hasHash) {
        return { ok: false, reason: "the full request record has incomplete integrity metadata (byte count and SHA256 must both be present)" };
      }
      if (typeof record.params_bytes !== "number" || !Number.isSafeInteger(record.params_bytes) || record.params_bytes < 0) {
        return { ok: false, reason: "the persisted byte count is not a valid non-negative integer" };
      }
      if (typeof record.params_sha256 !== "string" || !SHA256_HEX_PATTERN.test(record.params_sha256)) {
        return { ok: false, reason: "the persisted SHA256 is not a valid 64-character hex digest" };
      }
      if (record.params_bytes !== bytes) {
        return { ok: false, reason: "the persisted byte count does not match the full content" };
      }
      if (record.params_sha256 !== createHash("sha256").update(serialized).digest("hex")) {
        return { ok: false, reason: "the persisted SHA256 does not match the full content" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "the full request record is unreadable or corrupt" };
    }
  }

  answerInteractionRequest(
    taskId: string,
    requestId: string,
    answer: Record<string, unknown>,
    answeredAt = new Date().toISOString(),
  ): "answered" | "already_answered" {
    const file = this.interactionFile(taskId, requestId);
    return withEventLock(path.join(this.taskDir(taskId), "interactions.lock"), () => {
      if (!existsSync(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file) as ZCodeInteractionRecord;
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return "already_answered";
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt,
      } satisfies ZCodeInteractionRecord);
      return "answered";
    });
  }

  /** ADR-008: approval answers verify the full request inside the same
   * interaction lock the answer is written under, so the record checked for
   * integrity is exactly the one the answer lands on — there is no
   * check-then-write window where an edited record could slip through. */
  answerInteractionRequestVerified(
    taskId: string,
    requestId: string,
    answer: Record<string, unknown>,
    options: { requireIntegrity: boolean },
    answeredAt = new Date().toISOString(),
  ): { state: "answered" } | { state: "already_answered" } | { state: "integrity_failed"; reason: string } {
    const file = this.interactionFile(taskId, requestId);
    return withEventLock(path.join(this.taskDir(taskId), "interactions.lock"), () => {
      if (!existsSync(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file) as ZCodeInteractionRecord;
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return { state: "already_answered" };
      if (options.requireIntegrity) {
        const integrity = this.verifyInteractionRequestIntegrity(taskId, requestId);
        if (!integrity.ok) return { state: "integrity_failed", reason: integrity.reason };
      }
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt,
      } satisfies ZCodeInteractionRecord);
      return { state: "answered" };
    });
  }

  private interactionFile(taskId: string, requestId: string): string {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    const key = createHash("sha256").update(requestId).digest("hex");
    return path.join(this.taskDir(taskId), "interactions", `${this.readStatus(taskId).attempt}-${key}.json`);
  }

  #readJson(file: string): unknown {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { throw new Error(`unreadable or corrupt JSON record: ${file}`, { cause: error }); }
  }

  #writeJsonAtomic(file: string, value: unknown): void {
    this.#writeTextAtomic(file, JSON.stringify(value, null, 2));
  }

  #writeTextAtomic(file: string, text: string): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
      privateFile(tmp);
      atomicRenameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      throw error;
    }
  }
}

/** Key-order-independent comparison used for duplicate-id collision checks and
 * worker-side original-vs-persisted request comparison (ADR-008). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function withEventLock<T>(lockDir: string, operation: () => T): T {
  const deadline = Date.now() + 10_000;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(lockDir))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for task state/event lock: ${lockDir}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return operation();
  } finally {
    release();
  }
}

function privateMkdir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
}

function privateDirectory(directory: string): void {
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function privateFile(file: string): void {
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

function readLastEventSeq(file: string): number {
  if (!existsSync(file)) return 0;
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as TaskProgressEvent;
      if (Number.isInteger(event.seq)) return event.seq;
    } catch {
      // Skip malformed or partial records.
    }
  }
  return 0;
}

function parseProgressEvent(line: string): TaskProgressEvent | null {
  if (!line) return null;
  try {
    const event = JSON.parse(line) as TaskProgressEvent;
    return Number.isInteger(event.seq) ? event : null;
  } catch {
    // Ignore a partial final line left by an interrupted process.
    return null;
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  // waiting_for_master ends the current attempt and has a persisted result;
  // a later master decision starts a new attempt through coding_agent_continue.
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "waiting_for_master"
  );
}

/** Strips internal fields for the frozen TaskStatusRecord view. */
export function toPublicStatus(status: InternalTaskStatus): TaskStatusRecord {
  const record: TaskStatusRecord = {
    task_id: status.task_id,
    status: status.status,
    attempt: status.attempt,
    created_at: status.created_at,
    updated_at: status.updated_at,
    started_at: status.started_at,
    finished_at: status.finished_at,
    worker_pid: status.worker_pid,
    zcode_session_id: status.zcode_session_id,
    exit_code: status.exit_code,
  };
  if (status.error_code) record.error_code = status.error_code;
  if (status.error) record.error = status.error;
  return record;
}
