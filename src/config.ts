import { byShortcut, isProviderId, PROVIDER_LIST, PROVIDERS } from "./providers/registry.js";
import type { Provider, ProviderId, ProviderRuntime } from "./providers/types.js";
import { resolveDataDir } from "./db/dataDir.js";
import type { ContextOverflowMode } from "./upstream/openaiCompatClient.js";

// Documentation URLs surfaced in "missing API key" errors. Built-ins are
// hardcoded here so error messages stay user-friendly; generic providers
// supply their own via Provider.docsUrl.
const BUILTIN_DOCS_URL: Record<string, string> = {
  mimo: "https://platform.xiaomimimo.com/#/console/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
};

export interface Config {
  host: string;
  port: number;
  baseUrl: string;            // resolved base url for the default provider
  apiKey: string;             // resolved api key for the default provider
  exposeReasoning: boolean;
  verbose: boolean;
  userAgent: string;
  defaultProviderId: ProviderId;
  providers: Record<ProviderId, ProviderRuntime | null>;
  // Convenience: same as providers[defaultProviderId]!.flags.isTokenPlan
  // when default is mimo. Kept on Config for log-banner ergonomics.
  isTokenPlan: boolean;
  dataDir: string;
  adminEnabled: boolean;
  // How to render upstream 400s identified as "context window exceeded".
  // "friendly" (default): rewrite to a bilingual hint that points users at
  // codex's /compact command. "passthrough": forward the raw upstream error.
  // Controlled via MIMO2CODEX_CONTEXT_OVERFLOW_MODE.
  contextOverflowMode: ContextOverflowMode;
  // --disable-thinking CLI flag (or MIMO2CODEX_DISABLE_THINKING env)。三态：
  //   true  → CLI/env 显式开启了"关思考"
  //   false → CLI/env 显式 --reasoning（等同 --no-disable-thinking）/未来留口
  //   undefined → 未显式设置，让运行时读 settings DB（admin UI 控制）
  // server.ts 的 resolveDisableThinking() 实现 CLI > settings > false 的优先级。
  disableThinkingFromCli?: boolean;
  // Authentication mode. "off" (default for the native CLI binary) keeps the
  // historic local-only behavior: /admin/* and /v1/* are fully open, no users,
  // no sessions, no per-request key checks. "on" (default in the Docker image
  // via ENV MIMO2CODEX_AUTH=on) enforces session cookies on /admin/* and
  // bearer tokens on /v1/*, and exposes the bootstrap/login/users/BYOK
  // surfaces. The new tables exist in both modes; "off" simply doesn't
  // populate or consult them.
  authMode: "off" | "on";
  // When true the session cookie is marked Secure (HTTPS-only). Defaults
  // to false; deployers behind nginx/caddy set MIMO2CODEX_COOKIE_SECURE=1.
  cookieSecure: boolean;
  // Suppress the "model fallback applied" info log when Codex sends a model id
  // that differs from the provider's catalog (e.g. "gpt-5.4" → "mimo-v2.5-pro").
  //   true/false → env MIMO2CODEX_SILENT_REWRITE explicitly set, forces it
  //   undefined  → runtime reads settings DB (admin UI toggle), default silent
  // server.ts resolveSilentRewrite() implements env > settings > true.
  silentRewriteFromCli?: boolean;
  // Built-in plugin override. true/false means env explicitly controls the
  // plugin and admin UI cannot change it; undefined means settings DB controls
  // it and can be hot-applied from the Plugins page.
  computerUsePluginFromEnv?: boolean;
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8788,
};

