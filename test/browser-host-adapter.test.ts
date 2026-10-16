import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import type { BrowserControlPort } from "../src/browser/contracts.js";
import type { BrowserBackendDescriptor } from "../src/browser/backend.js";
import type { BrowserCommandResult } from "../src/browser/result.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { makeWorkspace, SESSION_ID, validReport } from "./helpers.js";

// 离线 native 集成：fake app-server 按 commit aac4755666d09fdcd70272fcf063c077a639015f
// 的 ProtocolBrowserControlBroker 形状下发 interaction/browserList /
// interaction/browserExecute 反向请求，覆盖修复前返回 -32601 Unsupported 的路径。
const task: TaskPackage = {
  task_id: "browser_host_test",
  workspace: "C:\\unused",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

const DESCRIPTOR: BrowserBackendDescriptor = {
  id: "cdp:fake-adapter-backend",
  generation: 7,
  type: "cdp",
  name: "Fake Managed CDP",
  capabilities: { browser: [], tab: [] },
  apiSupportOverrides: { "BrowserUser.openTabs": false },
  metadata: { provider: "codex-zcode-bridge", launchMode: "managed", headless: "true" },
};

class FakeBackend implements BrowserControlPort {
  executeLog: string[] = [];
  closed = false;
  hangOnNavigate = false;
  closeShouldThrow = false;

  async list(): Promise<BrowserBackendDescriptor[]> {
    return [DESCRIPTOR];
  }

  async execute(input: { command: { method: string }; signal?: AbortSignal }): Promise<BrowserCommandResult> {
    this.executeLog.push(input.command.method);
    if (input.command.method === "navigate" && this.hangOnNavigate) {
      await new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new DOMException("Browser command cancelled", "AbortError")));
      });
      return { ok: false, error: { code: "cancelled", message: "cancelled" }, elapsedMs: 0 };
    }
    if (input.command.method === "newTab") {
      return {
        ok: true,
        tab: { tabId: "tab:1", url: "about:blank", title: "", viewport: { width: 1280, height: 720 }, lifecycle: "active" },
        meta: {
          browserUse: true,
          backendType: "cdp",
          browserId: DESCRIPTOR.id,
          browserGeneration: DESCRIPTOR.generation,
          openTabIds: ["tab:1"],
          tabId: "tab:1",
          lifecycle: "active",
        },
        elapsedMs: 2,
      };
    }
    return { ok: true, elapsedMs: 1 };
  }

  async close(): Promise<void> {
    if (this.closeShouldThrow) throw new Error("simulated adapter close failure");
    this.closed = true;
  }
}

type Scenario = "disabled-default" | "disabled-env-off" | "enabled" | "wrong-session" | "wrong-workspace" | "stale" | "invalid-params" | "hang-navigate";

interface BrowserFakeRuntime {
  root: string;
  config: ZCodeRuntimeConfig;
  replyLog: string;
}

