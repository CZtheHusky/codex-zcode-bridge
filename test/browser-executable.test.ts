// F2 regression (2026-10-16 cross-environment review): browser auto-discovery
// on Windows must accept the common casings of the ProgramFiles variables the
// worker env forwards, using fixture directories instead of a real browser.
// The win32 path table is exercised via the platform option, so no real
// browser and no Windows OS are required.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveInstalledBrowserExecutable, type PlaywrightChromiumModule } from "../src/browser/executable.js";

function fakePlaywrightWithoutBundledBrowser(): PlaywrightChromiumModule {
  return { chromium: { executablePath: () => "" } } as unknown as PlaywrightChromiumModule;
}

function fakeBrowserExe(base: string, ...segments: string[]): string {
  const exePath = path.join(base, ...segments);
  mkdirSync(path.dirname(exePath), { recursive: true });
  writeFileSync(exePath, "fixture browser executable", "utf8");
  return exePath;
}

test("uppercase system directory variables discover installed browsers (existing contract)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-exe-uppercase-"));
  try {
    const edge = fakeBrowserExe(dir, "x86", "Microsoft", "Edge", "Application", "msedge.exe");
    const resolved = resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), {
      platform: "win32",
      env: { PROGRAMFILES: path.join(dir, "missing"), "PROGRAMFILES(X86)": path.join(dir, "x86") },
    });
    assert.equal(resolved, edge);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("common Windows casings (ProgramFiles / ProgramFiles(x86) / localappdata) discover the same installs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-exe-casing-"));
  try {
    const chrome = fakeBrowserExe(dir, "pf", "Google", "Chrome", "Application", "chrome.exe");
    const chromium = fakeBrowserExe(dir, "local", "Chromium", "Application", "chrome.exe");
    for (const env of [
      { ProgramFiles: path.join(dir, "pf"), "ProgramFiles(x86)": path.join(dir, "x86") },
      { PROGRAMFILES: path.join(dir, "pf"), "PROGRAMFILES(X86)": path.join(dir, "x86") },
      { programfiles: path.join(dir, "pf"), "programfiles(x86)": path.join(dir, "x86") },
    ]) {
      const resolved = resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), { platform: "win32", env });
      assert.equal(resolved, chrome, `casing ${Object.keys(env).join("/")} must resolve the ProgramFiles install`);
    }
    const resolvedLocal = resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), {
      platform: "win32",
      env: { localappdata: path.join(dir, "local") },
    });
    assert.equal(resolvedLocal, chromium, "lowercase localappdata must resolve the per-user install");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whitespace-only directory values are skipped and discovery falls through to the next root", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-exe-blank-"));
  try {
    const edge = fakeBrowserExe(dir, "x86", "Microsoft", "Edge", "Application", "msedge.exe");
    const resolved = resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), {
      platform: "win32",
      env: { ProgramFiles: "   ", "ProgramFiles(x86)": path.join(dir, "x86") },
    });
    assert.equal(resolved, edge);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit executable path keeps priority over discovered system installs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-exe-explicit-"));
  try {
    const explicit = fakeBrowserExe(dir, "explicit", "custom-browser.exe");
    fakeBrowserExe(dir, "pf", "Google", "Chrome", "Application", "chrome.exe");
    const resolved = resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), {
      platform: "win32",
      executablePath: explicit,
      env: { ProgramFiles: path.join(dir, "pf") },
    });
    assert.equal(resolved, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing installed still raises the documented ZCODE_BRIDGE_BROWSER_EXECUTABLE guidance", () => {
  assert.throws(
    () => resolveInstalledBrowserExecutable(fakePlaywrightWithoutBundledBrowser(), { platform: "win32", env: {} }),
    /ZCODE_BRIDGE_BROWSER_EXECUTABLE/u,
  );
});
