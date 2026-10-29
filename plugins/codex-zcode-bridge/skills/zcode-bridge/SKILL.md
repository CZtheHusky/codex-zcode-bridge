---
name: zcode-bridge
description: 通过 Coding Agent Bridge 委派本机 ZCode 或 Kimi 编码任务；选择模型与推理档位，后台执行、查询进度、同会话续作、处理审批及取消；环境支持时预约执行并唤醒原 Codex 聊天独立验收。
---

# Coding Agent Bridge

> Status: AUTHORITATIVE
> Last updated: 2026-10-28
> Last verified: 2026-10-28，静态核对调度工具/schema、静默推进及独立验收指令，并核对本机 systemd 255 / MCP / Bridge worker 的 8 项离线闭环实测证据（执行器和 App 接收端为 fixture，无模型调用）；另已完成本机真实 ZCode 自评/续作、当前 App 消息送达与 Codex 独立验收；新版调度在对话空闲时启动新轮次仍未验证，详见 ADR-010。
> Verified against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + 当前 working tree（ADR-010 调度相关源码）。

你是 Master，ZCode 是执行一个有明确边界任务的 worker。仅委派用户已授权的实现工作。不同执行目录可并发；不得让 Codex 与 ZCode 同时修改同一个实际执行目录。Bridge 会串行化共享执行目录的任务。

## 能力速查

- 立即后台执行：`coding_agent_task`，默认 ZCode；Kimi 传 `executor: "kimi"`。普通任务不会主动唤醒聊天。
- 模型与推理：`coding_agent_model_catalog` 查询 ZCode 模型及档位，任务中传 `model.reasoning_level`；Kimi 使用 `kimi.model` 本地别名和可选 `kimi.reasoning_level`（原生 thinking；K3/K3.1 Pro 和标准模型当前支持 low/high/max），省略时保留原生设置；未提供 Kimi 模型目录工具。
- 跟进与续作：`coding_agent_events` / `coding_agent_status` / `coding_agent_feedback` / `coding_agent_result`；反馈交给 `coding_agent_continue`，保留同一执行器和 session。
- 审批与停止：`coding_agent_interaction_reply` 回复已授权的请求；普通任务用 `coding_agent_cancel`，预约目标用 `coding_agent_schedule_cancel`。
- 一次预约：`coding_agent_schedule` 在指定时间启动执行器，静默续作，自评达标后唤醒原 Codex 聊天独立验收；需要 Linux user systemd 与 Codex App pipe。Kimi 预约唤醒整链路未实测；不支持周期创建新任务。
- 诊断与默认模型：`coding_agent_doctor` 和默认模型工具仅用于 ZCode。completed 不是验收通过。

## 持续目标

本节用于当前聊天立即执行的持续委派。用户要求预约启动时使用下节调度工具，由持久调度器负责等待与续作；不要用当前轮长时间等待、活跃 Goal 反复轮询或另建周期自动化代替预约监督。

- 用户明确要求跨轮持续推进，例如“持续做到项目完成或我让你停止”时，把它视为当前 Codex 线程的长期目标；在派发首个 ZCode 任务前调用 `create_goal`，不要只在普通回复里复述持续意图。目标写明用户授权的最终结果、独立审查/验证要求、接收改动的条件，以及用户叫停或必须等待用户决定时的停止条件。不得借此扩大用户授权；除非用户明确指定，不设置 Goal token budget。
- 单次、有明确边界的委派或一次性问答不创建 Goal。若当前环境没有 Goal 工具，明确告知用户无法启用持久续行，不要声称已经创建。
- Goal 属于当前线程。保持它活动，直到最终目标经证据核验完成；Bridge 的 `completed`、ZCode 的完成报告或“任务仍在运行”都不单独满足完成条件。只有所有必要任务终态、改动完成独立审查和适用验证、授权范围内的改动已接收到目标工作区，才可完成 Goal。
- 若 Codex 当前轮结束时 Bridge 任务仍在运行，保留活动 Goal 并说明当前状态，让 Goal 在可继续时接手轮询；不要把中间状态作为最终结论或自行暂停 Goal。用户要求停止时遵从其指示。

