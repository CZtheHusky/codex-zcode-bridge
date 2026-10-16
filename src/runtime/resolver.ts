// RuntimeResolver per docs/INTERFACES.md (frozen) and the runtime behavior in
// docs/ARCHITECTURE.md:
// - Bridge overrides: ZCODE_BRIDGE_NODE, ZCODE_BRIDGE_ZCODE_CJS, ZCODE_BRIDGE_DATA_DIR.
// - Provider config: prefer a valid inherited official pair
//   (ZCODE_BUILTIN_PROVIDER_CONFIG_FILE + ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
//   otherwise resolve the builtin from the ZCode installation and the personal
//   config from ZCODE_DATA_BASE_DIR or the home directory.
// - Validates paths and JSON structure only; never logs or returns file
//   contents; never copies or edits ZCode files; never silently accepts a stub.
import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../host/profile.js";

const PERSISTED_RUNTIME_KEYS = [
  "ZCODE_BRIDGE_NODE",
  "ZCODE_BRIDGE_ZCODE_CJS",
  "ZCODE_BRIDGE_DATA_DIR",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_WINDOWS_APP_INSTALL_DIR",
  "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID",
  "ZCODE_BRIDGE_DEFAULT_MODEL_ID",
  "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL",
  "ZCODE_BRIDGE_MODE",
  "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS",
  "ZCODE_BRIDGE_TIMEOUT_MS",
  "ZCODE_BRIDGE_BROWSER_USE",
  "ZCODE_BRIDGE_BROWSER_EXECUTABLE",
] as const;

/**
 * Loads safe, non-secret runtime settings from the stable per-user config.
 * The config file takes precedence over process variables; environment values
 * remain a fallback for standalone use and migration from older installs.
 */
export function loadPersistedRuntimeEnvironment(source: NodeJS.ProcessEnv, homeDir = homedir(), host: BridgeHostProfile = codexHostProfile(homeDir)): NodeJS.ProcessEnv {
  validateHostProfile(host);
  const settingsPaths = [host.settingsDirectory, ...(host.legacySettingsDirectories ?? [])].map((directory) => path.join(directory, "runtime-config.json"));
  const legacyDataRoot = source["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (legacyDataRoot && path.isAbsolute(legacyDataRoot)) {
    settingsPaths.push(path.join(legacyDataRoot, "runtime-config.json"));
  }

  let parsed: Record<string, unknown> | null = null;
  const seenPaths = new Set<string>();
  for (const settingsPath of settingsPaths) {
    const normalized = path.resolve(settingsPath);
    const identity = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    try {
      if (statSync(normalized).size > 64 * 1024) throw new Error("runtime settings exceed 64 KB");
      const candidate: unknown = JSON.parse(readFileSync(normalized, "utf8"));
      if (isPlainObject(candidate)) {
        parsed = candidate;
        break;
      }
      throw new Error("runtime settings must be an object");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new BridgeError("provider_config_invalid", `invalid Bridge runtime settings: ${normalized}`, { cause: error });
    }
  }
  if (!parsed) return { ...source };

  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of PERSISTED_RUNTIME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const value = parsed[key];
    // Empty/null values are intentional: they clear stale environment values
    // left by older installers and allow ordinary runtime discovery.
    if (typeof value === "string") env[key] = value.trim();
    else if (value === null) env[key] = "";
    else throw new BridgeError("provider_config_invalid", `Bridge runtime setting ${key} must be a string or null`);
  }
  return env;
}

export interface RuntimeResolverOptions {
  /** Environment used for all lookups; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used for personal-config discovery; defaults to os.homedir(). */
  homeDir?: string;
  /** Bridge installation directory used as the default data root; auto-detected otherwise. */
  packageRoot?: string;
  host?: BridgeHostProfile;
}

export class NodeRuntimeResolver implements RuntimeResolver {
  readonly #env: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #packageRoot: string | null;
  readonly #host: BridgeHostProfile;

  constructor(options: RuntimeResolverOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#packageRoot = options.packageRoot ?? null;
    this.#host = validateHostProfile(options.host ?? codexHostProfile(this.#homeDir));
  }

