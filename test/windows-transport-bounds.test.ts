// Review-round-1 addendum R4 (incl. 13:13 review): the PowerShell
// transaction transport must be bounded against oversized lines, endless
// streams (bytes AND line counts, including empty lines), oversized
// enumerations, expired sessions with fully buffered data, and post-failure
// data — all with FAKE streams, no OS processes. Close must verify the
// helper's actual exit code/signal.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PowerShellTreeTransaction, type TransportBounds } from "../src/adapters/windows-process-cleanup.js";

class FakeStream extends EventEmitter {
  setEncoding(): void {
    // encoding is irrelevant for string pushes in the fake
  }
}

interface CloseScript {
  readonly closed: string;
  readonly failed: string;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

class FakeChild {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly #stdinEmitter = new EventEmitter();
  readonly pid = 42_424;
  killCount = 0;
  closeScript: CloseScript = { closed: "0", failed: "0", exitCode: 0, exitSignal: null };
  #closeListener: ((code: number | null, signal: string | null) => void) | null = null;
  #errorListener: ((error: Error) => void) | null = null;
  #swallowCommands = false;

  constructor() {
    // The transport writes protocol commands; script the close reply here.
    (this.#stdinEmitter as unknown as { write: (chunk: string) => void }).write = (chunk: string) => {
      if (this.#swallowCommands) return;
      if (chunk.trim() === "close") {
        this.stdout.emit("data", `CLOSED ${this.closeScript.closed} ${this.closeScript.failed}\n`);
        setImmediate(() => this.exitHelper(this.closeScript.exitCode, this.closeScript.exitSignal));
      }
    };
  }

  get stdin(): NodeJS.WritableStream {
    return this.#stdinEmitter as unknown as NodeJS.WritableStream;
  }

  /** When set, commands receive no reply and the helper never exits. */
  swallowCommands(): void {
    this.#swallowCommands = true;
  }

  emitStdout(chunk: string): void {
    this.stdout.emit("data", chunk);
  }

  /** Simulates the helper exiting. */
  exitHelper(code: number | null = 0, signal: string | null = null): void {
    this.#closeListener?.(code, signal);
  }

  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === "close") this.#closeListener = listener as (code: number | null, signal: string | null) => void;
    if (event === "error") this.#errorListener = listener as (error: Error) => void;
  }

  kill(): boolean {
    this.killCount += 1;
    // A killed helper dies: signal exit shortly after the kill lands.
    setImmediate(() => this.exitHelper(null, "SIGKILL"));
    return true;
  }
}

function attach(fake: FakeChild, bounds: TransportBounds): PowerShellTreeTransaction {
  return PowerShellTreeTransaction.attach(fake as unknown as Parameters<typeof PowerShellTreeTransaction.attach>[0], bounds);
}

test("transport: an oversized protocol line fails the stream bound immediately", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { maxLineBytes: 64 });
  const pending = transaction.enumerate();
  fake.emitStdout("ENUM_BEGIN\n");
  fake.emitStdout(`${"x".repeat(200)}\n`);
  await assert.rejects(pending, /process_tree_transport_overflow/);
});

test("transport: a burst beyond the buffered-LINE budget fails even when every line is empty", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { maxBufferedLines: 50 });
  const pending = transaction.enumerate();
  // One synchronous burst: ENUM_BEGIN is consumed by the pending waiter; the
  // remaining empty lines have no reader and must trip the line-count budget.
  fake.emitStdout(`ENUM_BEGIN\n${"\n".repeat(200)}`);
  await assert.rejects(pending, /process_tree_transport_overflow/);
});

test("transport: data after a failure is neither buffered nor served", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { maxLineBytes: 64 });
  const first = transaction.enumerate();
  fake.emitStdout("ENUM_BEGIN\n");
  fake.emitStdout(`${"x".repeat(200)}\n`);
  await assert.rejects(first, /process_tree_transport_overflow/);
  // The failed transport keeps receiving but must not resurrect.
  fake.emitStdout("ENUM_BEGIN\nENUM_END\n");
  fake.emitStdout(`${"y".repeat(500)}\n`);
  await assert.rejects(transaction.enumerate(), /process_tree_transport_overflow/);
});