## 预约启动与安静验收

1. 用户要求未来某时开始并持续做到验收通过时，使用 `coding_agent_schedule`。一次预约对应一个目标和 task ID，不定期创建新任务。先按“派发”准备完整 TaskPackage 和现存执行目录；把验收标准与关键约束写进要求。开始时间用含秒与时区的 ISO 8601 `start_at`（如 `2026-10-29T09:00:00-07:00`）；时间或时区有实质歧义先澄清。
2. 必须把用户授权的原本机 Codex 聊天 UUID 显式写入 `thread_id`，只从当前宿主上下文取得（宿主提供时可用当前 `CODEX_THREAD_ID`）。不知道原聊天 ID 就停止预约并说明缺失，不从别的进程环境、其他聊天或任务 ID 猜测。不要把 App pipe 地址或秘密放进 TaskPackage、context 或 ZCode prompt。
3. 调用 `coding_agent_schedule({ task, start_at, thread_id })`，检查回执的开始时间、绑定聊天、监督 unit 与 log_path。首版仅支持可用 Linux user systemd（systemd 254 起，须支持 `--expand-environment=no`）和 Codex App tools pipe；不支持时报告具体失败，不用 PTY、当前聊天、无监管后台进程或新建自动化假装替代。回执丢失用相同 task ID 与相同完整请求查询/重试。预约返回后简短确认并结束本轮，等待调度唤醒；本节不套用普通立即任务“马上读 events 并连续报告进度”的步骤。
4. 正常运行和 completed + `acceptance_met=false` 由调度器静默继续同 task/session，不轮询当前聊天，不通知用户。调度器只向调度 prompt 强制请求可选 boolean `acceptance_met`；这是 ZCode 自评，绝不等于 Codex 验收通过。timeout 仅在保存了 session 且清理验证通过后自动续作。
5. 收到调度唤醒后，先用 `coding_agent_schedule_status` 核对 event ID、当前 attempt、attention 和 `attempt_under_review`，再读取 `coding_agent_status` / `coding_agent_result` / 必要事件。通知至少一次交付，可能重复；已处理的事件、已取消/接受目标或旧 attempt 只核对状态，不重复验收或续作。App 消息送达也不是完成证据。
6. awaiting_review 时按照“审查与接收改动”检查实际 diff、执行适用验证并处理已授权的改动接收；不能只相信 completed、acceptance_met=true 或 worker 的 passed 自报。通过后对**当前待验收 attempt**调用 `coding_agent_schedule_review({ task_id, attempt, accepted: true })`，确认目标为 accepted，再通知用户验收结果和证据。未通过则调用 `accepted: false` 并给 `feedback`：具体失败、证据、期望行为与尚缺验收项；由调度器复用同 session 续作，普通返工保持安静。不要用新的 task ID 或普通 `coding_agent_continue` 替代这个 review 判定。
7. 权限/输入、needs_master_decision、缺失或无效自评、失败、额度耗尽与清理未确认只唤醒 Codex 判断，不自动批准或盲目重试。先用权威状态与已有授权处理能确定的事项；确需新增权限、关键决定或用户处理的问题再通知用户。权限仍遵守下文明确授权规则；额度耗尽立即停止并告知用户，等用户确认恢复；cleanup 未确认不能续作。不是 awaiting_review 的问题不能伪造 review 通过。
8. 用户取消时调用 `coding_agent_schedule_cancel`，确认持久停止意图、目标状态与执行清理；只调 `coding_agent_cancel` 不会关闭预约目标。MCP 调用中断后由 runner 恢复取消；收到 `cancel_failed` 时核对目标 failed 且 `cancel_requested=true`，确认自动续作与清理重试已暂停，处理清理问题，确需人决定时通知用户，不自动无限重试。通知失败或清理失败须如实报告，不把它们写成已通过。正常进展、未达标续作和验收拒绝不通知人，仅验收通过或关键问题需处理时通知。
9. App 唤醒适配仅为 Observed Linux App 26.1016.61520 / codex-app-tools 0.1.6 内部接口，无公开跨版本保证。本机 systemd 255 / MCP / Bridge worker 的 8 项离线闭环实测已通过（执行器和 App 接收端为 fixture，无模型调用），历史原聊天唤醒实测另列；本机真实 ZCode 自评/续作、App 消息送达和 Codex 独立验收已通过；新版调度在聊天空闲时启动新轮次仍未验证。不自动修改 provider 配置、安装插件、提交、推送或发布。

