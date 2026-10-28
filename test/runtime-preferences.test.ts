import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runBridgeDoctor } from "../src/runtime/doctor.js";
import { resolveSessionPreferences } from "../src/runtime/session-preferences.js";

test("execution mode defaults to yolo and build can be selected explicitly", () => {
  assert.equal(resolveSessionPreferences(undefined, {}).mode, "yolo");
  assert.equal(resolveSessionPreferences(undefined, { ZCODE_BRIDGE_MODE: "" }).mode, "yolo");
  assert.equal(resolveSessionPreferences(undefined, { ZCODE_BRIDGE_MODE: "   " }).mode, "yolo");
  assert.equal(resolveSessionPreferences(undefined, { ZCODE_BRIDGE_MODE: "build" }).mode, "build");
  assert.equal(resolveSessionPreferences(undefined, { ZCODE_BRIDGE_MODE: "yolo" }).mode, "yolo");
});

test("doctor validates local setup without starting a ZCode session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-doctor-test-"));
  try {
    const install = path.join(root, "ZCode");
    const providerDir = path.join(install, "resources", "config", "provider");
    const runtimeDir = path.join(install, "resources", "glm");
    const home = path.join(root, "home");
    const dataRoot = path.join(root, "bridge-data");
    mkdirSync(providerDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    const runtime = path.join(runtimeDir, "zcode.cjs");
    const builtin = path.join(providerDir, "zcode-builtin.json");
    const personal = path.join(root, ".zcode", "v2", "provider_config.json");
    mkdirSync(path.dirname(personal), { recursive: true });
    writeFileSync(runtime, "// fake ZCode runtime");
    writeFileSync(builtin, JSON.stringify({ config: {} }));
    writeFileSync(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: { test: {} } } } }));
    writeFileSync(path.join(root, ".zcode", "v2", "tasks-index.sqlite"), "");

    const env = {
      ZCODE_BRIDGE_NODE: process.execPath,
      ZCODE_BRIDGE_ZCODE_CJS: runtime,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_BRIDGE_MODE: "build",
    };
    const report = await runBridgeDoctor({
      env,
      resolver: { env, homeDir: home, packageRoot: root },
      dataRoot,
    });
    const checks = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(report.execution_mode, "build");
    assert.equal(checks.get("zcode_runtime")?.status, "ok");
    assert.equal(checks.get("provider_config")?.status, "ok");
    assert.equal(checks.get("desktop_index")?.status, "ok");
    assert.equal(checks.get("app_server")?.status, "unknown");
    assert.equal(checks.get("start_plan")?.status, "warning");
    assert.equal(checks.get("permission_roundtrip")?.status, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
