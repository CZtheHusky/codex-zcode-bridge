import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserHost, type BrowserHost, type BrowserHostEvent } from "../src/browser/host.js";
import type { BrowserControlPort, BrowserControlListInput, BrowserControlExecuteInput } from "../src/browser/contracts.js";
import type { BrowserBackendDescriptor } from "../src/browser/backend.js";
import type { BrowserCommandResult } from "../src/browser/result.js";

const DESCRIPTOR: BrowserBackendDescriptor = {
  id: "cdp:test-backend",
  generation: 3,
  type: "cdp",
  name: "Fake Managed CDP",
  capabilities: { browser: [], tab: [] },
  apiSupportOverrides: { "BrowserUser.openTabs": false },
  metadata: { provider: "codex-zcode-bridge", launchMode: "managed", headless: "true" },
};

class FakeBackend implements BrowserControlPort {
  listCalls = 0;
  executeCalls: Array<{ commandMethod: string; signal?: AbortSignal }> = [];
  closed = false;
  closeShouldThrow = false;
  listResult: BrowserBackendDescriptor[] = [DESCRIPTOR];
  nextExecute: (input: { commandMethod: string; signal?: AbortSignal }) => Promise<BrowserCommandResult> =
    async () => ({ ok: true, elapsedMs: 1 });

  async list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]> {
    void input;
    this.listCalls += 1;
    return this.listResult;
  }

  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    this.executeCalls.push({ commandMethod: input.command.method, signal: input.signal });
    return this.nextExecute({ commandMethod: input.command.method, signal: input.signal });
  }

  async turnEnded(input: BrowserControlListInput): Promise<void> {
    this.turnEndedSessions.push(input.sessionId);
  }

  async closeSession(input: BrowserControlListInput): Promise<void> {
    this.closeSessionIds.push(input.sessionId);
  }

  readonly turnEndedSessions: string[] = [];
  readonly closeSessionIds: string[] = [];

  async close(): Promise<void> {
    if (this.closeShouldThrow) throw new Error("simulated close failure");
    this.closed = true;
  }
}

function listParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: "list-1", sessionId: "sess_host", ...overrides };
}

function executeParams(command: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "exec-1",
    sessionId: "sess_host",
    browserId: DESCRIPTOR.id,
    browserGeneration: DESCRIPTOR.generation,
    command,
    ...overrides,
  };
}

async function parsedParams(schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = schema.safeParse(payload);
  if (!result.success || !result.data) throw new Error("fixture params failed schema parse");
  return result.data as Record<string, unknown>;
}

/**
 * The host's deadline and close-budget timers are unref'd so a leaked budget
 * can never keep a real worker process alive. On Node 22.18 an isolated test
 * process holds no other referenced handle while awaiting those timers, so
 * the event loop drains and the process exits before the 1s budget fires;
 * the same fixtures settle on Node 24 without help. Each affected fixture
 * holds its own referenced keepalive so the unref'd host timer is observed
 * without a global handle or a larger host budget. The keepalive itself is
 * bounded and cleared in finally on success, assertion failure, and host
 * hangs, so a broken host fails the test instead of hanging it.
 */
function withBoundedKeepalive<T>(maxWaitMs: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`fixture exceeded its ${maxWaitMs}ms keepalive bound`)), maxWaitMs);
  });
  return Promise.race([run(), guard]).finally(() => clearTimeout(timer));
}

test("disabled host lists no browsers and declines execute in-band", async () => {
  const events: BrowserHostEvent[] = [];
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "off", backendFactory: async () => backend }, (event) => events.push(event));
  const list = await host.handleList(await parsedList(listParams()), new AbortController().signal);
  assert.deepEqual(list, { kind: "ok", browsers: [] });
  const execute = await host.handleExecute(await parsedExecute(executeParams({ method: "getState" })), new AbortController().signal);
  assert.equal(execute.ok, false);
  assert.equal(execute.error?.code, "backend_unavailable");
  assert.equal(backend.listCalls, 0);
  assert.equal(events.length, 0);
});

