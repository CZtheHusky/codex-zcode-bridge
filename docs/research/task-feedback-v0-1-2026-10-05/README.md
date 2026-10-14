# Task Feedback v0.1 输入（2026-10-05）

> Status: RESEARCH
> Date: 2026-10-05
> 研究结论，不代表当前实现。观测版本 ZCode CLI 0.16.9。

本目录是 Task Feedback v0.1 实施任务的输入材料：一次真实 app-server 探针，以及由它派生的两份建议。实现结果见 [Task Feedback v0.1 实施报告](../../reports/task-feedback-v0-1-implementation-2026-10-06.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md](ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md) | 真实 runtime 探针：环境、事件类型、能力与隐私边界 |
| [TASK_FEEDBACK_SCHEMA_RECOMMENDATION.md](TASK_FEEDBACK_SCHEMA_RECOMMENDATION.md) | 快照 schema 建议：冻结核心信封，未观测字段保持可空 |
| [NATIVE_FEEDBACK_RENDERER_RECOMMENDATION.md](NATIVE_FEEDBACK_RENDERER_RECOMMENDATION.md) | 原生文本渲染建议：什么可以显示、什么不能 |
| [evidence/run-001-summary.json](evidence/run-001-summary.json) | 探针的安全摘要（4 KB） |

## 适用范围

探针结论只适用于记录的本机版本与实验范围。建议里标注为不支持或未观测的部分，在实现中保持 `null` 或不渲染。
