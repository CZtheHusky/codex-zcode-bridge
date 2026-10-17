// F1/F2 regression (2026-10-16 cross-environment review): the production
// createWorkerSpawner launches a REAL detached worker process, so assertions
// here cross the actual spawn boundary instead of snapshotting
// createWorkerEnv. The probe worker only records non-sensitive env fields.
// Fixture lifecycle (2026-10-17 matrix2 review): receipt is not exit — the
// detached worker's cwd is the fixture data root, so the tree may only be
// removed after the owned pid is confirmed exited. The probe watches a
// release file and the shared cleanupOwnedProcessFixture gate performs the
// release, exit confirmation, and gated tree removal on every path.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkerSpawner } from "../src/manager/spawn-worker.js";
import { cleanupOwnedProcessFixture } from "./helpers.js";
import { isProcessRunning } from "../src/adapters/process-spawn.js";

interface ProbeReceipt {
  browser_use: string | null;
  browser_executable: string | null;
  secret_probe: string | null;
  unrelated_secret: string | null;
  programfiles: string | null;
  programfiles_x86: string | null;
  zcode_bridge_keys: string[];
}

/** Case-insensitive lookup matching Windows env semantics for plain objects. */
function envLookup(entries: Record<string, string | undefined>, key: string): string | null {
  for (const [name, value] of Object.entries(entries)) {
    if (name.toUpperCase() === key && typeof value === "string" && value !== "") return value;
  }
  return null;
}

function writeProbeWorker(scriptPath: string, receiptPath: string, releasePath: string): void {
  writeFileSync(scriptPath, [
    '"use strict";',
    "const fs = require('node:fs');",
    `const receipt = ${JSON.stringify(receiptPath)};`,
    `const release = ${JSON.stringify(releasePath)};`,
    "function lookup(key) {",
    "  for (const [name, value] of Object.entries(process.env)) {",
    "    if (name.toUpperCase() === key && typeof value === 'string' && value !== '') return value;",
    "  }",
    "  return null;",
    "}",
    "const snapshot = {",
    "  browser_use: lookup('ZCODE_BRIDGE_BROWSER_USE'),",
    "  browser_executable: lookup('ZCODE_BRIDGE_BROWSER_EXECUTABLE'),",
    "  secret_probe: lookup('ZCODE_BRIDGE_SECRET_PROBE'),",
    "  unrelated_secret: lookup('BRIDGE_TEST_UNRELATED_SECRET'),",
    "  programfiles: lookup('PROGRAMFILES'),",
    "  programfiles_x86: lookup('PROGRAMFILES(X86)'),",
    "  zcode_bridge_keys: Object.keys(process.env).filter((name) => name.startsWith('ZCODE_BRIDGE_')).sort(),",
    "};",
    "fs.writeFileSync(receipt, JSON.stringify(snapshot, null, 2));",
    "// Receipt is not exit: stay alive (holding the fixture cwd) until the",
    "// test's cooperative release file appears, then exit cleanly.",
    "function watchRelease() { if (fs.existsSync(release)) process.exit(0); setTimeout(watchRelease, 50); }",
    "watchRelease();",
  ].join("\n"), "utf8");
}

