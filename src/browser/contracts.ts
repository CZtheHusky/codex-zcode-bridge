// Adapted with modifications from the public ZCode source at commit
// aac4755666d09fdcd70272fcf063c077a639015f (Apache-2.0):
//   apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts
// Bridge modifications:
// - types come from the locally vendored schema modules instead of
//   @zcode/shared (single-package layout, no zod v3/v4 cross-coupling);
// - TraceContext is dropped: the Bridge host does not propagate tracing;
// - forChildSession is not implemented: the Bridge host binds every request
//   to the single active task session and has no registered child sessions,
//   so the upstream "absent means no client-session validation" escape hatch
//   is intentionally not taken.
import type { BrowserBackendDescriptor } from "./backend.js";
import type { BrowserCommand } from "./commands.js";
import type { BrowserCommandResult } from "./result.js";

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  signal?: AbortSignal;
}

export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  signal?: AbortSignal;
}

export interface BrowserControlPort {
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
  /**
   * Bridge modification: whole-backend bounded teardown for the end of a task
   * attempt. Throws when a graceful browser close cannot be verified so the
   * host can report unverified cleanup honestly.
   */
  close?(): Promise<void>;
}
