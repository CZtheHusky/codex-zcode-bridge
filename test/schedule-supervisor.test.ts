// ADR-010 supervisor tests: the exact systemd-run command line (unit naming,
// Type=exec, Restart=on-failure, unlimited restarts, append log under the
// private schedule directory, bounded env forwarding, explicit child
// command), start verification against systemctl, and the support probe.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleError } from "../src/schedule/errors.js";
import { createSystemdRunSupervisor, planSystemdRunUnit, type SystemdRunDeps } from "../src/schedule/supervisor.js";

function fakeExec(script: { systemctl?: (args: string[]) => { stdout: string; reject?: boolean }; systemdRun?: (args: string[]) => void }) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const deps: SystemdRunDeps = {
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "systemd-run") {
        script.systemdRun?.(args);
        return { stdout: "", stderr: "" };
      }
      if (file === "systemctl") {
        const outcome = script.systemctl?.(args) ?? { stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n" };
        if (outcome.reject) {
          const error = Object.assign(new Error(`systemctl ${args.join(" ")} failed`), { stdout: outcome.stdout });
          throw error;
        }
        return { stdout: outcome.stdout, stderr: "" };
      }
      throw new Error(`unexpected command ${file}`);
    },
  };
  return { deps, calls };
}

function planFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-sup-plan-"));
  const scheduleDir = path.join(dir, ".schedules", "goal_1");
  const runner = path.join(dir, "schedule-runner.mjs");
  writeFileSync(runner, "// fake runner\n", { mode: 0o600 });
  const plan = planSystemdRunUnit({
    unit: "zcode-bridge-schedule-00000000-0000-4000-8000-000000000001",
    runnerEntryPath: runner,
    scheduleDir,
    dataRoot: dir,
    taskId: "goal_1",
    env: {
      PATH: "/usr/bin",
      HOME: "/home/user",
      SECRET_TOKEN: "must-not-forward",
      CODEX_APP_TOOLS_PIPE_PATH: "/tmp/private-app.pipe",
      ZCODE_BRIDGE_MODE: "build",
      ZCODE_BRIDGE_DATA_DIR: dir,
      ZCODE_BRIDGE_HOST_PROFILE: '{"name":"$HOME stays literal"}',
    },
    nodeExecutable: "/usr/bin/node",
  });
  return { dir, plan };
}

