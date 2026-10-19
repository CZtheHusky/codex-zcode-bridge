# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-10-18
> Last verified: 2026-10-18，PR #47 claimant 扫描返修（P1-A/P1-B、逐边持有证明的外来代排除、hold 响应校验、终止预算语义）经专项、Manager baseline-RED 复验与 evaluator 契约探针回归（worker 自测；Codex 独立矩阵待运行），证据索引见[公开返修报告](reports/2026-10-18-pr47-claimant-repair.md)；其余沿承 2026-10-17 的 ADR-009 全量矩阵核对范围。
> Verified against: 0902236c488adf7a3280dfdc38401dfa9f41cb49 + 本分支修复；受测源码指纹见各修复记录。

本文件描述当前代码，不是历史阶段的冻结设计。公共类型见 `src/interfaces.ts`，MCP schema 见 `src/mcp/schemas.ts`；共享边界见 [SHARED_CORE.md](SHARED_CORE.md)。

## 总览

```text
Codex 宿主
   │ MCP（stdio）
Bridge MCP server（src/mcp）
   │
TaskManager（src/manager）
   ├─ TaskStore（src/store）        任务证据持久化
   ├─ 调度队列与 worker 启动
   └─ 事件与 feedback 聚合
   │
ZCodeAppServerAdapter（src/adapters）
   │
ZCode app-server（zcode.cjs app-server --stdio）
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| MCP server | 对外契约面：工具名、输入 schema、输出结构 | 任务状态判定 |
| TaskManager | 生命周期所有者：排队、调度、attempt 边界、终态、续跑、清理 | ZCode 协议细节 |
| TaskStore | 任务证据持久化：status、result、events、attempt 元数据 | 业务判断 |
| Worker | 单 attempt 的执行进程，一次进入、不重跑 | 调度决策 |
| AppServerAdapter | ZCode 协议边界：session、事件、交互、清理 | 宿主策略 |
| 调用宿主 | 准备执行目录、决定是否接收改动 | 任务调度 |

合同级定义见 [INTERFACES.md](INTERFACES.md)。

`src/mcp/main.ts` 仅为 Codex 入口；`src/host/stdio.ts` 组合宿主 profile、运行配置、TaskStore、DirectWorkspaceProvider、BridgeTaskManager 和 MCP server。启动不创建 ZCode session；坏的 Bridge 配置会明确阻止启动。doctor 对坏配置返回 error。

Manager 用进程内 promise 队列以及同一 data root 下的 `.tasks/.manager.lock` 序列化调度。锁记录 owner PID 与 best-effort 启动身份，活 owner 不因时间超限被驱逐；死 owner 由串行 reclaim guard 回收。获取时原子发布完整 owner；释放时原子移出完整目录，再清理私有 retired 目录，避免释放中退出留下缺 owner 的共享锁。不可读取的旧 owner 仍明确报错，不按年龄删除。恢复 single-flight 即使释放锁抛错也会复位。不同 data root 不共享调度锁，需要调用宿主避免向重叠目录提交冲突任务。锁 owner 回收仍依赖 PID 的 ESRCH，尚未按保存的 fingerprint 判断复用。

同一 data root 内，FIFO 队列按 worker 上限和执行路径重叠规则启动 detached worker。Spawner 显式传 attempt。worker 在进入 adapter 前通过 attempt 目录的永久 `execution.claim` 抢占执行权，拒绝重复、旧 attempt 和终态入场。`state.lock` 保护状态更新和结果提交；worker 提交还校验当前 attempt/非终态。Manager 的延迟 PID 写入只作用于仍 running 的同一 attempt。

未启动 worker 可重拉一次；抢占过的 attempt 不会重复执行。已开始的 worker 不自动重跑。worker 丢失但记录的 ZCode PID 仍存活时保留占用，要求 `zcode_cancel` 验证清理。清理失败的终态任务也保留目录与 slot；续跑被拒绝，再次 cancel 或只读恢复探测确认退出后才释放，原 failed 结果不改写。进程恢复使用 PID 和启动 fingerprint；unknown 不当作已退出。Windows 强制清理按 ADR-009 执行：一个持久 PowerShell 事务 helper 为每个已验证成员持有原生句柄（持有期间 PID 不可复用），归属按创建时间表示区间与句柄精确时间零容差证明（早于父创建的旧记录在触碰前排除；同 100ns 不可区分即拒绝；自然退出父、未确认退出保守拒绝）；Windows 终止必须携带调用者期望根指纹，信号仅经"同一句柄内验证、同一句柄内 TerminateProcess"发出，不使用 taskkill /T；未解析 hold、候选消失、传输异常、helper 关闭失败均携带完整已知成员集合显式失败并保留占用。已记录的 tree-cleanup 失败以 `cleanup_unverified` 锁存：恢复与 worker 提交不得抹除证据；部分或无法恢复完整成员的记录保守阻断，完整 marker 回退及 legacy 无失败记录的 probe 恢复按 ADR-009 具体分支执行；已记录树失败的正常释放由后续 cancel 的新鲜 probe 与 claimant 扫描门控。公共错误使用稳定诊断代码，不转发本地化 taskkill 文本。claimant 扫描（PR #47 返修后语义）：存活记录 PID 指纹匹配即 claimant；枚举与 hold 之间消失的记录 PID 视为已死，其存活子代计入；已证外国换代的 PID 本身排除，其后代仅在每条边持有证明成立时排除——边的父代被持有且与枚举行同代一致、子代创建表示区间严格晚于该持有精确创建时间、子代自身再被持有核验后其更深后代递归同判；相等精度、更早、跨界、未知时间，或中间代消失/拒绝/换代，一律保持占用。多记录根证据单调合并：相对某一记录根证明外来不抹除相对另一记录根的 claimant 路径（如已死记录成员的存活子代复用了另一记录 PID），claimant 证据优先；记录目标自身的外来判定须行/句柄同代一致才可用该行作证，且仍接受同一严格入边检验（缓存句柄不是全局排除证书，严格更晚的正例复用缓存证据不重复 hold）。hold 响应按请求校验（数量/PID/精确身份字段），协议畸形拒绝扫描；行/句柄代矛盾按归属未证明保持占用。扫描 false 或拒绝时的任务相关观察（原始记录目标、请求过但未证实的候选、claimant；不新增已证外来后代候选）经既有 cleanup-failure 记录与 marker 单调持久化，后续 cancel 与重建后的扫描取并集；已观察中间代不属未观察祖先边界。kill 预算只约束等待退出：截止仅对无句柄确认退出时间的成员报 process_tree_cleanup_unverified，已确认退出的成员继续闭包确认轮。已记录 PID 的 claimant 闭包外（未观察中间祖先）不可证明，不以完整清理名义宣称。见 ADR-005、ADR-009。

worker 每 3 秒原子写入一次绑定 attempt 与 PID 的私有 heartbeat，字段含 session、turn、Bridge event 序号和已观测到的 ZCode event 序号。管理器遇到一次负向 PID 探测时，若 heartbeat 不超过 15 秒则暂缓失联判定。ZCode turn 完成后，worker 在清理进程前写入 outcome checkpoint，并在清理成功后更新验证标志；worker 在提交最终 result 之前退出时，管理器可据 checkpoint 恢复报告，清理未验证则保留 `cleanup_failed` 与 workspace 占用。

续跑先复制旧结果到 attempt 归档、准备 continue spec，再提交新 attempt 的 queued 状态。旧 root result 在提交前可恢复，在提交后因 attempt 不匹配不会被视为新结果。即使准备过程崩溃，原终态仍可读取。

审批记录按 attempt 隔离，公开 request ID 也带 attempt。相同 ID 的方法与规范化参数（包括 session 和输入）必须一致，否则拒绝。超时、取消和结束均 abort 待处理 interaction，释放 worker 轮询。

app-server stdout 协议帧与模型文本捕获分离（ADR-008）：完整 JSON-RPC 帧按换行逐条消费，单帧上限 **16 MiB 原始未 trim 的 UTF-8 字节**（空白填充不能经 trim 缩到限内），同 chunk 多帧之和不算单帧；帧顶层必须是 JSON 对象，null/数组/标量按非法帧处理。越限或非法帧是致命协议错误：首个原因被锁存，立即结束所有 pending RPC 与 turn 等待、停止缓冲，并阻止后续任何 request，使协议原因直接浮现而不是被 RPC 超时或任务时限掩盖。模型可见文本捕获保持独立的 2,000,000 字符边界并带显式截断标志。

大审批输入（ADR-008）：sanitizer 允许的审批 params 完整私有保存至 **1 MiB UTF-8 bytes**（以 `JSON.stringify(params)` 紧凑序列化为计量单位），超过时给模型与调用宿主含 actual/limit 与拆分建议的可恢复拒绝，不执行对应工具。记录携带 params_bytes 与 params_sha256（均针对上述序列化单位，不是整个 JSON 记录文件）。批准（allow/accept）在 interaction 锁内校验记录完整一致后才落盘：只有完全无新元数据且不超过旧 32,000-byte 上限的记录按 legacy 兼容放行；大记录或缺/错类型元数据、字节/哈希不匹配、验证时超过 1 MiB 的记录一律拒绝，不记为已授权。worker 消费回答前另将持久化记录与最初收到的请求比对，等待中记录消失、损坏或被改动时明确 decline 并退出等待，不无限轮询。完整性哈希用于发现损坏与意外改动，不是对同 OS 账户恶意篡改的安全隔离。超过单事件 64,000-byte 上限的大请求发布为显式标记的预览事件（`preview: true`），并附带同任务/attempt 私有完整记录的引用（路径、字节数、SHA256），预览不得当作全文。

生产执行使用 ZCodeAppServerAdapter。历史 CLI adapter、envelope、loader 和 GitWorktreeProvider 保留为 legacy 模块及其测试，不从共享公共入口导出，也不参与生产任务路径。不要把 legacy CLI 的重试、快照排除或 worktree 创建语义应用到当前生产路径。

收到 ZCode `turn.failed` 时，adapter 只在 provider 错误的顶层 `code`、`type`、`message`（或纯文本错误）中寻找明确的用量额度耗尽标记。匹配后错误码为 `zcode_usage_exhausted`，事件与结果使用 Bridge 固定说明，明确本次执行已中断，要求 Codex 立即停止当前任务并告知用户；不得继续工作、自动重试或续作，须等待用户确认额度恢复。原始 RPC 错误不外发。HTTP 429、普通 rate limit、泛化 limit 错误和未识别内容仍为 `zcode_nonzero_exit`，不能推断额度耗尽。是否能分类取决于当前 ZCode runtime 实际提供的错误字段。

模型目录客户端与执行客户端目前保留各自 RPC 生命周期：前者处理短 session/cache，后者处理 turn/event/interaction。未为了减少行数合并协议客户端；公共配置、环境、报告和进程管理仍共享。

可选浏览器宿主（ADR-007，`src/browser/`）：默认关闭。开启后 worker 的 app-server adapter 在 `#handleMessage` 拦截 `interaction/browserList` / `interaction/browserExecute` 反向请求，校验 session/workspace/turnId 身份后交给按 attempt 惰性创建的 BrowserHost。Host 负责 protocol 参数校验（zod，改编自官方 browser-use schema）、默认关闭时空列表表达、重复 requestId、stale generation、host 级命令截止（backend 不响应 abort 也会超时）与幂等 cancelRequest；每次 discovery 都重新查询 backend 以免缓存掩盖重启后的 generation 变化。managed CDP runtime（官方 CLI adapter 改编，playwright-core 1.64.0 固定版本）用独立临时 profile 启动系统 Chromium/Edge，不下载浏览器、不连接用户窗口、不冒充桌面 IAB；descriptor 通过 apiSupportOverrides 隐藏未实现成员。浏览器生命周期属于当前 attempt：成功、失败、取消、超时路径都先有界关闭浏览器宿主，最终 outcome 的 cleanupVerified/cleanupError 合并 app-server 与浏览器两份清理事实，浏览器关闭未验证时不得报告 verified。runtime.close 以连接状态而非 promise settle 判定成败，late launch 在 close 后落地仍会被回收并把真实回收结果并入判定。普通事件只含生命周期与错误码，不含 URL、标题、页面内容、截图或 CDP endpoint。插件把 managed CDP 后端打成 `worker/vendor/pkg/browser-host.cjs`（CJS，附带 playwright-core 的 browsers.json/package.json 注册数据在 `worker/vendor/`），worker ESM bundle 通过 `src/browser/load-backend.ts` 按相对路径加载，不依赖开发目录或 Codex node_modules。

TaskStore 的 JSON 用临时文件原子 rename；事件文件有独立短锁、字节上限、关键事件保留空间和稀疏索引。追加只读最后一个字节，不重新读取完整历史。worker 把模型输出拆为 2000 字符事件；容量用尽仍可能丢弃非关键事件，普通超长摘要明确标记截断。

损坏记录会显式诊断、隔离调度，并保留可确定的执行路径。健康且不重叠的任务可继续；无法确定损坏任务的执行范围时暂停新调度，不能猜测它已经释放目录。每次 pump 在调度锁内校验一次全库，快照复用于运行占用、损坏占用和 FIFO 队列；启动前重读 queued 状态。快照不跨操作缓存，终态健康检查仍保留，因此调度成本仍随历史任务数增长。

Desktop 索引同步是 best effort，事务内检查 schema 与 Bridge owner、更新有限状态字段，保留用户标题与额外 metadata。回归使用临时 SQLite。真实 Desktop schema/刷新/并发行为受安装版本影响，本轮未写入真实数据库。
