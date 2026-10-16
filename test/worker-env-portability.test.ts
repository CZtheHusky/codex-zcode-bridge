// F1/F2 regression (2026-10-16 cross-environment review): the production
// createWorkerSpawner launches a REAL detached worker process, so assertions
// here cross the actual spawn boundary instead of snapshotting
// createWorkerEnv. The probe worker only records non-sensitive env fields.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkerSpawner } from "../src/manager/spawn-worker.js";

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

function writeProbeWorker(scriptPath: string, receiptPath: string): void {
  writeFileSync(scriptPath, [
    '"use strict";',
    "const fs = require('node:fs');",
    `const receipt = ${JSON.stringify(receiptPath)};`,
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
  try {
    const dataRoot = path.join(dir, "data-root");
    const receiptPath = path.join(dir, "receipt.json");
    const probeWorker = path.join(dir, "probe-worker.cjs");
    writeProbeWorker(probeWorker, receiptPath);
    // An existing absolute file standing in for an explicitly configured browser.
    const fakeExecutable = path.join(dir, "fake-msedge.exe");
    writeFileSync(fakeExecutable, "probe fixture", "utf8");

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
      spawnWorker(dataRoot, "task_env_probe", 1);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without browser settings the worker env stays default-off (keys absent, no broad ZCODE_BRIDGE_ forwarding)", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-worker-env-default-"));
  try {
    const dataRoot = path.join(dir, "data-root");
    const receiptPath = path.join(dir, "receipt.json");
    const probeWorker = path.join(dir, "probe-worker.cjs");
    writeProbeWorker(probeWorker, receiptPath);

    const envBefore = { ...process.env };
    try {
      delete process.env["ZCODE_BRIDGE_BROWSER_USE"];
      delete process.env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"];
      const spawnWorker = createWorkerSpawner({
        name: "worker-env-default-host",
        settingsDirectory: path.join(dir, "settings"),
        workerEntryPath: probeWorker,
      });
      spawnWorker(dataRoot, "task_env_default", 1);
    } finally {
      restoreEnv(envBefore);
    }

    const receipt = await waitForReceipt(receiptPath, 30_000);
    assert.equal(receipt.browser_use, null, "unset browser mode must not arrive as any value (default off)");
    assert.equal(receipt.browser_executable, null, "unset browser executable must not arrive");
    // Only the spawner's own host-profile injection may appear: forwarding must
    // stay an explicit key list, not a ZCODE_BRIDGE_* namespace copy.
    assert.deepEqual(receipt.zcode_bridge_keys, ["ZCODE_BRIDGE_HOST_PROFILE"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
