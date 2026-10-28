# ADR-011：补齐 Provider 额度耗尽诊断入口

> Status: DECISION
> Decision: Accepted（用户于 2026-10-28 要求修正额度错误漏报；无法直接接入 Codex 自动审批时不改审批）
> Date: 2026-10-28

## Context

ADR-006 的实现只检查 `turn.failed.error` 顶层 `code/type/message`。Observed 本机 `/opt/ZCode/resources/glm/zcode.cjs`（版本号未取得）还声明 `detail/underlyingErrorMessage/underlyingErrorDetail` 和 `attribution.providerErrorCode/providerId`，并投影底层 provider 原因。ZCode 当前公开源码的 `error-payload.ts` 也有这些字段。RPC 错误路径则直接丢弃错误文本，仅保留通用请求失败说明。

[Z.AI](https://docs.z.ai/api-reference/api-code) 与 [智谱](https://docs.bigmodel.cn/cn/api/api-code) 的业务码明确区分五小时/周月用量耗尽（1308、1310、1316–1321）、余额不足（1113）、请求速率限制（1302）和过载（1305）。原有文本匹配不能识别只有业务码或“已达到 5 小时使用上限”的错误。历史开发任务仅保存通用失败，不能倒推它当时的原始 provider 错误。

## Decision

1. 扩大 ADR-006 白名单，检查以上明确的诊断字段；仍不递归扫描任意对象、RPC data、headers、stack 或 metadata，不外发原始错误。
2. 对 `turn.failed` 和 RPC 错误回复共用同一额度分类；保留 `failed` 与 `zcode_usage_exhausted` 以及原有固定停止说明。
3. 支持明确的 quota/credits/spend-limit 符号码和官方中英文用量上限说明。数字业务码仅在错误归因或实际选中的 provider ID 属于 Z.AI/智谱命名空间时匹配，避免把其他 provider 的同号错误误报为额度耗尽。
4. 普通 429、1302、1305、认证失败、工具失败、未知错误不据此推断额度耗尽。不新增重试、不改写历史记录、不自动批准权限。
5. Codex CLI 0.165.0 的 `--approve-for-me` 是 Codex 内部审批路由；本机生成的公开/实验协议未提供外部请求通用审查入口。`review/start` 是代码审查，`thread/approveGuardianDeniedAction` 是已拒绝动作的覆盖入口，均不用于伪装外部 ZCode 审批。现有审批链路保持不变。

## Rationale

确定性分类读取真实协议字段即可补齐诊断，不需要新模型、依赖或审批代理。受限字段和 provider 范围保留原有隐私边界，普通限流不会触发“等待额度恢复”的错误指引。

## Consequences

新增离线协议回归与 worker 持久结果验证。真实额度复现不消耗用户已耗尽的 ZCode 配额，标记 NOT RUN。没有结构化或明确文本证据的失败仍为 `zcode_nonzero_exit`。
