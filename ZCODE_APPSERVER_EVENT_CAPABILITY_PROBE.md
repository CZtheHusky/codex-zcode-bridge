# ZCode App-Server Event Capability Probe

**Date:** 2026-10-05 (Asia/Shanghai)
**Scope:** Probe-only runtime research. No production Bridge source, schema, worker, or renderer was modified.

## Environment

| Item | Observed value |
|---|---|
| ZCode CLI / bundled app-server | `0.16.9` (`zcode.cjs --version`; no separate app-server version string was reported) |
| Bridge checkout | `2596759198fa826c2b7ac0478c5682da996e9727` |
| OS | Windows (PowerShell host) |
| Node | `v24.16.0` |
| Provider / model | `account:bigmodel-individual-coding-plan` / `GLM-5.3` |
| Runtime-reported reasoning level | `max` in the session snapshot |
| Second runtime/model path | Not run |

The probe spawned the installed `zcode.cjs app-server --stdio` directly, created temporary workspaces under the OS temp directory, and used the account-provider reply in memory. Probe records retained event names, sequence numbers, key names, and a small allowlist of metadata. They did **not** retain model text, reasoning text, tool input/arguments, headers, credentials, or raw RPC frames.

Sanitized evidence summary: [probe/evidence/run-001-summary.json](probe/evidence/run-001-summary.json).

## Method and evidence levels

- **Observed:** returned by the real runtime or received on its live `session/event` stream during this probe.
- **Documented:** method/shape is present in the installed runtime bundle or local Bridge code, but this probe did not observe the behavior.
- **Inferred:** plausible interpretation that is not a runtime guarantee.
- **Not observed:** this probe provides no evidence that the behavior exists or is absent.

The probe performed read RPCs for `runtime/capabilities`, `session/read`, `session/events`, `session/subagents`, and `session/list`; created and closed temporary sessions; and ran one harmless coding task that was asked to create and verify one file in an isolated temporary workspace. A later host-side inspection found that the requested file was absent. A reconnect attempt used a uniquely named empty workspace. The probe did not run destructive commands or approve an external side effect.

## Probe scenarios

| Scenario | Result |
|---|---|
| A. Normal coding task | **Partially observed.** The runtime returned `turn.completed` with `resultType: success`, but a later host-side inspection found that the requested `probe.txt` was absent. Runtime turn success did not establish that the task objective was satisfied. |
| B. Tool-heavy lifecycle | **Partially observed.** The same task produced 9 tool calls in the terminal event metadata, 26 `tool.updated` events, and model-stream tool events. The task was not designed as a multi-file stress test. |
| C. Permission request | **Partially observed.** Five `permission.requested` and five `permission.resolved` events appeared during the normal task. No inbound `interaction/requestPermission` RPC requiring a human decision was observed, so a pending human approval round trip was not tested. |
| D. User input request | **Not run.** No `interaction/requestUserInput` RPC was triggered. |
| E. Cancellation | **Not run.** No turn was cancelled. |
| F. Failure | **Not run.** No task-level, tool-level, or infrastructure failure was intentionally induced. |
| G. Retry / recovery | **Partially observed.** Nine `streamRecovery.updated` events appeared. This is evidence of stream-recovery notifications only; it does not establish a general tool/model/provider retry contract. |
| H. Generic progress | **Not observed.** No structured current/total/percentage progress event appeared in the captured taxonomy. |

## Runtime snapshot and RPC observations

`runtime/capabilities` succeeded and returned `{ "independentPlanState": true }`.

`session/create` and same-process `session/read` succeeded. The returned snapshot contained these top-level groups:

```text
messages, projection, protocol, runtime, session, settings,
slashCommands, todoGroups, todos
```

Relevant observed nested fields included:

- `session`: `sessionId`, `status`, `mode`, `sessionKind`, `model`, `workspace`, timestamps, and title metadata.
- `runtime`: `eventSeq`, `stateRevision`, `pendingRequestIds`, and goal-verification fields.
- `settings`: `mode`, `model`, `permission`, and `thoughtLevel`.
- `settings.model.current`: `providerId`, `modelId`, and `options.reasoningLevel`.

The session snapshot reported `GLM-5.3`, provider `account:bigmodel-individual-coding-plan`, and reasoning level `max`. This is runtime-reported selection, not the request or catalog default. The completed task snapshot was `idle`, had `eventSeq: 261`, and had zero pending request IDs. The probe did not sample `session/read` while a turn was actively blocked, so these fields do not yet prove a running/waiting state transition.

`session/events` succeeded in the same app-server process and returned event records after a sequence cursor. `session/subagents` on an empty session returned error code `-32004`; this is **not** evidence that subagents are generally unsupported.

