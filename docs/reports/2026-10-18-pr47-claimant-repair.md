# PR #47 Claimant 扫描返修报告（2026-10-18）

> Status: REPORT（一次性交付材料；验证结论以 ADR-009 与 PROJECT_STATE 的核对记录为准）
> 范围：PR #47 反馈 head `628984c` 上的两项 P1 修复、真实 process-lock 失败调查、组合与真实 Manager 门禁回归；含集中评估 review-round-1 R1–R4 返工。原始日志与脚本存任务私有证据归档（本仓库外），本报告只保留可公开摘要。

## 修复内容

1. **P1-A（枚举后消失）**：`verifyWindowsRecordedTreeClaimants` 中，记录 PID 在枚举与 hold 之间消失时按已死处理（从 live 集合移除），其存活子代经已死记录 PID 路径计入 claimant；不再以过期枚举快照证明 clean。
2. **P1-B（换代父与旧子）**：撤回"外来换代父排除整棵子树"的不成立保证。现行为逐边持有证明：每条边的父代必须被持有句柄核验（同句柄精确创建时间、与枚举行同代一致），子代创建表示区间**严格晚于**该精确创建时间才可判属外来代；随后子代自身也必须被持有且行代一致，更深后代递归同判。相等精度（ADR-009 同 100ns 规则同样适用于排除方向）、更早、跨界、创建时间未知，以及中间代消失/拒绝/换代/行句柄矛盾，一律保持占用。正向 clean 场景（空记录树；可证明新代链）保留。
3. **hold 响应校验（review-round-1 R2，口径修正于 review-round-2）**：扫描对每次单 PID hold 校验响应数量、PID 对应关系与 ok 响应的精确身份字段（十进制、非空）。协议畸形（数量/PID 不符、字段缺失或非法格式）抛 `process_tree_hold_invalid` 拒绝扫描；行与句柄的代矛盾（ticks 不符或精确时间落在表示区间外）属归属未证明，保持占用而非抛错——两类出口都不用于证明 foreign/clean；helper 仍恰好在所有出口关闭一次。
4. **终止预算语义**：kill 截止只对无句柄确认退出 FILETIME 的成员触发 `process_tree_cleanup_unverified`；全部成员已确认退出时继续闭包确认轮直至枚举证明为空（受 120 s 传输会话预算约束）。修复"全表枚举耗时 + WMI 滞留已终止成员行"时对已证明退出成员的误报（与本轮实测机制一致：单次全表枚举约 1.1–1.5 s，两轮枚举占 5 s 预算约六成）。

5. **多记录根单调合并（review-round-2 S1）**：某 PID 相对一个记录根证明为外来换代，不抹除它相对另一记录根的 claimant 证据（如已死记录成员的存活子代复用了另一记录 PID）；claimant 路径优先于外来排除，对全部记录根均无 claimant 路径时才排除。目标/行序不敏感，全外来正向仍释放。
6. **观察证据持久化（review-round-2 S2）**：扫描返回 false 或拒绝时，任务相关观察——原始记录目标（即使某目标的当前代已证换代，目标 PID 本身仍保留，供后续按记录身份复扫）、claimant、请求过但未证实的外来谱系候选（不新增已证外来的后代候选，不采信响应载荷任意 PID）——经既有 cleanup-failure 记录与状态 marker 单调持久化；后续 cancel、恢复与 Manager 重建后的 scanTargets 取并集，已观察过的中间代不属"未观察祖先"边界；全部相关 PID 真正消失后正常释放。

7. **记录目标的统一边证明（review-round-3 T1）**：记录 PID 的换代判定须先通过行/句柄同代一致（ticks 相等且精确时间落在行表示区间）才可用该行为换代作证，否则保持占用；已判外来的记录目标仍按同一严格规则接受入边检验（创建不严格晚于外来父的持有精确时间即降级 claimant，孙代随之传播），缓存的外来状态不是全局排除证书；严格更晚且一致的正例复用缓存证据、不重复 hold，正向外来代释放保持。

## 维护者 process-lock 失败的排查边界

在官方校验的便携 Node 24.16.0（SHASUMS256 核对通过）与新编译输出下，两项 process-lock 用例修复前后均 2/2 通过，失败未自然复现；带登记与信号前成员身份门禁的阶段计时探针（自建 node 子进程与其 conhost，无信号观察取证确认成员构成）在 24.16.0 与 24.19.0 各 8/8。结论：已证明的误报机制已修复并有确定性回归，但不宣称对维护者机器特定失败的根治或版本归因。

