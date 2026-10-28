// ADR-010 scheduler supervision: the long-lived schedule runner must be
// owned by the user's systemd manager (Type=exec, Restart=on-failure), never
// by this process, the MCP session, a PTY, or a detached nohup. Missing user
// systemd fails visibly for scheduling only. No linger changes are made and
// nothing here claims survival across OS logout/shutdown.
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createWorkerEnv } from "../runtime/child-env.js";
import { ScheduleError } from "./errors.js";

const execFile = promisify(execFileCallback);

export interface SupervisorPlan {
  readonly unit: string;
  readonly logPath: string;
  readonly command: string;
  readonly args: string[];
  readonly systemdRunArgs: readonly string[];
}

export interface SupervisorStartResult {
  readonly unit: string;
}

export interface Supervisor {
  start(plan: SupervisorPlan): Promise<SupervisorStartResult>;
  stop(unit: string): Promise<void>;
}

export interface SystemdRunOptions {
  readonly unit: string;
  /** Absolute runner entry (schedule-runner.mjs / runner-main.js). */
  readonly runnerEntryPath: string;
  readonly scheduleDir: string;
  readonly dataRoot: string;
  readonly taskId: string;
  /** Explicit worker configuration plus host-only scheduler settings. */
  readonly env: NodeJS.ProcessEnv;
  readonly nodeExecutable?: string;
}

export function planSystemdRunUnit(options: SystemdRunOptions): SupervisorPlan {
  const unit = options.unit;
  const logPath = path.join(options.scheduleDir, "runner.log");
  const command = options.nodeExecutable ?? process.execPath;
  const args = [options.runnerEntryPath, options.dataRoot, options.taskId];
  // Clear inherited manager variables before Node; pass worker configuration
  // and the host-only settings needed by this supervised runner.
  const forwarded: Record<string, string> = {
    ...createWorkerEnv(options.env),
    ...(options.env["XDG_RUNTIME_DIR"] !== undefined ? { XDG_RUNTIME_DIR: options.env["XDG_RUNTIME_DIR"] } : {}),
    ...(options.env["DBUS_SESSION_BUS_ADDRESS"] !== undefined ? { DBUS_SESSION_BUS_ADDRESS: options.env["DBUS_SESSION_BUS_ADDRESS"] } : {}),
    ...(options.env["ELECTRON_RUN_AS_NODE"] !== undefined ? { ELECTRON_RUN_AS_NODE: options.env["ELECTRON_RUN_AS_NODE"] } : {}),
    ...(options.env["ZCODE_BRIDGE_PLUGIN_MODE"] !== undefined ? { ZCODE_BRIDGE_PLUGIN_MODE: options.env["ZCODE_BRIDGE_PLUGIN_MODE"] } : {}),
    ...(options.env["ZCODE_BRIDGE_HOST_PROFILE"] !== undefined ? { ZCODE_BRIDGE_HOST_PROFILE: options.env["ZCODE_BRIDGE_HOST_PROFILE"] } : {}),
    ...(options.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] !== undefined ? { ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: options.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] } : {}),
  };
  const systemdRunArgs = [
    "--user",
    "--collect",
    "--expand-environment=no",
    "--unit", unit,
    "--property", "Type=exec",
    "--property", "Restart=on-failure",
    "--property", "RestartSec=5s",
    // Bridge workers survive runner recovery; only TaskManager verifies their cleanup.
    "--property", "KillMode=process",
    // Restart indefinitely: a crashed runner resumes from persisted intent.
    "--property", "StartLimitIntervalSec=0",
    "--property", `StandardOutput=append:${logPath}`,
    "--property", `StandardError=append:${logPath}`,
    // User services inherit the manager environment; clear it before Node starts.
    "/usr/bin/env", "-i",
    ...Object.entries(forwarded).map(([key, value]) => `${key}=${value}`),
    command,
    ...args,
  ];
  return { unit, logPath, command, args, systemdRunArgs };
}

export interface SystemdRunDeps {
  readonly execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/** Starts the supervised runner and verifies the unit actually runs under
 * the user manager before returning (the supervisor, not this process, must
 * own the long-lived runner). */
export function createSystemdRunSupervisor(deps: SystemdRunDeps = {}): Supervisor {
  const run = deps.execFile ?? defaultExecFile;
  const inspect = async (unit: string): Promise<{ active: string; pid: number; group: string; loaded: string }> => {
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
      // A lost start receipt must reuse the persisted unit, not create another runner.
      const previous = await inspect(plan.unit).catch(() => null);
      if (previous?.active === "active" && previous.pid > 0 && previous.group) return { unit: plan.unit };
      let startFailed = false;
      try {
        await run("systemd-run", [...plan.systemdRunArgs]);
      } catch {
        // The unit may already exist and be restarting; verify ownership below.
        startFailed = true;
      }
      let lastState = "unknown";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const observed = await inspect(plan.unit).catch(() => null);
        lastState = observed?.active ?? "unavailable";
        if (observed?.active === "active" && observed.pid > 0 && observed.group) return { unit: plan.unit };
        if (observed?.active === "failed" || (startFailed && observed?.loaded === "not-found")) break;
        await sleep(150);
      }
      throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", `schedule runner unit ${plan.unit} did not become active with a MainPID and cgroup (last state: ${lastState}); inspect ${plan.logPath}`);
    },
    async stop(unit) {
      try {
        await run("systemctl", ["--user", "stop", unit]);
      } catch {
        // --collect may remove a completed unit before cancellation reaches it.
        const observed = await inspect(unit).catch(() => null);
        if (observed?.loaded === "not-found" || (observed?.active === "inactive" && observed.pid === 0)) return;
        throw new ScheduleError("SCHEDULE_SUPERVISOR_UNAVAILABLE", `could not stop schedule runner unit ${unit}`);
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(file, args, { timeout: 15_000, encoding: "utf8" });
}
