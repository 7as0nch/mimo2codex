import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createGenericProvider,
  GenericProviderSpecError,
  type GenericProviderSpec,
} from "./generic.js";
import type { Provider, ProviderModel } from "./types.js";
import { mimo } from "./mimo.js";
import { deepseek } from "./deepseek.js";
import { log } from "../util/log.js";

// File format for ~/.mimo2codex/providers.json:
//   { "providers": [ <GenericProviderSpec>, ... ] }
// Each entry becomes one runtime-registered Provider.
interface ProvidersFile {
  providers?: unknown;
}

export class GenericLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenericLoaderError";
  }
}

// Where the canonical providers.json lives for this process. `source` tells
// callers whether the path came from an explicit env override (cannot be
// freely changed) or the default location (safe to write to). `exists` is
// the disk-state at resolution time.
export interface ProvidersFileLocation {
  path: string;
  source: "explicit" | "default";
  exists: boolean;
}

// Resolve which JSON file path applies. Unlike resolveProvidersFile, this
// returns the path even when the file doesn't exist yet — used by the admin
// UI to know where a first-time save should go.
export function locateProvidersFile(
  env: NodeJS.ProcessEnv,
  dataDir: string
): ProvidersFileLocation | null {
  const explicit = env.MIMO2CODEX_PROVIDERS_FILE;
  if (explicit) {
    return { path: explicit, source: "explicit", exists: existsSync(explicit) };
  }
  if (!dataDir) return null;
  const defaultPath = join(dataDir, "providers.json");
  return { path: defaultPath, source: "default", exists: existsSync(defaultPath) };
}

// Resolve which JSON file (if any) to read. Order:
//   1. $MIMO2CODEX_PROVIDERS_FILE — explicit override
//   2. <dataDir>/providers.json — default location, co-located with sqlite
function resolveProvidersFile(env: NodeJS.ProcessEnv, dataDir: string): string | null {
  const explicit = env.MIMO2CODEX_PROVIDERS_FILE;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new GenericLoaderError(
        `MIMO2CODEX_PROVIDERS_FILE points to "${explicit}" but the file does not exist`
      );
    }
    return explicit;
  }
  if (!dataDir) return null;
  const defaultPath = join(dataDir, "providers.json");
  return existsSync(defaultPath) ? defaultPath : null;
}

function parseModels(raw: unknown, providerId: string): ProviderModel[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new GenericLoaderError(`provider "${providerId}" .models must be an array`);
  }
  return raw.map((m, idx) => {
    if (typeof m !== "object" || m === null) {
      throw new GenericLoaderError(`provider "${providerId}" .models[${idx}] must be an object`);
    }
    const obj = m as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) {
      throw new GenericLoaderError(`provider "${providerId}" .models[${idx}].id must be a string`);
    }
    return {
      id: obj.id,
      aliases: Array.isArray(obj.aliases) ? (obj.aliases as string[]) : undefined,
      displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
      supportsImages: typeof obj.supportsImages === "boolean" ? obj.supportsImages : undefined,
      supportsReasoning:
        typeof obj.supportsReasoning === "boolean" ? obj.supportsReasoning : undefined,
      supportsWebSearch:
        typeof obj.supportsWebSearch === "boolean" ? obj.supportsWebSearch : undefined,
      contextWindow: typeof obj.contextWindow === "number" ? obj.contextWindow : undefined,
      maxOutputTokens: typeof obj.maxOutputTokens === "number" ? obj.maxOutputTokens : undefined,
      deprecatedAfter:
        typeof obj.deprecatedAfter === "string" ? obj.deprecatedAfter : undefined,
    };
  });
}

