import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "codex-zcode-bridge");
const distDir = path.join(pluginRoot, "dist");
const workerDir = path.join(pluginRoot, "worker");
const vendorDir = path.join(workerDir, "vendor");
await Promise.all([mkdir(distDir, { recursive: true }), mkdir(vendorDir, { recursive: true })]);

const shared = {
  bundle: true,
  platform: "node",
  target: "node22.18",
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
};

await Promise.all([
  build({ ...shared, format: "esm", entryPoints: [path.join(repoRoot, "src", "mcp", "main.ts")], outfile: path.join(distDir, "bridge.mjs") }),
  build({ ...shared, format: "esm", entryPoints: [path.join(repoRoot, "src", "worker", "worker-main.ts")], outfile: path.join(workerDir, "worker-main.mjs") }),
  build({ ...shared, format: "esm", entryPoints: [path.join(repoRoot, "src", "schedule", "runner-main.ts")], outfile: path.join(workerDir, "schedule-runner.mjs") }),
]);

// The managed CDP browser backend ships as a CommonJS bundle next to the ESM
// worker: playwright-core (pinned in package.json) keeps its CommonJS runtime
// assumptions (registry data resolved one level above the bundle directory,
// lazy chromium-bidi requires) intact, and the worker loads it through
// src/browser/load-backend.ts. chromium-bidi is an optional runtime dependency
// of playwright-core that the CDP path never initializes, so its two lazy
// requires stay external. browsers.json/package.json live at the vendor root
// because playwright-core resolves them from join(__dirname, "..") of the
// bundle — hence the extra pkg/ nesting for the bundle itself.
await build({
  ...shared,
  format: "cjs",
  entryPoints: [path.join(repoRoot, "src", "browser", "backend-entry.ts")],
  outfile: path.join(vendorDir, "pkg", "browser-host.cjs"),
  external: [
    "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
    "chromium-bidi/lib/cjs/cdp/CdpConnection",
  ],
});
// playwright-core resolves browsers.json and its own package.json relative to
// the bundle directory's parent at runtime; ship them verbatim.
await Promise.all([
  copyFile(path.join(repoRoot, "node_modules", "playwright-core", "browsers.json"), path.join(vendorDir, "browsers.json")),
  copyFile(path.join(repoRoot, "node_modules", "playwright-core", "package.json"), path.join(vendorDir, "package.json")),
]);

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const bridgeBundlePath = path.join(distDir, "bridge.mjs");
const bridgeBundle = await readFile(bridgeBundlePath, "utf8");
const versionPattern = /var SERVER_VERSION = "[^"]+";/;
if (!versionPattern.test(bridgeBundle)) {
  throw new Error("Could not find the bundled SERVER_VERSION declaration.");
}
await writeFile(
  bridgeBundlePath,
  bridgeBundle.replace(versionPattern, `var SERVER_VERSION = "${packageJson.version}"; // x-release-please-version`),
  "utf8",
);

console.log("Built the self-contained Codex marketplace plugin server, worker, and vendored browser backend.");