## 派发

1. 确认 Codex 项目根目录，并始终把它作为 coding_agent_task 的 `workspace`。根据 Codex 对任务的执行指示决定是否需要 worktree；需要时由 Codex 创建并准备，再把其现存绝对路径作为 `worktree_path`。Bridge 不创建、选择或删除 worktree；未提供该字段时任务直接在项目根目录执行。
2. 将 objective、requirements、allowed_paths、forbidden_paths、acceptance_criteria 和 test_commands 写具体，路径约束只是任务指令，不是强制沙箱。只在任务需要时传入精简的 `context`，按 `PROJECT DECISIONS`、`CONSTRAINTS`、`RELEVANT FILES`、`OPEN DECISIONS — DO NOT CHOOSE` 组织；不要复制整段 Codex 对话。没有未决事项时省略该小节。不要把验收责任交给 ZCode。
3. 用户指定 ZCode 模型或推理档位时，先调用 `coding_agent_model_catalog`，再传入 `model: { provider_id, model_id, reasoning_level? }`。`reasoning_level` 必须使用所选模型 `reasoning_levels[].value`，不能猜测 high/max 等值。优先使用 runtime 报告的精确 provider/model 标识；Bridge 会识别配置中声明的旧版 builtin ID 和账户 provider ID。若模型预检失败，从 `model_catalog` 事件复制 runtime 实际报告的完整标识再重试；不要猜思考档位。用户未指定时省略 model，使用 Bridge 已配置默认值；无 Bridge 默认值时使用 ZCode session 默认模型。
4. 调用 coding_agent_task。MCP 报错时先解释和解决具体配置问题，不要重复提交相同 task_id。

## 跟进