function parseSpec(raw: unknown, idx: number): GenericProviderSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new GenericLoaderError(`providers[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  if (!id) {
    throw new GenericLoaderError(`providers[${idx}].id is required`);
  }
  const features =
    obj.features && typeof obj.features === "object"
      ? (obj.features as Record<string, unknown>)
      : undefined;

  return {
    id,
    shortcut: typeof obj.shortcut === "string" ? obj.shortcut : undefined,
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
    baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : "",
    envKey: typeof obj.envKey === "string" ? obj.envKey : "",
    defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : "",
    wireApi:
      obj.wireApi === "responses" || obj.wireApi === "chat"
        ? (obj.wireApi as "responses" | "chat")
        : undefined,
    models: parseModels(obj.models, id),
    features: features
      ? {
          webSearch: typeof features.webSearch === "boolean" ? features.webSearch : undefined,
          forceParallelToolCalls:
            typeof features.forceParallelToolCalls === "boolean"
              ? features.forceParallelToolCalls
              : undefined,
          // minimax-compat: 透传 MinimaxCompatFeatures 的 6 个开关
          minimaxCompat:
            typeof features.minimaxCompat === "boolean" ? features.minimaxCompat : undefined,
          dropNullStrict:
            typeof features.dropNullStrict === "boolean" ? features.dropNullStrict : undefined,
          dropNullContent:
            typeof features.dropNullContent === "boolean" ? features.dropNullContent : undefined,
          dropToolChoiceAuto:
            typeof features.dropToolChoiceAuto === "boolean"
              ? features.dropToolChoiceAuto
              : undefined,
          dropStreamOptions:
            typeof features.dropStreamOptions === "boolean"
              ? features.dropStreamOptions
              : undefined,
          dropParallelToolCalls:
            typeof features.dropParallelToolCalls === "boolean"
              ? features.dropParallelToolCalls
              : undefined,
          mergeSystemMessages:
            typeof features.mergeSystemMessages === "boolean"
              ? features.mergeSystemMessages
              : undefined,
          extractThinkTags:
            typeof features.extractThinkTags === "boolean"
              ? features.extractThinkTags
              : undefined,
          dropResponseFormat:
            typeof features.dropResponseFormat === "boolean"
              ? features.dropResponseFormat
              : undefined,
          dropNonFunctionTools:
            typeof features.dropNonFunctionTools === "boolean"
              ? features.dropNonFunctionTools
              : undefined,
          dropReasoningEffort:
            typeof features.dropReasoningEffort === "boolean"
              ? features.dropReasoningEffort
              : undefined,
          // enhanceErrorPreset 是 string 而非 boolean。当前承认 "sensenova" / "minimax" / "kimi"，
          // 未知值丢弃以避免无效配置进入运行时（generic.ts 的 enhanceError 会调
          // applyEnhanceErrorPreset，签名是 ProviderPresetId 联合类型）。
          enhanceErrorPreset:
            features.enhanceErrorPreset === "sensenova" ||
            features.enhanceErrorPreset === "minimax" ||
            features.enhanceErrorPreset === "kimi"
              ? features.enhanceErrorPreset
              : undefined,
        }
      : undefined,
    docsUrl: typeof obj.docsUrl === "string" ? obj.docsUrl : undefined,
    // minimax-compat: 顶层 forceDefaultModel 字段
    forceDefaultModel:
      typeof obj.forceDefaultModel === "boolean" ? obj.forceDefaultModel : undefined,
  };
}

// Read & parse the providers.json at `filePath`. Returns the validated spec
// list (model entries normalized, types coerced). Throws GenericLoaderError
// on file/JSON/schema problems. Used both by loadGenericProviders at boot
// and by the admin UI's GET /admin/api/generic-providers handler.
export function readSpecsFromFile(filePath: string): GenericProviderSpec[] {
  return loadFromFile(filePath);
}

// Atomically write a vetted spec list to `filePath`. Creates the parent
// directory if missing. Throws on validation failure: every spec is run
// through createGenericProvider first (which is what loadGenericProviders
// would do at boot), and ids must be unique. The admin UI never persists
// data that wouldn't load cleanly on restart.
export function writeSpecsToFile(filePath: string, specs: GenericProviderSpec[]): void {
  const seen = new Set<string>();
  // `shortcut` shares the providers.shortcut UNIQUE column with the built-ins,
  // so a generic colliding with mimo/ds (or with another generic) would crash
  // the next DB seed ("UNIQUE constraint failed: providers.shortcut") and take
  // admin down (issue #63). Seed the set with the built-in shortcuts and reject
  // any collision here, at save time, with a friendly message.
  const shortcutSeen = new Set<string>([mimo.shortcut, deepseek.shortcut]);
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") {
      throw new GenericLoaderError("each provider entry must be an object");
    }
    if (seen.has(spec.id)) {
      throw new GenericLoaderError(
        `duplicate generic provider id "${spec.id}" — each id must appear once`
      );
    }
    seen.add(spec.id);
    const shortcut = spec.shortcut ?? spec.id;
    if (shortcutSeen.has(shortcut)) {
      throw new GenericLoaderError(
        `provider shortcut "${shortcut}" (provider "${spec.id}") is already taken — ` +
          `shortcut must be unique across all providers including built-ins (mimo / ds)`
      );
    }
    shortcutSeen.add(shortcut);
    try {
      // Build the Provider to run the same validation the boot path uses.
      // We discard the result — only the side-effect of validation matters.
      createGenericProvider(spec);
    } catch (err) {
      if (err instanceof GenericProviderSpecError) {
        throw new GenericLoaderError(err.message);
      }
      throw err;
    }
  }
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify({ providers: specs }, null, 2) + "\n", "utf-8");
}

function loadFromFile(filePath: string): GenericProviderSpec[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new GenericLoaderError(
      `failed to read providers file ${filePath}: ${(err as Error).message}`
    );
  }
  let parsed: ProvidersFile;
  try {
    parsed = JSON.parse(text) as ProvidersFile;
  } catch (err) {
    throw new GenericLoaderError(
      `providers file ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GenericLoaderError(`providers file ${filePath} must be a JSON object`);
  }
  const raw = parsed.providers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new GenericLoaderError(`providers file ${filePath}: .providers must be an array`);
  }
  return raw.map((item, idx) => parseSpec(item, idx));
}

