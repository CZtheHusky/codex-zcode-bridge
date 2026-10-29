# Kimi 推理档位验证（2026-10-28）

实现：kimi.reasoning_level 可选字符串映射原生 prompts.thinking。省略不发送；续作使用持久任务中的配置；工具说明和技能已更新。未新增依赖，也未修改用户全局 Kimi 配置。

验证环境：Linux，本机 Kimi Code CLI 2.3.3，当前 working tree。

- typecheck、build、validate:plugin、git diff --check 通过。
- npm test：641 项，637 pass、0 fail、4 平台 skip；clean-entrypoints 6 pass。
- 新回归：MCP 参数传递、默认省略、low/high/max 各自续作保留、运行时返回档位与请求不一致时只报告运行时值。
- 原生 OpenAPI thinking 为非空字符串。模型目录：K3、K3.1 Pro、标准 kimi-for-coding 报告 low/high/max，旧 highspeed 未报告档位能力。
- 真实 Kimi CLI + 隔离本地 OpenAI provider：low/high/max 均进入实际 reasoning_effort，请求完成、同 session 续作、每次清理 verified。不消耗真实账号额度。
- 真实账号 K3.1 Pro 指定 max：返回预期 KIMI_MAX_OK 报告，cleanup verified。不能从返回文本推断推理档位；该次会话查询没有返回 thinking。
- 构建后的真实 MCP 客户端 tools/list 确认 Kimi reasoning_level schema 和说明。

限制与原始失败：原生 wire 测试首次对会话查询必须返回 thinking 的假设不成立（provider 已收到 low，但 session.agent_config 没有 thinking），该轮断言失败，未计为通过。随后按实际协议将缺失记录为未报告，再跑三档全部通过。Bridge 不伪造确认值；有原生字段时报告，没有时保持缺失。真实账号仅试 max，low/high 的原生参数传递由本地 provider 检查证明；不同真实模型未逐一试用。Kimi 预约唤醒整链路未新增实测，跨平台未验证。

本次未提交、push 或更新安装。历史 Kimi/改名报告中“未开放档位”的结论属于旧时点，由 ADR-014 取代。
