// Manual MVP end-to-end integration test. It performs one real ZCode model
// invocation through the MCP stdio server and detached worker, using only
// disposable directories under the system temp directory.
//
// Prerequisites: `npm run build`, a working ZCode runtime/provider setup, and
// Python (`python` or the Windows `py -3` launcher) on PATH.
// Usage: `node test/live-integration.mjs` (invokes a real model)
// This is intentionally excluded from `npm test` to avoid model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "dist", "src", "mcp", "main.js");
const taskId = `mvp_add_${Date.now()}`;
const workspacePrefix = "codex-zcode-mvp-workspace-";
const dataPrefix = "codex-zcode-mvp-data-";
const waitTimeoutMs = 15 * 60 * 1000;
const pollIntervalMs = 1_000;
const terminalStates = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);

function pickPython() {
  for (const candidate of [
    { command: "python", prefix: [] },
    { command: "py", prefix: ["-3"] },
  ]) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python was not found; install Python or make `python` / `py -3` available on PATH");
}

function structured(result, operation) {
  if (result?.isError) {
    const text = result.content?.find((block) => block.type === "text")?.text ?? "unknown MCP tool error";
    throw new Error(`${operation} failed: ${text}`);
  }
  if (!result?.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`${operation} returned no structuredContent`);
  }
  return result.structuredContent;
}

