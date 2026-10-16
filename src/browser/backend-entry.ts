// Entry point for the vendored CommonJS browser backend bundle
// (worker/vendor/browser-host.cjs). The worker ESM bundle loads this through
// src/browser/load-backend.ts; keeping it a separate entry lets the managed
// CDP runtime and its pinned playwright-core dependency ship as one
// self-contained artifact instead of being inlined into the ESM worker,
// where playwright-core's CommonJS runtime assumptions do not hold.
import { createManagedCdpBrowserRuntime } from "./runtime.js";
import type { BrowserControlPort } from "./contracts.js";

export type { BrowserControlPort } from "./contracts.js";

export default {
  createManagedCdpBrowserRuntime: createManagedCdpBrowserRuntime as (options: {
    env?: NodeJS.ProcessEnv;
    executablePath?: string;
    closeTimeoutMs?: number;
  }) => { browserControlPort: BrowserControlPort; close(): Promise<void> },
};
