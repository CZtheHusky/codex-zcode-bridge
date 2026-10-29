# ADR-014：开放 Kimi 推理档位

> Status: DECISION
> Date: 2026-10-28
> 授权：用户要求打开 Kimi 档位选择；已读取本机 Kimi 2.3.3 原生接口与模型目录。

新增可选 TaskPackage.kimi.reasoning_level，使用与 ZCode 相同的字段命名，值为非空字符串。KimiAdapter 将其直接映射到原生 POST sessions/{id}/prompts 的 thinking 字段；省略时不发送该字段，保留原生默认/会话配置。模型支持与值解释交给 Kimi 原生接口，不新增硬编码档位转换或模型判断。

本机原生 API 的 thinking 为非空字符串；K3/K3.1 Pro/标准 kimi-for-coding 目录报告 support_efforts=[low,high,max]，旧 highspeed 未报告可调档位。工具和技能明确模型相关限制，不保证所有模型支持所有档位。推理控制是设置，不向事件输出隐藏思考文本。最终档位仍从原生 session.agent_config.thinking 读取，不将请求值伪装为确认值。

首轮、显式续作和预约自动续作使用已保存任务中的同一配置；不增加续作时切换档位接口，不修改用户全局 Kimi 配置。MCP schema、类型、适配器、fixture、调用测试、说明和 bundle 同步更新。ADR-013 中“Kimi 未暴露档位”的限制由本 ADR 取代；历史报告保留当时状态。

验证：MCP 输入和透传、原生请求包含/省略、运行时确认、同 session 续作保留；本机真实 Kimi 对本地 provider 的 wire 检查；适用回归、构建及插件验证。真实账户支持范围不由 fixture 结果推断。
