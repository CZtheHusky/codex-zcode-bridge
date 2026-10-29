# Kimi 执行器开发与验证

> Status: RESEARCH
> Date: 2026-10-28
> Verified against: eb85edc861a4c8698bf6bfab2eca225939b2606e + 本次 working tree
> Environment: Linux，本机 Node 22.22.2，Kimi Code CLI 2.3.3

## 交付行为

在现有仓库加入 KimiAdapter，没有新建仓库或新增依赖。`zcode_task` / `zcode_schedule.task` 传 `executor: "kimi"`；省略保持 ZCode。Kimi 模型别名与权限使用 `kimi: { model?, permission_mode? }`，默认 yolo。现有 status/events/feedback/result/continue/interaction_reply/cancel 工具继续使用，续作复用同 Kimi session。MCP schema 拒绝混用 ZCode model 和 Kimi 配置；共享核心调用者遵循同一合同。

采用 Kimi 原生 Server API。每个 attempt 启动独立、保留认证的 loopback 服务，不记录含 token 的启动 banner；权限和问题进入现有完整请求持久化与授权流程。仅当前 session/main agent/prompt/turn 的 completed 及有效 JSON 报告能够完成。失败、断流、输出偏移不符、报告无效均明确失败；thinking 不进入公共证据。usage 标为 `kimi_runtime_session`，是运行时报告的会话累计值，不能当成本轮用量；本机曾返回零值，不推算真实消耗。

`kimi_usage_exhausted` 表示额度耗尽，预约策略只升级通知、不自动续作；普通限流为 `kimi_nonzero_exit`。原始 provider 错误不外发。Kimi 的配置、登录和会话由 Kimi 自身管理，Bridge 只转发非密钥环境配置 `KIMI_BRIDGE_EXECUTABLE` / `KIMI_CODE_HOME`。

## 真实本机验证

| 场景 | 结果与独立检查 |
|---|---|
| 直接 adapter 文件任务 | Kimi 使用 Write/Read，独立读取 proof.txt 确认精确内容；cleanup verified |
| MCP → detached worker → Kimi | 文件任务 completed，独立读取产物；并非仅验证 adapter |
| 同会话续作 | 第二 attempt 追加指定内容，session ID 与首轮一致，独立读取精确文件内容 |
| manual 模式权限 | 原生 Write 审批经 interaction_requested → zcode_interaction_reply allow → 继续执行，产物正确 |
| 原生问答 | AskUserQuestion 请求传回宿主，以完整问题文本回答 Blue，最终 chosen.txt 精确为 Blue |
| 执行中取消 | marker.txt 证明真实前台 shell 已启动，取消后 cancelled、cleanup verified |
| 执行中 120 秒超时 | marker.txt 证明 shell 已启动；任务 failed/error_code=timeout，cleanup verified |
| 真实 CLI 的额度故障 | 隔离 KIMI_CODE_HOME，连接本地 OpenAI 兼容故障 provider；仅一次请求，原生错误穿透为 kimi_usage_exhausted，cleanup verified，无真实账号额度故障注入 |
| 最终插件包 | bundled MCP → bundled worker → Kimi 协议 fixture completed，executor=kimi；该项无模型调用 |
| 独立进程核对 | 对上述成功测试的工作目录检查 /proc，测试完成后无残留进程 |

两项故障在开发中暴露并修复：新 Web session 没有自动选模型，需要显式传入会话模型或配置默认模型；GET session 只读冷索引，续作须先 GET snapshot 恢复 runtime，再按 watermark/epoch 订阅。专项 fixture 模拟冷会话拒绝订阅，防止该问题回归。

首个 60 秒超时探针在模型生成期间到期，虽然正确返回 timeout，但不能证明执行中 shell 被中断，因此未将它记为上述 shell 超时通过；后续 120 秒实测才覆盖该场景。

## 自动回归与构建

- `npm run typecheck`：通过。
- `npm test`：637 项，633 通过、0 失败、4 项平台跳过。
- 新 Kimi 专项：15 项，覆盖冷会话恢复、prompt/turn/agent 归属、同 session 续作、失败报告、额度与普通限流区分、断流/输出缺口、REST envelope 错误、审批 allow/deny、问题映射、取消/启动竞争、worker 持久化、MCP 配置合同与提交幂等身份。
- MCP schema 与调度额度策略回归：通过；现有 ZCode 回归包含在全量测试中。
- `npm run build`、`npm run validate:plugin`：通过；三个受管理 bundle 已重建。
- `npm run test:clean-entrypoints`：6 项通过，无跳过。
- `git diff --check`：通过。

4 项跳过为原有 Windows startup hook、两项 Windows process-tree 语义和非 Linux 调度分支，不是 Kimi 专项跳过。真实账号额度耗尽没有主动制造；上表额度验证通过真实 Kimi CLI 连接本地故障 provider 完成，协议 fixture 另覆盖普通 429 不误分类。

## 未验证与限制

- 原生 Server API 是实验接口；本次兼容范围为 Kimi 2.3.3 / Linux，Windows、macOS 和其他版本未实测。
- 预约工具沿用现有 systemd runner、worker、验收和唤醒流程，已覆盖 schema、Kimi quota policy 与打包入口；Kimi 真实预约到原 Codex 对话自动唤醒的整条链路未实测。
- 审批测试覆盖普通工具 allow；原生问答实测单选。Bridge 的 answers 合同为每题一个字符串，未扩展原生复选 UI 的完整回答结构。
- Kimi doctor/模型目录工具未新增；现有 ZCode doctor/catalog/default_model 仍只服务 ZCode。
- 未提交、push、发布、更新本机插件缓存或远端安装。

协议来源：[Kimi Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)、本机服务生成的 OpenAPI/AsyncAPI，以及本机 2.3.3 CLI 源码。执行器选择的依据见 [ADR-012](../decisions/ADR-012-kimi-executor.md)。
