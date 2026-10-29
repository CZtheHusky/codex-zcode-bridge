// Stdio entry tests: the compiled main.js must speak pure JSON-RPC on stdout,
// keep diagnostics on stderr, start without any ZCode provider configuration,
// and honor ZCODE_BRIDGE_DATA_DIR. Uses real child processes but never starts
// a ZCode worker (only initialize/initialized/tools/list/status-on-unknown-id).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import test from "node:test";
import { resolveDataRoot, resolveMaxConcurrentWorkers } from "../src/mcp/main.js";

const MAIN_JS = fileURLToPath(new URL("../src/mcp/main.js", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/", import.meta.url));

for (const { name, runner } of [
  { name: "compiled scheduler", runner: fileURLToPath(new URL("../src/schedule/runner-main.js", import.meta.url)) },
  { name: "bundled scheduler", runner: path.join(PLUGIN_ROOT, "worker", "schedule-runner.mjs") },
]) {
  test(`${name} entry loads from a clean environment before reporting missing arguments`, () => {
    const home = mkdtempSync(path.join(tmpdir(), "zcode-bridge-scheduler-entry-"));
    try {
      const run = spawnSync(process.execPath, [runner], {
        cwd: home,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], HOME: home, USERPROFILE: home, SystemRoot: process.env["SystemRoot"] },
        timeout: 5_000,
      });
      assert.equal(run.status, 2, `stderr: ${run.stderr}`);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /usage: node schedule-runner\.mjs <dataRoot> <taskId>/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const PROTOCOL_MESSAGES = [
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-probe", version: "0.0.0" },
    },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "coding_agent_status", arguments: { task_id: "ghost" } },
  }),
].join("\n") + "\n";

test("compiled stdio entry speaks pure JSON-RPC on stdout and diagnostics on stderr", { timeout: 30_000 }, () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "zcode-bridge-stdio-"));
  try {
    const run = spawnSync(process.execPath, [MAIN_JS], {
      input: PROTOCOL_MESSAGES,
      encoding: "utf8",
      env: { ...process.env, ZCODE_BRIDGE_DATA_DIR: dataRoot },
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 3, `expected protocol responses on stdout, got: ${run.stdout}`);
    const parsed = lines.map((line) => {
      let value: unknown;
      assert.doesNotThrow(() => {
        value = JSON.parse(line);
      }, `stdout contained a non-JSON line: ${line}`);
      return value as { jsonrpc?: string; id?: number; result?: Record<string, unknown> };
    });
    for (const message of parsed) {
      assert.equal(message.jsonrpc, "2.0");
    }

    const initialize = parsed.find((message) => message.id === 1);
    assert.ok(initialize?.result, "initialize must succeed");
    assert.match(JSON.stringify(initialize.result), /coding-agent-bridge/);
    assert.match(JSON.stringify(initialize.result), /Coding Agent Bridge/);
    assert.match(JSON.stringify(initialize.result), /reasoning_levels/);
    const toolsList = parsed.find((message) => message.id === 2);
    const toolNames = (
      (toolsList?.result?.tools as Array<{ name: string }> | undefined) ?? []
    )
      .map((tool) => tool.name)
      .sort();
    // The default Codex host composes the ADR-010 scheduler; a createBridgeServer
    // consumer that injects no scheduling sees only the 13 frozen core tools
    // (covered by mcp-server tests).
    assert.deepEqual(toolNames, [
      "coding_agent_cancel",
      "coding_agent_clear_default_model",
      "coding_agent_continue",
      "coding_agent_default_model",
      "coding_agent_doctor",
      "coding_agent_events",
      "coding_agent_feedback",
      "coding_agent_interaction_reply",
      "coding_agent_model_catalog",
      "coding_agent_result",
      "coding_agent_schedule",
      "coding_agent_schedule_cancel",
      "coding_agent_schedule_review",
      "coding_agent_schedule_status",
      "coding_agent_set_default_model",
      "coding_agent_status",
      "coding_agent_task",
    ]);

    const statusCall = parsed.find((message) => message.id === 3);
    const isError = (
      statusCall?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
    );
    assert.equal(isError?.isError, true, "unknown task must be a tool error, not success");
    assert.match(isError?.content?.[0]?.text ?? "", /TASK_NOT_FOUND/);

    assert.match(run.stderr, /\[bridge\]/, "diagnostics must go to stderr");
    assert.match(run.stderr, /data root/);
    assert.doesNotMatch(run.stdout, /\[bridge\]/, "stdout must contain protocol messages only");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("worker concurrency defaults to eight and rejects out-of-range configuration", () => {
  assert.deepEqual(resolveMaxConcurrentWorkers({}), { maxConcurrentWorkers: 8 });
  assert.deepEqual(resolveMaxConcurrentWorkers({ ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: "3" }), {
    maxConcurrentWorkers: 3,
  });
  const invalid = resolveMaxConcurrentWorkers({ ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: "9" });
  assert.equal(invalid.maxConcurrentWorkers, 1);
  assert.match(invalid.warning ?? "", /integer from 1 to 8/);
});

test("marketplace bundle starts from its plugin root without repo-local dependencies", { timeout: 30_000 }, () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "zcode-bridge-plugin-stdio-"));
  try {
    const run = spawnSync(process.execPath, ["./dist/bridge.mjs"], {
      cwd: PLUGIN_ROOT,
      input: PROTOCOL_MESSAGES,
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_BRIDGE_PLUGIN_MODE: "1",
        ZCODE_BRIDGE_DATA_DIR: dataRoot,
      },
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const lines = run.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const messages = lines.map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
    assert.ok(messages.some((message) => message.id === 1 && message.result), "bundle must initialize over stdio");
    const initialization = messages.find((message) => message.id === 1);
    assert.match(JSON.stringify(initialization?.result), /Coding Agent Bridge/);
    assert.match(JSON.stringify(initialization?.result), /coding_agent_schedule/);
    const toolsList = messages.find((message) => message.id === 2)?.result;
    const toolNames = ((toolsList?.["tools"] as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "coding_agent_cancel", "coding_agent_clear_default_model", "coding_agent_continue", "coding_agent_default_model", "coding_agent_doctor", "coding_agent_events", "coding_agent_feedback", "coding_agent_interaction_reply", "coding_agent_model_catalog", "coding_agent_result", "coding_agent_schedule", "coding_agent_schedule_cancel", "coding_agent_schedule_review", "coding_agent_schedule_status", "coding_agent_set_default_model", "coding_agent_status", "coding_agent_task",
    ]);
    assert.ok(existsSync(path.join(PLUGIN_ROOT, "worker", "worker-main.mjs")), "detached worker bundle must ship beside the MCP server");
    assert.match(run.stderr, /data root/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("resolveDataRoot honors an absolute override and falls back on invalid input", () => {
  const absolute = path.join(tmpdir(), "bridge-data");
  assert.deepEqual(resolveDataRoot({ ZCODE_BRIDGE_DATA_DIR: absolute }), {
    dataRoot: path.normalize(absolute),
  });

  const relative = resolveDataRoot({ ZCODE_BRIDGE_DATA_DIR: "relative/dir" });
  assert.ok(relative.warning, "a relative override must produce a warning");
  assert.ok(path.isAbsolute(relative.dataRoot));

  const fallback = resolveDataRoot({});
  assert.ok(path.isAbsolute(fallback.dataRoot));
  assert.equal(fallback.warning, undefined);
});