### Reconnect attempt

For a newly created, idle session in a unique temporary workspace:

1. The initial snapshot reported `status: idle` and `eventSeq: 0`.
2. After stopping that app-server process, `session/read` and `session/events` in a new process returned `-32004`.
3. `session/list` in the new process returned 50 session entries but did not contain that unique workspace/session ID.
4. `session/resume` for that exact session ID returned `-32004`.

An earlier exploratory list contained a probe-workspace session that could be resumed, but the returned record was not identity-matched to the just-created session. It is excluded as recovery evidence. **Recovery of a completed or active task session after app-server restart remains unverified.** The observed behavior does show that direct `session/read` requires the session to be present in the current app-server session registry; a successful runtime query is not available merely from the old session ID.

## Observed event taxonomy

The normal task produced 261 live events, with the following event-name counts. The observed stream began at sequence 1 and ended with `turn.completed` at sequence 261. This is a single-run observation, not a cross-run ordering guarantee.

| Event name | Count | Safe conclusions from this capture |
|---|---:|---|
| `session.titleUpdated` | 1 | Session title metadata changed. Title content was not retained. |
| `turn.started` | 1 | A structured turn-start event exists. `turnId` and `seq` were present in the event envelope. |
| `session.updated` | 36 | Session/model/telemetry update events exist. Payload key names included model/provider metadata and, in some updates, request/response header fields and usage telemetry. Values were not retained. |
| `model.streaming` | 177 | Stream events included `reasoning_delta`, `text_delta`, `tool_input_start`, `tool_input_delta`, `tool_input_end`, and `tool_call`. `delta`, `input`, and tool metadata are not safe to log wholesale. |
| `tool.updated` | 26 | Structured tool update events exist. This capture did not retain enough state values to define a stable started/running/completed/failed mapping. |
| `permission.requested` | 5 | Permission lifecycle request notifications occurred. Request IDs/details were not retained, so request/resolve correlation is not established. |
| `permission.resolved` | 5 | Permission lifecycle resolution notifications occurred. Equal counts do not prove one-to-one correlation. |
| `streamRecovery.updated` | 9 | Structured stream-recovery updates exist; their precise meaning and relation to retries were not established. |
| `turn.completed` | 1 | Terminal turn event reported `resultType: success`; `tokenCount`, `toolCallCount`, duration, and usage metadata were present. Token/usage values are excluded from feedback and evidence. |

### Sensitive fields and privacy boundary

The event envelope provided `sessionId`, `turnId`, and numeric `seq` on observed session events. The captured normal-task `model.streaming` payload shape included `delta`; tool-related variants included `input`, `toolCallId`, and `toolName`. `session.updated` payload key names included `requestHeaders`, `responseHeaders`, `baseURL`, request/trace identifiers, and usage metadata. The probe recorded key names only for these fields.

Do not persist or render raw event payloads. Hidden `reasoning_delta` content, visible text deltas, tool input/arguments, request/response headers, and provider telemetry must stay outside default feedback. A strict field allowlist is required even for diagnostic evidence.

## Capability findings

### Lifecycle

- **Observed:** `turn.started` and successful `turn.completed` in a real task.
- **Not observed:** `turn.failed`, runtime cancellation, or separate task lifecycle states such as queued or waiting-for-master. Those are Bridge task states, not established app-server events by this probe.
- `session.status` was `idle` before and after the task in the snapshots captured. An in-turn `session/read` sample was not taken.

### Model selection

- **Observed:** snapshot `settings.model.current` reported provider ID, model ID, and `options.reasoningLevel`; the selected model was `GLM-5.3`, reasoning `max`.
- **Observed:** stream-side `session.updated` payload keys included `modelId` and `providerId`.
- **Limit:** only one provider/model path and one task were sampled. Stability across model switches, provider changes, and runtime versions is not established.

### Tool behavior and activity

- **Observed:** `model.streaming` tool-related kinds and `tool.updated` events. A `Write` tool name was observed in a tool event; the task’s terminal metadata reported 9 tool calls.
- **Not established:** the exact `tool.updated` state values, a reliable `tool started` boundary, or whether the most recent tool event still represents a currently active operation.
- Therefore the runtime supports **tool-related activity signals**, but this probe cannot justify text such as `Tool running · shell`. At most, a renderer may report a time-stamped **last observed tool event** after verifying the exact event and safe tool name.

### Permission and user input