test("systemd-run plan names the unit and logs under the private schedule directory", () => {
  const { dir, plan } = planFixture();
  try {
    assert.equal(plan.unit, "zcode-bridge-schedule-00000000-0000-4000-8000-000000000001");
    assert.equal(plan.logPath, path.join(dir, ".schedules", "goal_1", "runner.log"));
    assert.equal(plan.command, "/usr/bin/node");
    assert.equal(plan.args.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("systemd-run argument list encodes supervision, logging, env, and exec", () => {
  const { dir, plan } = planFixture();
  try {
    const args = plan.systemdRunArgs;
    const at = (flag: string): string => {
      const index = args.indexOf(flag);
      assert.ok(index >= 0, `missing ${flag} in ${JSON.stringify(args)}`);
      const value = args[index + 1];
      assert.ok(value !== undefined);
      return value;
    };
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("--collect"));
    assert.ok(args.includes("--expand-environment=no"), "host profile values must not be interpolated by systemd");
    assert.equal(at("--unit"), plan.unit);
    assert.equal(at("--property"), "Type=exec");
    assert.ok(args.includes("Restart=on-failure"));
    assert.ok(args.includes("StartLimitIntervalSec=0"));
    const properties = args.filter((_, index) => args[index - 1] === "--property");
    assert.deepEqual([...properties].sort(), [
      "KillMode=process",
      "Restart=on-failure",
      "RestartSec=5s",
      `StandardError=append:${plan.logPath}`,
      `StandardOutput=append:${plan.logPath}`,
      "StartLimitIntervalSec=0",
      "Type=exec",
    ]);
    const envIndex = args.indexOf("/usr/bin/env");
    assert.ok(envIndex > 0);
    assert.equal(args[envIndex + 1], "-i", "the runner must clear inherited user-manager secrets before Node starts");
    const assignments = args.slice(envIndex + 2, args.indexOf(plan.command));
    const keys = assignments.map((entry) => entry.split("=")[0]).sort();
    assert.deepEqual(keys, ["HOME", "PATH", "ZCODE_BRIDGE_DATA_DIR", "ZCODE_BRIDGE_HOST_PROFILE", "ZCODE_BRIDGE_MODE"]);
    assert.ok(assignments.includes('ZCODE_BRIDGE_HOST_PROFILE={"name":"$HOME stays literal"}'));
    assert.ok(!args.some((entry) => entry.includes("must-not-forward") || entry.includes("private-app.pipe")), "credentials and the host App pipe must not reach the supervised environment");
    assert.deepEqual(args.slice(-4), ["/usr/bin/node", ...plan.args]);
    assert.equal(plan.args[0], path.join(dir, "schedule-runner.mjs"));
    assert.equal(plan.args[1], dir);
    assert.equal(plan.args[2], "goal_1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner launch discards inherited manager environment before Node starts", { skip: process.platform !== "linux" ? "Linux launcher" : false }, () => {
  const { dir, plan } = planFixture();
  try {
    const envIndex = plan.systemdRunArgs.indexOf("/usr/bin/env");
    const commandIndex = plan.systemdRunArgs.indexOf(plan.command, envIndex + 1);
    const launch = spawnSync("/usr/bin/env", [
      ...plan.systemdRunArgs.slice(envIndex + 1, commandIndex), process.execPath,
      "-e", "console.log(JSON.stringify(process.env))",
    ], { encoding: "utf8", env: { NODE_OPTIONS: "--this-must-never-reach-node", UNRELATED_SECRET: "discard", ZCODE_HOME: "/stale/manager/config" } });
    assert.equal(launch.status, 0, launch.stderr);
    const env = JSON.parse(launch.stdout);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.UNRELATED_SECRET, undefined);
    assert.equal(env.ZCODE_HOME, undefined);
    assert.equal(env.ZCODE_BRIDGE_HOST_PROFILE, '{"name":"$HOME stays literal"}');
    assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start verifies the unit under the user manager (linux)", { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    let launched = false;
    const { deps, calls } = fakeExec({
      systemdRun: () => { launched = true; },
      systemctl: () => ({ stdout: launched
        ? "LoadState=loaded\nActiveState=active\nMainPID=1234\nControlGroup=/user.slice/fixture\n"
        : "LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n" }),
    });
    const supervisor = createSystemdRunSupervisor(deps);
    const started = await supervisor.start(plan);
    assert.equal(started.unit, plan.unit);
    assert.deepEqual(calls.map((call) => call.file), ["systemctl", "systemd-run", "systemctl"]);
    assert.deepEqual(calls[2]?.args, ["--user", "show", plan.unit, "--property=LoadState,ActiveState,MainPID,ControlGroup"], "success requires a supervised process and cgroup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start reuses an already supervised unit after a lost start receipt (linux)", { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    const { deps, calls } = fakeExec({ systemctl: () => ({ stdout: "LoadState=loaded\nActiveState=active\nMainPID=1234\nControlGroup=/user.slice/fixture\n" }) });
    assert.deepEqual(await createSystemdRunSupervisor(deps).start(plan), { unit: plan.unit });
    assert.deepEqual(calls.map((call) => call.file), ["systemctl"], "replay must not start a second runner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const identity of [
  { label: "MainPID", fields: "MainPID=0\nControlGroup=/user.slice/fixture\n" },
  { label: "cgroup", fields: "MainPID=1234\nControlGroup=\n" },
]) {
  test(`an active state without ${identity.label} is not proof of supervised execution (linux)`, { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
    const { dir, plan } = planFixture();
    try {
      let launched = false;
      const { deps, calls } = fakeExec({
        systemdRun: () => { launched = true; },
        systemctl: () => ({ stdout: launched
          ? "LoadState=loaded\nActiveState=failed\nMainPID=0\nControlGroup=\n"
          : `LoadState=loaded\nActiveState=active\n${identity.fields}` }),
      });
      await assert.rejects(createSystemdRunSupervisor(deps).start(plan), /did not become active/u);
      assert.equal(calls.filter((call) => call.file === "systemd-run").length, 1, "incomplete ownership evidence cannot replay a successful start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("start surfaces a missing unit after systemd-run failure (linux)", { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    const { deps } = fakeExec({
      systemdRun: () => { throw new Error("Failed to start transient service unit: unit exists"); },
    });
    const supervisor = createSystemdRunSupervisor(deps);
    await assert.rejects(supervisor.start(plan), (error: unknown) => {
      assert.ok(error instanceof ScheduleError);
      assert.equal(error.code, "SCHEDULE_SUPERVISOR_UNAVAILABLE");
      assert.match(error.message, /did not become active/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start rejects when the unit enters the failed state (linux)", { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    const { deps } = fakeExec({ systemctl: () => ({ stdout: "LoadState=loaded\nActiveState=failed\nMainPID=0\nControlGroup=\n" }) });
    const supervisor = createSystemdRunSupervisor(deps);
    await assert.rejects(supervisor.start(plan), /last state: failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start rejects when the unit never becomes active (linux)", { skip: process.platform !== "linux" ? "systemd behavior is Linux-only" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    const { deps } = fakeExec({ systemctl: () => ({ stdout: "inactive", reject: true }) });
    const supervisor = createSystemdRunSupervisor(deps);
    await assert.rejects(supervisor.start(plan), /did not become active/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-linux platforms fail scheduling visibly without invoking systemd", { skip: process.platform === "linux" ? "non-Linux behavior" : false }, async () => {
  const { dir, plan } = planFixture();
  try {
    const { deps, calls } = fakeExec({});
    const supervisor = createSystemdRunSupervisor(deps);
    await assert.rejects(supervisor.start(plan), /platform .* is not supported/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