1. `coding_agent_task` 返回后立即调用 `coding_agent_events`（`after_seq: 0, view: "summary"`），不要先做别的工作或只复述 queued receipt。先报告 `workspace_ready` 中的 `project_path`、`execution_path`（如有则说明 Codex 准备的 worktree）和 queued/running 状态。按 `next_seq` 和 `wait_ms` 继续读取，直到出现 `turn_started`、明确启动失败或终态；不要忙轮询。
2. 在 `turn_started` 后、等待模型输出前，先向用户报告：Codex 项目根目录、实际执行目录、ZCode session ID、runtime 实际报告的 provider/model、runtime 实际报告的思考档位和执行模式。思考档位从 `session_ready.details.reasoning_level` 或 `model_selected.details.reasoning_level` 读取；若只有 `requested_reasoning_level`，说明这是请求值而不是 runtime 确认值；两者都没有时明确说 runtime 未报告档位，不要用模型目录的默认档位冒充当前档位。模式来自 Bridge 配置，默认 `yolo`；若为 `yolo`，明确提醒普通工具操作可能不经审批且使用当前 OS 账户权限，并说明可将 `ZCODE_BRIDGE_MODE` 设为 `build`。若使用 worktree，说明它不是 OS 沙箱。模型字段缺失时明确说 runtime 没有报告；不要把用户请求的模型或项目默认值猜成实际已选模型。
3. 如果在 `turn_started` 前失败，立即报告 Bridge 的启动错误；只有在 `session_ready` 已出现时才能声称 ZCode session 已创建。不存在 `session_ready` 时说明没有 ZCode session/model 元数据。
4. 运行期间用 `coding_agent_events` 的 `after_seq` 读取增量事件，默认使用 `view: "summary"`，需要逐条文本时改用 `view: "raw"`；`next_seq` 会跨过已合并事件。`wait_ms` 可设为 10000–25000；如需快速刷新状态，可调用 `coding_agent_status`。需要简洁、可直接呈现的当前 attempt 摘要时调用 `coding_agent_feedback`；其 `last_observed` activity 不是当前运行中的工具状态，`interaction: not_observed` 也不代表没有交互。心跳只证明 worker 响应，工具事件只证明已观测活动；没有命令输出或结果时，不把它们描述成测试持续推进、已通过或源码已还原。`stalled` 是提示，不自动取消或重派。向用户简短汇报模型可见输出和工具活动摘要。事件不包含隐藏推理；`interaction_requested` 会包含完成决定所需的有限请求细节。
5. 收到 `interaction_requested` 时，先向用户概述请求的方法、工具、理由、输入、选项或问题。事件带 `preview: true` 时，`input_preview` 只是有界预览，不是全文：需要完整输入时读 `details.full_request`（同一任务/attempt 的私有记录路径，`bytes`/`sha256` 按 `JSON.stringify(params)` 紧凑序列化计量，不是整个 JSON 记录文件），不要把预览当全文或据此放行。权限请求不得从任务描述、worktree 或 `yolo` 模式推定为获准：只有用户明确授权该项操作才可用 `coding_agent_interaction_reply` 的 `allow`，否则向用户询问或明确拒绝。批准由 Bridge 在落盘前校验完整记录一致；记录缺失、损坏或被改动时请求会被明确拒绝且不执行，此时如实向用户报告原因。用户输入问题只可依据已知信息或用户明确指示回答；计划审批须让用户决定。对于 `interaction/requestUserInput` 的 AskUserQuestion，`answers` 必须以请求中每个 `questions[].question` 的完整原文作为键，以用户选择或明确回答作为值；不得用 `header`、选项标签或选项值作键。先从 `interaction_requested.details.questions`（必要时从 `details.input.questions`）复制准确问题文本，再调用 `coding_agent_interaction_reply`。若 Bridge 报 `answers must be keyed by the exact ZCode question text`，用原问题文本修正键并重试同一个待处理请求。回复后继续读取事件并确认 ZCode 已继续或结束。
6. 任务终态后调用 `coding_agent_feedback` 获取标注来源的简洁原生文本，再按需调用 `coding_agent_result` 查看完整结果。completed 仅表示 Bridge/ZCode 执行和报告规范化完成，不代表代码审查通过；feedback 中的 Agent report 也不是 Bridge 独立验证。

遇到安装、运行时或 provider 配置问题时，先调用只读工具 `coding_agent_doctor`，根据每项状态诊断；它不会启动 ZCode session，`unknown` 不得描述成检查通过。

## 审查与接收改动

