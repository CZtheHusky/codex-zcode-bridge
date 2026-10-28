import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createMinimalOsEnv } from "./child-env.js";
import { buildAccountProviderPayload, zcodeDataBaseDir, runtimeAuthReply } from "./account-provider.js";
import { BridgeError } from "./errors.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver } from "./resolver.js";
import { ZCODE_SESSION_MODES, type ZCodeSessionMode } from "./session-preferences.js";
import type { ZCodeRuntimeConfig } from "../interfaces.js";
import { captureSpawnGenerationIdentity, childStillOnSpawnGeneration, createPlatformProbe, terminateProcessTree } from "../adapters/process-spawn.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { withProcessLock } from "../store/process-lock.js";
import { atomicRename } from "../store/atomic-rename.js";

type JsonRecord = Record<string, unknown>;

export interface ZCodeModelCatalogEntry {
  provider_id: string;
  model_id: string;
  label: string;
  provider_label?: string;
  context_window?: number;
  max_output_tokens?: number;
  reasoning_levels?: Array<{ value: string; label: string }>;
  reasoning_default_level?: string;
  disabled_reason?: string;
}

export interface ZCodeModelCatalog {
  workspace: string;
  current_model: { provider_id: string; model_id: string } | null;
  models: ZCodeModelCatalogEntry[];
  account_provider_sync: "not_needed" | "applied" | "failed";
  cache_status?: "fresh" | "refreshed";
  cached_at?: string;
  warning?: string;
}

export interface DefaultModelSelection {
  provider_id: string;
  model_id: string;
  reasoning_level?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface AppServerProcess {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params: JsonRecord): Promise<unknown>;
  close(): Promise<void>;
  readonly stderr: string;
}

interface CatalogSource {
  config: ZCodeRuntimeConfig;
  runtimeEnv: NodeJS.ProcessEnv;
  cachePath: string;
  fingerprint: string;
}

const RPC_TIMEOUT_MS = 30_000;
const PROCESS_CLOSE_TIMEOUT_MS = 1_500;
const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;

