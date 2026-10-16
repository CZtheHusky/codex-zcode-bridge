// Adapted from the public ZCode source at commit
// aac4755666d09fdcd70272fcf063c077a639015f (Apache-2.0):
//   apps/zcode-cli/packages/adapters/src/browser/<file>
// Bridge modifications are annotated in place and limited to module boundaries
// (local schema/contract modules instead of @zcode/contracts) plus the changes
// required by the Bridge host lifecycle documented in ADR-007.
import type { BrowserCommand } from "./commands.js";
import type { BrowserErrorCode } from "./command-metadata.js";

export function abortError(): Error {
  return new DOMException("Browser command cancelled", "AbortError");
}

export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function hasSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return ["click", "dblclick", "fill", "press", "selectOption", "setChecked"].includes(
      command.action.operation,
    );
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "handleDialog",
    "close",
    "newTab",
    "evaluate",
  ].includes(command.method);
}

export function classifyError(error: unknown): BrowserErrorCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /unavailable|closed|disconnected/iu.test(error.message)) {
    return "backend_unavailable";
  }
  return "execution_error";
}
