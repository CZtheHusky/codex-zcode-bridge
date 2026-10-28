# ADR-010 — 定时运行 ZCode 与原 Codex 聊天唤醒

> Status: DECISION
> Date: 2026-10-27
> Decision owner: 用户授权开发；Codex 根据已完成的本机链路实测制定首版范围。

## 背景与证据

用户要求由 ZCode 定时启动并持续做到自评达标，然后唤醒原 Codex 聊天独立验收；正常执行静默，验收不通过则继续同一 ZCode session。2026-10-27 已实测：Linux App 26.1016.61520 / codex-app-tools 0.1.6 的本地工具 pipe 可调用 send_message_to_thread，空闲的原聊天会启动新轮次。该通道属于观测到的 App 内部接口，不宣称公开稳定合同。只发送唤醒事件，不把 App 回执当作任务验收。

## 决策

1. 新增可选的调度层，组合现有 TaskManager，不改变其六种状态和 attempt/cleanup 规则。首版支持带时区的绝对开始时间，启动一个目标，持续至 Codex 接收或取消。不是每隔一段时间创建一个全新目标。
2. 提供 zcode_schedule、zcode_schedule_status、zcode_schedule_review、zcode_schedule_cancel。提交包含完整 TaskPackage、start_at、明确的原 Codex thread_id（本机 host）。使用 task_id 作为调度主键。重试相同提交复用记录，冲突显式报错。review 接收当前 attempt 与 accepted 或带具体反馈的 rejected；拒绝调用原 continueTask 复用 session，并重新监控。接收才结束目标。
3. 调度进程由 Linux systemd --user 服务监管，脱离 MCP/聊天生命周期。没有可用用户级 systemd 时明确失败，不降级为 PTY 或无监管的长任务。不自动启用用户 linger，不承诺关机/注销/App 关闭后的运行。运行记录、监督单元和日志可查询；取消先持久化停止意图，禁止后续自动续作，再经 TaskManager 验证清理。进程崩溃由监督服务恢复，持久化意图和既有 task/continue 幂等机制防止重复执行。
4. AgentReport/TaskResult 增加可选 acceptance_met 布尔值，旧任务可省略；这是 ZCode 自评，不是 Codex PASS。仅调度任务的 prompt 强制请求该字段。completed 且 acceptance_met=false 且无决策时自动 continue；true 时请求 Codex 验收。缺失/无效自评、需要决策、失败、额度耗尽、清理未确认不得自动视为成功或盲目重试。单次超时只在 session 已存在且清理已验证时允许继续原 session；其他失败交由 Codex 判断。额度耗尽绝不自动续作。
5. 已提交、attempt 匹配的 TaskResult 才能触发终态处理，不使用先于提交的 task_finished 事件作完成事实。挂起的权限/输入请求以当前 attempt 的 Bridge 私有请求记录确认，唤醒 Codex，不自动批准。
6. App 唤醒适配与共享调度策略分离；共享核心不依赖 Codex 私有接口。宿主显式注入发送能力。只把 pipe 路径用于调度宿主，不透传给 ZCode worker，也不扩大环境白名单。任务绑定保存明确 thread_id；不能从另一进程的环境猜测原聊天。
7. 唤醒发送前持久化待发送事件，成功回执后标记已发送，失败保留错误与重试状态。可恢复交付采用至少一次语义：发送成功但回执/落盘丢失仍可能重复；消息含稳定事件标识和 attempt，review 使用已有 operation_id 保证续作幂等并拒绝过期验收。通知失败不改写执行结果。重连入口可更新 App pipe；不枚举别的 socket，不读取凭据或转发完整 prompt、环境、工具参数。
8. 唤醒提示要求 Codex 读取权威任务状态并独立验证。正常推进不通知人；仅通过验收或确需人决策时通知。调度状态与交付状态可观察，不能把消息发送成功标记为用户任务完成。
9. 不新增 npm 运行时依赖，不更改 provider 配置，不自动提交、推送、发布或替换用户已安装插件。

