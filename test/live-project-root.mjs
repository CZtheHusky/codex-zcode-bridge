// Local manual E2E: verify a session is indexed under this project's actual
// workspace root while the task executes in a Codex-selected external worktree.
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
const taskId = `PROJECT_ROOT_VISIBILITY_${suffix}`;
const fileName = "zcode-project-root-e2e-probe.txt";
const expectedContent = `PROJECT_ROOT_E2E_${suffix}`;
const timeoutMs = 15 * 60 * 1000;
const terminal = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const tempParent = await mkdtemp(path.join(tmpdir(), "codex-zcode-project-root-e2e-"));
const worktreePath = path.join(tempParent, "worktree");
const dataRoot = await mkdtemp(path.join(tmpdir(), "codex-zcode-project-data-"));
const branch = `project-root-e2e-${suffix}`;
const sourceStatus = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" });
let client;
let submitted = false;
let terminalConfirmed = false;
let worktreeCreated = false;
let failure;

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}
function assertTempChild(candidate, prefix) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(tmpdir()), resolved);
  if (!path.basename(resolved).startsWith(prefix) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing cleanup outside temp root: ${resolved}`);
  }
}
function structured(result, label) {
  if (result?.isError) throw new Error(`${label}: ${result.content?.[0]?.text ?? "MCP tool error"}`);
  if (!result?.structuredContent) throw new Error(`${label}: missing structured content`);
  return result.structuredContent;
}
async function tool(name, args) {
  return structured(await client.callTool({ name, arguments: args }), name);
}
async function status() { return tool("coding_agent_status", { task_id: taskId }); }
async function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

try {
  assertTempChild(tempParent, "codex-zcode-project-root-e2e-");
  assertTempChild(dataRoot, "codex-zcode-project-data-");
  git(repoRoot, "worktree", "add", "-b", branch, worktreePath, "HEAD");
  worktreeCreated = true;

  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
  childEnv.ZCODE_BRIDGE_DATA_DIR = dataRoot;
  childEnv.PYTHONDONTWRITEBYTECODE = "1";
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: repoRoot, env: childEnv, stderr: "pipe" });
  client = new Client({ name: "codex-zcode-project-root-e2e", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const receipt = await tool("coding_agent_task", {
    task_id: taskId,
    workspace: repoRoot,
    worktree_path: worktreePath,
    model,
    objective: `Create exactly one file named ${fileName} containing the single line ${expectedContent}.`,
    requirements: ["Create only the requested file in the supplied worktree.", "Do not run commands, tests, or install dependencies."],
    allowed_paths: [fileName],
    forbidden_paths: [],
    acceptance_criteria: ["The new file has the exact requested content."],
    test_commands: [],
  });
  submitted = true;

  const initialEvents = await tool("coding_agent_events", { task_id: taskId, after_seq: 0, wait_ms: 0 });
  const workspaceEvent = initialEvents.events.find((event) => event.type === "workspace_ready");
  assert.ok(workspaceEvent, "workspace_ready event is missing");
  assert.equal(workspaceEvent.details.project_path, repoRoot, "Desktop project identity must use this project root");
  assert.equal(workspaceEvent.details.execution_path, worktreePath, "ZCode must use the supplied worktree");
  assert.equal(workspaceEvent.details.mode, "worktree");
  console.log("task started:", JSON.stringify({ task_id: taskId, receipt_status: receipt.status, workspace: repoRoot, execution_path: worktreePath, model }));

  const deadline = Date.now() + timeoutMs;
  let current = await status();
  while (!terminal.has(current.status) && Date.now() < deadline) {
    await delay(1_000);
    current = await status();
  }
  assert.ok(terminal.has(current.status), "timed out waiting for the task");
  terminalConfirmed = true;

  const result = await tool("coding_agent_result", { task_id: taskId });
  const events = await tool("coding_agent_events", { task_id: taskId, after_seq: 0, limit: 200, wait_ms: 0 });
  assert.equal(result.status, "completed", `${result.error_code ?? result.summary}`);
  assert.equal(result.exit_code, 0);
  assert.ok(result.session_id);
  assert.ok(events.events.some((event) => event.type === "desktop_task_registered"), "session must be indexed by ZCode Desktop");
  const selected = events.events.find((event) => event.type === "model_selected");
  assert.equal(selected?.details?.provider_id, model.provider_id);
  assert.equal(selected?.details?.model_id, model.model_id);
  const outputPath = path.join(worktreePath, fileName);
  assert.ok(existsSync(outputPath));
  const content = (await readFile(outputPath, "utf8")).trim();
  assert.equal(content, expectedContent);
  assert.deepEqual((await readdir(worktreePath)).filter((name) => name === fileName), [fileName]);
  assert.deepEqual(git(worktreePath, "status", "--porcelain").trim().split(/\r?\n/u), [`?? ${fileName}`]);
  assert.equal(git(repoRoot, "status", "--porcelain"), sourceStatus, "the Codex project checkout must remain unchanged");
  console.log("PROJECT_ROOT_E2E_OK", JSON.stringify({ task_id: taskId, session_id: result.session_id, status: result.status, model: selected.details.model_id, indexed_project: repoRoot }));
} catch (error) {
  failure = error;
} finally {
  if (client && submitted && !terminalConfirmed) {
    try {
      const canceled = await tool("coding_agent_cancel", { task_id: taskId });
      terminalConfirmed = terminal.has(canceled.status);
      const deadline = Date.now() + 30_000;
      while (!terminalConfirmed && Date.now() < deadline) {
        const current = await status();
        terminalConfirmed = terminal.has(current.status);
        if (!terminalConfirmed) await delay(500);
      }
    } catch (error) { failure ??= error; }
  }
  if (client) await client.close().catch((error) => { failure ??= error; });
  if (!submitted || terminalConfirmed) {
    if (worktreeCreated) {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
      execFileSync("git", ["-C", repoRoot, "branch", "-D", branch], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
    }
    assertTempChild(tempParent, "codex-zcode-project-root-e2e-");
    assertTempChild(dataRoot, "codex-zcode-project-data-");
    await rm(tempParent, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  } else {
    failure ??= new Error("task is not confirmed terminal; preserving its temporary workspace and Bridge records");
    console.error("cleanup skipped; inspect task before removing:", JSON.stringify({ taskId, worktreePath, dataRoot }));
  }
}

if (failure) {
  console.error("PROJECT_ROOT_E2E_FAILED:", failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  process.exitCode = 1;
}
