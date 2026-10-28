# Codex → ZCode Bridge

> Status: AUTHORITATIVE
> Last updated: 2026-10-28
> Last verified: 2026-10-28 — static review plus eight offline integration checks using real systemd 255, MCP, and Bridge workers; executor and App receiver were fixtures, with no model calls. Real GLM-5.3/max scheduling, continuation, current-App delivery and independent Codex acceptance also passed on this Linux host; a new turn from an idle chat remains unverified.
> Verified against: 0e74ee1c64b179752a24317574916a98c77a5ef1 + scheduling working-tree changes.

**Use ZCode as a coding worker inside Codex.**

Delegate coding tasks from Codex to your local ZCode Agent. Codex assigns tasks, monitors progress, reviews the resulting changes, and decides whether to accept the work or send it back for another iteration.

> **Codex delegates. ZCode codes. Codex reviews.**

[![CI](https://github.com/Sandyzzx/codex-zcode-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Sandyzzx/codex-zcode-bridge/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Sandyzzx/codex-zcode-bridge)](https://github.com/Sandyzzx/codex-zcode-bridge/releases)
[![License](https://img.shields.io/github/license/Sandyzzx/codex-zcode-bridge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#)

[English](README.md) · [简体中文](README.zh-CN.md)

---

## How it works

```text
You
 │  "Implement this feature."
 ▼
Codex ── delegates task ──▶ Codex → ZCode Bridge ── starts / monitors ──▶ ZCode Agent
 ▲                                                                           │
 └──────────── reviews diff, verifies, accepts or continues ◀── reports ─────┘
```

Codex remains responsible for task definition, architecture, review, and acceptance. ZCode handles bounded implementation work in the local development environment. The bridge connects them through MCP and ZCode's local runtime.

### Example

Tell Codex:

> Use ZCode to implement the provider capability probe, run the tests, and report the changes back for review.

Codex can delegate the task, monitor execution, inspect the resulting changes, verify the tests, and accept the result or continue the same ZCode session with follow-up instructions.

---

## 中文简介

**在 Codex 中调用 ZCode 干活。** Codex 派发并审查任务，ZCode 负责在本机执行代码工作。

完整中文说明：[README.zh-CN.md](README.zh-CN.md)。

---

## Features

- Submit, follow, continue, and cancel ZCode tasks from Codex.
- Schedule one goal to start at an absolute time on Linux with user-level systemd supervision. ZCode continues the same session quietly until it self-assesses ready for independent Codex review; Codex can accept or return concrete feedback. This scheduling path is experimental; its full real-ZCode E2E test has not run.
- Run tasks across multiple projects concurrently; tasks sharing an execution directory are queued.
- Read the live ZCode model catalog and reasoning levels, select a provider/model per task, and get/set/clear a Bridge default model.
- At startup, report the project directory, execution directory, ZCode session, runtime-reported model and reasoning level, and execution mode.
- Group ZCode Desktop tasks under the Codex project directory; index sync failures do not stop task execution.
- Unified task observation (`zcode_status.observation`, `zcode_events.observation`): worker/runtime liveness with OS process-identity probing (PID-reuse safe), activity/waiting/stalled hints, result/cleanup state — advisory only, `unknown` never means dead.
- Bounded, resumable event scans (`zcode_events` with `scan_cursor`/`max_bytes`): complete-line parsing, corruption counters, byte-budgeted reads near the log cap.
- Per-attempt usage/model/timing evidence in `zcode_result` (`usage`, `model`, `timing`): runtime-reported token numbers only — missing stays "not reported", totals are never recomputed.
- Large approval inputs (ADR-008): tool-permission params persist completely up to 1 MiB (measured on the compact `JSON.stringify(params)` serialization); requests over the 64,000-byte single-event line are published as an explicitly-marked preview with a private full-request reference (path, byte count, SHA256). Approvals verify the record's bytes/SHA256 under the interaction lock; a record that went missing, corrupt, or edited mid-wait is declined explicitly instead of executing.
- Session frames (ADR-008): newline-delimited JSON-RPC frames are consumed one at a time with a 16 MiB raw-frame UTF-8 limit; a fatal frame error latches its reason, ends pending RPCs and the turn, and blocks further requests instead of surfacing as a timeout.
- Optional project task ledger (`ledger_*` tools, opt-in only): long-lived project tasks, runs, per-AC reviews, and a controlled DONE gate that a worker report alone can never satisfy.

## Install

Requires Node.js 22.18+, Git, ZCode installed and signed in, and the Codex desktop app or CLI with marketplace support. Real ZCode execution has been tested on recorded Windows and Linux environments; macOS remains unverified. Scheduling verification is scoped below.

### Install with Codex CLI

Add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref master
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Install in the Codex desktop app

First run the marketplace-add command above to register the GitHub marketplace. Then open Codex's **Plugins Directory**, choose that marketplace, and install **Zcode Bridge**.

### First run

After installing, start a new conversation and review and trust the plugin's `SessionStart` hook. On Windows, it discovers and validates Node.js, the ZCode runtime, provider configuration, and data directories, then saves settings to `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`. It does not write Windows user environment variables or copy provider credentials. Standard installs do not require cloning the repository or running `npm install`. The marketplace does not install Node.js or ZCode for you.

To customize settings, edit `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json` directly. On macOS/Linux, use `~/.codex/codex-zcode-bridge/runtime-config.json`. The Windows first-run hook creates this file; on other platforms, create it if needed. Keep the discovered path fields and change only the values you need:

- `ZCODE_BRIDGE_NODE`: absolute path to Node.js (only needed when `node` is not on PATH).
- `ZCODE_BRIDGE_ZCODE_CJS`: absolute path to the ZCode runtime.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`: absolute paths to the builtin and personal provider config files.
- `ZCODE_HOME`: absolute path to the actual `.zcode` data directory.
- `ZCODE_BRIDGE_DATA_DIR`: absolute path to the Bridge task data directory.
- `ZCODE_BRIDGE_DEFAULT_PROVIDER_ID` and `ZCODE_BRIDGE_DEFAULT_MODEL_ID`: default provider and model IDs; set both.
- `ZCODE_BRIDGE_MODE`: initial execution mode: `plan`, `build`, `edit`, or `yolo`; defaults to `yolo`. `yolo` allows ordinary tool operations with the current operating-system account's permissions. Set it to `build` to use ZCode's approval rules.
- `ZCODE_BRIDGE_TIMEOUT_MS`: default wall-clock limit for one task attempt when `timeout_ms` is omitted; 60,000–14,400,000 milliseconds, default 3,600,000 (60 minutes).
- `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS`: parallel task limit.
- `ZCODE_BRIDGE_BROWSER_USE`: optional headless browser host for ZCode's native browser tools; `off` (default) or `headless`. When `headless`, the Bridge worker answers `interaction/browserList`/`interaction/browserExecute` reverse RPCs through a managed CDP backend that launches an installed system Chromium/Edge with an isolated temporary profile (nothing is downloaded and the user's own browser windows are never attached). Optional `ZCODE_BRIDGE_BROWSER_EXECUTABLE` sets an absolute executable path. The native model browser flow was verified on the recorded Windows/ZCode version; see `docs/reports/2026-10-15-browser-and-transport-fixes.md` for scope and remaining limitations.

Save valid JSON; a newly started Bridge reads the config file, which takes precedence over legacy environment variables. `ZCODE_HOME` must point to the `.zcode` directory, and the personal provider config must be at `v2/provider_config.json` inside it. Copy provider/model IDs from your ZCode configuration, and do not edit ZCode's provider files.

See the [official OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and plugin details.

## Use

Describe the development task and its acceptance criteria. Codex decides whether to prepare a worktree, then delegates the task to ZCode. ZCode runs in that worktree when provided, or directly in the project directory otherwise. ZCode does not automatically receive the full Codex conversation, so Codex must include any required project decisions and constraints with the task.

ZCode generates the session title from the first task prompt. The Bridge puts `TASK ID` on the first line, but the displayed title may also include following prompt text.

After execution, Codex should inspect the actual diff and run acceptance checks independently. `completed` means ZCode reported the task finished; it does not mean Codex approved the changes. If an unresolved decision could materially affect behavior, ZCode asks Codex for direction before proceeding on that point.

In ZCode Desktop, find tasks in the Workspace view under the Codex project directory.

For installation or startup problems, call the `zcode_doctor` MCP tool for setup diagnostics. It does not start a ZCode session. Use `zcode_model_catalog` to read the cached or live app-server model list; a real permission-approval roundtrip still requires an actual task.

Use `zcode_model_catalog` with the current project path to read app-server model IDs and reasoning levels. Pass a selected `provider_id`/`model_id` in `zcode_task.model` for one task. Use `zcode_set_default_model` to configure the default for future tasks, `zcode_default_model` to read it, and `zcode_clear_default_model` to return to the ZCode session default. The catalog is cached for one day; provider config changes invalidate it. On a cache miss, the Bridge creates and closes a deferred session without sending a prompt. If a refresh fails, it re-reads provider config and retries once. A persistent failure reports an error with a `zcode_doctor` diagnostic step and never returns an expired catalog.

If a `zcode_task` call times out or loses its response, query or retry with the same `task_id`; identical submissions replay the original receipt and changed content is rejected. For retryable `zcode_continue` calls, supply a stable `operation_id` so a lost response cannot increment the attempt twice.

### Scheduled goals (experimental, Linux)

Ask Codex to start one bounded goal at a specific date, time, and timezone, continue quietly until its acceptance criteria are met, and return to the current chat for independent review. The default Codex stdio host exposes `zcode_schedule`, `zcode_schedule_status`, `zcode_schedule_review`, and `zcode_schedule_cancel` in addition to the 13 core tools. Other hosts must explicitly compose the scheduler.

`zcode_schedule` takes a complete `task`, an ISO 8601 `start_at` with `Z` or an explicit offset, and the original local Codex chat's `thread_id`. Codex must obtain that UUID from the current host context under the user's authorization. One `task_id` identifies one scheduled goal; an identical retry reuses it, and conflicting submissions fail. This is one delayed start followed by continued work, with no recurring creation of new tasks.

The scheduler requires an available Linux user systemd manager, `systemd-run` with `--expand-environment=no` support (systemd 254 or newer), and a Codex App tools pipe. It records the supervisor unit and log path, waits until the start time, and resumes from persisted state after a runner crash. It does not enable linger or promise operation across logout, shutdown, or App closure. Missing scheduling support does not disable the ordinary task tools.

Only scheduled prompts require the optional boolean `acceptance_met`. A completed attempt with `false` continues the same task and ZCode session quietly; `true` wakes the bound chat for independent inspection and acceptance checks. Codex then calls `zcode_schedule_review` with the current `attempt` and either `accepted: true`, or `accepted: false` plus concrete feedback to continue that session. A self-assessment, `completed`, or successful wakeup delivery alone never means acceptance. Normal progress and rejected reviews stay quiet for the human; notify them when Codex accepts the work or a critical issue requires attention.

Missing or invalid self-assessment, decisions, pending permission/input requests, failures, quota exhaustion, or unverified cleanup wake Codex for judgment. Permissions are never auto-approved. A timeout can resume automatically only with a saved session and verified cleanup; quota exhaustion never triggers automatic continuation. Cancel through `zcode_schedule_cancel` so the persisted stop intent blocks future automatic work before task cleanup. If the MCP caller disappears, the runner resumes that cancellation; unverified cleanup stops cancellation retries and wakes Codex with `cancel_failed` for a decision.

Wakeups use a persisted outbox with at-least-once delivery: a lost receipt can cause duplicates. Codex rechecks authoritative task state and the stable event ID before acting; stale attempts cannot be reviewed. The adapter uses an App-internal pipe observed on Linux App 26.1016.61520 / codex-app-tools 0.1.6, with no public cross-version guarantee. On 2026-10-28, eight offline integration checks passed using the source-built plugin, real systemd 255, MCP, and Bridge workers; the executor and App receiver were fixtures, with no model calls. Real GLM-5.3/max scheduling, same-session continuation, current-App delivery and independent Codex acceptance subsequently passed, including runner recovery, verified-cleanup timeout continuation and running cancellation. The idle-chat new-turn check remains unverified because a new user request resumed the chat before that callback arrived; historical idle wakeup evidence is separate. See the [live validation report](docs/reports/2026-10-28-scheduled-zcode-live-validation.md). See [ADR-010](docs/decisions/ADR-010-scheduled-zcode-and-codex-wakeup.md) and the [interface contract](docs/INTERFACES.md).

## Known issues

- The ZCode Desktop sidebar may not immediately show a new session. The Bridge best-effort syncs the local task index; Desktop controls when the list refreshes.
- ZCode Start Plan is currently unavailable through the Bridge.
- Workers have a 10-second cold-start grace window. A worker that never began may be respawned once; an attempt that claimed execution never executes twice. Managers sharing a data root serialize scheduling across processes. Separate data roots do not share a lock; avoid submitting tasks against overlapping execution directories through them.
- Unverified runtime cleanup reserves the task's execution directory and prevents continuation. Call `zcode_cancel` again to verify cleanup before releasing it. Corrupt records are diagnosed and their known directories remain reserved; an unknown execution scope pauses new scheduling.

## Security and limitations

- The default execution mode is `yolo`. It allows ordinary tool operations with the current operating-system account's permissions; a worktree is not a sandbox. Set `ZCODE_BRIDGE_MODE` to `build` to use ZCode's approval rules. A real permission-approval roundtrip has been verified on the recorded Windows/ZCode version (a single 43,014-byte Write approved through the full persistence and reply path with byte/SHA256-verified content); other approval combinations were not certified. Integrity hashes on approval records detect corruption and accidental edits; they are not a security isolation against a malicious same-OS-account process.
- A Git worktree isolates the working directory; it is not an operating-system sandbox. `allowed_paths` and `forbidden_paths` describe task constraints but cannot prevent the process from accessing other files or running commands.
- Codex decides whether to create a worktree. The Bridge uses the supplied project directory and optional worktree path; it does not create or remove worktrees.
- Parallel tasks use more local resources and provider capacity.
- The Bridge stores prompts, status, logs, visible model output, events, and results locally in `~/.codex/codex-zcode-bridge/` (on Windows: `%USERPROFILE%\.codex\codex-zcode-bridge\`). Do not include credentials or data in tasks or workspaces if they should not be sent to the selected model service.
- The Bridge uses the local ZCode app-server. Interactions and available events depend on the installed ZCode version. For AskUserQuestion replies, key `answers` by each full `questions[].question` text and use the selected or explicit answer as its value; do not use the header or option label as the key. Large permission requests arrive as an explicitly-marked preview event with a `full_request` reference (the preview is not the full input; the reference carries byte count and SHA256 over the compact serialized params). Only allow permission requests when the user explicitly authorizes the action.

## Build from source

See [SHARED_CORE.md](docs/SHARED_CORE.md) for host integration, [ARCHITECTURE.md](docs/ARCHITECTURE.md) for current architecture, and [INTERFACES.md](docs/INTERFACES.md) for contracts. `npm test` uses disposable homes and fake runtimes, including a real worker's 60-second timeout; it does not call a real model or write a real Desktop database. Oversized task prompts and corrupt existing runtime settings fail explicitly. The experimental `zcode_progress_probe` is disabled by default.

The repository includes TypeScript source for review and self-builds. With Node.js 22.18+:

```sh
npm ci
npm run build
```

## Acknowledgements and license

Process handling is adapted in part from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex); ZCode Desktop task-index integration is adapted in part from [zcode-acp](https://github.com/william0wang/zcode-acp). Thanks to the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project. See [NOTICE](NOTICE) for source and copyright details.

This project is licensed under [Apache License 2.0](LICENSE). Third-party components remain subject to their respective licenses.
