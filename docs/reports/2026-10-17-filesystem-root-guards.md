# 文件系统根守卫与 Windows 锁时序修复记录

> Status: RESEARCH（一次性交付与验证记录，不替代当前合同）
> Date: 2026-10-17
> Base: 0902236c488adf7a3280dfdc38401dfa9f41cb49（上游 1.2.6）
> 分支：codex/filesystem-root-guards-20261017

PR #45 维护者审查遗留的两条 P3：`state.lock` 竞争 EPERM/ENOTEMPTY 与测试 teardown ENOTEMPTY 同属 Windows 文件系统时序问题；`buildRepoRootLeakPattern` 对病态检出根（`/`、`C:\`）无守卫。本记录汇总证据、修复与验证边界；原始探针输出保存于任务私有目录 `local/filesystem-root-guards-20261017/worker/`。

## 锁竞争证据（自然复现 + 确定性注入）

- 原始失败的测试输出未在旧任务目录中保留（2026-10-16 两轮目录均无 ENOTEMPTY/EPERM 原文），按"区分自然复现与确定性注入"处理，不虚构原始输出。
- 自然复现（基线代码、真实跨进程竞争，6 进程 × 5000 次 acquire/release）：Node 22.18.0 逃逸 2 次、Node 24.19.0 逃逸 1 次，错误均为 `EPERM: rename '<dir>/state.lock' -> '<dir>/state.lock.<token>.retired'`，即**释放路径**的撤回 rename 失败（这是直接观察）。机制解释（假设，未做句柄层验证）：竞争者 `acquireExistingLock` 读取 owner.json 时可能在目录内短暂持有句柄，Windows 拒绝对含打开句柄子文件的目录 rename；无论具体机制如何，该错误从 `withEventLock` 的 `finally` 抛出并掩盖已成功完成的状态写入是被观察到的行为。获取路径的瞬时失败（目的名 delete-pending）此前已有 #30 的 EEXIST/EPERM/EACCES ≤3 次立即重试，但不含 ENOTEMPTY/EBUSY、无间隔。
- 确定性注入（补丁 `fs.renameSync` 注入错误码）：瞬时码到达白名单路径时按预算重试；非瞬时码（EINVAL）第一次即抛；预算耗尽抛原始错误码且不留 staging/retired 残留。

## 修复（src/store/process-lock.ts）

- 瞬时码白名单统一为 `EEXIST/EPERM/EACCES/EBUSY/ENOTEMPTY`（依据：本机自然复现 EPERM；Node 22.18 官方 fs 文档将 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM 列为 recursive rm 的可重试码；libuv 将 sharing violation 映射为 EBUSY、access denied 映射为 EPERM/EACCES）。
- 发布竞争（rename staging→锁名失败且目的名不存在）：保留 ≤3 次重试，白名单扩大，并在重试间加 10ms 停顿等 delete-pending 澄清。
- 撤回 rename（锁名→`.retired`）与死 owner 回收 rename：新增有界重试（2 秒预算、10ms 间隔）；预算耗尽抛出原错误，共享锁保持完整可读 owner 记录，后继获取者看到存活 owner 得到 null，不驱逐。
- 私有目录清理:staging/retired 的 rmdir 与 owner 文件 unlink 对瞬时码 1 秒有界重试;尽力而为边界仅适用于这些**私有**残留(ADR-005),不覆盖原获取错误。reclaim guard 不属私有 best-effort——见 Attempt 2/3 的最终语义(共享状态,清理失败必须可见)。crash-safety 测试保持不变并通过。
- 不变量不变：staged rename 仍是唯一发布点（并发最多一个 owner）、未知 owner 不按年龄驱逐、非瞬时错误与预算耗尽都可见失败。

修复后同强度自然竞争（6×5000）在 Node 22.18.0 与 24.19.0 均 0 逃逸。

## teardown ENOTEMPTY 修复（test/）

- `runtime-remediation` 的 fixture 清理是无重试的 `rm(recursive, force)`。150 轮"子进程在树内写日志后退出再删除"模拟未自然复现（如实记录：原始抖动更罕见，与全量并发负载相关）。
- Node 22.18 文档核对：`fs.rm` 系列在 recursive 模式对 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM 按 `retryDelay` 线性退避重试 `maxRetries` 次，默认 0。确定性注入（Node 22 上补丁 `fs.rmdirSync` 可被 rmSync 观测）证明：连续注入 ENOTEMPTY 时默认选项失败可见，`maxRetries>=2` 存活。
- 修复：`test/helpers.ts` 导出 `TEMP_TREE_REMOVE_OPTIONS = { maxRetries: 5, retryDelay: 100 }`，`removeTempDir` 与 `runtime-fixture` 的 cleanup 采用。预算耗尽仍抛出，不掩盖真实清理失败；其余测试文件的内联清理未改动（超出本次证据范围）。

