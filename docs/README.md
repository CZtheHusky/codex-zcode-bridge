# 文档索引 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-10-14

英文使用者从 [README.md](../README.md) 开始。技术文档为中文。本文是文档路由：先看状态等级，再按读者路径选文档。

English readers start at [README.md](../README.md). This index is bilingual; the technical documents themselves are written in Chinese.

## 状态等级 / Status levels

每份文档顶部标注四种状态之一。这是本仓库最重要的一条约定：没有状态标注的文档不能被当成事实依据。

| 状态 | 含义 | 使用方式 |
|---|---|---|
| `AUTHORITATIVE` | 当前事实或合同 | 可以据此开发和判断 |
| `DECISION` | 已批准的架构决策 | 引用它回答"为什么不那样做" |
| `RESEARCH` | 研究结论 | 只作参考，不代表当前实现 |
| `ARCHIVED` | 历史材料 | 默认不读，只用于追溯 |

每份文档必须在顶部自带状态标注；本索引只做汇总，不能代替标注。跳过本索引直接打开权威文档时，也应能从文件顶部看到状态与核对情况。

## For Master Agents

按顺序读，不要通读全仓库文档：

1. `docs/PROJECT_STATE.md` —— 当前状态快照（稳定 / 实验 / 不支持 / 调查中）
2. `docs/ARCHITECTURE.md` —— 系统现在怎么工作
3. `docs/INTERFACES.md` —— 合同与兼容边界
4. `docs/decisions/README.md` —— 已批准决策索引
5. 只在需要证据时读 `docs/research/`

不要默认读 `docs/archive/`。

## For Coding Agents

1. 本任务涉及的合同文档（`INTERFACES.md` / `ZCODE_RUNTIME.md` / `SHARED_CORE.md`）
2. 对应组件的架构（`ARCHITECTURE.md`）
3. `AGENTS.md` 里的硬规则

实现不能自行改写合同。需要改合同先提 `DECISION`。

## 索引 / Index

### 权威文档 AUTHORITATIVE

| 文档 | 语言 | 最后更新 | 最后核对 |
|---|---|---|---|
| [README.md](../README.md) | en | 2026-10-05 | 未记录 |
| [README.zh-CN.md](../README.zh-CN.md) | zh | 2026-10-03 | 未记录 |
| [PROJECT_STATE.md](PROJECT_STATE.md) | zh | 2026-10-14 | 部分核对；详见文档顶部 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | zh | 2026-10-14 | 部分核对；详见文档顶部 |
| [INTERFACES.md](INTERFACES.md) | zh | 2026-10-14 | 部分核对；详见文档顶部 |
| [SHARED_CORE.md](SHARED_CORE.md) | zh | 2026-10-06 | 未记录 |
| [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) | zh | 2026-10-14 | 2026-10-08，本地配置/假运行时 |
| [plugins/codex-zcode-bridge/README.md](../plugins/codex-zcode-bridge/README.md) | zh | 2026-10-03 | 未记录 |
| [plugins/codex-zcode-bridge/SECURITY.md](../plugins/codex-zcode-bridge/SECURITY.md) | zh + en | 2026-10-03 | 未记录 |
| [plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md](../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) | zh | 2026-10-08 | 2026-10-08，本地源码/合同 |

`最后核对` 表示上一次有人把文档内容与代码对照的日期及范围；标记为未记录的条目仍缺少核对证据。新建和修改文档时必须填写，否则该文档只能算"最后更新"，不能算"已验证"。本地回归不代表真实 provider 或长期运行通过。

### 决策 DECISION

| 文档 | 日期 | 说明 |
|---|---|---|
| [decisions/README.md](decisions/README.md) | 2026-10-08 | 决策索引 |
| [ADR-001](decisions/ADR-001-appserver-as-production-execution-path.md) | 2026-10-07 | Accepted：生产执行路径使用 app-server |
| [ADR-002](decisions/ADR-002-manager-owns-task-lifecycle.md) | 2026-10-07 | Accepted：Manager 独占生命周期，worker 通过 attempt claim 入场 |
| [ADR-003](decisions/ADR-003-execution-directory-prepared-by-host.md) | 2026-10-07 | Accepted：执行目录由调用宿主准备 |
| [ADR-004](decisions/ADR-004-separate-control-state-and-observation.md) | 2026-10-07 | Accepted：分离运行时控制、权威状态与补充观察 |
| [ADR-005](decisions/ADR-005-long-session-reliability.md) | 2026-10-08 | Accepted：长会话清理、锁释放、报告修复与 provider 兼容 |
| [ADR-006](decisions/ADR-006-provider-quota-failure-diagnostics.md) | 2026-10-14 | Accepted：安全识别并明确提示 provider 用量额度耗尽 |
| [decisions/roadmap-decisions-2026-09-27.md](decisions/roadmap-decisions-2026-09-27.md) | 2026-09-27 | 路线图与决策讨论 |
| [decisions/reliability-repair-plan-v2-2026-10-03.md](decisions/reliability-repair-plan-v2-2026-10-03.md) | 2026-10-03 | 可靠性修复计划，含未完成项 |

