# 共享核心与宿主适配

> Status: AUTHORITATIVE
> Last updated: 2026-10-06
> Last verified: 未逐条核对

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

公共 MCP 工具名称、schema 和业务语义由核心维护，宿主可传服务身份与 instructions。描述与 task prompt 使用调用宿主的中性措辞。`zcode_feedback` 是向后兼容的只读 snapshot 与文本 renderer；原有 `zcode_events`、`zcode_status` 和 `zcode_result` 保持原契约。`zcode_progress_probe` 是实验工具，默认关闭；只有直接调用 `createBridgeServer({ enableExperiments: true, ... })` 才启用。

fork 接入顺序：构建并锁定本项目制品 → 用宿主入口替换公共模块中的路径/身份修改 → 将共享 worker 打入宿主制品 → 验证 stdio、任务执行、续跑、审批、模型缓存和自包含安装 → 独立发布。共享修复先进入本项目，fork 通过升级核心制品接收，避免长期各自修改任务核心。本轮只改造本项目，未修改 dsh，也未创建发布。

回归覆盖两个宿主设置隔离、显式 migration、MCP 身份/instructions、worker profile 往返以及 bundled core 无启动副作用。真实 dsh 安装/权限往返和两个宿主共同运行的 Desktop UI 尚未验证。
