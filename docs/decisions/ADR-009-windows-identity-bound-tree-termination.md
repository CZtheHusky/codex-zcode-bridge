# ADR-009 Windows 进程树身份绑定归属与终止

> Status: DECISION
> Last updated: 2026-10-18
> Last verified: 2026-10-18（attempt-6 行为修复经 Codex 独立验收：六组 fake 探针 × Node 22.18.0/24.16.0 全过；完整平台矩阵 Windows 22.18.0/24.16.0 全量 509 项（508/507 pass、1/2 平台专有 skip）、Windows 24.19.0 受影响九套件 152/152、Linux 22.18.0/24.20.0 全量 511 项（508/507 pass、3/4 平台专有 skip）均 0 fail，typecheck/build/validate:plugin/clean-entrypoints 通过——Linux 首次聚合 bundle 比较失败为评估器符号链接致来源注释差异，实体依赖重建后字节一致、原失败保留；维护者机器特定失败未复现边界保持。attempt-7 仅注释/文档收尾，行为字节不变。详见[公开返修报告](../reports/2026-10-18-pr47-claimant-repair.md)；原始输出存任务私有归档）
> Verified against: 628984ca625a4d307b859d9f32d49e52e2d21ee6 + 本分支修复（含 review-round-1 R1–R4、review-round-1-addendum、review-round-2-callers C1 返工与 2026-10-18 PR #47 claimant/预算返修）

> 编号说明：公开基线 0902236c488adf7a3280dfdc38401dfa9f41cb49 的 `docs/decisions/` 只有 ADR-001..008；"ADR-009" 是本 PR 分支自选编号。维护者本地整合若已占用 009，最终编号由维护者在整合时协调重排，本文件不据未公开源码猜测。

## 背景

旧策略（ADR-005 时代实现）：PowerShell 按 `ParentProcessId` 闭包展开树并记录各成员 StartTime ticks，probe 核验后执行 `taskkill /PID <root> /T /F`。2026-10-17 只读回放与两轮集中评估确认的缺陷：

1. 旧无关记录入树：`Win32_Process` 文档明确 `ParentProcessId` 在 PID 复用后不可信，需结合 `CreationDate`；旧闭包只按父 PID 匹配。
2. 验证集与操作集解耦：`taskkill /T` 发信号时自行重展开；manager"先 probe 后仅传 PID"存在交接窗口；终止失败可被根退出证据解消。
3. 失败证据可被抹除：恢复路径、worker 晚到提交、连续失败、记录损坏/缺失/截断均可能清掉已知后代失败锁存（R1/R3 及补充）。
4. 未解析候选被当作可执行集合、传输无帧/总预算、helper 关闭回执不验证（R2/R4 及补充）。

## 决策

**身份绑定的归属与终止**：信号只经操作系统进程句柄发出，`taskkill /T` 完全移除；未知即保守失败，占用与失败证据单调保持。

### D1 归属：表示区间精确推理，零容差

- 单个持久 PowerShell helper 一次性枚举全表 `pid|ppid|CIM CreationDate.ToFileTimeUtc()|Get-Process StartTime.Ticks 或 unknown`；闭包在 TS 内确定性计算，行到达顺序不影响结果（父代未决的行保持 pending，杀序为真后序：每个成员先于自己的父被信号）。
- CIM `CreationDate` 在本机观测为微秒截断（真实创建时间位于闭区间 `[cim, cim+1µs]`，N=215，偏差 ∈(0,0.9µs)）。归属推理把 CIM 表示区间用于"子在父后/明显早于父"的判定与行-句柄同代一致性核对；**信号对象的身份绑定由同一持有句柄上的精确创建时间保证**，这是与 CIM 表示无关的最终依据。
- **活父边**：区间不重叠即证明"子在父后"；重叠时对双方当前持有句柄读精确创建时间（100ns），先核对精确值落在各自 CIM 区间（行-句柄同代一致），再比较：子严格晚于父成立；相等（同一 100ns）不可区分即拒绝。**早于父创建的行是旧无关记录，在打开句柄前按时间排除，不触碰无关进程**。
- **被我们终止的父**：同一句柄 `TerminateProcess` → `WaitForSingleObject` 确认 → 读内核退出 FILETIME。子精确创建时间落在 `[父精确创建, 父精确退出]` 闭区间内为可证明的子（该区间内 PID 归属独占）；早于父创建或晚于父确认退出为可证明排除。等待超时的父（无确认退出时间）→ `process_tree_parent_exit_unconfirmed` 保守失败。
- **自然退出的父**（无句柄、无退出时间）：其存活候选子不可证明归属 → 保守拒绝。
- **根**：Windows 终止必须携带调用者期望根指纹（持久化 executor identity 或 spawn 代捕获），逐位相符才展开；**根缺席且未被本事务杀死时一律 `process_tree_root_exited` 拒绝**（新事务无法证明死根之子的归属，不作"无候选即成功"的推断）；根换代即 `process_tree_root_identity_changed` 拒绝。无可信期望身份即 `process_tree_root_identity_required`，不建裸 PID 信任。

