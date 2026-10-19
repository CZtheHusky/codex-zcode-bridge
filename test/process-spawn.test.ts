// Real (local, model-free) process-tree termination test for Windows. Spawns a
// Node parent that spawns its own sleeper child, then verifies that
// terminateProcessTree kills the entire verified tree. Skipped on non-Windows.
// Fixture lifecycle (2026-10-17 matrix2 review): the production call may
// refuse (it did, with a malformed-identity snapshot rejection) — the test
// must never orphan its own children in that case. BOTH fixture scripts
// independently watch the same private release file (triggered only in the
// finally, after the primary assertions or their failure — never before the
// production call, so it cannot mask production behavior); the parent also
// stops its OWN child handle, and only a real close event on that handle
// counts as confirmation. The finally gate confirms every owned pid exited
// before removing the tree, and an unreported grandchild preserves the tree.
// Before the production termination call, a read-only ownership precondition
// verifies the selected tree belongs to this fixture (the matrix2 incident
// selected stale system rows that merely shared a ParentProcessId); any
// unrelated, older, or unknown entry fails visibly BEFORE any production
// signal is sent.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureSpawnGenerationIdentity, createPlatformProbe, isProcessRunning, terminateProcessTree } from "../src/adapters/process-spawn.js";
import { cleanupOwnedProcessFixture } from "./helpers.js";

