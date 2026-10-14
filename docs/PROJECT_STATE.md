# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-10-14
> Last verified: 2026-10-14，本地代码与额度分类定向测试；完整测试存在一项 Windows 锁并发失败，单独复跑通过；真实 provider 错误字段兼容仍 NOT RUN。

当前状态快照，回答"现在什么能用、什么不能用"。路线图和优先级不在这里。

控制面、权威 Bridge 状态与补充观察的边界见 [decisions/ADR-004](decisions/ADR-004-separate-control-state-and-observation.md)：本地材料可以观察，但不能单独驱动任务状态、状态迁移与恢复结论。

## 版本与发布

- 当前发布：`1.2.3`（`package.json`、`plugins/codex-zcode-bridge/plugin.json`）。
- 发布方式：release-please 监听 `master`，合并后自动开版本 PR；合并版本 PR 才产生 tag 与 GitHub Release。
- CI：`.github/workflows/ci.yml`，ubuntu 与 windows 两个作业，跑 typecheck、build、test、validate:plugin，并校验生成的 bundle 已随源码提交。

## 本地未发布改动

- `master` 当前含本地提交 `6756225`：明确识别 provider 报告的用量额度耗尽，并要求 Codex 立即停止当前任务、通知用户；未推送，尚未由 release-please 生成版本 PR。额度分类定向测试、typecheck、build 与插件校验通过；完整测试首次有一项 Windows 锁并发用例报 `EPERM`，该用例单独复跑通过。真实 provider 错误字段兼容仍 NOT RUN。

## 稳定

- TaskManager 生命周期：`queued` / `running` / `completed` / `failed` / `cancelled` / `waiting_for_master`，含 attempt 独占、续跑归档、清理验证。
- MCP 默认工具 13 个，清单见 `INTERFACES.md`。
- `zcode_events` 的增量事件、cursor 与 raw/summary 视图。
- `zcode_feedback` 的 `TaskFeedbackSnapshotV01`。
- 工作区隔离：执行目录由调用宿主准备，Bridge 不创建也不删除 worktree。
- 模型选择：可按任务覆盖 provider/model，不持久化为工作区默认。
- 并发：同一 data root 内默认最多 8 个 worker，可用 `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 在 1–8 之间调整。

## 实验

- `zcode_progress_probe`：默认关闭，只有直接调用 `createBridgeServer({ enableExperiments: true })` 才注册。
- Desktop 索引同步：best effort，事务内校验 schema 与 Bridge owner；尚未写入真实 Desktop 数据库。

## 不支持

- Start Plan 的 headless 认证：app-server 需要桌面渲染器提供的验证码会话，Bridge 不伪造、不绕过。当前 headless 开发路径使用 Coding Plan。见 `research/start-plan-headless-2026-09-27.md`。

## 调查中 / NOT RUN

以下边界没有实跑验证，不能当成已知可用：

- `session/read` 原生当前状态查询：未接入。
- 真实 ZCode app-server RPC 探针与跨版本兼容：只在记录过的 0.16.9 路径上观测过。
- 真实 ZCode 权限审批往返：现有回归使用假运行时，未经真实交互验证。
- 跨 Host 并发 attach/control：研究阶段结论为 NO-GO，除非上游提供 ownership/control 协议。
- 真实 GUI 关闭时序、UI 响应与取消时延。
- 真实 Desktop 数据库写入与刷新行为。
- PID 重用，以及自行脱离进程组的后代进程。
- Windows 树采样后新增的后代，以及采样与发信号之间的身份变化；已运行的真实 Windows 树清理回归不能覆盖这些窗口。
- 旧不可读取 owner 与崩溃遗留 reclaim guard 的安全恢复；没有按年龄清除旧锁。
- 长会话真实 provider/报告一次合格率。调度已减少同次重复扫描，仍有随历史库增长的全量校验成本。

## 核对来源

`package.json`、`src/host/stdio.ts`、`src/mcp/server.ts`、`src/worker/run-task.ts`、`src/adapters/zcode-app-server-adapter.ts`、`docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、GitHub Actions 运行记录。文中标注"未运行"的条目没有被上述来源证实，保持未验证状态。
