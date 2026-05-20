#!/usr/bin/env node
import { createRequire } from "node:module";
import { buildConfig, parseArgv, type Config } from "./config.js";
import { startServer } from "./server.js";
import { setVerbose, log, redactKey } from "./util/log.js";
import { closeDb, openDb } from "./db/index.js";
import { initRegistry } from "./providers/registry.js";
import { loadGenericProviders, GenericLoaderError } from "./providers/genericLoader.js";
import { resolveDataDir } from "./db/dataDir.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadDotenvFile } from "./util/dotenv.js";
import {
  bundledExamplePath,
  dataDirEnvPath,
  dataDirExamplePath,
  ensureDataDirEnv,
  refreshDataDirExample,
} from "./setup/initEnv.js";
import { PROVIDER_LIST } from "./providers/registry.js";
import {
  getCachedStatus,
  refreshCacheInBackground,
  type UpdateStatus,
} from "./util/checkUpdate.js";
import { runUpdate } from "./setup/runUpdate.js";
import { printLogo } from "./util/logo.js";
import { printBoxedBanner } from "./util/cliBanner.js";
import { logFirstRunBannerIfNeeded } from "./auth/bootstrap.js";

// Discover the data-dir path WITHOUT creating it. Used for print-config /
// print-cc-switch subcommands so a one-shot snippet print doesn't have
// filesystem side effects.
function nonCreatingDataDirCandidate(
  cliOverride: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  const dir = cliOverride ?? env.MIMO2CODEX_DATA_DIR ?? join(homedir(), ".mimo2codex");
  return existsSync(dir) ? dir : "";
}
import {
  ccSwitchSnippet,
  configSnippet,
  configSnippetEnvKey,
  resolveSnippetTarget,
  type SnippetTarget,
} from "./setup/snippets.js";

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const HELP = `mimo2codex v${VERSION} — local proxy: Codex Responses API → Chat Completions (MiMo / DeepSeek)

USAGE
  mimo2codex [options]
  mimo2codex init
  mimo2codex update
  mimo2codex print-config
  mimo2codex print-cc-switch

OPTIONS
  -p, --port <n>          listen port (default: 8788, env: MIMO2CODEX_PORT)
      --host <h>          bind host (default: 127.0.0.1, env: MIMO2CODEX_HOST)
      --model <shortcut>  default upstream provider: "mimo" (default) or "ds" (DeepSeek)
      --base-url <url>    base url for the default provider (env: MIMO_BASE_URL / DEEPSEEK_BASE_URL)
      --api-key <key>     api key for the default provider (env varies — see below) — required
      --no-reasoning      hide reasoning_content from Codex (still re-injected for multi-turn quality)
      --reasoning         force reasoning passthrough (default)
      --disable-thinking  globally skip upstream "thinking" mode (mimo/deepseek: thinking:disabled;
                          sensenova/generic: reasoning_effort:"none"). Admin UI 也可配置；
                          CLI flag 优先于 admin UI 设置. env: MIMO2CODEX_DISABLE_THINKING=1
      --data-dir <path>   admin sqlite + UI data directory (default: ~/.mimo2codex,
                          env: MIMO2CODEX_DATA_DIR)
      --no-admin          disable the local admin UI + sqlite logging
                          (env: MIMO2CODEX_NO_ADMIN=1)
      --no-load-env       skip auto-loading <data-dir>/.env on startup
                          (default: auto-loaded if the file exists)
      --no-update-check   skip the startup npm registry version check
                          (env: MIMO2CODEX_NO_UPDATE_CHECK=1)
      --auth <on|off>     enforce login + per-user API keys (default: off for the
                          native CLI; on by default inside the Docker image).
                          env: MIMO2CODEX_AUTH=on. When on, the first start
                          prints a one-time bootstrap URL.
  -v, --verbose           log every request (env: MIMO2CODEX_VERBOSE=1)
  -V, --version           print version
  -h, --help              show this help

PROVIDER KEYS
      MiMo:     MIMO_API_KEY                          (default base: https://api.xiaomimimo.com/v1)
      DeepSeek: DS_API_KEY  or  DEEPSEEK_API_KEY      (default base: https://api.deepseek.com/v1)
      Set the key for whichever provider --model selects. Other providers are
      registered automatically when their key is present (per-request routing
      lands in a follow-up release).

GENERIC OPENAI-COMPAT PROVIDERS
      Declare any OpenAI Chat-Completions-compatible upstream (Qwen, GLM, Kimi,
      vLLM, Ollama, etc.) in providers.json — by default at:
        ~/.mimo2codex/providers.json
      Or set MIMO2CODEX_PROVIDERS_FILE to point elsewhere.

      For a one-shot single instance, set GENERIC_BASE_URL + GENERIC_API_KEY +
      GENERIC_DEFAULT_MODEL; mimo2codex synthesizes a provider with id "generic".

      Each provider entry supports wireApi: "chat" (default — translate to
      Chat Completions) or "responses" (pipe Codex's Responses payload through
      to the upstream's /v1/responses unchanged — use when the upstream natively
      speaks the Responses API).

      To make a generic provider the default, pass --model <id-or-shortcut>
      (e.g. \`--model qwen\`). With no flag, mimo2codex defaults to mimo.

DEFAULTS BAKED IN (no flag needed)
      ✓ MiMo thinking mode ON — model generates reasoning_content; use
        --no-reasoning to hide it from the Codex terminal (still preserved
        between turns for multi-turn tool quality)
      ✓ parallel_tool_calls forced on — model can batch tool calls per turn,
        helps avoid "model says 'I'll do X' then ends" pattern
      ✓ Codex web_search forwarded to MiMo's web_search builtin. If your account
        doesn't have the Web Search Plugin activated, MiMo returns 400
        "webSearchEnabled is false" — mimo2codex surfaces that error so you can
        activate the plugin (https://platform.xiaomimimo.com/#/console/plugin,
        separately billed) and restart, or accept that web search isn't available.
        Token-plan users who activated the plugin can set MIMO2CODEX_WEB_SEARCH=1.
SUBCOMMANDS
  init                    bootstrap <data-dir>/.env + .env.example from the bundled
                          template. Idempotent: refreshes .env.example, only creates
                          .env if absent. Run this once after install, edit .env, then
                          launch mimo2codex normally — keys auto-load on every start.
  update                  detect the install method (npm-global vs git checkout) and
                          run the matching update command, streaming output to your
                          terminal. Exit code mirrors the underlying spawn.
  print-config            print ~/.codex/auth.json + config.toml snippets (default;
                          works for Codex CLI and desktop app)
  print-config --env-key  print env-var-based variant (Codex CLI only — desktop app
                          will NOT see shell env vars set via export/setx)
  print-cc-switch         print auth.json + config.toml snippets for the cc-switch
                          desktop app (https://github.com/farion1231/cc-switch)

EXAMPLES
  MIMO_API_KEY=sk-... mimo2codex
  mimo2codex --port 9000 --base-url https://token-plan-cn.xiaomimimo.com/v1
  mimo2codex print-config > codex-mimo.toml
  mimo2codex print-config --env-key       # legacy env-var variant
  mimo2codex print-cc-switch

  # Generic OpenAI-compat upstream — single instance via env vars
  GENERIC_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \\
    GENERIC_API_KEY=sk-... GENERIC_DEFAULT_MODEL=qwen3-max \\
    mimo2codex --model generic

  # Multi-instance — declare in ~/.mimo2codex/providers.json, then:
  QWEN_API_KEY=sk-... mimo2codex --model qwen
`;

