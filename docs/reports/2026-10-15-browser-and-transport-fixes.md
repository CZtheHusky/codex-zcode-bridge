# 浏览器宿主及会话传输修复：维护者审查说明

> Status: RESEARCH
> Date: 2026-10-15
> Base: fae74e45033a50fb560c0014d1a6d60a7dc771d1（上游1.2.4）

## 问题与结果

1. app-server发出的`interaction/browserList`和`interaction/browserExecute`原来返回Unsupported。本分支添加默认关闭、显式启用的headless宿主，使用独立临时profile和系统浏览器，通过managed CDP提供浏览器发现与操作。保留scope/generation校验、结构化错误、有界清理和失败传播；不连接用户现有窗口。
2. 大于旧2M字符接收阈值的合法恢复响应被丢弃，最后表现为30秒RPC超时。改为独立16MiB原始帧上限、逐帧消费及致命错误锁存；原超时预算不变。
3. 大Write审批同时受32,000-byte记录上限和64,000-byte事件上限阻碍。完整私有params现支持1MiB；事件超限时给有界预览和全文引用，批准与消费回答均校验完整内容；超限及不可交付错误不再伪装成用户拒绝。

决策：[浏览器宿主](../decisions/ADR-007-browser-host-rpc.md)、[帧与审批输入](../decisions/ADR-008-session-frames-and-large-interactions.md)。上游ADR-006配额耗尽逻辑及ADR-004控制面规则保留，版本号保持1.2.4。

## 依赖和打包

- 固定增加`playwright-core@1.64.0`，适配固定ZCode源码commit中的managed CDP与协议形状；NOTICE保留来源、许可和修改说明。
- 插件携带vendor bundle、registry资源及许可证，避免安装环境依赖开发目录；不自动下载浏览器。生成的vendor包含上游模板字符串中的有意义行尾空格，`.gitattributes`仅对该生成文件关闭blank-at-eol检查并标为generated，其余源码保持严格检查。
- 浏览器宿主默认off，`ZCODE_BRIDGE_BROWSER_USE=headless`显式启用；独立的`ZCODE_BRIDGE_BROWSER_EXECUTABLE`可指定现有浏览器。

## 验证层级

**此前1.2.3修复版本的本机实测（2026-10-14）：** Windows、Node 24.19.0、ZCode Desktop 3.15.1.8093 / Agent 0.16.9、系统Edge。原生browser-client链路完成发现、导航、填写、单次提交、等待确认、截图与关闭；服务器收据及专属资源清理独立核对。真实旧会话恢复完成无工具诊断；安装版本打包MCP的单次43,014-byte Write（审批params45,704 bytes）与批准内容、源内容一致，退出及清理成功。完整测试340通过、1跳过、0失败。私人会话正文、ID、原始输入、机器路径和备份未纳入此公开分支。

**维护者审查修复前的1.2.4整合分支（2026-10-15，Windows / Node 24.19.0）：** 类型检查、测试编译、core/plugin构建、插件结构校验与差异格式检查均通过。完整隔离测试343项，342通过、1跳过、0失败，205.529秒；保留并覆盖上游新增的配额错误分类测试。命令为仓库npm scripts的等价Node入口：`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc --project tsconfig.test.json`、`node scripts/test-isolated.mjs`、`node scripts/build-core.mjs`、`node scripts/build-plugin.mjs`、`node scripts/validate-plugin.mjs`、`git diff --check`。该次完整回归之后，同一实现提交已安装为1.2.4，并补充真实账号最小链路：MCP initialize实际报告1.2.4，GLM-5.3/low/build执行Read→唯一Write，36-byte文件与批准内容及源文件一致，completed/exit0/cleanup verified，执行22.893秒。运行配置哈希保持不变。1.2.4未重跑原生浏览器及43KB Write链路；这两项实测证据仍属于此前1.2.3修复版本。

**维护者审查修复批（2026-10-15实现；2026-10-16 Codex集中验收通过）：**

- 仅为 `test/browser-host.test.ts` 的三个超时夹具增加各自有界（5s）、在 `finally` 清理的 referenced 定时器，使 host 的 unref'd deadline/close 预算能在隔离测试中触发。保留原有 timeout、sideEffect、cleanup 断言和实际 host 超时路径；生产源码、超时预算、依赖、engines 和 CI 配置均未改变。
- 修正 NOTICE 与 `configure-runtime.ps1` 注释中的两处浏览器 ADR-006 → ADR-007；保留上游 provider ADR-006。补充官方 playwright-core 制品携带内嵌 MCP/ajv 内容的说明，以及 core/fork 宿主的依赖打包责任。
- 修复前 Node 22.18.0 的 browser-host 文件为 5通过/9取消；另外两个同类场景单独运行也会取消。ZCode 修复后三个场景分别通过，整个文件14/14通过，无诊断 preload。

Codex在原生Windows环境独立执行的结果：

| 检查 | 版本与结果 |
|---|---|
| `npm run typecheck` | Node 22.18.0，exit 0 |
| `npm test` | Node 22.18.0，343项：342通过、0失败、0取消、1跳过，exit 0 |
| `npm run build` / `npm run validate:plugin` | Node 22.18.0，均exit 0；重建的bridge、worker及browser vendor与提交物字节一致 |
| browser-host兼容回归 | Node 24.19.0，14/14通过、0取消，exit 0 |
| `git diff --check` | exit 0 |

执行环境记录：ZCode工具终端缺少 `OS` 环境变量，曾使Windows hook测试失败；该问题在相同终端的Node 22和24均复现，按进程级补齐本机真实值 `OS=Windows_NT` 后通过。另一次尝试因本地npm启动入口缺失而未进入套件。这些原始失败与后续结果均保留。Codex的独立验证使用原生Windows已有的 `OS` 值，无诊断preload；npm入口仅设于任务私有目录，未修改全局配置。任务工作区不是OS沙箱。

本批未复现已知 `state.lock` EPERM，未修改锁代码；仍按独立问题保留。ADR-007/008批准权仍在维护者。GitHub双平台CI结果以该PR实际运行记录为准；本机验收不替代CI或维护者批准。

本次受测 `test/browser-host.test.ts` SHA256：`688125e0c5370de24e418e09ab0bbd6ef6fdeb484f8e6731064180781ec9c34b`。独立验证期间所有受跟踪文件均未变化；之后只补充本次文档说明。


维护者审查修复前受测src/test/scripts与package清单的SHA256指纹：`3325db76d632884147675f7a92e73449ac71301c369cdde2171af4525dde58a1`（按相对路径排序，逐行`path:sha256\n`再取哈希）。构建产物重新生成，不携带工作树junction路径。

## 未覆盖边界

>64KB事件预览、1MiB输入边界、16MiB协议帧及损坏/缺失/修改审批通过合成回归验证，不冒称都由真实模型生成。跨ZCode版本、Linux/macOS浏览器路径、桌面IAB、Computer Use、录制和子会话派生未据此认证。浏览器自动化不等于已验证模型视觉理解。

历史失败尝试仍保留在本机证据中，公开摘要不把它们改写为成功。本分支供维护者代码审查，不包含自动发布或版本提升。