## 根守卫（scripts/lib/repo-root-pattern.mjs）

- 基线行为（探针留档）：根 `/` 时任意 `//` 行注释与任意 `file://` URI 均判泄漏；根 `C:\` 时同盘任意绝对路径（`C:\Windows\...`）均判泄漏。检查退化为必然误报。
- 新增 `assertNotFilesystemRoot(root)` 并在 `buildRepoRootLeakPattern` 入口调用：拒绝 POSIX 根（`/`、`//`）、盘符根及其等价写法（`C:`、`C:\`、`C:/`、大小写、`\\?\C:\`、`\\.\C:\`）、UNC 共享根（`\\server\share`、`\\?\UNC\server\share`）与非字符串/空白输入，错误信息说明输入、根种类与后果（必然误报、POSIX 根连 `//` 注释都命中），并指引用命名目录下的 checkout。抛错使 validate-plugin 以非零退出显式失败，不静默跳过泄漏检查。测试使用输入夹具，未把仓库放到磁盘根目录。
- 调查中发现并一并修复的相邻误报：URL 主机名恰为短根名时（如根 `/app` 对 `https://app/config`），http 抑制 lookbehind 无法跨 `://` 边界回看，基线会误报；已在 scheme 冒号后首位增加 `(?<!https?:\/?)` 抑制，普通 http(s) URL 语义与既有正反例回归全部保留。此为 PR #45 审查外的独立发现，超出两条 P3 字面范围但在"HTTP URL 不误报"语义内，如不接受可单独回退该 lookbehind 增量。

## 验证

- `npm run typecheck`、`npm test`（Windows Node 22.18.0 两次全量）、Node 24.19.0 全量、`npm run build`、`npm run validate:plugin`、`npm run test:clean-entrypoints`、`git diff --check` 的实际结果与 bundle 指纹见任务私有目录执行流水；本报告不复制数字，以流水和 CI 为准。
- 新增回归：`test/process-lock.test.ts`（注入瞬时/非瞬时/预算耗尽/撤回重试/存活 owner 不驱逐 + 真实 3 进程竞争 0 逃逸）、`test/teardown-retry.test.ts`（选项接线跨版本 + Node 22 端到端注入）、`test/validate-plugin-root-pattern.test.ts`（根拒绝清单/近根可用/主机名 URL 不误报）。
- NOT RUN：Linux/macOS 实机回归（本轮为 Windows 本机验证；Linux 由 Codex 用已准备的 rootless Podman 独立验收）、自然形态的 teardown ENOTEMPTY 复现（150 轮未触发，采用确定性注入；不宣称维护者那次抖动的唯一根因已被证明或根治）、锁竞争在非 Windows 平台的自然复现（该时序为 Windows 特有）。

## 清理

任务私有临时目录、探针输出与运行日志的位置及回收方式见 `local/filesystem-root-guards-20261017/worker/execution.md`；未创建容器、端口或全局安装。

## Attempt 2（2026-10-17 集中审查返工）

首轮交付未接收。Codex 独立注入实测（evaluator/attempt-1/{late-identity,lock-failures,teardown-test-audit,root-probes}.json）证实的问题与本轮修复：

