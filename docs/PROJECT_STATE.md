# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-10-15
> Last verified: 2026-10-15，最新上游整合分支的验证结果见[审查说明](reports/2026-10-15-browser-and-transport-fixes.md)；旧版本实测与当前分支回归分别记录。
> Verified against: 上游fae74e45033a50fb560c0014d1a6d60a7dc771d1 + 本分支修复；受测源码指纹见审查说明。

当前状态快照，回答"现在什么能用、什么不能用"。路线图和优先级不在这里。

控制面、权威 Bridge 状态与补充观察的边界见 [decisions/ADR-004](decisions/ADR-004-separate-control-state-and-observation.md)：本地材料可以观察，但不能单独驱动任务状态、状态迁移与恢复结论。

## 版本与发布

- 当前审查基线：`1.2.4`（`package.json`、`plugins/codex-zcode-bridge/plugin.json`）。
- 发布方式：release-please 监听 `master`，合并后自动开版本 PR；合并版本 PR 才产生 tag 与 GitHub Release。
- CI：`.github/workflows/ci.yml`，ubuntu 与 windows 两个作业，跑 typecheck、build、test、validate:plugin，并校验生成的 bundle 已随源码提交。

## 本分支改动

本分支基于上游1.2.4，保留其provider额度耗尽处理和控制面约束，加入可选浏览器宿主及协议帧/大审批输入修复。版本号未提升，不代表已发布；详情见[审查说明](reports/2026-10-15-browser-and-transport-fixes.md)。

## 稳定

- TaskManager 生命周期：`queued` / `running` / `completed` / `failed` / `cancelled` / `waiting_for_master`，含 attempt 独占、续跑归档、清理验证。
- MCP 默认工具 13 个，清单见 `INTERFACES.md`。
- `zcode_events` 的增量事件、cursor 与 raw/summary 视图。
- `zcode_feedback` 的 `TaskFeedbackSnapshotV01`。
- 工作区隔离：执行目录由调用宿主准备，Bridge 不创建也不删除 worktree。
- 模型选择：可按任务覆盖 provider/model，不持久化为工作区默认。
- 并发：同一 data root 内默认最多 8 个 worker，可用 `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 在 1–8 之间调整。
- 会话帧传输（ADR-008）：换行 JSON-RPC 帧逐条消费，单帧 16 MiB 原始未 trim 字节上限；致命帧错误锁存原因、终止 pending RPC/turn 并阻止后续 request。真实 resume 帧（观测 2,139,927 UTF-8 bytes，曾触发旧伪 30s 超时）与分片/合包/UTF-8 边界由回归覆盖。
- 大审批输入（ADR-008）：审批 params 完整私有保存至 1 MiB（`JSON.stringify(params)` 紧凑序列化计量），带 bytes/SHA256 元数据；批准在 interaction 锁内校验，等待中记录丢失/损坏/改动时明确 decline。真实链路已实测：build 模式单次 43,014-byte Write 走完整审批往返，审批 params 45,704 bytes，文件与批准内容字节/SHA256 一致，cleanup verified（1.2.3修复版本的本机实测，当前分支回归范围另列）。超过 64,000-byte 事件行的大请求按显式预览 + `full_request` 完整引用发布；该 >64KB 预览与 1 MiB 边界由合成回归验证，与真实 43,014-byte Write 属不同验证强度，不混称。

## 实验

- `zcode_progress_probe`：默认关闭，只有直接调用 `createBridgeServer({ enableExperiments: true })` 才注册。
- Desktop 索引同步：best effort，事务内校验 schema 与 Bridge owner；尚未写入真实 Desktop 数据库。
- 可选 headless 浏览器宿主（ADR-007）：默认关闭；显式启用后通过独立managed CDP后端处理browserList/browserExecute。1.2.3修复版本曾在Windows Edge和ZCode Agent 0.16.9验证原生工具链；本1.2.4整合分支的验证单列于[审查说明](reports/2026-10-15-browser-and-transport-fixes.md)。桌面IAB、Computer Use、录制及子会话派生未实现。

## 不支持

- Start Plan 的 headless 认证：app-server 需要桌面渲染器提供的验证码会话，Bridge 不伪造、不绕过。当前 headless 开发路径使用 Coding Plan。见 `research/start-plan-headless-2026-09-27.md`。

## 调查中 / NOT RUN

以下边界没有实跑验证，不能当成已知可用：

- 浏览器原生链路仅在独立验收记录所列版本验证，其他模型、版本、平台未扩展验证。
- 浏览器宿主的跨安装版本兼容：协议 schema 依观测 commit `aac4755666d09fdcd70272fcf063c077a639015f` 适配；咨询字段做了容错，身份字段缺失或不可解析仍拒绝，但未在其它 app-server 版本上实测。
- Linux/macOS 上的浏览器可执行文件发现：路径表来自官方实现，本机只验证了 Windows Edge。

- `session/read` 原生当前状态查询：未接入。
- 真实 ZCode app-server RPC 探针与跨版本兼容：只在记录过的 0.16.9 路径上观测过。
- 真实 ZCode 权限审批的其他分支：本次 Windows build 模式 allow_once 往返已实测，其他审批组合未据此认证。
- 跨 Host 并发 attach/control：研究阶段结论为 NO-GO，除非上游提供 ownership/control 协议。
- 真实 GUI 关闭时序、UI 响应与取消时延。
- 真实 Desktop 数据库写入与刷新行为。
- PID 重用，以及自行脱离进程组的后代进程。
- Windows 树采样后新增的后代，以及采样与发信号之间的身份变化；已运行的真实 Windows 树清理回归不能覆盖这些窗口。
- 旧不可读取 owner 与崩溃遗留 reclaim guard 的安全恢复；没有按年龄清除旧锁。
- 长会话真实 provider/报告一次合格率。调度已减少同次重复扫描，仍有随历史库增长的全量校验成本。

## 核对来源

`package.json`、`src/host/stdio.ts`、`src/mcp/server.ts`、`src/worker/run-task.ts`、`src/adapters/zcode-app-server-adapter.ts`、`docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、GitHub Actions 运行记录。文中标注"未运行"的条目没有被上述来源证实，保持未验证状态。