function writeFixtureScripts(dir: string): { parentScript: string; childScript: string; releasePath: string } {
  const parentScript = path.join(dir, "parent.cjs");
  const childScript = path.join(dir, "sleeper.cjs");
  const releasePath = path.join(dir, "release");
  writeFileSync(childScript, [
    '"use strict";',
    "const fs = require('node:fs');",
    `const release = ${JSON.stringify(releasePath)};`,
    "// Independent cooperative release: this sleeper exits on the fixture's",
    "// private release file even when its parent is already gone.",
    "function watch() { if (fs.existsSync(release)) process.exit(0); setTimeout(watch, 50); }",
    "watch();",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  writeFileSync(parentScript, [
    '"use strict";',
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const childScript = ${JSON.stringify(childScript)};`,
    `const release = ${JSON.stringify(releasePath)};`,
    "const child = spawn(process.execPath, [childScript], { stdio: 'ignore' });",
    "let childClosed = false;",
    "let childError = null;",
    "child.once('close', () => { childClosed = true; });",
    "child.once('error', (error) => { childError = error; });",
    "console.log(`${child.pid}:${child.pid > 0 ? 'ok' : 'bad'}`);",
    "// Cooperative release for the parent: stop OUR OWN child handle and",
    "// exit only after its real close event. A spawn error is reported and",
    "// exits nonzero — it never counts as a confirmed close.",
    "function watchRelease() {",
    "  if (fs.existsSync(release)) {",
    "    if (childError !== null) { process.exit(1); return; }",
    "    if (!childClosed) {",
    "      try { child.kill(); } catch { /* the bounded close wait decides */ }",
    "      const deadline = Date.now() + 5000;",
    "      (function awaitClose() {",
    "        if (childClosed) { process.exit(0); return; }",
    "        if (childError !== null || Date.now() > deadline) { process.exit(1); return; }",
    "        setTimeout(awaitClose, 20);",
    "      })();",
    "      return;",
    "    }",
    "    process.exit(0);",
    "    return;",
    "  }",
    "  setTimeout(watchRelease, 50);",
    "}",
    "watchRelease();",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  return { parentScript, childScript, releasePath };
}

/** Spawns the fixture parent and returns the handle and pid IMMEDIATELY; the
 * pid receipt is a separate promise with error/close registered at spawn, so
 * a receipt failure still leaves the caller holding the owned parent pid. */
function spawnFixtureParent(parentScript: string): { parent: ChildProcess; parentPid: number; receipt: Promise<number> } {
  const parent = spawn(process.execPath, [parentScript], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const parentPid = parent.pid ?? 0;
  const receipt = new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("parent did not report a complete child pid receipt")), 10_000);
    if (typeof timer.unref === "function") timer.unref();
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return; // wait for the complete receipt line
      const [pidText, tag] = buffer.slice(0, newline).trim().split(":");
      buffer = buffer.slice(newline + 1);
      const pid = Number.parseInt(pidText ?? "", 10);
      if (tag === "ok" && Number.isSafeInteger(pid) && pid > 0) {
        clearTimeout(timer);
        resolve(pid);
      } else {
        clearTimeout(timer);
        reject(new Error(`parent reported an unusable child pid receipt: ${JSON.stringify(pidText ?? "")}`));
      }
    });
    parent.once("error", (error) => { clearTimeout(timer); reject(error); });
    parent.once("close", () => { clearTimeout(timer); reject(new Error("parent exited before reporting its child pid")); });
  });
  return { parent, parentPid, receipt };
}

interface TreeRow {
  pid: number;
  parentPid: number;
  name: string;
  creationFileTime: bigint;
  commandLine: string;
}

/** Read-only fresh snapshot of the PID closure under rootPid: no signalling,
 * purely CIM enumeration. Base64 keeps the pipe protocol unambiguous; the
 * FILETIME is compared as an exact BigInt, with no clock skew allowance. */
function snapshotTreeClosure(rootPid: number): TreeRow[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    `$selected = [System.Collections.Generic.HashSet[int]]::new(); [void]$selected.Add(${rootPid})`,
    "do { $changed = $false; foreach ($item in $all) { if ($selected.Contains([int]$item.ParentProcessId)) { if ($selected.Add([int]$item.ProcessId)) { $changed = $true } } } } while ($changed)",
    "'bridge_tree_owned_v1'",
    "foreach ($item in $all) { if ($selected.Contains([int]$item.ProcessId)) { $cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$item.CommandLine)); '{0}|{1}|{2}|{3}|{4}' -f $item.ProcessId, $item.ParentProcessId, $item.Name, $item.CreationDate.ToFileTimeUtc(), $cmd } }",
  ].join("; ");
  const run = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (run.status !== 0) throw new Error(`ownership snapshot failed (exit ${String(run.status)}): ${String(run.stderr).slice(0, 300)}`);
  const lines = run.stdout.trim().split(/\r?\n/u);
  if (lines.shift() !== "bridge_tree_owned_v1") throw new Error("ownership snapshot failed: protocol marker missing");
  return lines.filter((line) => line.trim()).map((line) => {
    const [pidText, parentText, name, fileTimeText, commandB64] = line.split("|");
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || !name || !/^\d+$/u.test(fileTimeText ?? "")) {
      throw new Error(`ownership snapshot failed: malformed row ${JSON.stringify(line.slice(0, 120))}`);
    }
    return { pid, parentPid, name, creationFileTime: BigInt(fileTimeText!), commandLine: Buffer.from(commandB64 ?? "", "base64").toString("utf8") };
  });
}

/**
 * Fixture ownership precondition (2026-10-17 matrix2 Safety addendum): every
 * process selected under the test's root must belong to THIS fixture. Node
 * rows must be exactly the recorded parent/grandchild pids whose command
 * lines reference this run's unique fixture scripts; the sleeper's parent is
 * the root and its creation cannot predate the root's; console hosts hang
 * directly off those verified pids and cannot predate their own parent. All
 * creation-time comparisons are exact BigInt checks with no skew allowance,
 * so a stale system row that merely shares a ParentProcessId fails HERE,
 * before the production terminator is ever invoked. This is a fixture guard,
 * not a production policy; it never skips, fabricates, or re-picks pids.
 */
function assertTreeBelongsToFixture(rootPid: number, grandchildPid: number, parentScript: string, childScript: string): void {
  const rows = snapshotTreeClosure(rootPid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid);
  if (!root) throw new Error(`ownership precondition failed: root pid ${String(rootPid)} missing from its own snapshot`);
  const sleeper = byPid.get(grandchildPid);
  if (!sleeper) throw new Error(`ownership precondition failed: expected fixture sleeper pid ${String(grandchildPid)} not selected`);
  if (sleeper.parentPid !== rootPid) throw new Error(`ownership precondition failed: sleeper parent pid ${String(sleeper.parentPid)} is not the fixture root`);
  if (sleeper.creationFileTime < root.creationFileTime) {
    throw new Error(`ownership precondition failed: sleeper pid ${String(grandchildPid)} predates the fixture root; refusing to signal an unrelated process`);
  }
  if (root.name.toLowerCase() !== "node.exe" || !root.commandLine.includes(parentScript)) {
    throw new Error("ownership precondition failed: the fixture root is not this test's node parent");
  }
  if (sleeper.name.toLowerCase() !== "node.exe" || !sleeper.commandLine.includes(childScript)) {
    throw new Error("ownership precondition failed: the recorded sleeper is not this test's node child");
  }
  const allowedImages = new Set(["node.exe", "conhost.exe", "openconsole.exe"]);
  for (const row of rows) {
    if (!allowedImages.has(row.name.toLowerCase())) {
      throw new Error(`ownership precondition failed: pid ${String(row.pid)} has unexpected image ${row.name}; refusing to signal an unknown process`);
    }
    if (row.name.toLowerCase() === "node.exe" && row.pid !== rootPid && row.pid !== grandchildPid) {
      throw new Error(`ownership precondition failed: unexpected node pid ${String(row.pid)} inside the fixture tree`);
    }
    if (row.name.toLowerCase() !== "node.exe") {
      const hostParent = row.parentPid === rootPid ? root : row.parentPid === grandchildPid ? sleeper : null;
      if (!hostParent) throw new Error(`ownership precondition failed: console host pid ${String(row.pid)} does not hang off the verified fixture pids`);
      if (row.creationFileTime < hostParent.creationFileTime) {
        throw new Error(`ownership precondition failed: console host pid ${String(row.pid)} predates its parent; refusing to signal an unrelated process`);
      }
    }
  }
}

test("terminateProcessTree kills a real Windows process tree and verifies it", { timeout: 30_000 }, async () => {
  if (process.platform !== "win32") {
    return test.skip("Windows-only process tree semantics");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-bridge-tree-"));
  const { parentScript, childScript, releasePath } = writeFixtureScripts(dir);
  const spawned = spawnFixtureParent(parentScript);
  const parentPid = spawned.parentPid;
  let grandchildPid = 0;
  let primaryFailed = false;
  try {
    grandchildPid = await spawned.receipt;
    assert.ok(isProcessRunning(parentPid), "parent must be alive before termination");
    assert.ok(isProcessRunning(grandchildPid), "grandchild must be alive before termination");

    // Read-only ownership guard BEFORE the production terminator runs.
    assertTreeBelongsToFixture(parentPid, grandchildPid, parentScript, childScript);

    // ADR-009 identity handoff through the ORIGINAL ChildProcess object: the
    // shared capture re-verifies the spawn generation after every await
    // (Node delivers exit before close and libuv releases the native handle
    // at exit delivery — a close flag would prove nothing). A capture that
    // races the parent's exit is discarded and the terminator then refuses
    // instead of trusting the bare PID.
    const identity = await captureSpawnGenerationIdentity(spawned.parent, createPlatformProbe());
    assert.equal(identity !== null, true, "the fixture parent identity must be readable on its original generation");
    const result = await terminateProcessTree(parentPid, { graceMs: 500, killWaitMs: 8_000, expectedRootFingerprint: identity!.fingerprint });
    assert.equal(result.verified, true);
    // The receipt preserves every verified member's creation time/identity
    // (AC4) and the signaled set equals the verified member set (AC2).
    assert.ok(result.windows, "the Windows receipt is present");
    assert.ok(result.windows!.members.some((m) => m.pid === parentPid), "the root is in the verified member set");
    assert.ok(result.windows!.members.some((m) => m.pid === grandchildPid), "the grandchild is in the verified member set");
    assert.ok(result.windows!.signaled.length > 0, "the receipt records which members were signalled");
    for (const pid of result.windows!.signaled) {
      assert.ok(result.windows!.members.some((m) => m.pid === pid), "signals only reached verified members");
    }
    assert.equal(isProcessRunning(parentPid), false, "parent must be dead after termination");
    assert.equal(isProcessRunning(grandchildPid), false, "grandchild must be dead after termination");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (parentPid > 0) {
      const pids = grandchildPid > 0 ? [parentPid, grandchildPid] : [parentPid];
      await cleanupOwnedProcessFixture({ pids, releasePath, dir, primaryFailed, preserveTree: grandchildPid === 0 });
    }
  }
});

test("terminateProcessTree with a wrong expected root fingerprint refuses and signals nothing", { timeout: 30_000 }, async () => {
  // ADR-009 rejection path on a real, registered, independently-bounded
  // fixture: a mismatched expectation means the PID may be owned by another
  // generation, so the terminator must refuse BEFORE any signal and the tree
  // must stay alive. The bounded fixture release then cleans up without any
  // tree signalling.
  if (process.platform !== "win32") {
    return test.skip("Windows-only process tree semantics");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-bridge-tree-refuse-"));
  const { parentScript, childScript, releasePath } = writeFixtureScripts(dir);
  const spawned = spawnFixtureParent(parentScript);
  const parentPid = spawned.parentPid;
  let grandchildPid = 0;
  let primaryFailed = false;
  try {
    grandchildPid = await spawned.receipt;
    assert.ok(isProcessRunning(parentPid), "fixture parent starts alive");
    assert.ok(isProcessRunning(grandchildPid), "fixture sleeper starts alive");
    assertTreeBelongsToFixture(parentPid, grandchildPid, parentScript, childScript);
    const identity = await captureSpawnGenerationIdentity(spawned.parent, createPlatformProbe());
    assert.equal(identity !== null, true, "the fixture parent identity must be readable on its original generation");
    const wrongFingerprint = identity!.fingerprint === "1" ? "2" : "1";
    await assert.rejects(
      terminateProcessTree(parentPid, { graceMs: 500, killWaitMs: 2_000, expectedRootFingerprint: wrongFingerprint }),
      /process_tree_root_identity_changed/,
    );
    assert.equal(isProcessRunning(parentPid), true, "a refused termination leaves the tree alive");
    assert.equal(isProcessRunning(grandchildPid), true, "no descendant was signalled either");
    // Missing identity is refused the same way (bare-PID trust is forbidden).
    await assert.rejects(
      terminateProcessTree(parentPid, { graceMs: 500, killWaitMs: 2_000 }),
      /process_tree_root_identity_required/,
    );
    assert.equal(isProcessRunning(parentPid), true, "still alive after the identity-required refusal");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (parentPid > 0) {
      const pids = grandchildPid > 0 ? [parentPid, grandchildPid] : [parentPid];
      await cleanupOwnedProcessFixture({ pids, releasePath, dir, primaryFailed, preserveTree: grandchildPid === 0 });
    }
  }
});

test("terminateProcessTree rejects non-positive PIDs", async () => {
  await assert.rejects(terminateProcessTree(0), /positive integer PID/);
  await assert.rejects(terminateProcessTree(-5), /positive integer PID/);
});

test("when termination never succeeds the fixture still leaves no owned orphans", { timeout: 30_000 }, async () => {
  // Failure-path coverage for the same fixture family: if the production
  // terminator refuses or is never reached (the matrix2 shape), the
  // cooperative release path alone must stop BOTH known fixture processes
  // and clean the tree — without any PID-tree signalling and without
  // weakening the primary test above, whose assertions are unchanged.
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-bridge-tree-refuses-"));
  const { parentScript, releasePath } = writeFixtureScripts(dir);
  const spawned = spawnFixtureParent(parentScript);
  const parentPid = spawned.parentPid;
  let grandchildPid = 0;
  let primaryFailed = false;
  let settledByPrimaryCleanup = false;
  try {
    grandchildPid = await spawned.receipt;
    assert.ok(parentPid > 0 && isProcessRunning(parentPid), "fixture parent starts alive");
    assert.ok(isProcessRunning(grandchildPid), "fixture sleeper starts alive");

    // Deliberately NO production termination here: the gated fixture release
    // must suffice (both scripts watch the private release file; the parent
    // additionally stops its own child after a confirmed close event).
    await cleanupOwnedProcessFixture({ pids: [parentPid, grandchildPid], releasePath, dir, primaryFailed: false, timeoutMs: 15_000 });
    settledByPrimaryCleanup = true;
    assert.equal(isProcessRunning(parentPid), false, "the fixture parent exited via the cooperative release");
    assert.equal(isProcessRunning(grandchildPid), false, "the fixture sleeper exited via its own release watch");
    assert.equal(existsSync(dir), false, "the tree is removed only after both exits are confirmed");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (!settledByPrimaryCleanup && parentPid > 0) {
      const pids = grandchildPid > 0 ? [parentPid, grandchildPid] : [parentPid];
      await cleanupOwnedProcessFixture({ pids, releasePath, dir, primaryFailed, preserveTree: grandchildPid === 0 });
    }
  }
});
