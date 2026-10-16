import assert from "node:assert/strict";
import test from "node:test";
import { browserListParamsSchema, browserExecuteParamsSchema } from "../src/browser/params.js";
import { browserCommandSchema } from "../src/browser/commands.js";
import { browserBackendDescriptorSchema } from "../src/browser/backend.js";
import { browserCommandResultSchema } from "../src/browser/result.js";

/** 官方 ProtocolBrowserControlBroker 在 commit aac4755666d09fdcd70272fcf063c077a639015f 下发的上下文形状。 */
function officialRequestContext(): Record<string, unknown> {
  return {
    requestId: "0b2a25f1-1111-4222-8333-444455556666",
    sessionId: "sess_browser",
    turnId: "turn_1",
    workspaceKey: "D:\\work\\project",
    workspacePath: "D:\\work\\project\\.worktrees\\exec",
    workspaceIdentity: "identity-1",
    remoteSessionId: "remote-1",
    clientMode: "desktop-continuous",
    sessionContext: "live",
  };
}

test("browserList params accept the official broker context and strip unknown keys", () => {
  const parsed = browserListParamsSchema.parse({ ...officialRequestContext(), futureField: { nested: true } });
  assert.equal(parsed.sessionId, "sess_browser");
  assert.equal(parsed.workspaceKey, "D:\\work\\project");
  assert.equal(parsed.clientMode, "desktop-continuous");
  assert.equal(Object.hasOwn(parsed as Record<string, unknown>, "futureField"), false);
});

test("browserList params reject missing identity fields", () => {
  const context = officialRequestContext() as Record<string, unknown>;
  delete context.requestId;
  assert.equal(browserListParamsSchema.safeParse(context).success, false);
  const context2 = officialRequestContext() as Record<string, unknown>;
  delete context2.sessionId;
  assert.equal(browserListParamsSchema.safeParse(context2).success, false);
});

test("browserExecute params validate a real command payload", () => {
  const parsed = browserExecuteParamsSchema.parse({
    ...officialRequestContext(),
    browserId: "cdp:1f2e3d4c",
    browserGeneration: 2,
    command: { method: "navigate", url: "http://127.0.0.1:1/fixture" },
  });
  assert.equal(parsed.command.method, "navigate");
  assert.equal(parsed.browserGeneration, 2);
});

test("browserExecute params reject unknown or malformed commands", () => {
  const base = { ...officialRequestContext(), browserId: "cdp:x", browserGeneration: 0 };
  assert.equal(browserExecuteParamsSchema.safeParse({ ...base, command: { method: "noSuchMethod" } }).success, false);
  assert.equal(browserExecuteParamsSchema.safeParse({ ...base, command: { method: "navigate" } }).success, false);
  assert.equal(browserExecuteParamsSchema.safeParse({ ...base, command: { method: "navigate", url: "", tabId: 5 } }).success, false);
  assert.equal(browserExecuteParamsSchema.safeParse({ ...base, command: { method: "fill", value: "text" } }).success, false);
  assert.equal(browserExecuteParamsSchema.safeParse({ ...officialRequestContext(), command: { method: "getState" } }).success, false);
});

test("browser command schema keeps strict variants", () => {
  assert.equal(browserCommandSchema.safeParse({ method: "click", x: 1, y: 2, unexpected: true }).success, false);
  assert.equal(browserCommandSchema.safeParse({ method: "click", ref: "e1" }).success, true);
  assert.equal(browserCommandSchema.safeParse({ method: "cancelRequest", requestId: "req-1" }).success, true);
  assert.equal(browserCommandSchema.safeParse({ method: "playwrightWaitForTimeout", timeoutMs: -1 }).success, false);
});

test("managed cdp descriptor hides unsupported members through apiSupportOverrides", () => {
  const descriptor = browserBackendDescriptorSchema.parse({
    id: "cdp:abc",
    generation: 1,
    type: "cdp",
    name: "Bridge Managed Headless Chromium",
    capabilities: { browser: [], tab: [] },
    apiSupportOverrides: { "BrowserUser.openTabs": false, "PlaywrightAPI.waitForEvent": false },
    metadata: { provider: "codex-zcode-bridge", launchMode: "managed", headless: "true" },
  });
  assert.equal(descriptor.apiSupportOverrides?.["BrowserUser.openTabs"], false);
});

test("browser command result schema accepts the documented terminal shapes", () => {
  assert.equal(browserCommandResultSchema.safeParse({ ok: true, elapsedMs: 5 }).success, true);
  const declined = browserCommandResultSchema.parse({
    ok: false,
    error: { code: "backend_unavailable", message: "disabled", sideEffect: "none" },
    elapsedMs: 0,
  });
  assert.equal(declined.error?.code, "backend_unavailable");
  // error is optional in the official result schema; ok:false without an
  // error object stays schema-legal, so only ok/elapsedMs are required.
  assert.equal(browserCommandResultSchema.safeParse({ ok: false, elapsedMs: 0 }).success, true);
  assert.equal(browserCommandResultSchema.safeParse({ ok: false }).success, false);
});
