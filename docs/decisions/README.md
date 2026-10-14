# 决策记录 / Decisions

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-10-08

本目录保存已批准的架构决策和带日期的决策记录。决策回答"为什么这样定"，当前实现仍以 `ARCHITECTURE.md` / `INTERFACES.md` 为准。

## 现有记录

| 文档 | 状态 | 说明 |
|---|---|---|
| [roadmap-decisions-2026-09-27.md](roadmap-decisions-2026-09-27.md) | DECISION | 2026-09-27 的路线图与决策讨论。仍然成立的结论需要提炼进 `ARCHITECTURE.md` / `INTERFACES.md`；本文本身不是当前事实来源。 |
| [reliability-repair-plan-v2-2026-10-03.md](reliability-repair-plan-v2-2026-10-03.md) | DECISION | Bridge 可靠性修复计划。A/B 主要改动已实现；C/D 与宿主启动核验仍有未完成项。 |
| [ADR-005](ADR-005-long-session-reliability.md) | Accepted | 长会话 Windows 清理验证、原子锁释放、报告续作与 catalog provider 兼容；历史记录保持不变。 |
| [ADR-006](ADR-006-provider-quota-failure-diagnostics.md) | Accepted | 仅对白名单 provider 错误字段分类明确的用量额度耗尽；不公开原始 RPC 错误。 |

## 待补的 ADR

已补写：

| ADR | 状态 | 主题 |
|---|---|---|
| [ADR-001](ADR-001-appserver-as-production-execution-path.md) | Accepted | 生产执行路径使用 ZCode app-server |
| [ADR-002](ADR-002-manager-owns-task-lifecycle.md) | Accepted | Manager 独占任务生命周期，worker 通过 attempt claim 入场 |
| [ADR-003](ADR-003-execution-directory-prepared-by-host.md) | Accepted | 执行目录由调用宿主准备，Bridge 不创建也不删除 |
| [ADR-004](ADR-004-observation-is-not-control.md) | Proposed | 本地材料只作观察面，不作控制面 |

ADR-001 到 ADR-003 只搬运权威文档里已经写明的结论。ADR-004 是唯一需要 Master 决策的一条：仓库文档里没有明文记录"观察面不等于控制面"，此前只有设计讨论，因此它保持 Proposed，不当作已批准决策使用。

## 命名

新决策使用 `ADR-NNN-<slug>.md`，正文至少包含 Status、Date、Context、Decision、Rationale、Consequences。
