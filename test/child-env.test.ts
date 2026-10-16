import assert from "node:assert/strict";
import test from "node:test";
import { createMinimalOsEnv, createWorkerEnv } from "../src/runtime/child-env.js";

test("child environments keep only OS and explicit Bridge settings", () => {
  const source = {
    PATH: "safe-path",
    HOME: "/home/test",
    API_TOKEN: "must-not-leak",
    HTTPS_PROXY: "http://secret-proxy",
    ZCODE_OTHER_SECRET: "must-not-leak",
    ZCODE_BRIDGE_NODE: "/opt/node",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/config/builtin.json",
  };
  const worker = createWorkerEnv(source);
  assert.equal(worker.PATH, "safe-path");
  assert.equal(worker.ZCODE_BRIDGE_NODE, "/opt/node");
  assert.equal(worker.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "/config/builtin.json");
  assert.equal(worker.API_TOKEN, undefined);
  assert.equal(worker.HTTPS_PROXY, undefined);
  assert.equal(worker.ZCODE_OTHER_SECRET, undefined);

  const child = createMinimalOsEnv(source);
  assert.equal(child.PATH, "safe-path");
  if (process.platform === "win32") {
    assert.equal(child.HOME, undefined);
  } else {
    assert.equal(child.HOME, "/home/test");
  }
  assert.equal(child.API_TOKEN, undefined);
  assert.equal(child.ZCODE_BRIDGE_NODE, undefined);
});

test("worker environments forward the env-only browser settings and nothing broader", () => {
  const worker = createWorkerEnv({
    PATH: "safe-path",
    ZCODE_BRIDGE_BROWSER_USE: "headless",
    ZCODE_BRIDGE_BROWSER_EXECUTABLE: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ZCODE_BRIDGE_BROWSER_SECRET: "must-not-leak",
  });
  assert.equal(worker.ZCODE_BRIDGE_BROWSER_USE, "headless");
  assert.equal(worker.ZCODE_BRIDGE_BROWSER_EXECUTABLE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  assert.equal(worker.ZCODE_BRIDGE_BROWSER_SECRET, undefined, "only the two documented browser keys are forwarded");

  const unset = createWorkerEnv({ PATH: "safe-path" });
  assert.equal("ZCODE_BRIDGE_BROWSER_USE" in unset, false, "default off means the key stays absent");
  assert.equal("ZCODE_BRIDGE_BROWSER_EXECUTABLE" in unset, false);
});

test("Windows child environments keep the Program Files directories in common casings", () => {
  // Real Windows casing, as the OS environment block and the forwarded worker
  // env present it; browser auto-discovery reads these roots.
  const child = createMinimalOsEnv({
    PATH: "safe-path",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  if (process.platform === "win32") {
    const keys = Object.keys(child).map((key) => key.toUpperCase());
    assert.ok(keys.includes("PROGRAMFILES"), "ProgramFiles must survive the OS env filter");
    assert.ok(keys.includes("PROGRAMFILES(X86)"), "ProgramFiles(x86) must survive the OS env filter");
    const forwarded = Object.entries(child)
      .filter(([key]) => key.toUpperCase() === "PROGRAMFILES" || key.toUpperCase() === "PROGRAMFILES(X86)")
      .map(([, value]) => value)
      .sort();
    assert.deepEqual(forwarded, ["C:\\Program Files", "C:\\Program Files (x86)"].sort());
  } else {
    assert.equal(Object.keys(child).includes("ProgramFiles"), false, "POSIX child envs do not forward Windows-only directories");
  }
});
