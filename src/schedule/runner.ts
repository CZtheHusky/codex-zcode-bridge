// ADR-010 supervised scheduler runner: waits for start_at inside the
// systemd-owned process, dispatches the derived task idempotently, then
// observes PERSISTED COMMITTED task state only (never the pre-commit
// task_finished event) and drives the goal policy: quiet same-session
// continuation, review request, or one escalation per condition. Wakeup
// delivery retries from the persisted outbox; the runner stays alive until
// every event is confirmed sent, then exits 0. Crashes are restarted by the
// supervisor and resume from persisted intent.
import type { TaskManager, TaskStatus } from "../interfaces.js";
import { TaskManagerError } from "../manager/errors.js";
import { TaskStore } from "../store/task-store.js";
import type { ScheduleController } from "./controller.js";
import { evaluateTerminalResult } from "./policy.js";

export interface SchedulerRunnerOptions {
  readonly dataRoot: string;
  readonly taskId: string;
  readonly manager: TaskManager;
  readonly controller: ScheduleController;
  readonly taskStore: TaskStore;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Monitor tick; the start-time wait uses waitTickMs. Default 2000. */
  readonly pollIntervalMs?: number;
  readonly waitTickMs?: number;
}

export type RunnerExitReason = "cancelled" | "accepted" | "schedule_failed" | "task_record_missing";

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "waiting_for_master";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSchedulerRunner(options: SchedulerRunnerOptions): Promise<{ exit_reason: RunnerExitReason }> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const waitTickMs = options.waitTickMs ?? 1_000;
  const { taskId, controller, manager, taskStore } = options;

  // Phase 1 — the scheduled start gates ALL execution; nothing above has run.
  while (true) {
    const before = controller.readState(taskId);
    if (before.status === "failed") return drainOutbox(controller, taskId, "schedule_failed", sleep, pollIntervalMs);
    if (before.cancel_requested && before.status !== "cancelled") {
      try { await controller.cancel(taskId); } catch {
        // cancel persists the failure event before throwing; drain it once and stop.
        if (controller.readState(taskId).status !== "failed") throw new Error("schedule cancellation recovery failed before persisting its outcome");
      }
    }
    await controller.recoverReview(taskId);
    const state = controller.readState(taskId);
    if (state.status === "cancelled") return drainOutbox(controller, taskId, "cancelled", sleep, pollIntervalMs);
    if (state.status === "accepted") return drainOutbox(controller, taskId, "accepted", sleep, pollIntervalMs);
    if (state.status === "failed") return drainOutbox(controller, taskId, "schedule_failed", sleep, pollIntervalMs);
    const startAtMs = Date.parse(controller.readSpec(taskId).start_at);
    const remaining = startAtMs - now().getTime();
    if (remaining <= 0) break;
    await sleep(Math.max(1, Math.min(waitTickMs, remaining)));
  }

  // Phase 2 — idempotent dispatch (crash-safe through createTask replay).
  await controller.dispatch(taskId);

  // Phase 3 — monitor committed state until the goal is terminal.
  while (true) {
    const before = controller.readState(taskId);
    if (before.status === "failed") return drainOutbox(controller, taskId, "schedule_failed", sleep, pollIntervalMs);
    if (before.cancel_requested && before.status !== "cancelled") {
      try { await controller.cancel(taskId); } catch {
        // cancel persists the failure event before throwing; drain it once and stop.
        if (controller.readState(taskId).status !== "failed") throw new Error("schedule cancellation recovery failed before persisting its outcome");
      }
    }
    await controller.recoverReview(taskId);
    const state = controller.readState(taskId);
    if (state.status === "cancelled") return drainOutbox(controller, taskId, "cancelled", sleep, pollIntervalMs);
    if (state.status === "accepted") return drainOutbox(controller, taskId, "accepted", sleep, pollIntervalMs);
    if (state.status === "failed") return drainOutbox(controller, taskId, "schedule_failed", sleep, pollIntervalMs);

    let status: Awaited<ReturnType<TaskManager["getStatus"]>>;
    try {
      status = await manager.getStatus(taskId);
    } catch (error) {
      if (error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND") {
        // Dispatch committed a receipt; a vanished record means the task
        // store was removed or corrupted underneath the schedule. Fail the
        // goal visibly instead of silently re-creating execution.
        await controller.fail(taskId, "task_failed", "The dispatched task record is missing; execution was not recreated.");
        return drainOutbox(controller, taskId, "task_record_missing", sleep, pollIntervalMs);
      }
      throw error;
    }

    if (!isTerminal(status.status)) {
      await controller.noteActiveAttempt(taskId, status.attempt);
      for (const request of taskStore.listPendingInteractions(taskId)) {
        // Public request ids are "<attempt>:<runtime id>"; older attempts'
        // pending requests belong to archived evidence, not this run.
        if (!request.request_id.startsWith(`${String(status.attempt)}:`)) continue;
        await controller.notifyPendingInteraction(taskId, status.attempt, request);
      }
    } else {
      const alreadyHandled = (state.status === "awaiting_review" && state.attempt_under_review === status.attempt)
        || (state.attention !== null && state.attention.attempt === status.attempt && state.attention.reason !== "pending_interaction");
      if (!alreadyHandled) {
        const result = await manager.getResult(taskId).catch((error: unknown) => {
          if (error instanceof TaskManagerError && error.code === "TASK_NOT_FINISHED") return null;
          throw error;
        });
        // Only the committed result of the CURRENT attempt decides anything.
        if (result !== null && result.attempt === status.attempt) {
          const decision = evaluateTerminalResult(taskId, result);
          switch (decision.action) {
            case "continue": {
              const outcome = await controller.autoContinue(taskId, status.attempt, decision.feedback, decision.operation_id);
              if (!outcome.continued) {
                await controller.escalate(taskId, status.attempt, "continue_failed", { detail: outcome.reason });
              }
              break;
            }
            case "request_review":
              await controller.requestReview(taskId, status.attempt);
              break;
            case "escalate":
              await controller.escalate(taskId, status.attempt, decision.reason, { errorCode: decision.detail });
              break;
            default:
              break;
          }
        }
      }
    }

    // Wakeup delivery is at-least-once; terminal goals only exit once every
    // persisted event is confirmed sent.
    await controller.deliverPending(taskId);
    await sleep(pollIntervalMs);
  }
}

async function drainOutbox(
  controller: ScheduleController,
  taskId: string,
  reason: RunnerExitReason,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
): Promise<{ exit_reason: RunnerExitReason }> {
  do {
    await controller.deliverPending(taskId);
    if (controller.hasUndeliveredNotifications(taskId)) await sleep(pollIntervalMs);
  } while (controller.hasUndeliveredNotifications(taskId));
  return { exit_reason: reason };
}
