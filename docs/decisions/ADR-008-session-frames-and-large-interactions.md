# ADR-008：恢复会话协议帧与大审批输入

> Status: DECISION / Implemented proposal for maintainer review
> Date: 2026-10-15

## Context

在1.2.3修复前，一份真实会话恢复响应为2,139,927 UTF-8 bytes / 2,039,924 JavaScript字符，运行时470ms即返回，但Bridge最终报30秒resume超时。适配器把2,000,000字符的文本捕获上限用于整个stdout缓冲，越限只拒绝turn等待，没有拒绝pending RPC。另一个问题是审批params保存上限32,000 bytes，单条事件上限64,000 bytes；大Write输入无法送达审批，失败被通用拒绝掩盖。

## Decision

- 模型文本捕获仍为2,000,000字符并显式标记截断；传输按换行逐帧消费，原始未trim帧上限16MiB UTF-8 bytes。分片和合包不能改变边界语义。
- 非法JSON、非对象帧或越限帧锁存首个致命原因，立即拒绝pending RPC与turn，停止缓冲并阻止后续请求。保留原30秒RPC预算，不通过增加超时掩盖错误。
- sanitized params完整私有保存至1MiB，以`JSON.stringify(params)`的UTF-8紧凑序列化计量；保存字节数与SHA256。重复ID比较完整输入。
- 小事件保持兼容字段；大事件使用`preview: true`及同任务/attempt完整记录引用。64,000-byte事件行上限不变，预览不能作为完整审批内容。
- allow/accept在interaction锁内验证完整性再落盘；仅完全无新元数据且不超过旧32,000-byte上限的记录兼容旧格式。worker消费回答前再比较原始请求，损坏、丢失或被修改时明确拒绝。
- 超限、持久化或发布失败给出明确原因和适用的拆分建议，不留悬挂审批。哈希不构成对同OS账户恶意修改的隔离。
- 不更改MCP工具schema、审批模式、provider配置、任务状态与清理语义。

## Rationale and consequences

大响应接收与文本捕获是不同资源边界；完整私有审批记录与有界公开展示也需要分别处理。内存和磁盘用量仍有上限，失败可以定位。新记录增加可选元数据字段，旧的小请求保持兼容。

## Validation

回归覆盖合法大resume、分片/合包/UTF-8、坏帧后不再发请求、原始空白超限、40KiB与80KiB审批、1MiB拒绝、日志容量、冲突ID和损坏/缺失/修改记录。1.2.3修复版本已实测旧会话恢复及打包MCP单次43,014-byte Write；当前1.2.4整合分支单独验证，详见[审查说明](../reports/2026-10-15-browser-and-transport-fixes.md)。

Node.js官方[stream data事件](https://nodejs.org/api/stream.html#event-data)与[Buffer.byteLength](https://nodejs.org/api/buffer.html#static-method-bufferbytelengthstring-encoding)用于分块和字节计量。ZCode协议仅按观测Agent 0.16.9适配，不声明跨版本或完整桌面功能保证。
