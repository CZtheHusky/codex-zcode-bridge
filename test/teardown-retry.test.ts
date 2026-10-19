// Windows teardown ENOTEMPTY regressions (2026-10-17): a full-suite run on
// Node 22.18.0/Windows flaked once in runtime-remediation teardown, and the
// PR #45 review attributed it to the same Windows filesystem timing family as
// the state.lock EPERM/ENOTEMPTY races (attribution, not a proven unique
// cause). Node documents EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM as retryable for
// recursive rm, so the fixtures remove trees with an explicit bounded retry
// budget (TEMP_TREE_REMOVE_OPTIONS). Attempt-2 note: Node 22's rmSync with
// default options still performs one internal re-walk, consuming two injected
// failures by itself — each arm below therefore builds its OWN tree with a
// FRESH injection counter, the no-retry arm must fail visibly, the retry arm
// must actually observe failures and survive them, and a permanent error must
// still fail after the budget. The natural flake itself was not reproduced in
// 150 probe rounds (attempt-1 record); these are deterministic injections.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { TEMP_TREE_REMOVE_OPTIONS, makeTempDir, removeTempDir } from "./helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";

const errnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(`injected ${code} (deterministic teardown regression)`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const makeTree = (root: string): string => {
  const victim = path.join(root, `victim-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path.join(victim, "sub"), { recursive: true });
  writeFileSync(path.join(victim, "sub", "a.txt"), "a");
  writeFileSync(path.join(victim, "b.txt"), "b");
  return victim;
};

test("the shared fixture teardown passes a bounded retry budget to recursive rm", async () => {
  const root = await makeTempDir("teardown-wiring-");
  try {
    const victim = makeTree(root);
    const realRm = fsPromises.rm;
    let observed: unknown = null;
    fsPromises.rm = (async (dir: string, options: unknown) => {
      observed = options;
      return realRm(dir, options as object);
    }) as typeof fsPromises.rm;
    syncBuiltinESMExports();
    try { await removeTempDir(victim); }
    finally { fsPromises.rm = realRm; syncBuiltinESMExports(); }
    const options = observed as { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number };
    assert.equal(options.recursive, true, "removal must stay recursive");
    assert.equal(options.force, true, "removal must stay forced");
    assert.ok((options.maxRetries ?? 0) >= 1, `a retry budget is required, saw ${JSON.stringify(options)}`);
    assert.ok((options.retryDelay ?? 0) >= 1, "retries need an explicit delay");
    assert.equal(fs.existsSync(victim), false, "tree must be gone");
  } finally { await removeTempDir(root); }
});

test("the async runtimeFixture cleanup carries the same bounded retry budget", async () => {
  const fixture = await runtimeFixture();
  const realRm = fsPromises.rm;
  let observed: unknown = null;
  fsPromises.rm = (async (dir: string, options: unknown) => {
    observed = options;
    return realRm(dir, options as object);
  }) as typeof fsPromises.rm;
  syncBuiltinESMExports();
  try { await fixture.cleanup(); }
  finally { fsPromises.rm = realRm; syncBuiltinESMExports(); }
  const options = observed as { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number };
  assert.equal(options.recursive, true, "the fixture cleanup must stay recursive");
  assert.equal(options.force, true, "the fixture cleanup must stay forced");
  assert.ok((options.maxRetries ?? 0) >= 1, `the fixture cleanup needs the retry budget, saw ${JSON.stringify(options)}`);
  assert.ok((options.retryDelay ?? 0) >= 1, "the fixture cleanup needs an explicit retry delay");
  assert.equal(fs.existsSync(fixture.root), false, "the fixture tree must be gone");
});

// On Node 22 the recursive rm implementation calls the exported rmdirSync, so
// a patch can inject the observed errno codes end-to-end. Node 24's rimraf
// binds the internal operation directly and the patch is not observable
// there; the wiring tests above cover the option contract on every version.
test("injected ENOTEMPTY: default rm fails visibly, the fixture budget survives it, permanent errors still fail", { skip: Number(process.versions.node.split(".")[0]) !== 22, timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-test-teardown-inject-"));
  try {
    const realRmdirSync = fs.rmdirSync;
    const injectVictimFailures = (victim: string, times: number) => {
      let failuresLeft = times;
      let observed = 0;
      const fail = (target: string): NodeJS.ErrnoException | null => {
        if (target !== victim || failuresLeft <= 0) return null;
        failuresLeft -= 1;
        observed += 1;
        return errnoError("ENOTEMPTY");
      };
      return { fail, observedCount: () => observed };
    };
    const runRm = (victim: string, injector: ReturnType<typeof injectVictimFailures>, options: fs.RmOptions): void => {
      fs.rmdirSync = ((target: fs.PathLike, rmdirOptions?: fs.RmDirOptions) => {
        const injected = injector.fail(String(target));
        if (injected) throw injected;
        return realRmdirSync(target, rmdirOptions);
      }) as typeof fs.rmdirSync;
      syncBuiltinESMExports();
      try {
        fs.rmSync(victim, { recursive: true, force: true, ...options });
      } finally {
        fs.rmdirSync = realRmdirSync;
        syncBuiltinESMExports();
      }
    };

    // Arm 1 — default options on its OWN fresh tree: the injected transient
    // failures must stay visible (no masking without a budget).
    const victim1 = makeTree(root);
    const arm1 = injectVictimFailures(victim1, 3);
    assert.throws(() => runRm(victim1, arm1, {}), (error: NodeJS.ErrnoException) => error.code === "ENOTEMPTY",
      "default options must keep the transient failure visible");
    assert.ok(arm1.observedCount() >= 1, "the default arm must actually observe injected failures");
    assert.equal(fs.existsSync(victim1), true, "the tree survives a visible failure");
    rmSync(victim1, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS });

    // Arm 2 — the fixture budget on its OWN fresh tree with a FRESH counter:
    // it must also observe failures and survive them through retries.
    const victim2 = makeTree(root);
    const arm2 = injectVictimFailures(victim2, 3);
    runRm(victim2, arm2, { ...TEMP_TREE_REMOVE_OPTIONS });
    assert.ok(arm2.observedCount() >= 1, "the retry arm must actually receive the injected errors (attempt-1 defect: it saw none)");
    assert.equal(fs.existsSync(victim2), false, "the fixture retry budget must survive the injected ENOTEMPTY");

    // Arm 3 — a permanent error with the full budget still fails visibly.
    const victim3 = makeTree(root);
    const arm3 = injectVictimFailures(victim3, Number.MAX_SAFE_INTEGER);
    assert.throws(() => runRm(victim3, arm3, { ...TEMP_TREE_REMOVE_OPTIONS }), (error: NodeJS.ErrnoException) => error.code === "ENOTEMPTY",
      "budget exhaustion must keep genuine permanent failures visible");
    assert.equal(fs.existsSync(victim3), true, "the tree survives the exhausted budget");
  } finally { rmSync(root, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS }); }
});
