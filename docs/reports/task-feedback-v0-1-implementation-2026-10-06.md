# Task Feedback v0.1 Implementation Report

> Status: REPORT
> Date: 2026-10-06
> 一次性交付报告，不是当前事实来源。当前行为见 [INTERFACES.md](../INTERFACES.md) 与 [PROJECT_STATE.md](../PROJECT_STATE.md)。

## 1. Summary

Implemented a provenance-aware `TaskFeedbackSnapshotV01`, an independent plain-text renderer, and the additive `zcode_feedback` MCP tool. The tool returns the structured snapshot and renders concise Codex transcript text. `zcode_events` remains the detailed event-history API. This was integrated additively on the v1.1.0 master baseline; its existing A4 `renderFeedback` template and opt-in task ledger remain intact.

## 2. Files Changed

- `src/interfaces.ts` — snapshot contract and optional `ProgressTaskManager.getFeedback` capability.
- `src/feedback/task-feedback.ts` — snapshot construction from allowlisted Bridge/runtime facts and eligible Agent reports.
- `src/feedback/renderer.ts` — standalone concise text renderer.
- `src/manager/task-manager.ts` — current-attempt event aggregation and snapshot access; new `worker_started.details.attempt` enables reliable attempt scoping for new events.
- `src/mcp/schemas.ts` — strict v0.1 snapshot output schema and feedback input schema.
- `src/mcp/server.ts` — additive `zcode_feedback` tool with rendered text and structured content.
- `src/core.ts` — public exports for the snapshot builder and renderer.
- `docs/INTERFACES.md`, `docs/SHARED_CORE.md` — provenance, compatibility, and public API documentation.
- `plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md` — guidance for using concise snapshots while retaining `zcode_events` as detailed history.
- `test/task-feedback.test.ts` — snapshot, provenance, privacy, renderer, lifecycle, and schema tests.
- `test/task-manager.test.ts`, `test/mcp-server.test.ts`, `test/mcp-stdio-entry.test.ts` — aggregation, tool, and bundled stdio coverage.
- `plugins/codex-zcode-bridge/dist/bridge.mjs` — regenerated self-contained MCP plugin bundle containing the new tool and renderer; the existing A4 report renderer remains present.

## 3. Implemented Schema

```ts
type TaskFeedbackSnapshotV01 = {
  schema_version: "0.1";
  task_id: string;
  attempt: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_master";
  model: {
    provider_id: string | null;
    model_id: string | null;
    reasoning_level: string | null;
    source: "runtime";
  } | null;
  phase: null;
  progress: null;
  activity: {
    kind: "tool_call" | "tool_update";
    summary: string;
    observed_at: string;
    currentness: "last_observed";
  } | null;
  interaction: {
    state: "not_observed" | "pending" | "answered";
    kind: "permission" | "user_input" | null;
  } | null;
  result: {
    source: "agent_report";
    summary: string;
    issues: string[];
    files_changed: string[];
    tests: { command: string; status: "passed" | "failed" | "not_run"; details?: string }[];
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
  } | null;
};
```

## 4. Provenance Rules

- **Bridge state:** `task_id`, `attempt`, `status`, start/finish timestamps, and duration. Duration is the Bridge wall-clock interval and is null unless both valid timestamps exist.
- **Runtime-observed:** model metadata comes only from normalized `model_selected` fields containing runtime provider/model IDs. Reasoning is included only when marked runtime-sourced. No requested or catalog fallback is used. Activity comes only from `model_tool_call` or `tool_status`, carries the Bridge event-persistence observation timestamp, and never claims the operation is still active.
- **Agent report:** summary, issues, changed-file claims, and tests are included only when the current attempt has `report_ready` and the matching final result is `completed` or `waiting_for_master`. The source is explicitly `agent_report`.
- `phase` and `progress` are always null. `interaction` is `not_observed` because this snapshot does not establish a reliable current pending/answered state; that value does not mean no historical or pending interaction exists.

## 5. Renderer Examples

Queued:

```text
▣ ZCode · TASK_052
○ Queued
```

Running:

```text
▣ ZCode · TASK_052
→ Running
```

Running with runtime model:

```text
▣ ZCode · TASK_052
→ Running
Model: GLM-5.3 · Reasoning: max
```

Running with last observed activity:

```text
▣ ZCode · TASK_052
→ Running
Model: GLM-5.3 · Reasoning: max

Last observed: Tool request · Write
```

Completed:

```text
▣ ZCode · TASK_052 · COMPLETED
✓ Bridge task completed

Agent report:
Created the requested file.
Changed: 5 files
Tests: npm test · reported passed
Duration: 3m 42s
```

Failed:

```text
▣ ZCode · TASK_052 · FAILED
✗ Bridge task failed
```

Cancelled:

```text
▣ ZCode · TASK_052 · CANCELLED
Result: Task cancellation confirmed by Bridge
```

Waiting for master:

```text
▣ ZCode · TASK_052 · WAITING_FOR_MASTER
Agent report requires a master decision.
```

The frozen snapshot has no runtime turn outcome or Bridge failure-reason field. The renderer therefore reports the Bridge completion/failure status and cannot add a runtime-turn-success line or a specific failure reason without expanding the schema.

## 6. Safety and Privacy

Snapshot construction uses event-type and field allowlists. It reads only runtime-selected provider/model/reasoning fields and sanitized tool names. It does not copy model text, reasoning, tool arguments, request/response headers, credentials, tokens, base URLs, telemetry, or raw RPC payloads. The renderer receives only the snapshot, collapses report text and commands to bounded single lines, shows a changed-file count by default, and labels tests as reported claims.

## 7. Compatibility

- `zcode_status` and `zcode_result` schemas and `TaskResult` semantics are unchanged.
- `zcode_events` cursor, raw/summary views, and event types are unchanged. New `worker_started` records include an additive `details.attempt` value to scope feedback; legacy records remain readable and use the Bridge start timestamp as a fallback.
- Persisted task records require no migration. Existing event history remains intact.
- MCP adds `zcode_feedback`; it does not replace an existing tool. The manager capability is optional for downstream `ProgressTaskManager` implementations.
- The shared core exports `buildTaskFeedbackSnapshotV01` and `renderTaskFeedback`.

## 8. Tests and Validation

| Command | Result |
|---|---|
| `npm run typecheck` | Passed on the v1.1.0 master baseline |
| `npm run build` | Passed; core and plugin bundles generated on the v1.1.0 master baseline |
| `npm test` | Passed: 256 tests, 255 passed, 0 failed, 1 skipped on Windows because POSIX permission bits are not applicable; includes the existing B3-05 scale/performance case (about 11m 8s total) |
| `npm run validate:plugin` | Passed on codex-zcode-bridge@1.1.0 |`r`n| `npm run test:clean-entrypoints` | Passed: 4/4 |`r`n| `git diff --check` | Passed; Git emitted CRLF normalization warnings for generated bundles |

## 9. Known Limitations

- `phase = null`; `progress = null`.
- Pending permission and user-input semantics remain incomplete; current snapshot interaction remains `not_observed`.
- Activity means `last_observed` only and does not imply current tool execution.
- Runtime success does not verify the task objective.
- Agent report claims are not Bridge or host verification.
- The schema cannot report runtime turn outcome or a specific Bridge failure reason.
- Probe evidence covers only the recorded ZCode 0.16.9/provider/model path; cross-version guarantees were not established.

## 10. Deferred Work

Real pending-permission round trip, user-input round trip, runtime cancellation/failure paths, active-session reconnect, Verification Layer, and Master acceptance remain out of scope.
