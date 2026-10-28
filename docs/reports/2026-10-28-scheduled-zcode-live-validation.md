# 2026-10-28 预约 ZCode 真实链路验证

> Status: REPORT
> Tested against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + 本次 ADR-010 / ADR-011 改动。

本次使用源码构建插件、真实 MCP 客户端、本机 Linux systemd 255、Node 22.22.2、已安装 ZCode app-server 和当前 Codex App。runtime 确认 provider 为 account:bigmodel-individual-coding-plan、模型 GLM-5.3、推理 max、模式 yolo。测试在隔离小目录中运行，不修改真实业务项目或 provider 配置。阶段推进是受控集成场景，不是一般业务任务成功率评估。

| 检查 | 独立结果 | 证据 |
|---|---|---|
| 未来开始门控及后台持久运行 | PASS | 开始前无 task；开始后 systemd MainPID/cgroup/ExecStart 已记录，MCP 客户端已关闭 |
| false 静默自动续作 | PASS | attempt 1 false 后复用相同 session 进入 attempt 2，无通知记录 |
| true 通知及独立退回 | PASS | attempt 2 true 后原聊天实际收到事件；Codex 检查文件后要求补充条件 |
| 同 session 返工、接受及退出 | PASS | attempt 3 复用 session；Codex 独立检查 JSON、UTF-8 和补充标志后接受，runner 退出 |
| runner 崩溃恢复 | PASS | attempt 2 期间 SIGKILL main，新 runner PID，原 worker 仍活且 attempt 不变 |
| 幂等及冲突 | PASS | 相同提交/退回/接受重放无重复执行，冲突提交和旧 attempt 验收明确拒绝 |
| 未来取消 | PASS | 取消及重放后仍 cancelled，没有创建执行记录 |
| 运行中取消 | PASS | worker、app-server、真实工具子进程均 absent；无迟到完成文件 |
| 60 秒超时续作 | PASS | 首次 timeout；工具 PID 已退出；相同 session 的 attempt 2 写入续作标记并获独立接受 |
| 新版调度唤醒空闲聊天的新轮次 | 未验证 | 预约后本轮已结束，但用户在回调前发来新请求，通知进入运行中的轮次 |
| 真实额度耗尽 | NOT RUN | 不人为耗尽恢复的额度；使用协议/worker 回归验证错误映射 |

全量回归共 620 项，616 passed、4 skipped、0 failed；跳过为 Windows 专用启动/进程树用例及 Linux 上的非 Linux 调度分支。typecheck、build、validate:plugin、6 项 clean-entrypoints 和 git diff --check 通过。额度回归覆盖 RPC 拒绝、底层诊断字段、provider 限定业务码、普通 429/过载不误报、持久状态/结果/事件及停止续作策略。审批流程未更改。

本次原始事件、结果、监督命令、进程探针、独立验收文件和日志保存在调用者聊天私有工作区；不把机器路径、聊天 UUID、provider 配置或凭据提交到仓库。2026-10-27 的空闲 pipe 唤醒是独立历史证据。以上结果不保证跨 App 版本、macOS/Windows 调度、注销/关机恢复、App 关闭或长期运行。