1. **迟到 identity 复活已删除的 fixture**（late-identity.json：completed 返回后 resolve 延迟 250ms 的 selfIdentity，目录被重建并写入 executor-identity.json；与此前观察到的 7 个真实残留形状吻合）。修复：`src/worker/run-task.ts` 跟踪全部 self/runtime identity 写盘 promise，在终态 artifacts 提交前以 2 秒有界预算收束（Windows 平台探针约 0.5 秒完成），超时后关闭写入口——迟到 resolve 直接丢弃（A2 允许 null identity），不再触碰已删除的 store；心跳/关联计时器改由外层 try/finally 在所有退出路径清理（含心跳建立后、adapter 运行前的抛出路径）。回归：`test/late-identity-lifecycle.test.ts` 4 项（预算内落盘、超预算丢弃不复活、失败路径+拒绝无未处理、真实 adapter 的迟到 runtime identity）。它是本轮生命周期范围内的具体缺陷；不宣称它就是维护者那次 ENOTEMPTY 的唯一根因。
2. **锁失败可见性**（lock-failures.json）：live owner 存在时发布 rename 注入 EIO 被吞成 null——现在非白名单码无论目的名是否存在都立即抛出；死 owner 回收的共享 `.reclaim` guard 清理注入 EIO 仍报成功并留 guard（会永久阻塞后续回收）——`removeSharedGuard` 对瞬时码有界重试（2 秒），非瞬时/耗尽抛出含 guard 路径的可诊断错误，原操作错误不被清理错误覆盖；`acquireExistingLock` 重构，只有"读取 owner 失败"走不可读锁年龄策略，reclaim 下游错误不再被 catch-all 吞掉。回归：EIO-live-owner 抛出、guard 非瞬时可见+手动移除后恢复、guard 瞬时重试成功、guard 预算耗尽可见。
3. **retired owner.json 首次 unlink EPERM 残留**（lock-failures.json）：`removeStagedLock` 只重试 rmdir 修不了未删除的文件——owner 文件 unlink 增加同样的 1 秒有界瞬时重试，整体仍是 ADR-005 私有 best-effort 边界（不抛、不覆盖原获取错误）。
4. **teardown 测试第二臂无注入**（teardown-test-audit.json：Node 22 默认 rm 自带一次内部重走已耗尽 2 次注入，重试臂实际遇到 0 次）：重建为三独立树+独立计数器——默认臂必须失败可见、重试臂必须实际收到注入并存活、永久错误带满预算仍失败；新增异步 `runtimeFixture` cleanup 接线断言。
5. **根等价写法**（root-probes.json 39 例中 4 例：`/./`、`/alpha/..`、`c:/./`、`C:/alpha/..`）：守卫现在对 win32/posix 词法规范化后的候选一并用分隔符无关谓词判定,错误信息注明词法等价目标;重复分隔符（`C:\\`）与 `\\server\share\repo\..` 一并覆盖。措辞修正(Attempt 3):两个规范化器作用于所有输入——win32.normalize 也会折叠扩展前缀后的 `..`(`\\?\C:\repo\..` → `\\?\C:`,按盘符根拒绝);命名扩展 checkout(`\\?\C:\repo`)因规范化候选非根而保持可用,由近根正例回归固定。
6. **并发测试收束与公平性**：`test/process-lock.test.ts` 的竞争测试改为 spawn 即注册 error/close、finally 先 `terminateProcessTree` 收束全部本次子进程并确认 close 再清理（新增"崩溃+挂起子进程被收束、清理后无残留"显式用例）；互斥验证改用临界区内共享 ledger（任一前缀并发持有者 ≤1），不再假设无公平性合同时每个进程固定轮次内必然获胜（只断言总有临界区活动）。
7. HTTP 主机名等于短根的修复经审查保留;Linux 交接占位脚本未采用——仅标记 DEPRECATED 保留在任务 sandbox(未删除),Linux 由 Codex 用自有 rootless Podman 独立验收。

## Attempt 3（2026-10-17 第二轮复验返工）

Attempt 2 复验(evaluator/attempt-2/review.md)确认:root 39/39、三个锁失败分支、迟到 self/runtime 实际行为、teardown mutation 均已关闭;本轮按收敛清单修复四组剩余:

