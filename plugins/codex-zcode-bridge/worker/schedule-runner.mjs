// src/schedule/runner-main.ts
import path10 from "node:path";

// src/manager/task-manager.ts
import path5 from "node:path";
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";

// src/store/task-store.ts
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync2, readSync, readdirSync, rmSync, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import path2 from "node:path";
import { StringDecoder } from "node:string_decoder";

// src/store/process-lock.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
var selfIdentity = null;
var TRANSIENT_LOCK_FS_CODES = /* @__PURE__ */ new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
var DESTINATION_PRESENT_CONTENTION_CODES = /* @__PURE__ */ new Set(["EEXIST", "ENOTEMPTY"]);
var PUBLICATION_RETRY_ATTEMPTS = 3;
var WITHDRAW_RETRY_MS = 2e3;
var SHARED_GUARD_RETRY_MS = 2e3;
var PRIVATE_CLEANUP_RETRY_MS = 1e3;
var RETRY_PAUSE_MS = 10;
function isTransientLockFsError(error) {
  return TRANSIENT_LOCK_FS_CODES.has(error?.code ?? "");
}
function pauseBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_PAUSE_MS);
}
function publishSelfIdentity(identity) {
  selfIdentity = identity;
}
async function withProcessLock(directory, operation, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  let release;
  while (!(release = tryAcquireProcessLock(directory))) {
    if (Date.now() >= deadline) {
      const owner = describeLockOwner(directory);
      throw new Error(`timed out waiting for process lock: ${directory}${owner ? ` (live owner: ${owner})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    return await operation();
  } finally {
    release();
  }
}
function describeLockOwner(directory) {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner.pid)) return null;
    return `pid ${String(owner.pid)}${owner.started_at ? `, started ${owner.started_at}` : ""}`;
  } catch {
    return null;
  }
}
function tryAcquireProcessLock(directory) {
  return tryAcquireProcessLockWithRetry(directory, 0);
}
function tryAcquireProcessLockWithRetry(directory, retries) {
  const token = randomUUID();
  if (existsSync(directory)) return acquireExistingLock(directory);
  const staging = `${directory}.${process.pid}.${token}.pending`;
  const ownerRecord = {
    pid: process.pid,
    token,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    // Fingerprint may be null before the async self-identity probe finishes;
    // null never authorizes binding a recycled PID to a prior owner.
    identity: selfIdentity ? { fingerprint: selfIdentity.fingerprint, identity_version: selfIdentity.identity_version, platform: selfIdentity.platform } : null
  };
  try {
    mkdirSync(staging, { mode: 448 });
    writeFileSync(path.join(staging, "owner.json"), JSON.stringify(ownerRecord), { mode: 384, flag: "wx" });
    try {
      renameSync(staging, directory);
    } catch (error) {
      removeStagedLock(staging);
      const code = error.code;
      if (!isTransientLockFsError(error)) throw error;
      if (DESTINATION_PRESENT_CONTENTION_CODES.has(code ?? "") || existsSync(directory)) {
        return acquireExistingLock(directory);
      }
      if (retries < PUBLICATION_RETRY_ATTEMPTS) {
        pauseBriefly();
        return tryAcquireProcessLockWithRetry(directory, retries + 1);
      }
      throw error;
    }
  } catch (error) {
    removeStagedLock(staging);
    throw error;
  }
  return () => {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (owner.token !== token) throw new Error("process lock ownership changed");
    const retired = `${directory}.${token}.retired`;
    renameWithTransientRetry(directory, retired);
    removeStagedLock(retired);
  };
}
function renameWithTransientRetry(source, target) {
  const deadline = Date.now() + WITHDRAW_RETRY_MS;
  while (true) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (!isTransientLockFsError(error) || Date.now() >= deadline) throw error;
      pauseBriefly();
    }
  }
}
function acquireExistingLock(directory) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid lock owner");
  } catch {
    try {
      if (Date.now() - statSync(directory).mtimeMs > 3e4) throw new Error(`unreadable lock owner: ${directory}`);
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    return null;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (failure) {
    if (failure.code === "ESRCH") {
      if (reclaimDeadOwner(directory)) return tryAcquireProcessLock(directory);
    }
  }
  return null;
}
function removeStagedLock(directory) {
  removePrivateFile(path.join(directory, "owner.json"));
  removePrivateDirectory(directory);
}
function removePrivateFile(file) {
  const deadline = Date.now() + PRIVATE_CLEANUP_RETRY_MS;
  while (true) {
    try {
      unlinkSync(file);
      return;
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT" || !isTransientLockFsError(error) || Date.now() >= deadline) return;
      pauseBriefly();
    }
  }
}
function removePrivateDirectory(directory) {
  const deadline = Date.now() + PRIVATE_CLEANUP_RETRY_MS;
  while (true) {
    try {
      rmdirSync(directory);
      return;
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT" || !isTransientLockFsError(error) || Date.now() >= deadline) return;
      pauseBriefly();
    }
  }
}
function reclaimDeadOwner(directory) {
  const guard = `${directory}.reclaim`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  let outcome;
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      outcome = { kind: "busy" };
    } else {
      try {
        process.kill(owner.pid, 0);
        outcome = { kind: "busy" };
      } catch (failure) {
        if (failure.code !== "ESRCH") {
          outcome = { kind: "busy" };
        } else {
          const retired = `${directory}.${randomUUID()}.retired`;
          renameWithTransientRetry(directory, retired);
          removeStagedLock(retired);
          outcome = { kind: "reclaimed" };
        }
      }
    }
  } catch (error) {
    outcome = error.code === "ENOENT" ? { kind: "busy" } : { kind: "error", error };
  }
  let guardCleanupError = null;
  try {
    removeSharedGuard(guard);
  } catch (error) {
    guardCleanupError = error;
  }
  if (outcome.kind === "error") throw outcome.error;
  if (guardCleanupError !== null) throw guardCleanupError;
  return outcome.kind === "reclaimed";
}
function removeSharedGuard(guard) {
  const deadline = Date.now() + SHARED_GUARD_RETRY_MS;
  while (true) {
    try {
      rmdirSync(guard);
      return;
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") return;
      if (!isTransientLockFsError(error) || Date.now() >= deadline) {
        throw new Error(
          `could not remove the lock reclaim guard at ${guard} (${code ?? "unknown error"}); a leftover guard blocks all future dead-owner reclaims of this lock and needs manual diagnosis`,
          { cause: error }
        );
      }
      pauseBriefly();
    }
  }
}

// src/store/atomic-rename.ts
import { renameSync as renameSync2 } from "node:fs";
function retryable(error, deadline) {
  return process.platform === "win32" && Date.now() < deadline && ["EPERM", "EBUSY", "EACCES"].includes(error.code ?? "");
}
function atomicRenameSync(source, target) {
  const deadline = Date.now() + 2e3;
  while (true) {
    try {
      renameSync2(source, target);
      return;
    } catch (error) {
      if (!retryable(error, deadline)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

// src/store/task-store.ts
var TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
var MAX_INTERACTION_PARAMS_BYTES = 1024 * 1024;
var LEGACY_INTERACTION_PARAMS_BYTES = 32e3;
var SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
var InteractionRequestTooLargeError = class extends Error {
  actualBytes;
  limitBytes;
  constructor(actualBytes, limitBytes) {
    super(
      `ZCode interaction request exceeded the ${limitBytes}-byte persistence limit (actual ${actualBytes} UTF-8 bytes); split the tool input into smaller parts and retry`
    );
    this.name = "InteractionRequestTooLargeError";
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
};
var MAX_CRITICAL_EVENT_RESERVE_BYTES = 256 * 1024;
var CRITICAL_EVENT_TYPES = /* @__PURE__ */ new Set([
  "error",
  "task_finished",
  "turn_completed",
  "report_ready",
  "session_ready",
  "turn_started",
  "worker_started",
  "workspace_ready",
  "timeout_warning",
  "model_catalog",
  "account_provider_sync_failed",
  "interaction_requested",
  "interaction_reply_submitted",
  "cancelled",
  "cancel_failed",
  "cleanup_unverified",
  "outcome_checkpoint_failed",
  "outcome_recovered",
  // ADR-008: fatal frame failures and undeliverable approvals must survive
  // event-log capacity pressure.
  "protocol_error",
  "interaction_request_oversized",
  "interaction_request_undeliverable"
]);
var TaskStore = class {
  #dataRoot;
  #tasksRoot;
  #maxLogBytes;
  #maxEventBytes;
  constructor(dataRoot2, options = {}) {
    this.#dataRoot = dataRoot2;
    this.#tasksRoot = path2.join(dataRoot2, ".tasks");
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_LOG_BYTES;
    privateMkdir(this.#tasksRoot);
  }
  get dataRoot() {
    return this.#dataRoot;
  }
  get tasksRoot() {
    return this.#tasksRoot;
  }
  assertValidTaskId(taskId2) {
    if (typeof taskId2 !== "string" || !TASK_ID_PATTERN.test(taskId2)) {
      throw new Error(`invalid task_id (must match ${TASK_ID_PATTERN.source}): ${String(taskId2)}`);
    }
  }
  taskDir(taskId2) {
    this.assertValidTaskId(taskId2);
    return path2.join(this.#tasksRoot, taskId2);
  }
  hasTask(taskId2) {
    try {
      return existsSync2(path2.join(this.taskDir(taskId2), "status.json"));
    } catch {
      return false;
    }
  }
  listTaskIds() {
    if (!existsSync2(this.#tasksRoot)) return [];
    return readdirSync(this.#tasksRoot).filter(
      (entry) => existsSync2(path2.join(this.#tasksRoot, entry, "status.json"))
    );
  }
  createTask(task, createdAt) {
    this.assertValidTaskId(task.task_id);
    const dir = this.taskDir(task.task_id);
    if (existsSync2(path2.join(dir, "task.json"))) {
      throw new Error(`task already exists: ${task.task_id}`);
    }
    privateMkdir(path2.join(dir, "attempts"));
    this.#writeJsonAtomic(path2.join(dir, "task.json"), task);
    const status = {
      task_id: task.task_id,
      status: "queued",
      attempt: 1,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null
    };
    this.#writeJsonAtomic(path2.join(dir, "status.json"), status);
  }
  readTask(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "task.json");
    const parsed = this.#readJson(file);
    const task = parsed;
    if (!task || task.task_id !== taskId2 || typeof task.workspace !== "string" || !task.workspace || typeof task.objective !== "string" || [task.requirements, task.allowed_paths, task.forbidden_paths, task.acceptance_criteria, task.test_commands].some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))) throw new Error(`corrupt task record: ${file}`);
    return task;
  }
  readSubmission(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "submission.json");
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  writeSubmission(taskId2, submission) {
    this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "submission.json"), submission);
  }
  writeWorkspaceRef(taskId2, workspace) {
    this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "workspace.json"), workspace);
  }
  readWorkspaceRef(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "workspace.json");
    if (!existsSync2(file)) return null;
    const workspace = this.#readJson(file);
    if (!workspace || typeof workspace.canonicalPath !== "string" || typeof workspace.requestedPath !== "string" || !["direct", "worktree"].includes(workspace.mode)) throw new Error(`corrupt workspace record: ${file}`);
    return workspace;
  }
  readStatus(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "status.json");
    const parsed = this.#readJson(file);
    if (!parsed || parsed.task_id !== taskId2 || !["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"].includes(parsed.status) || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || typeof parsed.created_at !== "string") {
      throw new Error(`corrupt status record: ${file}`);
    }
    return parsed;
  }
  /** Read-merge-write with an updated timestamp; atomic via temp file + rename. */
  writeStatus(taskId2, patch, expectedAttempt) {
    return withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const current = this.readStatus(taskId2);
      if (expectedAttempt !== void 0 && (current.attempt !== expectedAttempt || isTerminalStatus(current.status))) throw new Error("stale or terminal worker status rejected");
      const next = {
        ...current,
        ...patch,
        task_id: current.task_id,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "status.json"), next);
      return next;
    });
  }
  readResult(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "result.json");
    if (!existsSync2(file)) return null;
    const result = this.#readJson(file);
    if (!result || result.task_id !== taskId2 || !Number.isSafeInteger(result.attempt) || !isTerminalStatus(result.status)) throw new Error(`corrupt result record: ${file}`);
    return result.attempt === this.readStatus(taskId2).attempt ? result : null;
  }
  writeResult(taskId2, result) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      if (this.readStatus(taskId2).attempt !== result.attempt) throw new Error("stale worker attempt result rejected");
      this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "result.json"), result);
    });
  }
  commitWorkerResult(taskId2, attempt, result, patch) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      this.assertWorkerAttempt(taskId2, attempt);
      this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "result.json"), result);
      const current = this.readStatus(taskId2);
      let effective = patch;
      if (current.cleanup_unverified === true) {
        effective = { ...patch, cleanup_unverified: true };
        if (typeof current.error === "string" && current.error.includes("[cleanup-members:")) {
          effective = { ...effective, error: current.error };
        }
      }
      this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "status.json"), { ...current, ...effective, task_id: taskId2, attempt, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
    });
  }
  patchRunningAttempt(taskId2, attempt, patch) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const current = this.readStatus(taskId2);
      if (current.attempt !== attempt || current.status !== "running") return;
      this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "status.json"), { ...current, ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
    });
  }
  /** Copies evidence before the continuation status commit; the old result remains recoverable. */
  archiveResultToAttempt(taskId2, attempt) {
    const dir = this.taskDir(taskId2);
    const source = path2.join(dir, "result.json");
    if (!existsSync2(source)) return;
    const targetDir = this.attemptDir(taskId2, attempt);
    privateMkdir(targetDir);
    copyFileSync(source, path2.join(targetDir, "result.json"));
    privateFile(path2.join(targetDir, "result.json"));
  }
  /** A claim is permanent: a started attempt must never execute again. */
  claimWorkerExecution(taskId2, attempt) {
    return withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const status = this.readStatus(taskId2);
      if (status.attempt !== attempt || isTerminalStatus(status.status)) return false;
      privateMkdir(this.attemptDir(taskId2, attempt));
      try {
        writeFileSync2(path2.join(this.attemptDir(taskId2, attempt), "execution.claim"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 384 });
        return true;
      } catch (error) {
        if (error.code === "EEXIST") return false;
        throw error;
      }
    });
  }
  assertWorkerAttempt(taskId2, attempt) {
    const status = this.readStatus(taskId2);
    if (status.attempt !== attempt || isTerminalStatus(status.status)) throw new Error("stale or terminal worker attempt rejected");
  }
  readArchivedResult(taskId2, attempt) {
    const file = path2.join(this.attemptDir(taskId2, attempt), "result.json");
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  attemptDir(taskId2, attempt) {
    return path2.join(this.taskDir(taskId2), "attempts", String(attempt));
  }
  writeAttemptFile(taskId2, attempt, fileName, content) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeTextAtomic(path2.join(dir, fileName), content);
  }
  writeAttemptMeta(taskId2, attempt, fileName, meta) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeJsonAtomic(path2.join(dir, fileName), meta);
  }
  readAttemptMeta(taskId2, attempt, fileName) {
    const file = path2.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  writeWorkerHeartbeat(taskId2, attempt, heartbeat) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const status = this.readStatus(taskId2);
      const claim = this.readAttemptMeta(taskId2, attempt, "execution.claim");
      if (status.attempt !== attempt || status.status !== "running" || status.worker_pid !== heartbeat.worker_pid || claim?.pid !== heartbeat.worker_pid) {
        throw new Error("stale or unowned worker heartbeat rejected");
      }
      this.#writeJsonAtomic(path2.join(this.attemptDir(taskId2, attempt), "heartbeat.json"), heartbeat);
    });
  }
  readWorkerHeartbeat(taskId2, attempt) {
    const value = this.readAttemptMeta(taskId2, attempt, "heartbeat.json");
    if (!value || value.attempt !== attempt || !Number.isSafeInteger(value.worker_pid) || typeof value.heartbeat_at !== "string") return null;
    return value;
  }
  readAttemptText(taskId2, attempt, fileName) {
    const file = path2.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync2(file)) return null;
    return readFileSync2(file, "utf8");
  }
  // ---- A1 observation evidence (bounded reads, no task bodies) ----
  /** Bounded persisted evidence for the observation judger. */
  readObservationEvidence(taskId2, attempt) {
    const checkpointRaw = this.readAttemptMeta(taskId2, attempt, "outcome-checkpoint.json");
    const checkpoint = checkpointRaw && typeof checkpointRaw.recorded_at === "string" ? { recorded_at: checkpointRaw.recorded_at } : null;
    const heartbeat = this.readWorkerHeartbeat(taskId2, attempt);
    return {
      checkpoint,
      heartbeat,
      last_business_event: this.readLastBusinessEvent(taskId2),
      pending_interaction: this.readPendingInteraction(taskId2)
    };
  }
  /** Last complete event line, read from a bounded tail window. */
  readLastBusinessEvent(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "events.jsonl");
    if (!existsSync2(file)) return null;
    let size = 0;
    try {
      size = statSync2(file).size;
    } catch {
      return null;
    }
    if (size === 0) return null;
    const window = Math.min(8192, size);
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try {
        read = readSync(fd, buffer, 0, window, size - window);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const body = newline >= 0 && window < size ? text.slice(newline + 1) : text;
    const lines = body.split("\n").filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = parseProgressEvent(lines[index]);
      if (event) return { at: event.at, type: event.type, seq: event.seq };
    }
    return null;
  }
  /** Distinct event types from a bounded tail window (A3 stage inference). */
  listRecentEventTypes(taskId2, maxLines) {
    const file = path2.join(this.taskDir(taskId2), "events.jsonl");
    if (!existsSync2(file)) return [];
    let size = 0;
    try {
      size = statSync2(file).size;
    } catch {
      return [];
    }
    const window = Math.min(256 * 1024, size);
    if (window === 0) return [];
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try {
        read = readSync(fd, buffer, 0, window, size - window);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const body = newline >= 0 && window < size ? text.slice(newline + 1) : text;
    const types = /* @__PURE__ */ new Set();
    for (const line of body.split("\n").slice(-maxLines)) {
      const event = parseProgressEvent(line);
      if (event) types.add(event.type);
    }
    return [...types];
  }
  /** Newest unanswered interaction request (bounded directory scan). */
  readPendingInteraction(taskId2) {
    const directory = path2.join(this.taskDir(taskId2), "interactions");
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return null;
    }
    const files = entries.filter((entry) => entry.endsWith(".json")).slice(0, 64);
    let newest = null;
    for (const file of files) {
      try {
        const record2 = JSON.parse(readFileSync2(path2.join(directory, file), "utf8"));
        if (record2.state === "pending" && typeof record2.method === "string" && typeof record2.created_at === "string") {
          if (!newest || record2.created_at > newest.created_at) newest = { method: record2.method, created_at: record2.created_at };
        }
      } catch {
      }
    }
    return newest;
  }
  /** Pending interaction requests for the current attempt, oldest first.
   * Public request ids are attempt-prefixed ("<attempt>:<runtime id>"), so a
   * monitor can wake a host exactly once per still-pending request. */
  listPendingInteractions(taskId2, max = 16) {
    const directory = path2.join(this.taskDir(taskId2), "interactions");
    const prefix = `${this.readStatus(taskId2).attempt}-`;
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const file of entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))) {
      const record2 = JSON.parse(readFileSync2(path2.join(directory, file), "utf8"));
      if (record2.state === "pending") records.push({ request_id: record2.request_id, method: record2.method, created_at: record2.created_at });
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
  writeWorkerObservation(taskId2, attempt, writerPid, patch, revision, updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const status = this.readStatus(taskId2);
      if (status.attempt !== attempt) throw new Error("stale attempt observation rejected");
      const claim = this.readAttemptMeta(taskId2, attempt, "execution.claim");
      if (claim?.pid !== writerPid) throw new Error("observation writer does not own the execution claim");
      this.#mergeObservationSnapshot(taskId2, attempt, "worker", revision, patch, updatedAt);
    });
  }
  /** Writes manager-owned snapshot fields (probe verdicts); worker business
   * phases are never overwritten from the manager side. */
  writeManagerObservation(taskId2, attempt, patch, revision, updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    withEventLock(path2.join(this.taskDir(taskId2), "state.lock"), () => {
      const status = this.readStatus(taskId2);
      if (status.attempt !== attempt) throw new Error("stale attempt observation rejected");
      this.#mergeObservationSnapshot(taskId2, attempt, "manager", revision, patch, updatedAt);
    });
  }
  readObservationSnapshot(taskId2, attempt) {
    const file = path2.join(this.attemptDir(taskId2, attempt), "observation.json");
    if (!existsSync2(file)) return { snapshot: null, corrupt: false };
    try {
      const parsed = JSON.parse(readFileSync2(file, "utf8"));
      if (parsed.schema_version !== 1 || parsed.task_id !== taskId2 || parsed.attempt !== attempt) {
        return { snapshot: null, corrupt: true };
      }
      return { snapshot: parsed, corrupt: false };
    } catch {
      return { snapshot: null, corrupt: true };
    }
  }
  #mergeObservationSnapshot(taskId2, attempt, writer, revision, patch, updatedAt) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("observation revision must be a non-negative integer");
    const current = this.readObservationSnapshot(taskId2, attempt).snapshot;
    const previousRevision = current?.writers?.[writer] ?? -1;
    if (revision <= previousRevision) throw new Error("stale observation revision rejected");
    const carried = current ?? {};
    const next = {
      schema_version: 1,
      task_id: taskId2,
      attempt,
      writers: { ...carried.writers, [writer]: revision },
      updated_at: updatedAt
    };
    const workerOwned = ["session_id", "turn_id", "last_runtime_seq", "activity_phase", "worker_identity", "runtime_identity"];
    const managerOwned = ["worker_probe", "runtime_probe"];
    for (const key of workerOwned) {
      if (key in patch) next[key] = patch[key];
      else if (key in carried) next[key] = carried[key];
    }
    for (const key of managerOwned) {
      if (key in patch) next[key] = patch[key];
      else if (key in carried) next[key] = carried[key];
    }
    this.writeAttemptMeta(taskId2, attempt, "observation.json", next);
  }
  // ---- A2 executor identity evidence ----
  writeExecutorIdentity(taskId2, attempt, identity) {
    const current = this.readAttemptMeta(taskId2, attempt, "executor-identity.json") ?? {};
    this.writeAttemptMeta(taskId2, attempt, "executor-identity.json", {
      ...current,
      ...identity
    });
  }
  readExecutorIdentity(taskId2, attempt) {
    return this.readAttemptMeta(taskId2, attempt, "executor-identity.json");
  }
  /**
   * Atomically claims the single worker-respawn slot for an attempt by
   * creating the marker file with an exclusive flag, so several Bridge
   * processes sharing this data root can never spawn two replacement
   * workers. Returns false when the slot is already claimed.
   */
  claimAttemptRespawn(taskId2, attempt) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    try {
      closeSync(openSync(path2.join(dir, "respawn.claim"), "wx"));
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }
  /** File time of the respawn claim, or null when the attempt is unclaimed. */
  respawnClaimedAt(taskId2, attempt) {
    try {
      return statSync2(path2.join(this.attemptDir(taskId2, attempt), "respawn.claim")).mtime;
    } catch {
      return null;
    }
  }
  /** Append-only, byte-bounded. Returns whether the chunk was truncated. */
  appendLog(taskId2, kind, text) {
    if (!text) return { truncated: false };
    const dir = this.taskDir(taskId2);
    privateMkdir(dir);
    const file = path2.join(dir, `${kind}.log`);
    let currentBytes = 0;
    try {
      currentBytes = statSync2(file).size;
    } catch {
      currentBytes = 0;
    }
    const bytes = Buffer.from(text, "utf8");
    const room = this.#maxLogBytes - currentBytes;
    if (room <= 0) return { truncated: true };
    appendFileSync(file, bytes.length <= room ? bytes : bytes.subarray(0, room), { mode: 384 });
    privateFile(file);
    return { truncated: bytes.length > room };
  }
  readLog(taskId2, kind) {
    const file = path2.join(this.taskDir(taskId2), `${kind}.log`);
    return existsSync2(file) ? readFileSync2(file, "utf8") : "";
  }
  appendEvent(taskId2, type, summary, details, at = (/* @__PURE__ */ new Date()).toISOString()) {
    const dir = this.taskDir(taskId2);
    mkdirSync2(dir, { recursive: true });
    const lockDir = path2.join(dir, "events.lock");
    return withEventLock(lockDir, () => {
      const file = path2.join(dir, "events.jsonl");
      const seqFile = path2.join(dir, "events.seq");
      let bytes = 0;
      let previousSeq = 0;
      let needsSeparator = false;
      try {
        const info = statSync2(file);
        bytes = info.size;
        let lastByte;
        if (bytes > 0) {
          const fd = openSync(file, "r");
          try {
            const tail = Buffer.alloc(1);
            readSync(fd, tail, 0, 1, bytes - 1);
            lastByte = tail[0];
          } finally {
            closeSync(fd);
          }
        }
        needsSeparator = bytes > 0 && lastByte !== 10;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        bytes = 0;
      }
      try {
        previousSeq = Number(readFileSync2(seqFile, "utf8"));
        if (!Number.isSafeInteger(previousSeq) || previousSeq < 0) previousSeq = readLastEventSeq(file);
      } catch {
        previousSeq = readLastEventSeq(file);
      }
      const event = {
        seq: previousSeq + 1,
        at,
        type: type.slice(0, 80),
        summary: summary.length <= 2e3 ? summary : `${summary.slice(0, 1970)}\u2026[output truncated]`,
        ...details && Object.keys(details).length ? { details } : {}
      };
      const line = `${JSON.stringify(event)}
`;
      const lineBytes = Buffer.byteLength(line, "utf8") + (needsSeparator ? 1 : 0);
      const critical = CRITICAL_EVENT_TYPES.has(type);
      const capacity = this.#maxEventBytes + (critical ? MAX_CRITICAL_EVENT_RESERVE_BYTES : 0);
      if (lineBytes > 64e3 || bytes + lineBytes > capacity) return null;
      this.#writeTextAtomic(seqFile, String(event.seq));
      const eventOffset = bytes + (needsSeparator ? 1 : 0);
      appendFileSync(file, `${needsSeparator ? "\n" : ""}${line}`, { encoding: "utf8", mode: 384 });
      privateFile(file);
      const genFile = path2.join(dir, "events.gen");
      if (!existsSync2(genFile)) {
        this.#writeTextAtomic(genFile, randomUUID2());
      }
      if (event.seq % 100 === 0) {
        const index = path2.join(dir, "events.index");
        appendFileSync(index, `${event.seq}	${eventOffset}
`, { encoding: "utf8", mode: 384 });
        privateFile(index);
      }
      return event;
    });
  }
  readEvents(taskId2, afterSeq = 0, limit = 100, view = "raw") {
    const file = path2.join(this.taskDir(taskId2), "events.jsonl");
    if (!existsSync2(file)) return { events: [], nextSeq: afterSeq, hasMore: false, omittedEvents: 0 };
    let offset = 0;
    const indexFile = path2.join(this.taskDir(taskId2), "events.index");
    if (existsSync2(indexFile)) {
      for (const row of readFileSync2(indexFile, "utf8").split(/\r?\n/u)) {
        const [seqText, offsetText] = row.split("	");
        const seq = Number(seqText);
        const candidateOffset = Number(offsetText);
        if (Number.isInteger(seq) && Number.isSafeInteger(candidateOffset) && seq <= afterSeq) offset = candidateOffset;
        if (seq > afterSeq) break;
      }
    }
    const fd = openSync(file, "r");
    const page = [];
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
          if (page.length === limit) {
            hasMore = true;
            break;
          }
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
            summary: combined.length <= 5e3 ? combined : `${combined.slice(0, 4950)}\u2026[output compacted]`
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
      omittedEvents
    };
  }
  /**
   * B1 bounded scan: parses complete byte lines only; an unfinished trailing
   * line is not consumed and the cursor never passes it. Complete corrupt
   * lines are skipped but counted. The byte budget covers at most the
   * configured budget plus one read block; exhaustion reports scan_incomplete
   * and never a has_more=true page with an unchanged after_seq.
   */
  readEventsBounded(taskId2, input = {}) {
    const afterSeq = input.afterSeq ?? 0;
    const limit = input.limit ?? 100;
    const view = input.view ?? "raw";
    const budget = input.maxBytes ?? this.#maxEventBytes;
    const file = path2.join(this.taskDir(taskId2), "events.jsonl");
    const empty = {
      events: [],
      nextSeq: afterSeq,
      hasMore: false,
      omittedEvents: 0,
      scan_incomplete: false,
      scan_cursor: null,
      cursor_invalid: false,
      metrics: { bytes_read: 0, records_scanned: 0, invalid_lines: 0, corrupt_count: 0, first_corrupt_offset: null, index_fallback: false }
    };
    let size = 0;
    try {
      size = statSync2(file).size;
    } catch {
      return empty;
    }
    if (size === 0) return empty;
    let startOffset = 0;
    let cursorInvalid = false;
    if (input.cursor) {
      const generation = this.readEventGeneration(taskId2);
      const valid = input.cursor.v === 1 && input.cursor.task_id === taskId2 && generation !== null && input.cursor.generation === generation && Number.isSafeInteger(input.cursor.offset) && input.cursor.offset >= 0 && input.cursor.offset <= size;
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
    let indexFallback = false;
    if (startOffset === 0) {
      const indexFile = path2.join(this.taskDir(taskId2), "events.index");
      if (existsSync2(indexFile)) {
        try {
          let lastSeq = 0;
          let lastOffset = 0;
          for (const row of readFileSync2(indexFile, "utf8").split(/\r?\n/u)) {
            if (!row.trim()) continue;
            const [seqText, offsetText] = row.split("	");
            const seq = Number(seqText);
            const offset = Number(offsetText);
            if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(offset) || seq <= lastSeq || offset < lastOffset || offset > size) {
              throw new Error("invalid index row");
            }
            lastSeq = seq;
            lastOffset = offset;
          }
          for (const row of readFileSync2(indexFile, "utf8").split(/\r?\n/u)) {
            const [seqText, offsetText] = row.split("	");
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
    const events = [];
    let scanned = 0;
    let bytesRead = 0;
    let invalidLines = 0;
    let corruptCount = 0;
    let firstCorruptOffset = null;
    let hasMore = false;
    let position = startOffset;
    let lastCompleteOffset = startOffset;
    let pending = "";
    let pendingStartOffset = startOffset;
    let reachedEnd = false;
    const maxRead = budget + 64 * 1024;
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const fd = openSync(file, "r");
    const processLine = (line, lineOffset, lineEndOffset) => {
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
        if (count <= 0) {
          reachedEnd = true;
          break;
        }
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
          if (!processLine(line, lineOffset, pendingStartOffset + consumedBytes)) {
            stopped = true;
            break;
          }
        }
        if (stopped) {
          pending = "";
          break;
        }
        pending = text.slice(searchFrom);
        pendingStartOffset += consumedBytes;
      }
      if (!hasMore) {
        const tail = pending + decoder.end();
        let searchFrom = 0;
        let consumedBytes = 0;
        while (true) {
          const newline = tail.indexOf("\n", searchFrom);
          if (newline < 0) break;
          const line = tail.slice(searchFrom, newline).replace(/\r$/u, "");
          const lineBytes = Buffer.byteLength(tail.slice(searchFrom, newline + 1), "utf8");
          const lineOffset = pendingStartOffset + consumedBytes;
          consumedBytes += lineBytes;
          searchFrom = newline + 1;
          if (!processLine(line, lineOffset, pendingStartOffset + consumedBytes)) break;
        }
        if (!hasMore && !reachedEnd && bytesRead >= maxRead) {
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
            summary: combined.length <= 5e3 ? combined : `${combined.slice(0, 4950)}\u2026[output compacted]`
          };
          omittedEvents += 1;
        } else {
          page.push(event);
        }
      }
    }
    const scanIncomplete = !reachedEnd && !hasMore;
    const nextSeq = page.at(-1)?.seq ?? afterSeq;
    if (hasMore && nextSeq === afterSeq && !input.cursor) hasMore = false;
    const cursor = this.readEventGeneration(taskId2) ? { v: 1, task_id: taskId2, generation: this.readEventGeneration(taskId2), offset: lastCompleteOffset, first_seq: input.cursor?.first_seq ?? this.readFirstEventSeq(file, size) } : null;
    return {
      events: page,
      nextSeq,
      hasMore,
      omittedEvents,
      scan_incomplete: scanIncomplete,
      scan_cursor: cursor,
      cursor_invalid: false,
      metrics: { bytes_read: bytesRead, records_scanned: scanned, invalid_lines: invalidLines, corrupt_count: corruptCount, first_corrupt_offset: firstCorruptOffset, index_fallback: indexFallback }
    };
  }
  /** Generation marker detecting log replacement/truncation across reads. */
  readEventGeneration(taskId2) {
    try {
      const value = readFileSync2(path2.join(this.taskDir(taskId2), "events.gen"), "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }
  readFirstEventSeq(file, size) {
    const window = Math.min(64 * 1024, size);
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    try {
      const fd = openSync(file, "r");
      try {
        read = readSync(fd, buffer, 0, window, 0);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) return null;
    const event = parseProgressEvent(text.slice(0, newline).replace(/\r$/u, ""));
    return event ? event.seq : null;
  }
  writeInteractionRequest(taskId2, request, createdAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const directory = path2.join(this.taskDir(taskId2), "interactions");
    privateMkdir(directory);
    const file = this.interactionFile(taskId2, request.request_id);
    return withEventLock(path2.join(this.taskDir(taskId2), "interactions.lock"), () => {
      if (existsSync2(file)) {
        const record3 = this.#readJson(file);
        if (record3.request_id !== request.request_id || record3.method !== request.method || stableJson(record3.params) !== stableJson(request.params)) {
          throw new Error("interaction request id collision");
        }
        return { record: record3, created: false };
      }
      const serialized = JSON.stringify(request.params);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_INTERACTION_PARAMS_BYTES) {
        throw new InteractionRequestTooLargeError(bytes, MAX_INTERACTION_PARAMS_BYTES);
      }
      const record2 = {
        ...request,
        state: "pending",
        created_at: createdAt,
        params_bytes: bytes,
        params_sha256: createHash("sha256").update(serialized).digest("hex")
      };
      this.#writeJsonAtomic(file, record2);
      return { record: record2, created: true };
    });
  }
  readInteractionRequest(taskId2, requestId) {
    const file = this.interactionFile(taskId2, requestId);
    if (!existsSync2(file)) return null;
    const record2 = this.#readJson(file);
    if (record2.request_id !== requestId) throw new Error("interaction request id hash mismatch");
    return record2;
  }
  /** Absolute path of one attempt's private full-request record; referenced
   * by bounded interaction_requested preview events (ADR-008). */
  interactionRequestPath(taskId2, requestId) {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    return this.interactionFile(taskId2, requestId);
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
  verifyInteractionRequestIntegrity(taskId2, requestId) {
    const file = this.interactionFile(taskId2, requestId);
    try {
      if (!existsSync2(file)) return { ok: false, reason: "the full request record is missing" };
      const record2 = this.#readJson(file);
      if (record2.request_id !== requestId) return { ok: false, reason: "the persisted request id does not match this request" };
      if (record2.state !== "pending" && record2.state !== "answered") return { ok: false, reason: "the persisted request state is unreadable" };
      const serialized = JSON.stringify(record2.params);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_INTERACTION_PARAMS_BYTES) {
        return { ok: false, reason: `the full request content is ${bytes} UTF-8 bytes, over the ${MAX_INTERACTION_PARAMS_BYTES}-byte persistence limit` };
      }
      const hasBytes = record2.params_bytes !== void 0;
      const hasHash = record2.params_sha256 !== void 0;
      if (!hasBytes && !hasHash) {
        if (bytes <= LEGACY_INTERACTION_PARAMS_BYTES) return { ok: true };
        return { ok: false, reason: `the full request record carries no integrity metadata but is ${bytes} UTF-8 bytes, over the legacy ${LEGACY_INTERACTION_PARAMS_BYTES}-byte limit; it cannot be treated as a legacy record` };
      }
      if (!hasBytes || !hasHash) {
        return { ok: false, reason: "the full request record has incomplete integrity metadata (byte count and SHA256 must both be present)" };
      }
      if (typeof record2.params_bytes !== "number" || !Number.isSafeInteger(record2.params_bytes) || record2.params_bytes < 0) {
        return { ok: false, reason: "the persisted byte count is not a valid non-negative integer" };
      }
      if (typeof record2.params_sha256 !== "string" || !SHA256_HEX_PATTERN.test(record2.params_sha256)) {
        return { ok: false, reason: "the persisted SHA256 is not a valid 64-character hex digest" };
      }
      if (record2.params_bytes !== bytes) {
        return { ok: false, reason: "the persisted byte count does not match the full content" };
      }
      if (record2.params_sha256 !== createHash("sha256").update(serialized).digest("hex")) {
        return { ok: false, reason: "the persisted SHA256 does not match the full content" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "the full request record is unreadable or corrupt" };
    }
  }
  answerInteractionRequest(taskId2, requestId, answer, answeredAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const file = this.interactionFile(taskId2, requestId);
    return withEventLock(path2.join(this.taskDir(taskId2), "interactions.lock"), () => {
      if (!existsSync2(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file);
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return "already_answered";
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt
      });
      return "answered";
    });
  }
  /** ADR-008: approval answers verify the full request inside the same
   * interaction lock the answer is written under, so the record checked for
   * integrity is exactly the one the answer lands on — there is no
   * check-then-write window where an edited record could slip through. */
  answerInteractionRequestVerified(taskId2, requestId, answer, options, answeredAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const file = this.interactionFile(taskId2, requestId);
    return withEventLock(path2.join(this.taskDir(taskId2), "interactions.lock"), () => {
      if (!existsSync2(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file);
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return { state: "already_answered" };
      if (options.requireIntegrity) {
        const integrity = this.verifyInteractionRequestIntegrity(taskId2, requestId);
        if (!integrity.ok) return { state: "integrity_failed", reason: integrity.reason };
      }
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt
      });
      return { state: "answered" };
    });
  }
  interactionFile(taskId2, requestId) {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    const key = createHash("sha256").update(requestId).digest("hex");
    return path2.join(this.taskDir(taskId2), "interactions", `${this.readStatus(taskId2).attempt}-${key}.json`);
  }
  #readJson(file) {
    try {
      return JSON.parse(readFileSync2(file, "utf8"));
    } catch (error) {
      throw new Error(`unreadable or corrupt JSON record: ${file}`, { cause: error });
    }
  }
  #writeJsonAtomic(file, value) {
    this.#writeTextAtomic(file, JSON.stringify(value, null, 2));
  }
  #writeTextAtomic(file, text) {
    const tmp = `${file}.${randomUUID2()}.tmp`;
    try {
      writeFileSync2(tmp, text, { encoding: "utf8", mode: 384 });
      privateFile(tmp);
      atomicRenameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
      }
      throw error;
    }
  }
};
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function withEventLock(lockDir, operation) {
  const deadline = Date.now() + 1e4;
  let release;
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
function privateMkdir(directory) {
  mkdirSync2(directory, { recursive: true, mode: 448 });
  privateDirectory(directory);
}
function privateDirectory(directory) {
  if (process.platform !== "win32") chmodSync(directory, 448);
}
function privateFile(file) {
  if (process.platform !== "win32") chmodSync(file, 384);
}
function readLastEventSeq(file) {
  if (!existsSync2(file)) return 0;
  for (const line of readFileSync2(file, "utf8").trimEnd().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (Number.isInteger(event.seq)) return event.seq;
    } catch {
    }
  }
  return 0;
}
function parseProgressEvent(line) {
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    return Number.isInteger(event.seq) ? event : null;
  } catch {
    return null;
  }
}
function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "waiting_for_master";
}
function toPublicStatus(status) {
  const record2 = {
    task_id: status.task_id,
    status: status.status,
    attempt: status.attempt,
    created_at: status.created_at,
    updated_at: status.updated_at,
    started_at: status.started_at,
    finished_at: status.finished_at,
    worker_pid: status.worker_pid,
    zcode_session_id: status.zcode_session_id,
    exit_code: status.exit_code
  };
  if (status.error_code) record2.error_code = status.error_code;
  if (status.error) record2.error = status.error;
  return record2;
}

