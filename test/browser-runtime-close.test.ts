import assert from "node:assert/strict";
import test from "node:test";
import { createManagedCdpBrowserRuntime } from "../src/browser/runtime.js";
import type { PlaywrightChromiumModule } from "../src/browser/executable.js";

// R2 targeted regression: deterministic, fake-playwright coverage of the
// managed runtime's close verdicts. No real browser is launched.

interface FakeBrowser {
  connected: boolean;
  closeShouldReject: boolean;
  closeCalls: number;
  isConnected(): boolean;
  close(): Promise<void>;
  on(): void;
}

function makeFakeBrowser(): FakeBrowser {
  const browser: FakeBrowser = {
    connected: true,
    closeShouldReject: false,
    closeCalls: 0,
    isConnected: () => browser.connected,
    close: () => {
      browser.closeCalls += 1;
      if (browser.closeShouldReject) return Promise.reject(new Error("fake browser close rejected"));
      browser.connected = false;
      return Promise.resolve();
    },
    on: () => undefined,
  };
  return browser;
}

function fakePlaywright(launch: () => Promise<FakeBrowser>): PlaywrightChromiumModule {
  return {
    chromium: {
      // Point resolution at an existing file (the current Node executable);
      // the actual launch below is faked, so nothing real is spawned.
      executablePath: () => process.execPath,
      launch: async () => launch(),
    },
  } as unknown as PlaywrightChromiumModule;
}

test("a browser close that rejects while still connected is reported unverified", async () => {
  const browser = makeFakeBrowser();
  browser.closeShouldReject = true;
  const runtime = createManagedCdpBrowserRuntime({
    loadPlaywright: async () => fakePlaywright(async () => browser),
    closeTimeoutMs: 200,
  });
  await runtime.browserControlPort.list({ sessionId: "late-1" });
  await assert.rejects(() => runtime.close(), /could not be verified/u);
  assert.ok(browser.isConnected(), "the fake browser stays connected; success must not be claimed");
});

test("a close that never settles stays bounded and unverified", async () => {
  const browser = makeFakeBrowser();
  browser.close = () => new Promise(() => undefined);
  const runtime = createManagedCdpBrowserRuntime({
    loadPlaywright: async () => fakePlaywright(async () => browser),
    closeTimeoutMs: 200,
  });
  await runtime.browserControlPort.list({ sessionId: "late-2" });
  await assert.rejects(() => runtime.close(), /could not be verified/u);
});

test("a late launch landing after close still recycles and reports its true verdict", async () => {
  let resolveLaunch: ((browser: FakeBrowser) => void) | null = null;
  const browser = makeFakeBrowser();
  browser.closeShouldReject = true;
  const runtime = createManagedCdpBrowserRuntime({
    loadPlaywright: async () => fakePlaywright(() => new Promise<FakeBrowser>((resolve) => {
      resolveLaunch = resolve;
    })),
    closeTimeoutMs: 2_000,
  });
  const listPromise = runtime.browserControlPort.list({ sessionId: "late-3" }).catch((error: unknown) => error);
  // Let the launch promise exist before closing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closePromise = runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  resolveLaunch!(browser);
  await assert.rejects(() => closePromise, /could not be verified/u);
  const listOutcome = await listPromise;
  assert.ok(listOutcome instanceof Error || typeof listOutcome === "object");
  assert.ok(browser.closeCalls >= 1, "the late-launched browser must still be recycled");
  assert.ok(browser.isConnected(), "the fake browser remains connected; the verdict must stay failed");
});

test("a clean browser close resolves close without throwing", async () => {
  const browser = makeFakeBrowser();
  const runtime = createManagedCdpBrowserRuntime({
    loadPlaywright: async () => fakePlaywright(async () => browser),
    closeTimeoutMs: 500,
  });
  await runtime.browserControlPort.list({ sessionId: "late-4" });
  await runtime.close();
  assert.equal(browser.isConnected(), false);
});