1. **共享 guard 提前返回泄漏**(lock-failures.json 第四类:外层确认 dead、持 guard 后复查 owner 变 live,返回 null 但 `.reclaim` 残留):`reclaimDeadOwner` 重构为单出口漏斗——guard 创建后的所有结局(reclaimed/busy/原错误)都经过恰好一次 `removeSharedGuard`,不重复消费清理预算;清理失败在 busy/ENOENT 竞争路径同样抛出可见,原操作错误优先不被覆盖。回归:复查变 live、复查变 invalid、锁消失(ENOENT)+guard 清理失败可见三分支。
2. **Linux 空/未知 owner 目录被发布 rename 覆盖**(rootless Podman UID1000 断网零挂载真实复现,unknownPreserved=false;POSIX rename 静默替换已存在空目录):发布前增加存在性预检——锁路径已存在(任意形态:空目录/异构内容/普通文件)一律走 `acquireExistingLock` 策略,不再尝试 rename;空未知 owner 目录字节不变。staged rename 仍是自由路径上的唯一原子发布点;检查到 rename 之间出现的锁仍由 rename 错误路径接管。未验证边界(如实说明):与**旧版本进程**并发发布时,旧实现仍可能覆盖窗口内出现的空目录,本预检不构成跨版本保护;完整 owner 的原子性与并发独占不变。回归:空目录/异构内容/文件三种形态不被接管且内容原样。
3. **子进程收束假成功与 Linux 信号退出**:`reapTrackedChildren` 终止器可注入;终止失败与 close 超时(5 秒,unref 计时器)以抛出报告,不再吞错或超时假成功;仅当全部本次 child 的 close 事件确认后才允许清理。"已关闭"以 close 事件为准(Node 22.18 官方 child_process 语义:POSIX 信号退出 exitCode 合法为 null,signalCode 置位)。回归:终止失败分支与 no-op 终止器 close 超时分支均证明清理不会在仍存活 child 下面执行。
4. **identity 回归不可靠**(identity-test-mutation.json:移除两个 callback fence 的 mutant 仍 4/4 通过并留下 3 份 executor-identity.json):测试重写为显式受控 deferred——运行结束、fixture 删除**之后**才 settle,并等待 `whenSelfSettled`/`whenRuntimeSettled`(worker 的 .then 先挂载,派生 promise 后解析 + 一个 macrotask,保证回调已执行)再断言;名为 reject 的测试现在真正 reject。移除任一 fence 的 mutant 会以"目录复活"失败。
5. 证据措辞与一致性:死 PID 夹具不再附会原因,改为使用前断言 ESRCH 前提(固定高 pid,同 observation-lifecycle A2-07 惯例);normalize 注释按真实策略修订(见上);`removePrivateDirectory` 注释明确 guard 不属私有 best-effort;worker 曾把运行中 31 项快照当最终残留——Codex 终态核查为 12 项(11 空目录+1 compile-cache 文件),最终统计以结束后快照为准。

本轮交付方式按复验要求:修复+针对性自测+typecheck/build/validate:plugin/diff+bundle 同步;最终 Windows 双版本全量矩阵与 Linux 完整沙盒由 Codex 独立执行。原始失败与全部旧证据保留。

验证与指纹更新见 worker 执行流水 attempt 2；attempt 1 的全部原始失败证据与日志未改动。

## Attempt 5（2026-10-17 独立矩阵复验返工）

Codex 独立双平台矩阵(evaluator/matrix-attempt-1):Windows 全部通过;Linux22 全量 1 失败(真实竞争测试 ENOTEMPTY 逃逸)、Linux24 全量 1 失败(cooperative cancellation stale/terminal 提交),二者不同源,分别诊断修复:

1. **publication ENOTEMPTY 竞争逃逸(Linux22)**:确定性复现(worker/probe-red-enotempty-contention-node22.json):目的名不存在时注入 rename ENOTEMPTY,旧实现烧完 ≤3 次发布重试后把 errno 抛出。机制:POSIX rename(2) 的 EEXIST/ENOTEMPTY 只在目的已于 rename 时刻作为非空目录存在时产生(既有空目录会被静默替换,正是存在性预检针对的问题)——竞争者在存在性预检与 rename 之间发布又撤回,复查 existsSync 为空使旧代码误判为"歧义缺失瞬时"。修复:新增 DESTINATION_PRESENT_CONTENTION_CODES(EEXIST/ENOTEMPTY)——该二码无条件按"确定的目的在场竞争"移交 acquireExistingLock(锁已再撤回则读为 busy,由调用方有界外循环重试),不消耗发布重试预算;EPERM/EACCES/EBUSY 于目的缺失时保持 ≤3 有界重试后可见抛出(可能是持久访问故障);非瞬时码立即抛出不变。不变量:单 owner(staged rename 仍是唯一发布点)、未知 owner 保护(预检+existing-owner 策略)、外层超时有界、持久故障可见。回归:ENOTEMPTY/EEXIST 注入(目的缺失)首试即 busy-null 且 rename 仅 1 次——该测试在旧实现下失败(即红证据);歧义码重试测试改用 EPERM/EBUSY。自然竞争 6×5000 修复后 Node22/Node24 均 0 逃逸。
2. **cooperative cancellation(Linux24)**:该测试为基线既有(git diff 为空,1.2.3 后未动)。确定性机制复现(worker/probe-red-cooperative-cancel-node24-run2.json):结果投递 >500ms 协作窗时 manager 终止假 worker 并写终态,迟到 commitWorkerResult 以 stale/terminal 拒绝——与现场错误一致。边界如实说明:600ms 变体证明迟到提交拒绝机制,不证明原 104ms 现场具体超窗原因(矩阵负载下事件循环延迟使 40ms 定时器迟到/轮询饥饿为合理推断,未直接观测)。修复(仅测试 fixture,不动 manager/时钟策略):finish 改为协调于 store 中持久化的 cancel_requested 记录(有界 5s 轮询)后立即提交,确定性落在 500ms 窗内;实质断言不变(worker 结果被验证、无第二次终止、session 传播)。新增边界测试钉住 >500ms 策略:恰好一次已验证终止、迟到提交按契约拒绝、manager 结果优先。
3. Linux 定向验证脚本 sandbox/worker/linux-targeted-attempt5.mjs(errno 分类二探针+三测试;Windows 侧未运行,NOT RUN,交 Codex 在其既有隔离资源执行)。定向回归 10 文件 147 项 146 通过/0 失败/1 既有跳过;typecheck/build/validate:plugin/diff exit 0;最终双平台矩阵仍由 Codex 执行。