async function waitForReceipt(receiptPath: string, timeoutMs: number): Promise<ProbeReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(readFileSync(receiptPath, "utf8")) as ProbeReceipt;
    } catch {
      if (Date.now() > deadline) throw new Error(`probe worker receipt not written within ${timeoutMs} ms: ${receiptPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

test("a real detached worker receives env-only browser settings while secrets stay filtered", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-worker-env-probe-"));
  const dataRoot = path.join(dir, "data-root");
  const receiptPath = path.join(dir, "receipt.json");
  const releasePath = path.join(dir, "release");
  const probeWorker = path.join(dir, "probe-worker.cjs");
  writeProbeWorker(probeWorker, receiptPath, releasePath);
  // An existing absolute file standing in for an explicitly configured browser.
  const fakeExecutable = path.join(dir, "fake-msedge.exe");
  writeFileSync(fakeExecutable, "probe fixture", "utf8");

  let workerPid: number | null = null;
  let primaryFailed = false;
  try {
    const envBefore = { ...process.env };
    try {
      process.env["ZCODE_BRIDGE_BROWSER_USE"] = "headless";
      process.env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"] = fakeExecutable;
      process.env["ZCODE_BRIDGE_SECRET_PROBE"] = "must-not-leak";
      process.env["BRIDGE_TEST_UNRELATED_SECRET"] = "must-not-leak";
      if (process.platform === "win32") {
        // Real Windows casing, values that differ per variable so a mixed-up
        // forward cannot pass. Auto-discovery needs these directory roots.
        process.env["ProgramFiles"] = path.join(dir, "Program Files");
        process.env["ProgramFiles(x86)"] = path.join(dir, "Program Files (x86)");
      }
      const spawnWorker = createWorkerSpawner({
        name: "worker-env-probe-host",
        settingsDirectory: path.join(dir, "settings"),
        workerEntryPath: probeWorker,
      });
      workerPid = spawnWorker(dataRoot, "task_env_probe", 1).pid;
    } finally {
      restoreEnv(envBefore);
    }

    const receipt = await waitForReceipt(receiptPath, 30_000);
    assert.equal(receipt.browser_use, "headless", "env-only ZCODE_BRIDGE_BROWSER_USE must reach the detached worker");
    assert.equal(receipt.browser_executable, fakeExecutable, "env-only ZCODE_BRIDGE_BROWSER_EXECUTABLE must reach the detached worker");
    assert.equal(receipt.secret_probe, null, "an arbitrary ZCODE_BRIDGE_ secret must not reach the worker");
    assert.equal(receipt.unrelated_secret, null, "an arbitrary non-Bridge secret must not reach the worker");
    if (process.platform === "win32") {
      assert.equal(receipt.programfiles, path.join(dir, "Program Files"), "ProgramFiles must survive the worker env filter (browser auto-discovery)");
      assert.equal(receipt.programfiles_x86, path.join(dir, "Program Files (x86)"), "ProgramFiles(x86) must survive the worker env filter (browser auto-discovery)");
    }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await cleanupOwnedProcessFixture({ pids: workerPid === null ? [] : [workerPid], releasePath, dir, primaryFailed });
  }
});

test("without browser settings the worker env stays default-off (keys absent, no broad ZCODE_BRIDGE_ forwarding)", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-worker-env-default-"));
  const dataRoot = path.join(dir, "data-root");
  const receiptPath = path.join(dir, "receipt.json");
  const releasePath = path.join(dir, "release");
  const probeWorker = path.join(dir, "probe-worker.cjs");
  writeProbeWorker(probeWorker, receiptPath, releasePath);

  let workerPid: number | null = null;
  let primaryFailed = false;
  try {
    const envBefore = { ...process.env };
    try {
      delete process.env["ZCODE_BRIDGE_BROWSER_USE"];
      delete process.env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"];
      const spawnWorker = createWorkerSpawner({
        name: "worker-env-default-host",
        settingsDirectory: path.join(dir, "settings"),
        workerEntryPath: probeWorker,
      });
      workerPid = spawnWorker(dataRoot, "task_env_default", 1).pid;
    } finally {
      restoreEnv(envBefore);
    }

    const receipt = await waitForReceipt(receiptPath, 30_000);
    assert.equal(receipt.browser_use, null, "unset browser mode must not arrive as any value (default off)");
    assert.equal(receipt.browser_executable, null, "unset browser executable must not arrive");
    // Only the spawner's own host-profile injection may appear: forwarding must
    // stay an explicit key list, not a ZCODE_BRIDGE_* namespace copy.
    assert.deepEqual(receipt.zcode_bridge_keys, ["ZCODE_BRIDGE_HOST_PROFILE"]);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await cleanupOwnedProcessFixture({ pids: workerPid === null ? [] : [workerPid], releasePath, dir, primaryFailed });
  }
});

test("receipt is not exit: a held real worker is confirmed exited before its fixture tree is removed", { timeout: 60_000 }, async () => {
  // Deterministic lifecycle regression for the Windows22 matrix2 EBUSY: the
  // controlled proof held a real detached worker alive after its receipt and
  // reproduced EBUSY on rmdir of the data root. Here the worker provably
  // stays alive after its receipt (it awaits the release file), then the
  // gated cleanup confirms exit and removes the tree — never the reverse
  // order.
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-worker-env-held-"));
  const dataRoot = path.join(dir, "data-root");
  const receiptPath = path.join(dir, "receipt.json");
  const releasePath = path.join(dir, "release");
  const probeWorker = path.join(dir, "probe-worker.cjs");
  writeProbeWorker(probeWorker, receiptPath, releasePath);

  let workerPid: number | null = null;
  let primaryFailed = false;
  let settledByPrimaryCleanup = false;
  try {
    const envBefore = { ...process.env };
    try {
      delete process.env["ZCODE_BRIDGE_BROWSER_USE"];
      delete process.env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"];
      const spawnWorker = createWorkerSpawner({
        name: "worker-env-held-host",
        settingsDirectory: path.join(dir, "settings"),
        workerEntryPath: probeWorker,
      });
      workerPid = spawnWorker(dataRoot, "task_env_held", 1).pid;
    } finally {
      restoreEnv(envBefore);
    }
    assert.ok(workerPid !== null, "the spawner must report the owned worker pid");

    const receipt = await waitForReceipt(receiptPath, 30_000);
    assert.ok(receipt, "the held worker wrote its receipt");
    assert.equal(isProcessRunning(workerPid), true, "receipt is not exit: the held worker is still alive in its fixture cwd");
    await cleanupOwnedProcessFixture({ pids: [workerPid], releasePath, dir, primaryFailed: false, timeoutMs: 15_000 });
    assert.equal(isProcessRunning(workerPid), false, "the owned worker reports exited after the release signal");
    assert.equal(existsSync(dir), false, "the fixture tree is removed only after the exit confirmation");
    settledByPrimaryCleanup = true; // the inner gated call reaped the worker and removed the tree
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (!settledByPrimaryCleanup) {
      await cleanupOwnedProcessFixture({ pids: workerPid === null ? [] : [workerPid], releasePath, dir, primaryFailed });
    }
  }
});