### D2 终止：句柄绑定与失败携带

- 每轮对每个已验证存活成员：`OpenProcess(QUERY_LIMITED|TERMINATE|SYNCHRONIZE)` → 句柄上 `GetProcessTimes` 与该成员 ticks 逐位比对 → `TerminateProcess` → 同句柄等待退出并读退出时间。句柄跨轮持有至最终扫描，持有期间该 PID 不可复用（官方句柄契约）。**验证与信号作用于同一句柄、同一进程对象：不存在"检查后 PID 换代被杀错"的窗口**——这是本设计的核心保障，不依赖任何时间差；后续轮次的枚举只用于收敛证明（发现动态后代/确认闭包为空），不是对错误信号的补救。
- **R2 语义**：hold 永久 denied、响应缺失/重复/意外、六轮预算耗尽、或候选在枚举与 hold 之间消失（`process_tree_candidate_absent`：其存活子代不可归属）都立即失败，错误携带全部已知成员 + 观察未验证候选 PID；不得把未证明完整的轮次当已验证清理，也不得漏掉存活孙代返回成功。
- **R3 语义（按实现的实际分支）**：所有异常出口（含传输/查询错误）都包装为携带完整已知成员集合的 `WindowsTreeCleanupError`。manager 端失败记录为结构化 `cleanup-failure.json`（member_pids + complete 标志），状态错误文本内嵌持久 `[cleanup-members: …]` 标记。读取分级：
  - meta 返回 null 或读取抛错，且 status 存在**完整** marker → marker 恢复的集合并入 claimant 扫描，允许正常释放；
  - meta 对象**存在**但 member_pids 字段缺失/无效/null → `#validMemberPids` 直接拒绝，**即使存在完整 marker 也不绕过**（"存在却缺字段"是损坏，不是丢失）；
  - marker 不完整（截断）或 `meta.complete === false`（部分集合标志）→ **持续拒绝，不承诺自动解除**：正常 cancel 不会把 partial 洗白，解除需要另外取得完整证据并修复记录（人工/上游介入后重新落盘完整记录）；
  - 集合与 incomplete 状态单调：任何后续失败把 prior marker 无条件并入，不得以新鲜子集洗白；
  - 无任何记录与 marker 的 legacy 终态锁存保留原根 probe 释放路径（既有行为）。
- **R4 语义（实际预算）**：单行 ≤ 1 MiB；缓冲流 ≤ 8 MiB 且 ≤ 65 536 行；单次枚举 ≤ 4 096 行；整个事务会话一个 120 s 总等待预算（每行等待取剩余额，过期后已缓冲的行也不再供出）。超过任一预算即明确失败（`process_tree_transport_overflow` / `process_tree_transport_session_timeout`），失败后停止接收并清空缓冲。关闭必须收到 `CLOSED <closed> <failed>`（failed==0，逐个 CloseHandle 成功被计数）且 helper 以退出码 0 自然退出；kill 回退可收敛进程但作为可见失败（`process_tree_close_forced`）报告，绝不当成功。helper 的进度记录在源头抑制（`$ProgressPreference='SilentlyContinue'`）；仍有 stderr 数据即按错误记录使传输失败，本地化文本永不外发。
- **持久摘要的实际边界**：status marker 在成员联串 ≤ 1 600 字符时完整保存，否则截断为前 200 项 + 省略号；结构化记录不受此限。成员超过该界的失败其 marker 必然不完整，按上述规则**保守占用**——这是有意的资源上限，不是静默数据丢失。

### D3 收敛与 manager 单调锁存