// src/manager/normalize.ts
function buildTaskResult(input) {
  const { task, attempt, startedAt, finishedAt, outcome } = input;
  const base = {
    task_id: task.task_id,
    attempt,
    started_at: startedAt,
    finished_at: finishedAt,
    zcode_output: outcome?.response ?? "",
    exit_code: outcome?.exitCode ?? null,
    session_id: outcome?.sessionId ?? input.sessionId ?? null,
    ...input.usage !== void 0 ? { usage: input.usage } : {},
    ...input.model !== void 0 ? { model: input.model } : {},
    ...input.timing !== void 0 ? { timing: input.timing } : {}
  };
  if (input.cancelled || outcome?.cancelled) {
    return {
      ...base,
      status: "cancelled",
      summary: input.failure?.message ?? "cancelled by request",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false
    };
  }
  const failure = input.failure ?? (outcome ? null : { code: "worker_lost", message: "no adapter outcome was recorded" });
  if (failure || !outcome) {
    const resolved = failure ?? { code: "worker_lost", message: "no adapter outcome was recorded" };
    return {
      ...base,
      status: "failed",
      summary: truncate(`${resolved.code}: ${resolved.message}`, 2e3),
      files_changed: [],
      tests: [],
      issues: [truncate(resolved.message, 2e3)],
      needs_master_decision: true,
      error_code: resolved.code,
      ...resolved.code === "cleanup_failed" && outcome?.reportCandidate ? { report_candidate: outcome.reportCandidate } : {}
    };
  }
  if (outcome.errorCode || outcome.reportError) {
    const code = outcome.errorCode ?? "invalid_agent_report";
    const message = outcome.reportError ?? "the subordinate report was invalid";
    return {
      ...base,
      status: "failed",
      summary: truncate(`${code}: ${message}`, 2e3),
      files_changed: [],
      tests: [],
      issues: [truncate(message, 2e3)],
      needs_master_decision: true,
      error_code: code,
      ...outcome.reportCandidate ? { report_candidate: outcome.reportCandidate } : {}
    };
  }
  const report = outcome.agentReport;
  if (!report) {
    return {
      ...base,
      status: "failed",
      summary: "the adapter reported success without a normalized report",
      files_changed: [],
      tests: [],
      issues: ["missing AgentReport despite a clean exit"],
      needs_master_decision: true,
      error_code: "invalid_agent_report"
    };
  }
  return {
    ...base,
    status: report.needs_master_decision ? "waiting_for_master" : "completed",
    summary: report.summary,
    files_changed: report.files_changed,
    tests: report.tests,
    issues: report.issues,
    needs_master_decision: report.needs_master_decision,
    ...report.acceptance_met === void 0 ? {} : { acceptance_met: report.acceptance_met }
  };
}
function truncate(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\u2026[truncated]`;
}

// src/manager/errors.ts
var TaskManagerError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "TaskManagerError";
    this.code = code;
  }
};

// src/manager/spawn-worker.ts
import { spawn } from "node:child_process";
import { closeSync as closeSync2, mkdirSync as mkdirSync3, openSync as openSync2 } from "node:fs";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// src/runtime/child-env.ts
var WINDOWS_OS_ENV = /* @__PURE__ */ new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  // Non-sensitive system install directories; browser auto-discovery resolves
  // system Chrome/Edge under these roots (src/browser/executable.ts).
  "PROGRAMFILES",
  "PROGRAMFILES(X86)"
]);
var POSIX_OS_ENV = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME"
]);
function createMinimalOsEnv(source) {
  const allowed = process.platform === "win32" ? WINDOWS_OS_ENV : POSIX_OS_ENV;
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== void 0) env[key] = value;
  }
  return env;
}
function createWorkerEnv(source) {
  const env = createMinimalOsEnv(source);
  const explicitBridgeKeys = /* @__PURE__ */ new Set([
    "ZCODE_BRIDGE_NODE",
    "ZCODE_BRIDGE_ZCODE_CJS",
    "ZCODE_BRIDGE_DATA_DIR",
    "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID",
    "ZCODE_BRIDGE_DEFAULT_MODEL_ID",
    "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL",
    "ZCODE_BRIDGE_MODE",
    "ZCODE_BRIDGE_TIMEOUT_MS",
    // Env-only browser configuration (ADR-007): non-secret strings the worker's
    // adapter reads from its own environment when no persisted setting exists.
    "ZCODE_BRIDGE_BROWSER_USE",
    "ZCODE_BRIDGE_BROWSER_EXECUTABLE",
    "ZCODE_HOME",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_WINDOWS_APP_INSTALL_DIR"
  ]);
  for (const key of explicitBridgeKeys) {
    const value = source[key];
    if (value !== void 0) env[key] = value;
  }
  return env;
}

// src/host/profile.ts
import path3 from "node:path";
function validateHostProfile(host2) {
  if (!host2 || typeof host2.name !== "string" || !host2.name.trim() || typeof host2.settingsDirectory !== "string" || !path3.isAbsolute(host2.settingsDirectory)) throw new Error("invalid Bridge host profile");
  if (host2.legacySettingsDirectories !== void 0 && (!Array.isArray(host2.legacySettingsDirectories) || host2.legacySettingsDirectories.some((directory) => typeof directory !== "string" || !path3.isAbsolute(directory)))) throw new Error("host migration directories must be absolute");
  if (host2.workerEntryPath !== void 0 && (typeof host2.workerEntryPath !== "string" || !path3.isAbsolute(host2.workerEntryPath))) throw new Error("host worker entry must be absolute");
  if (host2.instructions !== void 0 && typeof host2.instructions !== "string") throw new Error("host instructions must be text");
  if (host2.defaultDataRoot !== void 0 && (typeof host2.defaultDataRoot !== "string" || !path3.isAbsolute(host2.defaultDataRoot))) throw new Error("host default data root must be absolute");
  return host2;
}

// src/manager/spawn-worker.ts
function workerEntryPath() {
  if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1") {
    return fileURLToPath(new URL("../worker/worker-main.mjs", import.meta.url));
  }
  return fileURLToPath(new URL("../worker/worker-main.js", import.meta.url));
}
function createWorkerSpawner(host2) {
  if (host2) validateHostProfile(host2);
  return (dataRoot2, taskId2, attempt) => {
    const attemptDir = path4.join(dataRoot2, ".tasks", taskId2, "attempts", String(attempt));
    mkdirSync3(attemptDir, { recursive: true });
    const stderrFd = openSync2(path4.join(attemptDir, "worker-stderr.log"), "a", 384);
    try {
      const workerEnv = {
        ...createWorkerEnv(process.env),
        ...host2 ? { ZCODE_BRIDGE_HOST_PROFILE: JSON.stringify(host2) } : {},
        // DeepSeek Harness may host its MCP entrypoint inside Electron. Its
        // executable is reusable for detached Node workers only in this mode.
        ...process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}
      };
      const child = spawn(process.execPath, [host2?.workerEntryPath ?? workerEntryPath(), dataRoot2, taskId2, String(attempt)], {
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", stderrFd],
        windowsHide: true,
        cwd: dataRoot2,
        env: workerEnv
      });
      child.on("error", (error) => console.error(`Bridge worker spawn failed: ${error.message}`));
      child.unref();
      if (typeof child.pid !== "number") {
        throw new Error("worker process did not provide a pid");
      }
      return { pid: child.pid };
    } finally {
      closeSync2(stderrFd);
    }
  };
}
var defaultSpawnWorker = createWorkerSpawner();

// src/runtime/process-probe.ts
import { readFile } from "node:fs/promises";
import { spawn as spawn2 } from "node:child_process";
var PROCESS_IDENTITY_VERSION = 1;
var DEFAULT_PROBE_TIMEOUT_MS = 5e3;
var DEFAULT_MAX_CONCURRENT = 2;
function identityOfFingerprint(pid, fingerprint, precision, now) {
  return {
    pid,
    fingerprint,
    fingerprint_precision: precision,
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: process.platform,
    captured_at: new Date(now()).toISOString()
  };
}
function verdict(state, reason, now) {
  return { state, reason_code: reason, observed_at: new Date(now()).toISOString() };
}
function failedQuery(reason) {
  return { ok: false, reason, fingerprints: /* @__PURE__ */ new Map() };
}
function windowsBatchQuery(pids, timeoutMs) {
  return new Promise((resolve) => {
    const script = `$ErrorActionPreference = 'Stop'; Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "{0}|{1}" -f $_.Id, $_.StartTime.Ticks }; 'bridge_probe_complete_v1'`;
    const child = spawn2("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let settled = false;
    const finish = (query) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(query);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish(failedQuery("timeout"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderrBytes = 0;
    child.stderr.on("data", (chunk) => {
      stderrBytes = Math.min(64e3, stderrBytes + chunk.length);
    });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1e6) stdout += chunk;
    });
    child.on("error", () => finish(failedQuery("spawn_error")));
    child.on("close", (code) => {
      const map = /* @__PURE__ */ new Map();
      const lines = stdout.trim().split(/\r?\n/u);
      if (code !== 0 || stderrBytes > 0 || lines.pop() !== "bridge_probe_complete_v1") {
        finish(failedQuery("query_error"));
        return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        const match = /^(\d+)\|(\d+)$/u.exec(line.trim());
        if (!match || !pids.includes(Number(match[1])) || map.has(Number(match[1]))) {
          finish(failedQuery("query_error"));
          return;
        }
        map.set(Number(match[1]), match[2]);
      }
      finish({ ok: true, reason: "ok", fingerprints: map });
    });
  });
}
async function darwinQuery(pids, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn2("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve(failedQuery("timeout"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1e6) stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(failedQuery("spawn_error"));
      }
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const map = /* @__PURE__ */ new Map();
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        if (match) map.set(Number(match[1]), match[2].trim());
      }
      resolve({ ok: true, reason: "ok", fingerprints: map });
    });
  });
}
function createPlatformProbe(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const now = options.now ?? Date.now;
  let chain = Promise.resolve();
  let inFlight = 0;
  let waiters = [];
  const schedule = async (operation) => {
    if (inFlight >= maxConcurrent) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
    try {
      return await operation();
    } finally {
      inFlight -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
  const probe = async (requests) => {
    if (requests.length === 0) return [];
    const distinct = [...new Set(requests.map((request) => request.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
    const query = await schedule(async () => {
      if (process.platform === "win32") return windowsBatchQuery(distinct, timeoutMs);
      if (process.platform === "darwin") return darwinQuery(distinct, timeoutMs);
      if (process.platform === "linux") {
        const map = /* @__PURE__ */ new Map();
        for (const pid of distinct) {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
            const fields = afterComm.split(" ");
            const starttime = fields[19];
            if (starttime) map.set(pid, starttime.trim());
          } catch (error) {
            if (error.code === "ENOENT") continue;
            return failedQuery("proc_read_error");
          }
        }
        return { ok: true, reason: "ok", fingerprints: map };
      }
      return failedQuery("unsupported_platform");
    });
    return requests.map((request) => {
      if (!Number.isInteger(request.pid) || request.pid <= 0) return verdict("unknown", "invalid_pid", now);
      if (!query.ok) return verdict("unknown", `query_${query.reason}`, now);
      const fingerprint = query.fingerprints.get(request.pid);
      if (fingerprint === void 0) {
        return verdict("exited", "pid_absent", now);
      }
      if (!request.identity || request.identity.fingerprint === null) {
        return verdict("unknown", "live_pid_no_fingerprint", now);
      }
      if (request.identity.fingerprint_precision === "coarse") {
        return request.identity.fingerprint === fingerprint ? verdict("unknown", "coarse_fingerprint_match", now) : verdict("exited", "pid_reused_coarse", now);
      }
      if (request.identity.fingerprint !== fingerprint) {
        return verdict("exited", "pid_reused", now);
      }
      return verdict("alive", "pid_and_fingerprint_match", now);
    });
  };
  const fingerprintOfPid = async (pid) => {
    const query = await schedule(async () => {
      if (process.platform === "win32") return windowsBatchQuery([pid], timeoutMs);
      if (process.platform === "darwin") return darwinQuery([pid], timeoutMs);
      if (process.platform === "linux") {
        const map = /* @__PURE__ */ new Map();
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
          const starttime = afterComm.split(" ")[19];
          if (starttime) map.set(pid, starttime.trim());
        } catch {
        }
        return { ok: true, reason: "ok", fingerprints: map };
      }
      return failedQuery("unsupported_platform");
    });
    const fingerprint = query.fingerprints.get(pid);
    if (!query.ok || !fingerprint) return identityOfFingerprint(pid, null, "unknown", now);
    const precision = process.platform === "darwin" ? "coarse" : "exact";
    return identityOfFingerprint(pid, fingerprint, precision, now);
  };
  return {
    platform: process.platform,
    identityOf: fingerprintOfPid,
    selfIdentity: () => fingerprintOfPid(process.pid),
    probe
  };
}
function livenessVerdict(pid, isAlive, now) {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return verdict("unknown", "no_pid_recorded", now);
  return isAlive(pid) ? verdict("alive", "kill0_alive_no_identity", now) : verdict("exited", "kill0_pid_absent", now);
}

// src/adapters/windows-process-cleanup.ts
import { spawn as spawn3 } from "node:child_process";
var CIM_REPRESENTATION_INTERVAL_TICKS = 10n;
function withinCimInterval(exactFileTime, cimFileTime) {
  const exact = BigInt(exactFileTime);
  const cim = BigInt(cimFileTime);
  return exact >= cim && exact <= cim + CIM_REPRESENTATION_INTERVAL_TICKS;
}
function cimIntervalWithin(cimFileTime, lowExact, highExact) {
  const cim = BigInt(cimFileTime);
  return cim >= BigInt(lowExact) && cim + CIM_REPRESENTATION_INTERVAL_TICKS <= BigInt(highExact);
}
function cimClearlyBefore(cimFileTime, exactFileTime) {
  return BigInt(cimFileTime) + CIM_REPRESENTATION_INTERVAL_TICKS < BigInt(exactFileTime);
}
function cimClearlyAfter(cimFileTime, exactFileTime) {
  return BigInt(cimFileTime) > BigInt(exactFileTime);
}
function acceptMember(row, input, held, members, memberPids, decidedIrrelevant, holdRequired, refuse) {
  if (row.startTicks === null || row.creationFileTime === null) {
    refuse("process_tree_member_identity_unknown", row.pid);
    return;
  }
  const child = held.get(row.pid);
  if (!child) {
    holdRequired.add(row.pid);
    return;
  }
  if (!withinCimInterval(child.creationFileTime, row.creationFileTime)) {
    refuse("process_tree_generation_mismatch", row.pid);
    return;
  }
  if (child.creationTicks !== row.startTicks) {
    refuse("process_tree_member_generation_mismatch", row.pid);
    return;
  }
  memberPids.add(row.pid);
  members.push({ pid: row.pid, parentPid: row.parentPid, creationFileTime: row.creationFileTime, startTicks: row.startTicks });
}
function resolveWindowsTreeMembership(input) {
  const rowsByPid = /* @__PURE__ */ new Map();
  for (const row of input.rows) {
    if (rowsByPid.has(row.pid)) return { kind: "refuse", code: "process_tree_snapshot_invalid", pid: row.pid };
    rowsByPid.set(row.pid, row);
  }
  const members = [];
  const memberPids = /* @__PURE__ */ new Set();
  const decidedIrrelevant = /* @__PURE__ */ new Set();
  const holdRequired = /* @__PURE__ */ new Set();
  const state = { refusal: null };
  const refuse = (code, pid) => {
    if (!state.refusal) state.refusal = { code, pid };
  };
  const rootRow = rowsByPid.get(input.rootPid);
  if (rootRow) {
    if (input.expectedRootTicks === null) {
      return { kind: "refuse", code: "process_tree_root_identity_required", pid: input.rootPid };
    }
    if (rootRow.startTicks === null || rootRow.creationFileTime === null) {
      return { kind: "refuse", code: "process_tree_root_identity_unknown", pid: input.rootPid };
    }
    if (rootRow.startTicks !== input.expectedRootTicks) {
      return { kind: "refuse", code: "process_tree_root_identity_changed", pid: input.rootPid };
    }
    const heldRoot = input.held.get(input.rootPid);
    if (!heldRoot) {
      holdRequired.add(input.rootPid);
    } else if (heldRoot.creationTicks !== rootRow.startTicks || !withinCimInterval(heldRoot.creationFileTime, rootRow.creationFileTime)) {
      return { kind: "refuse", code: "process_tree_root_generation_mismatch", pid: input.rootPid };
    } else {
      memberPids.add(rootRow.pid);
      members.push({ pid: rootRow.pid, parentPid: rootRow.parentPid, creationFileTime: rootRow.creationFileTime, startTicks: rootRow.startTicks });
    }
  } else if (!input.killed.has(input.rootPid)) {
    if (input.expectedRootTicks === null) {
      return { kind: "refuse", code: "process_tree_root_identity_required", pid: input.rootPid };
    }
    return { kind: "refuse", code: "process_tree_root_exited", pid: input.rootPid };
  }
  for (let changed = true; changed && !state.refusal; ) {
    changed = false;
    for (const row of input.rows) {
      if (state.refusal) break;
      if (memberPids.has(row.pid) || decidedIrrelevant.has(row.pid)) continue;
      const parentPid = row.parentPid;
      if (parentPid === row.pid) {
        decidedIrrelevant.add(row.pid);
        changed = true;
        continue;
      }
      const parentRow = memberPids.has(parentPid) ? rowsByPid.get(parentPid) : void 0;
      if (parentRow) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        if (parentRow.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", parentPid);
          continue;
        }
        const parent = input.held.get(parentPid);
        if (!parent) {
          holdRequired.add(parentPid);
          continue;
        }
        if (cimClearlyBefore(row.creationFileTime, parent.creationFileTime)) {
          decidedIrrelevant.add(row.pid);
          changed = true;
          continue;
        }
        const child = input.held.get(row.pid);
        if (!child) {
          holdRequired.add(row.pid);
          continue;
        }
        if (!withinCimInterval(child.creationFileTime, row.creationFileTime) || !withinCimInterval(parent.creationFileTime, parentRow.creationFileTime)) {
          refuse("process_tree_generation_mismatch", row.pid);
          continue;
        }
        const childCreation = BigInt(child.creationFileTime);
        const parentCreation = BigInt(parent.creationFileTime);
        if (childCreation === parentCreation) {
          refuse("process_tree_edge_indistinguishable", row.pid);
          continue;
        }
        if (childCreation < parentCreation) {
          decidedIrrelevant.add(row.pid);
          changed = true;
          continue;
        }
        acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
        if (memberPids.has(row.pid)) changed = true;
        continue;
      }
      const killedParent = input.killed.get(parentPid);
      if (killedParent) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        if (cimClearlyBefore(row.creationFileTime, killedParent.creationFileTime)) {
          decidedIrrelevant.add(row.pid);
          changed = true;
          continue;
        }
        if (killedParent.exitFileTime === null) {
          refuse("process_tree_parent_exit_unconfirmed", parentPid);
          continue;
        }
        if (cimClearlyAfter(row.creationFileTime, killedParent.exitFileTime)) {
          decidedIrrelevant.add(row.pid);
          changed = true;
          continue;
        }
        if (cimIntervalWithin(row.creationFileTime, killedParent.creationFileTime, killedParent.exitFileTime)) {
          acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
          if (memberPids.has(row.pid)) changed = true;
          continue;
        }
        const child = input.held.get(row.pid);
        if (!child) {
          holdRequired.add(row.pid);
          continue;
        }
        if (!withinCimInterval(child.creationFileTime, row.creationFileTime)) {
          refuse("process_tree_generation_mismatch", row.pid);
          continue;
        }
        const creation = BigInt(child.creationFileTime);
        if (creation >= BigInt(killedParent.creationFileTime) && creation <= BigInt(killedParent.exitFileTime)) {
          acceptMember(row, input, input.held, members, memberPids, decidedIrrelevant, holdRequired, refuse);
          if (memberPids.has(row.pid)) changed = true;
        } else {
          decidedIrrelevant.add(row.pid);
          changed = true;
        }
        continue;
      }
      if (input.naturalGonePids.has(parentPid)) {
        if (row.creationFileTime === null) {
          refuse("process_tree_row_creation_unknown", row.pid);
          continue;
        }
        const lastCim = input.naturalGoneCreation.get(parentPid) ?? null;
        if (lastCim !== null && cimClearlyBefore(row.creationFileTime, lastCim)) {
          decidedIrrelevant.add(row.pid);
          changed = true;
          continue;
        }
        refuse("process_tree_parent_unprovable", parentPid);
        continue;
      }
      const parentUndecidedLiveRow = rowsByPid.has(parentPid) && !memberPids.has(parentPid) && !decidedIrrelevant.has(parentPid);
      if (parentUndecidedLiveRow || parentPid === input.rootPid) continue;
      decidedIrrelevant.add(row.pid);
      changed = true;
    }
  }
  if (state.refusal) return { kind: "refuse", code: state.refusal.code, pid: state.refusal.pid };
  if (holdRequired.size > 0) return { kind: "members", members, holdRequired: [...holdRequired] };
  if (members.length === 0) return { kind: "success" };
  return { kind: "members", members, holdRequired: [] };
}
var WindowsTreeCleanupError = class extends Error {
  code;
  memberPids;
  constructor(code, message, memberPids = []) {
    super(message);
    this.name = "WindowsTreeCleanupError";
    this.code = code;
    this.memberPids = memberPids;
  }
};
async function terminateWindowsProcessTree(pid, expectedRootTicks, killWaitMs, dependencies) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new WindowsTreeCleanupError("process_tree_invalid_pid", `a positive integer PID is required, got: ${String(pid)}`);
  }
  const now = dependencies.now ?? Date.now;
  const sleep4 = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transaction = await dependencies.open();
  const killed = /* @__PURE__ */ new Map();
  const held = /* @__PURE__ */ new Map();
  const naturalGone = /* @__PURE__ */ new Set();
  const naturalGoneCreation = /* @__PURE__ */ new Map();
  const memberReceipts = /* @__PURE__ */ new Map();
  const killReceipts = [];
  const unverifiedCandidates = /* @__PURE__ */ new Set();
  let rounds = 0;
  let bodyError = null;
  let succeeded = false;
  const knownPids = () => [.../* @__PURE__ */ new Set([...memberReceipts.keys(), ...unverifiedCandidates])];
  try {
    const deadline = now() + Math.max(0, killWaitMs);
    for (; ; ) {
      rounds += 1;
      const rows = await transaction.enumerate();
      const resolution = await resolveRound(rows);
      if (resolution.kind === "refuse") {
        throw new WindowsTreeCleanupError(resolution.code, `${resolution.code}: process tree cleanup refused`, knownPids());
      }
      if (resolution.kind === "success") break;
      const members = resolution.members.map((m) => ({ pid: m.pid, parentPid: m.parentPid, startTicks: m.startTicks, creationFileTime: m.creationFileTime }));
      const livePids = new Set(resolution.members.map((m) => m.pid));
      for (const previous of memberReceipts.keys()) {
        if (!livePids.has(previous) && !killed.has(previous) && !naturalGone.has(previous)) {
          naturalGone.add(previous);
          naturalGoneCreation.set(previous, memberReceipts.get(previous).creationFileTime);
        }
      }
      for (const member of members) {
        unverifiedCandidates.delete(member.pid);
        if (!memberReceipts.has(member.pid)) {
          memberReceipts.set(member.pid, { pid: member.pid, fingerprint: member.startTicks, creationFileTime: member.creationFileTime });
        }
      }
      const ordered = orderChildrenFirst(members);
      const remaining = Math.max(120, deadline - now());
      const perMemberWait = Math.min(2e3, Math.max(120, Math.floor(remaining / Math.max(1, ordered.length))));
      for (const member of ordered) {
        const heldInfo = held.get(member.pid);
        const kill = await transaction.kill(member.pid, member.startTicks, perMemberWait);
        killReceipts.push({ pid: member.pid, status: kill.status, exitFileTime: kill.exitFileTime });
        if (kill.status === "signaled" || kill.status === "already_exited") {
          killed.set(member.pid, {
            pid: member.pid,
            creationFileTime: heldInfo?.creationFileTime ?? member.creationFileTime,
            exitFileTime: kill.exitFileTime
          });
        } else if (kill.status === "identity_changed" || kill.status === "not_held") {
          naturalGone.add(member.pid);
          naturalGoneCreation.set(member.pid, member.creationFileTime);
        }
      }
      const unconfirmedMembers = members.filter((m) => {
        const record2 = killed.get(m.pid);
        return record2 === void 0 || record2.exitFileTime === null;
      });
      if (now() >= deadline && unconfirmedMembers.length > 0) {
        throw new WindowsTreeCleanupError(
          "process_tree_cleanup_unverified",
          `process_tree_cleanup_unverified: ${String(unconfirmedMembers.length)} recorded member(s) not provably exited`,
          knownPids()
        );
      }
      await sleep4(20);
    }
    succeeded = true;
    return {
      rootPid: pid,
      rounds,
      members: [...memberReceipts.values()],
      kills: killReceipts,
      signaled: killReceipts.filter((k) => k.status === "signaled").map((k) => k.pid)
    };
  } catch (error) {
    bodyError = error;
    if (error instanceof WindowsTreeCleanupError) {
      throw error.memberPids.length > 0 ? error : new WindowsTreeCleanupError(error.code, error.message, knownPids());
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WindowsTreeCleanupError("process_tree_transaction_error", `process_tree_transaction_error: ${detail}`, knownPids());
  } finally {
    let closeError = null;
    try {
      await transaction.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== null) {
      const closeText = closeError instanceof Error ? closeError.message : String(closeError);
      if (bodyError !== null) {
        const original = bodyError instanceof WindowsTreeCleanupError ? new WindowsTreeCleanupError(bodyError.code, `${bodyError.message}; process_tree_close_failed: ${closeText}`, bodyError.memberPids.length > 0 ? bodyError.memberPids : knownPids()) : new WindowsTreeCleanupError("process_tree_transaction_error", `process_tree_transaction_error: ${String(bodyError instanceof Error ? bodyError.message : bodyError)}; process_tree_close_failed: ${closeText}`, knownPids());
        throw original;
      }
      throw new WindowsTreeCleanupError("process_tree_close_failed", `process_tree_close_failed: ${closeText}`, knownPids());
    }
  }
  async function resolveRound(rows) {
    let workingRows = [...rows];
    const resolve = () => resolveWindowsTreeMembership({
      rows: workingRows,
      rootPid: pid,
      expectedRootTicks,
      held,
      killed,
      naturalGonePids: naturalGone,
      naturalGoneCreation
    });
    let resolution = resolve();
    for (let attempt = 0; attempt < 6 && resolution.kind === "members" && resolution.holdRequired.length > 0; attempt += 1) {
      const requested = [...new Set(resolution.holdRequired)];
      for (const candidate of resolution.holdRequired) unverifiedCandidates.add(candidate);
      const outcomes = await transaction.hold(requested);
      if (outcomes.length !== requested.length) {
        throw new WindowsTreeCleanupError(
          "process_tree_hold_invalid",
          `process_tree_hold_invalid: ${String(outcomes.length)} responses for ${String(requested.length)} requested pids`,
          knownPids()
        );
      }
      const seen = /* @__PURE__ */ new Set();
      for (const outcome of outcomes) {
        if (seen.has(outcome.pid)) {
          throw new WindowsTreeCleanupError("process_tree_hold_invalid", `process_tree_hold_invalid: duplicate response for pid ${String(outcome.pid)}`, knownPids());
        }
        seen.add(outcome.pid);
        if (!requested.includes(outcome.pid)) {
          throw new WindowsTreeCleanupError("process_tree_hold_invalid", `process_tree_hold_invalid: unexpected pid ${String(outcome.pid)} in hold response`, knownPids());
        }
        if (outcome.status === "ok") {
          held.set(outcome.pid, { pid: outcome.pid, creationFileTime: outcome.creationFileTime, creationTicks: outcome.creationTicks });
        } else if (outcome.status === "absent") {
          throw new WindowsTreeCleanupError(
            "process_tree_candidate_absent",
            `process_tree_candidate_absent: candidate pid ${String(outcome.pid)} vanished between enumeration and hold; its subtree cannot be attributed`,
            [.../* @__PURE__ */ new Set([...requested, ...knownPids()])]
          );
        }
      }
      resolution = resolve();
    }
    if (resolution.kind === "members" && resolution.holdRequired.length > 0) {
      for (const candidate of resolution.holdRequired) unverifiedCandidates.add(candidate);
      const roundMemberPids = resolution.members.map((m) => m.pid);
      throw new WindowsTreeCleanupError(
        "process_tree_hold_unresolved",
        `process_tree_hold_unresolved: cannot prove identity/ownership for pids ${resolution.holdRequired.join(",")}`,
        [.../* @__PURE__ */ new Set([...roundMemberPids, ...knownPids()])]
      );
    }
    return resolution;
  }
}
function orderChildrenFirst(members) {
  const remaining = [...members];
  const ordered = [];
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const member = remaining[index];
      const hasPendingChild = remaining.some((other) => other !== member && other.parentPid === member.pid);
      if (!hasPendingChild) {
        ordered.push(member);
        remaining.splice(index, 1);
        progress = true;
      }
    }
  }
  const leftovers = remaining.sort((a, b) => BigInt(a.creationFileTime) > BigInt(b.creationFileTime) ? -1 : 1);
  return [...ordered, ...leftovers];
}
async function verifyWindowsRecordedTreeClaimants(targets, dependencies) {
  const transaction = await dependencies.open();
  let bodyError = null;
  const targetPids = targets.map((t) => t.pid).filter((p) => Number.isInteger(p) && p > 0);
  const claimantPids = /* @__PURE__ */ new Set();
  const foreignHeld = /* @__PURE__ */ new Map();
  const unattributableLineagePids = /* @__PURE__ */ new Set();
  const edgeVerifiedForeignPids = /* @__PURE__ */ new Set();
  const requestedPids = /* @__PURE__ */ new Set();
  const evidencePids = () => [
    .../* @__PURE__ */ new Set([...targetPids, ...claimantPids, ...[...requestedPids].filter((pid) => !foreignHeld.has(pid))])
  ];
  const DECIMAL = /^\d{1,25}$/u;
  const holdOneValidated = async (pid) => {
    requestedPids.add(pid);
    const outcomes = await transaction.hold([pid]);
    if (outcomes.length !== 1) {
      throw new WindowsTreeCleanupError(
        "process_tree_hold_invalid",
        `process_tree_hold_invalid: ${String(outcomes.length)} responses for 1 requested pid`,
        evidencePids()
      );
    }
    const outcome = outcomes[0];
    if (outcome === void 0 || outcome.pid !== pid) {
      throw new WindowsTreeCleanupError(
        "process_tree_hold_invalid",
        `process_tree_hold_invalid: unexpected pid ${String(outcome?.pid ?? "missing")} in hold response`,
        evidencePids()
      );
    }
    if (outcome.status === "ok") {
      if (typeof outcome.creationFileTime !== "string" || !DECIMAL.test(outcome.creationFileTime) || typeof outcome.creationTicks !== "string" || !DECIMAL.test(outcome.creationTicks)) {
        throw new WindowsTreeCleanupError(
          "process_tree_hold_invalid",
          `process_tree_hold_invalid: ok hold response for pid ${String(pid)} lacks usable exact identity fields`,
          evidencePids()
        );
      }
      return { status: "ok", creationFileTime: outcome.creationFileTime, creationTicks: outcome.creationTicks };
    }
    return { status: outcome.status };
  };
  try {
    const rows = await transaction.enumerate();
    const live = /* @__PURE__ */ new Set();
    for (const row of rows) live.add(row.pid);
    const rowsByPid = /* @__PURE__ */ new Map();
    for (const row of rows) {
      if (!rowsByPid.has(row.pid)) rowsByPid.set(row.pid, row);
    }
    const recorded = /* @__PURE__ */ new Set();
    for (const target of targets) {
      if (!Number.isInteger(target.pid) || target.pid <= 0) continue;
      recorded.add(target.pid);
      if (!live.has(target.pid)) continue;
      if (target.fingerprint === null) {
        claimantPids.add(target.pid);
        continue;
      }
      const outcome = await holdOneValidated(target.pid);
      if (outcome.status === "ok") {
        if (outcome.creationTicks === target.fingerprint) claimantPids.add(target.pid);
        else {
          const row = rowsByPid.get(target.pid);
          if (row !== void 0 && row.startTicks !== null && row.creationFileTime !== null && outcome.creationTicks === row.startTicks && withinCimInterval(outcome.creationFileTime, row.creationFileTime)) {
            foreignHeld.set(target.pid, { exact: outcome.creationFileTime });
          } else {
            claimantPids.add(target.pid);
          }
        }
      } else if (outcome.status === "absent") {
        live.delete(target.pid);
      } else {
        claimantPids.add(target.pid);
      }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const row of rows) {
        if (claimantPids.has(row.pid)) continue;
        if (claimantPids.has(row.parentPid) || unattributableLineagePids.has(row.parentPid) || recorded.has(row.parentPid) && !live.has(row.parentPid) && !foreignHeld.has(row.parentPid)) {
          claimantPids.add(row.pid);
          changed = true;
        }
      }
      for (const row of rows) {
        if (claimantPids.has(row.pid) || unattributableLineagePids.has(row.pid) || edgeVerifiedForeignPids.has(row.pid)) continue;
        const foreignParent = foreignHeld.get(row.parentPid);
        if (foreignParent === void 0) continue;
        if (row.creationFileTime === null || BigInt(row.creationFileTime) <= BigInt(foreignParent.exact)) {
          claimantPids.add(row.pid);
          foreignHeld.delete(row.pid);
          edgeVerifiedForeignPids.delete(row.pid);
          changed = true;
          continue;
        }
        if (foreignHeld.has(row.pid)) {
          edgeVerifiedForeignPids.add(row.pid);
          changed = true;
          continue;
        }
        const outcome = await holdOneValidated(row.pid);
        if (outcome.status === "absent") {
          unattributableLineagePids.add(row.pid);
        } else if (outcome.status === "ok" && row.startTicks !== null && outcome.creationTicks === row.startTicks && withinCimInterval(outcome.creationFileTime, row.creationFileTime)) {
          foreignHeld.set(row.pid, { exact: outcome.creationFileTime });
          edgeVerifiedForeignPids.add(row.pid);
        } else {
          claimantPids.add(row.pid);
        }
        changed = true;
      }
    }
    const liveList = [...claimantPids].sort((a, b) => a - b);
    return { clean: liveList.length === 0, livePids: liveList, observedPids: evidencePids().sort((a, b) => a - b) };
  } catch (error) {
    bodyError = error;
    if (error instanceof WindowsTreeCleanupError) {
      throw error.memberPids.length > 0 ? error : new WindowsTreeCleanupError(error.code, error.message, evidencePids());
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WindowsTreeCleanupError("process_tree_scan_failed", `process_tree_scan_failed: ${detail}`, evidencePids());
  } finally {
    let closeError = null;
    try {
      await transaction.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== null) {
      const closeText = closeError instanceof Error ? closeError.message : String(closeError);
      if (bodyError !== null) {
        const originalText = bodyError instanceof Error ? bodyError.message : String(bodyError);
        throw new WindowsTreeCleanupError("process_tree_scan_failed", `process_tree_scan_failed: ${originalText}; process_tree_close_failed: ${closeText}`, evidencePids());
      }
      throw new WindowsTreeCleanupError("process_tree_close_failed", `process_tree_close_failed: ${closeText}`, evidencePids());
    }
  }
}
function windowsTreeTransactionScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Runtime.InteropServices;",
    "public static class BridgeTreeTx {",
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint exitCode);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);',
    "  public static readonly Dictionary<int, IntPtr> Held = new Dictionary<int, IntPtr>();",
    "  public static string Hold(int pid) {",
    "    IntPtr existing;",
    '    if (Held.TryGetValue(pid, out existing) && existing != IntPtr.Zero) { return "already_held|"; }',
    "    IntPtr h = OpenProcess(0x00101001u, false, pid);",
    '    if (h == IntPtr.Zero) { int err = Marshal.GetLastWin32Error(); return (err == 87 ? "absent|" : (err == 5 ? "denied|" : "error|")) + err.ToString(); }',
    "    long c, e, k, u;",
    '    if (!GetProcessTimes(h, out c, out e, out k, out u)) { int err = Marshal.GetLastWin32Error(); CloseHandle(h); return "error|" + err.ToString(); }',
    "    Held[pid] = h;",
    '    return "ok|" + c.ToString() + "|" + DateTime.FromFileTime(c).Ticks.ToString();',
    "  }",
    "  public static string Kill(int pid, string expectTicks, int waitMs) {",
    "    IntPtr h;",
    '    if (!Held.TryGetValue(pid, out h) || h == IntPtr.Zero) { return "not_held|"; }',
    "    long c, e, k, u;",
    '    if (!GetProcessTimes(h, out c, out e, out k, out u)) { return "error|" + Marshal.GetLastWin32Error().ToString(); }',
    "    string current = DateTime.FromFileTime(c).Ticks.ToString();",
    '    if (current != expectTicks) { return "identity_changed|" + current; }',
    '    if (e != 0) { return "already_exited|" + e.ToString(); }',
    '    if (!TerminateProcess(h, 1)) { return "error|" + Marshal.GetLastWin32Error().ToString(); }',
    "    uint wait = WaitForSingleObject(h, (uint)waitMs);",
    '    if (!GetProcessTimes(h, out c, out e, out k, out u)) { return "error|" + Marshal.GetLastWin32Error().ToString(); }',
    '    if (wait != 0) { return "wait_timeout|" + e.ToString(); }',
    '    return "signaled|" + e.ToString();',
    "  }",
    "  public static string CloseAll() {",
    "    int closed = 0;",
    "    int failed = 0;",
    "    foreach (KeyValuePair<int, IntPtr> entry in Held) { if (entry.Value != IntPtr.Zero) { if (CloseHandle(entry.Value)) { closed++; } else { failed++; } } }",
    "    Held.Clear();",
    '    return closed.ToString() + "|" + failed.ToString();',
    "  }",
    "}",
    "'@",
    "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { [void][BridgeTreeTx]::CloseAll(); exit 0 }",
    "  $parts = $line.Trim().Split(' ')",
    "  if ($parts[0] -eq 'enum') {",
    "    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "    [Console]::Out.WriteLine('ENUM_BEGIN')",
    "    $ids = @(); foreach ($p in $all) { $ids += [int]$p.ProcessId }",
    "    $byId = @{}",
    "    if ($ids.Count -gt 0) { foreach ($g in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $byId[[int]$g.Id] = $g } }",
    "    foreach ($p in $all) {",
    "      $ticks = 'unknown'",
    "      $cim = 'unknown'",
    "      if ($null -ne $p.CreationDate) { $cim = [string]$p.CreationDate.ToFileTimeUtc() }",
    "      $g = $byId[[int]$p.ProcessId]",
    "      if ($null -ne $g) { try { $st = $g.StartTime; if ($null -ne $st) { $ticks = [string]$st.Ticks } } catch { $ticks = 'unknown' } }",
    "      if ([string]::IsNullOrEmpty($ticks)) { $ticks = 'unknown' }",
    "      [Console]::Out.WriteLine(('R {0} {1} {2} {3}' -f [int]$p.ProcessId, [int]$p.ParentProcessId, $cim, $ticks))",
    "    }",
    "    [Console]::Out.WriteLine('ENUM_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'hold') {",
    "    for ($i = 1; $i -lt $parts.Count; $i++) {",
    "      $hp = 0",
    "      if (-not [int]::TryParse($parts[$i], [ref]$hp)) { [Console]::Out.WriteLine('H 0 error 22'); continue }",
    "      $r = [BridgeTreeTx]::Hold($hp).Split('|')",
    "      if ($r[0] -eq 'already_held') { [Console]::Out.WriteLine(('H {0} held' -f $hp)) }",
    "      elseif ($r[0] -eq 'ok') { [Console]::Out.WriteLine(('H {0} ok {1} {2}' -f $hp, $r[1], $r[2])) }",
    "      else { [Console]::Out.WriteLine(('H {0} {1} {2}' -f $hp, $r[0], $r[1])) }",
    "    }",
    "    [Console]::Out.WriteLine('HOLD_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'kill') {",
    "    $kpid = [int]$parts[1]; $kticks = [string]$parts[2]; $kwait = [int]$parts[3]",
    "    $r = [BridgeTreeTx]::Kill($kpid, $kticks, $kwait).Split('|')",
    "    if ($r[0] -eq 'signaled' -or $r[0] -eq 'already_exited') { [Console]::Out.WriteLine(('K {0} {1} {2}' -f $kpid, $r[0], $r[1])) }",
    "    elseif ($r[0] -eq 'identity_changed') { [Console]::Out.WriteLine(('K {0} identity_changed 0' -f $kpid)) }",
    "    elseif ($r[0] -eq 'wait_timeout') { [Console]::Out.WriteLine(('K {0} wait_timeout {1}' -f $kpid, $r[1])) }",
    "    elseif ($r[0] -eq 'not_held') { [Console]::Out.WriteLine(('K {0} not_held 0' -f $kpid)) }",
    "    else { [Console]::Out.WriteLine(('K {0} error {1}' -f $kpid, $r[1])) }",
    "    [Console]::Out.WriteLine('KILL_END'); [Console]::Out.Flush()",
    "  } elseif ($parts[0] -eq 'close') {",
    "    $r = [BridgeTreeTx]::CloseAll().Split('|')",
    "    [Console]::Out.WriteLine(('CLOSED {0} {1}' -f $r[0], $r[1])); [Console]::Out.Flush()",
    "    exit 0",
    "  } else {",
    "    [Console]::Out.WriteLine('FATAL unknown_command'); [Console]::Out.Flush(); exit 1",
    "  }",
    "}"
  ].join("\n");
}
var TRANSPORT_MAX_LINE_BYTES = 1048576;
var TRANSPORT_MAX_BUFFERED_BYTES = 8388608;
var TRANSPORT_MAX_BUFFERED_LINES = 65536;
var TRANSPORT_MAX_ENUM_ROWS = 4096;
var TRANSPORT_TOTAL_SESSION_MS_DEFAULT = 12e4;
var PowerShellTreeTransaction = class _PowerShellTreeTransaction {
  #child;
  #bounds;
  #lines = [];
  #waiters = [];
  #exitWaiters = [];
  #closed = false;
  #bufferedBytes = 0;
  #sessionDeadline;
  #exitCode = null;
  #exitSignal = null;
  /** True once the helper's own exit is expected (receipt processed or
   * fallback initiated); its close event is then not a transport failure. */
  #closeHandled = false;
  #failure = null;
  /** Test seam: attach to an externally spawned/controlled child so the
   * bounded-stream behaviours are testable with fake streams (no OS). */
  static attach(child, bounds = {}) {
    return new _PowerShellTreeTransaction(child, bounds);
  }
  constructor(child, bounds = {}) {
    this.#child = child;
    this.#bounds = {
      maxLineBytes: bounds.maxLineBytes ?? TRANSPORT_MAX_LINE_BYTES,
      maxBufferedBytes: bounds.maxBufferedBytes ?? TRANSPORT_MAX_BUFFERED_BYTES,
      maxBufferedLines: bounds.maxBufferedLines ?? TRANSPORT_MAX_BUFFERED_LINES,
      maxEnumRows: bounds.maxEnumRows ?? TRANSPORT_MAX_ENUM_ROWS,
      totalSessionMs: bounds.totalSessionMs ?? TRANSPORT_TOTAL_SESSION_MS_DEFAULT
    };
    this.#sessionDeadline = Date.now() + this.#bounds.totalSessionMs;
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      if (this.#failure) {
        buffer = "";
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > this.#bounds.maxLineBytes) {
          this.#failAndDrain();
          this.#fail(new Error(`process_tree_transport_overflow: line of ${String(lineBytes)} bytes exceeds ${String(this.#bounds.maxLineBytes)}`));
          return;
        }
        this.#bufferedBytes += lineBytes;
        if (this.#bufferedBytes > this.#bounds.maxBufferedBytes || this.#lines.length >= this.#bounds.maxBufferedLines) {
          this.#failAndDrain();
          this.#fail(new Error(`process_tree_transport_overflow: buffered stream exceeded its byte or line budget (${String(this.#bufferedBytes)} bytes, ${String(this.#lines.length)} lines)`));
          return;
        }
        const waiter = this.#waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(line);
          this.#bufferedBytes -= lineBytes;
        } else {
          this.#lines.push(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > this.#bounds.maxLineBytes) {
        this.#failAndDrain();
        this.#fail(new Error(`process_tree_transport_overflow: unterminated line exceeds ${String(this.#bounds.maxLineBytes)} bytes`));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      void chunk;
      this.#fail(new Error("process_tree_transport_stderr"));
    });
    child.on("error", (error) => this.#fail(new Error(`process_tree_transport_error: ${String(error.message)}`)));
    child.on("close", (code, signal) => {
      this.#closed = true;
      this.#exitCode = code;
      this.#exitSignal = signal;
      if (!this.#closeHandled) this.#fail(new Error("process_tree_transport_closed"));
      for (const waiter of this.#exitWaiters.splice(0)) waiter();
    });
  }
  /** Clears buffered receive state; used when a budget trips so a failed
   * transport neither accumulates nor serves stale lines afterwards. */
  #failAndDrain() {
    for (const line of this.#lines) this.#bufferedBytes -= Buffer.byteLength(line, "utf8");
    this.#lines = [];
  }
  #fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
  #nextLine(timeoutMs, what) {
    if (this.#failure) return Promise.reject(this.#failure);
    const remainingSession = this.#sessionDeadline - Date.now();
    if (remainingSession <= 0) {
      const error = new Error(`process_tree_transport_session_timeout: ${what}`);
      this.#failAndDrain();
      this.#fail(error);
      return Promise.reject(error);
    }
    const buffered = this.#lines.shift();
    if (buffered !== void 0) {
      this.#bufferedBytes -= Buffer.byteLength(buffered, "utf8");
      return Promise.resolve(buffered);
    }
    if (this.#closed) return Promise.reject(new Error("process_tree_transport_closed"));
    const boundedTimeout = Math.min(timeoutMs, remainingSession);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        const reason = remainingSession < timeoutMs ? "process_tree_transport_session_timeout" : "process_tree_transport_timeout";
        reject(new Error(`${reason}: ${what}`));
        this.#fail(new Error(`${reason}: ${what}`));
      }, boundedTimeout);
      if (typeof timer.unref === "function") timer.unref();
      this.#waiters.push({ resolve, reject, timer });
    });
  }
  static async start(timeoutMs = 2e4) {
    const encoded = Buffer.from(windowsTreeTransactionScript(), "utf16le").toString("base64");
    const child = spawn3("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const transaction = _PowerShellTreeTransaction.attach(child);
    try {
      const ready = await transaction.#nextLine(timeoutMs, "helper startup");
      if (ready !== "READY") throw new Error("process_tree_transport_protocol: startup marker missing");
      return transaction;
    } catch (error) {
      transaction.#closeHandled = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      const exited = await transaction.#waitForExit(3e3);
      if (!exited) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; process_tree_close_failed: startup helper did not exit within bounds`);
      }
      throw error;
    }
  }
  async enumerate() {
    this.#child.stdin.write("enum\n");
    const begin = await this.#nextLine(2e4, "enum begin");
    if (begin !== "ENUM_BEGIN") throw new Error("process_tree_snapshot_invalid: protocol missing");
    const rows = [];
    for (; ; ) {
      const line = await this.#nextLine(2e4, "enum row");
      if (line === "ENUM_END") break;
      const match = /^R (\d{1,12}) (\d{1,12}) (\d{1,25}|unknown) (\d{1,25}|unknown)$/u.exec(line);
      if (!match) throw new Error("process_tree_snapshot_invalid: malformed identity");
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
      if (rows.length >= this.#bounds.maxEnumRows) {
        throw new Error(`process_tree_snapshot_invalid: enumeration exceeded ${String(this.#bounds.maxEnumRows)} rows`);
      }
      rows.push({ pid, parentPid, creationFileTime: match[3] === "unknown" ? null : match[3], startTicks: match[4] === "unknown" ? null : match[4] });
    }
    return rows;
  }
  async hold(pids) {
    if (pids.length === 0) return [];
    this.#child.stdin.write(`hold ${pids.join(" ")}
`);
    const outcomes = [];
    for (; ; ) {
      const line = await this.#nextLine(2e4, "hold response");
      if (line === "HOLD_END") break;
      const match = /^H (\d{1,12}) (ok (\d{1,25}) (\d{1,25})|held|absent (\d{1,6})|denied (\d{1,6})|error (\d{1,6}))$/u.exec(line);
      if (!match) throw new Error("process_tree_hold_invalid: malformed response");
      const pid = Number(match[1]);
      if (match[2].startsWith("ok")) {
        outcomes.push({ pid, status: "ok", creationFileTime: match[3], creationTicks: match[4] });
      } else if (match[2] === "held") {
        outcomes.push({ pid, status: "error", detail: "already_held" });
      } else if (match[2].startsWith("absent")) {
        outcomes.push({ pid, status: "absent", error: Number(match[5] ?? 0) });
      } else if (match[2].startsWith("denied")) {
        outcomes.push({ pid, status: "denied", error: Number(match[6] ?? 0) });
      } else {
        outcomes.push({ pid, status: "error", error: Number(match[7] ?? 0) });
      }
    }
    return outcomes;
  }
  async kill(pid, expectedTicks, waitMs) {
    this.#child.stdin.write(`kill ${String(pid)} ${expectedTicks} ${String(Math.max(0, Math.floor(waitMs)))}
`);
    const line = await this.#nextLine(waitMs + 25e3, "kill response");
    const end = await this.#nextLine(5e3, "kill terminator");
    if (end !== "KILL_END") throw new Error("process_tree_kill_invalid: terminator missing");
    const match = /^K (\d{1,12}) (signaled|identity_changed|not_held|wait_timeout|already_exited|error) (\d{1,25})$/u.exec(line);
    if (!match || Number(match[1]) !== pid) throw new Error("process_tree_kill_invalid: malformed response");
    const status = match[2];
    const value = match[3];
    return {
      status,
      exitFileTime: status === "signaled" || status === "already_exited" || status === "wait_timeout" ? value === "0" ? null : value : null,
      detail: status === "identity_changed" ? value : void 0
    };
  }
  async close() {
    let failure = this.#failure;
    if (!failure && !this.#closed) {
      try {
        this.#child.stdin.write("close\n");
        const ack = await this.#nextLine(1e4, "close acknowledgement");
        const match = /^CLOSED (\d{1,9}) (\d{1,9})$/u.exec(ack);
        if (!match) throw new Error(`process_tree_close_invalid: unexpected close receipt ${JSON.stringify(ack.slice(0, 60))}`);
        const failedHandles = Number(match[2]);
        if (failedHandles > 0) throw new Error(`process_tree_close_failed: ${String(failedHandles)} CloseHandle call(s) failed`);
        this.#closeHandled = true;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        this.#closeHandled = true;
      }
    }
    const exited = await this.#waitForExit(5e3);
    if (!exited) {
      this.#closeHandled = true;
      try {
        this.#child.kill("SIGKILL");
      } catch {
      }
      try {
        this.#child.stdin.end();
      } catch {
      }
      const exitedAfterKill = await this.#waitForExit(3e3);
      if (!exitedAfterKill) {
        throw new Error(failure ? `${failure.message}; process_tree_close_failed: helper did not exit within bounds` : "process_tree_close_failed: helper did not exit within bounds");
      }
      throw new Error(failure ? `${failure.message}; process_tree_close_forced: helper exited only after a forced kill` : "process_tree_close_forced: helper exited only after a forced kill");
    }
    if (this.#exitCode !== 0 || this.#exitSignal !== null) {
      const abnormal = `process_tree_close_abnormal: helper exited with code ${String(this.#exitCode)}${this.#exitSignal ? `, signal ${this.#exitSignal}` : ""}`;
      throw new Error(failure ? `${failure.message}; ${abnormal}` : abnormal);
    }
    if (failure) throw failure;
    if (this.#failure) throw this.#failure;
  }
  #waitForExit(timeoutMs) {
    if (this.#closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.#exitWaiters.indexOf(waiter);
        if (index >= 0) this.#exitWaiters.splice(index, 1);
        resolve(value);
      };
      const waiter = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#exitWaiters.push(waiter);
    });
  }
};
async function openPowerShellTreeTransaction() {
  return PowerShellTreeTransaction.start();
}