function assertDisposablePath(candidate, prefix) {
  const resolved = path.resolve(candidate);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (
    !path.basename(resolved).startsWith(prefix) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`refusing cleanup outside the expected temp directory: ${resolved}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

const python = pickPython();
const workspace = await mkdtemp(path.join(os.tmpdir(), workspacePrefix));
const dataRoot = await mkdtemp(path.join(os.tmpdir(), dataPrefix));
const requestedWorktreePath = path.join(os.tmpdir(), `codex-zcode-mvp-execution-${Date.now()}`);
const taskBranch = `live-e2e-${Date.now()}`;
assertDisposablePath(workspace, workspacePrefix);
assertDisposablePath(dataRoot, dataPrefix);
assertDisposablePath(requestedWorktreePath, "codex-zcode-mvp-execution-");

const verifierSource = [
  "import unittest",
  "from calculator import add",
  "",
  "class CalculatorTests(unittest.TestCase):",
  "    def test_positive_numbers(self):",
  "        self.assertEqual(add(2, 3), 5)",
  "",
  "    def test_negative_numbers(self):",
  "        self.assertEqual(add(-4, 7), 3)",
  "",
  "    def test_zero(self):",
  "        self.assertEqual(add(0, 0), 0)",
  "",
  "if __name__ == '__main__':",
  "    unittest.main()",
  "",
].join("\n");
git(workspace, "init");
git(workspace, "config", "user.name", "Codex ZCode Bridge E2E");
git(workspace, "config", "user.email", "codex-zcode-e2e@localhost");
git(workspace, "config", "core.autocrlf", "false");
await writeFile(path.join(workspace, "README.md"), "baseline\n", "utf8");
git(workspace, "add", "README.md");
git(workspace, "commit", "-m", "temporary integration baseline");
await writeFile(path.join(workspace, "README.md"), "dirty source snapshot\n", "utf8");
git(workspace, "worktree", "add", "-b", taskBranch, requestedWorktreePath, "HEAD");
await writeFile(path.join(requestedWorktreePath, "test_calculator.py"), verifierSource, "utf8");
git(requestedWorktreePath, "config", "user.name", "Codex ZCode Bridge E2E");
git(requestedWorktreePath, "config", "user.email", "codex-zcode-e2e@localhost");
git(requestedWorktreePath, "add", "test_calculator.py");
git(requestedWorktreePath, "commit", "-m", "add integration verifier");
const verifierHashBefore = sha256(verifierSource);
const readmeHashBefore = sha256(await readFile(path.join(workspace, "README.md"), "utf8"));

const client = new Client({ name: "codex-zcode-phase6-check", version: "0.1.0" }, { capabilities: {} });
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
childEnv.ZCODE_BRIDGE_DATA_DIR = dataRoot;
childEnv.PYTHONDONTWRITEBYTECODE = "1";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: repoRoot,
  env: childEnv,
  stderr: "pipe",
});

let stderr = "";
transport.stderr?.setEncoding?.("utf8");
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk).slice(0, Math.max(0, 16_384 - stderr.length));
});

let submitted = false;
let terminalConfirmed = false;
let failure = null;
let resultRecord = null;
let executionWorkspace = null;

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "coding_agent_cancel",
    "coding_agent_continue",
    "coding_agent_events",
    "coding_agent_result",
    "coding_agent_status",
    "coding_agent_task",
  ]);

const providerId = process.env.ZCODE_BRIDGE_E2E_MODEL_PROVIDER_ID?.trim();
const modelId = process.env.ZCODE_BRIDGE_E2E_MODEL_ID?.trim();
if (!providerId || !modelId) {
  throw new Error("Set ZCODE_BRIDGE_E2E_MODEL_PROVIDER_ID and ZCODE_BRIDGE_E2E_MODEL_ID to model IDs available in your local ZCode profile.");
}
const model = { provider_id: providerId, model_id: modelId };
  const testCommand = `${python.command} ${[...python.prefix, "-B", "-m", "unittest", "-v", "test_calculator.py"].join(" ")}`;
  const receipt = structured(
    await client.callTool({
      name: "coding_agent_task",
      arguments: {
        task_id: taskId,
        workspace,
        worktree_path: requestedWorktreePath,
        model,
        objective: "Create calculator.py containing a pure function add(a, b) that returns a + b.",
        requirements: [
          "Create exactly one new file: calculator.py.",
          "Define add(a, b) and return the arithmetic sum of the two inputs.",
          "Do not modify test_calculator.py and do not create any other files.",
        ],
        allowed_paths: ["calculator.py"],
        forbidden_paths: ["test_calculator.py"],
        acceptance_criteria: [
          "calculator.py imports successfully.",
          "The independent test_calculator.py suite passes.",
        ],
        test_commands: [testCommand],
        context: "A test_calculator.py verifier already exists in this temporary project. Implement only the requested module.",
      },
    }),
    "coding_agent_task",
  );
  assert.equal(receipt.task_id, taskId);
  submitted = true;
  console.log("task accepted:", JSON.stringify({ task_id: receipt.task_id, status: receipt.status, model }));

  const initialEvents = structured(
    await client.callTool({ name: "coding_agent_events", arguments: { task_id: taskId, after_seq: 0, wait_ms: 0 } }),
    "coding_agent_events after submission",
  );
  const workspaceEvent = initialEvents.events.find((event) => event.type === "workspace_ready");
  assert.ok(workspaceEvent, "Bridge must return the isolated workspace event");
  assert.equal(workspaceEvent.details.mode, "worktree");
  assert.equal(workspaceEvent.details.worktree_path, requestedWorktreePath);
  assert.equal(workspaceEvent.details.project_path, workspace);
  executionWorkspace = workspaceEvent.details.execution_path;
  assert.equal(executionWorkspace, requestedWorktreePath);
  assert.ok(typeof executionWorkspace === "string" && executionWorkspace.length > 0);
  assert.ok(typeof taskBranch === "string" && taskBranch.length > 0);
  assert.notEqual(executionWorkspace, workspace, "ZCode must not run in the source workspace");
  console.log("isolated worktree:", JSON.stringify({ source: workspace, execution: executionWorkspace, branch: taskBranch }));

  const deadline = Date.now() + waitTimeoutMs;
  let statusRecord;
  while (Date.now() < deadline) {
    statusRecord = structured(
      await client.callTool({ name: "coding_agent_status", arguments: { task_id: taskId } }),
      "coding_agent_status",
    );
    if (terminalStates.has(statusRecord.status)) {
      terminalConfirmed = true;
      break;
    }
    await delay(pollIntervalMs);
  }
  if (!terminalConfirmed) throw new Error(`timed out waiting for task ${taskId}`);

  resultRecord = structured(
    await client.callTool({ name: "coding_agent_result", arguments: { task_id: taskId } }),
    "coding_agent_result",
  );
  const finalEvents = structured(
    await client.callTool({ name: "coding_agent_events", arguments: { task_id: taskId, after_seq: 0, limit: 200, wait_ms: 0 } }),
    "coding_agent_events after completion",
  );
  console.log("bridge result:", JSON.stringify({
    status: resultRecord.status,
    attempt: resultRecord.attempt,
    exit_code: resultRecord.exit_code,
    session_id: resultRecord.session_id,
    error_code: resultRecord.error_code,
    summary: resultRecord.summary,
    needs_master_decision: resultRecord.needs_master_decision,
    files_changed: resultRecord.files_changed,
    tests_reported: resultRecord.tests,
  }, null, 2));

  if (resultRecord.status === "failed") {
    const taskDir = path.join(dataRoot, ".tasks", taskId);
    for (const file of ["stderr.log", path.join("attempts", "1", "outcome.json")]) {
      const filePath = path.join(taskDir, file);
      if (existsSync(filePath)) {
        console.error(`task diagnostic ${file}:\n${await readFile(filePath, "utf8")}`);
      }
    }
  }

  assert.ok(
    resultRecord.status === "completed" || resultRecord.status === "waiting_for_master",
    `ZCode execution failed: ${resultRecord.error_code ?? resultRecord.summary}`,
  );
  assert.equal(resultRecord.exit_code, 0, "ZCode must exit successfully");
  assert.ok(resultRecord.session_id?.startsWith("sess_"), "result must contain a ZCode session id");
  const modelEvent = finalEvents.events.find((event) => event.type === "model_selected");
  assert.ok(modelEvent, "Bridge must confirm the explicitly requested model");
  assert.equal(modelEvent.details.provider_id, model.provider_id);
  assert.equal(modelEvent.details.model_id, model.model_id);

  const calculatorPath = path.join(executionWorkspace, "calculator.py");
  const calculatorSource = await readFile(calculatorPath, "utf8");
  assert.ok(calculatorSource.trim().length > 0, "calculator.py must not be empty");
  const testSourceAfter = await readFile(path.join(executionWorkspace, "test_calculator.py"), "utf8");
  assert.equal(sha256(testSourceAfter), verifierHashBefore, "the verifier file must remain unchanged");
  assert.equal(sha256(await readFile(path.join(workspace, "README.md"), "utf8")), readmeHashBefore, "source workspace must remain unchanged");
  assert.equal(existsSync(path.join(workspace, "calculator.py")), false, "agent output must remain isolated");

  const pythonRun = spawnSync(
    python.command,
    [...python.prefix, "-B", "-m", "unittest", "-v", "test_calculator.py"],
    {
      cwd: executionWorkspace,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const pythonOutput = `${pythonRun.stdout ?? ""}${pythonRun.stderr ?? ""}`;
  console.log("independent Python test output:\n" + pythonOutput.trim());
  if (pythonRun.error) throw pythonRun.error;
  assert.equal(pythonRun.status, 0, `independent Python tests failed (status=${String(pythonRun.status)})`);

  const trackedChanges = git(executionWorkspace, "diff", "--name-only", "HEAD").trim().split(/\r?\n/).filter(Boolean);
  const untrackedFiles = git(executionWorkspace, "ls-files", "--others", "--exclude-standard").trim().split(/\r?\n/).filter(Boolean);
  const changedFiles = [...trackedChanges, ...untrackedFiles].sort();
  assert.deepEqual(changedFiles, ["calculator.py"], "the task worktree diff must contain only the requested module");
  assert.deepEqual(resultRecord.files_changed, ["calculator.py"], "AgentReport must name only the independently observed new file");

  console.log("LIVE_INTEGRATION_OK");
} catch (error) {
  failure = error;
} finally {
  if (submitted && !terminalConfirmed) {
    try {
      const cancel = await client.callTool({ name: "coding_agent_cancel", arguments: { task_id: taskId } });
      const canceledStatus = structured(cancel, "coding_agent_cancel");
      terminalConfirmed = terminalStates.has(canceledStatus.status);
      if (!terminalConfirmed) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const status = structured(
            await client.callTool({ name: "coding_agent_status", arguments: { task_id: taskId } }),
            "coding_agent_status after cancellation",
          );
          if (terminalStates.has(status.status)) {
            terminalConfirmed = true;
            break;
          }
          await delay(250);
        }
      }
    } catch (cancelError) {
      failure ??= new Error(
        `task did not reach a confirmed terminal state; cancellation failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
      );
    }
  }

  await client.close().catch((closeError) => {
    failure ??= closeError;
  });
  if (!submitted || terminalConfirmed) {
    if (executionWorkspace && taskBranch) {
      const worktreeRemoval = spawnSync("git", ["-C", workspace, "worktree", "remove", "--force", executionWorkspace], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      if (worktreeRemoval.error || worktreeRemoval.status !== 0) {
        failure ??= new Error("failed to remove disposable task worktree: " + (worktreeRemoval.stderr ?? worktreeRemoval.error?.message ?? worktreeRemoval.status));
      } else {
        spawnSync("git", ["-C", workspace, "branch", "-D", taskBranch], {
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        });
      }
    }
    assertDisposablePath(workspace, workspacePrefix);
    assertDisposablePath(dataRoot, dataPrefix);
    await rm(workspace, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  } else {
    failure ??= new Error("task termination was not confirmed; preserving the temp workspace and Bridge records");
    console.error("cleanup skipped to avoid deleting files still in use:", JSON.stringify({ workspace, dataRoot }));
  }
}

if (failure) {
  console.error("LIVE_INTEGRATION_FAILED:", failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  if (stderr) console.error("MCP server stderr (bounded):\n" + stderr);
  process.exitCode = 1;
}