// Env-only single-instance shortcut. When providers.json is absent but the
// user has set GENERIC_BASE_URL + GENERIC_API_KEY + GENERIC_DEFAULT_MODEL,
// we synthesize one provider with id "generic" — the simplest path for "I
// just want to plug in one OpenAI-compat upstream".
function loadFromEnv(env: NodeJS.ProcessEnv): GenericProviderSpec[] {
  const baseUrl = env.GENERIC_BASE_URL;
  const defaultModel = env.GENERIC_DEFAULT_MODEL;
  if (!baseUrl || !defaultModel) return [];
  // We don't require GENERIC_API_KEY to be set right now (it might be set
  // later when the user passes --api-key). But envKey itself is required for
  // resolveProviderRuntime to know which env var to read, so we hardcode
  // "GENERIC_API_KEY" as the convention.
  return [
    {
      id: "generic",
      shortcut: env.GENERIC_SHORTCUT ?? "generic",
      displayName: env.GENERIC_DISPLAY_NAME ?? "Generic (OpenAI-compatible)",
      baseUrl,
      envKey: "GENERIC_API_KEY",
      defaultModel,
      wireApi:
        env.GENERIC_WIRE_API === "responses" || env.GENERIC_WIRE_API === "chat"
          ? (env.GENERIC_WIRE_API as "responses" | "chat")
          : undefined,
      models: [],
      // minimax-compat: env-var 单实例下接 MiniMax 类严格上游时必开。
      // 默认 false → 不影响 Ollama / OpenRouter 等开放目录直通用法。
      forceDefaultModel:
        env.GENERIC_FORCE_DEFAULT_MODEL === "1" || env.GENERIC_FORCE_DEFAULT_MODEL === "true",
    },
  ];
}

// Load all user-declared generic providers. Returns [] when nothing is
// configured — existing mimo/deepseek behavior stays untouched.
export function loadGenericProviders(
  env: NodeJS.ProcessEnv,
  dataDir: string
): Provider[] {
  const filePath = resolveProvidersFile(env, dataDir);
  let specs: GenericProviderSpec[] = [];

  if (filePath) {
    specs = loadFromFile(filePath);
    log.debug(`loaded ${specs.length} generic provider(s) from ${filePath}`);
  } else {
    specs = loadFromEnv(env);
    if (specs.length > 0) {
      log.debug(`synthesized 1 generic provider from GENERIC_* env vars`);
    }
  }

  const seen = new Set<string>();
  const result: Provider[] = [];
  for (const spec of specs) {
    if (seen.has(spec.id)) {
      throw new GenericLoaderError(
        `duplicate generic provider id "${spec.id}" — each id must appear once`
      );
    }
    seen.add(spec.id);
    try {
      result.push(createGenericProvider(spec));
    } catch (err) {
      if (err instanceof GenericProviderSpecError) {
        throw new GenericLoaderError(err.message);
      }
      throw err;
    }
  }
  return result;
}