## 取消恢复补充（2026-10-28）

已复现的停止意图恢复场景要求：runner 恢复未完成的取消；只有 TaskManager 的最新 cleanup=verified 才可标记 cancelled。清理调用失败或返回后仍未确认时，目标保留 cancel_requested=true，进入 failed，以 cancel_failed 事件请求原聊天决定；停止自动清理重试，显式再次取消才重试。其他未送通知被 superseded。systemd runner 使用 /usr/bin/env -i 和显式环境白名单，禁止继承 user manager 的任意环境；启动要求 systemd-run 支持 --expand-environment=no。

## 验收

以下是验收要求，不表示已经全部通过。

确定性测试覆盖开始时间门控、静默未达标续作、同 session/attempt、终态提交顺序、决策/权限/额度/cleanup 停止、验收接收与拒绝、取消竞态、重复提交/过期验收、重启恢复和失败通知重试。App pipe 用真实 Unix socket fixture 检查分片/错误/超时。实测新代码经 systemd 托管的定时 ZCode 完成与原聊天消息送达。运行仓库要求的 typecheck、test、build、validate:plugin 与 diff --check，生成物同步；跨平台、跨 App 版本、关机恢复未验证时明确标注。

## 当前验证边界（2026-10-28）

核对基线为 `0e74ee1c64b179752a24317574916a98c77a5ef1` + 调度 working tree。2026-10-28 使用同版源码构建的插件、真实 MCP、systemd 255 与 Bridge worker 完成 8 项离线闭环实测；执行器及 App 接收端均为 fixture，无模型调用：

1. 未来开始时间阻止提前派发，关闭 MCP 后仍由 systemd 托管 runner。
2. 自评 false 静默复用同 session 进入 attempt 2。
3. 杀掉 runner main 后 systemd 以新 PID 恢复，原 worker 与 attempt 2 保留。
4. true 结果提交后，含绑定目标的 framed 唤醒送达离线 App 接收端。
5. review 拒绝续作同 session 至 attempt 3，相同 verdict 重试幂等。
6. review 接受后目标结束，runner 退出。
7. 未来预约经真实 MCP 取消，没有启动执行。
8. 执行器 fixture 精确记录 1 次 create 与 2 次 resume。

上述 8 项为离线组合证据，与下列真实 provider / App 实测分开记录。

额度恢复后，本机 systemd 255、源码构建插件与真实 ZCode app-server（runtime 确认 account:bigmodel-individual-coding-plan / GLM-5.3，max，yolo）完成：

- 预约门控、MCP 入口退出后后台运行；第一次自评 false 不发送消息，第二次复用同 session 自评 true 后送达绑定的原 Codex 聊天。
- 独立检查真实 UTF-8 文件，受控退回补充条件后同 session 进入第三次执行；重复退回不多开 attempt，旧 attempt 验收被拒绝。独立验收通过后 runner 退出。
- 第二次执行期间 SIGKILL runner main，systemd 恢复新 runner PID，原 worker 保持运行且 attempt 没有增加。
- 未来预约取消不启动 worker；运行中取消后 worker、app-server 和工具子进程均已退出，无迟到输出。
- 60 秒真实超时后清理原工具进程，同 session 第二次执行成功，经独立检查后接受；通知只在自评 true 后发送。
- 全量回归 620 项：616 passed、4 平台跳过、0 failed；typecheck/build/validate:plugin、6 项 clean-entrypoints 与 diff --check 通过。

上述真实链路验证至当前 App 消息送达和 Codex 独立接受。新版调度在空闲聊天启动新轮次仍未验证：最后测试完成前用户已发送新请求，回调进入运行中的轮次；2026-10-27 的内部 pipe 空闲唤醒是独立历史证据。真实额度耗尽未人为复现；跨平台、跨 App 版本、注销/关机恢复、App 关闭及长期运行不在此次认证范围。详细证据见[实测报告](../reports/2026-10-28-scheduled-zcode-live-validation.md)。