## 验证摘要（worker 自测；Codex 独立复验与平台矩阵另行执行）

- 维护者原始两 fake 反例：反馈 head RED（clean=true 缺陷复现）→ 修复后 GREEN（clean=false、livePids=[102]、零信号）。
- evaluator 契约探针（10 例：两个原始反例、相等精度、中间代 absent/换代/denied、错 PID hold、缺精确字段、两个正向对照）：Node 22.18.0 / 24.16.0 / 24.19.0 各 10/10。
- `windows-process-cleanup` 专项（attempt-2 源码）53/53：P1 组合矩阵（消失/换代+旧子/可证明新子/混合/多层/同精度/未知时间/缺 hold/身份读取失败）+ R1/R2 新增回归 + 预算两态。
- `manager-claimant-gate`（attempt-2 源码）4/4：真实 TaskManager 消费路径（cancel→新鲜 probe→锁存→扫描门控→pump），fake 仅作 OS 传输；P1-A 经指纹化记录根真正触发 absent hold（断言 hold 发生）；maxConcurrency=1 且不同执行目录验证 slot 保留；扫描 false/reject/畸形 hold 保持 `cleanup_unverified` 与占用；可证明 clean 正常释放并放行排队任务。
- baseline 对照：同一 Manager 测试在反馈 head 的原扫描器（转译加载）下 4/4 全部 "Missing expected rejection"——包括 review-round-1 指出原先误 PASS 的 P1-A 用例。
- 预算机制独立复验（6 例，attempt-1）：基线误拒已确认退出、候选完成第三轮空闭包、未确认退出仍拒绝、会话预算拒绝保留成员集合。
- 全量套件与 typecheck/build/validate:plugin/clean-entrypoints/git diff --check 的最终计数以 PROJECT_STATE 核对记录为准（按源码版本分别记录，不跨版本叠加）。

## 最终验证（Codex 独立平台矩阵，冻结候选上执行）

| 平台/运行时 | 范围 | 测试 | 通过 | 失败/取消 | 跳过 |
|---|---|---:|---:|---:|---:|
| Windows 22.18.0 | 全量 | 509 | 508 | 0/0 | 1 |
| Windows 24.16.0 | 全量 | 509 | 507 | 0/0 | 2 |
| Windows 24.19.0 | 受影响九套件 | 152 | 152 | 0/0 | 0 |
| Linux 22.18.0 | 全量 | 511 | 508 | 0/0 | 3 |
| Linux 24.20.0 | 全量 | 511 | 507 | 0/0 | 4 |

- 独立探针（fake 传输、零真实信号）于 Node 22.18.0 与 24.16.0 各六组全过：契约 10 例、已死父跨根 4 例、记录外来边 5 例、根行代 3 例、观察历史 2 模式、真实 Manager 重建 2 模式；各含正向释放对照。
- 前述各平台检查（typecheck、全量/受影响套件、build、validate:plugin、clean-entrypoints 4/4）均通过，源码在验证期间未变；git diff --check 在 Windows 源码工作区通过（Linux tar 验收未运行 git diff）。Linux 首次聚合比较失败被保留：评估器 node_modules 符号链接使两 bundle 内来源注释指向 ../deps 源路径；经精确注释前缀归一化证明无其他字节差异，并在两运行时以实体依赖目录重建后 bundle 与原始字节一致、validate 通过（仅重建复检，未重跑全套）。
- 跳过项如实记录不作通过论：Windows 的 POSIX 模式用例；Node24 专有 injected-ENOTEMPTY 按既有测试条件跳过；Linux 的 Windows startup hook 与两个 Windows 专有进程树子测试。各平台测试总数差异源于平台子测试分别计数。
- 以上为 Codex 独立结果；worker 自测（Windows 24.19.0 会话全量 509/507/2 等）见各 attempt 记录，二者不混计。Windows 为目录隔离非 OS 沙箱；Linux 隔离为 rootless、非 root、仅回环网络、capEff 0、noNewPrivs 1、无宿主挂载。

## 未覆盖与边界

- 维护者机器特定失败未在本机自然复现（见上）。
- 组合矩阵为 fake 事务覆盖；真实进程路径限于自建登记 fixture（node 子进程与其 conhost）。
- 观察历史：早期一次探针存在 close 监听晚挂的观察缺陷、另一次缺少信号前成员名记录，均保留为历史且不并入门禁化后的结论；后续成员构成（node + conhost）由无信号自然退出 fixture 单独取证。
- 未观察中间祖先仍在任何证明之外；ADR-009 为本 PR 分支自选编号，整合期重编号由维护者协调。
