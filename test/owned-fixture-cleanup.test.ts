// Gated fixture-teardown regressions for cleanupOwnedProcessFixture
// (2026-10-17 matrix2 review): the helper must confirm OWNED child exit
// before removing the fixture tree, and any release/exit-confirmation
// failure must preserve the tree and fail visibly instead of deleting
// around a live child. The refusing-child scenarios are controlled — the
// child ignores the release file on purpose so the gate's timeout branch is
// deterministic; afterwards the test stops its OWN child handle (kill
// first, then a bounded close confirmation) and never deletes the tree when
// the stop cannot be confirmed.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupOwnedProcessFixture, TEMP_TREE_REMOVE_OPTIONS } from "./helpers.js";
import { isProcessRunning } from "../src/adapters/process-spawn.js";

/** A real child of THIS test: writes a ready receipt from its fixture cwd,
 * then either watches the release file (cooperative) or keeps running
 * (refusing) so the gate's timeout branch is deterministic. */
function spawnFixtureChild(dir: string, options: { cooperative: boolean }): {
  child: ChildProcess;
  release: string;
  ready: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const script = path.join(dir, options.cooperative ? "cooperative.cjs" : "refusing.cjs");
  const release = path.join(dir, "release");
  const ready = path.join(dir, "ready.json");
  writeFileSync(script, [
    '"use strict";',
    "const fs = require('node:fs');",
    `const release = ${JSON.stringify(release)};`,
    `const ready = ${JSON.stringify(ready)};`,
    "fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));",
    options.cooperative
      ? "function watch() { if (fs.existsSync(release)) process.exit(0); setTimeout(watch, 25); } watch();"
      : "setInterval(() => undefined, 1_000);",
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: "ignore", windowsHide: true });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.once("error", () => { /* surfaced through the bounded close wait */ });
  return { child, release, ready, closed };
}

const waitForReady = async (ready: string, timeoutMs: number): Promise<{ pid: number; cwd: string }> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(ready, "utf8")) as { pid: number; cwd: string };
    } catch {
      if (Date.now() >= deadline) throw new Error(`fixture child did not write its ready receipt within ${String(timeoutMs)} ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

/** Stop this test's OWN child handle: deliver the kill signal first, then
 * CONFIRM the close event within the bound. A kill delivery failure or a
 * close timeout throws — the test fails and the caller keeps the tree. */
const stopFixtureChild = async (child: ChildProcess, closed: Promise<unknown>, timeoutMs = 5_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
  const signalled = child.kill();
  if (!signalled) throw new Error(`the kill signal could not be delivered to fixture child pid ${String(child.pid)}`);
  const winner = await Promise.race([
    closed.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
  if (winner !== "closed") throw new Error(`fixture child pid ${String(child.pid)} did not close within ${String(timeoutMs)} ms of the kill signal`);
};

/** Test-side final gate: only removes the tree after the owned child's close
 * is confirmed; a stop failure fails the test and preserves the tree. */
const finalizeTestTree = async (child: ChildProcess, closed: Promise<unknown>, dir: string): Promise<void> => {
  await stopFixtureChild(child, closed);
  rmSync(dir, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS });
};

test("a cooperative owned child is released, confirmed exited with code 0, and the tree removed", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-owned-cleanup-ok-"));
  const { child, release, ready, closed } = spawnFixtureChild(dir, { cooperative: true });
  try {
    const handshake = await waitForReady(ready, 10_000);
    assert.equal(handshake.cwd, dir, "the child runs with the fixture tree as its cwd (the EBUSY shape)");
    assert.ok(typeof child.pid === "number" && isProcessRunning(child.pid), "the fixture child is alive after its ready receipt — receipt is not exit");
    await cleanupOwnedProcessFixture({ pids: [child.pid!], releasePath: release, dir, primaryFailed: false, timeoutMs: 10_000 });
    const outcome = await closed;
    assert.equal(outcome.code, 0, "the cooperative child must exit cleanly via the release path (not a startup failure)");
    assert.equal(existsSync(dir), false, "the fixture tree is removed only after the exit confirmation");
  } finally {
    await finalizeTestTree(child, closed, dir);
  }
});

test("a child that ignores the release signal preserves the tree and fails visibly", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-owned-cleanup-refuses-"));
  const { child, release, ready, closed } = spawnFixtureChild(dir, { cooperative: false });
  try {
    await waitForReady(ready, 10_000);
    assert.ok(typeof child.pid === "number" && isProcessRunning(child.pid));
    await assert.rejects(
      cleanupOwnedProcessFixture({ pids: [child.pid!], releasePath: release, dir, primaryFailed: false, timeoutMs: 300 }),
      /did not report exit within 300 ms.*fixture tree preserved/u,
      "the gate must report the unconfirmed exit and preserve the tree",
    );
    assert.equal(existsSync(dir), true, "no deletion may happen around a live owned child");
    assert.equal(isProcessRunning(child.pid!), true, "the refusing child is still alive");
  } finally {
    await finalizeTestTree(child, closed, dir);
  }
});

test("with a primary failure propagating, the gate reports diagnostics without masking it and still preserves the tree", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-owned-cleanup-primary-"));
  const { child, release, ready, closed } = spawnFixtureChild(dir, { cooperative: false });
  const originalError = console.error;
  const diagnostics: string[] = [];
  const primaryError = new Error("primary assertion failed (injected)");
  let caught: unknown = null;
  let treePreservedWhenGateFinished = false;
  try {
    await waitForReady(ready, 10_000);
    console.error = (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); };
    try {
      throw primaryError;
    } finally {
      try {
        await cleanupOwnedProcessFixture({ pids: [child.pid!], releasePath: release, dir, primaryFailed: true, timeoutMs: 300 });
        treePreservedWhenGateFinished = existsSync(dir);
      } finally {
        console.error = originalError;
      }
    }
    assert.fail("the primary error must have propagated");
  } catch (error) {
    caught = error;
  } finally {
    console.error = originalError;
    await finalizeTestTree(child, closed, dir);
  }
  assert.equal(caught, primaryError, "the primary failure propagates with its identity intact");
  assert.ok(diagnostics.some((line) => line.includes("fixture teardown failed") && line.includes("fixture tree preserved")),
    `the cleanup diagnostics stay visible alongside the primary failure: ${JSON.stringify(diagnostics)}`);
  assert.equal(treePreservedWhenGateFinished, true, "the tree stays for diagnosis while the primary failure propagates (before this test's own finalizer runs)");
});
