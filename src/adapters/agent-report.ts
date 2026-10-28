// Structured subordinate report parsing per docs/INTERFACES.md (frozen):
// "The adapter parses the CLI JSON envelope first, then parses/validates
// `response` as AgentReport." The response may contain surrounding prose, so
// balanced JSON-object candidates are scanned; `needs_master_decision` is
// required and never synthesized.
import type { AgentReport, TestReport } from "../interfaces.js";

export type ReportParseResult =
  | { report: AgentReport; candidate: AgentReport; error: null }
  | { report: null; candidate: Partial<AgentReport> | null; error: string };

const TEST_STATUSES = new Set(["passed", "failed", "not_run"]);
const MAX_SCAN_CHARS = 400_000;

export function parseAgentReport(responseText: string): ReportParseResult {
  let lastError: string | null = null;
  let lastCandidate: Partial<AgentReport> | null = null;
  for (const candidate of extractJsonObjects(responseText)) {
    const validated = validateAgentReport(candidate);
    if (validated.ok) {
      return { report: validated.report, candidate: validated.report, error: null };
    }
    lastError = validated.error;
    lastCandidate = extractReportCandidate(candidate);
  }
  return {
    report: null,
    candidate: lastCandidate,
    error: lastError ?? "no JSON object found in the response text",
  };
}

function extractReportCandidate(value: unknown): Partial<AgentReport> | null {
  if (!isPlainObject(value)) return null;
  const candidate: Partial<AgentReport> = {};
  if (typeof value["summary"] === "string") candidate.summary = value["summary"];
  if (isStringArray(value["files_changed"])) candidate.files_changed = value["files_changed"];
  if (isStringArray(value["issues"])) candidate.issues = value["issues"];
  if (typeof value["needs_master_decision"] === "boolean") candidate.needs_master_decision = value["needs_master_decision"];
  if (typeof value["acceptance_met"] === "boolean") candidate.acceptance_met = value["acceptance_met"];
  if (Array.isArray(value["tests"])) {
    const tests: TestReport[] = [];
    for (const entry of value["tests"]) {
      const test = validateTestReport(entry);
      if (!test.ok) return candidate;
      tests.push(test.test);
    }
    candidate.tests = tests;
  }
  return Object.keys(candidate).length ? candidate : null;
}

export function validateAgentReport(
  value: unknown,
): { ok: true; report: AgentReport } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: "report is not a JSON object" };
  }
  const summary = value["summary"];
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, error: "report.summary must be a non-empty string" };
  }
  const filesChanged = value["files_changed"];
  if (!isStringArray(filesChanged)) {
    return { ok: false, error: "report.files_changed must be an array of strings" };
  }
  const testsRaw = value["tests"];
  if (!Array.isArray(testsRaw)) {
    return { ok: false, error: "report.tests must be an array" };
  }
  const tests: TestReport[] = [];
  for (const entry of testsRaw) {
    const test = validateTestReport(entry);
    if (!test.ok) {
      return { ok: false, error: `report.tests entry invalid: ${test.error}` };
    }
    tests.push(test.test);
  }
  const issues = value["issues"];
  if (!isStringArray(issues)) {
    return { ok: false, error: "report.issues must be an array of strings" };
  }
  const needsMasterDecision = value["needs_master_decision"];
  if (typeof needsMasterDecision !== "boolean") {
    return { ok: false, error: "report.needs_master_decision must be a boolean" };
  }
  // ADR-010: acceptance_met is optional, but a PRESENT non-boolean value is an
  // invalid report (invalid_agent_report) rather than a silent "unassessed";
  // the scheduler must never guess a self-assessment from malformed evidence.
  if (value["acceptance_met"] !== undefined && typeof value["acceptance_met"] !== "boolean") {
    return { ok: false, error: "report.acceptance_met must be a boolean when present" };
  }
  const acceptanceMet = value["acceptance_met"];
  return {
    ok: true,
    report: {
      summary,
      files_changed: filesChanged,
      tests,
      issues,
      needs_master_decision: needsMasterDecision,
      ...(acceptanceMet === undefined ? {} : { acceptance_met: acceptanceMet }),
    },
  };
}

function validateTestReport(
  value: unknown,
): { ok: true; test: TestReport } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: "entry is not an object" };
  }
  const command = value["command"];
  if (typeof command !== "string") {
    return { ok: false, error: "command must be a string" };
  }
  const status = value["status"];
  if (typeof status !== "string" || !TEST_STATUSES.has(status)) {
    return { ok: false, error: "status must be one of passed|failed|not_run" };
  }
  const details = value["details"];
  if (details !== undefined && typeof details !== "string") {
    return { ok: false, error: "details must be a string when present" };
  }
  return {
    ok: true,
    test: details === undefined ? { command, status: status as TestReport["status"] } : { command, status: status as TestReport["status"], details },
  };
}

/** Yields JSON.parse results for balanced top-level `{…}` blocks, string-aware. */
function* extractJsonObjects(text: string): Generator<unknown> {
  if (text.trimStart().startsWith("{")) {
    try {
      yield JSON.parse(text);
    } catch {
      // fall through to scanning
    }
  }
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            yield JSON.parse(slice);
          } catch {
            // malformed candidate; keep scanning
          }
          start = -1;
        }
      }
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