/** Read the live app-server catalog and manage Bridge's persistent model default. */
export class ZCodeModelSettings {
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #host: BridgeHostProfile;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(sourceEnv: NodeJS.ProcessEnv = process.env, options: { homeDir?: string; host?: BridgeHostProfile } = {}) {
    this.#sourceEnv = sourceEnv;
    this.#homeDir = options.homeDir ?? homedir();
    this.#host = validateHostProfile(options.host ?? codexHostProfile(this.#homeDir));
  }

  async listModels(workspace: string): Promise<ZCodeModelCatalog> {
    const requestedWorkspace = workspace.trim();
    if (!path.isAbsolute(requestedWorkspace)) {
      throw new BridgeError("provider_config_invalid", "workspace must be an absolute existing directory");
    }
    let workspacePath: string;
    try {
      workspacePath = await realpath(requestedWorkspace);
      if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new BridgeError("provider_config_invalid", `workspace is not an accessible directory: ${requestedWorkspace}`);
    }

    let source: CatalogSource;
    try {
      source = await this.#resolveCatalogSource(workspacePath);
    } catch {
      // Provider files can be replaced while we read them. Resolve once more
      // before asking the caller to repair a persistent configuration error.
      try {
        source = await this.#resolveCatalogSource(workspacePath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const code = error instanceof BridgeError ? error.code : "provider_config_invalid";
        throw new BridgeError(code, `Could not load the ZCode runtime/provider configuration after retrying: ${reason}. Run zcode_doctor for the failing path, correct it, then call zcode_model_catalog again.`, { cause: error });
      }
    }
    const cached = await readModelCatalogCache(source.cachePath);
    const cacheAge = cached ? Date.now() - cached.cached_at_ms : null;
    if (cached && cached.source_fingerprint === source.fingerprint && cacheAge !== null &&
        cacheAge >= 0 && cacheAge < MODEL_CATALOG_TTL_MS) {
      return {
        workspace: workspacePath,
        current_model: null,
        models: cached.models,
        account_provider_sync: "not_needed",
        cache_status: "fresh",
        cached_at: new Date(cached.cached_at_ms).toISOString(),
      };
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Re-read the persisted settings and provider files after a failed
        // attempt, so a concurrent Desktop/config update can recover here.
        const currentSource = attempt === 0 ? source : await this.#resolveCatalogSource(workspacePath);
        return await this.#readLiveCatalog(workspacePath, currentSource);
      } catch (error) {
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const code = lastError instanceof BridgeError ? lastError.code : "zcode_nonzero_exit";
    throw new BridgeError(code, `Model catalog refresh failed after re-reading provider config and retrying: ${reason}. Run zcode_doctor to identify a missing or invalid runtime/provider file; after correcting it, call zcode_model_catalog again.`, { cause: lastError });
  }

  async #resolveCatalogSource(workspacePath: string): Promise<CatalogSource> {
    const runtimeEnv = loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
    const config = await new NodeRuntimeResolver({ env: runtimeEnv, homeDir: this.#homeDir, host: this.#host }).resolve();
    const cachePath = modelCatalogCachePath(workspacePath, config, runtimeEnv, this.#host.settingsDirectory);
    const fingerprint = await modelCatalogSourceFingerprint(config, runtimeEnv);
    return { config, runtimeEnv, cachePath, fingerprint };
  }

  async #readLiveCatalog(workspacePath: string, source: CatalogSource): Promise<ZCodeModelCatalog> {
    const { config, runtimeEnv, cachePath, fingerprint } = source;
    const childEnv = buildRuntimeChildEnv(config, runtimeEnv);
    const client = startAppServer(config, workspacePath, childEnv);
    let sessionId: string | null = null;
    let accountSync: ZCodeModelCatalog["account_provider_sync"] = "not_needed";
    let warning: string | undefined;
    try {
      const accountPayload = buildAccountProviderPayload(config);
      if (accountPayload) {
        try {
          await client.request("provider/updateAccountConfig", accountPayload as unknown as JsonRecord);
          accountSync = "applied";
        } catch (error) {
          throw new BridgeError("zcode_nonzero_exit", `Account provider synchronization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }

      const configuredMode = runtimeEnv["ZCODE_BRIDGE_MODE"]?.trim() || "yolo";
      const mode: ZCodeSessionMode = (ZCODE_SESSION_MODES as readonly string[]).includes(configuredMode)
        ? configuredMode as ZCodeSessionMode
        : "build";
      const snapshot = asRecord(await client.request("session/create", {
        workspace: { workspacePath, workspaceKey: workspacePath },
        mode,
        persistence: "deferred",
      }));
      sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new BridgeError("zcode_nonzero_exit", "ZCode app-server did not return a session ID");

      const settings = asRecord(snapshot.settings);
      const modelSettings = asRecord(settings.model);
      const rawAvailable = Array.isArray(modelSettings.available) ? modelSettings.available : [];
      const models = rawAvailable.map(toCatalogEntry).filter((entry): entry is ZCodeModelCatalogEntry => entry !== null);
      const current = toModelRef(modelSettings.current);
      if (models.length === 0) throw new BridgeError("zcode_nonzero_exit", "ZCode app-server returned an empty model catalog for this workspace");
      const cachedAt = Date.now();
      await writeModelCatalogCache(cachePath, { cached_at_ms: cachedAt, source_fingerprint: fingerprint, models }).catch(() => undefined);
      return {
        workspace: workspacePath,
        current_model: current,
        models,
        account_provider_sync: accountSync,
        cache_status: "refreshed",
        cached_at: new Date(cachedAt).toISOString(),
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError(
        "zcode_nonzero_exit",
        message,
        { cause: error },
      );
    } finally {
      if (sessionId) await client.request("session/close", { sessionId }).catch(() => undefined);
      await client.close();
    }
  }

  async getDefaultModel(): Promise<{ configured: boolean; model: DefaultModelSelection | null }> {
    const env = loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
    const providerId = env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "";
    const modelId = env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim() ?? "";
    const reasoningLevel = env["ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL"]?.trim() ?? "";
    if (Boolean(providerId) !== Boolean(modelId)) {
      throw new BridgeError("provider_config_invalid", "Stored default model is incomplete; provider_id and model_id must be set together");
    }
    if (!providerId) return { configured: false, model: null };
    return {
      configured: true,
      model: { provider_id: providerId, model_id: modelId, ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}) },
    };
  }

  async setDefaultModel(selection: DefaultModelSelection): Promise<{ configured: true; model: DefaultModelSelection }> {
    const providerId = selection.provider_id.trim();
    const modelId = selection.model_id.trim();
    const reasoningLevel = selection.reasoning_level?.trim();
    if (!providerId || !modelId || (selection.reasoning_level !== undefined && !reasoningLevel)) {
      throw new BridgeError("provider_config_invalid", "provider_id, model_id, and any supplied reasoning_level must be non-empty");
    }
    await this.#updateConfig((config) => {
      config.ZCODE_BRIDGE_DEFAULT_PROVIDER_ID = providerId;
      config.ZCODE_BRIDGE_DEFAULT_MODEL_ID = modelId;
      if (reasoningLevel) config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = reasoningLevel;
      else config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = null;
    });
    return { configured: true, model: { provider_id: providerId, model_id: modelId, ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}) } };
  }

  async clearDefaultModel(): Promise<{ configured: false; model: null }> {
    await this.#updateConfig((config) => {
      // Explicit nulls override inherited environment values in
      // loadPersistedRuntimeEnvironment and make clear durable.
      config.ZCODE_BRIDGE_DEFAULT_PROVIDER_ID = null;
      config.ZCODE_BRIDGE_DEFAULT_MODEL_ID = null;
      config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = null;
    });
    return { configured: false, model: null };
  }

  #updateConfig(update: (config: JsonRecord) => void): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(this.#host.settingsDirectory, { recursive: true });
      return withProcessLock(path.join(this.#host.settingsDirectory, ".settings.lock"), async () => {
        const configPath = path.join(this.#host.settingsDirectory, "runtime-config.json");
        let config: JsonRecord = {};
        try {
          const info = await stat(configPath);
          if (!info.isFile() || info.size > 64 * 1024) {
            throw new BridgeError("provider_config_invalid", "Bridge runtime config is not a small regular JSON file");
          }
          const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
          if (!isRecord(parsed)) throw new BridgeError("provider_config_invalid", "Bridge runtime config must contain a JSON object");
          config = parsed;
        } catch (error) {
          if (isMissingFile(error)) {
            config = {};
            for (const directory of this.#host.legacySettingsDirectories ?? []) {
              const legacyPath = path.join(directory, "runtime-config.json");
              try {
                if ((await stat(legacyPath)).size > 64 * 1024) throw new Error("legacy settings exceed size limit");
                const legacy: unknown = JSON.parse(await readFile(legacyPath, "utf8"));
                if (!isRecord(legacy)) throw new Error("invalid legacy settings");
                loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
                config = legacy;
                break;
              } catch (legacyError) {
                if (!isMissingFile(legacyError)) throw new BridgeError("provider_config_invalid", "Could not migrate host runtime settings", { cause: legacyError });
              }
            }
          }
          else if (error instanceof BridgeError) throw error;
          else throw new BridgeError("provider_config_invalid", "Could not read Bridge runtime config", { cause: error });
        }
        update(config);
        const serialized = `${JSON.stringify(config, null, 2)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
          throw new BridgeError("provider_config_invalid", "Updated Bridge runtime config would exceed 64 KiB");
        }
        const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await atomicRename(tempPath, configPath);
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw new BridgeError("provider_config_invalid", `Could not save Bridge runtime config: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

function buildRuntimeChildEnv(config: ZCodeRuntimeConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = createMinimalOsEnv(source);
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
  if (source.ZCODE_HOME) env.ZCODE_HOME = source.ZCODE_HOME;
  const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
  if (dataBaseDir) env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  return env;
}

function startAppServer(config: ZCodeRuntimeConfig, cwd: string, env: NodeJS.ProcessEnv): AppServerProcess {
  const child = spawn(config.nodeExecutable, [config.zcodeEntrypoint, "app-server", "--stdio"], {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<string | number, PendingRequest>();
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 0;
  let closed = false;
  // ADR-009 spawn-generation continuity: libuv releases the child's native
  // handle when it delivers 'exit' (before stdio close), so continuity is
  // tracked from the exit state, never from a close flag. The identity
  // capture re-verifies the generation after every await and discards
  // results that raced an exit (a recycled PID's fingerprint must never be
  // stored as this spawn's identity).
  let childExitSeen = false;
  child.once("exit", () => {
    childExitSeen = true;
  });
  const generationChild = {
    get pid() { return child.pid; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    get exitSeen() { return childExitSeen; },
  };
  let childIdentity: { pid: number; fingerprint: string } | null = null;
  if (process.platform === "win32" && child.pid) {
    void captureSpawnGenerationIdentity(generationChild, createPlatformProbe()).then((identity) => {
      childIdentity = identity;
    });
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const write = (message: JsonRecord): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > 2_000_000) stdoutBuffer = stdoutBuffer.slice(-2_000_000);
    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRecord;
      try { message = asRecord(JSON.parse(line)); } catch { continue; }
      if (message.method === "session/requestRuntimePreferences" && (typeof message.id === "string" || typeof message.id === "number")) {
        write({ id: message.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } });
      } else if (message.method === "interaction/requestProviderRuntimeHeaders" && (typeof message.id === "string" || typeof message.id === "number")) {
        const params = asRecord(message.params);
        const selection = asRecord(params.modelSelection);
        const providerId = typeof selection.providerId === "string" ? selection.providerId : typeof params.providerId === "string" ? params.providerId : undefined;
        write({ id: message.id, result: runtimeAuthReply(providerId, config) });
      } else if (message.id !== undefined && message.method === undefined) {
        const call = pending.get(message.id as string | number);
        if (!call) continue;
        clearTimeout(call.timer);
        pending.delete(message.id as string | number);
        if (message.error !== undefined) {
          const error = asRecord(message.error);
          call.reject(new Error(`ZCode app-server request failed${typeof error.code === "number" ? ` (code ${error.code})` : ""}`));
        } else call.resolve(message.result);
      } else if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string") {
        write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
      }
    }
  });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length); });
  child.on("error", (error) => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  });
  child.on("close", (code, signal) => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`ZCode app-server exited (${String(code)}${signal ? `, ${signal}` : ""})`));
    }
    pending.clear();
  });
  const request = (method: string, params: JsonRecord): Promise<unknown> => {
    if (closed) return Promise.reject(new Error(`ZCode app-server is closed before ${method}`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ZCode app-server request timed out: ${method}`)); }, RPC_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer); pending.delete(id); reject(error);
      });
    });
  };
  const close = async (): Promise<void> => {
    if (!closed) {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PROCESS_CLOSE_TIMEOUT_MS);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (child.pid && (!closed || process.platform !== "win32")) {
      // Windows: only signal while the child is provably on its original
      // spawn generation; after exit the PID may be recycled and a missing
      // captured identity is a conservative refusal, never bare-PID trust.
      if (process.platform === "win32" && !childStillOnSpawnGeneration(generationChild)) return;
      await terminateProcessTree(child.pid, {
        graceMs: 500,
        killWaitMs: 5_000,
        expectedRootFingerprint: childIdentity?.pid === child.pid ? childIdentity.fingerprint : null,
      });
    }
  };
  return { child, request, close, get stderr() { return stderr; } };
}

