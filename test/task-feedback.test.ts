import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProgressEvent, TaskResult, TaskStatusRecord } from "../src/interfaces.js";
import { buildTaskFeedbackSnapshotV01 } from "../src/feedback/task-feedback.js";
import { renderTaskFeedback } from "../src/feedback/renderer.js";
import { taskFeedbackSnapshotV01Schema } from "../src/mcp/schemas.js";

const START = "2026-10-05T12:00:00.000Z";
const FINISH = "2026-10-05T12:03:42.000Z";

function status(overrides: Partial<TaskStatusRecord> = {}): TaskStatusRecord {
  return {
    task_id: "TASK_052",
    status: "running",
    attempt: 1,
    created_at: START,
    updated_at: START,
    started_at: START,
    finished_at: null,
    worker_pid: 42,
    zcode_session_id: "session-1",
    exit_code: null,
    ...overrides,
  };
}

function event(type: string, details?: Record<string, unknown>, at = START): TaskProgressEvent {
  return { seq: 1, at, type, summary: "ignored event summary", ...(details ? { details } : {}) };
}

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    task_id: "TASK_052",
    status: "completed",
    summary: "Created the requested file.",
    files_changed: ["out.txt"],
    tests: [{ command: "npm test", status: "passed" }],
    issues: [],
    needs_master_decision: false,
    zcode_output: "must not leak",
    exit_code: 0,
    session_id: "session-1",
    attempt: 1,
    started_at: START,
    finished_at: FINISH,
    ...overrides,
  };
}

test("snapshot uses runtime-selected model and last-observed tool activity only", () => {
  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status(),
    events: [
      event("model_selected", {
        requested_model: "requested/fallback",
        provider_id: "runtime-provider",
        model_id: "runtime-model",
        reasoning_level: "max",
        reasoning_level_source: "runtime",
      }),
      event("tool_status", { tool_name: "shell\nInjected", state: "running" }),
      event("interaction_requested", { request_id: "historical-request", method: "interaction/requestPermission" }),
      event("turn_completed", { token_count: 900, tool_call_count: 9 }),
      { seq: 2, at: START, type: "model_output", summary: "This text says Review and is not phase evidence" },
    ],
    result: null,
  });

  assert.equal(snapshot.model?.model_id, "runtime-model");
  assert.equal(snapshot.model?.source, "runtime");
  assert.deepEqual(snapshot.activity, {
    kind: "tool_update",
    summary: "Tool update · shellInjected",
    observed_at: START,
    currentness: "last_observed",
  });
  assert.equal(snapshot.phase, null);
  assert.equal(snapshot.progress, null);
  assert.deepEqual(snapshot.interaction, { state: "not_observed", kind: null });
  assert.doesNotMatch(JSON.stringify(snapshot), /historical-request|interaction\/requestPermission|900|"9"|Review/iu);
  const rendered = renderTaskFeedback(snapshot);
  assert.match(rendered, /Model: runtime-model · Reasoning: max/u);
  assert.match(rendered, /Last observed: Tool update · shellInjected/u);
  assert.doesNotMatch(rendered, /Tool running|Current:|No interaction required/iu);
  assert.doesNotMatch(JSON.stringify(snapshot), /requested_model/u);
  assert.equal(snapshot.activity?.summary.includes("\n"), false);
});

test("missing runtime model does not fall back to a requested model and snapshot matches the schema", () => {
  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status(),
    events: [event("model_selected", { requested_model: "provider/requested" })],
    result: null,
  });
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.schema_version, "0.1");
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.attempt, 1);
  assert.doesNotThrow(() => taskFeedbackSnapshotV01Schema.parse(snapshot));
});

test("snapshot exposes report claims only after report_ready and computes Bridge duration", () => {
  const noReport = buildTaskFeedbackSnapshotV01({
    status: status({ status: "completed", finished_at: FINISH }),
    events: [],
    result: result(),
  });
  assert.equal(noReport.result, null);

  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status({ status: "completed", finished_at: FINISH }),
    events: [event("report_ready")],
    result: result(),
  });
  assert.equal(snapshot.result?.source, "agent_report");
  assert.equal(snapshot.result?.duration_ms, 222_000);
});

test("renderer labels report claims and avoids unsupported activity or verification statements", () => {
  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status({ status: "completed", finished_at: FINISH }),
    events: [event("report_ready")],
    result: result(),
  });
  const output = renderTaskFeedback(snapshot);
  assert.match(output, /Bridge task completed/);
  assert.match(output, /Agent report:/);
  assert.match(output, /Changed: 1 file/u);
  assert.match(output, /npm test · reported passed/);
  assert.match(output, /Duration: 3m 42s/);
  assert.doesNotMatch(output, /\bverified\b|\baccepted\b|host acceptance|review pass|must not leak/iu);
});

test("renderer shortens wrapped test commands and long report text", () => {
  const longSummary = "Monotonic cleanup deadline implemented. ".repeat(12);
  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status({ status: "completed", finished_at: FINISH }),
    events: [event("report_ready")],
    result: result({
      summary: longSummary,
      tests: [{
        command: 'cmd.exe /d /s /c "set HOME=C:\\Users\\Sandy&& set TEMP=C:\\Temp&& dotnet test tests\\LumeCAE.RadianceAdapter.Tests\\LumeCAE.RadianceAdapter.Tests.csproj --no-restore --filter FullyQualifiedName~RadianceDeadlineTests"',
        status: "passed",
        details: "9/9 passed",
      }],
      issues: ["Git Bash rewrites cmd.exe switches; the command was rerun with MSYS_NO_PATHCONV=1."],
    }),
  });

  const output = renderTaskFeedback(snapshot);
  assert.match(output, /dotnet test LumeCAE\.RadianceAdapter\.Tests · filter RadianceDeadlineTests · reported passed/u);
  assert.match(output, /! 1 reported issue · Git Bash rewrites cmd\.exe switches/u);
  assert.match(output, /…/u);
  assert.doesNotMatch(output, /cmd\.exe \/d|HOME=|TEMP=|9\/9 passed/u);
  assert.ok(output.length < 600, `expected concise output, got ${output.length} characters`);
});

test("renderer has Bridge-derived text for every task lifecycle status", () => {
  const cases = [
    ["queued", "○ Queued"],
    ["running", "→ Running"],
    ["completed", "✓ Bridge task completed"],
    ["failed", "✗ Bridge task failed"],
    ["cancelled", "Task cancellation confirmed by Bridge"],
    ["waiting_for_master", "Agent report requires a master decision."],
  ] as const;
  for (const [taskStatus, expected] of cases) {
    const snapshot = buildTaskFeedbackSnapshotV01({
      status: status({ status: taskStatus, started_at: taskStatus === "queued" ? null : START }),
      events: [],
      result: null,
    });
    assert.match(renderTaskFeedback(snapshot), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});

test("unapproved runtime fields never enter the snapshot or rendered text", () => {
  const snapshot = buildTaskFeedbackSnapshotV01({
    status: status(),
    events: [event("model_tool_call", {
      tool_name: "Write",
      reasoning: "private reasoning",
      arguments: { text: "secret body" },
      headers: { authorization: "secret token" },
      telemetry: { baseURL: "https://private.invalid" },
    }), { seq: 2, at: START, type: "model_output", summary: "private reasoning" }],
    result: null,
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private reasoning|secret body|authorization|private\.invalid/iu);
  assert.doesNotMatch(renderTaskFeedback(snapshot), /private reasoning|secret body|authorization|private\.invalid/iu);
});