export interface ParsedArgs {
  host?: string;
  port?: number;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  exposeReasoning?: boolean;
  verbose?: boolean;
  envKey?: boolean;
  dataDir?: string;
  noAdmin?: boolean;
  noLoadEnv?: boolean;
  noUpdateCheck?: boolean;
  disableThinking?: boolean;
  authMode?: "off" | "on";
  positional: string[];
  showHelp: boolean;
  showVersion: boolean;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], showHelp: false, showVersion: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case "--port":
      case "-p":
        out.port = Number(next());
        if (Number.isNaN(out.port)) throw new Error("--port must be a number");
        break;
      case "--host":
        out.host = next();
        break;
      case "--base-url":
      case "--baseurl":
        out.baseUrl = next();
        break;
      case "--api-key":
        out.apiKey = next();
        break;
      case "--model":
        out.model = next();
        break;
      case "--no-reasoning":
        out.exposeReasoning = false;
        break;
      case "--reasoning":
        out.exposeReasoning = true;
        break;
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
      case "--env-key":
        out.envKey = true;
        break;
      case "--data-dir":
        out.dataDir = next();
        break;
      case "--no-admin":
        out.noAdmin = true;
        break;
      case "--no-load-env":
        out.noLoadEnv = true;
        break;
      case "--no-update-check":
        out.noUpdateCheck = true;
        break;
      case "--disable-thinking":
        out.disableThinking = true;
        break;
      case "--auth": {
        const v = next().toLowerCase();
        if (v !== "on" && v !== "off") {
          throw new Error("--auth must be 'on' or 'off'");
        }
        out.authMode = v;
        break;
      }
      case "--help":
      case "-h":
        out.showHelp = true;
        break;
      case "--version":
      case "-V":
        out.showVersion = true;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`unknown flag: ${a}`);
        }
        out.positional.push(a);
    }
  }
  return out;
}

function resolveProviderRuntime(
  provider: Provider,
  isDefault: boolean,
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv
): ProviderRuntime | null {
  // CLI --api-key / --base-url apply only to the default provider.
  const apiKeyFromCli = isDefault ? parsed.apiKey : undefined;
  const baseUrlFromCli = isDefault ? parsed.baseUrl : undefined;

  let apiKey = apiKeyFromCli;
  if (!apiKey) {
    for (const k of provider.envKeys) {
      const v = env[k];
      if (v) {
        apiKey = v;
        break;
      }
    }
  }
  if (!apiKey) return null;

  // Priority: CLI --base-url > env > key-based inference > defaultBaseUrl.
  // Key-based inference handles MiMo's tp-* / sk-* tiers — using the wrong
  // host with a tp-* key 401s, so this auto-switches to the right one when
  // the user hasn't overridden it explicitly.
  const baseUrl =
    baseUrlFromCli ??
    env[provider.baseUrlEnv] ??
    provider.inferBaseUrlFromKey?.(apiKey) ??
    provider.defaultBaseUrl;
  return {
    apiKey,
    baseUrl,
    flags: provider.detectFlags(apiKey, baseUrl),
  };
}

