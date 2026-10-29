// Protocol-level ADR-010 scheduling tool tests over InMemoryTransport: the
// four tools exist ONLY when a schedule controller is injected; without it
// the frozen 13-tool surface is unchanged. Schedule errors map onto MCP tool
// error results; strict schemas reject malformed inputs before dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { scheduleReceiptSchema, scheduleStatusSchema } from "../src/mcp/schemas.js";
import { createBridgeServer } from "../src/mcp/server.js";
import { ScheduleController } from "../src/schedule/controller.js";
import { makeScheduleFixture, ScriptedManager, scheduleTaskPackage, THREAD_ID } from "./schedule-helpers.js";

const FROZEN_TOOLS = [
  "coding_agent_cancel", "coding_agent_clear_default_model", "coding_agent_continue", "coding_agent_default_model",
  "coding_agent_doctor", "coding_agent_events", "coding_agent_feedback", "coding_agent_interaction_reply",
  "coding_agent_model_catalog", "coding_agent_result", "coding_agent_set_default_model", "coding_agent_status", "coding_agent_task",
];

async function withClient(server: McpServer, run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schedule-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function toolNames(client: Client): Promise<string[]> {
  const list = await client.listTools();
  return list.tools.map((tool) => tool.name).sort();
}

test("without injected scheduling the frozen 13-tool surface is unchanged", async () => {
  const server = createBridgeServer({ taskManager: new ScriptedManager() });
  await withClient(server, async (client) => {
    assert.deepEqual(await toolNames(client), FROZEN_TOOLS);
  });
});

test("injected scheduling registers exactly the four additional tools", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = new ScheduleController({
      store: fixture.store,
      manager: fixture.manager,
      supervisor: fixture.supervisor,
      runnerEntryPath: "/runner/schedule-runner.mjs",
      dataRoot: fixture.dataRoot,
      env: {},
    });
    const server = createBridgeServer({
      taskManager: fixture.manager,
      schedule: { controller, appPipeSource: () => "/tmp/app.pipe" },
    });
    await withClient(server, async (client) => {
      assert.deepEqual(await toolNames(client), [...FROZEN_TOOLS, "coding_agent_schedule", "coding_agent_schedule_cancel", "coding_agent_schedule_review", "coding_agent_schedule_status"].sort());
      assert.match(client.getInstructions()!, /coding_agent_schedule/);
      assert.match(client.getInstructions()!, /Linux with user systemd/);
      assert.match(client.getInstructions()!, /original thread_id/);
      const receipt = await client.callTool({
        name: "coding_agent_schedule",
        arguments: { task: scheduleTaskPackage(), start_at: "2026-10-27T12:00:00+08:00", thread_id: THREAD_ID },
      });
      assert.equal(receipt.isError, undefined);
      const structured = scheduleReceiptSchema.parse(receipt.structuredContent);
      assert.equal(structured.task_id, "goal_1");
      assert.equal(structured.status, "scheduled");
      assert.equal(structured.supervisor?.unit, fixture.store.readSpec("goal_1").supervisor_unit);
      assert.equal(fixture.store.readRuntime()?.app_pipe_path, "/tmp/app.pipe", "each call refreshes the pipe location");
      const status = await client.callTool({ name: "coding_agent_schedule_status", arguments: { task_id: "goal_1" } });
      const statusView = scheduleStatusSchema.parse(status.structuredContent);
      assert.equal(statusView.schedule.status, "scheduled");
      assert.equal(statusView.execution, null, "no Bridge task exists before start_at");
      await controller.dispatch("goal_1");
      const active = await client.callTool({ name: "coding_agent_schedule_status", arguments: { task_id: "goal_1" } });
      assert.equal(active.isError, undefined, "an unfinished result must satisfy the output schema with a null decision verdict");
      const activeView = scheduleStatusSchema.parse(active.structuredContent);
      assert.equal(activeView.execution?.needs_master_decision, null);
      const cancelled = await client.callTool({ name: "coding_agent_schedule_cancel", arguments: { task_id: "goal_1" } });
      assert.equal(cancelled.isError, undefined, "cancellation must return its declared task_id in the MCP result");
      assert.deepEqual(cancelled.structuredContent, { task_id: "goal_1", schedule_status: "cancelled", task_status: "cancelled" });
    });
  } finally {
    await fixture.cleanup();
  }
});

test("schedule tool inputs are validated before reaching the controller", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = new ScheduleController({
      store: fixture.store,
      manager: fixture.manager,
      supervisor: fixture.supervisor,
      runnerEntryPath: "/runner/schedule-runner.mjs",
      dataRoot: fixture.dataRoot,
      env: {},
    });
    const server = createBridgeServer({ taskManager: fixture.manager, schedule: { controller } });
    await withClient(server, async (client) => {
      const noTimezone = await client.callTool({
        name: "coding_agent_schedule",
        arguments: { task: scheduleTaskPackage(), start_at: "2026-10-27T12:00:00", thread_id: THREAD_ID },
      });
      assert.equal(noTimezone.isError, true, "start_at without a timezone must be rejected");
      const badThread = await client.callTool({
        name: "coding_agent_schedule",
        arguments: { task: scheduleTaskPackage(), start_at: "2026-10-27T12:00:00Z", thread_id: "guess" },
      });
      assert.equal(badThread.isError, true);
      const extraField = await client.callTool({
        name: "coding_agent_schedule_status",
        arguments: { task_id: "goal_1", unexpected: true },
      });
      assert.equal(extraField.isError, true, "unknown fields are rejected");
      assert.equal(fixture.supervisor.plans.length, 0, "nothing started for invalid inputs");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("schedule errors surface as MCP tool errors with stable codes", async () => {
  const fixture = await makeScheduleFixture();
  try {
    const controller = new ScheduleController({
      store: fixture.store,
      manager: fixture.manager,
      supervisor: fixture.supervisor,
      runnerEntryPath: "/runner/schedule-runner.mjs",
      dataRoot: fixture.dataRoot,
      env: {},
    });
    const server = createBridgeServer({ taskManager: fixture.manager, schedule: { controller } });
    await withClient(server, async (client) => {
      const unknown = await client.callTool({ name: "coding_agent_schedule_status", arguments: { task_id: "ghost" } });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /SCHEDULE_NOT_FOUND/);
      const cancelled = await client.callTool({ name: "coding_agent_schedule_cancel", arguments: { task_id: "ghost" } });
      assert.equal(cancelled.isError, true);
      assert.match(cancelled.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /SCHEDULE_NOT_FOUND/);
    });
  } finally {
    await fixture.cleanup();
  }
});
