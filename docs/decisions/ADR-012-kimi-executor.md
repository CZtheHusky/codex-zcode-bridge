# ADR-012：现有 Bridge 接入 Kimi 执行器

> Status: DECISION
> Date: 2026-10-28
> 授权：用户要求直接在现有仓库开发，允许本机 Kimi 实测。

## 决策与范围

TaskPackage 增加可选 `executor: "zcode" | "kimi"`（省略仍为 ZCode）和仅 Kimi 使用的 `kimi: { model?, permission_mode? }`。model 是 Kimi 已配置别名；permission_mode 为 manual/yolo/auto，默认 yolo。原 ZCode model 字段不用于 Kimi；MCP schema 拒绝混用，共享核心调用者遵循同一合同，不在 Manager 重复类型检查。继续使用现有 zcode_* 工具、持久化、队列、审批、取消及预约执行；续作不能更换执行器，复用原 session。兼容字段 zcode_session_id/zcode_pid/zcode_output 对 Kimi 保存其 session/PID/可见输出，不改已有记录格式。ZCode doctor/catalog/default_model 仍只面向 ZCode。

每个 Kimi attempt 拥有一个仅绑定 loopback、保留认证的 `kimi web --no-open` 子进程。读取启动 URL 只在内存中提取端口和 token，不向事件或日志写入启动 banner。REST 检查 envelope.code；WebSocket 先确认订阅，再发带唯一 prompt_id 的 prompt，只接受对应 session、main agent、prompt/turn 的结果。仅 turn.ended reason=completed 且报告有效才完成；额度故障、未知终态、断流均失败，不靠日志猜状态。权限和问题经既有 interaction 持久化与回复合同传递，不因 yolo 自动放行。

选择 Server API 而非 ACP：本机 Kimi 2.3.3 的 ACP 将非认证 failed turn 映射为 end_turn，会丢失限额故障，无法满足当前需求。Server API 为实验接口；本次以已安装 2.3.3 的 live OpenAPI/AsyncAPI 和真实模型测试验证，后续版本须回归。

仅白名单错误字段用于额度分类；普通 429/rate limit 不等于额度耗尽。对外使用 kimi_usage_exhausted/kimi_nonzero_exit，不转发原始 provider 错误。沿用现有进程树清理与未验证清理阻断续作规则，不新增依赖。KIMI_BRIDGE_EXECUTABLE 与 KIMI_CODE_HOME 是显式非密钥运行配置，传入 worker；登录和 provider 配置交给 Kimi 管理。

## 验证

实现与实测结果见[验证报告](../reports/2026-10-28-kimi-validation.md)。本机真实执行、续作、审批、问答、取消和超时已验证；真实 CLI 连接本地故障 provider 已验证额度分类，不消耗真实账号额度制造耗尽。Kimi 真实预约唤醒未实测。