async function makeBrowserFakeRuntime(scenario: Scenario): Promise<BrowserFakeRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-browser-host-test-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const replyLog = path.join(root, "replies.jsonl");
  const script = `
const readline = require("node:readline");
const fs = require("node:fs");
const sessionId = ${JSON.stringify(SESSION_ID)};
const replyLog = ${JSON.stringify(replyLog)};
const scenario = ${JSON.stringify(scenario)};
const report = ${JSON.stringify(JSON.stringify(validReport()))};
let browserId = "cdp:fake-adapter-backend";
let browserGeneration = 7;
let nextRpc = 0;
let workspace = { workspacePath: "C:\\\\work\\\\demo", workspaceKey: "C:\\\\work\\\\demo" };
function reply(entry) { fs.appendFileSync(replyLog, JSON.stringify(entry) + "\\n"); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function context(overrides) {
  // 官方 broker 语义（browser-control-broker.ts buildBrowserRequestContext）：
  // workspaceKey = workspaceIdentity ?? workspacePath，其中 workspacePath 是
  // session/create 传入的执行目录。没有 identity 的本地 worktree 请求 key
  // 是执行目录本身，不是项目目录。
  return Object.assign({
    requestId: require("node:crypto").randomUUID(),
    sessionId,
    turnId: "turn_browser",
    workspaceKey: workspace.workspaceIdentity || workspace.workspacePath,
    workspacePath: workspace.workspacePath,
    clientMode: "desktop-continuous",
    sessionContext: "live",
  }, overrides || {});
}
function finishTurn() {
  send({ method: "session/event", params: { seq: 2, type: "turn.completed", payload: { response: report, usage: { totalTokens: 1 }, resultType: "success" } } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/create") {
    workspace = message.params.workspace;
    send({ id: message.id, result: {
      session: { sessionId },
      settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [{ ref: { providerId: "provider-default", modelId: "model-default" }, label: "Test Model" }] } },
      runtime: { eventSeq: 0 },
    } });
  } else if (message.method === "session/subscribe" || message.method === "session/send") {
    send({ id: message.id, result: {} });
    if (message.method === "session/send") startBrowserFlow();
  } else if (message.id !== undefined && message.method === undefined) {
    reply(message);
    if (message.id === "browser-list") {
      const browsers = (((message.result || {}).browsers) || []);
      if (browsers.length > 0) { browserId = browsers[0].id; browserGeneration = browsers[0].generation; }
      afterList();
    }
  }
});
function startBrowserFlow() {
  send({ method: "session/event", params: { seq: 1, type: "turn.started", payload: { turnId: "turn_browser" } } });
  if (scenario === "invalid-params") {
    send({ id: "browser-list", method: "interaction/browserList", params: context({ requestId: "" }) });
    send({ id: "browser-exec", method: "interaction/browserExecute", params: Object.assign(context(), { browserId, browserGeneration, command: { method: "bogus" } }) });
    setTimeout(finishTurn, 300);
    return;
  }
  if (scenario === "wrong-session") {
    send({ id: "browser-list", method: "interaction/browserList", params: context({ sessionId: "sess_other" }) });
    send({ id: "browser-exec", method: "interaction/browserExecute", params: Object.assign(context({ sessionId: "sess_other" }), { browserId, browserGeneration, command: { method: "getState" } }) });
    setTimeout(finishTurn, 300);
    return;
  }
  if (scenario === "wrong-workspace") {
    send({ id: "browser-list", method: "interaction/browserList", params: context({ workspaceKey: "D:\\\\elsewhere", workspacePath: "D:\\\\elsewhere" }) });
    setTimeout(finishTurn, 300);
    return;
  }
  send({ id: "browser-list", method: "interaction/browserList", params: context() });
}
function afterList() {
  if (scenario === "hang-navigate") {
    send({ id: "browser-exec", method: "interaction/browserExecute", params: Object.assign(context(), { browserId, browserGeneration, command: { method: "navigate", url: "http://127.0.0.1:1/slow" } }) });
    return;
  }
  if (scenario === "stale") {
    send({ id: "browser-exec", method: "interaction/browserExecute", params: Object.assign(context(), { browserId: "cdp:retired", browserGeneration: 1, command: { method: "getState" } }) });
    setTimeout(finishTurn, 300);
    return;
  }
  send({ id: "browser-exec", method: "interaction/browserExecute", params: Object.assign(context(), { browserId, browserGeneration, command: { method: "newTab" } }) });
  setTimeout(finishTurn, 300);
}
`;
  await writeFile(entrypoint, script, "utf8");
  return {
    root,
    replyLog,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
  };
}

interface ReplyEntry {
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function readReplies(logPath: string): Promise<ReplyEntry[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReplyEntry);
  } catch {
    return [];
  }
}

interface RunResult {
  outcome: { exitCode: number | null; errorCode: string | null; cleanupVerified?: boolean; cleanupError?: string | null };
  events: Array<{ type: string; summary: string; details?: Record<string, unknown> }>;
  replies: ReplyEntry[];
  backend: FakeBackend | null;
}

