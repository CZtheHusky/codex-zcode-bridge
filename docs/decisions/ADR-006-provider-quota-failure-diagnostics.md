# ADR-006：Provider 用量耗尽诊断

> Status: DECISION
> Decision: Accepted（用户于 2026-10-14 请求 Bridge 明确提示用量耗尽）
> Date: 2026-10-14

## Context

TermSplice task `TERM-PHASE2-INPUT-20261014-01` 的 attempt 4–6 在 runtime 报告 `session_ready`、`turn_started` 后快速失败。持久记录的错误码均为 `zcode_nonzero_exit`，ZCode 可见输出为空，usage 未报告，attempt stderr 为空。用户观察到 ZCode 用量已耗尽。

当前 `ZCodeAppServerAdapter` 在收到 `turn.failed` 时读取 `payload.error`，但丢弃内容并用通用 `ZCode turn failed` 结束。这使 Bridge 无法向任务结果明确归类 provider 报告的额度耗尽。历史 attempt 没有保留原始 payload，故无法从这些 Bridge 记录确认其具体 provider 错误文本或代码。

## Decision

1. 在 `turn.failed` 路径中，只检查 `payload.error` 的顶层 `code`、`type`、`message` 字段（或受限纯文本错误值），仅匹配明确的 quota/usage/credits exhausted 表达式；HTTP 429、rate limit、泛化的 `limit exceeded` 和未知错误不视为额度耗尽。
2. 命中时使用稳定错误码 `zcode_usage_exhausted`，并通过任务错误事件与结果摘要提示“ZCode 提供方明确报告用量额度已耗尽”。该结果同时明确当前执行已中断，要求 Codex 立即停止当前任务并告知用户，不继续工作、不自动重试或续作，并等待用户确认额度恢复后再继续。未知原因继续使用 `zcode_nonzero_exit`。
3. 不向公共事件、错误摘要或结果转发 provider 原始错误文本、任意嵌套对象、RPC metadata、headers、凭据或环境信息。分类只暴露有限的 Bridge 自有错误码和固定说明。
4. 保留原有 `failed` 任务语义和 MCP schema；不新增重试、不修改 provider 配置、不改写历史任务记录。

## Rationale

历史记录只能证实 Bridge 丢弃了 runtime 的失败原因，不能独立证明额度耗尽。窄匹配可以在 runtime 给出明确证据时提供可操作诊断，同时避免把普通限流误报为额度耗尽或泄露原始 RPC 内容。

## Consequences

明确 quota error 的失败将拥有新稳定诊断码。若上游 runtime 不提供可识别的顶层错误文本/代码，Bridge 仍只能报告通用 `zcode_nonzero_exit`；这类结果必须标为原因未识别，不能由低 usage、快速退出或空输出推断额度耗尽。真实 provider schema 和 marker 覆盖仍需后续实跑核验。
