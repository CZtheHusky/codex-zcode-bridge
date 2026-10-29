import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { build } from "esbuild";
import { registerDesktopTask, updateDesktopTaskStatus } from "../src/adapters/task-index-sync.js";
import { createBridgeServer } from "../src/mcp/server.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { ZCodeModelSettings } from "../src/runtime/model-settings.js";

test("temporary Desktop index preserves user rows, titles, and metadata while updating owned status", async () => {
  const fixture = await runtimeFixture();
  let database: DatabaseSync | undefined;
  try {
    const databasePath = path.join(fixture.root, "index.sqlite");
    database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT, title TEXT, task_status TEXT, provider TEXT, mode TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, unread_at INTEGER, pinned INTEGER, archived INTEGER, deleted INTEGER, title_overridden INTEGER, meta_json TEXT, searchable_text TEXT, UNIQUE(workspace_key, task_id));`);
    const entry = { databasePath, workspaceKey: "project", workspacePath: "execution", sessionId: "session", bridgeTaskId: "bridge-task", title: "original", model: "fake", provider: "glm", mode: "build" };
    await registerDesktopTask(entry);
    const initial = database.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
    const meta = { ...JSON.parse(initial.meta_json as string), title: "user renamed", extension: "keep" };
    database.prepare("UPDATE tasks SET title = ?, title_overridden = 1, meta_json = ?").run("user renamed", JSON.stringify(meta));
    await updateDesktopTaskStatus(entry, "completed");
    const changed = database.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
    assert.equal(changed.title, "user renamed");
    assert.equal(changed.title_overridden, 1);
    assert.equal(changed.task_status, "completed");
    assert.equal(JSON.parse(changed.meta_json as string).extension, "keep");
    const before = JSON.stringify(changed);
    await assert.rejects(registerDesktopTask({ ...entry, bridgeTaskId: "foreign-owner" }), /not owned/);
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM tasks").get()), before);
    await updateDesktopTaskStatus(entry, null);
    assert.equal((database.prepare("SELECT task_status FROM tasks").get() as Record<string, unknown>).task_status, null);
  } finally { database?.close(); await fixture.cleanup(); }
});

test("incompatible Desktop schemas are rejected without partial inserts", async () => {
  const fixture = await runtimeFixture();
  const databasePath = path.join(fixture.root, "bad.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE tasks (task_id TEXT)");
    await assert.rejects(registerDesktopTask({ databasePath, workspaceKey: "p", workspacePath: "p", sessionId: "s", bridgeTaskId: "b", title: "x", provider: "glm", model: null, mode: "build" }), /missing columns/);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count, 0);
  } finally { database.close(); await fixture.cleanup(); }
});

test("MCP identity and instructions are supplied by the host; experiments require explicit opt-in", async () => {
  const manager = { createTask: async () => { throw new Error("unused"); }, getStatus: async () => { throw new Error("unused"); }, getResult: async () => { throw new Error("unused"); }, cancelTask: async () => { throw new Error("unused"); }, continueTask: async () => { throw new Error("unused"); } };
  for (const experiments of [false, true]) {
    const server = createBridgeServer({ taskManager: manager, serverInfo: { name: "dsh-test-bridge", version: "0.0.test" }, instructions: "Host-supplied instructions", enableExperiments: experiments });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      assert.equal(client.getServerVersion()?.name, "dsh-test-bridge");
      assert.equal(client.getInstructions(), "Host-supplied instructions");
      assert.equal((await client.listTools()).tools.some((tool) => tool.name === "coding_agent_progress_probe"), experiments);
    } finally { await Promise.all([client.close(), server.close()]); }
  }
});

test("a bundled fork can import the core without implicitly starting a Codex server", async () => {
  const fixture = await runtimeFixture();
  try {
    const outfile = path.join(fixture.root, "host.mjs");
    const result = await build({ stdin: { contents: `import { codexHostProfile } from './src/core.ts'; console.log(codexHostProfile().name);`, resolveDir: path.resolve("."), sourcefile: "host.ts" }, outfile, bundle: true, platform: "node", format: "esm", target: "node22.18", logLevel: "silent" });
    assert.equal(result.errors.length, 0);
    const run = spawnSync(process.execPath, [outfile], { env: fixture.env, encoding: "utf8", timeout: 5_000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "codex-zcode-bridge");
    assert.doesNotMatch(run.stderr, /server ready|data root/);
  } finally { await fixture.cleanup(); }
});

test("model-default migration preserves legacy mode and unknown fields without changing legacy files", async () => {
  const fixture = await runtimeFixture();
  try {
    const legacyDirectory = path.join(fixture.root, "legacy");
    await mkdir(legacyDirectory);
    const legacyPath = path.join(legacyDirectory, "runtime-config.json");
    const legacy = JSON.stringify({ ZCODE_BRIDGE_MODE: "build", extension: { keep: true } });
    await writeFile(legacyPath, legacy);
    const settings = new ZCodeModelSettings({}, { homeDir: fixture.home, host: { name: "migrated", settingsDirectory: path.join(fixture.root, "canonical"), legacySettingsDirectories: [legacyDirectory] } });
    await settings.setDefaultModel({ provider_id: "fake", model_id: "fake" });
    const saved = JSON.parse(await readFile(path.join(fixture.root, "canonical", "runtime-config.json"), "utf8"));
    assert.equal(saved.ZCODE_BRIDGE_MODE, "build");
    assert.deepEqual(saved.extension, { keep: true });
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
  } finally { await fixture.cleanup(); }
});

test("Windows startup hook preserves timeout and extension settings and refuses corrupt settings", { skip: process.platform !== "win32" }, async () => {
  const fixture = await runtimeFixture();
  try {
    const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$HOME"], { env: fixture.env, encoding: "utf8", windowsHide: true });
    assert.equal(path.resolve(check.stdout.trim()), fixture.home, "refuse to run setup against the real home");
    const configPath = path.join(fixture.home, ".codex", "codex-zcode-bridge", "runtime-config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ ZCODE_BRIDGE_TIMEOUT_MS: "60000", ZCODE_BRIDGE_MODE: "build", extension: { keep: true } }));
    const hook = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/hooks/configure-runtime.ps1", import.meta.url));
    // dist-test/test needs the repository plugin, not a plugin inside dist-test.
    const actualHook = path.resolve(path.dirname(hook), "../../../plugins/codex-zcode-bridge/hooks/configure-runtime.ps1");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", actualHook, "-NodeExecutablePath", process.execPath, "-ZCodeRuntimePath", fixture.config.zcodeEntrypoint, "-BuiltinProviderConfigPath", fixture.config.providerBuiltinConfigFile, "-PersonalProviderConfigPath", fixture.config.providerPersonalConfigFile, "-ZCodeHome", path.join(fixture.home, ".zcode")];
    const setup = spawnSync("powershell.exe", args, { env: fixture.env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.equal(setup.status, 0, setup.stderr);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.ZCODE_BRIDGE_TIMEOUT_MS, "60000");
    assert.deepEqual(saved.extension, { keep: true });
    await writeFile(configPath, "{invalid");
    const bad = spawnSync("powershell.exe", args, { env: fixture.env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.notEqual(bad.status, 0);
    assert.equal(await readFile(configPath, "utf8"), "{invalid");
  } finally { await fixture.cleanup(); }
});
