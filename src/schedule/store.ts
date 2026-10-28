// ADR-010 ScheduleStore: durable spec/state/outbox records under
// <dataRoot>/.schedules/<task_id>/. JSON writes are atomic (temp file +
// rename) with 0o700 directories, mirroring the TaskStore conventions.
// Methods are synchronous readers/writers; mutation ordering across processes
// (MCP host vs supervised runner) is serialized by the controller through
// withProcessLock, so this store itself never blocks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicRenameSync } from "../store/atomic-rename.js";
import { ScheduleError } from "./errors.js";
import type {
  ScheduleNotification,
  ScheduleRuntimeInfo,
  ScheduleSpec,
  ScheduleState,
} from "./types.js";

/** Schedules live beside .tasks under their own private root. */
export function schedulesRootFor(dataRoot: string): string {
  return path.join(dataRoot, ".schedules");
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  atomicRenameSync(temp, file);
}


export class ScheduleStore {
  readonly #root: string;

  constructor(schedulesRoot: string) {
    this.#root = schedulesRoot;
  }

  get root(): string {
    return this.#root;
  }

  scheduleDir(taskId: string): string {
    return path.join(this.#root, taskId);
  }

  hasSchedule(taskId: string): boolean {
    return existsSync(path.join(this.scheduleDir(taskId), "spec.json"));
  }

  hasState(taskId: string): boolean {
    return existsSync(path.join(this.scheduleDir(taskId), "state.json"));
  }

  readSpec(taskId: string): ScheduleSpec {
    try {
      return JSON.parse(readFileSync(path.join(this.scheduleDir(taskId), "spec.json"), "utf8"));
    } catch (error) {
      if (!this.hasSchedule(taskId)) throw new ScheduleError("SCHEDULE_NOT_FOUND", `unknown schedule: ${taskId}`);
      throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId} spec could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  writeSpec(spec: ScheduleSpec): void {
    writeJsonAtomic(path.join(this.scheduleDir(spec.task_id), "spec.json"), spec);
  }

  readState(taskId: string): ScheduleState {
    try {
      return JSON.parse(readFileSync(path.join(this.scheduleDir(taskId), "state.json"), "utf8"));
    } catch (error) {
      if (!this.hasSchedule(taskId)) throw new ScheduleError("SCHEDULE_NOT_FOUND", `unknown schedule: ${taskId}`);
      throw new ScheduleError("SCHEDULE_STATE", `schedule ${taskId} state could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  writeState(state: ScheduleState): void {
    writeJsonAtomic(path.join(this.scheduleDir(state.task_id), "state.json"), state);
  }

  notificationPath(taskId: string): string {
    return path.join(this.scheduleDir(taskId), "outbox.json");
  }

  hasNotification(taskId: string, eventId: string): boolean {
    return this.listNotifications(taskId).some((record) => record.event_id === eventId);
  }

  writeNotification(taskId: string, notification: ScheduleNotification): void {
    const records = this.listNotifications(taskId);
    const previous = records.findIndex((record) => record.event_id === notification.event_id);
    if (previous < 0) records.push(notification);
    else records[previous] = notification;
    writeJsonAtomic(this.notificationPath(taskId), records);
  }

  listNotifications(taskId: string): ScheduleNotification[] {
    let records: ScheduleNotification[];
    try { records = JSON.parse(readFileSync(this.notificationPath(taskId), "utf8")); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
    return records;
  }

  readRuntime(): ScheduleRuntimeInfo | null {
    try { return JSON.parse(readFileSync(path.join(this.#root, "runtime.json"), "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  writeRuntime(info: ScheduleRuntimeInfo): void {
    writeJsonAtomic(path.join(this.#root, "runtime.json"), info);
  }
}
