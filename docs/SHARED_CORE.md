# 共享核心与宿主适配

> Status: AUTHORITATIVE
> Last updated: 2026-10-28
> Last verified: 2026-10-28，静态核对本次 createBridgeServer 的可选调度注入与默认 Codex stdio 装配；另核对本机 systemd 255 / MCP / Bridge worker 的 8 项离线闭环实测证据（执行器和 App 接收端为 fixture、无模型调用），详见 [ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md#当前验证边界2026-10-28)。另已完成本机真实 ZCode 自评/续作、当前 App 消息送达与 Codex 独立验收；新版调度在对话空闲时启动新轮次仍未验证，详见 ADR-010。
> Verified against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + 当前 working tree（ADR-010 调度相关源码与同版 bundle 离线实测；仅上述范围）
> Prior verification: 2026-10-16，仅核对本次新增的浏览器后端打包分层说明；其余条目仍未逐条核对
> Prior verified against: 183611e9c9bfc619b543933c7ad7204b2f646ea2（加载与构建源码，本次未改动）

Codex 与 dsh 连接同一个 ZCode 执行端，因此任务调度、存储、续跑、取消、结果归一化、ZCode 协议和 Desktop 索引属于共享核心。`src/adapters/` 适配 ZCode，不是调用宿主。

公共入口是 `codex-zcode-bridge/core`（源码 `src/core.ts`）。入口没有启动副作用，提供类型声明，并导出 `buildTaskFeedbackSnapshotV01` 与 `renderTaskFeedback`。`npm run build:core` 构建核心；当前仓库仍为 private，未发布独立 npm 包。可在本地构建后用 `npm pack` 生成版本化制品供 fork 锁定；发布渠道和独立核心版本策略尚未确定。

宿主入口显式提供 `BridgeHostProfile`：

```ts
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "codex-zcode-bridge/core";

const settingsDirectory = path.join(homedir(), ".dsh", "zcode-bridge");
await startBridge({
  name: "dsh-zcode-bridge",
  settingsDirectory,
  defaultDataRoot: settingsDirectory,
  workerEntryPath: fileURLToPath(new URL("./worker-main.mjs", import.meta.url)),
  instructions: "Host-specific delegation instructions go here.",
}, "YOUR_HOST_VERSION");
```

宿主独立维护 manifest、hook、安装配置、打包和发布版本。worker 可以把共享 `src/worker/worker-main.ts` 打进自己的制品，也可以调用公共 `runWorkerTask`；启动参数为 `dataRoot taskId attempt`，默认 spawner 同时传递校验后的宿主 profile。自定义 worker 入口必须接收并传给 `runWorkerTask`，不能重新猜测宿主。路径必须是绝对路径；设置、模型缓存和默认模型写入都使用该 profile，worker 使用同一配置。

Codex 默认配置目录保持 `~/.codex/codex-zcode-bridge`。运行配置仍优先于环境变量。`legacySettingsDirectories` 仅在宿主明确配置时启用；缺文件才回退，存在但损坏的文件会报错。首次写入默认模型会复制完整 legacy 设置到宿主 canonical 文件，并保留未知字段；不会修改 legacy 文件。不要默认共享两个宿主的可变任务目录。

公共 MCP 工具名称、schema 和业务语义由核心维护，宿主可传服务身份与 instructions。描述与 task prompt 使用调用宿主的中性措辞。`coding_agent_feedback` 是向后兼容的只读 snapshot 与文本 renderer；原有 `coding_agent_events`、`coding_agent_status` 和 `coding_agent_result` 保持原契约。`coding_agent_progress_probe` 是实验工具，默认关闭；只有直接调用 `createBridgeServer({ enableExperiments: true, ... })` 才启用。

预约调度（[ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md)）是可选组合层：`createBridgeServer` 只有收到 `schedule: { controller, appPipeSource? }` 才注册四个 `coding_agent_schedule*` 工具，不传时保持原 13 工具。默认 Codex `startBridge` 在 Codex profile 下装配 Linux systemd 监督器与 controller；不同名称的自定义宿主不会自动获得 Codex 私有 pipe。缺 systemd/App pipe 只影响预约调用，不阻断普通任务入口。

调度策略与 `ScheduleNotifier.send` 注入点分开；App pipe 的实际发送仅在 Codex runner 适配器中实现。宿主显式提供当前原聊天 UUID 与发送通道，不能从别的进程猜线程，也不能把 pipe 传入 worker 或任务 prompt。调度模块目前未从 `core` 公共入口新增导出，不把内部模块路径宣称为稳定 fork 接入 API；需要自定义调度宿主时仍须明确维护自己的装配、监督器和发送适配。

fork 接入顺序：构建并锁定本项目制品 → 用宿主入口替换公共模块中的路径/身份修改 → 将共享 worker 打入宿主制品 → 验证 stdio、任务执行、续跑、审批、模型缓存和自包含安装 → 独立发布。共享修复先进入本项目，fork 通过升级核心制品接收，避免长期各自修改任务核心。本轮只改造本项目，未修改 dsh，也未创建发布。

浏览器后端（ADR-007）的打包分层：标准插件随 `worker/vendor/` 携带自包含的 managed CDP CommonJS bundle（固定 playwright-core 1.64.0 及 browsers.json/package.json registry 数据），安装环境不需要另行安装该依赖。`build:core` 产物不含 vendor；core/fork 使用编译模块、缺少 vendor 时，loader（`src/browser/load-backend.ts`）回退到相邻的编译后 managed CDP runtime，再按 Node 模块解析规则加载 `package.json` 已声明的 playwright-core。宿主需确保这些模块及依赖可用；若重新打包 worker，需自行保留正确的 vendor 布局或提供等价的模块与资源布局，并遵守核心声明的依赖版本约束。打包责任在宿主，不能将标准插件的自包含性直接套用于自定义宿主。

回归覆盖两个宿主设置隔离、显式 migration、MCP 身份/instructions、worker profile 往返以及 bundled core 无启动副作用。真实 dsh 安装/权限往返和两个宿主共同运行的 Desktop UI 尚未验证。

## Kimi 执行器增量（ADR-012）

`TaskPackage.executor` 可选 zcode/kimi，省略仍走原路径。Kimi 使用 `kimi: { model?, reasoning_level?, permission_mode? }`，默认 yolo，不接受 ZCode model 字段；续作保持已持久化的 executor 与 session。公开工具名保持兼容，包含预约工具；ZCode doctor/catalog/default_model 不用于诊断或配置 Kimi。兼容字段 zcode_session_id、zcode_pid、zcode_output 在 Kimi 任务中存放 Kimi 对应证据，执行 profile.executor 和 usage.source 区分来源。

KimiAdapter 通过认证的 loopback Server API 执行；先 GET snapshot 恢复冷会话并取得游标，再订阅确认并提交独立 prompt_id。只接受当前 session/main agent/prompt/turn，失败、断流、文本偏移不符及无效报告均不得完成；thinking 不外发。审批/问题走既有 interaction 存储；成功和失败均验证进程树清理。Kimi 明确额度耗尽使用 kimi_usage_exhausted，普通 429 为 kimi_nonzero_exit；调度额度故障只升级通知，不自动续作。

配置、版本与验证范围见 [ADR-012](decisions/ADR-012-kimi-executor.md) 和[验证报告](reports/2026-10-28-kimi-validation.md)。本节不扩展原有 ZCode 的历史验证结论。