  async resolve(): Promise<ZCodeRuntimeConfig> {
    const env = loadPersistedRuntimeEnvironment(this.#env, this.#homeDir, this.#host);
    const zcodeHome = resolveZcodeHome(env);

    // Node executable: explicit override or `node` on PATH (frozen contract).
    let nodeExecutable = "node";
    const nodeOverride = env["ZCODE_BRIDGE_NODE"]?.trim();
    if (nodeOverride) {
      this.#assertReadableFile(
        nodeOverride,
        "ZCODE_BRIDGE_NODE is set but is not a readable file",
      );
      nodeExecutable = nodeOverride;
    }

    // zcode.cjs entrypoint: explicit override or discovery in the installation.
    let zcodeEntrypoint: string;
    const entryOverride = env["ZCODE_BRIDGE_ZCODE_CJS"]?.trim();
    if (entryOverride) {
      this.#assertReadableFile(
        entryOverride,
        "ZCODE_BRIDGE_ZCODE_CJS is set but is not a readable file",
      );
      zcodeEntrypoint = entryOverride;
    } else {
      const candidates = installCandidates(env, ["resources", "glm", "zcode.cjs"]);
      const discovered = candidates.find(isReadableFile);
      if (!discovered) {
        throw new BridgeError(
          "runtime_not_found",
          `zcode.cjs was not found; searched: ${candidates.join(", ") || "(no installation roots available)"}`,
        );
      }
      zcodeEntrypoint = discovered;
    }

