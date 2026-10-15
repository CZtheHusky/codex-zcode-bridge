# ADR-007: 可选的 Bridge 浏览器宿主

> Status: DECISION / Accepted for bounded implementation
> Date: 2026-10-13
> Scope: 实现提案与本机验证完成，提交维护者审查；不代表维护者已经接受。

## Context

本机已安装 Bridge 1.2.3 在真实 ZCode Browser Use 调用 `agent.browsers.list()` 时返回 `Unsupported ZCode app-server request: interaction/browserList`。运行时有 browser-use 插件，但 Bridge 未实现宿主反向 RPC。该缺口发生在浏览器发现阶段，尚不能据此判断模型视觉能力。

Observed: 官方公开 ZCode 源码 commit `aac4755666d09fdcd70272fcf063c077a639015f` 包含 app-server 的 browserList/browserExecute 协议和 CLI managed CDP adapter。CLI 的 `--browser-use=headless` 不适用于 app-server；桌面 IAB 依赖 Electron 宿主。

## Decision

1. 继续使用 app-server 生产路径，在 Bridge 宿主补 browserList/browserExecute；不修改已安装 ZCode、不向 app-server 强塞 CLI 专用参数。
2. 新增显式 opt-in headless browser 配置，默认关闭。使用系统已安装 Chromium/Edge 的独立临时 profile，不下载浏览器，不连接用户已有窗口，不冒充 ZCode Desktop IAB。
3. 优先按 Apache-2.0 许可适配上述固定 commit 的 managed CDP 实现与协议 schema，保留来源、许可及修改说明；允许新增固定版本 playwright-core 运行依赖，并使插件构建包含必要资源，不能依赖开发机器绝对路径。
4. 只公开已实现能力。scope 绑定当前 task 的 workspace/session，拒绝跨 session、过期 generation、重复请求和无效参数。子会话授权没有可靠证据时拒绝，不自动放宽。
5. 保持已有 permission/tool 审批、任务状态、凭据及 provider 路由语义。不得绕过 Start Plan/captcha 或修改账号配置；不记录 auth、浏览器 endpoint、页面内容或截图到普通事件日志。
6. browser lifecycle 属于当前 worker/attempt，成功、错误、取消、超时均须关闭所属 browser；采用有界清理并准确报告失败，禁止泛杀用户浏览器进程。取消后副作用不确定时如实返回 uncertain。

## Rationale

复用官方实现能降低浏览器对象 API 语义偏差。独立 browser host 是 app-server 的宿主职责；它不代表 Bridge 成为独立 ZCode 产品，也不代表完整桌面能力已实现。

## Acceptance

- 先覆盖旧版不支持 browser RPC 的回归；验证禁用、启动失败、参数/scope/generation、取消与清理边界。
- 在真实系统 Edge 上跑本地 HTTP fixture 的发现、新标签、导航、DOM、填表、点击、截图与关闭，检查临时资源和进程清理。
- 必须另跑真实 ZCode `mcp__node_repl__js` → 官方 browser-client → app-server → 修复版 Bridge → browser 的最小链路。只有 adapter 测试不能声称原生工具链通过。
- 跑仓库规定 typecheck/test/build/validate:plugin/diff-check；构建产物可从独立安装目录加载，无开发目录依赖。
- 交付后 Codex 集中审查与独立验证，再接收源码；当前安装版本保持到修复版验收通过，不能用发布替代验收。

## Consequences

新增可选运行依赖与打包资源；API 兼容边界按观测版本记录。桌面 UI、Computer Use、录制、会话同步、后台子 agent 收尾等不在此次浏览器修复的通过声明内。官方开源许可与服务/套餐条款分开表述，不声称服务端无法区分调用来源。