async function runAdapter(
  runtime: BrowserFakeRuntime,
  options: { browser?: { mode: "off" | "headless"; backendFactory: () => Promise<BrowserControlPort> }; env?: Record<string, string>; workspace?: ReturnType<typeof makeWorkspace> } = {},
): Promise<RunResult> {
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const adapter = new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
    childEnvBase: { PATH: process.env.PATH, ...(options.env ?? {}) },
    ...(options.browser ? { browser: options.browser } : {}),
  });
  let backend: FakeBackend | null = null;
  if (options.browser) {
    backend = new FakeBackend();
    options.browser.backendFactory = async () => backend!;
  }
  const handle = await adapter.startTask({ task, workspace: options.workspace ?? makeWorkspace(runtime.root), attempt: 1 });
  const outcome = await adapter.getResult(handle);
  return {
    outcome: { exitCode: outcome.exitCode, errorCode: outcome.errorCode, cleanupVerified: outcome.cleanupVerified, cleanupError: outcome.cleanupError },
    events,
    replies: await readReplies(runtime.replyLog),
    backend,
  };
}

test("default off: browserList answers an empty list instead of Unsupported, execute declines in-band", async () => {
  const runtime = await makeBrowserFakeRuntime("disabled-default");
  try {
    const run = await runAdapter(runtime);
    assert.equal(run.outcome.exitCode, 0);
    const listReply = run.replies.find((entry) => entry.id === "browser-list");
    assert.ok(listReply, "browserList reverse RPC must receive a reply");
    assert.deepEqual(listReply.result?.browsers, []);
    const execReply = run.replies.find((entry) => entry.id === "browser-exec");
    assert.ok(execReply);
    assert.equal((execReply.result as { ok?: boolean } | undefined)?.ok, false);
    assert.equal(((execReply.result as { error?: { code?: string } } | undefined)?.error)?.code, "backend_unavailable");
    assert.equal(run.events.filter((event) => event.type === "browser_host_disabled").length, 1);
    assert.equal(run.events.some((event) => event.type === "browser_host_started"), false);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("explicit env off keeps the same disabled semantics", async () => {
  const runtime = await makeBrowserFakeRuntime("disabled-env-off");
  try {
    const run = await runAdapter(runtime, { env: { ZCODE_BRIDGE_BROWSER_USE: "off" } });
    assert.equal(run.outcome.exitCode, 0);
    assert.deepEqual(run.replies.find((entry) => entry.id === "browser-list")?.result?.browsers, []);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("worktree execution directories key browser scope by the execution path (official broker semantics)", async () => {
  // R1 regression: the official protocol broker keys requests by
  // workspaceIdentity ?? workspacePath, where workspacePath is the execution
  // directory passed to session/create. A worktree whose project directory
  // differs from the execution directory must not be mis-keyed to the project
  // directory and rejected.
  const runtime = await makeBrowserFakeRuntime("enabled");
  try {
    const run = await runAdapter(runtime, {
      browser: { mode: "headless", backendFactory: async () => new FakeBackend() },
      workspace: {
        requestedPath: "D:\\projects\\recshop",
        canonicalPath: runtime.root,
        mode: "worktree",
        sourcePath: "D:\\projects\\recshop",
      },
    });
    assert.equal(run.outcome.exitCode, 0);
    const listReply = run.replies.find((entry) => entry.id === "browser-list");
    assert.ok(listReply, "browserList must be answered, not refused");
    const browsers = (listReply?.result?.browsers ?? []) as BrowserBackendDescriptor[];
    assert.equal(browsers.length, 1);
    assert.equal(browsers[0]!.type, "cdp");
    const execReply = run.replies.find((entry) => entry.id === "browser-exec");
    assert.equal((execReply?.result as { ok?: boolean } | undefined)?.ok, true);
    assert.equal(run.backend?.closed, true);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("headless opt-in lists the cdp descriptor, executes commands, and closes with the attempt", async () => {
  const runtime = await makeBrowserFakeRuntime("enabled");
  try {
    const run = await runAdapter(runtime, { browser: { mode: "headless", backendFactory: async () => new FakeBackend() } });
    assert.equal(run.outcome.exitCode, 0);
    const listReply = run.replies.find((entry) => entry.id === "browser-list");
    const browsers = (listReply?.result?.browsers ?? []) as BrowserBackendDescriptor[];
    assert.equal(browsers.length, 1);
    assert.equal(browsers[0]!.type, "cdp");
    assert.equal(browsers[0]!.id, DESCRIPTOR.id);
    assert.equal(browsers[0]!.generation, DESCRIPTOR.generation);
    assert.equal(browsers[0]!.apiSupportOverrides?.["BrowserUser.openTabs"], false);
    const execReply = run.replies.find((entry) => entry.id === "browser-exec");
    const result = execReply?.result as { ok?: boolean; tab?: { tabId?: string }; meta?: { browserId?: string } } | undefined;
    assert.equal(result?.ok, true);
    assert.equal(result?.tab?.tabId, "tab:1");
    assert.equal(result?.meta?.browserId, DESCRIPTOR.id);
    assert.equal(run.backend?.closed, true);
    assert.equal(run.events.some((event) => event.type === "browser_host_started"), true);
    assert.equal(run.events.some((event) => event.type === "browser_host_closed"), true);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("stale generation and cross-session or cross-workspace requests are declined", async () => {
  for (const scenario of ["stale", "wrong-session", "wrong-workspace"] as const) {
    const runtime = await makeBrowserFakeRuntime(scenario);
    try {
      const run = await runAdapter(runtime, { browser: { mode: "headless", backendFactory: async () => new FakeBackend() } });
      assert.equal(run.outcome.exitCode, 0, scenario);
      if (scenario === "stale") {
        const execReply = run.replies.find((entry) => entry.id === "browser-exec");
        assert.equal(((execReply?.result as { error?: { code?: string } } | undefined)?.error)?.code, "backend_unavailable");
        assert.equal(run.backend?.executeLog.includes("getState"), false);
      } else {
        const listReply = run.replies.find((entry) => entry.id === "browser-list");
        assert.ok(listReply?.error, `${scenario} browserList must be refused at RPC level`);
        assert.notEqual(listReply?.error?.code, -32601);
        if (scenario === "wrong-session") {
          const execReply = run.replies.find((entry) => entry.id === "browser-exec");
          assert.equal(((execReply?.result as { error?: { code?: string } } | undefined)?.error)?.code, "backend_unavailable");
        }
      }
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  }
});

test("a browser teardown failure keeps the final outcome unverified even when the app-server closes cleanly", async () => {
  // R2 regression: the final cleanup verdict must combine the app-server and
  // the managed browser; a browser that cannot be closed must not be hidden
  // behind a verified app-server exit.
  const failingRuntime = await makeBrowserFakeRuntime("enabled");
  try {
    const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
    const backend = new FakeBackend();
    backend.closeShouldThrow = true;
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => failingRuntime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 15_000,
      childEnvBase: { PATH: process.env.PATH },
      browser: { mode: "headless", backendFactory: async () => backend },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(failingRuntime.root), attempt: 1 });
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.cleanupVerified, false);
    assert.match(outcome.cleanupError ?? "", /Managed browser cleanup could not be verified/);
    assert.equal(events.some((event) => event.type === "browser_cleanup_unverified"), true);
  } finally {
    await rm(failingRuntime.root, { recursive: true, force: true });
  }
});

test("malformed browser params are rejected as invalid params, not Unsupported", async () => {
  const runtime = await makeBrowserFakeRuntime("invalid-params");
  try {
    const run = await runAdapter(runtime, { browser: { mode: "headless", backendFactory: async () => new FakeBackend() } });
    assert.equal(run.outcome.exitCode, 0);
    const listReply = run.replies.find((entry) => entry.id === "browser-list");
    assert.equal(listReply?.error?.code, -32602);
    const execReply = run.replies.find((entry) => entry.id === "browser-exec");
    assert.equal(execReply?.error?.code, -32602);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("cancelling mid browser command closes the browser host with the attempt", async () => {
  const runtime = await makeBrowserFakeRuntime("hang-navigate");
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const backend = new FakeBackend();
  backend.hangOnNavigate = true;
  const adapter = new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
    childEnvBase: { PATH: process.env.PATH },
    browser: { mode: "headless", backendFactory: async () => backend },
  });
  try {
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const deadline = Date.now() + 10_000;
    while (backend.executeLog.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backend.executeLog[0], "navigate");
    await adapter.cancelTask(handle);
    const outcome = await adapter.getResult(handle).catch((error: unknown) => error as { code?: string });
    const code = (outcome as { errorCode?: string }).errorCode ?? (outcome as { code?: string }).code;
    assert.equal(code, "cancelled");
    assert.equal(backend.closed, true);
    assert.equal(events.some((event) => event.type === "browser_host_closed"), true);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});
