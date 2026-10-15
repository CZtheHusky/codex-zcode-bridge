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

**当前1.2.4整合分支（2026-10-15，Windows / Node 24.19.0）：** 类型检查、测试编译、core/plugin构建、插件结构校验与差异格式检查均通过。完整隔离测试343项，342通过、1跳过、0失败，205.529秒；保留并覆盖上游新增的配额错误分类测试。命令为仓库npm scripts的等价Node入口：`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc --project tsconfig.test.json`、`node scripts/test-isolated.mjs`、`node scripts/build-core.mjs`、`node scripts/build-plugin.mjs`、`node scripts/validate-plugin.mjs`、`git diff --check`。该次完整回归之后，同一实现提交已安装为1.2.4，并补充真实账号最小链路：MCP initialize实际报告1.2.4，GLM-5.3/low/build执行Read→唯一Write，36-byte文件与批准内容及源文件一致，completed/exit0/cleanup verified，执行22.893秒。运行配置哈希保持不变。1.2.4未重跑原生浏览器及43KB Write链路；这两项实测证据仍属于此前1.2.3修复版本。

受测src/test/scripts与package清单的SHA256指纹：`3325db76d632884147675f7a92e73449ac71301c369cdde2171af4525dde58a1`（按相对路径排序，逐行`path:sha256\n`再取哈希）。构建产物重新生成，不携带工作树junction路径。

## 未覆盖边界

>64KB事件预览、1MiB输入边界、16MiB协议帧及损坏/缺失/修改审批通过合成回归验证，不冒称都由真实模型生成。跨ZCode版本、Linux/macOS浏览器路径、桌面IAB、Computer Use、录制和子会话派生未据此认证。浏览器自动化不等于已验证模型视觉理解。

历史失败尝试仍保留在本机证据中，公开摘要不把它们改写为成功。本分支供维护者代码审查，不包含自动发布或版本提升。
