// Manual live E2E for simultaneous sessions across two project roots.
// Requires a configured ZCode runtime and an entitled coding-plan model.
// Usage: node test/live-parallel.mjs (invokes real models)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "dist", "src", "mcp", "main.js");
const model = { provider_id: "account:bigmodel-individual-coding-plan", model_id: "GLM-5.3-Flash" };
const suffix = Date.now().toString(36);
const taskIds = [`PARALLEL_A_${suffix}`, `PARALLEL_B_${suffix}`];
const workspacePrefix = "codex-zcode-parallel-workspace-";
const dataPrefix = "codex-zcode-parallel-data-";
const timeoutMs = 15 * 60 * 1000;
const terminal = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const workspaces = [];
let dataRoot;
let worktreeFixtureRoot;
let client;
let submitted = [];
let terminalConfirmed = new Set();
let failure;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function structured(result, label) {
  if (result?.isError) throw new Error(`${label}: ${result.content?.[0]?.text ?? "MCP tool error"}`);
  if (!result?.structuredContent) throw new Error(`${label}: missing structured result`);
  return result.structuredContent;
}
function assertDesktopRegistered(events, taskId) {
  const registered = events.events.some((event) => event.type === "desktop_task_registered");
  const warning = events.events.find((event) => event.type === "desktop_task_index_warning");
  assert.ok(registered, `Desktop task index registration did not succeed for ${taskId}${warning ? `: ${warning.summary}` : ""}`);
}
function assertTempPath(candidate, prefix) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(tmpdir()), resolved);
  if (!path.basename(resolved).startsWith(prefix) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing cleanup outside expected temp root: ${resolved}`);
  }
}
async function tool(name, args) {
  return structured(await client.callTool({ name, arguments: args }), name);
}
async function getStatus(taskId) { return tool("coding_agent_status", { task_id: taskId }); }
async function getEvents(taskId) { return tool("coding_agent_events", { task_id: taskId, after_seq: 0, limit: 200, wait_ms: 0 }); }

try {
  dataRoot = await mkdtemp(path.join(tmpdir(), dataPrefix));
  assertTempPath(dataRoot, dataPrefix);
  for (const _ of taskIds) {
    const workspace = await mkdtemp(path.join(tmpdir(), workspacePrefix));
    assertTempPath(workspace, workspacePrefix);
    workspaces.push(workspace);
  }

  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  env.ZCODE_BRIDGE_DATA_DIR = dataRoot;
  env.ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS = "2";
  env.PYTHONDONTWRITEBYTECODE = "1";
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: repoRoot, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.setEncoding?.("utf8");
  transport.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_384); });
  client = new Client({ name: "codex-zcode-bridge-parallel-e2e", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const receipts = [];
  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index];
    submitted.push(taskId);
    const receipt = await tool("coding_agent_task", {
      task_id: taskId,
      workspace: workspaces[index],
      model,
      objective: `Create exactly one file named parallel-probe.txt containing the single line ZCODE_PARALLEL_${index === 0 ? "A" : "B"}_OK.`,
      requirements: ["Create only parallel-probe.txt in this workspace.", "Do not run commands, tests, or install dependencies."],
      allowed_paths: ["parallel-probe.txt"],
      forbidden_paths: [],
      acceptance_criteria: ["The file content exactly matches the requested line."],
      test_commands: [],
    });
    receipts.push(receipt);
  }

  assert.deepEqual(receipts.map((receipt) => receipt.status), ["running", "running"], "both sessions should start without queueing");
  const simultaneousStatuses = await Promise.all(taskIds.map(getStatus));
  assert.ok(simultaneousStatuses.every((status) => status.status === "running"), "both worker processes should overlap in running state");
  assert.notEqual(simultaneousStatuses[0].worker_pid, simultaneousStatuses[1].worker_pid, "each task must have its own worker process");
  console.log("concurrent workers started:", JSON.stringify({
    task_ids: taskIds,
    worker_pids: simultaneousStatuses.map((status) => status.worker_pid),
    provider_id: model.provider_id,
    model_id: model.model_id,
  }));

  const deadline = Date.now() + timeoutMs;
  let statuses = simultaneousStatuses;
  while (Date.now() < deadline && !statuses.every((status) => terminal.has(status.status))) {
    await delay(1_000);
    statuses = await Promise.all(taskIds.map(getStatus));
  }
  if (!statuses.every((status) => terminal.has(status.status))) throw new Error("timed out waiting for both parallel sessions");
  terminalConfirmed = new Set(taskIds);

  const outcomes = [];
  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index];
    const result = await tool("coding_agent_result", { task_id: taskId });
    const events = await getEvents(taskId);
    const selected = events.events.find((event) => event.type === "model_selected");
    assertDesktopRegistered(events, taskId);
    assert.equal(result.status, "completed", `task ${taskId} failed: ${result.error_code ?? result.summary}`);
    assert.equal(result.exit_code, 0);
    assert.ok(result.session_id, "ZCode session id must be recorded");
    assert.equal(selected?.details?.provider_id, model.provider_id);
    assert.equal(selected?.details?.model_id, model.model_id);

    const filePath = path.join(workspaces[index], "parallel-probe.txt");
    assert.ok(existsSync(filePath), `missing output from ${taskId}`);
    const expected = `ZCODE_PARALLEL_${index === 0 ? "A" : "B"}_OK`;
    const content = await readFile(filePath, "utf8");
    assert.ok(content === expected || content === `${expected}\n`, `unexpected output content for ${taskId}`);
    assert.deepEqual(await readdir(workspaces[index]), ["parallel-probe.txt"], "workspace must contain only the requested file");
    outcomes.push({ task_id: taskId, session_id: result.session_id, status: result.status, model: selected.details.model_id });
  }
  assert.notEqual(outcomes[0].session_id, outcomes[1].session_id, "parallel tasks must use distinct ZCode sessions");
  console.log("PARALLEL_E2E_OK", JSON.stringify(outcomes));

  // Repeat the overlap test for two sessions belonging to one project, using
  // real sibling Git worktrees prepared by this test harness (not by Bridge).
  worktreeFixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-zcode-worktree-e2e-"));
  assertTempPath(worktreeFixtureRoot, "codex-zcode-worktree-e2e-");
  const sourceProject = path.join(worktreeFixtureRoot, "source");
  const worktreeA = path.join(worktreeFixtureRoot, "worktree-a");
  const worktreeB = path.join(worktreeFixtureRoot, "worktree-b");
  mkdirSync(sourceProject);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  git(sourceProject, "init");
  git(sourceProject, "config", "user.name", "Codex ZCode Bridge parallel E2E");
  git(sourceProject, "config", "user.email", "codex-zcode-parallel-e2e@localhost");
  await writeFile(path.join(sourceProject, "README.md"), "temporary parallel session baseline\n", "utf8");
  git(sourceProject, "add", "README.md");
  git(sourceProject, "commit", "-m", "parallel E2E baseline");
  git(sourceProject, "worktree", "add", "-b", `parallel-e2e-a-${suffix}`, worktreeA, "HEAD");
  git(sourceProject, "worktree", "add", "-b", `parallel-e2e-b-${suffix}`, worktreeB, "HEAD");

  const worktreeTaskIds = [`PARALLEL_WTA_${suffix}`, `PARALLEL_WTB_${suffix}`];
  const worktreePaths = [worktreeA, worktreeB];
  const worktreeReceipts = [];
  for (let index = 0; index < worktreeTaskIds.length; index += 1) {
    const taskId = worktreeTaskIds[index];
    submitted.push(taskId);
    worktreeReceipts.push(await tool("coding_agent_task", {
      task_id: taskId,
      workspace: sourceProject,
      worktree_path: worktreePaths[index],
      model,
      objective: `Create exactly one file named parallel-probe.txt containing the single line ZCODE_WORKTREE_PARALLEL_${index === 0 ? "A" : "B"}_OK.`,
      requirements: ["Create only parallel-probe.txt in the supplied worktree.", "Do not run commands, tests, or install dependencies."],
      allowed_paths: ["parallel-probe.txt"],
      forbidden_paths: ["README.md"],
      acceptance_criteria: ["The new file contains exactly the requested line."],
      test_commands: [],
    }));
  }
  assert.deepEqual(worktreeReceipts.map((receipt) => receipt.status), ["running", "running"]);
  let worktreeStatuses = await Promise.all(worktreeTaskIds.map(getStatus));
  assert.ok(worktreeStatuses.every((status) => status.status === "running"));
  assert.notEqual(worktreeStatuses[0].worker_pid, worktreeStatuses[1].worker_pid);
  const worktreeDeadline = Date.now() + timeoutMs;
  while (Date.now() < worktreeDeadline && !worktreeStatuses.every((status) => terminal.has(status.status))) {
    await delay(1_000);
    worktreeStatuses = await Promise.all(worktreeTaskIds.map(getStatus));
  }
  if (!worktreeStatuses.every((status) => terminal.has(status.status))) throw new Error("timed out waiting for same-project worktree sessions");
  for (const taskId of worktreeTaskIds) terminalConfirmed.add(taskId);

  const worktreeOutcomes = [];
  for (let index = 0; index < worktreeTaskIds.length; index += 1) {
    const taskId = worktreeTaskIds[index];
    const result = await tool("coding_agent_result", { task_id: taskId });
    const events = await getEvents(taskId);
    const selected = events.events.find((event) => event.type === "model_selected");
    assertDesktopRegistered(events, taskId);
    assert.equal(result.status, "completed", `task ${taskId} failed: ${result.error_code ?? result.summary}`);
    assert.equal(selected?.details?.model_id, model.model_id);
    assert.ok(result.session_id);
    const outputFile = path.join(worktreePaths[index], "parallel-probe.txt");
    assert.ok(existsSync(outputFile), `missing output in ${worktreePaths[index]}`);
    const expected = `ZCODE_WORKTREE_PARALLEL_${index === 0 ? "A" : "B"}_OK`;
    const content = await readFile(outputFile, "utf8");
    assert.ok(content === expected || content === `${expected}\n`);
    assert.deepEqual(git(worktreePaths[index], "status", "--porcelain").trim().split(/\r?\n/u), ["?? parallel-probe.txt"]);
    worktreeOutcomes.push({ task_id: taskId, session_id: result.session_id, execution_path: worktreePaths[index] });
  }
  assert.notEqual(worktreeOutcomes[0].session_id, worktreeOutcomes[1].session_id);
  assert.equal(existsSync(path.join(sourceProject, "parallel-probe.txt")), false, "outputs must remain isolated from the shared source project");
  console.log("SAME_PROJECT_WORKTREE_PARALLEL_E2E_OK", JSON.stringify(worktreeOutcomes));
} catch (error) {
  failure = error;
} finally {
  if (client && submitted.some((taskId) => !terminalConfirmed.has(taskId))) {
    for (const taskId of submitted.filter((id) => !terminalConfirmed.has(id))) {
      try {
        const status = await getStatus(taskId);
        if (!terminal.has(status.status)) {
          const cancelled = await tool("coding_agent_cancel", { task_id: taskId });
          if (terminal.has(cancelled.status)) terminalConfirmed.add(taskId);
        } else terminalConfirmed.add(taskId);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (client) await client.close().catch((error) => { failure ??= error; });
  if (terminalConfirmed.size === submitted.length) {
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
    if (worktreeFixtureRoot) await rm(worktreeFixtureRoot, { recursive: true, force: true });
  } else {
    console.error("preserving task evidence because terminal state could not be confirmed", JSON.stringify({ dataRoot, workspaces, stderr }));
  }
}

if (failure) {
  console.error("PARALLEL_E2E_FAILED:", failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  process.exitCode = 1;
} else {
  console.log("parallel E2E passed; task data and disposable workspaces removed");
}
