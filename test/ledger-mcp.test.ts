// Ledger MCP surface: opt-in registration, host-controlled gate errors
// surfaced as tool errors, and coexistence with the frozen core tools.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/mcp/server.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { BridgeTaskManager } from "../src/manager/task-manager.js";
import type { TaskPackage, TaskReceipt } from "../src/interfaces.js";

const CREATED_AT = "2026-09-27T00:00:00.000Z";

const minimalManager = {
  createTask: async (task: TaskPackage): Promise<TaskReceipt> => ({ task_id: task.task_id, status: "queued", created_at: CREATED_AT }),
  getStatus: async () => ({ task_id: "x", status: "queued", attempt: 1, created_at: CREATED_AT, updated_at: CREATED_AT, started_at: null, finished_at: null, worker_pid: null, zcode_session_id: null, exit_code: null }),
  getResult: async () => { throw new Error("not used"); },
  continueTask: async () => { throw new Error("not used"); },
  cancelTask: async () => { throw new Error("not used"); },
  getEvents: async () => ({ task_id: "x", status: "queued" as const, events: [], next_seq: 0, has_more: false }),
  replyToInteraction: async () => { throw new Error("not used"); },
} as unknown as BridgeTaskManager;

interface LedgerFixture {
  client: Client;
  root: string;
  cleanup: () => void;
}

async function withLedgerServer(run: (client: Client, store: LedgerStore, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-ledger-mcp-"));
  const store = LedgerStore.open(root, { create: true });
  const server = createBridgeServer({
    taskManager: minimalManager,
    ledger: { store, taskManager: minimalManager, hostActorId: "test-host" },
  });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, store, root);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test("opt-in ledger tools register alongside the frozen twelve; summary and create work end to end", async () => {
  await withLedgerServer(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const core of ["coding_agent_task", "coding_agent_status", "coding_agent_result", "coding_agent_cancel", "coding_agent_doctor"]) {
      assert.ok(names.includes(core), `core tool ${core} must remain`);
    }
    for (const ledger of ["coding_agent_ledger_project_create", "coding_agent_ledger_summary", "coding_agent_ledger_task_create", "coding_agent_ledger_task_update", "coding_agent_ledger_task_get", "coding_agent_ledger_task_history", "coding_agent_ledger_run_start", "coding_agent_ledger_run_link", "coding_agent_ledger_review", "coding_agent_ledger_complete", "coding_agent_ledger_reopen"]) {
      assert.ok(names.includes(ledger), `ledger tool ${ledger} must be registered`);
    }
    const created = (await client.callTool({
      name: "coding_agent_ledger_project_create",
      arguments: { title: "MCP 项目", workspace: tmpdir() },
    })) as CallToolResult;
    assert.equal(created.isError ?? false, false);
    const summary = (await client.callTool({ name: "coding_agent_ledger_summary", arguments: {} })) as CallToolResult;
    assert.match(JSON.stringify(summary.structuredContent), /MCP 项目/);
    assert.match(JSON.stringify(summary.structuredContent), /不是整体工程完成度/);
  });
});

test("the DONE gate refuses through MCP without a review, with the ledger error code preserved", async () => {
  await withLedgerServer(async (client, store) => {
    const workspace = mkdtempSync(path.join(tmpdir(), "zcode-bridge-ledger-mcp-ws-"));
    try {
      await client.callTool({ name: "coding_agent_ledger_project_create", arguments: { title: "P", workspace } });
      const task = (await client.callTool({
        name: "coding_agent_ledger_task_create",
        arguments: { goal: "g", acceptance_criteria: [{ id: "AC1", text: "x" }], workspace },
      })) as CallToolResult;
      const taskId = (task.structuredContent as { task: { task_id: string } }).task.task_id;
      const complete = (await client.callTool({
        name: "coding_agent_ledger_complete",
        arguments: { task_id: taskId, delivery: { accepted: true, workspace, evidence: "received" } },
      })) as CallToolResult;
      assert.equal(complete.isError, true);
      assert.equal((complete.structuredContent as { error: { code: string } }).error.code, "LEDGER_STATE");
      // The store itself is unchanged by the refused completion.
      assert.equal(store.getTask(taskId).status, "backlog");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
