# 当前接口与兼容边界

> Status: AUTHORITATIVE
> Last updated: 2026-10-28
> Last verified: 2026-10-28，静态核对本次四个调度工具的 schema、acceptance_met 与 attempt 约束；另核对本机 systemd 255 / MCP / Bridge worker 的 8 项离线闭环实测证据（执行器和 App 接收端为 fixture、无模型调用），详见 [ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md#当前验证边界2026-10-28)。另已完成本机真实 ZCode 自评/续作、当前 App 消息送达与 Codex 独立验收；新版调度在对话空闲时启动新轮次仍未验证，详见 ADR-010。
> Verified against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + 当前 working tree（ADR-010 调度离线实测与 ADR-011 额度诊断回归；仅上述范围）
> Quota verification: 2026-10-28，ADR-011 白名单字段、provider 范围和 RPC 错误投影；离线协议及 worker 持久结果回归，真实额度故障 NOT RUN。
> Prior verification: 2026-10-15，最新上游整合分支的验证结果见[审查说明](reports/2026-10-15-browser-and-transport-fixes.md)；旧版本实测与当前分支回归分别记录。
> Prior verified against: 上游fae74e45033a50fb560c0014d1a6d60a7dc771d1 + 本分支修复；受测源码指纹见审查说明。

准确类型与 schema 以 `src/interfaces.ts` 和 `src/mcp/schemas.ts` 为准。核心公共入口见 [SHARED_CORE.md](SHARED_CORE.md)。历史源码注释中的 V0.1/FROZEN 是沿革说明，不代表当前新增功能已经冻结。

共享核心的 13 个 MCP 工具：`coding_agent_task`、`coding_agent_status`、`coding_agent_feedback`、`coding_agent_result`、`coding_agent_continue`、`coding_agent_cancel`、`coding_agent_events`、`coding_agent_interaction_reply`、`coding_agent_doctor`、`coding_agent_model_catalog`、`coding_agent_default_model`、`coding_agent_set_default_model`、`coding_agent_clear_default_model`。实验 progress probe 需显式启用。默认 Codex stdio 宿主另装配下述四个调度工具；generic `createBridgeServer` 未传 schedule 时不会注册它们。

## 预约目标工具（ADR-010）

| 工具 | 输入与行为 |
|---|---|
| `coding_agent_schedule` | `{ task: TaskPackage, start_at, thread_id }`。start_at 必须为带 `Z` 或 `±HH:MM` 的 ISO 8601 datetime（含秒），thread_id 是用户授权绑定的原本机 Codex 聊天 UUID。同 task ID 的相同请求重放回执，不同请求或已存在的普通 task ID 冲突。回执含目标状态、开始时间、thread ID、监督 unit/log_path。 |
| `coding_agent_schedule_status` | `{ task_id }`。分别返回 schedule、execution（派发前可为 null）、goal（attention、attempt_under_review、review）与 notifications（稳定 event_id、attempt、delivery）。 |
| `coding_agent_schedule_review` | `{ task_id, attempt, accepted, feedback? }`。只验收 awaiting_review 对应的当前 attempt；拒绝须非空具体 feedback（最多 8,000 字符），继续同 session；接受须 cleanup verified，结束目标。相同判定重试重放，冲突或旧 attempt 拒绝。 |
| `coding_agent_schedule_cancel` | `{ task_id }`。先持久化停止意图，再取消现有执行并验证清理；成功后停止监督单元。调用中断后 runner 恢复取消；清理失败保留 `cancel_requested=true`、目标进入 failed，以 `cancel_failed` attention 唤醒并暂停自动清理重试/续作。可显式再次取消；已接受目标拒绝取消。 |

目标状态为 `scheduled` / `dispatched` / `awaiting_review` / `accepted` / `cancelled` / `failed`，与 execution 的六种状态分开。一次预约只有一个绝对开始时间及同一目标；不是周期创建新任务。首版要求支持 `--expand-environment=no` 的 Linux user systemd（254 或更新版本）与宿主提供的 Codex App pipe，不满足时调度显式报错，原 13 工具仍可用。

`AgentReport.acceptance_met` / `TaskResult.acceptance_met` 是可选 boolean，普通任务可省略，字段存在但不是 boolean 仍为 invalid_agent_report。只有调度 prompt 强制要求它。completed + false 在 cleanup verified、session 已保存时静默续作；completed + true 请求 Codex 独立验收；needs_master_decision 优先交给 Codex。缺失/无效自评、失败、额度耗尽、待决策、待权限/输入与未确认清理不会当作成功或盲目重试。timeout 只有 session 已保存且清理已验证才自动续作。

通知 delivery 为 `pending` / `sent` / `failed` / `superseded`，附发送次数与可选错误、重试时间。交付至少一次，回执丢失可能重复；取消意图使普通未送通知 superseded，但仍交付 `cancel_failed`；接受及旧 attempt 的未送通知也 superseded。通知仅唤醒原聊天检查权威状态，sent、completed 和自评 true 均不代表独立验收通过。正常进展与拒绝续作不通知人，只在独立验收通过或关键问题需处理时通知。

调度错误包括 `SCHEDULE_INVALID`、`SCHEDULE_CONFLICT`、`SCHEDULE_NOT_FOUND`、`SCHEDULE_STATE`、`SCHEDULE_STALE_REVIEW`、`SCHEDULE_FEEDBACK_REQUIRED`、`SCHEDULE_SUPERVISOR_UNAVAILABLE`；TaskManager 错误仍保留。内部 `ContinueTaskInput.expected_attempt` 在 Manager 锁内检查，保护调度反馈的 attempt 归属，不增加普通 `coding_agent_continue` MCP 输入字段。

App pipe 是 Observed Linux App 26.1016.61520 / codex-app-tools 0.1.6 的内部接口，无公开跨版本保证。本机真实调度、自评续作、当前 App 消息送达与 Codex 独立验收已通过；新版调度的空闲聊天新轮次仍未验证。离线与真实验证范围分别见 [ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md#当前验证边界2026-10-28)。

## 原任务合同

TaskPackage 的五个数组必须存在，可为空。workspace 是绝对项目路径；worktree_path 是宿主已准备的执行目录。Bridge 不创建或删除 worktree。task_id 只能是最多 64 字符的字母数字、下划线和连字符。单 attempt timeout 范围 60,000–14,400,000 ms。

任务状态为 queued/running/completed/failed/cancelled/waiting_for_master。后四种结束当前 attempt；completed 表示执行及报告解析完成，宿主仍独立验收。续跑只接受 completed/failed/waiting_for_master，且清理必须已验证；保留同 task ID、执行目录和旧 attempt 证据。

AgentReport 必须包含布尔型 needs_master_decision；缺失或字符串值仍返回 invalid_agent_report，不静默合成。该错误的显式续作使用仅修复报告的 prompt，携带 candidate 与有界原始响应，不重发原实现任务或测试命令，禁止模型编辑或重跑。Bridge 不自动增加修复 turn；禁止工具操作是 prompt 约束，不是 OS 沙箱。心跳而无业务事件时 observation.activity 为 starting（启动宽限内）或 unknown，不声称业务执行。固定反馈模板区分原 attempt 的 cleanup_failed 与后续 cleanup=verified；未确认清理标为未验证，不能写成 NOT RUN。决策见 ADR-005。

任务 objective、requirements、路径、验收、测试命令及续跑 feedback 不截断；完整 prompt 超过 60,000 字符会返回 TASK_INVALID。参考 context 与旧结果摘要仍有明确的截断标记，不能把安全约束只放在参考 context。

coding_agent_events 使用单调 seq cursor、limit 1–200、wait_ms 0–25,000、raw/summary view。summary 合并可见输出时会注明压缩。公开事件只包含可见文本、工具名称与状态，以及有限的生命周期 metadata；隐藏 reasoning 和未知 usage metadata 不进入公开事件。`turn.failed` 与 RPC 错误回复仅投影 Bridge 稳定错误码，不转发 provider 原始错误；按 [ADR-011](decisions/ADR-011-provider-quota-diagnostic-coverage.md) 读取白名单诊断字段，明确额度耗尽显示为 `zcode_usage_exhausted`，未识别原因仍显示为 `zcode_nonzero_exit`。订阅前记录 `snapshot.runtime.eventSeq`。live 订阅连续 10 秒没有新事件时，每 5 秒按已观测序号向 `session/events` 补拉一次，重放仍经过同样的 session、单调 runtime seq 和 turn ID 过滤；runtime 明确拒绝该方法时降级为纯 live 订阅，连续 3 次失败后同样降级，两种情况都会发出可见的 `session_event_replay_unavailable` 事件。协议变化不能只靠字符串方法名推断支持。`session/read` 未接入，原生当前状态查询仍为 NOT RUN。运行时事件先核对 session、单调 runtime seq 和可用 turn ID；存在历史事件的 session 必须观察新 turn.started 后才接受结束事件。缺少某些身份字段的旧协议仍有兼容路径，真实跨版本行为未全部验证。

`coding_agent_feedback` 是独立的 `TaskFeedbackSnapshotV01` v0.1 聚合层，含 `schema_version: "0.1"`，并返回结构化 snapshot 与简洁文本。它不替代 `coding_agent_events`，也不改变 `TaskResult`、状态接口或已持久化记录。字段来源分为 Bridge task state（task、attempt、status、起止时间和墙钟 duration）、runtime-observed（只接受当前 attempt 规范化 `model_selected`、`model_tool_call`、`tool_status` 事件中的 allowlisted 字段）和 Agent report（仅当前 attempt 出现 `report_ready`、结果 attempt/status 匹配且结果为 `completed` 或 `waiting_for_master` 时，标记 `source: "agent_report"`）。模型不从请求或 catalog 回退；runtime model 缺失时为 `null`。`phase` 与 `progress` 固定为 `null`。activity 使用 Bridge 持久化事件时生成的 observation timestamp，语义固定为 `last_observed`；不表达工具仍在运行。交互状态固定为 `not_observed`，表示 snapshot 未确立可靠的当前交互状态，不表示历史中没有交互或没有待处理请求；原始交互事件仍由 `coding_agent_events` 提供。该 snapshot 不包含 runtime turn outcome 或 Bridge failure reason 字段，因此文本只显示可由 Bridge status 支持的完成/失败状态，不推断 turn 成功、目标完成或主机验收。Agent 报告中的 summary、文件、tests 与 issues 均不是 Bridge 独立验证结果。

coding_agent_interaction_reply 必须引用当前 attempt 的 interaction_requested.request_id，不能复用旧 ID。permission 只接受 allow/deny；user input 接受 accept/decline，answers 以完整问题文本为键。工具 schema 与 TaskManager 校验回答长度、支持的问题和允许选项。任务约束与路径声明不是 OS 权限控制。

大审批输入事件与完整性边界（ADR-008）：审批 params 完整私有保存至 1 MiB UTF-8 bytes（计量单位是 `JSON.stringify(params)` 的紧凑序列化，不是整个 JSON 记录文件）。单事件行仍守 64,000 bytes：小请求保持既有完整字段形状；超限请求发布为 `preview: true` 的有界预览（`input_preview`、`input_bytes`、可选 `questions_preview`/`options_preview`），并附 `full_request` 引用（同任务/attempt 私有记录的 `file` 路径、`bytes`、`sha256`）。`bytes`/`sha256` 对应上述序列化 params，宿主复核时用同一单位，且预览不是全文，需要全文必须读引用记录。allow/accept 在 interaction 锁内校验记录与字节/哈希一致后落盘：完全无新元数据且 <=旧 32,000-byte 上限的记录按 legacy 兼容；缺/错类型元数据、不匹配、或验证时超过 1 MiB 的一律返回 TASK_STATE 且不记为已授权。等待中记录消失、损坏或与最初请求不一致时 worker 明确 decline（`interaction_request_undeliverable` 事件，`interaction_record_missing`/`interaction_record_unreadable`/`interaction_record_mismatch`），不悬挂轮询。超过 1 MiB 的请求以 `interaction_request_oversized` 事件（actual/limit）明确拒绝并建议拆分输入。SHA256/bytes 是损坏与意外改动的核对手段，不是对同 OS 账户恶意篡改的安全隔离。

协议帧边界（ADR-008）：app-server stdout 的完整 JSON-RPC 帧按换行逐条消费，单帧上限 16 MiB 原始未 trim 的 UTF-8 字节；帧顶层必须是 JSON 对象。越限、坏 JSON 或非对象帧为致命协议错误（`protocol_error` 事件，含 error_code 与安全大小字段），锁存首个原因、结束全部 pending RPC 与 turn、阻止后续 request；模型文本捕获保持独立的 2,000,000 字符上限与截断标志。该行为不改变任何 MCP 工具名与 schema。

稳定错误包括 TASK_INVALID、TASK_ALREADY_EXISTS、TASK_ID_CONFLICT、CONTINUE_OPERATION_CONFLICT、BRIDGE_BUSY、REQUEST_QUEUE_TIMEOUT、TASK_NOT_FOUND、TASK_NOT_FINISHED、TASK_STATE、CANCEL_FAILED，以及 runtime/provider、timeout、invalid_agent_report 等执行错误。明确匹配到 ZCode provider 用量额度耗尽错误时，任务保留 `failed` 语义并使用 `error_code: "zcode_usage_exhausted"`；仅当 runtime 错误字段含明确 quota/usage exhaustion 标记才使用该码，HTTP 429、一般限流和未知错误仍为 `zcode_nonzero_exit`。该错误结果说明当前执行已中断，Codex 应立即停止当前任务并告知用户，不继续工作、不自动重试或续作，并等待用户确认额度恢复。相同 task_id 与相同任务内容会重放首次回执；不同内容返回 TASK_ID_CONFLICT。超时后使用原 task_id 查询或重试，不要换 ID。续作可传 operation_id；相同 ID 与相同反馈会重放回执，不同反馈返回 CONTINUE_OPERATION_CONFLICT。cleanup_failed 表示运行时清理未验证，任务保持目录占用；再次 coding_agent_cancel 尝试清理后保留原执行结果。

公开进度 usage 仅保留数值 token/cost 字段，隐藏推理、未知 metadata 和原始 RPC error 不转发。审批需要的工具输入、任务 prompt、可见回答、私有本地日志仍属于可能含敏感内容的任务证据，使用者须按本地数据策略管理。

控制面、权威状态与补充观察的边界见 [ADR-004](decisions/ADR-004-separate-control-state-and-observation.md)：ZCode 本地 metadata、rollout 与日志可以进入补充观察，但不得单独决定任务状态、状态迁移或恢复结论；Desktop `tasks-index.sqlite` 是登记过的 best-effort 集成例外。

可选浏览器宿主（ADR-007）只新增反向 RPC，不改任何公开 MCP 工具名与 schema：app-server 的 `interaction/browserList` 回 `{ browsers: [] }`（关闭时的正确表达）或单个 cdp descriptor；`interaction/browserExecute` 回官方 BrowserCommandResult（含结构化 error、sideEffect none/uncertain 与 elapsedMs）。host 端参数解析保持身份字段（requestId/sessionId）必填、咨询字段（workspace/clientMode 等）可选并剥未知键；跨 session、workspacePath/workspaceKey 与绑定不符、turnId 冲突、重复在途 requestId、stale browserId/generation、非法命令分别得到拒绝或结构化错误，不再落入通用 Unsupported。浏览器事件仅含生命周期与错误码（browser_host_started/disabled/launch_failed/closed、browser_cleanup_unverified），不记录 URL、标题、页面内容、截图、auth 或 CDP endpoint。浏览器清理与 app-server 清理共同决定最终 cleanupVerified；任一未验证即保持 cleanup_failed 语义。桌面 IAB、Computer Use、录制、用户 tab 认领与子会话派生不在合同内，descriptor 以 apiSupportOverrides 如实隐藏。1.2.3修复版本已做限定live模型链路验收；本分支及跨app-server版本范围见审查说明。

## Kimi 执行器增量（ADR-012）

`TaskPackage.executor` 可选 zcode/kimi，省略仍走原路径。Kimi 使用 `kimi: { model?, reasoning_level?, permission_mode? }`，默认 yolo，不接受 ZCode model 字段；续作保持已持久化的 executor 与 session。工具改名见 ADR-013；参数与持久记录保持兼容；ZCode doctor/catalog/default_model 不用于诊断或配置 Kimi。兼容字段 zcode_session_id、zcode_pid、zcode_output 在 Kimi 任务中存放 Kimi 对应证据，执行 profile.executor 和 usage.source 区分来源。

KimiAdapter 通过认证的 loopback Server API 执行；先 GET snapshot 恢复冷会话并取得游标，再订阅确认并提交独立 prompt_id。只接受当前 session/main agent/prompt/turn，失败、断流、文本偏移不符及无效报告均不得完成；thinking 不外发。审批/问题走既有 interaction 存储；成功和失败均验证进程树清理。Kimi 明确额度耗尽使用 kimi_usage_exhausted，普通 429 为 kimi_nonzero_exit；调度额度故障只升级通知，不自动续作。

配置、版本与验证范围见 [ADR-012](decisions/ADR-012-kimi-executor.md) 和[验证报告](reports/2026-10-28-kimi-validation.md)。本节不扩展原有 ZCode 的历史验证结论。

## Coding Agent Bridge 命名（ADR-013）

展示名为 **Coding Agent Bridge**，MCP server key 为 `coding_agent_bridge`，公开工具使用 `coding_agent_*`（可选 ledger 工具为 `coding_agent_ledger_*`）。旧 `zcode_*` / `ledger_*` 工具名不再注册；升级后刷新 MCP 工具列表并更新调用名。安装 ID、包名、路径、环境变量和已存任务字段保持原值。ZCode 支持模型与 `model.reasoning_level` 选择，档位取自 `coding_agent_model_catalog`；Kimi 支持 `kimi.model` 和可选 `kimi.reasoning_level`，透传原生 thinking，支持值依模型而定；见 [ADR-014](decisions/ADR-014-kimi-reasoning-level.md)。见 [ADR-013](decisions/ADR-013-coding-agent-bridge-discovery.md)。