### 研究 RESEARCH

| 文档 | 日期 | 说明 |
|---|---|---|
| [research/phase1-codex-zcode-2026-09-26.md](research/phase1-codex-zcode-2026-09-26.md) | 2026-09-26 | Phase 1 参考项目调研与 V0.1 架构建议 |
| [research/desktop-task-refresh-2026-09-28.md](research/desktop-task-refresh-2026-09-28.md) | 2026-09-28 | ZCode Desktop 任务列表刷新机制 |
| [research/start-plan-headless-2026-09-27.md](research/start-plan-headless-2026-09-27.md) | 2026-09-27 | Start Plan headless 认证阻塞与 Coding Plan 回归 |
| [research/native-cli-vs-appserver-2026-10-05/README.md](research/native-cli-vs-appserver-2026-10-05/README.md) | 2026-10-05 | Native CLI vs app-server 研究：结论、6 篇文档、实验脚本与证据索引 |
| [research/task-feedback-v0-1-2026-10-05/README.md](research/task-feedback-v0-1-2026-10-05/README.md) | 2026-10-05 | Task Feedback v0.1 的输入：app-server 事件能力探针与两份建议 |

带日期的研究目录可以自带 README 作为该主题的文档地图；逐篇条目写在那份 README 里，不重复列在本索引。

### 归档 ARCHIVED

| 文档 | 日期 | 说明 |
|---|---|---|
| [archive/appserver-capability-matrix-2026-09-27.md](archive/appserver-capability-matrix-2026-09-27.md) | 2026-09-27 | app-server 能力普查，已被 2026-10-05 的能力探针取代 |
| [archive/mvp-v0.3-2026-09-27.md](archive/mvp-v0.3-2026-09-27.md) | 2026-09-27 | MVP 0.3 版本说明 |
| [archive/mcp-sdk-v2-migration-2026-09-27.md](archive/mcp-sdk-v2-migration-2026-09-27.md) | 2026-09-27 | MCP SDK v2 迁移记录 |
| [archive/phase7-live-progress.md](archive/phase7-live-progress.md) | 2026-10-03 | Phase 7 兼容说明；有效内容已提炼进 `ARCHITECTURE.md` / `INTERFACES.md` |

### 报告 REPORT

| 文档 | 说明 |
|---|---|
| [reports/task-feedback-v0-1-implementation-2026-10-06.md](reports/task-feedback-v0-1-implementation-2026-10-06.md) | Task Feedback v0.1 的交付报告，一次性材料 |
| [reports/2026-10-08-long-session-reliability.md](reports/2026-10-08-long-session-reliability.md) | 长会话故障证据、本地修复、验证与未运行边界 |

### 自动生成 Generated

| 文档 | 说明 |
|---|---|
| [CHANGELOG.md](../CHANGELOG.md) | 由 release-please 维护，不要手改 |

## 新文档放哪里

| 内容 | 位置 |
|---|---|
| 当前事实、合同 | `docs/` 顶层，数量控制在 10 份以内 |
| 已批准决策 | `docs/decisions/ADR-NNN-<slug>.md` |
| 研究结论与证据 | `docs/research/<topic>-<YYYY-MM-DD>/` |
| 一次性交付报告 | `docs/reports/` |
| 已被取代的材料 | `docs/archive/<phase-or-topic>/` |
| 未定稿草稿 | `docs/_draft/`（已 gitignore，不进仓库） |

## 仓库外的材料

以下内容有意不放进仓库，追溯时按下表位置查找：

| 位置 | 内容 |
|---|---|
| `C:\Users\Sandy\.codex\archived_docs\codex-zcode-bridge\` | 全库审计报告、生命周期可观测性方案、ccteam 对比、整改报告、验收证据 JSON |
| `<repo>\.tasks\notes\` | 会话期笔记；属于桥接运行数据根，不是版本化文档 |

桥接运行数据根 `.tasks/` 只放任务记录，不要在那里存放研究用的外部仓库克隆。
