// Process helpers for the ZCode adapter: bounded output capture, process-tree
// termination with verification.
//
// Portions adapted from cc-plugin-codex, file scripts/lib/process.mjs
// (https://github.com/hex1n/cc-plugin-codex, commit
// 501f975372ddb5117b6389114c15f1ccd0104711), licensed under the Apache License,
// Version 2.0. Modifications: TypeScript ESM, injection-friendly types for the
// Bridge adapter contract, extra termination verification for this project.
import { spawn } from "node:child_process";
import { createPlatformProbe, type ProcessProbe } from "../runtime/process-probe.js";
import {
  openPowerShellTreeTransaction,
  terminateWindowsProcessTree,
  verifyWindowsRecordedTreeClaimants,
  type WindowsTerminationReceipt,
} from "./windows-process-cleanup.js";

export { createPlatformProbe, type ProcessProbe };

export interface OutputStreamLike {
  setEncoding(encoding: "utf8"): void;
  on(event: "data", listener: (chunk: string) => void): void;
}

export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: OutputStreamLike | null;
  readonly stderr: OutputStreamLike | null;
  /** Exit state per ADR-009: real child processes expose these from Node's
   * exit callback; while both are null the child is provably on its original
   * spawn generation. Optional so legacy fakes keep compiling; a fake
   * without them cannot prove continuity and production treats that
   * conservatively. */
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptionsLike {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: boolean;
}

export type SpawnFunction = (
  file: string,
  args: string[],
  options: SpawnOptionsLike,
) => SpawnedProcess;

export const defaultSpawnFunction: SpawnFunction = (file, args, options) =>
  // detached on POSIX so the child leads its own process group and the whole
  // tree can be signalled; Windows termination is identity-bound per member
  // through held handles (ADR-009) — no taskkill /T tree expansion.
  spawn(file, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

export interface BoundedText {
  value: string;
  truncated: boolean;
}

export function appendBounded(current: BoundedText, chunk: string, maxBytes: number): BoundedText {
  if (!(maxBytes > 0)) return { value: current.value + chunk, truncated: current.truncated };
  const remaining = maxBytes - Buffer.byteLength(current.value, "utf8");
  if (remaining <= 0) return chunk ? { value: current.value, truncated: true } : current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining) {
    return { value: current.value + chunk, truncated: current.truncated };
  }
  return {
    value: current.value + bytes.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export interface TerminationResult {
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly verified: true;
  /** Windows-only receipt of the identity-bound transaction (ADR-009). */
  readonly windows?: WindowsTerminationReceipt;
}

export interface TerminateOptions {
  graceMs?: number;
  killWaitMs?: number;
  /** Caller-bound root identity (startup fingerprint). REQUIRED on Windows:
   * the terminator never builds trust from a bare current PID. POSIX keeps
   * its process-group semantics and does not alter behavior for it. */
  expectedRootFingerprint?: string | null;
}

export type TerminateProcessTree = (
  pid: number,
  options?: TerminateOptions,
) => Promise<TerminationResult>;

/**
 * Terminates a process tree and only resolves after termination is verified.
 * Windows (ADR-009): one PowerShell transaction helper holds a handle per
 * verified member; every signal is issued on a held handle after
 * GetProcessTimes on that same handle confirms the recorded startup
 * identity; ownership edges are proven from exact kernel creation/exit
 * times; anything unprovable throws and keeps occupancy. POSIX: SIGTERM to
 * the process group, then SIGKILL, verified by group/pid liveness polls
 * (unchanged semantics).
 */
export const terminateProcessTree: TerminateProcessTree = async (pid, options = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`A positive integer PID is required, got: ${pid}`);
  }
  if (process.platform === "win32") {
    const expected = options.expectedRootFingerprint ?? null;
    if (expected === null) {
      throw new Error("process_tree_root_identity_required: Windows process-tree termination requires a caller-bound root identity");
    }
    const receipt = await terminateWindowsProcessTree(pid, expected, options.killWaitMs ?? 2_000, {
      open: openPowerShellTreeTransaction,
    });
    return { pid, signal: "SIGKILL", verified: true, windows: receipt };
  }
  signalProcessTree(pid, "SIGTERM");
  if (await waitForProcessTreeExit(pid, options.graceMs ?? 500)) {
    return { pid, signal: "SIGTERM", verified: true };
  }
  signalProcessTree(pid, "SIGKILL");
  if (!(await waitForProcessTreeExit(pid, options.killWaitMs ?? 2_000))) {
    throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  }
  return { pid, signal: "SIGKILL", verified: true };
};