// Collect the env-var names every registered provider could pull a key from,
// so we can detect "user already has a key in shell env, don't surprise them
// with bootstrap" reliably across built-ins + generic providers.
function knownProviderKeyEnvNames(): string[] {
  const names = new Set<string>();
  for (const p of PROVIDER_LIST) {
    for (const k of p.envKeys) names.add(k);
  }
  // Generic single-instance env var (synthesized when GENERIC_BASE_URL is set).
  names.add("GENERIC_API_KEY");
  return [...names];
}

function hasAnyProviderKey(env: NodeJS.ProcessEnv): boolean {
  return knownProviderKeyEnvNames().some((n) => !!env[n]);
}

// Auto-load <dataDir>/.env into process.env on startup. Returns the load
// result so the banner can mention which keys came from the file. Silent
// no-op when the file doesn't exist — bootstrap is handled separately.
function tryAutoLoadEnv(dataDir: string): { path: string; loaded: string[] } | null {
  const envPath = dataDirEnvPath(dataDir);
  if (!existsSync(envPath)) return null;
  try {
    const result = loadDotenvFile(envPath, process.env);
    return { path: envPath, loaded: result.loaded };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`load-env: failed to read ${envPath}: ${(err as Error).message}`);
    return null;
  }
}

function runInitSubcommand(parsed: ReturnType<typeof parseArgv>): void {
  const dataDir = resolveDataDir(parsed.dataDir, process.env);
  const bundled = bundledExamplePath();
  if (!existsSync(bundled)) {
    // eslint-disable-next-line no-console
    console.error(
      `error: bundled .env.example not found at ${bundled}. This usually means a broken install — try \`npm i -g mimo2codex\` again.`
    );
    process.exit(2);
  }
  const refreshed = refreshDataDirExample(dataDir);
  const ensured = ensureDataDirEnv(dataDir);
  // eslint-disable-next-line no-console
  console.log(`mimo2codex init`);
  // eslint-disable-next-line no-console
  console.log(`  data dir:    ${dataDir}`);
  // eslint-disable-next-line no-console
  console.log(`  template:    ${refreshed.dest} (refreshed)`);
  if (ensured.created) {
    // eslint-disable-next-line no-console
    console.log(`  env file:    ${ensured.envPath} (created from template)`);
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Next:");
    // eslint-disable-next-line no-console
    console.log(`  1. Open ${ensured.envPath} and fill in your API key(s).`);
    // eslint-disable-next-line no-console
    console.log(`  2. Run \`mimo2codex\` — the file is auto-loaded on every start.`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`  env file:    ${ensured.envPath} (already exists — left untouched)`);
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log(`The template at ${refreshed.dest} was refreshed; copy any new keys`);
    // eslint-disable-next-line no-console
    console.log(`into your .env manually if you want them.`);
  }
}

