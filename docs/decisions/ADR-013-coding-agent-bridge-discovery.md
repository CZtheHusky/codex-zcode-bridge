# ADR-013：Coding Agent Bridge 命名与能力发现

> Status: DECISION
> Date: 2026-10-28
> 授权：用户选定 Coding Agent Bridge / coding_agent_*，要求 Agent 一眼看懂工具用途。

## 决策

插件展示名改为 Coding Agent Bridge，MCP server key 改为 coding_agent_bridge，公开工具统一使用 coding_agent_*（原 zcode_* 直接更名；可选 ledger_* 改为 coding_agent_ledger_*）。不同时注册旧别名，避免重复工具与执行器歧义。旧工具调用者需要刷新 MCP 工具列表并更新工具名；历史 ADR、研究与验证报告保持原时点名称。

保留插件安装 ID、npm 包名、仓库/插件路径、skill 路径、环境变量、宿主 profile、持久化目录和兼容记录字段。它们是安装及运行数据身份，不随展示名迁移。已持久化预约的 runner 路径不变；旧 runner 的唤醒文案可能仍引用旧工具名，更新后应使用当前工具列表。

MCP 初始化 instructions、工具标题/描述和关键参数说明共同描述：本机 ZCode/Kimi 后台执行；模型选择；ZCode reasoning_level 从模型目录读取，不猜档位；Kimi 仅支持本地模型别名，尚未暴露推理档位；查询/续作/审批/取消；一次预约、同会话静默续作和原 Codex 聊天独立验收。ZCode 专用诊断和模型配置明确标注，不宣称用于 Kimi。预约要求 Linux user systemd 和 Codex App pipe，Kimi 预约唤醒整链路仍未实测。

普通任务不会主动唤醒原聊天；completed 不等于独立验收通过。自定义宿主 instructions 保持优先。任务执行和持久化格式不变，不增加 Kimi 推理控制等额外功能。

## 验证标准

通过 MCP 初始化和 tools/list 检查名称、说明及参数 schema，使用新名调用验证路由；预约唤醒文案使用新名；构建插件和入口测试验证安装包一致。执行 typecheck、全量测试、build、validate:plugin 和 diff 检查，不据此宣称真实调度唤醒已新增验证。
