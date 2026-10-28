// Shared TaskResult normalization per docs/INTERFACES.md (frozen). Used by the
// worker process after an adapter run and by the manager for infrastructure
// failures (worker_lost, spawn failures, cancellations).
//
// needs_master_decision policy: the subordinate report's value is used
// verbatim; when a run fails without a valid report the flag is true (the
// master must review), and a master-requested cancellation is false. The flag
// is never silently defaulted to false from missing evidence.
import type { AttemptTiming, ExecutionProfile, NormalizedUsage, TaskPackage, TaskResult, TestReport } from "../interfaces.js";
import type { ZCodeRunOutcome } from "../adapters/zcode-adapter.js";

export interface TaskFailure {
  readonly code: string;
  readonly message: string;
}

export interface BuildTaskResultInput {
  readonly task: TaskPackage;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly outcome: ZCodeRunOutcome | null;
  readonly failure?: TaskFailure | null;
  readonly cancelled?: boolean;
  readonly sessionId?: string | null;
  /** B4 additive: runtime usage normalized by the worker; absent on infra failures. */
  readonly usage?: NormalizedUsage | null;
  /** B4 additive: runtime-confirmed model / reasoning evidence. */
  readonly model?: ExecutionProfile | null;
  /** B4 additive: bounded phase timings. */
  readonly timing?: AttemptTiming | null;
}

export function buildTaskResult(input: BuildTaskResultInput): TaskResult {
  const { task, attempt, startedAt, finishedAt, outcome } = input;
  const base = {
    task_id: task.task_id,
    attempt,
    started_at: startedAt,
    finished_at: finishedAt,
    zcode_output: outcome?.response ?? "",
    exit_code: outcome?.exitCode ?? null,
    session_id: outcome?.sessionId ?? input.sessionId ?? null,
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.timing !== undefined ? { timing: input.timing } : {}),
  };

  if (input.cancelled || outcome?.cancelled) {
    return {
      ...base,
      status: "cancelled",
      summary: input.failure?.message ?? "cancelled by request",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
    };
  }

  const failure = input.failure ?? (outcome ? null : { code: "worker_lost", message: "no adapter outcome was recorded" });
  if (failure || !outcome) {
    const resolved = failure ?? { code: "worker_lost", message: "no adapter outcome was recorded" };
    return {
      ...base,
      status: "failed",
      summary: truncate(`${resolved.code}: ${resolved.message}`, 2_000),
      files_changed: [],
      tests: [],
      issues: [truncate(resolved.message, 2_000)],
      needs_master_decision: true,
      error_code: resolved.code,
      ...(resolved.code === "cleanup_failed" && outcome?.reportCandidate
        ? { report_candidate: outcome.reportCandidate }
        : {}),
    };
  }

  if (outcome.errorCode || outcome.reportError) {
    const code = outcome.errorCode ?? "invalid_agent_report";
    const message = outcome.reportError ?? "the subordinate report was invalid";
    return {
      ...base,
      status: "failed",
      summary: truncate(`${code}: ${message}`, 2_000),
      files_changed: [],
      tests: [],
      issues: [truncate(message, 2_000)],
      needs_master_decision: true,
      error_code: code,
      ...(outcome.reportCandidate ? { report_candidate: outcome.reportCandidate } : {}),
    };
  }

  const report = outcome.agentReport;
  if (!report) {
    // Unreachable by adapter contract, kept defensive: never synthesize
    // needs_master_decision=false without a report.
    return {
      ...base,
      status: "failed",
      summary: "the adapter reported success without a normalized report",
      files_changed: [],
      tests: [],
      issues: ["missing AgentReport despite a clean exit"],
      needs_master_decision: true,
      error_code: "invalid_agent_report",
    };
  }

  return {
    ...base,
    status: report.needs_master_decision ? "waiting_for_master" : "completed",
    summary: report.summary,
    files_changed: report.files_changed,
    tests: report.tests as TestReport[],
    issues: report.issues,
    needs_master_decision: report.needs_master_decision,
    ...(report.acceptance_met === undefined ? {} : { acceptance_met: report.acceptance_met }),
  };
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`;
}
