# 当前接口与兼容边界

> Status: AUTHORITATIVE
> Last updated: 2026-10-14
> Last verified: 2026-10-14，本地源码与回归；真实 provider 错误字段兼容仍 NOT RUN。

准确类型与 schema 以 `src/interfaces.ts` 和 `src/mcp/schemas.ts` 为准。核心公共入口见 [SHARED_CORE.md](SHARED_CORE.md)。历史源码注释中的 V0.1/FROZEN 是沿革说明，不代表当前新增功能已经冻结。

默认 MCP 工具：`zcode_task`、`zcode_status`、`zcode_feedback`、`zcode_result`、`zcode_continue`、`zcode_cancel`、`zcode_events`、`zcode_interaction_reply`、`zcode_doctor`、`zcode_model_catalog`、`zcode_default_model`、`zcode_set_default_model`、`zcode_clear_default_model`。实验 progress probe 需显式启用。

TaskPackage 的五个数组必须存在，可为空。workspace 是绝对项目路径；worktree_path 是宿主已准备的执行目录。Bridge 不创建或删除 worktree。task_id 只能是最多 64 字符的字母数字、下划线和连字符。单 attempt timeout 范围 60,000–14,400,000 ms。

任务状态为 queued/running/completed/failed/cancelled/waiting_for_master。后四种结束当前 attempt；completed 表示执行及报告解析完成，宿主仍独立验收。续跑只接受 completed/failed/waiting_for_master，且清理必须已验证；保留同 task ID、执行目录和旧 attempt 证据。

AgentReport 必须包含布尔型 needs_master_decision；缺失或字符串值仍返回 invalid_agent_report，不静默合成。该错误的显式续作使用仅修复报告的 prompt，携带 candidate 与有界原始响应，不重发原实现任务或测试命令，禁止模型编辑或重跑。Bridge 不自动增加修复 turn；禁止工具操作是 prompt 约束，不是 OS 沙箱。心跳而无业务事件时 observation.activity 为 starting（启动宽限内）或 unknown，不声称业务执行。固定反馈模板区分原 attempt 的 cleanup_failed 与后续 cleanup=verified；未确认清理标为未验证，不能写成 NOT RUN。决策见 ADR-005。

任务 objective、requirements、路径、验收、测试命令及续跑 feedback 不截断；完整 prompt 超过 60,000 字符会返回 TASK_INVALID。参考 context 与旧结果摘要仍有明确的截断标记，不能把安全约束只放在参考 context。

zcode_events 使用单调 seq cursor、limit 1–200、wait_ms 0–25,000、raw/summary view。summary 合并可见输出时会注明压缩。公开事件只包含可见文本、工具名称与状态，以及有限的生命周期 metadata；隐藏 reasoning 和未知 usage metadata 不进入公开事件。`turn.failed` 只投影 Bridge 稳定错误码，不转发 provider 原始 RPC error；明确额度耗尽显示为 `zcode_usage_exhausted`，未识别原因仍显示为 `zcode_nonzero_exit`。订阅前记录 `snapshot.runtime.eventSeq`。live 订阅连续 10 秒没有新事件时，每 5 秒按已观测序号向 `session/events` 补拉一次，重放仍经过同样的 session、单调 runtime seq 和 turn ID 过滤；runtime 明确拒绝该方法时降级为纯 live 订阅，连续 3 次失败后同样降级，两种情况都会发出可见的 `session_event_replay_unavailable` 事件。协议变化不能只靠字符串方法名推断支持。`session/read` 未接入，原生当前状态查询仍为 NOT RUN。运行时事件先核对 session、单调 runtime seq 和可用 turn ID；存在历史事件的 session 必须观察新 turn.started 后才接受结束事件。缺少某些身份字段的旧协议仍有兼容路径，真实跨版本行为未全部验证。

`zcode_feedback` 是独立的 `TaskFeedbackSnapshotV01` v0.1 聚合层，含 `schema_version: "0.1"`，并返回结构化 snapshot 与简洁文本。它不替代 `zcode_events`，也不改变 `TaskResult`、状态接口或已持久化记录。字段来源分为 Bridge task state（task、attempt、status、起止时间和墙钟 duration）、runtime-observed（只接受当前 attempt 规范化 `model_selected`、`model_tool_call`、`tool_status` 事件中的 allowlisted 字段）和 Agent report（仅当前 attempt 出现 `report_ready`、结果 attempt/status 匹配且结果为 `completed` 或 `waiting_for_master` 时，标记 `source: "agent_report"`）。模型不从请求或 catalog 回退；runtime model 缺失时为 `null`。`phase` 与 `progress` 固定为 `null`。activity 使用 Bridge 持久化事件时生成的 observation timestamp，语义固定为 `last_observed`；不表达工具仍在运行。交互状态固定为 `not_observed`，表示 snapshot 未确立可靠的当前交互状态，不表示历史中没有交互或没有待处理请求；原始交互事件仍由 `zcode_events` 提供。该 snapshot 不包含 runtime turn outcome 或 Bridge failure reason 字段，因此文本只显示可由 Bridge status 支持的完成/失败状态，不推断 turn 成功、目标完成或主机验收。Agent 报告中的 summary、文件、tests 与 issues 均不是 Bridge 独立验证结果。

zcode_interaction_reply 必须引用当前 attempt 的 interaction_requested.request_id，不能复用旧 ID。permission 只接受 allow/deny；user input 接受 accept/decline，answers 以完整问题文本为键。工具 schema 与 TaskManager 校验回答长度、支持的问题和允许选项。任务约束与路径声明不是 OS 权限控制。

稳定错误包括 TASK_INVALID、TASK_ALREADY_EXISTS、TASK_ID_CONFLICT、CONTINUE_OPERATION_CONFLICT、BRIDGE_BUSY、REQUEST_QUEUE_TIMEOUT、TASK_NOT_FOUND、TASK_NOT_FINISHED、TASK_STATE、CANCEL_FAILED，以及 runtime/provider、timeout、invalid_agent_report 等执行错误。明确匹配到 ZCode provider 用量额度耗尽错误时，任务保留 `failed` 语义并使用 `error_code: "zcode_usage_exhausted"`；仅当 runtime 错误字段含明确 quota/usage exhaustion 标记才使用该码，HTTP 429、一般限流和未知错误仍为 `zcode_nonzero_exit`。该错误结果说明当前执行已中断，Codex 应立即停止当前任务并告知用户，不继续工作、不自动重试或续作，并等待用户确认额度恢复。相同 task_id 与相同任务内容会重放首次回执；不同内容返回 TASK_ID_CONFLICT。超时后使用原 task_id 查询或重试，不要换 ID。续作可传 operation_id；相同 ID 与相同反馈会重放回执，不同反馈返回 CONTINUE_OPERATION_CONFLICT。cleanup_failed 表示运行时清理未验证，任务保持目录占用；再次 zcode_cancel 尝试清理后保留原执行结果。

公开进度 usage 仅保留数值 token/cost 字段，隐藏推理、未知 metadata 和原始 RPC error 不转发。审批需要的工具输入、任务 prompt、可见回答、私有本地日志仍属于可能含敏感内容的任务证据，使用者须按本地数据策略管理。
