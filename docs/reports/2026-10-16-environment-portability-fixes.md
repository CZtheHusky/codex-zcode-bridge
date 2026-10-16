# 跨环境审查 F1–F3 环境可移植性修复报告

> Status: RESEARCH
> Date: 2026-10-16
> Base: `0e1e319561edf94e0f0cd481ac455ec784eb19dd`（上游 1.2.5，PR #43 合并后的 master）
> 执行：Bridge worker（实现与本机 Windows 自测）；末尾独立验收部分由 Codex 据实补录，前面的 worker 记录保留原验证范围。

## 来源与范围

本次 Codex 独立审查（2026-10-16，审查记录与原始证据由 Codex 保存，只读引用）复现了三个缺陷：F1 env-only 浏览器设置未传给真实 detached worker；F2 Windows 系统浏览器自动发现所需的 `ProgramFiles` / `ProgramFiles(x86)` 被过滤；F3 仓库位于短目录（如容器 `/app`）时 `validate:plugin` 把仓库路径当无边界子串，在 JSON Schema URL 片段（`/vocab/applicator` 等）上误报"开发目录泄漏"。本分支在 1.2.5 基线上修复三项根因，版本号不变；不修改 MCP/schema/账号或权限合同、不放宽秘密边界、不改变依赖锁与 CI/Node 版本。

首轮实现后，Codex 对 F3 的独立探针又发现两类漏检：JS 字符串转义形式（双反斜杠）的 Windows 绝对路径、以及注释中前导空格之后的绝对路径未被拒绝；返修期间进一步收束为按路径结构判定边界（见下）。本报告描述最终实现；首轮与返修的红/绿日志均按任务记录另行保存，未改写。

## 修改

