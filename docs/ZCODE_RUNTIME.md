# ZCode 运行配置边界

> Status: AUTHORITATIVE
> Last updated: 2026-10-28
> Last verified: 2026-10-28，静态核对本次 systemd runner 配置、App pipe 私有记录与环境转发边界；另核对本机 systemd 255 / MCP / Bridge worker 的 8 项离线闭环实测证据（执行器和 App 接收端为 fixture、无模型调用），详见 [ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md#当前验证边界2026-10-28)。另已完成本机真实 ZCode 自评/续作、当前 App 消息送达与 Codex 独立验收；新版调度在对话空闲时启动新轮次仍未验证，详见 ADR-010。
> Verified against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + 当前 working tree（ADR-010 调度相关源码与同版 bundle 离线实测；仅上述范围）
> Prior verification: 2026-10-16，独立验证 Windows/Linux worker 环境转发、Windows 自动发现及真实浏览器后端（见[修复报告](reports/2026-10-16-environment-portability-fixes.md#codex-独立验收2026-10-16)）；其余条目沿用 2026-10-15 核对范围。
> Prior verified against: 0e1e319561edf94e0f0cd481ac455ec784eb19dd + 本分支 F1–F3 修复；受测产物指纹见修复报告。

当前生产路径是 `node zcode.cjs app-server --stdio`，不是历史 CLI `--prompt --json`。解析入口为 `NodeRuntimeResolver`，配置项与用户设置方法见仓库 README。

Bridge 只读取官方 builtin/personal provider 配置，不复制、不改写内容，也不将环境或凭据写入任务 metadata。personal 配置的 `config.providerConfigRules.providerRules` 必须为非空数组或对象；已知空 stub 被拒绝。结构验证不能证明 provider 可用或账号有权限。

请求模型时优先保留 catalog 中的精确 provider/model。无前缀旧 provider 只有在 catalog 存在同 model 的 account 前缀项，或官方规则确立了对应 account 映射时才解析；不按模型显示名切换其他 provider，catalog 缺席仍由 session/setModel 验证配置标识与模型。account: 标识不重复加前缀。请求值与 runtime 确认值分别保留，不持久化为工作区默认。见 ADR-005。

persisted runtime-config 中已知字段只能是字符串或 null；缺文件允许环境/发现回退，存在但损坏、非 object 或超过 64 KiB 会报配置错误。默认 mode 仍为已披露的 yolo；不能把坏配置当成首次未设置而回退到该模式。

浏览器宿主配置（ADR-007）：`ZCODE_BRIDGE_BROWSER_USE` 取 `off`（默认，含空值/未设置/非法值回退为 off）或 `headless`；`ZCODE_BRIDGE_BROWSER_EXECUTABLE` 可选，须为已存在文件的绝对路径，缺省按官方实现解析已安装 Chromium/Edge（不下载浏览器）。两项均为普通字符串配置键，遵循配置优先于环境变量的既有规则；非法 USE 值不阻断任务，仅保持关闭并由 doctor 给出 warning。detached worker 进程按显式键清单转发这两项非秘密设置（2026-10-16 修复：此前 env-only 配置在真实 spawn 边界丢失），其余任意父进程环境与秘密仍不透传。Windows worker 环境保留 `ProgramFiles` / `ProgramFiles(x86)`（接受常见大小写）等非敏感系统目录变量供自动发现使用，发现解析同样不区分大小写键；显式 `ZCODE_BRIDGE_BROWSER_EXECUTABLE` 优先级不变。不向 app-server 传递任何 headless CLI 参数；浏览器由 worker 内的 managed CDP runtime 以独立临时 profile 启动，生命周期见 ARCHITECTURE.md。

执行和模型目录 RPC 客户端都是私有集成实现，当前假运行时测试覆盖调用选择、事件、交互和清理。真实协议随安装版本变化；本次已新建真实会话验证记录版本的浏览器链路，不能将这次 smoke 扩展为全协议或其他版本认证。

stdout 协议帧与审批持久化边界（ADR-008）：换行分隔的完整 JSON-RPC 帧单帧上限 16 MiB 原始未 trim UTF-8 字节，帧顶层必须是对象，致命帧错误锁存原因并终止当次 attempt 的协议流；turn 可见文本另有 2,000,000 字符捕获上限。审批 params 以 `JSON.stringify(params)` 紧凑序列化完整保存至 1 MiB，单事件行仍守 64,000 bytes，超限走显式预览加完整引用。这些上限是 Bridge 侧守卫，不依赖也不约束 app-server 的内部实现；真实 resume 帧（观测 2,139,927 UTF-8 bytes）在限内正常通过。

2026-10-14 独立验证补充：已用本机 ZCode Desktop 3.15.1.8093 / Agent 0.16.9、GLM-5.3 / max、build 模式完成原生 browser-client 单次提交与截图、关闭验收。这次小范围 smoke 不等于全协议或跨版本认证。详情见 [独立验收](reports/2026-10-15-browser-and-transport-fixes.md)。

## 预约运行环境（ADR-010）

默认 Codex stdio 装配四个调度工具。`coding_agent_schedule` 的首版监督器只支持 Linux `systemd-run --user`：runner 使用 `Type=exec`、`Restart=on-failure`、`RestartSec=5s`、`KillMode=process` 和持久化 UUID 单元名。要求 systemd-run 支持 `--expand-environment=no`（systemd 254 起），禁止参数环境展开；本机 systemd 255 已通过下述离线闭环实测，其他版本未认证。启动回执核对 active/MainPID/cgroup；停止 runner 不代替 TaskManager 对独立 worker 的清理验证。缺可用 user systemd 时显式拒绝预约，不回退到 PTY、tmux 或 nohup；不自动开启 linger，不保证注销、关机或 App 关闭后的行为。

监督标识与 `runner.log` 路径由 schedule 回执/status 返回。runner 入口在源码构建为 `dist/src/schedule/runner-main.js`，插件为 `worker/schedule-runner.mjs`；与原 `dist/bridge.mjs`、`worker/worker-main.mjs` 一起构建和校验。运行数据位于 `<dataRoot>/.schedules/`，不改变 `.tasks/` 的任务事实。

`CODEX_APP_TOOLS_PIPE_PATH` 只从 MCP 宿主环境取得，写到宿主私有 `.schedules/runtime.json`，每次工具调用可刷新，runner 每次发送重新读取。它不加入 worker 环境白名单，不放进 TaskPackage 或 ZCode prompt；user systemd manager 会继承自身环境，因此 runner 经 `/usr/bin/env -i` 清空环境，再显式注入现有 worker 配置键清单、必要 host/plugin 标识，以及仅供调度宿主使用的 `XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS`、`ELECTRON_RUN_AS_NODE`；这三个键没有加入 ZCode worker 白名单，不能仅靠 `--setenv` 声称环境隔离。`thread_id` 由宿主显式绑定当前原聊天，不从别的进程环境推断。

App pipe 使用观测到的本机 `send_message_to_thread` 协议，Linux App 26.1016.61520 / codex-app-tools 0.1.6 的历史实测不构成公开或跨版本保证。pipe 不可用时 outbox 保留错误并重试；成功回执只有交付意义，可能重复，不能证明验收通过。本机真实 systemd/ZCode/原聊天验收链路已验证至消息送达与独立接受；新版调度的空闲聊天新轮次仍未验证，见 [ADR-010](decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md#当前验证边界2026-10-28)。

## Kimi 执行器增量（ADR-012）

`TaskPackage.executor` 可选 zcode/kimi，省略仍走原路径。Kimi 使用 `kimi: { model?, permission_mode? }`，默认 yolo，不接受 ZCode model 字段；续作保持已持久化的 executor 与 session。公开工具名保持兼容，包含预约工具；ZCode doctor/catalog/default_model 不用于诊断或配置 Kimi。兼容字段 zcode_session_id、zcode_pid、zcode_output 在 Kimi 任务中存放 Kimi 对应证据，执行 profile.executor 和 usage.source 区分来源。

KimiAdapter 通过认证的 loopback Server API 执行；先 GET snapshot 恢复冷会话并取得游标，再订阅确认并提交独立 prompt_id。只接受当前 session/main agent/prompt/turn，失败、断流、文本偏移不符及无效报告均不得完成；thinking 不外发。审批/问题走既有 interaction 存储；成功和失败均验证进程树清理。Kimi 明确额度耗尽使用 kimi_usage_exhausted，普通 429 为 kimi_nonzero_exit；调度额度故障只升级通知，不自动续作。

配置、版本与验证范围见 [ADR-012](decisions/ADR-012-kimi-executor.md) 和[验证报告](reports/2026-10-28-kimi-validation.md)。本节不扩展原有 ZCode 的历史验证结论。