- **Observed:** permission request/resolution event names during tool execution. No human approval request was left pending, and no permission interaction RPC round trip was tested.
- `runtime.pendingRequestIds` is present in snapshots, but this probe only observed an empty list before/after the completed task. Mapping those IDs to permission or user-input requests is unverified.
- **Not observed:** user-input request events, request IDs/question metadata, pending-state transitions, or resume behavior after a user answer.

### Phase and progress

- No runtime phase event or structured analysis/implementation/testing/review phase was observed.
- No generic `current`, `total`, percentage, step, stage, or test-case progress was observed.
- `iteration`, `messageCount`, `toolCount`, token counts, duration, and tool-call counts are runtime metadata, not task completion progress. Do not transform them into percentages or test-case counts.
- Current evidence supports `phase = null` and `progress = null`.

### Retry and failure

- `streamRecovery.updated` was observed, but no semantics were proven for model retry, provider retry, tool retry, or task retry.
- No task, tool, or infrastructure failure path was intentionally run. A unified `retry` feedback event is not justified by this probe.

### Session/state recovery

- `session/read`, `session/events`, and `session/list` are callable in the tested runtime; `session/resume` is also callable but the unique empty session test returned `-32004` after process restart.
- Same-process event history is queryable by `afterSeq` and `limit`.
- Rebuilding a trustworthy snapshot for a running turn after disconnect, restoring pending interactions, and recovering a completed Bridge task were not established.

## Evidence table

| Capability | Observed | Structured | Stable enough for v0.1 | Feedback use |
|---|---|---|---|---|
| Actual selected model | Yes, snapshot | Yes | One-path evidence only | Show with runtime source; omit when unreported |
| Reasoning level | Yes, snapshot | Yes | One-path evidence only | Optional model metadata; never show reasoning content |
| Turn start/completion | Yes | Yes | Useful for this runtime path; cross-version not tested | Lifecycle evidence |
| Tool-related activity | Yes | Yes | State mapping/currentness not established | Last observed activity only, after safe normalization |
| Permission request/resolution event | Yes, paired counts only | Yes | Correlation/pending behavior not established | Do not claim “waiting for permission” from this run |
| User-input request | Not observed | Unknown | No | Keep unknown / not observed |
| Phase | Not observed | No | No | `null` |
| Generic progress | Not observed | No | No | `null` |
| Test-case count | Not observed | No | No | Omit |
| Retry | Stream-recovery event only | Partially | No unified retry semantics | Event-only diagnostic; no generic retry label |
| Session read/replay | Same process observed | Yes | Same-process only | Queryable while session is registered |
| Cross-process session recovery | Empty-session attempt failed; ambiguous older session excluded | Partial | No | Do not promise recovery |
| Final result | Successful turn observed | Yes | This single task only | Runtime turn outcome; keep Agent report separately labeled |

## Answers to the five questions

**Q1. Can the runtime provide more structured Native Feedback data than the Bridge currently uses?**
Yes. This probe observed `permission.requested/resolved`, `streamRecovery.updated`, additional `model.streaming` kinds, rich `session.updated` metadata, and snapshot fields such as `runtime.pendingRequestIds`, `runtime.stateRevision`, and `settings.model.current`. Some fields carry sensitive material or lack proven feedback semantics; they should not be exposed without an allowlist and targeted validation.

**Q2. Can we reliably know whether the agent is waiting, using a tool, or generating output?**
We observed output-stream and tool-related events, plus permission request/resolution notifications. We did not prove a stable current-operation state or a pending human interaction state. `activity` can represent a last observed event, but “tool running” and “waiting for user” are not established by this run.

**Q3. Can we reliably obtain phase or progress?**
No structured phase or generic progress was observed. Keep both `null`.

**Q4. Can Bridge rebuild state after disconnect/restart with native queries?**
Same-process `session/read` and `session/events` work. The unique empty-session reconnect attempt could not be read, listed, or resumed after the original process ended. Active/completed-task recovery remains unverified; do not claim full reconstruction.

**Q5. What is the smallest trustworthy snapshot?**
Freeze only task identity/attempt/status and runtime-reported model metadata plus clearly source-labeled final result/timing. Keep phase/progress null. Represent tool events as last-observed activity only; do not assert currentness. Keep interaction state weak until a real pending interaction and recovery round trip are captured. A runtime turn success must remain distinct from task acceptance: this probe returned success while the requested artifact was missing at host-side inspection.

## Limitations

This probe covers one installed runtime version, one provider/model path, one successful task, and one empty-session reconnect attempt. It did not exercise user input, a human permission wait, cancellation, failure, a second model/provider, or reconnect during an active turn. Event counts and ordering are single-run observations, not protocol guarantees. No raw event dump was saved because it could contain reasoning, tool arguments, credentials, or provider telemetry.