- 多轮：枚举→归属→（无存活成员即成功；否则逐个句柄绑定终止）→下一轮。动态后代经证明窗口同样被绑定终止；不可证明即保守失败。verified 只由"闭包内无存活成员"给出，根退出不构成证据。
- manager：终止调用携带期望根指纹；任何终止失败 → `CANCEL_FAILED` + `cleanup_unverified` 锁存 + 成员记录；**对已记录 tree-cleanup 失败（记录或完整 marker 存在）的任务，恢复路径（persistedResult/checkpoint/worker_lost/terminal probe）在锁存期间保持占用**；无记录无 marker 的 legacy 终态锁存仍由根 probe 释放。worker 终态提交（`TaskStore.commitWorkerResult`）可保存结果但不得清锁存或覆盖成员证据（无论 patch 清除、重申还是省略该字段）；释放只能由后续 cancel 经新鲜 probe + recorded-tree claimant 扫描门控完成。
- claimant 扫描的 `clean` 证明："**已记录 PID 名下没有存活的、属于我们或不可归属的 claimant**"——含指纹匹配的存活记录 PID 本身、其存活子代（传递闭包）、已死记录 PID 的存活子代（归属不可判定，保守计入）；枚举与 hold 之间消失的记录 PID 视为已死，其存活子代同样计入（PR #47 P1-A：不得以过期枚举 live 集合证明 clean）。已证外国换代的存活 PID 本身排除，但其后代**逐边持有证明**后才排除（review-round-1 R1）：每条边的父代必须被持有（同句柄精确创建时间，且与枚举行同代一致），子代 CIM 表示区间**严格晚于**该精确创建时间才可证明属于外来代，随后子代自身也必须被持有且行代一致，其更深后代再依其持有精确时间递归判定；相等精度（表示区间触界）、更早、跨界、创建时间未知，以及中间代 absent/denied/换代/行句柄矛盾，一律保持占用。hold 响应按请求逐一校验（数量、PID、ok 必含可用精确身份字段），畸形证据拒绝扫描而非证明 clean（review-round-1 R2）。观察证据持久化（review-round-2 S2）：扫描 false 或拒绝时，任务相关观察（原始记录目标——即使某目标当前代已证换代，目标 PID 本身仍保留供按记录身份复扫；claimant；请求过但未证实的外来谱系候选；不新增已证外来的后代候选，不采信响应载荷任意 PID）经既有 cleanup-failure 记录与 marker 单调并入，后续 cancel/恢复/Manager 重建后的 scanTargets 取并集；已观察过的中间代不属于"未观察祖先"免责边界。空闭包最终仍正常释放。外来换代父不排除任何未经此证明的后代（PR #47 P1-B："外来换代父排除整棵子树"不是成立保证）。多记录根的证据单调合并（review-round-2 S1，review-round-3 T1 收紧）：某 PID 相对根 A 的记录证明为外来换代，不抹除它相对根 B 的 claimant 路径——它是已死记录成员的存活子代、claimant 后代或不可归属谱系后代时，claimant 证据优先，占用保持；排除只适用于对全部记录根都无 claimant 路径的 PID。记录目标自身的外来判定须先通过行/句柄同代一致（ticks 相等且精确时间落在行表示区间内）才可用该行为换代作证，否则按归属未证明保持占用；已判外来的记录目标仍按同一严格边规则接受入边检验（创建不严格晚于外来父的持有精确时间即降级为 claimant），缓存句柄不是全局排除证书；严格更晚且行句柄一致时复用缓存证据不重复 hold。行/句柄代矛盾（ticks 不符或精确时间出表示区间）按归属未证明保持占用，不按协议畸形抛错；协议畸形（响应数量、PID 对应、ok 缺精确身份字段或非十进制格式）才抛 process_tree_hold_invalid 拒绝扫描（review-round-2 复核口径）。未观察到的中间祖先在任何证明之外，调用方须记录该边界而非宣称完整。
- 终止预算语义（PR #47 process-lock 返修）：kill 预算约束的是**等待退出**，不是已在持有句柄上证明的退出。截止时刻只对无确认退出 FILETIME 的成员触发 `process_tree_cleanup_unverified`；全部成员均已确认退出时继续确认轮直至闭包证明为空，整体仍受传输会话预算约束。已证明的机制：本机实测单次全表枚举 1.1–1.5s、两次枚举即占 5s 预算约六成，旧代码在枚举耗时或 WMI 滞留已终止成员行时会对"已确认退出"的成员误报 not provably exited（确定性回归覆盖）；维护者 24.16.0 失败在本机未复现，不做版本或根治宣称。