// ─── update-check helpers ──────────────────────────────────────────────────
// Async prompt that resolves on either a key press or a timeout. Used to ask
// the user y/n at startup when a newer version is in cache. Restores raw-mode
// state on every exit path so the rest of the process keeps a sane stdin.
function timedYesNoPrompt(question: string, timeoutMs: number): Promise<"y" | "n" | "timeout"> {
  return new Promise((resolveOnce) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolveOnce("timeout");
      return;
    }
    // eslint-disable-next-line no-console
    process.stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let settled = false;
    const finish = (result: "y" | "n" | "timeout"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      // print a newline so the next banner line starts on a fresh row
      process.stdout.write("\n");
      resolveOnce(result);
    };
    const onData = (chunk: string): void => {
      const c = chunk.toLowerCase();
      if (c === "") {
        // Ctrl-C while we hold the prompt — let the user kill the process
        finish("timeout");
        process.exit(130);
      }
      if (c === "y") return finish("y");
      if (c === "n" || c === "\r" || c === "\n") return finish("n");
      // any other key: keep waiting
    };
    stdin.on("data", onData);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

function shouldSkipUpdateCheck(
  parsed: ReturnType<typeof parseArgv>,
  env: NodeJS.ProcessEnv
): boolean {
  if (parsed.noUpdateCheck) return true;
  if (env.MIMO2CODEX_NO_UPDATE_CHECK) return true;
  return false;
}

async function maybePromptForUpdate(status: UpdateStatus): Promise<void> {
  if (!status.hasUpdate || !status.latest) return;
  const banner = `New version v${status.latest} available (current ${status.current}).`;
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;
  if (!stdinTTY || !stdoutTTY) {
    // eslint-disable-next-line no-console
    console.log(
      `[update] ${banner} Run \`mimo2codex update\` to install, or \`mimo2codex --no-update-check\` to silence.`
    );
    return;
  }
  const answer = await timedYesNoPrompt(
    `${banner} Update now? [y/N] (auto-skip in 5s) `,
    5000
  );
  if (answer === "y") {
    const result = await runUpdate({
      onLine: (line, stream) => {
        // eslint-disable-next-line no-console
        (stream === "stderr" ? console.error : console.log)(line);
      },
    });
    process.exit(result.exitCode);
  }
  // n / timeout: continue startup, leaving banner visible
}

async function runUpdateSubcommand(): Promise<never> {
  const result = await runUpdate({
    onLine: (line, stream) => {
      // eslint-disable-next-line no-console
      (stream === "stderr" ? console.error : console.log)(line);
    },
  });
  if (result.skipped) {
    // eslint-disable-next-line no-console
    console.log(
      `\nNo automated update path detected for this install. Run the suggested command manually:`
    );
    // eslint-disable-next-line no-console
    console.log(`  ${result.command}`);
  }
  process.exit(result.exitCode);
}

function checkMimoHostMismatch(cfg: Config): string | null {
  // Catch the most common foot-gun: tp-* key sent at the pay-as-you-go host
  // (or sk-* key sent at the token-plan host) — usually because MIMO_BASE_URL
  // is left over in the shell from a previous session. Yields 401 or
  // confusing 400s upstream; cheaper to warn at startup.
  if (cfg.defaultProviderId !== "mimo") return null;
  const isTpKey = cfg.apiKey.startsWith("tp-");
  const isSkKey = cfg.apiKey.startsWith("sk-");
  const hostIsTokenPlan = /token-plan/i.test(cfg.baseUrl);
  if (isTpKey && !hostIsTokenPlan) {
    return `tp-* key 通常需要 token-plan 主机，但当前 baseUrl 是 ${cfg.baseUrl}。检查 MIMO_BASE_URL / --base-url 是否覆盖了自动推断。`;
  }
  if (isSkKey && hostIsTokenPlan) {
    return `sk-* key 通常需要 pay-as-you-go 主机，但当前 baseUrl 是 ${cfg.baseUrl}。检查 MIMO_BASE_URL / --base-url 是否泄漏（PowerShell: Remove-Item Env:MIMO_BASE_URL）。`;
  }
  return null;
}

function printStartupBanner(
  cfg: Config,
  target: SnippetTarget,
  autoLoadedEnv: { path: string; loaded: string[] } | null
): void {
  // Collect every runtime status line first, then frame the whole block in
  // a rounded box. Width is content-driven so the right border always aligns.
  const lines: string[] = [];
  lines.push(`mimo2codex v${VERSION} listening on http://${cfg.host}:${cfg.port}`);
  if (autoLoadedEnv) {
    lines.push(
      `env file:    ${autoLoadedEnv.path} (${autoLoadedEnv.loaded.length} key${autoLoadedEnv.loaded.length === 1 ? "" : "s"}: ${autoLoadedEnv.loaded.join(", ") || "—"})`
    );
  }
  lines.push(`provider:    ${cfg.defaultProviderId}`);
  lines.push(`upstream:    ${cfg.baseUrl}`);
  lines.push(`api key:     ${redactKey(cfg.apiKey)}`);
  const mismatch = checkMimoHostMismatch(cfg);
  if (mismatch) {
    lines.push(`⚠ 警告:      ${mismatch}`);
  }
  if (cfg.defaultProviderId === "mimo") {
    lines.push(
      `plan:        ${cfg.isTokenPlan ? "token-plan (web_search auto-disabled; set MIMO2CODEX_WEB_SEARCH=1 if plugin activated)" : "pay-as-you-go"}`
    );
  }
  lines.push(`reasoning:   ${cfg.exposeReasoning ? "passthrough" : "hidden"}`);
  if (cfg.disableThinkingFromCli === true) {
    lines.push(`thinking:    disabled (--disable-thinking)`);
  } else if (cfg.disableThinkingFromCli === false) {
    lines.push(`thinking:    forced on (CLI overrode admin setting)`);
  }
  // 未显式设 CLI flag 时不打印此行 —— 实际值由 admin UI 控制，每请求动态读 settings。
  const others = (Object.keys(cfg.providers) as Array<keyof typeof cfg.providers>)
    .filter((id) => id !== cfg.defaultProviderId && cfg.providers[id])
    .join(", ");
  if (others) {
    lines.push(`registered:  ${others} (model-routed when client picks one of those ids)`);
  }
  if (cfg.adminEnabled) {
    lines.push(`admin UI:    http://${cfg.host}:${cfg.port}/admin/`);
    lines.push(`data dir:    ${cfg.dataDir}`);
  } else {
    lines.push(`admin UI:    disabled (--no-admin)`);
  }

  printBoxedBanner(lines);
  // 不再在启动时把 ~/.codex/auth.json + config.toml 完整 snippet 打印到终端 ——
  // 用户反馈太啰嗦。需要查具体配置请到 admin 控制台（Setup / 对接指引 页），
  // 或运行 `mimo2codex print-config` / `print-cc-switch` 显式生成。
  // eslint-disable-next-line no-console
  console.log("");
  if (cfg.adminEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      `具体配置请到 admin 控制台查看： http://${cfg.host}:${cfg.port}/admin/`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `具体配置请运行 \`mimo2codex print-config\`（或 \`print-cc-switch\`）查看。`
    );
  }
  // target 仅在 print-config / print-cc-switch subcommand 路径下用到，本函数已不再消费。
  void target;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`error: ${(err as Error).message}`);
    process.exit(2);
  }

  if (parsed.showHelp) {
    printLogo(VERSION);
    // eslint-disable-next-line no-console
    console.log(HELP);
    return;
  }
  if (parsed.showVersion) {
    // eslint-disable-next-line no-console
    console.log(VERSION);
    return;
  }

  // Logo prints for normal startup + init + update. Subcommands whose output
  // is intended to be piped to a file (print-config / print-cc-switch) skip
  // it so the resulting snippets stay clean.
  const subcmd = parsed.positional[0];
  if (subcmd !== "print-config" && subcmd !== "print-cc-switch") {
    printLogo(VERSION);
  }

  // `init` subcommand: bootstrap <data-dir>/.env + .env.example and exit.
  // Always idempotent; safe to re-run.
  if (parsed.positional[0] === "init") {
    runInitSubcommand(parsed);
    return;
  }

  // `update` subcommand: detect install method, spawn the matching update
  // command, stream output to terminal, exit with the spawn's exit code.
  if (parsed.positional[0] === "update") {
    await runUpdateSubcommand();
    return;
  }

  // Register generic providers from providers.json (or GENERIC_* env vars)
  // BEFORE we look at print-config / print-cc-switch subcommands, so those
  // can resolve `--model qwen` against a user-declared generic. We do NOT
  // call resolveDataDir() here (which would auto-create ~/.mimo2codex/) — we
  // only inspect the default path if it already exists, so a one-shot
  // `mimo2codex print-config` doesn't have filesystem side effects.
  const isSubcommand =
    parsed.positional[0] === "print-config" || parsed.positional[0] === "print-cc-switch";
  const adminEnabledForLoader = parsed.noAdmin
    ? false
    : process.env.MIMO2CODEX_NO_ADMIN
      ? false
      : true;
  const dataDirForLoader =
    !isSubcommand && adminEnabledForLoader
      ? resolveDataDir(parsed.dataDir, process.env)
      : nonCreatingDataDirCandidate(parsed.dataDir, process.env);

  // Auto-load <dataDir>/.env into process.env before generic-provider
  // resolution (envKey lookups) and buildConfig (key + base-url reads).
  // Skipped for print-* subcommands (don't side-effect previews) and when
  // --no-load-env is set. First-run bootstrap: when no .env exists AND no
  // provider key is anywhere in env, copy the bundled template into place
  // and exit with friendly instructions — that's the npm-install user's
  // first interaction with mimo2codex.
  let autoLoadedEnv: { path: string; loaded: string[] } | null = null;
  if (!isSubcommand && !parsed.noLoadEnv && dataDirForLoader) {
    autoLoadedEnv = tryAutoLoadEnv(dataDirForLoader);
    if (!autoLoadedEnv && !hasAnyProviderKey(process.env)) {
      // First-run UX: no .env file, no keys in shell env, user clearly hasn't
      // set things up yet. Bootstrap and exit cleanly so they can edit.
      const dataDir = resolveDataDir(parsed.dataDir, process.env);
      const bundled = bundledExamplePath();
      if (existsSync(bundled)) {
        const ensured = ensureDataDirEnv(dataDir);
        if (ensured.created) {
          // eslint-disable-next-line no-console
          console.log(`mimo2codex: first-run setup`);
          // eslint-disable-next-line no-console
          console.log(
            `  Created ${ensured.envPath} from the bundled template (${dataDirExamplePath(dataDir)}).`
          );
          // eslint-disable-next-line no-console
          console.log("");
          // eslint-disable-next-line no-console
          console.log("Next:");
          // eslint-disable-next-line no-console
          console.log(`  1. Open ${ensured.envPath} and fill in your API key(s).`);
          // eslint-disable-next-line no-console
          console.log(
            `  2. Re-run \`mimo2codex\` — the file is auto-loaded on every start.`
          );
          // eslint-disable-next-line no-console
          console.log("");
          // eslint-disable-next-line no-console
          console.log(
            `Tip: \`mimo2codex --no-load-env\` skips the auto-load if you prefer shell-exported keys.`
          );
          return;
        }
      }
      // Bundled template missing or bootstrap failed — fall through to the
      // existing "missing API key" error from buildConfig, which already
      // points users at the right docs.
    }
  }

  try {
    const generics = loadGenericProviders(process.env, dataDirForLoader);
    initRegistry(generics);
  } catch (err) {
    if (err instanceof GenericLoaderError) {
      // eslint-disable-next-line no-console
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (parsed.positional[0] === "print-config") {
    const host = parsed.host ?? "127.0.0.1";
    const port = parsed.port ?? 8788;
    const useEnvKey = parsed.envKey === true;
    const target = resolveSnippetTarget(parsed.model);
    // eslint-disable-next-line no-console
    console.log(
      useEnvKey
        ? configSnippetEnvKey({ host, port }, target)
        : configSnippet({ host, port }, target)
    );
    return;
  }

  if (parsed.positional[0] === "print-cc-switch") {
    const host = parsed.host ?? "127.0.0.1";
    const port = parsed.port ?? 8788;
    const target = resolveSnippetTarget(parsed.model);
    // eslint-disable-next-line no-console
    console.log(ccSwitchSnippet({ host, port }, target));
    return;
  }

  let cfg: Config;
  try {
    cfg = buildConfig(parsed, process.env, VERSION);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`error: ${(err as Error).message}`);
    process.exit(2);
  }

  setVerbose(cfg.verbose);

  if (cfg.adminEnabled) {
    try {
      openDb(cfg.dataDir);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `error: failed to open admin database at ${cfg.dataDir}: ${(err as Error).message}\n` +
          `Pass --no-admin to disable persistence, or --data-dir <path> to choose a writable location.`
      );
      process.exit(2);
    }
  }

  printStartupBanner(cfg, resolveSnippetTarget(parsed.model), autoLoadedEnv);

  // Update-check: gated by --no-update-check / env / settings. Strategy:
  //   1. CLI restart is rare and explicit — the user is sitting at the
  //      terminal asking "anything new?". So we ALWAYS hit npm at startup,
  //      ignoring the 6h cache TTL. Without this, a cache written when
  //      v0.2.10 was the latest known stays "fresh" for 6h after v0.2.11
  //      ships, suppressing prompts across every restart in that window.
  //   2. Race the refresh against a 2s timeout so a slow / blackholed npm
  //      mirror never delays startup beyond 2s. Network failures bubble up
  //      as a null resolution (refreshCacheInBackground swallows fetch
  //      errors internally) and we fall through to cached state.
  //   3. The refresh promise keeps running past the race timeout; even if
  //      we couldn't use its result for this run's prompt, it still writes
  //      the cache for the next launch and the webui's status endpoint.
  //
  // Use dataDirForLoader (not cfg.dataDir): this honors --data-dir even
  // when --no-admin is passed, so opt-in-only users still get update prompts
  // from their cache file. Falls back to empty when nothing's resolvable.
  const updateCheckDataDir = dataDirForLoader || null;
  if (!shouldSkipUpdateCheck(parsed, process.env) && updateCheckDataDir) {
    const refreshPromise = refreshCacheInBackground({
      currentVersion: VERSION,
      dataDir: updateCheckDataDir,
    }).catch(() => null);
    const TIMEOUT = Symbol("timeout");
    type RaceResult = UpdateStatus | null | typeof TIMEOUT;
    const raced: RaceResult = await Promise.race([
      refreshPromise,
      new Promise<typeof TIMEOUT>((resolve) =>
        setTimeout(() => resolve(TIMEOUT), 2000).unref()
      ),
    ]);
    const status: UpdateStatus =
      raced && raced !== TIMEOUT
        ? (raced as UpdateStatus)
        : getCachedStatus({ currentVersion: VERSION, dataDir: updateCheckDataDir });
    if (status.hasUpdate) {
      try {
        await maybePromptForUpdate(status);
      } catch (err) {
        // Prompt failures (e.g. raw-mode unsupported) should never block start
        log.warn("update prompt failed", { error: (err as Error).message });
      }
    }
  }

  const server = startServer(cfg);
  server.on("listening", () => {
    log.debug("server listening");
    // Surface the authentication posture in the boot banner — running into
    // "I set MIMO2CODEX_AUTH but it had no effect" is otherwise hard to
    // debug from outside the process.
    log.info(`auth: ${cfg.authMode}${cfg.authMode === "on" ? " — admin login required" : " (local zero-auth mode)"}`);
    // Log a "go to /admin/ to claim the admin account" banner when authMode=on
    // and the users table is still empty. No-op otherwise.
    if (cfg.adminEnabled) logFirstRunBannerIfNeeded(cfg);
  });
  server.on("error", (err) => {
    log.error("server error", { error: err.message });
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    server.close(() => {
      try {
        closeDb();
      } catch {
        // ignore
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