## Attempt 6（2026-10-17 收敛修正）

attempt-5 复验(evaluator/attempt-5/review.md):15 文件指纹匹配,publication 分类 7/7 独立通过,锁分类实现进入最终验证候选不再改动。本轮仅三项收敛:

1. **600ms 边界测试非确定性**:Codex 反例(cancel-boundary-timing.json:finish(600) 先调度、cancelTask 延 188ms 启动时,worker 605ms 提交仍落 500ms 窗内,0 终止)证明固定定时不能保证提交晚于 manager 终态。重写边界测试为因果序:先 await manager 完成已验证取消(此时其终态已落盘、假 worker 已被恰一次终止),再尝试 worker 侧 commit——确定性 stale 拒绝、恰一次终止、manager 结果优先,无任何定时假设。协作取消测试保留显式意图协调;注释改为事件化协调描述,不再称数学时序保证。
2. **原始失败原因措辞**:测试注释不再把矩阵负载延迟称为现场观察到的原因;仅保留观察到的事实(104ms TAP 时长的 stale/terminal 拒绝),600ms 诊断为可能的拒绝机制而非已证原始原因。
3. **POSIX 术语**:process-lock.ts 分类注释改为"目的已作为非空目录存在"(POSIX rename 对既有空目录是静默替换——正是存在性预检针对的问题);报告同步修正。

仅运行受影响的取消/锁定向测试+typecheck/build/validate:plugin/diff;不重复 10 文件定向、全量矩阵或 6x5000 压力(记录保留);最终矩阵由 Codex 在修正后的冻结交付上执行。

## Attempt 7（2026-10-17 矩阵二相关 fixture 生命周期返工）

矩阵二复验(evaluator/matrix-attempt-2/review.md):Linux 全通过。Windows 两项失败需分开表述:Windows22 二轮失败是本任务 fixture 生命周期缺口(丢弃 pid、receipt 后立即删树致真实 EBUSY);Windows24 的**主失败**是未改生产 capture 的 malformed-identity 保守拒绝(基线既有问题,Codex 另记债,本轮不扩大修复),其后的 fixture 缺口(finally 不收束 owned children)导致遗留子进程并挂住整轮——两项分别处理,不混同源:

