import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { zcodeTasksIndexPath } from "./account-provider.js";
import { BridgeError } from "./errors.js";
import { resolveSessionPreferences } from "./session-preferences.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver, type RuntimeResolverOptions } from "./resolver.js";
import type { ZCodeRuntimeConfig } from "../interfaces.js";

export type DoctorStatus = "ok" | "warning" | "error" | "unknown";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  summary: string;
}

export interface DoctorReport {
  checked_at: string;
  execution_mode: string;
  checks: DoctorCheck[];
}

export interface BridgeDoctorOptions {
  env?: NodeJS.ProcessEnv;
  resolver?: RuntimeResolverOptions;
  dataRoot?: string;
  /** Explicit task-data root for the A1 active-task observation check. */
  observationDataRoot?: string;
}

/** Read-only diagnostics. This does not create a ZCode session or modify either app's data. */
export async function runBridgeDoctor(options: BridgeDoctorOptions = {}): Promise<DoctorReport> {
  const sourceEnv = options.env ?? process.env;
  let env = sourceEnv;
  const checks: DoctorCheck[] = [];
  try { env = loadPersistedRuntimeEnvironment(sourceEnv, options.resolver?.homeDir, options.resolver?.host); }
  catch (error) {
    return { checked_at: new Date().toISOString(), execution_mode: "unknown", checks: [{ name: "runtime_settings", status: "error", summary: safeError(error) }] };
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major! > 22 || (major === 22 && minor! >= 18);
  checks.push({
    name: "node",
    status: nodeOk ? "ok" : "error",
    summary: nodeOk ? `Bridge is running on Node.js ${process.versions.node}` : `Node.js ${process.versions.node}; 22.18 or newer is required`,
  });

  try {
    const gitVersion = execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    checks.push({ name: "git", status: "ok", summary: gitVersion });
  } catch {
    checks.push({ name: "git", status: "error", summary: "Git was not found or could not be started" });
  }

  let mode = "unknown";
  try {
    mode = resolveSessionPreferences(undefined, env).mode;
    checks.push({
      name: "execution_mode",
      status: mode === "yolo" ? "warning" : "ok",
      summary: mode === "yolo"
        ? "yolo: ordinary tool operations may run without approval and use the current OS account's permissions"
        : mode,
    });
  } catch (error) {
    checks.push({ name: "execution_mode", status: "error", summary: safeError(error) });
  }

  let config: ZCodeRuntimeConfig | null = null;
  try {
    config = await new NodeRuntimeResolver({ ...options.resolver, env }).resolve();
    checks.push({ name: "zcode_runtime", status: "ok", summary: "ZCode runtime was found and its configured path is readable" });
    checks.push({ name: "provider_config", status: "ok", summary: "Builtin and personal provider configs passed validation" });
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : null;
    if (code === "runtime_not_found") {
      checks.push({ name: "zcode_runtime", status: "error", summary: safeError(error) });
      checks.push({ name: "provider_config", status: "unknown", summary: "Not checked because the ZCode runtime could not be resolved" });
    } else if (code === "provider_config_missing" || code === "provider_config_invalid") {
      checks.push({ name: "zcode_runtime", status: "ok", summary: "ZCode runtime was found" });
      checks.push({ name: "provider_config", status: "error", summary: safeError(error) });
    } else {
      checks.push({ name: "zcode_runtime", status: "unknown", summary: safeError(error) });
      checks.push({ name: "provider_config", status: "unknown", summary: "Could not determine provider config status" });
    }
  }

  if (config) {
    try {
      const runtimeNodeVersion = execFileSync(config.nodeExecutable, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
      const match = /^v?(\d+)\.(\d+)\./u.exec(runtimeNodeVersion);
      const supported = Boolean(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 18)));
      checks.push({
        name: "runtime_node",
        status: supported ? "ok" : "error",
        summary: supported ? `Configured worker Node.js is ${runtimeNodeVersion}` : `Configured worker Node.js is ${runtimeNodeVersion}; 22.18 or newer is required`,
      });
    } catch {
      checks.push({ name: "runtime_node", status: "error", summary: "Configured worker Node.js could not be started" });
    }
    const modelConfigured = Boolean(env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() && env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim());
    checks.push({
      name: "model",
      status: "unknown",
      summary: modelConfigured
        ? "A Bridge default model is configured; actual app-server availability is checked when a task starts"
        : "No Bridge model override; the ZCode account default will be used and cannot be confirmed without starting a session",
    });
    // ADR-007 browser host: read-only status only. Doctor never launches a
    // browser; headless resolution is confirmed on first browser use instead.
    const browserUse = env["ZCODE_BRIDGE_BROWSER_USE"]?.trim() ?? "";
    const browserExecutable = env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"]?.trim() ?? "";
    if (browserUse === "" || browserUse === "off") {
      checks.push({
        name: "browser_host",
        status: "ok",
        summary: browserUse === "off"
          ? "Browser host is explicitly disabled; browser RPCs answer with an empty browser list"
          : "Browser host is disabled by default; browser RPCs answer with an empty browser list",
      });
    } else if (browserUse === "headless") {
      if (browserExecutable) {
        if (!path.isAbsolute(browserExecutable)) {
          checks.push({ name: "browser_host", status: "error", summary: `ZCODE_BRIDGE_BROWSER_EXECUTABLE must be an absolute path: ${browserExecutable}` });
        } else if (existsSync(browserExecutable)) {
          checks.push({ name: "browser_host", status: "ok", summary: `Headless browser host is enabled with the configured executable (${path.basename(browserExecutable)})` });
        } else {
          checks.push({ name: "browser_host", status: "error", summary: `Configured browser executable does not exist: ${browserExecutable}` });
        }
      } else {
        checks.push({ name: "browser_host", status: "unknown", summary: "Headless browser host is enabled; the managed runtime resolves an installed Chromium/Edge at first use and is not probed here" });
      }
    } else {
      checks.push({ name: "browser_host", status: "warning", summary: `ZCODE_BRIDGE_BROWSER_USE must be "off" or "headless"; got "${browserUse}" — the browser host stays disabled` });
    }
    const dataRoot = options.dataRoot ?? env["ZCODE_BRIDGE_DATA_DIR"]?.trim() ?? null;
    if (dataRoot && existsSync(dataRoot)) {
      try {
        const info = statSync(dataRoot);
        accessSync(dataRoot, constants.W_OK);
        checks.push({ name: "task_data", status: info.isDirectory() ? "ok" : "error", summary: info.isDirectory() ? "Bridge task data directory exists and is writable" : "Bridge task data path is not a directory" });
      } catch {
        checks.push({ name: "task_data", status: "error", summary: "Bridge task data directory exists but is not writable" });
      }
    } else {
      checks.push({ name: "task_data", status: "unknown", summary: "Task data directory is not configured or has not been created yet" });
    }
    const indexPath = zcodeTasksIndexPath(config.providerPersonalConfigFile);
    checks.push({
      name: "desktop_index",
      status: indexPath && existsSync(indexPath) ? "ok" : "warning",
      summary: indexPath && existsSync(indexPath)
        ? "ZCode Desktop task index file exists; Desktop refresh timing is not tested"
        : "ZCode Desktop task index file was not found at the configured data location",
    });
  } else {
    checks.push({ name: "runtime_node", status: "unknown", summary: "Not checked because runtime validation did not complete" });
    checks.push({ name: "model", status: "unknown", summary: "Not checked because runtime/provider validation did not complete" });
    checks.push({ name: "task_data", status: "unknown", summary: "Not checked because runtime validation did not complete" });
    checks.push({ name: "desktop_index", status: "unknown", summary: "Not checked because the active ZCode data location is unknown" });
  }

  checks.push({ name: "app_server", status: "unknown", summary: "Not probed; doctor does not start an app-server session" });
  checks.push({ name: "start_plan", status: "warning", summary: "Unsupported through the headless Bridge; ZCode Start Plan requires a Desktop captcha session" });
  checks.push({ name: "permission_roundtrip", status: "unknown", summary: "Bridge protocol tests exist; a real ZCode permission-approval roundtrip has not been verified" });

  // A2: report the process-identity probe capability for this platform.
  checks.push({
    name: "process_probe",
    status: process.platform === "win32" || process.platform === "linux" ? "ok" : "warning",
    summary: process.platform === "win32"
      ? "Windows process identity uses Get-Process StartTime (FileTime creation fingerprint), batched with a bounded timeout"
      : process.platform === "linux"
        ? "Linux process identity uses /proc/<pid>/stat starttime plus boot identity"
        : process.platform === "darwin"
          ? "macOS process identity uses ps lstart (second precision; coarse, not an absolute unique identity)"
          : `Process identity probing is not implemented for ${process.platform}; verdicts stay unknown`,
  });

  // B4: the Codex main-session token source. The Bridge has no access to the
  // calling host's per-turn telemetry, so the capability stays unavailable
  // here; the host feedback layer must state this rather than estimate.
  checks.push({
    name: "codex_host_tokens",
    status: "unknown",
    summary: "未取得：当前宿主未提供本次调用统计（Bridge 无法读取 Codex 主会话 per-turn token；不得用账户额度或文本估算代替）",
  });

  // A1: summarize persisted observations of non-terminal tasks via the same
  // judger used by coding_agent_status and coding_agent_events (bounded to 32 tasks).
  const observedRoot: string | null = options.observationDataRoot ?? env["ZCODE_BRIDGE_DATA_DIR"]?.trim() ?? null;
  if (observedRoot && existsSync(observedRoot)) {
    try {
      const { TaskStore: Store } = await import("../store/task-store.js");
      const { buildTaskObservation, inferExecutionStage } = await import("../observation/build.js");
      const store = new Store(observedRoot);
      const activeAll = store.listTaskIds()
        .map((taskId) => {
          try {
            const status = store.readStatus(taskId);
            return { taskId, status };
          } catch { return null; }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter((entry) => entry.status.status === "running" || entry.status.status === "queued" || entry.status.cleanup_unverified === true);
      const queued = activeAll.filter((entry) => entry.status.status === "queued");
      const cleanupPending = activeAll.filter((entry) => entry.status.cleanup_unverified === true);
      const running = activeAll.filter((entry) => entry.status.status === "running");
      const active = activeAll.slice(0, 32);
      if (active.length === 0) {
        checks.push({ name: "active_tasks", status: "ok", summary: "No queued/running tasks" });
      } else {
        const lines = active.map((entry) => {
          try {
            const observation = buildTaskObservation(store, entry.taskId, entry.status);
            const stage = inferExecutionStage(store, entry.taskId, entry.status);
            return `${entry.taskId}#${entry.status.attempt}: ${observation.activity.code} (stage ${stage}, worker ${observation.worker.state}, runtime ${observation.runtime.state}, result ${observation.result}, cleanup ${observation.cleanup}${observation.stalled ? ", stalled-hint" : ""})`;
          } catch (error) {
            return `${entry.taskId}#${entry.status.attempt}: observation unavailable (${safeError(error)})`;
          }
        });
        const oldestQueuedAt = queued
          .map((entry) => Date.parse(entry.status.created_at))
          .filter(Number.isFinite)
          .sort((a, b) => a - b)[0];
        const queueAge = oldestQueuedAt === undefined ? "unknown" : `${Math.floor(Math.max(0, Date.now() - oldestQueuedAt) / 60_000)}m`;
        const blocked = queued.length > 0 || cleanupPending.length > 0;
        const summary = `${running.length} running, ${queued.length} queued, ${cleanupPending.length} cleanup-unverified; oldest queue ${queueAge}${blocked ? "; dispatch may be blocked" : ""}. ${lines.join("; ")}`;
        checks.push({ name: "active_tasks", status: blocked ? "warning" : "ok", summary: summary.slice(0, 1_200) });
      }

      checks.push(inspectRecoveryLock(path.join(store.tasksRoot, ".recovery.lock")));
    } catch (error) {
      checks.push({ name: "active_tasks", status: "unknown", summary: safeError(error) });
    }
  }

  return { checked_at: new Date().toISOString(), execution_mode: mode, checks };
}

function inspectRecoveryLock(lockDirectory: string): DoctorCheck {
  if (!existsSync(lockDirectory)) {
    return { name: "recovery_lock", status: "ok", summary: "No persisted recovery lock is blocking task reconciliation" };
  }
  try {
    const lockStat = statSync(lockDirectory);
    const raw = readFileSync(path.join(lockDirectory, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: number; token?: string };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.token !== "string" || !owner.token) {
      throw new Error("invalid lock owner record");
    }
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs <= 30_000) {
      return { name: "recovery_lock", status: "ok", summary: "A recent recovery pass owns the reconciliation lock" };
    }
    try {
      process.kill(owner.pid!, 0);
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock is older than 30 seconds and its owner PID still exists; reconciliation may be stalled" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner PID is absent; the next recovery pass should reclaim the lock" };
      }
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner liveness could not be confirmed" };
    }
  } catch (error) {
    const ageMs = Date.now() - statSync(lockDirectory).mtimeMs;
    if (ageMs <= 30_000) {
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner record is being published or is unreadable; check again if it persists" };
    }
    return { name: "recovery_lock", status: "error", summary: `Recovery lock owner record is unreadable; automated reconciliation is blocked and needs repair (${safeError(error)})` };
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/gu, " ").slice(0, 500);
}