test("transport: an expired session does not serve already-buffered lines", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { totalSessionMs: 120, maxEnumRows: 4_096, maxBufferedLines: 65_536 });
  const pending = transaction.enumerate();
  // Attach the rejection expectation BEFORE the budget expires so the
  // mid-test rejection is always handled.
  const expectation = assert.rejects(pending, /process_tree_transport_(session_)?timeout/);
  fake.emitStdout("ENUM_BEGIN\nR 1 1 1 1\nR 2 1 1 1\n"); // begin consumed; rows buffered
  await new Promise((resolve) => setTimeout(resolve, 200));
  await expectation;
});

test("transport: an enumeration beyond the row cap fails the snapshot", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { maxEnumRows: 4 });
  const pending = transaction.enumerate();
  fake.emitStdout("ENUM_BEGIN\n");
  for (let index = 0; index < 6; index += 1) fake.emitStdout(`R ${String(1_000 + index)} 1 1 1\n`);
  await assert.rejects(pending, /exceeded 4 rows/);
});

test("transport: a stalled session hits the TOTAL budget, not just a per-line timeout", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { totalSessionMs: 150, maxEnumRows: 4_096, maxBufferedLines: 65_536 });
  const pending = transaction.enumerate();
  // The helper keeps trickling VALID rows forever; without a total budget
  // each line would reset a per-line wait indefinitely. The session cap
  // bounds the whole exchange.
  fake.emitStdout("ENUM_BEGIN\n");
  const trickle = setInterval(() => fake.emitStdout("R 1 1 1 1\n"), 20);
  try {
    await assert.rejects(pending, (error: unknown) => {
      assert.match((error as Error).message, /process_tree_transport_(timeout|session_timeout)/);
      return true;
    });
  } finally {
    clearInterval(trickle);
  }
});

test("transport: an oversized unterminated line (no newline) fails the bound", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, { maxLineBytes: 64 });
  const pending = transaction.enumerate();
  fake.emitStdout("ENUM_BEGIN\n");
  fake.emitStdout("y".repeat(300));
  await assert.rejects(pending, /process_tree_transport_overflow/);
});

test("transport: close verifies the receipt, a clean exit, and accepts the exchange", async () => {
  const fake = new FakeChild();
  const transaction = attach(fake, {});
  await assert.doesNotReject(transaction.close());
  assert.equal(fake.killCount, 0, "a clean close never needs the kill fallback");
});

test("transport: close fails when the helper exits abnormally despite a valid receipt", async () => {
  const fake = new FakeChild();
  fake.closeScript = { closed: "0", failed: "0", exitCode: 1, exitSignal: null };
  const transaction = attach(fake, {});
  await assert.rejects(transaction.close(), /process_tree_close_abnormal/);
});

test("transport: close fails when CloseHandle reports failures in the receipt", async () => {
  const fake = new FakeChild();
  fake.closeScript = { closed: "2", failed: "1", exitCode: 0, exitSignal: null };
  const transaction = attach(fake, {});
  await assert.rejects(transaction.close(), /CloseHandle call\(s\) failed/);
});

test("transport: close fails when the helper refuses to exit and the kill fallback converges visibly", async () => {
  const fake = new FakeChild();
  fake.swallowCommands();
  const transaction = attach(fake, { totalSessionMs: 250 });
  // The fake child has no real OS handle, so keep the loop alive for the
  // unref'd transport timers while the bounded close runs.
  const keepAlive = setInterval(() => undefined, 50);
  try {
    await assert.rejects(transaction.close(), (error: unknown) => {
      assert.match((error as Error).message, /process_tree_transport_(session_)?timeout|process_tree_close/);
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(fake.killCount >= 1, "the bounded kill fallback ran");
});