- `src/runtime/child-env.ts`：`createWorkerEnv` 显式键清单加入 `ZCODE_BRIDGE_BROWSER_USE` 与 `ZCODE_BRIDGE_BROWSER_EXECUTABLE`（非秘密字符串，worker 内 adapter 从自身环境读取）；Windows `createMinimalOsEnv` 白名单加入 `PROGRAMFILES`、`PROGRAMFILES(X86)`（按 `toUpperCase` 比较，保留原始键大小写）。其余任意环境与秘密仍不透传。（F1/F2，首轮实现，返修未动。）
- `src/browser/executable.ts`：Windows 浏览器发现改用大小写不敏感的环境键读取（`windowsEnvValue`），接受 `ProgramFiles` / `programfiles` 等常见形式；空值跳过、显式 `executablePath` 优先与候选顺序不变。（F2，首轮实现，返修未动。）
- `scripts/validate-plugin.mjs` + 新增 `scripts/lib/repo-root-pattern.mjs`：泄漏检查的根路径正则抽出为可回归测试的 helper。最终语义按路径结构而非名称字符黑名单判定：
  - 右界：根之后只允许路径分隔符、字符串/行终止符或文本结束；空格、`%20`、`@`、`+`、`(`、字母、`.` 等一律视为更长路径段的延续（`/app Backup`、`/app@2`、`/app.git`、`file:///app%20Backup` 均不是本仓库根）。
  - 左界：根必须出现在绝对路径可以开始的位置（文本起始、空白、引号或 `=`/`:`/`(`/`,`/`;`/`/`/`\` 等记号分隔符之后）；名称字符或 URL authority 尾部（`example.test/app`、`[::1]/app`）说明是更长名称或普通 HTTP URL 的一部分。原始路径分支上，同一记号内更早出现的 `http(s)://` 抑制匹配（覆盖 `https://…/docs/app/…` 等深层 URL 段）。
  - 每个原始分隔符位置匹配一到两个 `/` 或 `\`：bundle 中 Windows 绝对路径既有原生单分隔符形式，也有 JS 字符串转义的双反斜杠形式，二者是同一路径。
  - 完整标准 file URI（Node 内置 `pathToFileURL`，含 scheme）作为独立备选，不受上述 HTTP 抑制——嵌在 HTTP URL 里的 `file:` 引用（如 redirect target）仍是本地开发路径泄漏；POSIX 风格根同时纳入 `pathToFileURL(root, { windows: false })` 的跨平台拼写，避免验证平台差异。该备选沿用相同左右界（编码同级后缀 `%20Backup` 不误报）。
  - 旧实现的可比行为：其分隔符字符类按"替换后成对"生效，因此能命中 JS 转义等双分隔符形式，但漏掉原生单分隔符绝对路径（Windows 常见形态）；POSIX 短根上则退化为无边界子串导致误报。新实现两类形式均覆盖。
  - 路径泄漏检查本身保留，未取消、未硬编码跳过 `/app`；runtime 依赖与资源检查（vendored package/browsers.json、playwright-core 静态导入禁令）原样保留。
- 提交物 `plugins/codex-zcode-bridge/dist/bridge.mjs`、`worker/worker-main.mjs`、`worker/vendor/pkg/browser-host.cjs` 由 `npm run build` 重建，与源码同步，无手改（返修轮未触及生产源码，产物与首轮一致）。

## 回归（红/绿均有旧代码失败证据）

测试分四组：`test/worker-env-portability.test.ts`（真实 `createWorkerSpawner` 跨进程探针：两项浏览器设置到达、任意秘密不透传、未设置时键缺席且无 `ZCODE_BRIDGE_*` 整体转发）、`test/browser-executable.test.ts`（fixture 目录 + 假 playwright，无真实浏览器）、`test/child-env.test.ts`（函数级转发与 Windows 白名单）、`test/validate-plugin-root-pattern.test.ts`（helper 语义 + 真实 CLI 注入）。

- 首轮红相：旧生产代码上 16 项中 9 项失败（含 F1 跨进程 `null !== 'headless'`、F2 大小写/白名单、F3 `/app` 误报与 Windows 单分隔符漏检）。
- 返修红相：在首轮实现上，evaluator 输入的三个 helper 用例（注释前导空格、JS 转义双反斜杠、Windows 注释）与真实 CLI 注入（转义字符串、注释、斜杠、标准 file URI）均未被拒绝；返修后全部通过。另有审查补充的 `/app@2`、`/app+backup`、`/app(copy)`、`[::1]/app`、`file:///app%20Backup`、`pathToFileURL` 本机盘符同级后缀、深层 URL 段、HTTP 内嵌 `file:` URI 等负例/正例。
- 真实 CLI 回归在临时 fixture 仓库（根名含空格、Unicode 与正则字符）中复制现行 validator + helper 运行：baseline（含 schema URL、同段 URL、同级目录与编码同级目录负例）必须 exit 0；追加泄漏行（转义字符串、注释、斜杠、未编码与标准 file URI、HTTP 内嵌 file URI）必须被"embeds the development repository's absolute path"诊断拒绝。

## Worker 本机验证（Windows，2026-10-16）

| 检查 | 版本与结果 |
|---|---|
| 首轮红/绿（旧生产代码） | Node 22.18.0：红 16 项中 9 失败；绿 16/16 通过 |
| 首轮完整验证 | Node 22.18.0：typecheck、完整隔离测试 358 项（357 通过/0 失败/1 既有 Windows POSIX 权限跳过）、build、validate:plugin、`git diff --check` 全部 exit 0 |
| 返修红/绿（首轮实现） | Node 22.18.0：红相 3 项失败（注释/转义/CLI 注入）；绿相 22/22 通过 |
| 返修 typecheck / build / validate:plugin / diff-check | Node 22.18.0，均 exit 0；产物与首轮一致 |
| 返修后未重跑全仓测试 | 按分工由 Codex 在最终验收独立执行；首轮全套记录保留 |
| 本次相关回归 | Node 24.19.0：22/22 通过，exit 0 |

命令清单、真实退出码与完整 stdout/stderr 按任务约定保存于统一日志目录（本地交付物，不进仓库）；evaluator 探针只读复现，未在 evaluator 目录写入。

## Worker 交付时未运行项（现由下述独立验收补齐）