test("enabled host answers every discovery from the backend and reports the start event once", async () => {
  const events: BrowserHostEvent[] = [];
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend }, (event) => events.push(event));
  const first = await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const second = await host.handleList(await parsedList(listParams({ requestId: "list-2" })), new AbortController().signal);
  assert.equal(first.kind, "ok" as const);
  if (first.kind === "ok") {
    assert.equal(first.browsers.length, 1);
    assert.equal(first.browsers[0]!.id, DESCRIPTOR.id);
    assert.equal(first.browsers[0]!.apiSupportOverrides?.["BrowserUser.openTabs"], false);
  }
  assert.equal(second.kind, "ok" as const);
  // Every discovery re-queries the backend so a restart cannot be masked by a
  // cached descriptor (R3); the start event itself stays single-shot.
  assert.equal(backend.listCalls, 2);
  assert.equal(events.filter((event) => event.type === "browser_host_started").length, 1);
});

test("stale browser id or generation is rejected as backend_unavailable", async () => {
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  const staleId = await host.handleExecute(
    await parsedExecute(executeParams({ method: "getState" }, { browserId: "cdp:other" })),
    new AbortController().signal,
  );
  assert.equal(staleId.error?.code, "backend_unavailable");
  const staleGeneration = await host.handleExecute(
    await parsedExecute(executeParams({ method: "getState" }, { browserGeneration: DESCRIPTOR.generation + 1 })),
    new AbortController().signal,
  );
  assert.equal(staleGeneration.error?.code, "backend_unavailable");
  assert.equal(backend.executeCalls.length, 0);
});

test("duplicate in-flight requestId is rejected without side effects", async () => {
  const backend = new FakeBackend();
  let releaseFirst: (() => void) | null = null;
  backend.nextExecute = () => new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, elapsedMs: 1 }); });
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const firstPromise = host.handleExecute(await parsedExecute(executeParams({ method: "navigate", url: "http://127.0.0.1:1/a" })), new AbortController().signal);
  const duplicate = await host.handleExecute(await parsedExecute(executeParams({ method: "navigate", url: "http://127.0.0.1:1/b" })), new AbortController().signal);
  assert.equal(duplicate.error?.code, "duplicate_request_id");
  assert.equal(duplicate.error?.sideEffect, "none");
  releaseFirst!();
  const first = await firstPromise;
  assert.equal(first.ok, true);
  assert.equal(backend.executeCalls.length, 1);
});

test("cancelRequest aborts the pending request and stays idempotent", async () => {
  const backend = new FakeBackend();
  let attemptAbort: ((error: Error) => void) | null = null;
  backend.nextExecute = ({ signal }) => new Promise((_resolve, reject) => {
    attemptAbort = (error: Error) => reject(error);
    signal?.addEventListener("abort", () => reject(new DOMException("Browser command cancelled", "AbortError")));
    void attemptAbort;
  });
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const firstPromise = host.handleExecute(await parsedExecute(executeParams({ method: "getState" })), new AbortController().signal);
  const cancel = await host.handleExecute(
    await parsedExecute(executeParams({ method: "cancelRequest", requestId: "exec-1" }, { requestId: "cancel-1", browserId: DESCRIPTOR.id, browserGeneration: DESCRIPTOR.generation })),
    new AbortController().signal,
  );
  assert.equal(cancel.ok, true);
  const lateCancel = await host.handleExecute(
    await parsedExecute(executeParams({ method: "cancelRequest", requestId: "exec-1" }, { requestId: "cancel-2" })),
    new AbortController().signal,
  );
  assert.equal(lateCancel.ok, true);
  const first = await firstPromise;
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, "execution_error");
});

