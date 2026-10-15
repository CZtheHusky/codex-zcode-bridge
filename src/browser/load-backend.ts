// Default browser backend loader for the Bridge browser host.
//
// Production layout (plugin install): the worker ESM bundle sits next to a
// vendor directory containing browser-host.cjs — a self-contained CommonJS
// bundle of the managed CDP runtime with playwright-core (pinned 1.64.0) and
// the two registry data files playwright-core resolves relative to that
// directory. The loader imports it relative to its own module URL, so the
// plugin never depends on Codex's node_modules or any development path.
//
// Development/core layout: when no vendor bundle exists (tsc output, tests),
// fall back to the compiled managed CDP runtime module, which resolves
// playwright-core from this repository's node_modules.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserControlPort } from "./contracts.js";

export interface BackendModule {
  createManagedCdpBrowserRuntime: (options: {
    env?: NodeJS.ProcessEnv;
    executablePath?: string;
    closeTimeoutMs?: number;
  }) => { browserControlPort: BrowserControlPort; close(): Promise<void> };
}

/** 非静态 specifier 拼接，防止打包器在构建期内联开发回退路径。 */
function devRuntimeSpecifier(): string {
  return ["./runtime", "js"].join(".");
}

function asBackendModule(imported: Record<string, unknown>, label: string): BackendModule {
  // The vendored CJS bundle surfaces its default export behind an extra
  // interop wrapper (namespace.default.default), while the dev-path ESM
  // module exposes a plain named export. Unwrap bounded layers and accept
  // whichever level actually carries the factory.
  let candidate: unknown = imported;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate && typeof candidate === "object"
      && typeof (candidate as Partial<BackendModule>).createManagedCdpBrowserRuntime === "function") {
      return candidate as BackendModule;
    }
    candidate = (candidate as { default?: unknown } | null)?.default;
    if (candidate === undefined) break;
  }
  throw new Error(`${label} does not export createManagedCdpBrowserRuntime`);
}

export async function loadBackendModule(): Promise<BackendModule> {
  // new URL(".", import.meta.url) already yields the module directory; taking
  // dirname of it again would resolve the vendor layout one level too high.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // The vendored bundle sits in vendor/pkg/ so playwright-core's registry
  // data (vendor/browsers.json, vendor/package.json) resolves correctly one
  // level above the bundle directory.
  const vendorEntry = path.join(moduleDir, "vendor", "pkg", "browser-host.cjs");
  if (existsSync(vendorEntry)) {
    return asBackendModule(
      await import(pathToFileURL(vendorEntry).href) as Record<string, unknown>,
      "Vendor browser backend bundle",
    );
  }
  return asBackendModule(
    await import(devRuntimeSpecifier()) as Record<string, unknown>,
    "Managed CDP runtime module",
  );
}

/**
 * 惰性默认 backend 工厂：首次浏览器 RPC 时才加载模块并创建 runtime。
 * 任何一步失败都会作为该次请求的错误返回，不影响任务本身。
 */
export function createDefaultBrowserBackendFactory(options: {
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
}): () => Promise<BrowserControlPort> {
  return async () => {
    const module = await loadBackendModule();
    const runtime = module.createManagedCdpBrowserRuntime({
      env: options.env,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    return runtime.browserControlPort;
  };
}
