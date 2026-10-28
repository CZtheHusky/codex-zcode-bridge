// Supervised scheduler process shell (ADR-010). Started by systemd-run
// --user (Type=exec, Restart=on-failure); usage:
//   node schedule-runner.mjs <dataRoot> <taskId>
// All durable state lives under the shared data root, so a supervisor restart
// resumes from persisted intent instead of repeating execution.
import path from "node:path";
import { BridgeTaskManager } from "../manager/task-manager.js";
import { createWorkerSpawner } from "../manager/spawn-worker.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { TaskStore } from "../store/task-store.js";
import { DirectWorkspaceProvider } from "../workspace/direct-provider.js";
import { validateHostProfile } from "../host/profile.js";
import { sendAppPipeNotification } from "./app-notify.js";
import { ScheduleController } from "./controller.js";
import { ScheduleStore, schedulesRootFor } from "./store.js";
import { runSchedulerRunner } from "./runner.js";
import { createSystemdRunSupervisor } from "./supervisor.js";

const [dataRoot, taskId] = process.argv.slice(2);
if (!dataRoot || !taskId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(taskId) || !path.isAbsolute(dataRoot)) {
  console.error("usage: node schedule-runner.mjs <dataRoot> <taskId>");
  process.exit(2);
}

const hostText = process.env["ZCODE_BRIDGE_HOST_PROFILE"];
const host = hostText ? validateHostProfile(JSON.parse(hostText)) : undefined;

const taskStore = new TaskStore(dataRoot);
const manager = new BridgeTaskManager({
  store: taskStore,
  workspaceProvider: new DirectWorkspaceProvider(),
  maxConcurrentWorkers: Number(process.env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"] ?? "8"),
  spawnWorker: createWorkerSpawner(host),
  probe: createPlatformProbe(),
});

const controller = new ScheduleController({
  store: new ScheduleStore(schedulesRootFor(dataRoot)),
  manager,
  supervisor: createSystemdRunSupervisor(),
  runnerEntryPath: process.argv[1]!,
  dataRoot,
  env: process.env,
  notifier: {
    send: async ({ pipePath, threadId, callId, message }) => {
      await sendAppPipeNotification({ pipePath, threadId, callId, prompt: message });
    },
  },
});

let stopping = false;
const stop = (signal: string): void => {
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
    taskStore,
  });
  console.error(`[schedule ${taskId}] runner finished: ${outcome.exit_reason}`);
  manager.dispose();
  process.exitCode = 0;
} catch (error) {
  // Persisted intent makes a supervisor restart safe; surface the reason.
  console.error(`[schedule ${taskId}] runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  manager.dispose();
  process.exitCode = 1;
}