    // Provider pair (see class doc). An inherited pair must be complete.
    const builtinEnv = env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim() || null;
    const personalEnv = env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]?.trim() || null;

    let builtinConfigFile: string;
    let personalConfigFile: string;

    if (builtinEnv && personalEnv) {
      this.#validateBuiltinConfig(builtinEnv);
      this.#validatePersonalConfig(personalEnv);
      builtinConfigFile = builtinEnv;
      personalConfigFile = personalEnv;
    } else {
      if (builtinEnv) {
        this.#validateBuiltinConfig(builtinEnv);
        builtinConfigFile = builtinEnv;
      } else {
        const candidates = installCandidates(env, [
          "resources",
          "config",
          "provider",
          "zcode-builtin.json",
        ]);
        const discovered = candidates.find(isReadableFile);
        if (!discovered) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE is not set and no builtin provider config was found in the ZCode installation; searched: " +
              (candidates.join(", ") || "(no installation roots available)"),
          );
        }
        this.#validateBuiltinConfig(discovered);
        builtinConfigFile = discovered;
      }

      if (personalEnv) {
        this.#validatePersonalConfig(personalEnv);
        personalConfigFile = personalEnv;
      } else {
        const candidates = zcodeHome
          ? [path.join(zcodeHome, "v2", "provider_config.json")]
          : [
              env["ZCODE_DATA_BASE_DIR"]?.trim(),
              ...configuredDataBaseDirs(this.#homeDir),
              this.#homeDir,
            ]
              .filter((base): base is string => Boolean(base))
              .filter((base, index, values) => values.indexOf(base) === index)
              .map((base) => path.join(base, ".zcode", "v2", "provider_config.json"));
        const existing = candidates.filter((candidate) => existsSync(candidate));
        if (existing.length === 0) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is not set and no personal provider config exists at any of: " +
              candidates.join(", "),
          );
        }
        let accepted: string | null = null;
        let lastError: string | null = null;
        for (const candidate of existing) {
          try {
            this.#validatePersonalConfig(candidate);
            accepted = candidate;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!accepted) {
          throw new BridgeError(
            "provider_config_invalid",
            `No usable personal provider config among: ${existing.join(", ")}; last validation failure: ${lastError ?? "unknown"}`,
          );
        }
        personalConfigFile = accepted;
      }
    }

    if (zcodeHome && !samePath(personalConfigFile, path.join(zcodeHome, "v2", "provider_config.json"))) {
      throw new BridgeError(
        "provider_config_invalid",
        `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE must be ZCODE_HOME/v2/provider_config.json (${zcodeHome})`,
      );
    }

    // Bridge data root: explicit override or the Bridge installation directory.
    const dataOverride = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
    let dataRoot: string;
    if (dataOverride) {
      if (!path.isAbsolute(dataOverride)) {
        throw new Error(
          `ZCODE_BRIDGE_DATA_DIR must be an absolute path when set, got: ${dataOverride}`,
        );
      }
      dataRoot = path.normalize(dataOverride);
    } else {
      dataRoot = this.#packageRoot ?? findPackageRoot();
    }

    return {
      nodeExecutable,
      zcodeEntrypoint,
      providerBuiltinConfigFile: builtinConfigFile,
      providerPersonalConfigFile: personalConfigFile,
      dataRoot,
    };
  }

  #assertReadableFile(filePath: string, label: string): void {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("runtime_not_found", `${label}: ${filePath}`);
    }
  }

  /**
   * Structure validation only. The verified differential signal for the
   * CLI-created stub is an empty providerRules map (see docs/ZCODE_RUNTIME.md);
   * rejecting it implements "never silently select a known stub".
   */
  #validatePersonalConfig(filePath: string): void {
    const parsed = this.#readJsonConfig(filePath, "personal provider config");
    const config = parsed["config"];
    if (!isPlainObject(config)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config has no config object: ${filePath}`,
      );
    }
    const providerConfigRules = config["providerConfigRules"];
    const rules = isPlainObject(providerConfigRules)
      ? providerConfigRules["providerRules"]
      : undefined;
    if (!isNonEmptyCollection(rules)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config contains no provider rules (this matches the known CLI-created stub shape): ${filePath}`,
      );
    }
  }

  #validateBuiltinConfig(filePath: string): void {
    const parsed = this.#readJsonConfig(filePath, "builtin provider config");
    if (!isPlainObject(parsed["config"])) {
      throw new BridgeError(
        "provider_config_invalid",
        `Builtin provider config has no config object: ${filePath}`,
      );
    }
  }

  #readJsonConfig(filePath: string, label: string): Record<string, unknown> {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("provider_config_missing", `${label} not found: ${filePath}`);
    }
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not readable: ${filePath} (${errorText(error)})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not valid JSON: ${filePath}`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new BridgeError("provider_config_invalid", `${label} is not a JSON object: ${filePath}`);
    }
    return parsed;
  }
}

function installCandidates(env: NodeJS.ProcessEnv, relative: readonly string[]): string[] {
  const roots = [
    env["ZCODE_WINDOWS_APP_INSTALL_DIR"]?.trim(),
    env["LOCALAPPDATA"]?.trim()
      ? path.join(env["LOCALAPPDATA"]!.trim(), "Programs", "ZCode")
      : null,
    env["ProgramFiles"]?.trim()
      ? path.join(env["ProgramFiles"]!.trim(), "ZCode")
      : null,
  ].filter((root): root is string => Boolean(root));
  return roots.map((root) => path.join(root, ...relative));
}

/** Read ZCode Desktop's configured data directory without exposing settings content. */
function configuredDataBaseDirs(homeDir: string): string[] {
  const candidates = [path.join(homeDir, ".zcode", "v2", "setting.json")];
  for (const settingPath of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingPath, "utf8"));
      if (!isPlainObject(parsed)) continue;
      const dataBaseDir = parsed["dataBaseDir"];
      if (typeof dataBaseDir === "string" && path.isAbsolute(dataBaseDir.trim())) {
        return [path.normalize(dataBaseDir.trim())];
      }
    } catch {
      // Missing or unreadable Desktop settings do not block normal discovery.
    }
  }
  return [];
}

function resolveZcodeHome(env: NodeJS.ProcessEnv): string | null {
  const configured = env["ZCODE_HOME"]?.trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new BridgeError("provider_config_invalid", "ZCODE_HOME must be an absolute path");
  }
  const resolved = path.normalize(configured);
  // app-server's supported data-root contract appends ".zcode" to
  // ZCODE_DATA_BASE_DIR. Requiring the canonical leaf prevents silently
  // reading one tree in the Bridge and another in the child process.
  if (path.basename(resolved).toLowerCase() !== ".zcode") {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_HOME must name a .zcode directory so app-server can use the same data root",
    );
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new BridgeError("provider_config_invalid", `ZCODE_HOME is not a directory: ${resolved}`);
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("provider_config_missing", `ZCODE_HOME directory does not exist: ${resolved}`);
  }
  return resolved;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isReadableFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Walks up from the module location to the directory containing package.json. */
export function findPackageRoot(startDir?: string): string {
  let current = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Cannot locate the Bridge package root (no package.json above ${startDir ?? "module directory"})`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