// src/adapters/process-spawn.ts
function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
var terminateProcessTree = async (pid, options = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`A positive integer PID is required, got: ${pid}`);
  }
  if (process.platform === "win32") {
    const expected = options.expectedRootFingerprint ?? null;
    if (expected === null) {
      throw new Error("process_tree_root_identity_required: Windows process-tree termination requires a caller-bound root identity");
    }
    const receipt = await terminateWindowsProcessTree(pid, expected, options.killWaitMs ?? 2e3, {
      open: openPowerShellTreeTransaction
    });
    return { pid, signal: "SIGKILL", verified: true, windows: receipt };
  }
  signalProcessTree(pid, "SIGTERM");
  if (await waitForProcessTreeExit(pid, options.graceMs ?? 500)) {
    return { pid, signal: "SIGTERM", verified: true };
  }
  signalProcessTree(pid, "SIGKILL");
  if (!await waitForProcessTreeExit(pid, options.killWaitMs ?? 2e3)) {
    throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  }
  return { pid, signal: "SIGKILL", verified: true };
};
async function verifyProcessTreeClaimantsClean(targets) {
  if (process.platform === "win32") {
    return verifyWindowsRecordedTreeClaimants(targets, { open: openPowerShellTreeTransaction });
  }
  const live = targets.filter((t) => Number.isInteger(t.pid) && t.pid > 0 && isProcessTreeRunning(t.pid)).map((t) => t.pid);
  return { clean: live.length === 0, livePids: live, observedPids: live };
}
function signalProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if (inner.code !== "ESRCH") throw inner;
      }
    } else {
      throw error;
    }
  }
}
function isProcessTreeRunning(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return isProcessRunning(pid);
    throw error;
  }
}
async function waitForProcessTreeExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeRunning(pid) && Date.now() < deadline) {
    await sleep(20);
  }
  return !isProcessTreeRunning(pid);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/runtime/task-timeout.ts
var DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1e3;
var MAX_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1e3;
var MIN_TASK_TIMEOUT_MS = 60 * 1e3;
function validateTaskTimeout(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer from ${MIN_TASK_TIMEOUT_MS} to ${MAX_TASK_TIMEOUT_MS}`);
  }
  return value;
}

// src/prompts/task-prompt.ts
var MAX_PROMPT_CHARS = 6e4;
var MAX_SECTION_CHARS = 4e3;
var MAX_CONTEXT_CHARS = 2e3;
function buildTaskPrompt(task) {
  const sections = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent executing one bounded task inside the current working directory. Stay inside the workspace; do not touch files outside it.",
    `PROJECT WORKSPACE: ${task.workspace}`,
    ...task.worktree_path ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}. Make task changes in the current working directory, which is this worktree; the project workspace above identifies its parent project.`] : [],
    ...task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : [],
    ...task.timeout_ms ? [`EXECUTION TIME LIMIT: ${task.timeout_ms} ms for this attempt.`] : [],
    `OBJECTIVE
${task.objective}`,
    renderList("REQUIREMENTS", task.requirements),
    renderPaths("ALLOWED PATHS (write only inside these when provided)", task.allowed_paths),
    renderPaths("FORBIDDEN PATHS (never create, modify, or delete)", task.forbidden_paths),
    renderList(
      "ACCEPTANCE CRITERIA (the master verifies these independently; do not self-certify)",
      task.acceptance_criteria
    ),
    renderList(
      "TEST COMMANDS (run the applicable ones and report a status for each)",
      task.test_commands
    ),
    DECISION_RULE
  ];
  if (task.context && task.context.trim().length > 0) {
    sections.push(`CONTEXT
${bounded(task.context, MAX_CONTEXT_CHARS)}`);
  }
  return joinBoundedPreservingTail([...sections, OUTPUT_CONTRACT], OUTPUT_CONTRACT);
}
function buildContinuePrompt(input) {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  const sections = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent continuing a previous task in the same workspace. Stay inside the workspace.",
    ...task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []
  ];
  if (previousSessionId) {
    sections.push(
      `This run resumes persisted session ${previousSessionId}; earlier conversation context may be available.`
    );
  }
  if (previousResult?.error_code === "invalid_agent_report") {
    sections.push(
      "REPORT REPAIR MODE: The previous execution has ended. Only its final report failed validation. Do not use tools, edit files, rerun tests, or repeat task work. Return the corrected JSON report from the evidence below. Preserve claims as claims, including not_run and failures. Do not invent tests or missing facts. If needs_master_decision cannot be established, explicitly set it to true and record the uncertainty in issues.",
      `PROJECT WORKSPACE: ${task.workspace}`,
      ...task.worktree_path ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}`] : [],
      `PREVIOUS REPORT ERROR
${previousResult.summary}`,
      `REPORT CANDIDATE CLAIMS (not independently verified)
${JSON.stringify(previousResult.report_candidate ?? {}, null, 2)}`,
      `PREVIOUS RESPONSE
${bounded(previousResult.zcode_output, MAX_SECTION_CHARS)}`,
      `MASTER FEEDBACK (report repair only)
${feedback}`,
      ...additionalRequirements.length ? [renderList("ADDITIONAL REPORT REQUIREMENTS", [...additionalRequirements])] : [],
      OUTPUT_CONTRACT
    );
    return joinBoundedPreservingTail(sections, OUTPUT_CONTRACT);
  }
  if (previousResult) {
    sections.push(
      `PREVIOUS RESULT (normalized claims from the previous attempt)
${bounded(
        JSON.stringify(previousResult, null, 2),
        MAX_SECTION_CHARS
      )}`
    );
  }
  sections.push(`MASTER FEEDBACK (address every point)
${feedback}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(`ORIGINAL TASK
${buildTaskPrompt(task)}`);
  return joinBoundedPreservingTail(sections, OUTPUT_CONTRACT);
}
var OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT (mandatory)",
  "Your final response must be exactly one JSON object with no markdown fences and no text before or after it.",
  'Required fields: summary (non-empty string), files_changed (array of strings), tests (array of objects with command string, status "passed" | "failed" | "not_run", optional details string), issues (array of strings), needs_master_decision (JSON boolean).',
  'Valid JSON example (replace example values with observed facts): {"summary":"Describe the actual work","files_changed":[],"tests":[{"command":"An applicable command","status":"not_run","details":"Explain why it was not run"}],"issues":[],"needs_master_decision":true}',
  "List every file you created or modified in files_changed (workspace-relative paths). Give one tests entry per applicable test command; use status not_run when a command was not applicable or could not run. Record problems in issues. Set needs_master_decision=true only when a required decision is outside your authority; never guess.",
  "Before sending, check that all five top-level fields exist and needs_master_decision is a JSON boolean true or false, never a quoted string and never text such as needs_master_decision=false. If its value is uncertain, set true and explain in issues. Do not omit it."
].join("\n");
var DECISION_RULE = [
  "DECISION RULE",
  "Use only this task package, this prompt, repository files you inspect, and available tools; do not assume access to the calling host's conversation.",
  "Do not choose unresolved items explicitly listed under OPEN DECISIONS; a later explicit Master Feedback decision resolves that item. Also escalate conflicting requirements or missing decisions that would materially change externally visible behavior, even when the calling host did not list them. Record the exact question in issues and set needs_master_decision=true. Continue independent work that does not depend on the decision. For low-impact implementation choices, use the simplest consistent option and state the assumption in issues."
].join("\n");
function renderList(title, items) {
  if (items.length === 0) {
    return `${title}
- (none)`;
  }
  return `${title}
${items.map((item) => `- ${item}`).join("\n")}`;
}
function renderPaths(title, paths) {
  if (paths.length === 0) {
    return `${title}
- (unspecified; still write only within the workspace)`;
  }
  return `${title}
${paths.map((item) => `- ${item}`).join("\n")}`;
}
function bounded(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\u2026[truncated]`;
}
function joinBoundedPreservingTail(sections, requiredTail) {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  void requiredTail;
  throw new Error(`task prompt exceeds ${MAX_PROMPT_CHARS} characters; shorten the task package without dropping constraints`);
}

// src/observation/types.ts
var OBSERVATION_SCHEMA_VERSION = 1;
var DEFAULT_JUDGE_OPTIONS = {
  start_grace_ms: 1e4,
  heartbeat_fresh_ms: 15e3,
  stall_hint_ms: 12e4,
  clock_jump_guard_ms: 12e4
};
function judgeOptionsWith(overrides) {
  const merged = { ...DEFAULT_JUDGE_OPTIONS };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== void 0) merged[key] = value;
    }
  }
  return merged;
}

// src/observation/judge.ts
function ageMs(now, iso, guardMs) {
  if (!iso) return { value: null, skewed: false };
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return { value: null, skewed: false };
  const age = now - parsed;
  if (age < -guardMs) return { value: null, skewed: true };
  return { value: Math.max(0, age), skewed: false };
}
function clampReason(reason) {
  return reason.slice(0, 80);
}
function judgeTaskObservation(input) {
  const options = judgeOptionsWith(input.options);
  const now = input.now_ms;
  const observedAt = new Date(now).toISOString();
  const status = input.status;
  const terminal = status.status === "completed" || status.status === "failed" || status.status === "cancelled" || status.status === "waiting_for_master";
  const heartbeat = input.heartbeat && input.heartbeat.attempt === status.attempt && (status.worker_pid === null || input.heartbeat.worker_pid === status.worker_pid) ? input.heartbeat : null;
  const heartbeatAge = ageMs(now, heartbeat?.heartbeat_at, options.clock_jump_guard_ms);
  const heartbeatFresh = heartbeat !== null && heartbeatAge.value !== null && heartbeatAge.value <= options.heartbeat_fresh_ms;
  const committed = input.result !== null && input.result.attempt === status.attempt && terminal;
  const result = committed ? "committed" : input.checkpoint ? "checkpointed" : "absent";
  const cleanup = status.cleanup_unverified === true ? "unverified" : committed ? "verified" : terminal || status.status === "running" ? "pending" : "not_started";
  let worker;
  if (input.probe_worker) {
    worker = { state: input.probe_worker.state, reason_code: clampReason(input.probe_worker.reason_code), observed_at: input.probe_worker.observed_at };
  } else if (heartbeatFresh && !heartbeatAge.skewed) {
    worker = { state: "alive", reason_code: "heartbeat_fresh", observed_at: observedAt };
  } else if (heartbeatAge.skewed) {
    worker = { state: "unknown", reason_code: "clock_skew", observed_at: observedAt };
  } else {
    worker = { state: "unknown", reason_code: heartbeat ? "heartbeat_stale" : "no_heartbeat_evidence", observed_at: observedAt };
  }
  let runtime;
  const runtimePid = status.zcode_pid ?? null;
  if (input.probe_runtime) {
    runtime = { state: input.probe_runtime.state, reason_code: clampReason(input.probe_runtime.reason_code), observed_at: input.probe_runtime.observed_at };
  } else if (runtimePid === null) {
    runtime = { state: "unknown", reason_code: "runtime_pid_not_reported", observed_at: observedAt };
  } else {
    runtime = { state: "unknown", reason_code: "persisted_pid_no_probe", observed_at: observedAt };
  }
  let activity = "unknown";
  let activityReason = "no_activity_evidence";
  if (terminal || committed) {
    activity = "finalizing";
    activityReason = "task_terminal";
  } else if (status.status === "queued") {
    activity = "starting";
    activityReason = "queued_not_dispatched";
  } else if (input.pending_interaction) {
    activity = input.pending_interaction.method === "interaction/requestPermission" ? "waiting_for_permission" : "waiting_for_user";
    activityReason = "pending_interaction_request";
  } else {
    const startAge = ageMs(now, status.started_at, options.clock_jump_guard_ms).value;
    const eventAge = ageMs(now, input.last_business_event?.at, options.clock_jump_guard_ms).value;
    const withinStartGrace = startAge !== null && startAge < options.start_grace_ms;
    if (heartbeatFresh) {
      if (eventAge === null) {
        activity = withinStartGrace ? "starting" : "unknown";
        activityReason = "heartbeat_alive_no_business_event";
      } else if (eventAge > options.stall_hint_ms) {
        activity = "stalled";
        activityReason = "heartbeat_alive_business_events_stale";
      } else {
        activity = "executing";
        activityReason = "heartbeat_and_events_fresh";
      }
    } else if (withinStartGrace) {
      activity = "starting";
      activityReason = "within_worker_start_grace";
    } else if (worker.state === "unknown") {
      activity = "unknown";
      activityReason = worker.reason_code;
    } else {
      activity = "executing";
      activityReason = "executor_alive_no_fresh_heartbeat";
    }
  }
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    worker,
    runtime,
    activity: { code: activity, reason_code: clampReason(activityReason), observed_at: observedAt },
    result,
    cleanup,
    stalled: activity === "stalled",
    evidence: {
      heartbeat_age_ms: heartbeatAge.skewed ? null : heartbeatAge.value,
      last_event_age_ms: input.last_business_event ? ageMs(now, input.last_business_event.at, options.clock_jump_guard_ms).value : null,
      last_event_seq: heartbeat?.last_event_seq ?? input.last_business_event?.seq ?? null,
      last_event_type: heartbeat?.last_event_type ?? input.last_business_event?.type ?? null,
      session_id: heartbeat?.session_id ?? status.zcode_session_id ?? null,
      turn_id: heartbeat?.turn_id ?? null,
      attempt: status.attempt,
      status_updated_at: status.updated_at ?? null
    }
  };
}

// src/observation/build.ts
var PROBE_RECORD_MAX_AGE_MS = 6e4;
function buildTaskObservation(store, taskId2, status, options = {}) {
  const now = (options.now ?? (() => /* @__PURE__ */ new Date()))().getTime();
  const evidence = store.readObservationEvidence(taskId2, status.attempt);
  let probeWorker = null;
  let probeRuntime = null;
  const probes = options.probes;
  if (probes && probes.task_id === taskId2 && probes.attempt === status.attempt) {
    const probedAt = Date.parse(probes.probed_at);
    if (Number.isFinite(probedAt) && now - probedAt >= 0 && now - probedAt <= PROBE_RECORD_MAX_AGE_MS) {
      const pidMatch = (recorded, current) => recorded === null || current === null || recorded === current;
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
      updated_at: status.updated_at
    },
    result: store.readResult(taskId2),
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
      stall_hint_ms: options.stallHintMs
    })
  });
}

// src/observation/diagnostics.ts
function boundedErrorMessage(message, maxChars = 500) {
  const text = message instanceof Error ? message.message : String(message ?? "");
  return text.replace(/[\r\n\0\t]/gu, " ").slice(0, maxChars);
}
var MAX_COUNTER_KEYS = 64;
var MAX_LATENCY_SAMPLES = 64;
var DiagnosticCounters = class {
  #counters = /* @__PURE__ */ new Map();
  #latency = [];
  #now;
  constructor(now = Date.now) {
    this.#now = now;
  }
  record(reason, detail = "") {
    const key = `${reason}${detail ? `:${detail}` : ""}`.slice(0, 160);
    let entry = this.#counters.get(key);
    if (!entry) {
      if (this.#counters.size >= MAX_COUNTER_KEYS) {
        const oldest = this.#counters.keys().next().value;
        if (oldest !== void 0) this.#counters.delete(oldest);
      }
      entry = { count: 0, last_seen_at: new Date(this.#now()).toISOString(), last_reason: reason };
      this.#counters.set(key, entry);
    }
    entry.count += 1;
    entry.last_seen_at = new Date(this.#now()).toISOString();
    entry.last_reason = reason;
    return { count: entry.count, last_seen_at: entry.last_seen_at };
  }
  /** Throttle decision: emit a persistent event on the first occurrence and
   * then every `every`th occurrence, always carrying the cumulative count. */
  shouldEmit(reason, detail = "", every = 10) {
    const key = `${reason}${detail ? `:${detail}` : ""}`.slice(0, 160);
    const entry = this.#counters.get(key);
    if (!entry) return true;
    return entry.count === 1 || entry.count % every === 0;
  }
  recordLatency(ms) {
    if (!Number.isFinite(ms)) return;
    this.#latency.push(ms);
    if (this.#latency.length > MAX_LATENCY_SAMPLES) this.#latency.shift();
  }
  latencySummary() {
    if (this.#latency.length === 0) return { samples: 0, p50_ms: null, p95_ms: null, max_ms: null };
    const sorted = [...this.#latency].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
    return { samples: sorted.length, p50_ms: percentile(50), p95_ms: percentile(95), max_ms: sorted[sorted.length - 1] };
  }
  snapshot() {
    const result = {};
    for (const [key, entry] of this.#counters) {
      result[key] = { count: entry.count, last_seen_at: entry.last_seen_at, reason: entry.last_reason };
    }
    return result;
  }
};

// src/feedback/task-feedback.ts
var EMPTY_INTERACTION = { state: "not_observed", kind: null };
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function safeRuntimeText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return text ? text.slice(0, 160) : null;
}
function safeToolName(value) {
  if (typeof value !== "string") return "tool";
  const name = value.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80);
  return name || "tool";
}
function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return finish - start;
}
function buildTaskFeedbackSnapshotV01(input) {
  let model = null;
  let activity = null;
  let agentReportReady = false;
  for (const event of input.events) {
    const details = record(event.details);
    if (event.type === "model_selected" && details) {
      const providerId = safeRuntimeText(details["provider_id"]);
      const modelId = safeRuntimeText(details["model_id"]);
      if (providerId && modelId) {
        model = {
          provider_id: providerId,
          model_id: modelId,
          reasoning_level: details["reasoning_level_source"] === "runtime" ? safeRuntimeText(details["reasoning_level"]) : null,
          source: "runtime"
        };
      }
    } else if (event.type === "model_tool_call" && details) {
      activity = {
        kind: "tool_call",
        summary: `Tool request \xB7 ${safeToolName(details["tool_name"])}`,
        observed_at: event.at,
        currentness: "last_observed"
      };
    } else if (event.type === "tool_status" && details) {
      activity = {
        kind: "tool_update",
        // The normalized update state has not been validated as a current
        // running/completed state; deliberately render only the observation.
        summary: `Tool update \xB7 ${safeToolName(details["tool_name"])}`,
        observed_at: event.at,
        currentness: "last_observed"
      };
    } else if (event.type === "report_ready") {
      agentReportReady = true;
    }
  }
  const finalResult = input.result;
  const result = agentReportReady && finalResult && finalResult.attempt === input.status.attempt && finalResult.status === input.status.status && (finalResult.status === "completed" || finalResult.status === "waiting_for_master") ? {
    source: "agent_report",
    summary: finalResult.summary,
    issues: [...finalResult.issues],
    files_changed: [...finalResult.files_changed],
    tests: finalResult.tests.map((test) => ({ ...test })),
    started_at: input.status.started_at,
    finished_at: input.status.finished_at,
    duration_ms: durationMs(input.status.started_at, input.status.finished_at)
  } : null;
  return {
    schema_version: "0.1",
    task_id: input.status.task_id,
    attempt: input.status.attempt,
    status: input.status.status,
    model,
    phase: null,
    progress: null,
    activity,
    interaction: { ...EMPTY_INTERACTION },
    result
  };
}

// src/manager/task-manager.ts
var BridgeTaskManager = class _BridgeTaskManager {
  /** How long a respawn claim counts as in-flight across Bridge processes. */
  static RESPAWN_IN_FLIGHT_MS = 1e4;
  #store;
  #workspaceProvider;
  #spawnWorker;
  #isProcessRunning;
  #terminateProcessTree;
  #verifyTreeClean;
  #probe;
  #now;
  #dataRoot;
  #maxConcurrentWorkers;
  #workerStartGraceMs;
  #stallHintMs;
  #recoveryCooldownMs;
  #counters = new DiagnosticCounters();
  #timer = null;
  #mutex = Promise.resolve();
  #queuedOperations = 0;
  #recoveryPromise = null;
  constructor(options) {
    this.#store = options.store;
    this.#workspaceProvider = options.workspaceProvider;
    this.#spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.#isProcessRunning = options.isProcessRunning ?? isProcessRunning;
    this.#terminateProcessTree = options.terminateProcessTree ?? terminateProcessTree;
    this.#verifyTreeClean = options.verifyTreeClean ?? verifyProcessTreeClaimantsClean;
    this.#probe = options.probe ?? null;
    this.#now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.#dataRoot = options.store.dataRoot;
    this.#maxConcurrentWorkers = options.maxConcurrentWorkers ?? 8;
    if (!Number.isInteger(this.#maxConcurrentWorkers) || this.#maxConcurrentWorkers < 1 || this.#maxConcurrentWorkers > 8) {
      throw new RangeError("maxConcurrentWorkers must be an integer from 1 to 8");
    }
    this.#workerStartGraceMs = options.workerStartGraceMs ?? 1e4;
    if (!Number.isInteger(this.#workerStartGraceMs) || this.#workerStartGraceMs < 0) {
      throw new RangeError("workerStartGraceMs must be a non-negative integer");
    }
    this.#stallHintMs = options.stallHintMs ?? 12e4;
    const pollIntervalMs = options.pollIntervalMs ?? 1e3;
    this.#recoveryCooldownMs = pollIntervalMs;
    if (pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.recoverTasks().catch((error) => {
          const reason = boundedErrorMessage(error);
          const occurrence = this.#counters.record("recovery_loop_error", reason);
          if (this.#counters.shouldEmit("recovery_loop_error", reason, 60)) {
            console.error(`Bridge recovery failed: ${reason} (occurrence ${occurrence.count})`);
          }
        });
      }, pollIntervalMs);
      this.#timer.unref();
    }
    const probe = this.#probe;
    if (probe) {
      void probe.selfIdentity().then(
        (identity) => publishSelfIdentity(identity),
        () => void 0
      );
    }
  }
  /** Bounded live diagnostics (counters + lock latency), for doctor/ops tooling. */
  diagnostics() {
    return { counters: this.#counters.snapshot(), lock_wait: this.#counters.latencySummary() };
  }
  /** Stops the reconcile timer; safe to call repeatedly. */
  dispose() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
  /** Scans all non-terminal tasks and reconciles them, then pumps the queue.
   * Per the A2 three-phase design, OS probes run OUTSIDE the manager mutex:
   * snapshot → async probe → re-verify and commit. One task's failure never
   * blocks the others. */
  async recoverTasks() {
    if (this.#recoveryPromise) return this.#recoveryPromise;
    const releaseRecovery = tryAcquireProcessLock(path5.join(this.#store.tasksRoot, ".recovery.lock"));
    if (!releaseRecovery) return;
    const lastRunFile = path5.join(this.#store.tasksRoot, ".recovery-last-run");
    if (this.#recoveryCooldownMs > 0 && existsSync3(lastRunFile) && Date.now() - statSync3(lastRunFile).mtimeMs < this.#recoveryCooldownMs) {
      releaseRecovery();
      return;
    }
    const run = (async () => {
      for (const taskId2 of this.#store.listTaskIds()) {
        try {
          const status = this.#safeStatus(taskId2);
          if (!status) continue;
          if (status.status === "running") {
            await this.#reconcileRunningThreePhase(taskId2, status);
          } else if (isTerminalStatus(status.status) && status.cleanup_unverified === true) {
            await this.#reconcileTerminalCleanup(taskId2, status);
          }
        } catch (error) {
          const reason = this.#counters.record("reconcile_error", taskId2);
          if (this.#counters.shouldEmit("reconcile_error", taskId2)) {
            console.error(`Bridge could not reconcile task ${taskId2}: ${boundedErrorMessage(error)} (occurrence ${reason.count})`);
          }
        }
      }
      await this.#exclusive(async () => {
        this.#pumpLocked();
      });
    })();
    this.#recoveryPromise = run;
    try {
      await run;
    } finally {
      try {
        if (this.#recoveryCooldownMs > 0) {
          writeFileSync3(lastRunFile, String(Date.now()), { mode: 384 });
        }
      } finally {
        try {
          releaseRecovery();
        } finally {
          this.#recoveryPromise = null;
        }
      }
    }
  }
  /** Releases terminal-task occupancy only after the persisted executor exits
   * are independently confirmed. A probe never signals or retries the task. */
  async #reconcileTerminalCleanup(taskId2, status) {
    const identity = this.#store.readExecutorIdentity(taskId2, status.attempt);
    const started = this.#store.readAttemptMeta(taskId2, status.attempt, "started.json");
    const snapshot = {
      attempt: status.attempt,
      status_worker_pid: status.worker_pid,
      // A terminal status clears worker_pid before the worker process itself
      // has necessarily exited. Retain its attempt identity as exit evidence.
      worker_pid: status.worker_pid ?? identity?.worker?.pid ?? started?.worker_pid ?? null,
      zcode_pid: status.zcode_pid ?? null,
      identity
    };
    if (snapshot.worker_pid === null && snapshot.zcode_pid === null) {
      const occurrence = this.#counters.record("terminal_cleanup_unverifiable", "missing_pid");
      if (this.#counters.shouldEmit("terminal_cleanup_unverifiable", "missing_pid")) {
        this.#store.appendEvent(taskId2, "cleanup_probe_unknown", "Terminal task has no recorded executor PID; cleanup remains occupied", {
          reason_code: "missing_executor_pid",
          count: occurrence.count
        }, this.#now().toISOString());
      }
      return;
    }
    const verdicts = await this.#probeExecutors(snapshot);
    const workerExited = snapshot.worker_pid === null || verdicts.worker.state === "exited";
    const runtimeExited = snapshot.zcode_pid === null || verdicts.runtime.state === "exited";
    if (!workerExited || !runtimeExited) {
      const reason = !runtimeExited ? verdicts.runtime.reason_code : verdicts.worker.reason_code;
      const occurrence = this.#counters.record("terminal_cleanup_unverifiable", reason);
      if (this.#counters.shouldEmit("terminal_cleanup_unverifiable", reason)) {
        this.#store.appendEvent(taskId2, "cleanup_probe_unknown", "Terminal task cleanup is not yet verified; its execution path remains occupied", {
          reason_code: reason,
          worker_state: verdicts.worker.state,
          runtime_state: verdicts.runtime.state,
          count: occurrence.count
        }, this.#now().toISOString());
      }
      return;
    }
    const failureRecordState = this.#cleanupFailureRecordState(taskId2, status.attempt);
    if (failureRecordState !== "none") {
      const occurrence = this.#counters.record("terminal_cleanup_latched", failureRecordState);
      if (this.#counters.shouldEmit("terminal_cleanup_latched", failureRecordState)) {
        this.#store.appendEvent(taskId2, "cleanup_unverified", "A recorded tree-cleanup failure with known members keeps the terminal task occupied; cancel runs the recorded-tree scan", {
          record_state: failureRecordState,
          count: occurrence.count
        }, this.#now().toISOString());
      }
      return;
    }
    await this.#exclusive(async () => {
      const current = this.#safeStatus(taskId2);
      if (!current || !isTerminalStatus(current.status) || current.cleanup_unverified !== true) return;
      const currentIdentity = this.#store.readExecutorIdentity(taskId2, current.attempt);
      if (current.attempt !== snapshot.attempt || current.worker_pid !== snapshot.status_worker_pid || (current.zcode_pid ?? null) !== snapshot.zcode_pid || currentIdentity?.worker?.pid !== snapshot.identity?.worker?.pid || currentIdentity?.worker?.fingerprint !== snapshot.identity?.worker?.fingerprint || currentIdentity?.runtime?.pid !== snapshot.identity?.runtime?.pid || currentIdentity?.runtime?.fingerprint !== snapshot.identity?.runtime?.fingerprint) return;
      this.#store.writeStatus(taskId2, { cleanup_unverified: null, worker_pid: null, zcode_pid: null });
      this.#store.appendEvent(taskId2, "cleanup_verified", "Recorded worker and ZCode runtime exits were confirmed; terminal result was preserved", {
        attempt: snapshot.attempt,
        worker_reason_code: snapshot.worker_pid === null ? "not_recorded" : verdicts.worker.reason_code,
        runtime_reason_code: snapshot.zcode_pid === null ? "not_recorded" : verdicts.runtime.reason_code
      }, this.#now().toISOString());
      this.#pumpLocked();
    });
  }
  /** Persisted facts needed for one recovery probe cycle. */
  async #reconcileRunningThreePhase(taskId2, status) {
    const snapshot = {
      attempt: status.attempt,
      worker_pid: status.worker_pid,
      zcode_pid: status.zcode_pid ?? null,
      started_at: status.started_at,
      heartbeat: this.#store.readWorkerHeartbeat(taskId2, status.attempt),
      identity: this.#store.readExecutorIdentity(taskId2, status.attempt)
    };
    const heartbeatAgeMs = snapshot.heartbeat ? this.#now().getTime() - Date.parse(snapshot.heartbeat.heartbeat_at) : Number.NaN;
    if (snapshot.heartbeat && snapshot.worker_pid !== null && snapshot.heartbeat.worker_pid === snapshot.worker_pid && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 15e3) return;
    const verdicts = await this.#probeExecutors(snapshot);
    await this.#exclusive(async () => {
      const current = this.#safeStatus(taskId2);
      if (!current) return;
      if (isTerminalStatus(current.status)) return;
      if (current.attempt !== snapshot.attempt || current.worker_pid !== snapshot.worker_pid || (current.zcode_pid ?? null) !== snapshot.zcode_pid) return;
      this.#persistProbeVerdicts(taskId2, snapshot.attempt, verdicts);
      this.#applyReconcileVerdicts(taskId2, current, snapshot, verdicts);
    });
  }
  async #probeExecutors(snapshot) {
    const probe = this.#probe;
    const nowMs = () => this.#now().getTime();
    const workerIdentity = snapshot.identity?.worker ?? null;
    const runtimeIdentity = snapshot.identity?.runtime ?? null;
    if (probe && (snapshot.worker_pid !== null || snapshot.zcode_pid !== null)) {
      try {
        const requests = [];
        if (snapshot.worker_pid !== null) requests.push({ pid: snapshot.worker_pid, identity: workerIdentity });
        if (snapshot.zcode_pid !== null) requests.push({ pid: snapshot.zcode_pid, identity: runtimeIdentity });
        const results = await probe.probe(requests);
        let worker = livenessVerdict(snapshot.worker_pid, this.#isProcessRunning, nowMs);
        let runtime = snapshot.zcode_pid === null ? { state: "unknown", reason_code: "runtime_pid_not_reported", observed_at: new Date(nowMs()).toISOString() } : livenessVerdict(snapshot.zcode_pid, this.#isProcessRunning, nowMs);
        let index = 0;
        if (snapshot.worker_pid !== null) {
          worker = results[index] ?? worker;
          index += 1;
        }
        if (snapshot.zcode_pid !== null) {
          runtime = results[index] ?? runtime;
        }
        if (worker.state === "unknown") this.#counters.record("probe_unknown_worker", worker.reason_code);
        if (runtime.state === "unknown") this.#counters.record("probe_unknown_runtime", runtime.reason_code);
        return { worker, runtime };
      } catch (error) {
        this.#counters.record("probe_failed", boundedErrorMessage(error, 80));
      }
    }
    return {
      worker: livenessVerdict(snapshot.worker_pid, this.#isProcessRunning, nowMs),
      runtime: snapshot.zcode_pid === null ? { state: "unknown", reason_code: "runtime_pid_not_reported", observed_at: new Date(nowMs()).toISOString() } : livenessVerdict(snapshot.zcode_pid, this.#isProcessRunning, nowMs)
    };
  }
  #persistProbeVerdicts(taskId2, attempt, verdicts) {
    try {
      const current = this.#store.readObservationSnapshot(taskId2, attempt).snapshot;
      const revision = (current?.writers["manager"] ?? -1) + 1;
      this.#store.writeManagerObservation(taskId2, attempt, {
        worker_probe: { state: verdicts.worker.state, reason_code: verdicts.worker.reason_code },
        runtime_probe: { state: verdicts.runtime.state, reason_code: verdicts.runtime.reason_code }
      }, revision, this.#now().toISOString());
    } catch {
    }
  }
  /** Latches a failed termination (ADR-009): occupancy is retained via
   * cleanup_unverified and the member pids observed by the failed
   * transaction are persisted so later claimant scans cover them. The
   * complete member set is persisted structurally (cleanup-failure.json);
   * the bounded [cleanup-members: …] marker in the status text is a durable
   * fallback that is only trusted when complete — a truncated marker (or a
   * missing/corrupt record) fails later releases closed instead of silently
   * narrowing the scan (review-round-1 R3 + addendum). */
  #recordCleanupFailure(taskId2, attempt, error) {
    const message = boundedErrorMessage(error, 300);
    const freshPids = Array.isArray(error.memberPids) ? error.memberPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0) : [];
    let metaPids = [];
    let metaKnownIncomplete = false;
    try {
      const previous = this.#store.readAttemptMeta(taskId2, attempt, "cleanup-failure.json");
      if (previous !== null) {
        metaPids = this.#validMemberPids(previous.member_pids);
        metaKnownIncomplete = previous.complete === false;
      }
    } catch {
    }
    const priorMarker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId2)?.error);
    const priorMarkerIncomplete = priorMarker !== null && !priorMarker.complete;
    const previousPids = [.../* @__PURE__ */ new Set([...metaPids, ...priorMarker?.pids ?? []])];
    const mergedPids = [.../* @__PURE__ */ new Set([...previousPids, ...freshPids])];
    const joined = mergedPids.join(",");
    const fitsWithoutTruncation = joined.length <= 1600 && !(metaKnownIncomplete || priorMarkerIncomplete);
    const memberMarker = mergedPids.length > 0 ? fitsWithoutTruncation ? ` [cleanup-members: ${joined}]` : ` [cleanup-members: ${mergedPids.slice(0, 200).join(",")},\u2026]` : metaKnownIncomplete || priorMarkerIncomplete ? " [cleanup-members: ,\u2026]" : "";
    const recordComplete = fitsWithoutTruncation;
    try {
      this.#store.writeAttemptMeta(taskId2, attempt, "cleanup-failure.json", {
        member_pids: mergedPids,
        complete: recordComplete,
        last_error: message
      });
    } catch {
    }
    try {
      this.#store.writeStatus(taskId2, {
        cleanup_unverified: true,
        error: `cancellation could not be verified: ${boundedErrorMessage(error, 200)}${memberMarker}`
      });
      this.#store.appendEvent(taskId2, "cancel_failed", message, mergedPids.length > 0 ? { member_pids: mergedPids } : void 0, this.#now().toISOString());
    } catch {
    }
  }
  /** Validates a persisted member_pids value (review-round-1 addendum R3): a
   * PRESENT record without the member_pids field, a null, or a non-array is
   * corrupt and fails closed — "missing" must never read as "no members". */
  #validMemberPids(value) {
    if (value === void 0 || value === null) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup failure record is corrupt: member pid list is missing");
    }
    if (!Array.isArray(value) || !value.every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup failure record is corrupt: member pid list is not a valid array of positive integers");
    }
    return value;
  }
  /** Parses the durable [cleanup-members: …] marker from a latched status
   * error text. A TRUNCATED marker (…) is reported as incomplete: it must
   * never be treated as the full member set (addendum R3 case 2). */
  #parseCleanupMembersMarker(errorText) {
    const marker = /\[cleanup-members: ([0-9,]+)(,…)?\]/u.exec(errorText ?? "");
    if (!marker) return null;
    const pids = marker[1].split(",").map((part) => Number(part)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    return { pids, complete: marker[2] === void 0 };
  }
  /** Classification of the persisted cleanup-failure state for an attempt:
   * "none" (no record and no known-member marker — legacy latch), "empty"
   * (explicitly member-less record), "members" (known member pids must stay
   * covered, including via a complete latch marker), or "corrupt" (fail
   * closed). A read error is treated as corrupt. */
  #cleanupFailureRecordState(taskId2, attempt) {
    let meta = null;
    try {
      meta = this.#store.readAttemptMeta(taskId2, attempt, "cleanup-failure.json") ?? null;
    } catch {
      return "corrupt";
    }
    const marker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId2)?.error);
    if (meta === null) {
      if (marker === null) return "none";
      return marker.complete ? "members" : "corrupt";
    }
    let memberPids;
    try {
      memberPids = this.#validMemberPids(meta.member_pids);
    } catch {
      return "corrupt";
    }
    if (meta.complete === false) return "corrupt";
    return memberPids.length > 0 ? "members" : "empty";
  }
  /** Recorded pids (with persisted fingerprints when available) that later
   * claimant scans must cover after a termination failure. The durable
   * [cleanup-members: …] marker inside the latched status text is ALWAYS
   * unioned in (R3): a missing or emptied failure record can never narrow
   * the scan below what the latch itself recorded; a corrupt record — or a
   * TRUNCATED marker that cannot restore the full set — fails closed before
   * any scan runs. */
  #claimantTargets(taskId2, attempt, probeSnapshot) {
    const targets = [];
    const addPid = (pid, fingerprint) => {
      if (Number.isSafeInteger(pid) && pid > 0 && !targets.some((t) => t.pid === pid)) targets.push({ pid, fingerprint });
    };
    const workerFingerprint = typeof probeSnapshot.identity?.worker?.fingerprint === "string" ? probeSnapshot.identity.worker.fingerprint : null;
    const runtimeFingerprint = typeof probeSnapshot.identity?.runtime?.fingerprint === "string" ? probeSnapshot.identity.runtime.fingerprint : null;
    if (probeSnapshot.worker_pid !== null) addPid(probeSnapshot.worker_pid, workerFingerprint);
    if (probeSnapshot.zcode_pid !== null) addPid(probeSnapshot.zcode_pid, runtimeFingerprint);
    const marker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId2)?.error);
    if (marker !== null && !marker.complete) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup member record is incomplete: the latched member list was truncated and cannot be reconstructed; the task stays occupied");
    }
    if (marker !== null) {
      for (const pid of marker.pids) addPid(pid, null);
    }
    let meta = null;
    try {
      meta = this.#store.readAttemptMeta(taskId2, attempt, "cleanup-failure.json") ?? null;
    } catch {
    }
    if (meta === null) return targets;
    if (meta.complete === false) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup member record is incomplete: the structured member list is marked partial; the task stays occupied");
    }
    for (const pid of this.#validMemberPids(meta.member_pids)) addPid(pid, null);
    return targets;
  }
  /** Applies confirmed probe verdicts to one unchanged attempt snapshot. */
  #applyReconcileVerdicts(taskId2, status, snapshot, verdicts) {
    if (status.cleanup_unverified === true) {
      const occurrence = this.#counters.record("reconcile_latched_cleanup", "cleanup_unverified");
      if (this.#counters.shouldEmit("reconcile_latched_cleanup", "cleanup_unverified")) {
        this.#store.appendEvent(taskId2, "cleanup_unverified", "Reconciliation skipped: a recorded tree-cleanup failure keeps the task occupied until a verified cancel releases it", {
          count: occurrence.count
        }, this.#now().toISOString());
      }
      return;
    }
    const persistedResult = this.#store.readResult(taskId2);
    if (persistedResult && persistedResult.attempt === status.attempt) {
      this.#store.writeStatus(taskId2, {
        status: persistedResult.status,
        finished_at: persistedResult.finished_at,
        exit_code: persistedResult.exit_code,
        zcode_session_id: persistedResult.session_id,
        error_code: persistedResult.error_code ?? null,
        error: persistedResult.status === "failed" ? persistedResult.summary : null,
        worker_pid: null,
        cleanup_unverified: persistedResult.error_code === "cleanup_failed"
      });
      return;
    }
    const pid = status.worker_pid;
    const heartbeat = snapshot.heartbeat;
    const heartbeatAt = heartbeat ? Date.parse(heartbeat.heartbeat_at) : Number.NaN;
    const heartbeatAgeMs = this.#now().getTime() - heartbeatAt;
    if (pid !== null && heartbeat?.worker_pid === pid && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 15e3) return;
    if (verdicts.worker.state === "alive") return;
    if (verdicts.worker.state === "unknown" && pid !== null) {
      const occurrence = this.#counters.record("worker_probe_unknown", verdicts.worker.reason_code);
      if (this.#counters.shouldEmit("worker_probe_unknown", verdicts.worker.reason_code)) {
        this.#store.appendEvent(taskId2, "probe_unknown", "Worker liveness could not be confirmed; the task stays occupied", {
          reason_code: verdicts.worker.reason_code,
          count: occurrence.count,
          observed_at: verdicts.worker.observed_at
        }, verdicts.worker.observed_at);
      }
      return;
    }
    const runtimePid = status.zcode_pid ?? null;
    if (runtimePid !== null && verdicts.runtime.state === "alive") {
      if (this.#recoverOutcomeCheckpoint(taskId2, status, runtimePid, false)) return;
      this.#store.writeStatus(taskId2, { cleanup_unverified: true, error_code: "cleanup_failed", error: "Worker exited while ZCode remains alive; cancel to verify runtime cleanup" });
      return;
    }
    if (runtimePid !== null && verdicts.runtime.state === "unknown") {
      if (this.#recoverOutcomeCheckpoint(taskId2, status, runtimePid, false)) return;
      const occurrence = this.#counters.record("runtime_probe_unknown", verdicts.runtime.reason_code);
      if (this.#counters.shouldEmit("runtime_probe_unknown", verdicts.runtime.reason_code)) {
        this.#store.appendEvent(taskId2, "probe_unknown", "ZCode runtime exit could not be confirmed; cleanup stays unverified", {
          reason_code: verdicts.runtime.reason_code,
          count: occurrence.count
        }, verdicts.runtime.observed_at);
      }
      this.#store.writeStatus(taskId2, { cleanup_unverified: true, error_code: "cleanup_failed", error: "Worker exited; ZCode runtime exit could not be confirmed; cancel to verify cleanup" });
      return;
    }
    if (this.#recoverOutcomeCheckpoint(taskId2, status, runtimePid, true)) return;
    const startedAtMs = status.started_at === null ? Number.NaN : Date.parse(status.started_at);
    const withinGrace = Number.isFinite(startedAtMs) && this.#now().getTime() - startedAtMs < this.#workerStartGraceMs;
    const workerBegan = this.#store.readAttemptMeta(taskId2, status.attempt, "started.json") !== null;
    if (pid === null && withinGrace) return;
    if (pid !== null && workerBegan && withinGrace) return;
    if (!workerBegan) {
      if (this.#store.claimAttemptRespawn(taskId2, status.attempt)) {
        const respawned = this.#spawnWorker(this.#dataRoot, taskId2, status.attempt);
        this.#store.writeStatus(taskId2, { worker_pid: respawned.pid });
        this.#store.appendEvent(
          taskId2,
          "worker_respawned",
          `Bridge respawned the worker: previous pid ${String(pid)} exited before writing any task state`,
          { worker_pid: respawned.pid, worker_pid_previous: pid, attempt: status.attempt }
        );
        return;
      }
      const claimedAt = this.#store.respawnClaimedAt(taskId2, status.attempt);
      if (claimedAt && Date.now() - claimedAt.getTime() < _BridgeTaskManager.RESPAWN_IN_FLIGHT_MS) return;
    }
    const task = this.#store.readTask(taskId2);
    const finishedAt = this.#now().toISOString();
    const workerStderr = this.#store.readAttemptText(taskId2, status.attempt, "worker-stderr.log") ?? "";
    const failure = {
      code: "worker_lost",
      message: `worker pid ${String(pid)} is gone without a terminal result${workerStderr.trim() ? "; diagnostic stderr is available in private attempt evidence" : "; worker stderr was empty"}`
    };
    const result = buildTaskResult({
      task,
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome: null,
      failure,
      sessionId: status.zcode_session_id
    });
    this.#store.writeResult(taskId2, result);
    this.#store.writeStatus(taskId2, {
      status: "failed",
      finished_at: finishedAt,
      error_code: "worker_lost",
      error: result.summary,
      worker_pid: null
    });
    this.#store.appendEvent(taskId2, "error", result.summary, { error_code: "worker_lost" }, finishedAt);
  }
  async createTask(task) {
    return this.#exclusive(async () => {
      this.#validateTaskPackage(task);
      if (this.#store.hasTask(task.task_id)) {
        const existing = this.#store.readTask(task.task_id);
        const ref = this.#store.readWorkspaceRef(task.task_id);
        const sameWorkspace = path5.resolve(task.workspace) === path5.resolve(ref?.requestedPath ?? existing.workspace);
        const sameExecutionPath = task.worktree_path === void 0 ? existing.worktree_path === void 0 : existing.worktree_path !== void 0 && path5.resolve(task.worktree_path) === path5.resolve(ref?.canonicalPath ?? existing.worktree_path);
        const normalizedRetry = {
          ...task,
          workspace: existing.workspace,
          ...existing.worktree_path === void 0 ? { worktree_path: void 0 } : { worktree_path: existing.worktree_path }
        };
        const fingerprint2 = createHash2("sha256").update(stableJson2(normalizedRetry)).digest("hex");
        const previous = this.#store.readSubmission(task.task_id);
        const existingFingerprint = previous?.fingerprint ?? createHash2("sha256").update(stableJson2(existing)).digest("hex");
        if (!sameWorkspace || !sameExecutionPath || existingFingerprint !== fingerprint2) {
          throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already belongs to a different request: ${task.task_id}`);
        }
        const status2 = this.#store.readStatus(task.task_id);
        const receipt2 = previous?.receipt ?? {
          task_id: task.task_id,
          status: status2.status === "running" ? "running" : "queued",
          created_at: status2.created_at
        };
        this.#store.writeSubmission(task.task_id, { fingerprint: fingerprint2, receipt: receipt2 });
        return receipt2;
      }
      let workspaceRef;
      try {
        workspaceRef = await this.#workspaceProvider.resolve(task.workspace, task.task_id, task.worktree_path);
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error)
        );
      }
      const createdAt = this.#now().toISOString();
      try {
        buildTaskPrompt(task);
      } catch (error) {
        throw new TaskManagerError("TASK_INVALID", String(error));
      }
      const normalizedTask = {
        ...task,
        workspace: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
        ...workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : { worktree_path: void 0 }
      };
      const fingerprint = createHash2("sha256").update(stableJson2(normalizedTask)).digest("hex");
      try {
        this.#store.createTask(normalizedTask, createdAt);
        this.#store.writeWorkspaceRef(task.task_id, workspaceRef);
      } catch (error) {
        await this.#workspaceProvider.release(workspaceRef).catch(() => void 0);
        throw error;
      }
      this.#store.appendEvent(task.task_id, "queued", "Task accepted and queued", void 0, createdAt);
      this.#store.appendEvent(task.task_id, "workspace_ready", workspaceRef.mode === "worktree" ? "Using the the calling host-selected worktree for execution under the requested project" : "Using the requested project directory for execution", {
        project_path: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
        execution_path: workspaceRef.canonicalPath,
        ...workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : {},
        mode: workspaceRef.mode,
        ...workspaceRef.branchName ? { branch_name: workspaceRef.branchName } : {}
      }, createdAt);
      const acceptedReceipt = { task_id: task.task_id, status: "queued", created_at: createdAt };
      this.#store.writeSubmission(task.task_id, { fingerprint, receipt: acceptedReceipt });
      this.#pumpLocked();
      const status = this.#store.readStatus(task.task_id);
      const receipt = status.status === "running" ? {
        task_id: task.task_id,
        status: "running",
        created_at: createdAt
      } : acceptedReceipt;
      if (receipt !== acceptedReceipt) this.#store.writeSubmission(task.task_id, { fingerprint, receipt });
      return receipt;
    });
  }
  async getStatus(taskId2) {
    this.#requireTask(taskId2);
    const status = this.#store.readStatus(taskId2);
    const observation = this.#safeObservation(taskId2, status);
    return { ...toPublicStatus(status), ...observation ? { observation } : {} };
  }
  /** Observation built by the shared judger; a corrupt/failed build degrades
   * to a minimal unknown observation instead of failing the status read.
   * Fresh persisted probe verdicts from the recovery scan are included. */
  #safeObservation(taskId2, status) {
    try {
      const snapshot = this.#store.readObservationSnapshot(taskId2, status.attempt).snapshot;
      const probes = snapshot?.worker_probe || snapshot?.runtime_probe ? {
        task_id: taskId2,
        attempt: status.attempt,
        worker_pid: status.worker_pid,
        runtime_pid: status.zcode_pid ?? null,
        worker: snapshot.worker_probe ?? { state: "unknown", reason_code: "not_probed" },
        runtime: snapshot.runtime_probe ?? { state: "unknown", reason_code: "not_probed" },
        probed_at: snapshot.updated_at
      } : null;
      return buildTaskObservation(this.#store, taskId2, status, {
        now: this.#now,
        startGraceMs: this.#workerStartGraceMs,
        stallHintMs: this.#stallHintMs,
        probes
      });
    } catch {
      return null;
    }
  }
  async getEvents(input) {
    const afterSeq = input.after_seq ?? 0;
    const limit = input.limit ?? 100;
    const waitMs = input.wait_ms ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new TaskManagerError("TASK_INVALID", "after_seq must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskManagerError("TASK_INVALID", "limit must be an integer from 1 to 200");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25e3) {
      throw new TaskManagerError("TASK_INVALID", "wait_ms must be an integer from 0 to 25000");
    }
    if (input.view !== void 0 && input.view !== "raw" && input.view !== "summary") {
      throw new TaskManagerError("TASK_INVALID", "view must be raw or summary");
    }
    if (input.max_bytes !== void 0 && (!Number.isInteger(input.max_bytes) || input.max_bytes < 1024 || input.max_bytes > 32 * 1024 * 1024)) {
      throw new TaskManagerError("TASK_INVALID", "max_bytes must be an integer from 1024 to 33554432");
    }
    let startCursor = null;
    if (input.scan_cursor !== void 0) {
      if (typeof input.scan_cursor !== "string" || input.scan_cursor.length > 2048) {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor must be an opaque cursor string returned by a previous page");
      }
      try {
        const decoded = JSON.parse(Buffer.from(input.scan_cursor, "base64url").toString("utf8"));
        if (decoded?.v !== 1 || decoded.task_id !== input.task_id) throw new Error("cursor does not belong to this task");
        startCursor = decoded;
      } catch {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor is not a valid cursor for this task; restart the scan with after_seq");
      }
    }
    const deadline = Date.now() + waitMs;
    const readPage = () => {
      this.#requireTask(input.task_id);
      const status = this.#store.readStatus(input.task_id);
      const observation = this.#safeObservation(input.task_id, status);
      const bounded2 = Boolean(startCursor) || input.max_bytes !== void 0;
      const read = bounded2 ? this.#store.readEventsBounded(input.task_id, { afterSeq, limit, view: input.view ?? "raw", maxBytes: input.max_bytes, cursor: startCursor }) : this.#store.readEvents(input.task_id, afterSeq, limit, input.view ?? "raw");
      const page = {
        task_id: input.task_id,
        status: status.status,
        events: read.events,
        next_seq: read.nextSeq,
        has_more: read.hasMore,
        ...read.omittedEvents ? { omitted_events: read.omittedEvents } : {},
        ...observation ? { observation } : {}
      };
      if (bounded2) {
        const scan = read;
        if (scan.scan_incomplete) page.scan_incomplete = true;
        if (scan.scan_cursor) page.scan_cursor = encodeScanCursor(scan.scan_cursor);
        page.scan_metrics = {
          bytes_read: scan.metrics.bytes_read,
          records_scanned: scan.metrics.records_scanned,
          invalid_lines: scan.metrics.invalid_lines,
          corrupt_count: scan.metrics.corrupt_count,
          first_corrupt_offset: scan.metrics.first_corrupt_offset,
          index_fallback: scan.metrics.index_fallback ? 1 : 0
        };
        return { ...page, cursor_invalid: scan.cursor_invalid };
      }
      return page;
    };
    while (true) {
      const page = readPage();
      if (page.cursor_invalid) {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor no longer matches the task log (log replaced or truncated); restart with after_seq");
      }
      if (page.events.length || isTerminalStatus(page.status) || Date.now() >= deadline) return page;
      await sleep2(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }
  async getFeedback(taskId2) {
    this.#requireTask(taskId2);
    const status = this.#store.readStatus(taskId2);
    const startTime = status.started_at ? Date.parse(status.started_at) : Number.NaN;
    const relevantTypes = /* @__PURE__ */ new Set(["model_selected", "model_tool_call", "tool_status", "report_ready", "worker_started"]);
    const attemptEvents = [];
    let afterSeq = 0;
    while (true) {
      const previousSeq = afterSeq;
      const page = this.#store.readEvents(taskId2, afterSeq, 200, "raw");
      for (const event of page.events) {
        const eventTime = Date.parse(event.at);
        if (!Number.isFinite(startTime) || !Number.isFinite(eventTime) || eventTime < startTime) continue;
        if (relevantTypes.has(event.type)) attemptEvents.push(event);
      }
      afterSeq = page.nextSeq;
      if (!page.hasMore || page.nextSeq <= previousSeq) break;
    }
    let currentWorkerStarted = null;
    for (const event of attemptEvents) {
      if (event.type === "worker_started" && event.details?.["attempt"] === status.attempt) currentWorkerStarted = event;
    }
    const events = attemptEvents.filter((event) => {
      if (event.type === "worker_started") return false;
      if (!currentWorkerStarted) return true;
      return event.seq > currentWorkerStarted.seq;
    });
    const result = isTerminalStatus(status.status) ? this.#store.readResult(taskId2) : null;
    return buildTaskFeedbackSnapshotV01({ status: toPublicStatus(status), events, result });
  }
  async getResult(taskId2) {
    return (async () => {
      this.#requireTask(taskId2);
      const status = this.#store.readStatus(taskId2);
      if (!isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId2} is not finished (status: ${status.status})`
        );
      }
      const result = this.#store.readResult(taskId2);
      if (!result) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId2} has terminal status ${status.status} but no persisted result`
        );
      }
      return result;
    })();
  }
  async replyToInteraction(input) {
    return this.#exclusive(async () => {
      this.#requireTask(input.task_id);
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 512) {
        throw new TaskManagerError("TASK_INVALID", "request_id must be a non-empty string up to 512 characters");
      }
      const status = this.#store.readStatus(input.task_id);
      if (status.status !== "running") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction can only be answered while the task is running (status: ${status.status})`);
      }
      let record2;
      try {
        const read = this.#store.readInteractionRequest(input.task_id, input.request_id);
        if (!read) throw new TaskManagerError("TASK_NOT_FOUND", `unknown ZCode interaction request: ${input.request_id}`);
        record2 = read;
      } catch (error) {
        if (error instanceof TaskManagerError) throw error;
        throw new TaskManagerError(
          "TASK_STATE",
          `ZCode interaction request ${input.request_id} could not be read: the persisted full request is unreadable or corrupt`
        );
      }
      if (record2.state === "answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      const answer = buildInteractionAnswer(record2, input);
      const answered = input.decision === "allow" || input.decision === "accept" ? this.#store.answerInteractionRequestVerified(input.task_id, input.request_id, answer, { requireIntegrity: true }, this.#now().toISOString()) : { state: this.#store.answerInteractionRequest(input.task_id, input.request_id, answer, this.#now().toISOString()) };
      if (answered.state === "already_answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      if (answered.state === "integrity_failed") {
        throw new TaskManagerError(
          "TASK_STATE",
          `ZCode interaction request ${input.request_id} cannot be approved: ${answered.reason}; the approval was not recorded as granted`
        );
      }
      this.#store.appendEvent(input.task_id, "interaction_reply_submitted", "the calling host submitted a response to the ZCode interaction", {
        request_id: input.request_id,
        method: record2.method,
        decision: input.decision
      }, this.#now().toISOString());
      return { task_id: input.task_id, request_id: input.request_id, state: "answered" };
    });
  }
  async continueTask(input) {
    return this.#exclusive(async () => {
      const taskId2 = input.task_id;
      this.#requireTask(taskId2);
      if (typeof input.feedback !== "string" || input.feedback.trim().length === 0) {
        throw new TaskManagerError("TASK_INVALID", "feedback must be a non-empty string");
      }
      if (input.additional_requirements !== void 0 && (!Array.isArray(input.additional_requirements) || input.additional_requirements.some((item) => typeof item !== "string"))) {
        throw new TaskManagerError("TASK_INVALID", "additional_requirements must be an array of strings");
      }
      const status = this.#store.readStatus(taskId2);
      const continueFingerprint = createHash2("sha256").update(stableJson2({ feedback: input.feedback, additional_requirements: input.additional_requirements ?? [] })).digest("hex");
      if (input.operation_id !== void 0 && (typeof input.operation_id !== "string" || !input.operation_id.trim() || input.operation_id.length > 128)) {
        throw new TaskManagerError("TASK_INVALID", "operation_id must be a non-empty string up to 128 characters");
      }
      if (input.operation_id) {
        for (let attempt = 2; attempt <= status.attempt; attempt += 1) {
          const prior = this.#store.readAttemptMeta(taskId2, attempt, "continue.json");
          if (prior?.operation_id !== input.operation_id) continue;
          if (prior.fingerprint !== continueFingerprint) throw new TaskManagerError("CONTINUE_OPERATION_CONFLICT", "operation_id already belongs to different continuation input");
          if (prior.receipt) return prior.receipt;
          return { task_id: taskId2, status: status.status === "running" ? "running" : "queued", created_at: status.created_at };
        }
      }
      if (input.expected_attempt !== void 0 && input.expected_attempt !== status.attempt) {
        throw new TaskManagerError("TASK_STATE", `Expected attempt ${input.expected_attempt}; current attempt is ${status.attempt}`);
      }
      if (!["completed", "failed", "waiting_for_master"].includes(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_continue is not allowed from status ${status.status}`
        );
      }
      if (status.cleanup_unverified) throw new TaskManagerError("TASK_STATE", "Cannot continue until unverified ZCode process cleanup is resolved");
      const task = this.#store.readTask(taskId2);
      try {
        const ref = await this.#workspaceProvider.resolve(task.workspace, taskId2, task.worktree_path);
        const recorded = this.#store.readWorkspaceRef(taskId2);
        if (recorded && (ref.canonicalPath !== recorded.canonicalPath || ref.requestedPath !== recorded.requestedPath)) {
          throw new Error(`project or execution workspace no longer resolves to its recorded path`);
        }
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error)
        );
      }
      const previousAttempt = status.attempt;
      const previousResult = this.#store.readResult(taskId2);
      try {
        buildContinuePrompt({ task, feedback: input.feedback, additionalRequirements: input.additional_requirements ?? [], previousSessionId: previousResult?.session_id ?? status.zcode_session_id, previousResult });
      } catch (error) {
        throw new TaskManagerError("TASK_INVALID", String(error));
      }
      const nextAttempt = previousAttempt + 1;
      const createdAt = this.#now().toISOString();
      const continuationReceipt = { task_id: taskId2, status: "queued", created_at: createdAt };
      this.#store.archiveResultToAttempt(taskId2, previousAttempt);
      this.#store.writeAttemptMeta(taskId2, nextAttempt, "continue.json", {
        ...input.operation_id ? { operation_id: input.operation_id, fingerprint: continueFingerprint, receipt: continuationReceipt } : {},
        feedback: input.feedback,
        additional_requirements: [...input.additional_requirements ?? []],
        previous_session_id: previousResult?.session_id ?? status.zcode_session_id,
        previous_attempt: previousAttempt
      });
      this.#store.writeStatus(taskId2, {
        status: "queued",
        attempt: nextAttempt,
        started_at: null,
        finished_at: null,
        worker_pid: null,
        zcode_session_id: null,
        exit_code: null,
        error_code: null,
        error: null,
        cancel_requested: null,
        zcode_pid: null,
        cleanup_unverified: null
      });
      this.#pumpLocked();
      const after = this.#store.readStatus(taskId2);
      const receipt = {
        task_id: taskId2,
        status: after.status === "running" ? "running" : "queued",
        created_at: after.updated_at
      };
      if (input.operation_id) this.#store.writeAttemptMeta(taskId2, nextAttempt, "continue.json", {
        ...this.#store.readAttemptMeta(taskId2, nextAttempt, "continue.json"),
        receipt
      });
      return receipt;
    });
  }
  async cancelTask(taskId2) {
    return this.#exclusive(async () => {
      this.#requireTask(taskId2);
      const status = this.#store.readStatus(taskId2);
      const identity = this.#store.readExecutorIdentity(taskId2, status.attempt);
      const started = this.#store.readAttemptMeta(taskId2, status.attempt, "started.json");
      const probeSnapshot = {
        attempt: status.attempt,
        worker_pid: status.worker_pid ?? identity?.worker?.pid ?? started?.worker_pid ?? null,
        zcode_pid: status.zcode_pid ?? null,
        identity
      };
      const verdicts = await this.#probeExecutors(probeSnapshot);
      const workerFingerprint = typeof probeSnapshot.identity?.worker?.fingerprint === "string" ? probeSnapshot.identity.worker.fingerprint : null;
      const runtimeFingerprint = typeof probeSnapshot.identity?.runtime?.fingerprint === "string" ? probeSnapshot.identity.runtime.fingerprint : null;
      if (status.cleanup_unverified) {
        if (probeSnapshot.worker_pid === null && probeSnapshot.zcode_pid === null) {
          throw new TaskManagerError("CANCEL_FAILED", "No worker or ZCode process identity is available to verify cleanup");
        }
        if (probeSnapshot.zcode_pid !== null && verdicts.runtime.state === "unknown") {
          throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: runtime probe returned ${verdicts.runtime.reason_code}`);
        }
        if (probeSnapshot.worker_pid !== null && verdicts.worker.state === "unknown") {
          throw new TaskManagerError("CANCEL_FAILED", `Worker cleanup could not be verified: worker probe returned ${verdicts.worker.reason_code}`);
        }
        const verifiedRoots = /* @__PURE__ */ new Set();
        try {
          if (probeSnapshot.zcode_pid !== null && verdicts.runtime.state === "alive") {
            await this.#terminateProcessTree(probeSnapshot.zcode_pid, { graceMs: 500, killWaitMs: 5e3, expectedRootFingerprint: runtimeFingerprint });
            const after = (await this.#probeExecutors(probeSnapshot)).runtime;
            if (after.state === "alive") throw new Error("runtime still alive after termination");
            if (after.state === "unknown") throw new Error(`runtime exit could not be verified (${after.reason_code})`);
            verifiedRoots.add(probeSnapshot.zcode_pid);
          }
          if (probeSnapshot.worker_pid !== null && verdicts.worker.state === "alive") {
            await this.#terminateProcessTree(probeSnapshot.worker_pid, { graceMs: 500, killWaitMs: 5e3, expectedRootFingerprint: workerFingerprint });
            verifiedRoots.add(probeSnapshot.worker_pid);
          }
        } catch (error) {
          this.#recordCleanupFailure(taskId2, status.attempt, error);
          throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        }
        const scanTargets = this.#claimantTargets(taskId2, status.attempt, probeSnapshot).filter((target) => !verifiedRoots.has(target.pid));
        if (scanTargets.length > 0) {
          const retainObserved = (observed, livePids, error) => {
            const fromError = error instanceof WindowsTreeCleanupError ? error.memberPids : [];
            const pids = [.../* @__PURE__ */ new Set([...observed ?? [], ...livePids ?? [], ...fromError])].filter((pid2) => Number.isSafeInteger(pid2) && pid2 > 0);
            if (pids.length === 0) return;
            const carrier = error instanceof WindowsTreeCleanupError && error.memberPids.length > 0 ? error : new WindowsTreeCleanupError(
              "process_tree_cleanup_unverified",
              `recorded-tree scan keeps occupancy: ${pids.join(",")} still requires attribution`,
              pids
            );
            this.#recordCleanupFailure(taskId2, status.attempt, carrier);
          };
          const scan = await this.#verifyTreeClean(scanTargets).catch((error) => {
            retainObserved(void 0, void 0, error);
            throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          if (!scan.clean) {
            retainObserved(scan.observedPids, scan.livePids);
            this.#store.appendEvent(taskId2, "cleanup_unverified", "Recorded-tree scan still observes live claimants; the task stays occupied", { live_pids: [...scan.livePids] }, this.#now().toISOString());
            throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: ${String(scan.livePids.length)} recorded-tree process(es) still alive`);
          }
        }
        if (status.status === "running") {
          const finishedAt2 = this.#now().toISOString();
          const result2 = buildTaskResult({ task: this.#store.readTask(taskId2), attempt: status.attempt, startedAt: status.started_at, finishedAt: finishedAt2, outcome: null, cancelled: true, sessionId: status.zcode_session_id });
          this.#store.writeResult(taskId2, result2);
          this.#store.writeStatus(taskId2, { status: "cancelled", finished_at: finishedAt2, worker_pid: null, cleanup_unverified: null, zcode_pid: null, error: null, error_code: null, cancel_requested: null });
        } else this.#store.writeStatus(taskId2, { cleanup_unverified: null, zcode_pid: null });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      if (isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_cancel is not allowed from status ${status.status}`
        );
      }
      const task = this.#store.readTask(taskId2);
      if (status.status === "running" && this.#store.readResult(taskId2)) {
        const raced2 = this.#store.readResult(taskId2);
        this.#store.writeStatus(taskId2, {
          status: raced2.status,
          finished_at: raced2.finished_at,
          exit_code: raced2.exit_code,
          zcode_session_id: raced2.session_id,
          error_code: raced2.error_code ?? null,
          error: raced2.status === "failed" ? raced2.summary : null,
          worker_pid: null,
          cleanup_unverified: raced2.error_code === "cleanup_failed"
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      if (status.status === "queued") {
        const finishedAt2 = this.#now().toISOString();
        const result2 = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: null,
          finishedAt: finishedAt2,
          outcome: null,
          failure: { code: "cancelled", message: "cancelled by request before the task started" },
          cancelled: true
        });
        this.#store.writeResult(taskId2, result2);
        this.#store.writeStatus(taskId2, { status: "cancelled", finished_at: finishedAt2 });
        this.#store.appendEvent(taskId2, "cancelled", "Queued task cancelled before worker start", void 0, finishedAt2);
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      this.#store.writeStatus(taskId2, { cancel_requested: true });
      this.#store.appendEvent(taskId2, "cancel_requested", "Cancellation requested; waiting for process-tree confirmation", void 0, this.#now().toISOString());
      const pid = status.worker_pid;
      if (pid === null) {
        const finishedAt2 = this.#now().toISOString();
        const result2 = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt: finishedAt2,
          outcome: null,
          failure: { code: "worker_lost", message: "running task had no worker pid recorded" }
        });
        this.#store.writeResult(taskId2, result2);
        this.#store.writeStatus(taskId2, {
          status: "failed",
          finished_at: finishedAt2,
          error_code: "worker_lost",
          error: result2.summary
        });
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      if (verdicts.worker.state === "exited") {
        const racedEarly = this.#store.readResult(taskId2);
        if (racedEarly) {
          this.#store.writeStatus(taskId2, {
            status: racedEarly.status,
            finished_at: racedEarly.finished_at,
            exit_code: racedEarly.exit_code,
            zcode_session_id: racedEarly.session_id,
            error_code: racedEarly.error_code ?? null,
            error: racedEarly.status === "failed" ? racedEarly.summary : null,
            worker_pid: null,
            cancel_requested: null,
            cleanup_unverified: racedEarly.error_code === "cleanup_failed",
            zcode_pid: racedEarly.error_code === "cleanup_failed" ? status.zcode_pid ?? null : null
          });
          this.#pumpLocked();
          return toPublicStatus(this.#store.readStatus(taskId2));
        }
        const finishedAt2 = this.#now().toISOString();
        const reused = verdicts.worker.reason_code.startsWith("pid_reused");
        const result2 = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt: finishedAt2,
          outcome: null,
          failure: {
            code: "cancelled",
            message: reused ? `cancelled by request; the recorded worker pid ${String(pid)} was reused by another process, so the previous executor had already exited` : `cancelled by request; the recorded worker pid ${String(pid)} no longer exists`
          },
          cancelled: true,
          sessionId: status.zcode_session_id
        });
        this.#store.writeResult(taskId2, result2);
        this.#store.appendEvent(taskId2, "cancelled", "Cancellation confirmed without termination: the recorded worker process was already gone", { reason_code: verdicts.worker.reason_code }, finishedAt2);
        this.#store.writeStatus(taskId2, {
          status: "cancelled",
          finished_at: finishedAt2,
          worker_pid: null,
          cleanup_unverified: verdicts.runtime.state !== "exited" && status.zcode_pid !== null,
          zcode_pid: verdicts.runtime.state === "exited" ? null : status.zcode_pid,
          cancel_requested: null
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      const finishedSafely = () => {
        const result2 = this.#store.readResult(taskId2);
        return result2 !== null && result2.error_code !== "cleanup_failed" && !this.#store.readStatus(taskId2).cleanup_unverified && !this.#isProcessRunning(pid) && (!status.zcode_pid || !this.#isProcessRunning(status.zcode_pid));
      };
      const waitForSafeExit = async () => {
        const deadline = Date.now() + 500;
        do {
          if (finishedSafely()) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return finishedSafely();
      };
      try {
        if (!await waitForSafeExit()) {
          if (process.platform !== "win32" && status.zcode_pid && this.#isProcessRunning(status.zcode_pid)) {
            await this.#terminateProcessTree(status.zcode_pid, { graceMs: 500, killWaitMs: 5e3, expectedRootFingerprint: runtimeFingerprint });
          }
          await this.#terminateProcessTree(pid, { graceMs: 500, killWaitMs: 5e3, expectedRootFingerprint: workerFingerprint });
        }
      } catch (error) {
        this.#recordCleanupFailure(taskId2, status.attempt, error);
        const message = error instanceof Error ? error.message : String(error);
        throw new TaskManagerError(
          "CANCEL_FAILED",
          `process-tree termination for task ${taskId2} (pid ${pid}) could not be verified: ${message}`
        );
      }
      const raced = this.#store.readResult(taskId2);
      if (raced) {
        this.#store.writeStatus(taskId2, {
          status: raced.status,
          finished_at: raced.finished_at,
          exit_code: raced.exit_code,
          zcode_session_id: raced.session_id,
          error_code: raced.error_code ?? null,
          error: raced.status === "failed" ? raced.summary : null,
          worker_pid: null,
          cancel_requested: null,
          cleanup_unverified: null,
          zcode_pid: null
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId2));
      }
      const finishedAt = this.#now().toISOString();
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: status.started_at,
        finishedAt,
        outcome: null,
        failure: {
          code: "cancelled",
          message: `cancelled by request; worker process tree (pid ${pid}) was terminated and verified`
        },
        cancelled: true,
        sessionId: status.zcode_session_id
      });
      this.#store.writeResult(taskId2, result);
      this.#store.appendEvent(taskId2, "cancelled", "Worker process tree terminated and cancellation confirmed", void 0, finishedAt);
      this.#store.writeStatus(taskId2, {
        status: "cancelled",
        finished_at: finishedAt,
        worker_pid: null,
        cleanup_unverified: null,
        zcode_pid: null,
        cancel_requested: null
      });
      this.#pumpLocked();
      return toPublicStatus(this.#store.readStatus(taskId2));
    });
  }
  // ---- internals (must be called under the mutex) ----
  #recoverOutcomeCheckpoint(taskId2, status, runtimePid, runtimeExited) {
    const checkpoint = this.#store.readAttemptMeta(taskId2, status.attempt, "outcome-checkpoint.json");
    if (!checkpoint || typeof checkpoint.response !== "string") return false;
    const outcome = {
      attempts: 1,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdout: checkpoint.response,
      stderr: "",
      exitCode: typeof checkpoint.exit_code === "number" ? checkpoint.exit_code : null,
      signal: typeof checkpoint.signal === "string" ? checkpoint.signal : null,
      sessionId: typeof checkpoint.session_id === "string" ? checkpoint.session_id : null,
      response: checkpoint.response,
      usage: checkpoint.usage && typeof checkpoint.usage === "object" ? checkpoint.usage : null,
      timedOut: false,
      agentReport: checkpoint.agent_report ?? null,
      reportCandidate: checkpoint.report_candidate && typeof checkpoint.report_candidate === "object" ? checkpoint.report_candidate : null,
      reportError: typeof checkpoint.report_error === "string" ? checkpoint.report_error : null,
      errorCode: typeof checkpoint.error_code === "string" ? checkpoint.error_code : null,
      cleanupError: typeof checkpoint.cleanup_error === "string" ? checkpoint.cleanup_error : null,
      cleanupVerified: checkpoint.cleanup_verified === true
    };
    const cleanupVerified = outcome.cleanupVerified && runtimeExited;
    const failure = cleanupVerified ? null : {
      code: "cleanup_failed",
      message: outcome.cleanupError ?? "Worker exited before process cleanup could be verified; the ZCode result was recovered from its private checkpoint"
    };
    const finishedAt = this.#now().toISOString();
    const result = buildTaskResult({
      task: this.#store.readTask(taskId2),
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome,
      failure,
      sessionId: status.zcode_session_id ?? outcome.sessionId
    });
    this.#store.commitWorkerResult(taskId2, status.attempt, result, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      zcode_session_id: result.session_id,
      error_code: result.error_code ?? null,
      error: result.status === "failed" ? result.summary : null,
      worker_pid: null,
      cleanup_unverified: !cleanupVerified,
      zcode_pid: cleanupVerified ? null : runtimePid
    });
    this.#store.appendEvent(
      taskId2,
      "outcome_recovered",
      cleanupVerified ? "Recovered the completed ZCode report after the worker exited before committing its result" : "Recovered the ZCode report, but process cleanup could not be verified",
      { status: result.status, cleanup_verified: cleanupVerified },
      finishedAt
    );
    return true;
  }
  #pumpLocked() {
    const snapshot = this.#store.listTaskIds().map((taskId2) => ({ taskId: taskId2, status: this.#safeStatus(taskId2) }));
    const running = snapshot.filter(({ status }) => status?.status === "running" || status?.cleanup_unverified === true).map(({ taskId: taskId2 }) => taskId2);
    if (running.length >= this.#maxConcurrentWorkers) return;
    const occupiedPaths = running.map((taskId2) => this.#executionPathKeyLocked(taskId2));
    for (const { taskId: taskId2, status } of snapshot) {
      if (status) continue;
      try {
        occupiedPaths.push(this.#executionPathKeyLocked(taskId2));
      } catch {
        return;
      }
    }
    let slots = this.#maxConcurrentWorkers - running.length;
    const queued = snapshot.filter(({ status }) => status?.status === "queued").sort((a, b) => a.status.created_at.localeCompare(b.status.created_at));
    for (const { taskId: taskId2 } of queued) {
      if (slots <= 0) break;
      const executionPath = this.#executionPathKeyLocked(taskId2);
      if (occupiedPaths.some((occupied) => pathsOverlap(occupied, executionPath))) continue;
      this.#startWorkerLocked(taskId2);
      if (this.#store.readStatus(taskId2).status === "running") {
        occupiedPaths.push(executionPath);
        slots -= 1;
      }
    }
  }
  #executionPathKeyLocked(taskId2) {
    const recorded = this.#store.readWorkspaceRef(taskId2)?.canonicalPath;
    const task = recorded ? null : this.#store.readTask(taskId2);
    const resolved = path5.resolve(recorded ?? task.worktree_path ?? task.workspace);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  }
  #startWorkerLocked(taskId2) {
    const status = this.#store.readStatus(taskId2);
    if (status.status !== "queued") return;
    this.#store.writeStatus(taskId2, {
      status: "running",
      started_at: this.#now().toISOString(),
      worker_pid: null
    });
    let pid;
    try {
      const spawned = this.#spawnWorker(this.#dataRoot, taskId2, status.attempt);
      pid = spawned.pid;
    } catch (error) {
      const finishedAt = this.#now().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const task = this.#store.readTask(taskId2);
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: null,
        finishedAt,
        outcome: null,
        failure: { code: "spawn_failed", message }
      });
      this.#store.writeResult(taskId2, result);
      this.#store.writeStatus(taskId2, {
        status: "failed",
        finished_at: finishedAt,
        error_code: "spawn_failed",
        error: result.summary
      });
      this.#store.appendEvent(taskId2, "error", result.summary, { error_code: "spawn_failed" }, finishedAt);
      return;
    }
    this.#store.patchRunningAttempt(taskId2, status.attempt, { worker_pid: pid });
    this.#store.appendEvent(taskId2, "worker_started", "Bridge worker started", { worker_pid: pid, attempt: status.attempt }, this.#now().toISOString());
  }
  #requireTask(taskId2) {
    if (!this.#store.hasTask(taskId2)) {
      throw new TaskManagerError("TASK_NOT_FOUND", `unknown task_id: ${taskId2}`);
    }
  }
  #validateTaskPackage(task) {
    if (typeof task !== "object" || task === null) {
      throw new TaskManagerError("TASK_INVALID", "task package must be an object");
    }
    if (typeof task.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.task_id)) {
      throw new TaskManagerError(
        "TASK_INVALID",
        "task_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}"
      );
    }
    if (typeof task.objective !== "string" || task.objective.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "objective must be a non-empty string");
    }
    for (const field of [
      "requirements",
      "allowed_paths",
      "forbidden_paths",
      "acceptance_criteria",
      "test_commands"
    ]) {
      const value = task[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new TaskManagerError("TASK_INVALID", `${field} must be an array of strings (may be empty)`);
      }
    }
    if (task.context !== void 0 && typeof task.context !== "string") {
      throw new TaskManagerError("TASK_INVALID", "context must be a string when present");
    }
    if (task.timeout_ms !== void 0) {
      try {
        validateTaskTimeout(task.timeout_ms);
      } catch (error) {
        throw new TaskManagerError("TASK_INVALID", error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof task.workspace !== "string" || task.workspace.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "workspace is required");
    }
    if (task.worktree_path !== void 0 && (typeof task.worktree_path !== "string" || task.worktree_path.trim().length === 0)) {
      throw new TaskManagerError("TASK_INVALID", "worktree_path must be a non-empty absolute path when present");
    }
    if (task.model !== void 0 && (typeof task.model !== "object" || task.model === null || typeof task.model.provider_id !== "string" || task.model.provider_id.trim().length === 0 || typeof task.model.model_id !== "string" || task.model.model_id.trim().length === 0 || task.model.reasoning_level !== void 0 && (typeof task.model.reasoning_level !== "string" || task.model.reasoning_level.trim().length === 0))) {
      throw new TaskManagerError("TASK_INVALID", "model must include non-empty provider_id and model_id strings");
    }
  }
  #exclusive(operation) {
    if (this.#queuedOperations >= 32) return Promise.reject(new TaskManagerError("BRIDGE_BUSY", "Bridge operation queue is full; retry with the same task_id"));
    this.#queuedOperations += 1;
    let started = false;
    let expired = false;
    let rejectTimeout;
    const timeout = setTimeout(() => {
      if (started) return;
      expired = true;
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      rejectTimeout?.(new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not start within 5 seconds; retry with the same task_id"));
    }, 5e3);
    const locked = async () => {
      if (expired) throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation expired before it started");
      started = true;
      clearTimeout(timeout);
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      try {
        return await withProcessLock(path5.join(this.#store.tasksRoot, ".manager.lock"), operation, 5e3);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("timed out waiting for process lock:")) {
          throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not acquire the shared scheduling lock within 5 seconds; retry with the same task_id");
        }
        throw error;
      }
    };
    const run = this.#mutex.then(locked, locked);
    const bounded2 = new Promise((resolve, reject) => {
      rejectTimeout = reject;
      run.then(resolve, reject);
    });
    this.#mutex = run.catch(() => void 0);
    return bounded2;
  }
  #safeStatus(taskId2) {
    try {
      const status = this.#store.readStatus(taskId2);
      this.#store.readTask(taskId2);
      this.#store.readWorkspaceRef(taskId2);
      this.#store.readResult(taskId2);
      this.#store.readAttemptMeta(taskId2, status.attempt, "started.json");
      this.#store.readAttemptMeta(taskId2, status.attempt, "continue.json");
      return status;
    } catch (error) {
      console.error(`Bridge skipped corrupt task ${taskId2}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
};
function pathsOverlap(left, right) {
  const relative = path5.relative(left, right);
  const reverse = path5.relative(right, left);
  const inside = (value) => value === "" || !path5.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path5.sep}`);
  return inside(relative) || inside(reverse);
}
function encodeScanCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function stableJson2(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson2).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson2(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function buildInteractionAnswer(record2, input) {
  const params = record2.params;
  if (record2.method === "interaction/requestPermission") {
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new TaskManagerError("TASK_INVALID", "permission requests require decision allow or deny");
    }
    if (input.decision === "allow") {
      const options = Array.isArray(params.options) ? params.options : [];
      const canAllow = options.some((option) => {
        const item = asRecord(option);
        return typeof item.kind === "string" && item.kind.startsWith("allow");
      });
      if (!canAllow) throw new TaskManagerError("TASK_INVALID", "ZCode did not offer an allow option for this request");
    }
    return {
      decision: input.decision,
      ...input.decision === "deny" ? { reason: boundedReason(input.reason) } : {}
    };
  }
  if (input.decision !== "accept" && input.decision !== "decline") {
    throw new TaskManagerError("TASK_INVALID", "user input requests require decision accept or decline");
  }
  if (input.decision === "decline") return { action: "decline" };
  if (asRecord(params.schema).interaction === "plan_approval") {
    return { action: "accept", content: { answer_0: "approve" } };
  }
  const rawQuestions = Array.isArray(params.questions) ? params.questions : Array.isArray(asRecord(params.input).questions) ? asRecord(params.input).questions : [];
  const validQuestions = rawQuestions.map(asRecord).filter((question) => typeof question.question === "string").map((question) => question.question);
  if (!validQuestions.length) throw new TaskManagerError("TASK_INVALID", "ZCode request has no supported questions");
  const answers = input.answers ?? {};
  const answerKeys = Object.keys(answers);
  if (!answerKeys.length) throw new TaskManagerError("TASK_INVALID", "accepting an AskUserQuestion requires answers");
  if (answerKeys.some((question) => !validQuestions.includes(question))) {
    throw new TaskManagerError("TASK_INVALID", "answers must be keyed by the exact ZCode question text");
  }
  for (const [question, value] of Object.entries(answers)) {
    if (!value.trim() || value.length > 4e3) {
      throw new TaskManagerError("TASK_INVALID", `answer for '${question.slice(0, 80)}' must be non-empty and at most 4000 characters`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(answers), "utf8") > 16e3) {
    throw new TaskManagerError("TASK_INVALID", "combined ZCode answers exceed the 16 KB limit");
  }
  return { action: "accept", content: { answers } };
}
function boundedReason(reason) {
  return (reason?.trim() || "the calling host declined this request").slice(0, 2e3);
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/workspace/direct-provider.ts
import { realpathSync, statSync as statSync4 } from "node:fs";
import path6 from "node:path";
var DirectWorkspaceProvider = class {
  async resolve(workspacePath, _taskId, executionPath) {
    const projectPath = resolveExistingDirectory(workspacePath, "workspace");
    const execution = executionPath === void 0 ? projectPath : resolveExistingDirectory(executionPath, "worktree_path");
    return {
      requestedPath: projectPath.canonicalPath,
      canonicalPath: execution.canonicalPath,
      mode: executionPath === void 0 ? "direct" : "worktree",
      ...executionPath === void 0 ? {} : { sourcePath: projectPath.canonicalPath }
    };
  }
  async release(_workspace) {
  }
};
function resolveExistingDirectory(input, field) {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (!path6.isAbsolute(input)) throw new Error(`${field} must be an absolute path: ${input}`);
  let stat;
  try {
    stat = statSync4(input);
  } catch {
    throw new Error(`${field} does not exist: ${input}`);
  }
  if (!stat.isDirectory()) throw new Error(`${field} is not a directory: ${input}`);
  try {
    return { requestedPath: input, canonicalPath: realpathSync(input) };
  } catch {
    throw new Error(`${field} could not be canonicalized: ${input}`);
  }
}

// src/schedule/app-notify.ts
import { createConnection } from "node:net";

// src/schedule/app-protocol.ts
var APP_PIPE_REQUEST_ID = 1;
var APP_PIPE_TURN_ID = "mcp-turn-zcode-schedule";
function buildAppPipeRequest(input) {
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
      turnId: APP_PIPE_TURN_ID
    }
  };
}
function encodeAppPipeFrame(payloadJson) {
  const payload = Buffer.from(payloadJson, "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

// src/schedule/app-notify.ts
var APP_PIPE_DEFAULT_TIMEOUT_MS = 1e4;
var APP_PIPE_MAX_RESPONSE_BYTES = 1024 * 1024;
var defaultAppPipeConnector = (pipePath, timeoutMs) => new Promise((resolve, reject) => {
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
  socket.once("error", (error) => {
    clearTimeout(timer);
    socket.destroy();
    reject(new Error(`cannot connect to the Codex App tools pipe (${error.code ?? "connection error"})`));
  });
});
async function sendAppPipeNotification(input, connect = defaultAppPipeConnector) {
  const timeoutMs = input.timeoutMs ?? APP_PIPE_DEFAULT_TIMEOUT_MS;
  const request = buildAppPipeRequest({ threadId: input.threadId, prompt: input.prompt, callId: input.callId });
  const frame = encodeAppPipeFrame(JSON.stringify(request));
  const socket = await connect(input.pipePath, timeoutMs);
  try {
    const responseText = await readFramedResponse(socket, frame, timeoutMs);
    let response;
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
    const firstItem = "contentItems" in result && Array.isArray(result.contentItems) ? result.contentItems[0] : void 0;
    if (typeof firstItem !== "object" || firstItem === null || !("text" in firstItem) || typeof firstItem.text !== "string") {
      throw new Error("Codex App tools pipe receipt does not echo the target thread id; delivery identity is unconfirmed");
    }
    const receipt = JSON.parse(firstItem.text);
    if (typeof receipt !== "object" || receipt === null || !("threadId" in receipt) || receipt.threadId !== input.threadId) {
      throw new Error("Codex App tools pipe receipt has a different target thread; delivery identity is unconfirmed");
    }
  } finally {
    socket.destroy();
  }
}
function readFramedResponse(socket, frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expected = null;
    let done = false;
    const finish = (error, text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(text);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Codex App tools pipe response timed out after ${String(timeoutMs)}ms`));
      socket.destroy();
    }, timeoutMs);
    const onData = (chunk) => {
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
    const onError = (error) => finish(new Error(`Codex App tools pipe transport failed: ${error.message}`));
    const onClose = () => finish(new Error("Codex App tools pipe closed before a complete response arrived"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(frame);
  });
}

// src/schedule/controller.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdirSync as mkdirSync4 } from "node:fs";
import path8 from "node:path";

// src/schedule/errors.ts
var ScheduleError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
};

// src/schedule/policy.ts
var SCHEDULE_SELF_ASSESSMENT_REQUIREMENT = "This task runs under a scheduled autonomous loop. Your final JSON response must additionally include the boolean field acceptance_met: your honest assessment of whether this task's acceptance criteria are met by the completed work. This self-assessment is not the master's acceptance; the master still verifies independently. Set acceptance_met=false when the criteria are not yet met, and never set it true merely because work stopped.";
function deriveScheduledTask(task) {
  return { ...task, requirements: [...task.requirements, SCHEDULE_SELF_ASSESSMENT_REQUIREMENT] };
}
function autoContinueOperationId(taskId2, attempt) {
  return `sched-${taskId2}-a${String(attempt)}`;
}
function reviewContinueOperationId(taskId2, attempt) {
  return `sched-review-${taskId2}-a${String(attempt)}`;
}
function buildEventId(taskId2, attempt, reason, suffix = "") {
  return `${taskId2}:${attempt}:${reason}${suffix ? `:${suffix}` : ""}`;
}
function evaluateTerminalResult(taskId2, result) {
  switch (result.status) {
    case "completed":
      if (result.acceptance_met === true) return { action: "request_review" };
      if (result.acceptance_met === false) {
        return {
          action: "continue",
          feedback: "Scheduled self-assessment continuation: the previous attempt ended with acceptance_met=false. Continue the SAME task in this session toward the acceptance criteria, then finish with the required JSON report including the honest acceptance_met self-assessment. Do not repeat verification work that already passed.",
          operation_id: autoContinueOperationId(taskId2, result.attempt)
        };
      }
      return { action: "escalate", reason: "missing_self_assessment", detail: "acceptance_met absent" };
    case "waiting_for_master":
      return { action: "escalate", reason: "needs_decision" };
    case "failed":
      if (result.error_code === "zcode_usage_exhausted") return { action: "escalate", reason: "usage_exhausted" };
      if (result.error_code === "timeout" && result.session_id !== null) {
        return {
          action: "continue",
          feedback: "The previous attempt hit its wall-clock timeout with the session preserved and cleanup verified. Continue the SAME task in this session from where it stopped, then finish with the required JSON report including the honest acceptance_met self-assessment.",
          operation_id: autoContinueOperationId(taskId2, result.attempt)
        };
      }
      return { action: "escalate", reason: "task_failed", detail: result.error_code };
    case "cancelled":
      return { action: "escalate", reason: "task_cancelled" };
    default:
      return { action: "none" };
  }
}
var REASON_HEADLINES = {
  pending_interaction: "ZCode is blocked waiting for a permission or input decision",
  review_requested: "attempt finished with acceptance_met=true; independent review required",
  needs_decision: "the agent flagged needs_master_decision",
  task_failed: "the attempt failed",
  usage_exhausted: "provider usage quota is exhausted",
  task_cancelled: "the task was cancelled outside the schedule",
  missing_self_assessment: "the attempt completed without the required acceptance_met self-assessment; treat the outcome as uncertain",
  dispatch_failed: "the scheduler could not start the task",
  continue_failed: "the scheduler could not continue the session automatically",
  cancel_failed: "cancellation cleanup is unverified; the stop intent is preserved and a human decision is required"
};
function buildNotificationMessage(input) {
  const lines = [
    `Event ID: ${JSON.stringify(input.eventId)}`,
    `[ZCode Bridge schedule] task "${input.taskId}" attempt ${String(input.attempt)}: ${REASON_HEADLINES[input.reason]}.`,
    "This is a scheduler wakeup, not task acceptance; execution status and goal review are separate.",
    `- Inspect the authoritative state yourself with zcode_schedule_status (task_id "${input.taskId}"), then zcode_status / zcode_result / zcode_events on the task.`,
    "- If the agent self-assessed acceptance_met=true: independently verify the work, then call zcode_schedule_review with accepted=true, or accepted=false plus concrete feedback to resume the SAME ZCode session.",
    "- For a pending permission or input request: decide with the user and reply via zcode_interaction_reply using the exact request_id; the scheduler never auto-approves.",
    "- If provider quota is exhausted or cleanup is unverified: stop, inform the user, and do not auto-retry or continue.",
    "- Notify the human only when you accept the outcome or a human decision is required."
  ];
  const parts = [`reason=${input.reason}`];
  if (input.requestId) parts.push(`request_id=${input.requestId}`);
  if (input.errorCode) parts.push(`error_code=${input.errorCode}`);
  lines.push(parts.join(" "));
  return lines.join("\n");
}
function buildReviewContinueFeedback(feedback, attempt) {
  return [
    `Independent review of attempt ${String(attempt)} rejected the work. Address every point below, continue the SAME task in this session, then finish with the required JSON report including the honest acceptance_met self-assessment.`,
    `REVIEW FEEDBACK:
${feedback}`
  ].join("\n\n");
}

// src/schedule/supervisor.ts
import { execFile as execFileCallback } from "node:child_process";
import path7 from "node:path";
import { promisify } from "node:util";
var execFile = promisify(execFileCallback);
function planSystemdRunUnit(options) {
  const unit = options.unit;
  const logPath = path7.join(options.scheduleDir, "runner.log");
  const command = options.nodeExecutable ?? process.execPath;
  const args = [options.runnerEntryPath, options.dataRoot, options.taskId];
  const forwarded = {
    ...createWorkerEnv(options.env),
    ...options.env["XDG_RUNTIME_DIR"] !== void 0 ? { XDG_RUNTIME_DIR: options.env["XDG_RUNTIME_DIR"] } : {},
    ...options.env["DBUS_SESSION_BUS_ADDRESS"] !== void 0 ? { DBUS_SESSION_BUS_ADDRESS: options.env["DBUS_SESSION_BUS_ADDRESS"] } : {},
    ...options.env["ELECTRON_RUN_AS_NODE"] !== void 0 ? { ELECTRON_RUN_AS_NODE: options.env["ELECTRON_RUN_AS_NODE"] } : {},
    ...options.env["ZCODE_BRIDGE_PLUGIN_MODE"] !== void 0 ? { ZCODE_BRIDGE_PLUGIN_MODE: options.env["ZCODE_BRIDGE_PLUGIN_MODE"] } : {},
    ...options.env["ZCODE_BRIDGE_HOST_PROFILE"] !== void 0 ? { ZCODE_BRIDGE_HOST_PROFILE: options.env["ZCODE_BRIDGE_HOST_PROFILE"] } : {},
    ...options.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] !== void 0 ? { ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: options.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] } : {}
  };
  const systemdRunArgs = [
    "--user",
    "--collect",
    "--expand-environment=no",
    "--unit",
    unit,
    "--property",
    "Type=exec",
    "--property",
    "Restart=on-failure",
    "--property",
    "RestartSec=5s",
    // Bridge workers survive runner recovery; only TaskManager verifies their cleanup.
    "--property",
    "KillMode=process",
    // Restart indefinitely: a crashed runner resumes from persisted intent.
    "--property",
    "StartLimitIntervalSec=0",
    "--property",
    `StandardOutput=append:${logPath}`,
    "--property",
    `StandardError=append:${logPath}`,
    // User services inherit the manager environment; clear it before Node starts.
    "/usr/bin/env",
    "-i",
    ...Object.entries(forwarded).map(([key, value]) => `${key}=${value}`),
    command,
    ...args
  ];
  return { unit, logPath, command, args, systemdRunArgs };
}
function createSystemdRunSupervisor(deps = {}) {
  const run = deps.execFile ?? defaultExecFile;
  const inspect = async (unit) => {
    const { stdout } = await run("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,MainPID,ControlGroup"]);
    const fields = Object.fromEntries(stdout.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return { active: fields["ActiveState"] ?? "", pid: Number(fields["MainPID"]), group: fields["ControlGroup"] ?? "", loaded: fields["LoadState"] ?? "" };
  };
  return {
    async start(plan) {
      if (process.platform !== "linux") {
        throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", `scheduled goals require Linux systemd-run --user; platform ${process.platform} is not supported`);
      }
      const previous = await inspect(plan.unit).catch(() => null);
      if (previous?.active === "active" && previous.pid > 0 && previous.group) return { unit: plan.unit };
      let startFailed = false;
      try {
        await run("systemd-run", [...plan.systemdRunArgs]);
      } catch {
        startFailed = true;
      }
      let lastState = "unknown";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const observed = await inspect(plan.unit).catch(() => null);
        lastState = observed?.active ?? "unavailable";
        if (observed?.active === "active" && observed.pid > 0 && observed.group) return { unit: plan.unit };
        if (observed?.active === "failed" || startFailed && observed?.loaded === "not-found") break;
        await sleep3(150);
      }
      throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", `schedule runner unit ${plan.unit} did not become active with a MainPID and cgroup (last state: ${lastState}); inspect ${plan.logPath}`);
    },
    async stop(unit) {
      try {
        await run("systemctl", ["--user", "stop", unit]);
      } catch {
        const observed = await inspect(unit).catch(() => null);
        if (observed?.loaded === "not-found" || observed?.active === "inactive" && observed.pid === 0) return;
        throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", `could not stop schedule runner unit ${unit}`);
      }
    }
  };
}
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultExecFile(file, args) {
  return execFile(file, args, { timeout: 15e3, encoding: "utf8" });
}

// src/schedule/types.ts
var START_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
var THREAD_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

// src/schedule/controller.ts
var DELIVERY_BACKOFF_BASE_MS = 3e4;
var DELIVERY_BACKOFF_MAX_MS = 10 * 6e4;
var ScheduleController = class {
  #store;
  #manager;
  #supervisor;
  #runnerEntryPath;
  #dataRoot;
  #env;
  #notifier;
  #nodeExecutable;
  #now;
  constructor(options) {
    this.#store = options.store;
    this.#manager = options.manager;
    this.#supervisor = options.supervisor;
    this.#runnerEntryPath = options.runnerEntryPath;
    this.#dataRoot = options.dataRoot;
    this.#env = options.env;
    this.#notifier = options.notifier ?? null;
    this.#nodeExecutable = options.nodeExecutable;
    this.#now = options.now ?? (() => /* @__PURE__ */ new Date());
  }
  get store() {
    return this.#store;
  }
  readSpec(taskId2) {
    return this.#store.readSpec(taskId2);
  }
  readState(taskId2) {
    return this.#store.readState(taskId2);
  }
  /** The MCP host refreshes the App pipe location on reconnection; the
   * runner resolves it from this record per send. */
  noteAppPipePath(pipePath) {
    this.#store.writeRuntime({ app_pipe_path: pipePath, updated_at: this.#now().toISOString() });
  }
  async submit(input) {
    if (!Number.isFinite(Date.parse(input.start_at)) || !START_AT_PATTERN.test(input.start_at)) {
      throw new ScheduleError("SCHEDULE_INVALID", "start_at must be an ISO 8601 datetime with a timezone offset");
    }
    if (!THREAD_ID_PATTERN.test(input.thread_id)) {
      throw new ScheduleError("SCHEDULE_INVALID", "thread_id must be a UUID identifying the original Codex chat");
    }
    const taskId2 = input.task.task_id;
    mkdirSync4(this.#store.scheduleDir(taskId2), { recursive: true, mode: 448 });
    return withProcessLock(path8.join(this.#store.scheduleDir(taskId2), "state.lock"), async () => {
      let spec;
      if (this.#store.hasSchedule(taskId2)) {
        spec = this.#store.readSpec(taskId2);
        if (stableJson({ task: spec.task, start_at: spec.start_at, thread_id: spec.thread_id }) !== stableJson({ task: input.task, start_at: input.start_at, thread_id: input.thread_id })) {
          throw new ScheduleError("SCHEDULE_CONFLICT", `schedule ${taskId2} already exists with a different request`);
        }
      } else {
        const existing = await this.#manager.getStatus(taskId2).catch((error) => {
          if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
          throw error;
        });
        if (existing !== null) throw new ScheduleError("SCHEDULE_CONFLICT", `task_id ${taskId2} already belongs to a non-scheduled Bridge task`);
        spec = {
          task_id: taskId2,
          task: input.task,
          start_at: input.start_at,
          thread_id: input.thread_id,
          created_at: this.#now().toISOString(),
          supervisor_unit: `zcode-bridge-schedule-${randomUUID3()}`
        };
        this.#store.writeSpec(spec);
      }
      let state = this.#store.hasState(taskId2) ? this.#store.readState(taskId2) : initialState(taskId2, spec.created_at);
      this.#store.writeState(state);
      if (!["accepted", "cancelled", "failed"].includes(state.status)) state = await this.#startLocked(spec, state);
      return this.#receiptFrom(spec, state);
    }, 6e4);
  }
  async #startLocked(spec, state) {
    const plan = planSystemdRunUnit({
      unit: spec.supervisor_unit,
      runnerEntryPath: this.#runnerEntryPath,
      scheduleDir: this.#store.scheduleDir(spec.task_id),
      dataRoot: this.#dataRoot,
      taskId: spec.task_id,
      env: this.#env,
      nodeExecutable: this.#nodeExecutable
    });
    const prepared = { ...state, supervisor: state.supervisor ?? {
      unit: spec.supervisor_unit,
      log_path: plan.logPath,
      started_at: null
    }, updated_at: this.#now().toISOString() };
    this.#store.writeState(prepared);
    try {
      await this.#supervisor.start(plan);
    } catch (error) {
      this.#store.writeState({ ...prepared, failure_reason: boundedErrorMessage(error, 500), updated_at: this.#now().toISOString() });
      throw error;
    }
    const started = { ...prepared, failure_reason: null, supervisor: {
      unit: plan.unit,
      log_path: plan.logPath,
      started_at: prepared.supervisor.started_at ?? this.#now().toISOString()
    }, updated_at: this.#now().toISOString() };
    this.#store.writeState(started);
    return started;
  }
  async status(taskId2) {
    const spec = this.#store.readSpec(taskId2);
    const state = this.#store.readState(taskId2);
    return {
      task_id: taskId2,
      schedule: {
        status: state.status,
        start_at: spec.start_at,
        thread_id: spec.thread_id,
        created_at: spec.created_at,
        updated_at: state.updated_at,
        cancel_requested: state.cancel_requested,
        supervisor: state.supervisor ? { unit: state.supervisor.unit, log_path: state.supervisor.log_path } : null,
        failure_reason: state.failure_reason
      },
      execution: await this.#executionView(taskId2),
      goal: {
        attention: state.attention,
        attempt_under_review: state.attempt_under_review,
        review: state.review
      },
      notifications: this.#store.listNotifications(taskId2).map((notification) => ({
        event_id: notification.event_id,
        reason: notification.reason,
        attempt: notification.attempt,
        delivery: notification.delivery
      }))
    };
  }
  /** Idempotent dispatch of the derived task (runner + recovery entry). The
   * TaskManager's own submission idempotency prevents a second execution. */
  async dispatch(taskId2) {
    return this.#locked(taskId2, async (state, spec) => {
      if (state.status === "dispatched" || state.status === "awaiting_review") return { dispatched: true };
      if (state.cancel_requested || state.status !== "scheduled") return { dispatched: false };
      let receipt;
      try {
        receipt = await this.#manager.createTask(deriveScheduledTask(spec.task));
      } catch (error) {
        this.#failLocked(taskId2, state, "dispatch_failed", boundedErrorMessage(error, 500));
        this.#enqueueLocked(taskId2, spec, { attempt: 1, reason: "dispatch_failed", eventId: buildEventId(taskId2, 1, "dispatch_failed"), errorCode: "dispatch_failed" });
        throw new ScheduleError("SCHEDULE_STATE", `scheduled task ${taskId2} could not be dispatched: ${boundedErrorMessage(error, 300)}`);
      }
      this.#store.writeState({
        ...state,
        status: "dispatched",
        dispatched_at: this.#now().toISOString(),
        attention: null,
        updated_at: this.#now().toISOString()
      });
      void receipt;
      return { dispatched: true };
    });
  }
  /** Quiet same-session continuation (acceptance_met=false or verified
   * timeout). Guarded against a persisted stop intent; operation_id makes a
   * crash-retry replay the same continuation. */
  async autoContinue(taskId2, attempt, feedback, operationId) {
    return this.#locked(taskId2, async (state) => {
      if (state.cancel_requested || ["cancelled", "accepted", "failed"].includes(state.status)) return { continued: false, reason: `schedule is ${state.status}` };
      const current = await this.#manager.getStatus(taskId2);
      if (current.attempt > attempt) return { continued: true };
      if (current.observation?.cleanup !== "verified") return { continued: false, reason: "process cleanup is not verified" };
      const result = await this.#manager.getResult(taskId2);
      if (result.session_id === null) return { continued: false, reason: "no saved ZCode session to resume" };
      try {
        await this.#manager.continueTask({ task_id: taskId2, feedback, operation_id: operationId, expected_attempt: attempt });
      } catch (error) {
        return { continued: false, reason: boundedErrorMessage(error, 300) };
      }
      this.#store.writeState({ ...state, status: "dispatched", attempt_under_review: null, attention: null, updated_at: this.#now().toISOString() });
      return { continued: true };
    });
  }
  /** A new attempt began (also when the Codex host continued the task itself):
   * attention and a stale review window give way to active monitoring. */
  async noteActiveAttempt(taskId2, attempt) {
    await this.#locked(taskId2, async (state) => {
      if (state.status === "accepted" || state.status === "cancelled" || state.status === "failed") return;
      const reference = Math.max(state.attention?.attempt ?? 0, state.attempt_under_review ?? 0);
      if (attempt <= reference) return;
      this.#store.writeState({
        ...state,
        status: state.status === "awaiting_review" ? "dispatched" : state.status,
        attempt_under_review: null,
        attention: null,
        updated_at: this.#now().toISOString()
      });
    });
  }
  /** Terminal attempt with acceptance_met=true: wake the original thread for
   * independent review; the goal now waits for zcode_schedule_review. */
  async requestReview(taskId2, attempt) {
    await this.#locked(taskId2, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      if (state.status === "awaiting_review" && state.attempt_under_review === attempt) return;
      const eventId = buildEventId(taskId2, attempt, "review_requested");
      this.#enqueueLocked(taskId2, spec, { attempt, reason: "review_requested", eventId });
      this.#store.writeState({
        ...state,
        status: "awaiting_review",
        attempt_under_review: attempt,
        attention: { reason: "review_requested", attempt, event_id: eventId, set_at: this.#now().toISOString() },
        updated_at: this.#now().toISOString()
      });
    });
  }
  /** Persist the escalation and its wakeup event; no automatic retry or
   * approval ever follows. Idempotent per (attempt, reason, suffix). */
  async escalate(taskId2, attempt, reason, options = {}) {
    await this.#locked(taskId2, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      const eventId = buildEventId(taskId2, attempt, reason, options.requestId ?? "");
      if (state.attention?.event_id === eventId) return;
      this.#enqueueLocked(taskId2, spec, { attempt, reason, eventId, requestId: options.requestId, errorCode: options.errorCode });
      this.#store.writeState({
        ...state,
        attention: { reason, attempt, event_id: eventId, set_at: this.#now().toISOString(), ...options.detail !== void 0 ? { detail: options.detail } : {} },
        updated_at: this.#now().toISOString()
      });
    });
  }
  /** Wake once per still-pending interaction request; never auto-replies. */
  async notifyPendingInteraction(taskId2, attempt, request) {
    await this.#locked(taskId2, async (state, spec) => {
      if (state.cancel_requested || state.status === "cancelled" || state.status === "accepted" || state.status === "failed") return;
      if (state.notified_interactions.includes(request.request_id)) return;
      const eventId = buildEventId(taskId2, attempt, "pending_interaction", request.request_id);
      this.#enqueueLocked(taskId2, spec, { attempt, reason: "pending_interaction", eventId, requestId: request.request_id });
      this.#store.writeState({
        ...state,
        notified_interactions: [...state.notified_interactions, request.request_id],
        attention: { reason: "pending_interaction", attempt, event_id: eventId, set_at: this.#now().toISOString(), detail: request.request_id },
        updated_at: this.#now().toISOString()
      });
    });
  }
  /** Independent Codex review of the attempt that requested it. Rejection
   * requires feedback and resumes the SAME session via continueTask under a
   * stable operation id; acceptance ends the goal. */
  async review(input) {
    return this.#locked(input.task_id, async (state) => {
      if (state.cancel_requested || state.status === "cancelled") throw new ScheduleError("SCHEDULE_STATE", "schedule has a persisted stop intent");
      const prior = state.review;
      if (prior?.attempt === input.attempt) {
        if (prior.accepted !== input.accepted || prior.feedback !== input.feedback) throw new ScheduleError("SCHEDULE_STATE", "this attempt already has a different review");
        return prior.accepted ? { task_id: input.task_id, attempt: input.attempt, accepted: true, action: "accepted" } : { task_id: input.task_id, attempt: input.attempt, accepted: false, action: "continued", receipt: prior.receipt };
      }
      if (state.review_intent?.attempt === input.attempt) {
        const intent2 = state.review_intent;
        if (intent2.accepted !== input.accepted || intent2.feedback !== input.feedback) throw new ScheduleError("SCHEDULE_STATE", "a different review is already in flight");
        return this.#finishReviewLocked(input.task_id, state, input, intent2.operation_id);
      }
      if (state.status !== "awaiting_review" || input.attempt !== state.attempt_under_review) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "this attempt is not awaiting review");
      if (!input.accepted && !input.feedback?.trim()) throw new ScheduleError("SCHEDULE_FEEDBACK_REQUIRED", "rejecting a review requires concrete feedback");
      const current = await this.#manager.getStatus(input.task_id);
      if (current.attempt !== input.attempt || !["completed", "failed", "waiting_for_master"].includes(current.status)) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "execution has advanced since this review was requested");
      const intent = {
        attempt: input.attempt,
        accepted: input.accepted,
        feedback: input.feedback,
        operation_id: reviewContinueOperationId(input.task_id, input.attempt),
        set_at: this.#now().toISOString()
      };
      const prepared = { ...state, review_intent: intent, updated_at: intent.set_at };
      this.#store.writeState(prepared);
      return this.#finishReviewLocked(input.task_id, prepared, input, intent.operation_id);
    });
  }
  /** Complete an authorized review after its MCP caller disappears. */
  async recoverReview(taskId2) {
    await this.#locked(taskId2, async (state, spec) => {
      if (!state.review_intent || state.cancel_requested || ["accepted", "cancelled", "failed"].includes(state.status)) return;
      const intent = state.review_intent;
      try {
        await this.#finishReviewLocked(taskId2, state, {
          task_id: taskId2,
          attempt: intent.attempt,
          accepted: intent.accepted,
          feedback: intent.feedback
        }, intent.operation_id);
      } catch (error) {
        const current = await this.#manager.getStatus(taskId2);
        if (current.attempt > intent.attempt) {
          this.#store.writeState({
            ...state,
            status: "dispatched",
            attempt_under_review: null,
            attention: null,
            review_intent: null,
            failure_reason: "The saved review was superseded by a newer task attempt.",
            updated_at: this.#now().toISOString()
          });
          return;
        }
        if (!(error instanceof ScheduleError || error instanceof TaskManagerError)) throw error;
        const eventId = buildEventId(taskId2, intent.attempt, "needs_decision", "review_recovery");
        this.#enqueueLocked(taskId2, spec, { attempt: intent.attempt, reason: "needs_decision", eventId });
        this.#store.writeState({
          ...state,
          review_intent: null,
          failure_reason: boundedErrorMessage(error, 300),
          attention: { reason: "needs_decision", attempt: intent.attempt, event_id: eventId, set_at: this.#now().toISOString() },
          updated_at: this.#now().toISOString()
        });
      }
    });
  }
  async #finishReviewLocked(taskId2, state, input, operationId) {
    if (input.accepted) {
      const tasksRoot = path8.join(this.#dataRoot, ".tasks");
      mkdirSync4(tasksRoot, { recursive: true, mode: 448 });
      return withProcessLock(path8.join(tasksRoot, ".manager.lock"), async () => {
        const current = await this.#manager.getStatus(taskId2);
        if (current.attempt !== input.attempt || !["completed", "failed", "waiting_for_master"].includes(current.status)) throw new ScheduleError("SCHEDULE_STALE_REVIEW", "execution has advanced since this review was requested");
        if (current.observation?.cleanup !== "verified") throw new ScheduleError("SCHEDULE_STATE", "process cleanup must be verified before acceptance");
        const reviewedAt2 = this.#now().toISOString();
        this.#store.writeState({
          ...state,
          status: "accepted",
          attempt_under_review: null,
          attention: null,
          review_intent: null,
          review: { attempt: input.attempt, accepted: true, feedback: input.feedback, reviewed_at: reviewedAt2, operation_id: operationId, outcome: "accepted" },
          updated_at: reviewedAt2
        });
        return { task_id: taskId2, attempt: input.attempt, accepted: true, action: "accepted" };
      });
    }
    const receipt = await this.#manager.continueTask({
      task_id: taskId2,
      feedback: buildReviewContinueFeedback(input.feedback ?? "", input.attempt),
      operation_id: operationId,
      expected_attempt: input.attempt
    });
    const reviewedAt = this.#now().toISOString();
    this.#store.writeState({
      ...state,
      status: "dispatched",
      attempt_under_review: null,
      attention: null,
      review_intent: null,
      review: { attempt: input.attempt, accepted: false, feedback: input.feedback, reviewed_at: reviewedAt, operation_id: operationId, outcome: "continued", receipt },
      updated_at: reviewedAt
    });
    return { task_id: taskId2, attempt: input.attempt, accepted: false, action: "continued", receipt };
  }
  /** Stop intent persists FIRST, then the existing TaskManager cancellation
   * verifies cleanup; a cleanup failure surfaces and keeps the stop intent. */
  async cancel(taskId2) {
    return this.#locked(taskId2, async (state, spec) => {
      if (state.status === "cancelled") {
        if (state.supervisor) await this.#supervisor.stop(state.supervisor.unit);
        return { schedule_status: "cancelled", task_status: await this.#taskStatusOrNull(taskId2) };
      }
      if (state.status === "accepted") throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId2} was accepted; nothing to cancel`);
      this.#store.writeState({ ...state, cancel_requested: true, updated_at: this.#now().toISOString() });
      const tasksRoot = path8.join(this.#dataRoot, ".tasks");
      mkdirSync4(tasksRoot, { recursive: true, mode: 448 });
      let attempt = state.attempt_under_review ?? state.attention?.attempt ?? 1;
      try {
        while (true) {
          const committed = await withProcessLock(path8.join(tasksRoot, ".manager.lock"), async () => {
            const execution = await this.#manager.getStatus(taskId2).catch((error) => {
              if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
              throw error;
            });
            attempt = execution?.attempt ?? attempt;
            if (execution && (!["completed", "failed", "cancelled", "waiting_for_master"].includes(execution.status) || execution.observation?.cleanup !== "verified")) return false;
            this.#store.writeState({
              ...this.#store.readState(taskId2),
              status: "cancelled",
              attention: null,
              attempt_under_review: null,
              review_intent: null,
              failure_reason: null,
              updated_at: this.#now().toISOString()
            });
            for (const notification of this.#store.listNotifications(taskId2)) {
              if (!["sent", "superseded"].includes(notification.delivery.state)) {
                this.#store.writeNotification(taskId2, { ...notification, delivery: { state: "superseded", attempts: notification.delivery.attempts } });
              }
            }
            return true;
          });
          if (committed) break;
          try {
            await this.#manager.cancelTask(taskId2);
          } catch (error) {
            if (!(error instanceof TaskManagerError && error.code === "TASK_STATE")) throw error;
          }
          const after = await this.#manager.getStatus(taskId2);
          if (after.observation?.cleanup !== "verified") throw new ScheduleError("SCHEDULE_STATE", "cancellation returned without verified process cleanup");
        }
      } catch (error) {
        const eventId = buildEventId(taskId2, attempt, "cancel_failed");
        this.#enqueueLocked(taskId2, spec, { attempt, reason: "cancel_failed", eventId });
        this.#store.writeState({
          ...this.#store.readState(taskId2),
          status: "failed",
          cancel_requested: true,
          failure_reason: boundedErrorMessage(error, 300),
          attention: {
            reason: "cancel_failed",
            attempt,
            event_id: eventId,
            set_at: this.#now().toISOString()
          },
          updated_at: this.#now().toISOString()
        });
        throw error;
      }
      if (state.supervisor) await this.#supervisor.stop(state.supervisor.unit);
      return { schedule_status: "cancelled", task_status: await this.#taskStatusOrNull(taskId2) };
    });
  }
  async fail(taskId2, reason, detail) {
    await this.#locked(taskId2, async (state, spec) => {
      if (state.cancel_requested || ["accepted", "cancelled", "failed"].includes(state.status)) return;
      this.#failLocked(taskId2, state, reason, detail);
      this.#enqueueLocked(taskId2, spec, {
        attempt: state.attempt_under_review ?? 1,
        reason,
        eventId: buildEventId(taskId2, state.attempt_under_review ?? 1, reason)
      });
    });
  }
  /** Sends every undelivered outbox event (at-least-once); failures persist
   * bounded errors and a retry deadline. */
  async deliverPending(taskId2) {
    await this.#locked(taskId2, async (state, spec) => {
      const attention = state.attention;
      if (attention && !this.#store.hasNotification(taskId2, attention.event_id)) {
        this.#enqueueLocked(taskId2, spec, {
          attempt: attention.attempt,
          reason: attention.reason,
          eventId: attention.event_id,
          requestId: attention.reason === "pending_interaction" ? attention.detail : void 0
        });
      }
      const pipePath = this.#store.readRuntime()?.app_pipe_path ?? null;
      const current = await this.#manager.getStatus(taskId2).catch((error) => {
        if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
        throw error;
      });
      for (const notification of this.#store.listNotifications(taskId2)) {
        if (["sent", "superseded"].includes(notification.delivery.state)) continue;
        if (state.cancel_requested && notification.reason !== "cancel_failed" || ["cancelled", "accepted"].includes(state.status) || current && notification.attempt < current.attempt) {
          this.#store.writeNotification(taskId2, { ...notification, delivery: { state: "superseded", attempts: notification.delivery.attempts } });
          continue;
        }
        if (!this.#notifier) continue;
        if (notification.delivery.next_retry_at && Date.parse(notification.delivery.next_retry_at) > this.#now().getTime()) continue;
        const attempts = notification.delivery.attempts + 1;
        const attemptedAt = this.#now().toISOString();
        try {
          if (pipePath === null) throw new Error("Codex App tools pipe is not configured");
          await this.#notifier.send({
            pipePath,
            threadId: notification.thread_id,
            callId: `${randomUUID3()}`,
            message: notification.message
          });
          this.#store.writeNotification(taskId2, { ...notification, delivery: { state: "sent", attempts, last_attempt_at: attemptedAt, sent_at: attemptedAt } });
        } catch (error) {
          this.#store.writeNotification(taskId2, { ...notification, delivery: {
            state: "failed",
            attempts,
            last_error: boundedErrorMessage(error, 300),
            last_attempt_at: attemptedAt,
            next_retry_at: new Date(this.#now().getTime() + Math.min(DELIVERY_BACKOFF_BASE_MS * attempts, DELIVERY_BACKOFF_MAX_MS)).toISOString()
          } });
        }
      }
    });
  }
  hasUndeliveredNotifications(taskId2) {
    return this.#store.listNotifications(taskId2).some((notification) => !["sent", "superseded"].includes(notification.delivery.state));
  }
  async #taskStatusOrNull(taskId2) {
    try {
      return (await this.#manager.getStatus(taskId2)).status;
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    }
  }
  async #executionView(taskId2) {
    let status;
    try {
      status = await this.#manager.getStatus(taskId2);
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    }
    let result = null;
    if (["completed", "failed", "cancelled", "waiting_for_master"].includes(status.status)) {
      result = await this.#manager.getResult(taskId2).catch((error) => {
        if (error instanceof TaskManagerError && error.code === "TASK_NOT_FINISHED") return null;
        throw error;
      });
    }
    return {
      status: status.status,
      attempt: status.attempt,
      ...result?.error_code !== void 0 ? { error_code: result.error_code } : {},
      needs_master_decision: result?.needs_master_decision ?? null,
      ...result?.acceptance_met !== void 0 ? { acceptance_met: result.acceptance_met } : {}
    };
  }
  #failLocked(taskId2, state, reason, detail) {
    this.#store.writeState({
      ...state,
      status: "failed",
      failure_reason: detail,
      attention: { reason, attempt: state.attempt_under_review ?? 1, event_id: buildEventId(taskId2, state.attempt_under_review ?? 1, reason), set_at: this.#now().toISOString(), detail },
      updated_at: this.#now().toISOString()
    });
  }
  #enqueueLocked(taskId2, spec, event) {
    if (this.#store.hasNotification(taskId2, event.eventId)) return;
    this.#store.writeNotification(taskId2, {
      event_id: event.eventId,
      task_id: taskId2,
      attempt: event.attempt,
      reason: event.reason,
      thread_id: spec.thread_id,
      message: buildNotificationMessage({ eventId: event.eventId, taskId: taskId2, attempt: event.attempt, reason: event.reason, requestId: event.requestId, errorCode: event.errorCode }),
      created_at: this.#now().toISOString(),
      delivery: { state: "pending", attempts: 0 }
    });
  }
  #receiptFrom(spec, state) {
    return {
      task_id: spec.task_id,
      status: state.status,
      start_at: spec.start_at,
      thread_id: spec.thread_id,
      created_at: spec.created_at,
      supervisor: state.supervisor ? { unit: state.supervisor.unit, log_path: state.supervisor.log_path } : null
    };
  }
  async #locked(taskId2, operation) {
    this.#store.readSpec(taskId2);
    return withProcessLock(path8.join(this.#store.scheduleDir(taskId2), "state.lock"), async () => {
      const spec = this.#store.readSpec(taskId2);
      return operation(this.#store.readState(taskId2), spec);
    }, 6e4);
  }
};
function initialState(taskId2, createdAt) {
  return {
    task_id: taskId2,
    status: "scheduled",
    created_at: createdAt,
    updated_at: createdAt,
    dispatched_at: null,
    attempt_under_review: null,
    attention: null,
    cancel_requested: false,
    review_intent: null,
    review: null,
    notified_interactions: [],
    supervisor: null,
    failure_reason: null
  };
}