/**
 * Read-only verification used by the manager after a failed termination:
 * reports live processes that currently claim any recorded pid as their
 * parent (transitively), plus recorded pids still alive under their recorded
 * generation. A live recorded pid whose current generation differs is a
 * proven foreign owner and its subtree is excluded. It proves "nothing
 * provably-ours-or-unattributable is alive right now"; unobserved
 * intermediate ancestors remain outside any proof and callers must log that
 * boundary instead of claiming completeness.
 */
export interface TreeClaimantTarget {
  readonly pid: number;
  readonly fingerprint: string | null;
}

export async function verifyProcessTreeClaimantsClean(targets: readonly TreeClaimantTarget[]): Promise<{ clean: boolean; livePids: readonly number[] }> {
  if (process.platform === "win32") {
    return verifyWindowsRecordedTreeClaimants(targets, { open: openPowerShellTreeTransaction });
  }
  const live = targets.filter((t) => Number.isInteger(t.pid) && t.pid > 0 && isProcessTreeRunning(t.pid)).map((t) => t.pid);
  return { clean: live.length === 0, livePids: live };
}

// -- Spawn-generation continuity (ADR-009) ----------------------------------
//
// libuv closes the child's native process handle immediately before
// delivering Node's 'exit' event, and Node sets exitCode/signalCode inside
// that same exit callback — before any other JS (including promise
// continuations) can run. Therefore, while exitCode and signalCode are both
// null, either the process is still alive or libuv still holds its handle;
// in both states the PID cannot have been recycled and the child is provably
// still on its original spawn generation. A close/stdio flag alone is NOT
// sufficient: Node delivers 'exit' before stdio 'close', and between the two
// the PID may already be recycled.

export interface SpawnGenerationChildState {
  readonly pid?: number;
  /** Exit state as exposed by a real ChildProcess from Node's exit callback.
   * Missing fields (legacy fakes) prove nothing and must fail closed. */
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  /** Optional exit-event flag from the owner; extra defense, not required. */
  readonly exitSeen?: boolean;
}

/** True while `child` is provably still on its original spawn generation.
 * Missing exit state (undefined) is NOT treated as "not exited": unknown
 * fields never become trusted evidence of continuity. */
export function childStillOnSpawnGeneration(child: SpawnGenerationChildState): boolean {
  if (typeof child.pid !== "number" || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (child.exitSeen === true) return false;
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Captures the child's startup identity for as long as it stays on its
 * original spawn generation. The generation is re-verified AFTER every
 * asynchronous probe await and the child's pid must still match at return; a
 * fingerprint read after the child exited — possibly describing a recycled
 * PID generation — is discarded, never stored. Only exact-precision
 * fingerprints qualify (coarse ones can collide across generations).
 * Resolves null when the identity cannot be proven; Windows termination
 * must then refuse to signal.
 */
export async function captureSpawnGenerationIdentity(
  child: SpawnGenerationChildState,
  probe: { identityOf(pid: number): Promise<{ readonly fingerprint: string | null; readonly fingerprint_precision?: string | null }> },
  options: { retryDelayMs?: number } = {},
): Promise<{ pid: number; fingerprint: string } | null> {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const read = async (): Promise<{ pid: number; fingerprint: string } | null> => {
    let identity: { readonly fingerprint: string | null; readonly fingerprint_precision?: string | null };
    try {
      identity = await probe.identityOf(pid);
    } catch {
      return null;
    }
    if (!childStillOnSpawnGeneration(child)) return null;
    if (typeof identity.fingerprint !== "string" || identity.fingerprint.length === 0) return null;
    if (identity.fingerprint_precision !== "exact") return null;
    if (child.pid !== pid) return null;
    return { pid, fingerprint: identity.fingerprint };
  };
  const first = await read();
  if (first !== null) return first;
  await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 250));
  if (!childStillOnSpawnGeneration(child)) return null;
  return read();
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
    } else {
      throw error;
    }
  }
}

function isProcessTreeRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return isProcessRunning(pid);
    throw error;
  }
}

async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeRunning(pid) && Date.now() < deadline) {
    await sleep(20);
  }
  return !isProcessTreeRunning(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
