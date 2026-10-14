# ADR-004 — 分离运行时控制、权威状态与补充观察

Separate Runtime Control, Authoritative State, and Supplemental Observation

Status: Accepted
Date: 2026-10-07

## Context

ZCode 在本机留下多种材料：app-server 事件、CLI 的 metadata / output / model-io / rollout 文件、日志，以及 Desktop 的 `tasks-index.sqlite`。其中一部分在研究阶段被观测过，但它们都是未公开、随版本变化的内部结构。

这里要区分的是三件事，而不是"控制"与"观察"两件事：

- 谁控制 ZCode —— 受支持的运行时接口。
- 谁拥有 Bridge 生命周期的真相 —— Bridge 自己持久化的证据。
- 谁提供额外信息 —— ZCode 本地材料，以及 Desktop 索引这类集成副作用。

一个命名澄清：`src/observation/` 不是本条 ADR 说的"ZCode 本地观察面"。它从 Bridge 自己拥有的 TaskStore 证据推导有界观察，属于权威 Bridge 状态模型的一部分，源码注释也写明这里不发起 OS 查询。读到该模块不构成对本 ADR 的违反。

本条决策来自 bridge 之外的历史设计讨论；在此之前的仓库文档只散落描述过它，从未形成记录，因此现在正式记录。

## Decision

### 三类划分

| 类型 | 例子 | 能否写 | 能否决定 Bridge 状态 |
|---|---|---|---|
| Control | app-server 及其受支持的 RPC | 可以，走受支持语义 | 是，通过受支持语义 |
| Supplemental Observation | ZCode 本地 metadata / rollout / log | 不可以 | 不可以 |
| Integration Side Effect | `tasks-index.sqlite` | 可以，best effort | 不可以 |

```text
Control Plane
    │
ZCode 受支持的运行时接口（app-server / supported RPC）

Authoritative Bridge State
    │
Bridge TaskStore + TaskManager 拥有的证据

Supplemental Observation
    │
ZCode local metadata / rollout / logs
    │
可以观察、可以诊断、可以补充可见信息
但不能单独改变任务状态或恢复结论

Desktop Integration
    │
tasks-index.sqlite
    │
允许 best-effort 写入
但永远非权威
失败不得影响任务生命周期
```

### 补充观察的边界

本地材料可以进入补充观察面：帮助诊断、补足可见信息、解释"app-server 连接断开后 runtime 是否仍有活动"这类问题。

它们不能单独驱动 Bridge 生命周期、状态迁移或恢复结论。允许的形态是给 Codex 一条有来源、有时效的观察，例如"app-server 连接断开后，本地日志显示 session 仍在活动"；不允许的形态是据此把 TaskStore 里的 `running` 改写成 `completed`。

### 恢复继续依靠 Bridge 自己的证据

Bridge 生命周期恢复只使用自己拥有的持久化证据：TaskStore、heartbeat、attempt、`execution.claim`、outcome checkpoint、cleanup 验证。不用 ZCode 内部文件补洞。

### Desktop 索引是登记过的集成例外

`tasks-index.sqlite` 的写入保留，但它不属于补充观察面，因为它产生副作用。它是明确登记的 best-effort 集成例外，并且必须满足：

- 不得作为任务执行的门禁
- 不得改变 Bridge 任务状态
- 不得参与恢复判定
- 不得决定任务完成
- 不得决定清理是否成功
- 失败不得影响任务生命周期

### 未来若需要读写本地结构

必须单独走一次决策，说明兼容性、回滚方式与失败语义。

## Rationale

本地结构没有稳定性承诺。把补充观察升级成权威依据，会让 Bridge 在 ZCode 升级后静默给出错误状态；反过来，完全禁止读取又会丢掉真实有价值的可观测性。三分类把"可以看"和"可以据此下结论"拆开，同时给 Desktop 集成留出一个边界清楚、可审计的例外。

## Consequences

- 恢复与状态判定必须能用原生通道解释；本地材料只能提供线索，不能单独定论。
- 观察能力受安装版本影响，需要按版本标注并保留 NOT RUN 记录。
- 读取补充观察必须落在隐私边界内：不转发原始 reasoning 和工具参数。
- 未来新增 `ZCodeObserver` 一类读取组件时，默认落在补充观察类，不得进入状态判定路径。
- 如果将来确实需要写本地结构，必须单独走决策。

## Evidence

- 代码核对：`src/adapters/task-index-sync.ts` 的注册与状态更新是 best effort；`src/adapters/zcode-app-server-adapter.ts` 在 session ready 后调用并捕获失败，不阻塞任务；`src/runtime/account-provider.ts` 的 `zcodeTasksIndexPath()` 从 `provider_config.json` 推出 `<v2>/tasks-index.sqlite`；`src/observation/` 只读 TaskStore 证据。
- `docs/ARCHITECTURE.md`："Desktop 索引同步是 best effort，事务内检查 schema 与 Bridge owner、更新有限状态字段，保留用户标题与额外 metadata。回归使用临时 SQLite。真实 Desktop schema/刷新/并发行为受安装版本影响，本轮未写入真实数据库。"
- `docs/INTERFACES.md`："公开进度 usage 仅保留数值 token/cost 字段，隐藏推理、未知 metadata 和原始 RPC error 不转发。"
- `docs/ZCODE_RUNTIME.md`：运行配置与发现逻辑只读官方 provider 配置，不复制、不改写、不把凭据写入任务 metadata。