function toCatalogEntry(value: unknown): ZCodeModelCatalogEntry | null {
  const entry = asRecord(value);
  const ref = toModelRef(entry.ref);
  if (!ref) return null;
  const reasoning = asRecord(entry.reasoning);
  const rawLevels = Array.isArray(reasoning.levels) ? reasoning.levels : [];
  const reasoningLevels = rawLevels.flatMap((raw) => {
    const level = asRecord(raw);
    if (typeof level.value !== "string" || !level.value.trim()) return [];
    return [{ value: level.value, label: typeof level.label === "string" && level.label.trim() ? level.label : level.value }];
  });
  const defaultLevel = typeof reasoning.defaultLevel === "string" && reasoningLevels.some((level) => level.value === reasoning.defaultLevel)
    ? reasoning.defaultLevel
    : undefined;
  return {
    ...ref,
    label: typeof entry.label === "string" ? entry.label : ref.model_id,
    ...(typeof entry.providerLabel === "string" ? { provider_label: entry.providerLabel } : {}),
    ...(typeof entry.contextWindow === "number" ? { context_window: entry.contextWindow } : {}),
    ...(typeof entry.maxOutputTokens === "number" ? { max_output_tokens: entry.maxOutputTokens } : {}),
    ...(reasoningLevels.length ? { reasoning_levels: reasoningLevels } : {}),
    ...(defaultLevel ? { reasoning_default_level: defaultLevel } : {}),
    ...(typeof entry.disabledReason === "string" ? { disabled_reason: entry.disabledReason } : {}),
  };
}