1. **worker-env-portability 丢弃真实 spawner 返回的 pid,receipt 后立即删树**(受控证明 worker-env-exit-proof.json:receipt 在场而子进程持活时 rmdir 复现 EBUSY,允许退出后清理成功——生命周期缺口成立,未记录原始失败瞬间的句柄持有者):探针 worker 现于 receipt 后监听私有 release 文件;两个环境测试捕获 owned pid,finally 经共享门禁 helper(写 release→有界确认 owned pid 退出→确认后才删树);新增确定性回归"receipt 不等于 exit"(持活 worker 在 receipt 后可证存活,释放并确认退出后才移除树)。
2. **process-spawn 测试 finally 不收束 owned children**:parent/sleeper 双 fixture 脚本各自独立监听同一私有 release(仅在主断言或其失败之后的 finally 触发,不能掩盖生产行为);父脚本对自己持有的 child 句柄仅在真实 close 事件后退出(spawn error 单独记账并按失败退出);测试侧从 spawn 即登记 error/close、完整行解析 pid 回执,回执失败时已知 owned 父 pid 仍被释放且目录按 unknown-descendant 门禁保留;生产 terminateProcessTree 的原断言完全不变,并新增失败路径覆盖(不调用生产终止时,协作释放独自收束两个已知进程并清理)。按 Safety addendum,在调用未改动的生产树终止器之前执行只读归属前置:CIM 快照闭包内 node 行必须恰为记录的父/孙 pid 且命令行引用本次唯一 fixture 脚本,sleeper 父关系与严格 BigInt 创建时序(无容差)不得早于 root,console host 必须挂于已验证 pid 且不早于其父;任何无关/更旧/未知行在发信号前显式失败(matrix2 事故=共享 ParentProcessId 的十月15 系统行被今日 root 选中,正是该门禁拦截的形状)。新增 fixture fallback 仅通过私有 release 与 owned child handle 收束,不做宽泛树终止;正向真实测试在归属前置通过后仍按原路径调用生产 terminateProcessTree(其 Windows 生产实现内部照旧使用 taskkill 树终止),主测试路径保持不变。
3. **共享门禁 helper**(test/helpers.ts cleanupOwnedProcessFixture):release 信号写出失败、任一 owned pid 退出确认超时、或显式 preserveTree(未知后代)时一律保留 fixture 树并显式报告;成功路径由调用方一次性标记避免重复调用;primary 失败传播时诊断不被遮蔽也不遮蔽 primary。配套 owned-fixture-cleanup.test.ts 三态回归(合作子进程经 ready 握手/cwd 断言/exit code 0;拒绝子进程保树且显式失败;primary 传播时诊断可见、树保留、错误身份不变)。

验证:受影响三文件定向 9 项 9 通过 0 失败(过程失败两轮保留:console.error 恢复顺序、终化器先于断言删树);typecheck/build/validate:plugin/diff 全 exit 0。未修改生产 windows-process-cleanup/process-spawn/manager 策略;未跑全矩阵或多余压力。生产 Windows 身份快照保守拒绝为独立既有问题,由 Codex 记债并限定验收说明。

## Codex 独立验收追加（2026-10-17）

本节由 Evaluator 在 attempt7 代码冻结后追加；只更新文档，未修改受测实现、测试或生产 bundle。此前 worker 自测和各轮失败仍按原时点保留。

| 独立完整回归 | 实际结果（每轮） |
| --- | --- |
| Windows x64 / Node 22.18.0，两轮 | 每轮398项：397通过、1跳过、0失败、0取消 |
| Windows x64 / Node 24.19.0 | 398项：396通过、2跳过、0失败、0取消 |
| Linux x64 / Node 22.18.0 | 399项：397通过、2跳过、0失败、0取消 |
| Linux x64 / Node 24.20.0 | 399项：396通过、3跳过、0失败、0取消 |

双方 typecheck/build/validate:plugin/clean-entrypoints 均通过。Windows 为独立目录与测试数据根，不是 OS 沙箱；Linux 在 /app、rootless、UID1000、断网、零宿主挂载、capabilities清零、no-new-privileges 条件下完成，运行时约束已检查。生成包的跨平台规范化指纹一致。

补充独立验证：39个根输入案例、真实6进程/900次临界区互斥与退出回收、锁错误/超时分支、迟到self/runtime identity、4种真实child清理状态、11种无信号归属输入均通过。新测试夹具只有在已知进程退出后才能删树；未确认状态保留现场。Windows Edge与Linux Chromium各完成16步打包链路，页面与服务端均确认单次提交；浏览器进程与本次监听端口关闭。该链路未使用真实模型账号调用。

跳过项按平台与Node版本保留：Windows不执行POSIX权限位断言；Linux跳过Windows专属启动/进程树语义；Node24跳过依赖Node22内部可注入路径的rm错误注入分支，保留其接线回归，Node22实际注入验证另存。没有把跳过视为已覆盖。

限定接收仍保留两类边界：维护者那一次历史teardown抖动的唯一根因未被证明；生产Windows树采样的旧ParentProcessId记录/身份拒绝是独立既有问题，本轮未放宽或修改生产策略。测试夹具的归属前置通过，不代表该生产问题已解决。macOS/ARM、其它app-server版本与真实模型账号链路不在本轮新增认证范围。

完整原始结果、早期失败、源指纹及最终资源清理回执由任务私有 evaluator 目录保留；本节不发布本机日志、会话标识或运行数据。源码交付未提交、推送、发布或安装。
