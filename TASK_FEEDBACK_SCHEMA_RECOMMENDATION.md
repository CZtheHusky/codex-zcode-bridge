# Task Feedback Schema Recommendation

**Decision:** Do **not** freeze the full `TaskFeedbackSnapshotV01` candidate yet. Freeze the core envelope and source semantics now; keep uncertain fields nullable/deferred until their state transitions are directly observed.

Evidence: real ZCode `0.16.9` app-server probe documented in [ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md](ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md) and [run-001-summary.json](probe/evidence/run-001-summary.json).

## KEEP

- `schema_version`, `task_id`, `attempt`, and the existing Bridge task `status` vocabulary. These identify the Bridge task and its attempt; they are not app-server turn states.
- `model`, but source it only from a runtime snapshot or runtime-reported selection. The probe observed `settings.model.current.providerId`, `modelId`, and `options.reasoningLevel`. Preserve provider/model IDs and mark reasoning level nullable. Do not substitute request or catalog defaults and call them actual selection.
- Final `result` fields after a terminal result is available: `summary`, `issues`, `files_changed`, `tests`, `started_at`, and `finished_at`. Keep the Agent-report origin explicit; these are not Bridge-verified file diffs or independently verified test outcomes.
- `phase` and `progress` nullable slots if forward compatibility is valuable. Their values remain `null` until the runtime supplies explicit, structured phase/progress events.

## CHANGE

- Define `activity` as **last observed activity**, not “the operation currently running.” The probe observed `model.streaming` tool events and `tool.updated`, but did not establish the exact state mapping or whether the last update remains active. Include `observed_at`; do not render “Tool running” unless a confirmed runtime state says so.
- Narrow activity kinds to values directly supported by normalized, allowlisted events. Do not use model output text or tool arguments as a phase/action classifier. The observed runtime kinds include `tool_call` and tool-related `tool.updated`; `visible_output` is content, not an activity label.
- Give result subfields an explicit source, for example `source: "agent_report"`; give lifecycle/model fields `source: "bridge"` or `source: "runtime_snapshot"`. This prevents reported test/file claims from appearing runtime-verified.
- Define `interaction.state = "not_observed"` as “no interaction was observed in the event/query range,” never as “none exists.” A pending state must be backed by a current pending-request snapshot or an unmatched request event with a validated correlation rule.
- Define `duration_ms` as derived from Bridge `started_at` and `finished_at`, and populate it only when both are available. It is wall-clock task duration, not model execution time.

## ADD

- Add an optional runtime snapshot provenance block with `session_status`, `event_seq`, and `state_revision` when read from `session/read`. The probe observed these fields. Do not expose raw `pendingRequestIds`; at most expose a validated count/state after testing a real pending permission and input request.
- Add event `observed_at` and source sequence metadata to normalized activity records so a consumer can distinguish a recent event from an ongoing operation.
- Keep Bridge lifecycle state and app-server session state separate. They are separate state machines; one cannot stand in for the other.

## REMOVE

- Remove any promise that `phase` is inferred from tool kind or model text.
- Remove percentage progress derived from token counts, tool counts, elapsed time, message count, or iterations.
- Remove a generic `retry` label based only on `streamRecovery.updated`; its semantics were not established.
- Remove “Tool running · shell” as a default renderer claim from the current evidence. The task observed tool signals, but the redacted capture did not establish a reliable active-state mapping or shell name.

## DEFER

- Non-null `phase` and `progress`: no explicit runtime phase/progress event was observed.
- `current_action` / current operation: currentness has not been proven. If retained in the v0.1 type, only populate a `last_activity` interpretation.
- Permission-pending and user-input-pending state: permission request/resolution events appeared, but no human wait round trip or ID correlation was tested. User input was not observed.
- Cancellation, task/tool/infrastructure failure, and retry state: not tested in a real task.
- Full snapshot recovery after app-server restart: same-process reads worked; recovery of the unique empty session failed, and active/completed-task recovery is unverified.
- Cross-version/model/provider guarantees: only ZCode `0.16.9`, one provider, and GLM-5.3 were probed.

## Freeze recommendation

Freeze a **core v0.1** contract containing:

```ts
type TaskFeedbackSnapshotV01 = {
  schema_version: "0.1";
  task_id: string;
  attempt: number;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "waiting_for_master";
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
    tests: {
      command: string;
      status: "passed" | "failed" | "not_run";
      details?: string;
    }[];
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
  } | null;
};
```

This proposed type freezes nullability and provenance. It does **not** authorize non-null `phase` or `progress` values, nor a claim that an activity remains active. Keep `interaction.state` weak until a real pending interaction is tested. If the contract cannot define evidence rules for those nullable fields, defer freezing the full schema rather than freezing ambiguous meanings.

## Renderer implications

- Safe now: Bridge task status, runtime-reported model metadata when present, successful `turn.completed` as a runtime turn outcome, and final result labeled “Agent report.”
- Conditionally safe: “Last observed tool event · Write,” only from an allowlisted event and only if the renderer does not imply that the tool is still running.
- Unsupported by this probe: phase checklists, test-case counts, percentages, confirmed permission/user-input waiting, generic retry, and recovery guarantees.

No production schema or code was changed as part of this recommendation.