1. 在事件报告的实际执行目录检查 Git 状态、完整 diff、实际文件和测试。对照用户目标、允许/禁止路径和验收标准逐项核实。
2. 不能仅相信 AgentReport.files_changed、ZCode 报告的测试状态或模型输出；独立运行适用的验收命令。
3. 若执行目录是 worktree，在审查通过后由 Codex 按用户授权把所需改动接收到项目工作区；先保留项目中已有的用户改动、检查冲突，再复查并运行验收。若直接在项目根目录执行，则在同一目录审查。
4. Bridge 不会自动应用、合并或删除 worktree。不要在审查及接收改动前删除 Codex 准备的 worktree，也不要自动提交、推送或创建 PR。
5. 如果结果未达标，调用 coding_agent_continue，反馈具体失败证据；续作会复用同一 ZCode session 和原执行目录。任务运行期间若用户取消，调用 coding_agent_cancel 并确认终态。
6. 如果结果为 `invalid_agent_report` 且执行工作已完成，先检查 `report_candidate`、原始 `zcode_output` 和实际 diff；续作提示只要求修复 JSON 报告，不要再次编辑或重跑测试。缺少的决定字段必须基于证据补齐，无法确认时设 `needs_master_decision=true`。
7. 任务为 failed 时用 `coding_agent_result.error_code` 确认原因，不仅凭 `coding_agent_feedback` 的失败标签判断代码失败。`cleanup_failed` 是当时清理未能确认；后续 `coding_agent_status.observation.cleanup=verified` 表示已取得退出证据，原失败仍保留。分别报告两个事实，再独立验收代码。新鲜查询为 unknown 或 unverified 时不自行删除锁、改历史状态或另起同目录任务；旧不可读取锁需要独立诊断，不能按时间删锁。
8. 若 `coding_agent_result.error_code` 或失败事件为 `zcode_usage_exhausted`，这表示本次 ZCode 执行已中断：立即停止当前任务，不要继续编辑、派发、调用 `coding_agent_continue` 或自动重试；马上明确告知用户额度已耗尽、当前任务已中断，并等待用户确认额度恢复后再继续。

## 边界