### D4 调用链身份交接（每代状态）

- adapter（生产 app-server、legacy CLI、model-settings）在 spawn 后经共享 `captureSpawnGenerationIdentity` 采集本代身份。连续性判定依据：**libuv 在同步交付 Node 'exit' 回调之前释放子进程原生句柄；Node 在该回调内设置 exitCode/signalCode；JS continuation 无法插入两者之间**。因此"exitCode/signalCode 均为 null"蕴含"进程仍存活或 libuv 仍持有句柄"，两种状态下 PID 都不可复用——这是可证明的代连续性。close 旗标晚于 exit，不构成句柄持有证明。每次 await 后复核原对象；仅接受 exact 精度；返回时 pid 一致性复核；退出竞态的指纹一律丢弃。Windows 终止前复核仍在原代；已 exit 的子进程永不再信号。
- 重试复用 RunEntry 时，childClosed/childIdentity 等每 spawn 字段按代重置；上一代迟到的身份捕获不得覆盖当代（review-round-2 C1）。
- POSIX 保持既有进程组身份/信号语义不变（Windows 专项）。

## 依据（均已核对）

- [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)：PID 复用与 CreationDate 对父子关系的作用。
- [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)：/T 自行展开子树（本设计弃用）。
- [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)：按句柄定位进程对象。
- [PROCESS_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information) 与 [Process Handles and Identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers)：PID 在所有句柄关闭且对象释放后才可复用；句柄在进程退出后仍有效——持有句柄阻断复用是本设计窗口归属的依据。
- libuv `src/win/process.c`（v1.x）：`uv__process_proc_exit` 先 `CloseHandle(process_handle)` 再触发 exit 回调；Node 在 exit 回调内设置 exitCode/signalCode（[child_process 事件顺序](https://nodejs.org/api/child_process.html)）。

## 残余边界（披露，不宣称解决）

- 身份不是同账户恶意进程认证（沿承 process-probe 边界）。
- claimant 扫描只覆盖已记录 PID 及其当前存活 claimant；未观察中间祖先不可证明。
- spawn 后、身份采集完成前子进程退出且 PID 被复用的窗口：capture 在 exit 状态复核处丢弃该指纹，Windows 终止随后拒绝（缺身份 fail-closed）；这保证不会杀错对象，但不构成对 spawn 代连续性的正面证明（完全消除需 spawn 时刻持有原生句柄，超出本轮无新依赖边界）。
- 传输/枚举预算是有界的资源上限：进程表超过 4 096 行、成员联串超过 1 600 字符（截断为部分集）或会话超预算时按明确失败/保守占用处理（保守方向）。
- 本机 CIM 截断观测与句柄换算核验仅在 Windows 11 10.0.26200 / PowerShell 5.1 上进行；其他 Windows/CIM 实现未经观测，**不能宣称同等的归属保证**——同一句柄的精确时间仍是信号对象身份绑定的不变保障。

## 可重跑验证（本轮实际结果；命令在源码仓库执行，原始输出存私有证据归档 worker/attempt-2/logs/）

- `node --test dist-test/test/{windows-process-cleanup,windows-cleanup-review-regressions,windows-transport-bounds,manager-recovery-latch,spawn-generation-identity,audit-remediation,legacy-retry-generation}.test.js`：94/94。
- `node --test dist-test/test/process-spawn.test.js`（有界真实 fixture：正向身份绑定终止、错误指纹拒绝且零信号、缺身份拒绝、独立收束）：4/4。
- Codex 反例脚本（存私有证据归档 evaluator/，新 attempt id 可重跑）：9 个脚本 / 10 个运行用例全部 ok——recovery-latch-probe（recover 与 corrupt-meta 两模式）、adversarial-cleanup、absent-candidate、missing-members、truncated-members、repeated-failure、repeated-truncated、worker-commit-latch、legacy-retry。
- 全量：Windows Node 22.18.0 `node scripts/test-isolated.mjs` 461 项 460 pass/1 skip；Node 24.19.0 同命令 459 pass/2 skip；`npm run typecheck`、`npm run build`、`npm run validate:plugin`、`git diff --check` 均 exit 0。

## PR #47 返修补充验证 — attempt-1（2026-10-18 源码版本；原始输出存任务私有归档 attempt-1/，下列计数属该版源码，勿与 attempt-2 计数叠加）

- 维护者原始两 fake 反例（absent-after-enumeration、reused-parent-old-child）在反馈 head 记录 RED（clean=true 缺陷复现，exit 1），修复后同脚本 GREEN（clean=false、livePids=[102]，exit 0），零信号。
- `node --test dist-test/test/windows-process-cleanup.test.js`：44/44（含 P1-A/P1-B 及组合矩阵、边界零容差、预算语义回归）。
- `node --test dist-test/test/manager-claimant-gate.test.js`：3/3——真实 TaskManager 消费路径（cancel→probe→锁存→扫描门控→pump），fake 只作 OS 传输；false/reject 保持 `cleanup_unverified`、同目录后续任务不放行，可证明 clean 正常释放。
- 受影响套件 `node --test dist-test/test/{windows-process-cleanup,windows-cleanup-review-regressions,manager-recovery-latch,manager-claimant-gate,task-manager}.test.js`：93/93；`process-lock` 全量 19/19。
- 便携 Node 24.16.0（官方 SHASUMS256 校验）下两 process-lock 用例 2/2（修复前后各一次）；阶段计时探针（自建登记进程、信号前成员身份门禁）：24.16.0 与 24.19.0 各 8/8，terminate 全程 2.8–3.3s / 预算 5s，单次全表枚举 1.1–1.5s；维护者失败未在本机自然复现，边界如实记录。
- 预算机制 RED→GREEN：head 驱动对"已确认退出成员的滞留行 + 截止超时"抛 `process_tree_cleanup_unverified`（缺陷复现），修复后 3 轮完成闭包证明。

## PR #47 返修补充验证 — attempt-2 / review-round-1 R1–R4（2026-10-18 源码版本；以下均为 worker 自测，原始输出存任务私有归档 attempt-2/；本轮源码全量 492/490 pass/2 skip，受影响七套件 128/128，typecheck/build/validate:plugin/clean-entrypoints/git diff --check exit 0）

- evaluator 契约探针（10 例，含 6 个 R1/R2 失败反例与 2 个正向对照）经 worker 在 Node 22.18.0 / 24.16.0 / 24.19.0 各 10/10 通过，零信号、helper 各关闭一次。
- `node --test dist-test/test/windows-process-cleanup.test.js`（attempt-2 源码）：53/53——新增中间代 absent/denied/换代/行句柄矛盾保持占用、相等精度不判外来、被排除成员必须被持有且行代一致、R2 形状违规（错 PID、超量、缺精确字段、非数字时间）拒绝扫描。
- `node --test dist-test/test/manager-claimant-gate.test.js`（attempt-2 源码）：4/4——P1-A 经指纹化记录根真正触发 absent hold（断言 hold 发生）；maxConcurrency=1 且不同执行目录验证 slot 保留；reject/畸形 hold 同路径保持占用；可证明 clean 释放并放行排队任务。
- baseline-loader 复验：同一 Manager 测试在原缺陷扫描器（head 转译）下 4/4 全部 "Missing expected rejection" RED——包括 review-round-1 指出原先误 PASS 的 P1-A。
- R1/R2 未改变终止驱动与预算语义；attempt-1 的预算机制独立复验（6 例）与 24.16.0 未复现边界继续有效，不重复执行真实阶段探针。

## PR #47 返修补充验证 — attempt-3 / review-round-2 S1/S2（2026-10-18 源码版本；以下均为 worker 自测，原始输出存任务私有归档 attempt-3/）

- evaluator `probe-recorded-roots.mjs`（只读复用）S1 四例 × Node 24.19.0/24.16.0/22.18.0：跨根 claimant（含目标序反转、孙代传播）保持占用，全外来正向释放。
- evaluator `probe-manager-observed-history.mjs`（只读复用，新编译 dist-test）S2 两模式（正负检查）× 同三版本全过：false 与拒绝两路径均持久化观察，第二次 scanTargets 含并入 PID，task_2 保持 queued，空表后正常释放且 task_2 转 running。
- 单元 `windows-process-cleanup` 59/59（新增 S1 四例与 S2 观察证据两例）；Manager 门禁 `manager-claimant-gate` 7/7（新增 S1 跨根、S2 false 持久化、S2 拒绝持久化），baseline-loader 复验原扫描器下 6/7 RED（S2-false 模式由 Manager 侧 livePids 兜底在旧扫描器下亦过；该模式旧候选 RED 由评估方 round2 探针证明）。
- 受影响十套件 175 tests/174 pass/0 fail/1 skip；全量 501 tests/499 pass/0 fail/2 skip；typecheck/build/validate:plugin/clean-entrypoints(4/4)/git diff --check exit 0。前轮计数见 attempt-1/attempt-2 节，按版本分开不叠加。

## PR #47 返修补充验证 — attempt-6 / review-round-3 T1（2026-10-18 源码版本；以下均为 worker 自测，原始输出存任务私有归档 attempt-6/；attempt-4/5 为 provider 额度中断，无实现产出，失败由调用方记录保留）

- evaluator `probe-recorded-foreign-edges.mjs`（只读复用）5/5 × Node 22.18.0/24.16.0：修复前当前源码记录 RED（4 负例 clean:true、1 正例过），修复后同探针 GREEN。
- evaluator `probe-root-row-generation.mjs`（只读复用）3/3 × 同两版本：修复前两处行/句柄代不一致误 clean，修复后占用保持；行句柄一致正例仍 clean。
- 既有证据复验（修复后源码）：`probe-claimant-contract` 10/10 × Node 22.18.0/24.16.0/24.19.0；`probe-recorded-roots` 4/4 × 同三版本；`probe-manager-observed-history` 两模式 × Node 22.18.0/24.16.0。
- 单元 `windows-process-cleanup` 67/67（新增 T1 八例：换代记录父子更早/等时/孙代传播/顺序反转/严格更晚正例、行句柄代不一致两形态与一致正例）；受影响九套件 116 tests/115 pass/0 fail/1 skip；全量 509 tests/507 pass/0 fail/2 skip；typecheck/build/validate:plugin/clean-entrypoints(4/4)/git diff --check exit 0（EOF 空白一次告警最小修复后 run2 exit 0，未重跑套件）。

## 最终独立验收（2026-10-18，Codex 于冻结候选执行；本节为公开摘要，原始证据存任务私有归档）

- 六组 fake 探针 × Node 22.18.0/24.16.0 全过（含正向释放对照，零真实信号）：契约 10、已死父跨根 4、记录外来边 5、根行代 3、观察历史 2 模式、真实 Manager 重建 2 模式。
- 平台矩阵（测试/通过/跳过，均 0 fail；平台专有 skip 如实记录）：Windows 22.18.0 全量 509/508/1；Windows 24.16.0 全量 509/507/2；Windows 24.19.0 受影响九套件 152/152/0；Linux 22.18.0 全量 511/508/3；Linux 24.20.0 全量 511/507/4。typecheck/build/validate:plugin/clean-entrypoints(4/4) 通过；git diff --check 于 Windows 工作区通过。Linux 首次聚合 bundle 比较失败保留：评估器符号链接使 bundle 来源注释指向 ../deps 源路径，注释前缀归一化后无其他字节差异，实体依赖重建后与原始 bundle 字节一致并 validate 通过（未重跑全套）。
- attempt-7 仅按 review-round-6 完成注释/文档/记录措辞修正，源码行为与 bundle 字节不变。

## 影响

- 修改 `src/adapters/windows-process-cleanup.ts`（重写：区间归属、句柄事务、传输预算）、`src/adapters/process-spawn.ts`（期望根指纹、代连续性 helper、claimant 扫描）、`src/adapters/zcode-app-server-adapter.ts`、`src/adapters/zcode-adapter.ts`（每代重置）、`src/runtime/model-settings.ts`、`src/manager/task-manager.ts`（单调锁存、扫描门控）、`src/store/task-store.ts`（commitWorkerResult 锁存保留）及测试；`docs/ARCHITECTURE.md` Windows 清理段随本决策更新。
- 公共 MCP 工具名/schema、任务状态语义、隐私边界、npm/native 运行时依赖不变；错误为 ASCII 稳定诊断码。
- 取代旧"采样后 taskkill /T"语义；ADR-005 的 unknown-不当退出、占用保留原则不变。
