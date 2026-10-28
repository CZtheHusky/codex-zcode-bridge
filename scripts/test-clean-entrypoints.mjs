import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(path.join(tmpdir(), "bridge-clean-entrypoints-"));
try {
  // Deliberately omit production dist/: tests must exercise dist-test/src.
  for (const entry of ["src", "dist-test", "plugins", "package.json", "scripts/test-isolated.mjs"]) cpSync(path.join(repository, entry), path.join(fixture, entry), { recursive: true });
  symlinkSync(path.join(repository, "node_modules"), path.join(fixture, "node_modules"), "junction");
  const run = spawnSync(process.execPath, ["scripts/test-isolated.mjs", "--test-name-pattern=compiled stdio|marketplace bundle|compiled worker|compiled scheduler|bundled scheduler|bundled fork", "dist-test/test/mcp-stdio-entry.test.js", "dist-test/test/run-worker-task.test.js", "dist-test/test/host-and-index.test.js"], { cwd: fixture, stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally { rmSync(fixture, { recursive: true, force: true }); }
