// ADR-010 acceptance_met plumbing: the agent-report parser keeps the five
// frozen required fields, accepts an OPTIONAL boolean acceptance_met, and
// rejects a present non-boolean as invalid_agent_report evidence (never a
// silent "unassessed"); normalize carries the flag onto TaskResult. Old
// reports without the field stay valid.
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReport, validateAgentReport } from "../src/adapters/agent-report.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import { validReport, SESSION_ID } from "./helpers.js";

test("report without acceptance_met stays valid and reads as absent", () => {
  const parsed = parseAgentReport(JSON.stringify(validReport()));
  assert.equal(parsed.error, null);
  assert.equal(parsed.report!.acceptance_met, undefined);
  const round = validateAgentReport(parsed.candidate);
  assert.equal(round.ok, true);
  assert.equal("acceptance_met" in round.report, false);
});

test("boolean acceptance_met parses through candidates and validation", () => {
  for (const acceptanceMet of [true, false]) {
    const parsed = parseAgentReport(JSON.stringify(validReport({ acceptance_met: acceptanceMet })));
    assert.equal(parsed.error, null);
    assert.equal(parsed.report!.acceptance_met, acceptanceMet);
    assert.equal(parsed.candidate.acceptance_met, acceptanceMet);
  }
});

test("a present non-boolean acceptance_met invalidates the report", () => {
  const raw = JSON.stringify({ ...validReport(), acceptance_met: "true" });
  const parsed = parseAgentReport(raw);
  assert.equal(parsed.report, null);
  assert.match(parsed.error ?? "", /acceptance_met must be a boolean when present/);
});

test("normalize copies a present acceptance_met onto TaskResult and omits it otherwise", () => {
  const base = {
    task: { task_id: "t1", workspace: "/w", objective: "o", requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] },
    attempt: 1,
    startedAt: null,
    finishedAt: "2026-10-27T00:00:00.000Z",
    outcome: {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      sessionId: SESSION_ID,
      response: "ok",
      usage: null,
      timedOut: false,
      agentReport: validReport({ acceptance_met: true }),
      reportCandidate: null,
      reportError: null,
      errorCode: null,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    },
  };
  const withFlag = buildTaskResult(base);
  assert.equal(withFlag.status, "completed");
  assert.equal(withFlag.acceptance_met, true);

  const withoutFlag = buildTaskResult({
    ...base,
    outcome: { ...base.outcome, agentReport: validReport(), reportCandidate: validReport() },
  });
  assert.equal(withoutFlag.status, "completed");
  assert.equal("acceptance_met" in withoutFlag, false);
});