test("host timeout returns a timeout error with honest sideEffect classification", async () => {
  await withBoundedKeepalive(5_000, async () => {
    const backend = new FakeBackend();
    backend.nextExecute = ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Browser command cancelled", "AbortError")));
    });
    const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend, commandTimeoutMs: 1_000 });
    await host.handleList(await parsedList(listParams()), new AbortController().signal);
    const navigate = await host.handleExecute(await parsedExecute(executeParams({ method: "navigate", url: "http://127.0.0.1:1/slow" })), new AbortController().signal);
    assert.equal(navigate.ok, false);
    assert.equal(navigate.error?.code, "timeout");
    assert.equal(navigate.error?.sideEffect, "uncertain");
    const getState = await host.handleExecute(await parsedExecute(executeParams({ method: "getState" }, { requestId: "exec-2" })), new AbortController().signal);
    assert.equal(getState.error?.code, "timeout");
    assert.equal(getState.error?.sideEffect, "none");
  });
});

test("launch failure surfaces a bounded error and a single launch-failed event", async () => {
  const events: BrowserHostEvent[] = [];
  const host = createBrowserHost(
    {
      mode: "headless",
      backendFactory: async () => { throw new Error("launch failed"); },
    },
    (event) => events.push(event),
  );
  const outcome = await host.handleList(await parsedList(listParams()), new AbortController().signal);
  assert.equal(outcome.kind, "error" as const);
  if (outcome.kind === "error") assert.match(outcome.message, /unavailable: launch failed/);
  const execute = await host.handleExecute(await parsedExecute(executeParams({ method: "getState" })), new AbortController().signal);
  assert.equal(execute.error?.code, "backend_unavailable");
  assert.equal(events.filter((event) => event.type === "browser_host_launch_failed").length, 1);
});

test("turnEnded and closeSession commands are forwarded to the backend lifecycle", async () => {
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const turnEnded = await host.handleExecute(await parsedExecute(executeParams({ method: "turnEnded", turnId: "turn_9" })), new AbortController().signal);
  const closeSession = await host.handleExecute(await parsedExecute(executeParams({ method: "closeSession" }, { requestId: "close-1" })), new AbortController().signal);
  assert.equal(turnEnded.ok, true);
  assert.equal(closeSession.ok, true);
  assert.deepEqual(backend.turnEndedSessions, ["sess_host"]);
  assert.deepEqual(backend.closeSessionIds, ["sess_host"]);
});

test("close is bounded, idempotent, and reports failures honestly", async () => {
  const events: BrowserHostEvent[] = [];
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend }, (event) => events.push(event));
  await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const first = await host.close();
  const second = await host.close();
  assert.deepEqual(first, { closed: true, error: null });
  assert.deepEqual(second, { closed: true, error: null });
  assert.equal(backend.closed, true);
  assert.equal(events.filter((event) => event.type === "browser_host_closed").length, 1);

  const failingEvents: BrowserHostEvent[] = [];
  const failing = new FakeBackend();
  failing.closeShouldThrow = true;
  const failingHost = createBrowserHost({ mode: "headless", backendFactory: async () => failing }, (event) => failingEvents.push(event));
  await failingHost.handleList(await parsedList(listParams()), new AbortController().signal);
  const outcome = await failingHost.close();
  assert.equal(outcome.closed, false);
  assert.equal(outcome.error, "simulated close failure");
  assert.equal(failingEvents.filter((event) => event.type === "browser_cleanup_unverified").length, 1);
  const afterClose = await failingHost.handleExecute(await parsedExecute(executeParams({ method: "getState" })), new AbortController().signal);
  assert.equal(afterClose.error?.code, "backend_unavailable");
});

test("default loader resolves the compiled managed CDP runtime on the dev path", async () => {
  // dist-test has no vendor/ sibling, so the loader must fall back to the
  // compiled runtime module and unwrap its named export without launching
  // a browser.
  const { loadBackendModule } = await import("../src/browser/load-backend.js");
  const module = await loadBackendModule();
  assert.equal(typeof module.createManagedCdpBrowserRuntime, "function");
});

