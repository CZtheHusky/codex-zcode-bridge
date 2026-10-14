# Native Feedback Renderer Recommendation

> Status: RESEARCH
> Date: 2026-10-05
> 研究结论，不代表当前实现。索引见 [README.md](README.md)。

This recommendation uses the evidence in [ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md](ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md). It separates Bridge/runtime observations from Agent-reported result fields.

## Safe to render now

### Queued

```text
▣ ZCode · TASK_ID
○ Queued
```

**Source:** Bridge task status. The runtime probe did not observe a queued app-server state.

### Running

```text
▣ ZCode · TASK_ID
→ Running
Model: GLM-5.3 · Reasoning: max
```

**Source:** Running is the Bridge task status. Model and reasoning values are included only when the runtime snapshot reports them. This probe observed the values above for one task.

If a safe tool event is available, use a last-observed label:

```text
Last observed: Tool request · Write
```

Do not render `Tool running` from the current probe: `tool.updated` occurred, but its state values and currentness semantics were not validated in the sanitized capture.

### Interaction observed

The probe saw `permission.requested` and `permission.resolved` events, but no human approval wait. A renderer may report the event only if its normalized event has a safe summary and correlation:

```text
Permission event observed
```

Do not render “Waiting for permission” unless a validated pending interaction is present. User-input interaction was not observed.

### Completed

```text
▣ ZCode · TASK_ID
✓ Runtime turn completed

Agent report:
<summary>
Changed: <N> files
Tests: <command> · <reported status>
```

`Runtime turn completed` is based on `turn.completed` and its `resultType`; it does not prove that the requested task objective was satisfied. In this probe, the runtime returned success but the requested file was absent at host-side inspection. Show a Bridge task `COMPLETED` status only when Bridge has normalized a final result, and continue to label summary, changed files, and test command statuses as Agent-reported claims. Do not display a test-case pass count from command-level status.

### Failed

```text
▣ ZCode · TASK_ID · FAILED
Reason: <bounded Bridge error summary>
```

Use only after Bridge records a failed terminal status. This probe did not exercise failure handling, so it does not validate a runtime `turn.failed` mapping.

### Cancelled

```text
▣ ZCode · TASK_ID · CANCELLED
Result: Task cancellation confirmed by Bridge
```

Use only after Bridge confirms cancellation. The runtime cancellation path was not probed.

### Waiting for master

```text
▣ ZCode · TASK_ID · WAITING_FOR_MASTER
Agent report requires a master decision.
```

This is the Bridge terminal task status derived from the Agent report. It is not a runtime permission/user-input wait.

## Keep unsupported

Do not render these as facts until structured runtime evidence and state semantics are validated:

- `✓ Analysis / → Implementation / ○ Tests / ○ Review`
- `Tests · 38/42`, `73%`, or other progress inferred from tool calls, tokens, elapsed time, or text
- `Tool running · shell` based solely on a tool call/update event
- `Waiting: ZCode requires user input` based only on an earlier request event or absence of a reply in a partial event page
- A generic `Retrying` label based solely on `streamRecovery.updated`
- Any raw model text delta, reasoning delta, tool input/arguments, request headers, response headers, provider telemetry, or protocol dump

## Event aggregation

The probe saw 261 events for one task, including 177 `model.streaming` events. Do not forward every event to Codex Native Text. The Bridge’s current `summary` event view only merges adjacent visible model-output chunks; it is not a semantic phase/progress aggregator. A renderer should emit lifecycle changes and verified interaction transitions, retain raw diagnostics outside the default transcript, and throttle repetitive updates.

## Provenance labels

| Displayed value | Source label / rule |
|---|---|
| Queued/running/completed/failed/cancelled/waiting-for-master | Bridge task status |
| Turn started/completed and event-derived tool/permission activity | Runtime observed; use only normalized, allowlisted fields |
| Selected model and reasoning level | Runtime reported; omit if absent |
| Summary, changed files, test commands/status, issues | Agent report; not independent verification |
| Phase and generic progress | Unsupported; keep `null` |

Do not interpret `TaskResult.status = completed` as host acceptance or review PASS.