- Bridge 单进程默认最多运行 8 个 worker，可用 `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 设为 1–8；执行目录重叠的任务会串行。多个 Bridge 进程之间没有全局调度锁，共享数据目录时不要并行提交冲突任务。
- 单次执行默认上限为 60 分钟；可在任务中设置 `timeout_ms`（60 秒至 4 小时），或用 `ZCODE_BRIDGE_TIMEOUT_MS` 设置用户默认值。超时后 Bridge 会终止该次进程树并保留 attempt 证据。
- 每个任务通过本机 ZCode app-server 运行；默认模式为 `yolo`，也可通过 `ZCODE_BRIDGE_MODE` 配置。`yolo` 会放行普通工具操作。记录版本上已完成单次 43,014-byte Write 的真实权限审批往返实测；其他审批组合未据此认证。告知用户实际执行模式和当前账户权限边界，不要把 worktree 描述成沙箱。
- `workspace` 是项目身份路径；`worktree_path`（如提供）是实际执行路径。Codex 决定是否准备 worktree，Bridge 只校验并使用所给路径。Git worktree 是工作区隔离，不是 OS 沙箱。allowed_paths / forbidden_paths 是 worker 指令；不得声称它们能强制阻止所有越界命令。
- ZCode 不得选择仍未解决的 `OPEN DECISIONS`；后续 Master Feedback 明确给出决定后，按新决定继续。即使未列出，遇到需求冲突或会实质改变外部行为的缺失决定，也要提出具体问题、设置 `needs_master_decision=true`，并继续不依赖该决定的工作。低影响实现选择可采用最简单一致的方案，同时报告假设。
- 不要把 ZCode Hooks、Desktop 历史索引或并行 worker 当作已启用能力。预约只使用上述显式调度入口，不把它扩展成周期自动化或其他宿主已启用能力。
- 不要为了方便而修改 ZCode provider 配置或将凭据写入任务 prompt、日志或仓库。

## 结果反馈格式（适合人来判读）

向用户汇报任务结果时使用固定结构：**一句话结论 → 任务总览 → 验收证据 → 待处理事项**。让用户能从固定位置回答四个问题：完成了什么、验证到哪一步、花了多少时间/token、还需要决定什么。

1. 任务总览是纵向两列表（项目 / 内容），固定包含：目标与交付、执行标识（task_id、attempt）、执行状态（Bridge 原始状态，注明"不等同验收通过"）、独立验收（通过/未通过/未验证/部分验证，注明责任方与范围）、接收与发布（已接收/未接收、已提交/未提交、已推送/未推送、已发布/未发布，各附证据；没有执行过的操作写"未提交/未推送/未发布"，不适用写"不适用"）、本次耗时（排队/执行/独立验证分开列，未知项写"未知"，不拼成虚假总数）、Codex 主会话 token、ZCode 执行 token、模型与推理档位、后续动作。
2. 验收证据表固定三列"检查项 / 结果 / 证据"。结果必须区分：独立实测（你真实运行过的）、worker自报（tests 等报告值）、历史记录、NOT RUN。没有独立验证时，绝不能因为 worker 报告 tests=passed 就把验收标成通过。
3. token 与模型判读规则：Codex 主会话 token 目前无来源，固定写"未取得：当前宿主未提供本次调用统计"，不得用账户额度、会话总量或文本长度估算。ZCode token 显示 `coding_agent_result.usage` 的输入/输出/总量及完整性，缺失写"未报告"，不填 0；运行中写"截至当前未取得最终 token"，绝不能引用上一次任务的用量。模型只显示 runtime 确认值（`session_ready`/`model_selected` 的 provider_id/model_id 与 reasoning_level）；请求值标"请求"，runtime 未报告写"未报告"；请求与实际不一致时明确标出差异。
4. 运行中的反馈只报有意义的变化：当前阶段（`coding_agent_status.observation.activity`）、已执行时长、最后业务进展时间、阻塞项；不反复输出整份完成报告。
5. 格式：时间用分/秒，超过 1 小时用时/分/秒；token 用千位分隔整数；表格单元格内的竖线、换行、链接要转义；大批同类测试可分组，详细日志放链接不进表格；session ID、PID、OS 指纹、内部 seq 放诊断详情，不占完成反馈。任务成功但清理未确认时，两个事实分开写，不只给一个笼统 PASS/FAIL。
6. `coding_agent_status.observation` 是统一观测（worker/runtime 存活、activity、result、cleanup、stalled 提示）。`stalled` 只是观测提示，不代表失败，也不要因此自动重试或取消；`unknown` 不判死。


## Kimi 执行器

用户选择 Kimi 时，在 coding_agent_task（预约时 task）传 `executor: "kimi"`，可传 `kimi: { model: "本地别名", reasoning_level: "max", permission_mode: "manual" | "yolo" | "auto" }`；默认 yolo，省略 model 使用会话模型或 Kimi 默认。可选 `kimi.reasoning_level` 透传原生 thinking，K3/K3.1 Pro 和标准模型当前支持 low/high/max，旧 highspeed 未报告可调档位；省略档位保留原生设置，不保证所有模型支持。续作保留同一设置，实际档位只认运行时确认值。尚未提供 Kimi 模型目录工具；不要传 ZCode 的 model，不要用 ZCode doctor/catalog/default_model 配置 Kimi。需要已登录的 Kimi Code CLI 2.3.3；KIMI_BRIDGE_EXECUTABLE/KIMI_CODE_HOME 是可选环境配置。

仍用 `coding_agent_status`、`coding_agent_events`、`coding_agent_feedback`、`coding_agent_result`、`coding_agent_continue`、`coding_agent_interaction_reply` 和 `coding_agent_cancel` 跟进；zcode_session_id/zcode_pid/zcode_output 是兼容字段，在这些任务里记录 Kimi。模式属于请求配置；除非运行时明确报告，不声称实际档位或模式已确认。续作必须复用同 task ID、原执行器和 session。Kimi 请求审批/回答时沿用本技能的授权和完整请求检查规则；yolo 不代表所有请求已授权。kimi_usage_exhausted 表示本次已中断，立即告知用户并停止自动工作/重试/续作，等待用户确认额度恢复；普通限流与其区分。completed 仍须 Codex 独立验收。