test("discovery re-queries the backend so a restarted generation is not masked by a stale cache", async () => {
  const backend = new FakeBackend();
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  const first = await host.handleList(await parsedList(listParams()), new AbortController().signal);
  // Simulate a crash/restart: same connection identity, new generation.
  backend.listResult = [{ ...DESCRIPTOR, generation: DESCRIPTOR.generation + 1 }];
  const second = await host.handleList(await parsedList(listParams({ requestId: "list-2" })), new AbortController().signal);
  assert.equal(first.kind, "ok" as const);
  assert.equal(second.kind, "ok" as const);
  if (first.kind === "ok" && second.kind === "ok") {
    assert.equal(first.browsers[0]!.generation, DESCRIPTOR.generation);
    assert.equal(second.browsers[0]!.generation, DESCRIPTOR.generation + 1);
  }
  assert.equal(backend.listCalls, 2, "each discovery must re-query the backend");
  // The old generation is now stale for execute; the new one works.
  const stale = await host.handleExecute(
    await parsedExecute(executeParams({ method: "getState" }, { browserGeneration: DESCRIPTOR.generation })),
    new AbortController().signal,
  );
  assert.equal(stale.error?.code, "backend_unavailable");
  const fresh = await host.handleExecute(
    await parsedExecute(executeParams({ method: "getState" }, { requestId: "exec-2", browserGeneration: DESCRIPTOR.generation + 1 })),
    new AbortController().signal,
  );
  assert.equal(fresh.ok, true);
});

test("a failed close stays failed on repeated close calls", async () => {
  const backend = new FakeBackend();
  backend.closeShouldThrow = true;
  const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend });
  await host.handleList(await parsedList(listParams()), new AbortController().signal);
  const first = await host.close();
  const second = await host.close();
  assert.equal(first.closed, false);
  assert.equal(first.error, "simulated close failure");
  assert.deepEqual(second, first, "repeated close must not repaint an unverified teardown as verified");
});

test("a backend close that never settles is reported unverified within the host budget", async () => {
  await withBoundedKeepalive(5_000, async () => {
    const backend = new FakeBackend();
    backend.close = () => new Promise(() => undefined);
    const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend, closeBudgetMs: 1_000 });
    await host.handleList(await parsedList(listParams()), new AbortController().signal);
    const outcome = await host.close();
    assert.equal(outcome.closed, false);
    assert.match(outcome.error ?? "", /did not settle within the close budget/);
  });
});

test("the host deadline returns timeout even when the backend ignores its AbortSignal", async () => {
  await withBoundedKeepalive(5_000, async () => {
    const backend = new FakeBackend();
    backend.nextExecute = () => new Promise(() => undefined);
    const host = createBrowserHost({ mode: "headless", backendFactory: async () => backend, commandTimeoutMs: 1_000 });
    await host.handleList(await parsedList(listParams()), new AbortController().signal);
    const result = await host.handleExecute(await parsedExecute(executeParams({ method: "navigate", url: "http://127.0.0.1:1/hang" })), new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.sideEffect, "uncertain");
  });
});

async function parsedList(payload: Record<string, unknown>): Promise<import("../src/browser/params.js").BrowserListParams> {
  const { browserListParamsSchema } = await import("../src/browser/params.js");
  const parsed = browserListParamsSchema.safeParse(payload);
  if (!parsed.success) throw new Error("fixture list params failed schema parse");
  return parsed.data;
}

async function parsedExecute(payload: Record<string, unknown>): Promise<import("../src/browser/params.js").BrowserExecuteParams> {
  const { browserExecuteParamsSchema } = await import("../src/browser/params.js");
  const parsed = browserExecuteParamsSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`fixture execute params failed schema parse: ${String(parsed.error.issues[0]?.path)}`);
  return parsed.data;
}

void parsedParams;