export function buildConfig(parsed: ParsedArgs, env: NodeJS.ProcessEnv, version: string): Config {
  const exposeReasoningEnv = env.MIMO2CODEX_NO_REASONING ? false : true;
  const verboseEnv = !!env.MIMO2CODEX_VERBOSE;

  // Resolve default provider. --model accepts either a known shortcut ("ds")
  // or a full provider id ("deepseek"). Default = mimo.
  let defaultProviderId: ProviderId = "mimo";
  if (parsed.model) {
    const p = byShortcut(parsed.model);
    if (!p) {
      const known = PROVIDER_LIST.map((x) => `${x.shortcut} (${x.id})`).join(", ");
      throw new Error(`unknown --model "${parsed.model}". Known providers: ${known}`);
    }
    defaultProviderId = p.id;
  } else if (env.MIMO2CODEX_DEFAULT_PROVIDER) {
    if (!isProviderId(env.MIMO2CODEX_DEFAULT_PROVIDER)) {
      throw new Error(
        `MIMO2CODEX_DEFAULT_PROVIDER must be one of: ${PROVIDER_LIST.map((p) => p.id).join(", ")}`
      );
    }
    defaultProviderId = env.MIMO2CODEX_DEFAULT_PROVIDER;
  }

  // Resolve runtime for every registered provider (built-ins + any generic
  // providers loaded via initRegistry). Runtime is null when no key is
  // available; the registry stays populated so per-request model-based
  // routing can still recognize the provider's catalog.
  const providers: Record<ProviderId, ProviderRuntime | null> = Object.fromEntries(
    PROVIDER_LIST.map((p) => [p.id, null])
  );
  for (const p of PROVIDER_LIST) {
    providers[p.id] = resolveProviderRuntime(p, p.id === defaultProviderId, parsed, env);
  }

  const defaultRuntime = providers[defaultProviderId];
  if (!defaultRuntime) {
    const def = PROVIDERS[defaultProviderId];
    const envHint = def.envKeys.join(" or ");
    const docsUrl = def.docsUrl ?? BUILTIN_DOCS_URL[def.id];
    const docs = docsUrl
      ? `Get one at ${docsUrl}`
      : `Configure baseUrl + envKey in your providers.json entry for "${def.id}".`;
    throw new Error(
      `missing API key for ${def.displayName} — set ${envHint} env var or pass --api-key. ${docs}`
    );
  }

  const portFromEnv = env.MIMO2CODEX_PORT ? Number(env.MIMO2CODEX_PORT) : undefined;
  if (portFromEnv !== undefined && Number.isNaN(portFromEnv)) {
    throw new Error("MIMO2CODEX_PORT must be a number");
  }

  const adminEnabled = parsed.noAdmin
    ? false
    : env.MIMO2CODEX_NO_ADMIN
      ? false
      : true;
  const dataDir = adminEnabled ? resolveDataDir(parsed.dataDir, env) : "";

  const overflowEnv = env.MIMO2CODEX_CONTEXT_OVERFLOW_MODE?.toLowerCase();
  const contextOverflowMode: ContextOverflowMode =
    overflowEnv === "passthrough" ? "passthrough" : "friendly";

  // CLI flag 优先，否则看 env (MIMO2CODEX_DISABLE_THINKING=1)，否则留 undefined
  // 让 server 运行时读 settings DB（让 admin UI 改完立刻生效，无需重启）。
  const disableThinkingFromCli: boolean | undefined =
    parsed.disableThinking ??
    (env.MIMO2CODEX_DISABLE_THINKING === "1" || env.MIMO2CODEX_DISABLE_THINKING === "true"
      ? true
      : undefined);

  // --auth on|off > MIMO2CODEX_AUTH=on|1|true|off|0|false > "off" default.
  // Docker images flip this to "on" via ENV in the Dockerfile, so containers
  // are secure by default while npm/local CLI users keep the zero-auth UX.
  const authMode: "off" | "on" = resolveAuthMode(parsed.authMode, env);

  return {
    host: parsed.host ?? env.MIMO2CODEX_HOST ?? DEFAULTS.host,
    port: parsed.port ?? portFromEnv ?? DEFAULTS.port,
    baseUrl: defaultRuntime.baseUrl,
    apiKey: defaultRuntime.apiKey,
    exposeReasoning: parsed.exposeReasoning ?? exposeReasoningEnv,
    verbose: parsed.verbose ?? verboseEnv,
    userAgent: `mimo2codex/${version}`,
    defaultProviderId,
    providers,
    isTokenPlan: !!defaultRuntime.flags.isTokenPlan,
    dataDir,
    adminEnabled,
    contextOverflowMode,
    disableThinkingFromCli,
    authMode,
    cookieSecure: env.MIMO2CODEX_COOKIE_SECURE === "1" || env.MIMO2CODEX_COOKIE_SECURE === "true",
    silentRewriteFromCli:
      env.MIMO2CODEX_SILENT_REWRITE === "1" || env.MIMO2CODEX_SILENT_REWRITE === "true"
        ? true
        : env.MIMO2CODEX_SILENT_REWRITE === "0" || env.MIMO2CODEX_SILENT_REWRITE === "false"
          ? false
          : undefined,
    computerUsePluginFromEnv: parsePluginEnvForComputerUse(env.MIMO2CODEX_PLUGIN),
  };
}

function parsePluginEnvForComputerUse(raw: string | undefined): boolean | undefined {
  const v = raw?.toLowerCase().trim();
  if (!v) return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "none") return false;
  const enabled = new Set(
    v
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (enabled.has("mimo-computer-use") || enabled.has("computer-use")) return true;
  return undefined;
}

function resolveAuthMode(
  fromCli: "off" | "on" | undefined,
  env: NodeJS.ProcessEnv
): "off" | "on" {
  if (fromCli) return fromCli;
  const raw = env.MIMO2CODEX_AUTH?.toLowerCase().trim();
  if (raw === "on" || raw === "1" || raw === "true" || raw === "yes") return "on";
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  return "off";
}