function toModelRef(value: unknown): { provider_id: string; model_id: string } | null {
  const ref = asRecord(value);
  return typeof ref.providerId === "string" && typeof ref.modelId === "string"
    ? { provider_id: ref.providerId, model_id: ref.modelId }
    : null;
}

function nestedString(record: JsonRecord, keys: string[]): string | null {
  let value: unknown = record;
  for (const key of keys) value = asRecord(value)[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

interface CachedModelCatalog {
  cached_at_ms: number;
  source_fingerprint: string;
  models: ZCodeModelCatalogEntry[];
}

function modelCatalogCachePath(workspace: string, config: ZCodeRuntimeConfig, env: NodeJS.ProcessEnv, settingsDirectory: string): string {
  const identity = JSON.stringify({
    workspace,
    node: config.nodeExecutable,
    entrypoint: config.zcodeEntrypoint,
    builtin: config.providerBuiltinConfigFile,
    personal: config.providerPersonalConfigFile,
    zcodeHome: env.ZCODE_HOME ?? "",
  });
  const key = createHash("sha256").update(identity).digest("hex");
  return path.join(settingsDirectory, "model-catalog", `${key}.json`);
}

async function modelCatalogSourceFingerprint(config: ZCodeRuntimeConfig, env: NodeJS.ProcessEnv): Promise<string> {
  const digest = createHash("sha256");
  // Hash only: provider contents and credentials are never written to cache.
  for (const file of [config.providerBuiltinConfigFile, config.providerPersonalConfigFile]) {
    digest.update(file);
    digest.update(await readFile(file));
  }
  const entry = await stat(config.zcodeEntrypoint);
  digest.update(JSON.stringify({ entrypoint: config.zcodeEntrypoint, size: entry.size, mtimeMs: entry.mtimeMs, mode: env.ZCODE_BRIDGE_MODE?.trim() || "yolo" }));
  const account = buildAccountProviderPayload(config);
  if (account) digest.update(JSON.stringify({ providers: account.providers, states: account.states, builtinRevision: account.basedOnZCodeBuiltinRevision }));
  return digest.digest("hex");
}

async function readModelCatalogCache(cachePath: string): Promise<CachedModelCatalog | null> {
  try {
    const info = await stat(cachePath);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isRecord(value) || !Number.isFinite(value.cached_at_ms) || typeof value.source_fingerprint !== "string" || !Array.isArray(value.models)) return null;
    const models = value.models.map(toCachedCatalogEntry).filter((entry): entry is ZCodeModelCatalogEntry => entry !== null);
    if (models.length !== value.models.length || models.length === 0) return null;
    return { cached_at_ms: value.cached_at_ms as number, source_fingerprint: value.source_fingerprint, models };
  } catch {
    return null;
  }
}

function toCachedCatalogEntry(value: unknown): ZCodeModelCatalogEntry | null {
  if (!isRecord(value) || typeof value.provider_id !== "string" || !value.provider_id ||
      typeof value.model_id !== "string" || !value.model_id || typeof value.label !== "string") return null;
  if (value.reasoning_levels !== undefined && (!Array.isArray(value.reasoning_levels) ||
      !value.reasoning_levels.every((level: unknown) => isRecord(level) && typeof level.value === "string" && typeof level.label === "string"))) return null;
  for (const key of ["provider_label", "reasoning_default_level", "disabled_reason"]) if (value[key] !== undefined && typeof value[key] !== "string") return null;
  for (const key of ["context_window", "max_output_tokens"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ["provider_id", "model_id", "label", "provider_label", "context_window", "max_output_tokens", "reasoning_default_level", "disabled_reason"]) if (value[key] !== undefined) result[key] = value[key];
  if (Array.isArray(value.reasoning_levels)) result.reasoning_levels = value.reasoning_levels.map((level) => ({ value: level.value, label: level.label }));
  return result as unknown as ZCodeModelCatalogEntry;
}

async function writeModelCatalogCache(cachePath: string, cache: CachedModelCatalog): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(cache)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await atomicRename(tempPath, cachePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