- 本机为 Windows，无法在允许路径内把仓库放到真实 `/app` 根复现容器场景；F3 的端到端 `/app` 验收由 Codex Linux 沙盒执行（语义已由 helper 与真实 CLI 回归覆盖）。
- 真实浏览器自动发现（系统安装 Edge/Chrome + `ZCODE_BRIDGE_BROWSER_USE=headless` 无显式路径）按任务约定由 Codex 在 Windows 验收；本报告只覆盖 fixture 回归。
- 沙盒/环境清理、提交、PR 更新与发布不在 worker 职责内。

## Codex 独立验收（2026-10-16）

在 worker 第二次交付后冻结代码，独立审查完整差异及额外正反探针，再在原生 Windows 和 rootless Linux 容器验证。首轮未通过审查及返修日志保留；以下结果来自最终交付，不能用首轮结果代替。

| 独立检查 | 结果 |
|---|---|
| Windows / Node 22.18.0 / `npm test` | 364 项：363 通过、0 失败、0 取消、1 跳过（既有 POSIX 权限测试） |
| Linux / Node 22.18.0 / `npm test` | 365 项：363 通过、0 失败、0 取消、2 跳过（Windows 启动 hook 与进程树语义）；总数差异来自平台条件子测试 |
| 两平台 Node 22.18.0 | `npm run typecheck`、`npm run build`、`npm run validate:plugin`、`npm run test:clean-entrypoints` 全部 exit 0；clean-entrypoints 各 4/4 通过 |
| Node 24 相关回归 | Windows 24.19.0、Linux 24.20.0，各 36/36 通过（四个本次相关文件 + browser-host 原始回归） |
| 真实 detached worker | 两平台均收到 env-only 浏览器配置、任意测试秘密仍被过滤、worker 退出；Windows 无显式路径时自动发现系统 Edge |
| 短目录校验 | Linux 仓库实际置于 `/app`，完整 build 与 validator 通过；追加绝对注释、路径字符串、file URI 后分别被校验器拒绝 |
| 独立 F3 探针 | 19 个路径/URL 边界用例全部通过；Windows 真实 CLI 基线通过，JS 转义绝对路径与注释注入均被拒绝 |
| 独立插件包及真实浏览器 | Windows Edge / Linux Chromium，各 16 项通过：MCP 初始化和 1.2.5 版本、缺浏览器错误、vendored 后端、导航、填写、单次点击、页面确认、服务器恰好一次接收、截图、关闭 |
| 产物一致性 | 三个提交 JS bundle 的 Windows 交付与 Linux 干净重建 SHA256 一致（统一 LF 后比较）；Windows 验证期间 217 个交付文件均未变化；随后只补录本报告和运行文档的验收状态 |
| 清理 | 两个任务容器和一个派生镜像移除，原有 8 个镜像保留；浏览器及 worker 无残留、测试端口关闭；Windows 临时目录、下载输入与探针 fixture 共 8 个目录移入回收站，原路径不存在；证据与原始失败日志保留 |

Linux 验收环境使用非 root UID 1000、无网络、无宿主挂载、移除 capabilities、no-new-privileges；依赖准备阶段使用公开源联网安装，随后在独立断网容器运行。Windows 使用仓库之外含空格/中文的独立插件包和最小环境变量，属于目录与进程环境隔离，**不是 OS 沙箱**。两平台真实浏览器演示均未读取账户或调用模型服务。

受测产物 SHA256（LF 规范化）：

| 提交物 | SHA256 |
|---|---|
| `dist/bridge.mjs` | `6d7cf97a5c9f386f5b743b258d7ea6d0c823b75cb96b4a74e439a5e25542f8d4` |
| `worker/worker-main.mjs` | `a2b2cef48d6df746f345447c1e0082b02ff045da573287db9a664dced3404d84` |
| `worker/vendor/pkg/browser-host.cjs` | `b750aeff5cae48d6cdb71e068b0b8d96592cba52b57a514fedad515615c55b4e` |

结论：F1–F3 在上述范围内独立验收通过，适合提交维护者审查。此结论不包含 macOS/ARM 实机、真实模型端到端协议、所有浏览器版本或未运行的 Node 版本认证；既有 Windows 锁并发抖动本轮未复现，也未据此宣称根治。远端 CI 与维护者合并决定另行记录在 PR 中。本次未更改本机已安装插件，未发布版本。