// src/schedule/store.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "node:fs";
import path9 from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
function schedulesRootFor(dataRoot2) {
  return path9.join(dataRoot2, ".schedules");
}
function writeJsonAtomic(file, value) {
  mkdirSync5(path9.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${process.pid}.${randomUUID4()}.tmp`;
  writeFileSync4(temp, JSON.stringify(value, null, 2), { mode: 384 });
  atomicRenameSync(temp, file);
}
var ScheduleStore = class {
  #root;
  constructor(schedulesRoot) {
    this.#root = schedulesRoot;
  }
  get root() {
    return this.#root;
  }
  scheduleDir(taskId2) {
    return path9.join(this.#root, taskId2);
  }
  hasSchedule(taskId2) {
    return existsSync5(path9.join(this.scheduleDir(taskId2), "spec.json"));
  }
  hasState(taskId2) {
    return existsSync5(path9.join(this.scheduleDir(taskId2), "state.json"));
  }
  readSpec(taskId2) {
    try {
      return JSON.parse(readFileSync4(path9.join(this.scheduleDir(taskId2), "spec.json"), "utf8"));
    } catch (error) {
      if (!this.hasSchedule(taskId2)) throw new ScheduleError("SCHEDULE_NOT_FOUND", `unknown schedule: ${taskId2}`);
      throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId2} spec could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  writeSpec(spec) {
    writeJsonAtomic(path9.join(this.scheduleDir(spec.task_id), "spec.json"), spec);
  }
  readState(taskId2) {
    try {
      return JSON.parse(readFileSync4(path9.join(this.scheduleDir(taskId2), "state.json"), "utf8"));
    } catch (error) {
      if (!this.hasSchedule(taskId2)) throw new ScheduleError("SCHEDULE_NOT_FOUND", `unknown schedule: ${taskId2}`);
      throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId2} state could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  writeState(state) {
    writeJsonAtomic(path9.join(this.scheduleDir(state.task_id), "state.json"), state);
  }
  notificationPath(taskId2) {
    return path9.join(this.scheduleDir(taskId2), "outbox.json");
  }
  hasNotification(taskId2, eventId) {
    return this.listNotifications(taskId2).some((record2) => record2.event_id === eventId);
  }
  writeNotification(taskId2, notification) {
    const records = this.listNotifications(taskId2);
    const previous = records.findIndex((record2) => record2.event_id === notification.event_id);
    if (previous < 0) records.push(notification);
    else records[previous] = notification;
    writeJsonAtomic(this.notificationPath(taskId2), records);
  }
  listNotifications(taskId2) {
    let records;
    try {
      records = JSON.parse(readFileSync4(this.notificationPath(taskId2), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
    return records;
  }
  readRuntime() {
    try {
      return JSON.parse(readFileSync4(path9.join(this.#root, "runtime.json"), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  writeRuntime(info) {
    writeJsonAtomic(path9.join(this.#root, "runtime.json"), info);
  }
};

// src/schedule/runner.ts
function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "waiting_for_master";
}
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runSchedulerRunner(options) {
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const sleep4 = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 2e3;
  const waitTickMs = options.waitTickMs ?? 1e3;
  const { taskId: taskId2, controller: controller2, manager: manager2, taskStore: taskStore2 } = options;
  while (true) {
    const before = controller2.readState(taskId2);
    if (before.status === "failed") return drainOutbox(controller2, taskId2, "schedule_failed", sleep4, pollIntervalMs);
    if (before.cancel_requested && before.status !== "cancelled") {
      try {
        await controller2.cancel(taskId2);
      } catch {
        if (controller2.readState(taskId2).status !== "failed") throw new Error("schedule cancellation recovery failed before persisting its outcome");
      }
    }
    await controller2.recoverReview(taskId2);
    const state = controller2.readState(taskId2);
    if (state.status === "cancelled") return drainOutbox(controller2, taskId2, "cancelled", sleep4, pollIntervalMs);
    if (state.status === "accepted") return drainOutbox(controller2, taskId2, "accepted", sleep4, pollIntervalMs);
    if (state.status === "failed") return drainOutbox(controller2, taskId2, "schedule_failed", sleep4, pollIntervalMs);
    const startAtMs = Date.parse(controller2.readSpec(taskId2).start_at);
    const remaining = startAtMs - now().getTime();
    if (remaining <= 0) break;
    await sleep4(Math.max(1, Math.min(waitTickMs, remaining)));
  }
  await controller2.dispatch(taskId2);
  while (true) {
    const before = controller2.readState(taskId2);
    if (before.status === "failed") return drainOutbox(controller2, taskId2, "schedule_failed", sleep4, pollIntervalMs);
    if (before.cancel_requested && before.status !== "cancelled") {
      try {
        await controller2.cancel(taskId2);
      } catch {
        if (controller2.readState(taskId2).status !== "failed") throw new Error("schedule cancellation recovery failed before persisting its outcome");
      }
    }
    await controller2.recoverReview(taskId2);
    const state = controller2.readState(taskId2);
    if (state.status === "cancelled") return drainOutbox(controller2, taskId2, "cancelled", sleep4, pollIntervalMs);
    if (state.status === "accepted") return drainOutbox(controller2, taskId2, "accepted", sleep4, pollIntervalMs);
    if (state.status === "failed") return drainOutbox(controller2, taskId2, "schedule_failed", sleep4, pollIntervalMs);
    let status;
    try {
      status = await manager2.getStatus(taskId2);
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") {
        await controller2.fail(taskId2, "task_failed", "The dispatched task record is missing; execution was not recreated.");
        return drainOutbox(controller2, taskId2, "task_record_missing", sleep4, pollIntervalMs);
      }
      throw error;
    }
    if (!isTerminal(status.status)) {
      await controller2.noteActiveAttempt(taskId2, status.attempt);
      for (const request of taskStore2.listPendingInteractions(taskId2)) {
        if (!request.request_id.startsWith(`${String(status.attempt)}:`)) continue;
        await controller2.notifyPendingInteraction(taskId2, status.attempt, request);
      }
    } else {
      const alreadyHandled = state.status === "awaiting_review" && state.attempt_under_review === status.attempt || state.attention !== null && state.attention.attempt === status.attempt && state.attention.reason !== "pending_interaction";
      if (!alreadyHandled) {
        const result = await manager2.getResult(taskId2).catch((error) => {
          if (error instanceof TaskManagerError && error.code === "TASK_NOT_FINISHED") return null;
          throw error;
        });
        if (result !== null && result.attempt === status.attempt) {
          const decision = evaluateTerminalResult(taskId2, result);
          switch (decision.action) {
            case "continue": {
              const outcome = await controller2.autoContinue(taskId2, status.attempt, decision.feedback, decision.operation_id);
              if (!outcome.continued) {
                await controller2.escalate(taskId2, status.attempt, "continue_failed", { detail: outcome.reason });
              }
              break;
            }
            case "request_review":
              await controller2.requestReview(taskId2, status.attempt);
              break;
            case "escalate":
              await controller2.escalate(taskId2, status.attempt, decision.reason, { errorCode: decision.detail });
              break;
            default:
              break;
          }
        }
      }
    }
    await controller2.deliverPending(taskId2);
    await sleep4(pollIntervalMs);
  }
}
async function drainOutbox(controller2, taskId2, reason, sleep4, pollIntervalMs) {
  do {
    await controller2.deliverPending(taskId2);
    if (controller2.hasUndeliveredNotifications(taskId2)) await sleep4(pollIntervalMs);
  } while (controller2.hasUndeliveredNotifications(taskId2));
  return { exit_reason: reason };
}

// src/schedule/runner-main.ts
var [dataRoot, taskId] = process.argv.slice(2);
if (!dataRoot || !taskId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(taskId) || !path10.isAbsolute(dataRoot)) {
  console.error("usage: node schedule-runner.mjs <dataRoot> <taskId>");
  process.exit(2);
}
var hostText = process.env["ZCODE_BRIDGE_HOST_PROFILE"];
var host = hostText ? validateHostProfile(JSON.parse(hostText)) : void 0;
var taskStore = new TaskStore(dataRoot);
var manager = new BridgeTaskManager({
  store: taskStore,
  workspaceProvider: new DirectWorkspaceProvider(),
  maxConcurrentWorkers: Number(process.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] ?? "8"),
  spawnWorker: createWorkerSpawner(host),
  probe: createPlatformProbe()
});
var controller = new ScheduleController({
  store: new ScheduleStore(schedulesRootFor(dataRoot)),
  manager,
  supervisor: createSystemdRunSupervisor(),
  runnerEntryPath: process.argv[1],
  dataRoot,
  env: process.env,
  notifier: {
    send: async ({ pipePath, threadId, callId, message }) => {
      await sendAppPipeNotification({ pipePath, threadId, callId, prompt: message });
    }
  }
});
var stopping = false;
var stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.error(`[schedule ${taskId}] received ${signal}; exiting (detached workers keep running)`);
  manager.dispose();
  process.exit(0);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
try {
  const outcome = await runSchedulerRunner({
    dataRoot,
    taskId,
    manager,
    controller,
    taskStore
  });
  console.error(`[schedule ${taskId}] runner finished: ${outcome.exit_reason}`);
  manager.dispose();
  process.exitCode = 0;
} catch (error) {
  console.error(`[schedule ${taskId}] runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  manager.dispose();
  process.exitCode = 1;
}
