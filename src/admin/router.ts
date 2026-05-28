import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { PROVIDER_LIST, PROVIDERS } from "../providers/registry.js";
import {
  aggregateErrors,
  aggregateLatency,
  aggregateMappings,
  aggregateProviderHealth,
  aggregateStats,
  aggregateTokensTimeseries,
  aggregateUsagePerUser,
  deleteLogsBefore,
  getLogById,
  queryLogs,
} from "../db/logs.js";
import {
  deleteModel,
  insertCustomModel,
  listModels,
  patchModel,
  listModelAliases,
  upsertModelAlias,
  deleteModelAlias,
} from "../db/models.js";
import {
  deleteSetting,
  ForbiddenSettingError,
  getSetting,
  isForbiddenSettingKey,
  listSettings,
  setSetting,
} from "../db/settings.js";
import type { ProviderId } from "../providers/types.js";
import { isProviderId } from "../providers/registry.js";
import { log } from "../util/log.js";
import { buildSnippetBundle, resolveSnippetTarget, tomlProviderKeyFor } from "../setup/snippets.js";
import {
  GenericLoaderError,
  locateProvidersFile,
  readSpecsFromFile,
  writeSpecsToFile,
} from "../providers/genericLoader.js";
import type { GenericProviderSpec } from "../providers/generic.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";
import { isAbsolute as pathIsAbsolute } from "node:path";
import { applyCodex, deleteBackupPair, readCodexState, restoreCodex } from "../codex/state.js";
import { resolveDataDirInfo } from "../db/dataDir.js";
import { pointerFilePath } from "../db/dataDirPointer.js";
import {
  previewMigration,
  runMigration,
  type MigrationEvent,
} from "./migration.js";
import {
  isRestartRequired,
  getRestartInfo,
  isMaintenance,
} from "../util/maintenance.js";
import { authJsonPath, configTomlPath } from "../codex/paths.js";
import {
  renderApplyPowerShellScript,
  renderApplyShellScript,
} from "../codex/bundle.js";
import {
  appendCodexHistory,
  deleteCodexHistory,
  getCodexHistoryById,
  hasInitialHistory,
  listCodexHistory,
} from "../db/codexHistory.js";
import { buildCcSwitchFiles } from "../setup/snippets.js";
import {
  clearActiveOverride,
  getActiveOverride,
  setActiveOverride,
} from "../db/overrides.js";
import {
  callOpenAICompat,
  callResponsesPassthrough,
  UpstreamError,
} from "../upstream/openaiCompatClient.js";
import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import {
  compareVersions,
  DEFAULT_TTL_MS,
  getCachedStatus,
  refreshCacheInBackground,
  resolveStatus,
  type UpdateStatus,
} from "../util/checkUpdate.js";
import { detectUpdateMethod } from "../setup/updateMethod.js";
import { runUpdate } from "../setup/runUpdate.js";
import type { AuthContext } from "../auth/middleware.js";
import {
  buildSessionCookie,
  clearSessionCookieHeader,
} from "../auth/middleware.js";
import {
  countUsers,
  createUser,
  findUserByUsername,
  listUsers,
  updateUser,
  type UserRow,
} from "../db/users.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import {
  createSession,
  deleteSession,
} from "../db/sessions.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../db/apiKeys.js";
import {
  deleteUpstreamKey,
  listUpstreamKeys,
  setUpstreamKey,
} from "../db/upstreamKeys.js";
import { loadMasterKey } from "../security/masterKey.js";
import {
  deleteOAuthClient,
  listOAuthClients,
  upsertOAuthClient,
  type OAuthProvider,
} from "../db/oauthClients.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function publicUser(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: u.is_admin === 1,
    status: u.status,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

function sessionCookieOpts(cfg: Config): { ttlMs: number; secure: boolean } {
  return { ttlMs: SESSION_TTL_MS, secure: cfg.cookieSecure };
}

// Locate dist/web/ relative to THIS module's location, not process.cwd().
// When mimo2codex is installed globally (`npm install -g`), the user invokes
// it from any working directory, so cwd is never the install root.
//
// Two layouts to support:
//   - production (`node dist/cli.js`):   <root>/dist/admin/router.js → ../web
//   - dev mode (`tsx src/cli.ts`):       <root>/src/admin/router.ts  → ../../dist/web
//
// The list is checked in order; whichever exists wins. If neither exists we
// fall back to the production path for the 503 message — that's the path the
// user is most likely meant to populate via `npm run web:build`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_ROOT = (() => {
  const candidates = [
    resolve(__dirname, "..", "web"),                  // dist/admin → dist/web
    resolve(__dirname, "..", "..", "dist", "web"),    // src/admin  → dist/web
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
})();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message, status } });
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("admin body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (!text) return resolve({} as T);
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const u = new URL(req.url ?? "/", "http://localhost");
  return { pathname: u.pathname, query: u.searchParams };
}

function providerStateFor(cfg: Config): Array<Record<string, unknown>> {
  return PROVIDER_LIST.map((p) => {
    const runtime = cfg.providers[p.id];
    return {
      id: p.id,
      shortcut: p.shortcut,
      display_name: p.displayName,
      default: cfg.defaultProviderId === p.id,
      enabled: !!runtime,
      api_key_present: !!runtime,
      api_key_env: p.envKeys,
      base_url: runtime?.baseUrl ?? p.defaultBaseUrl,
      default_model: p.defaultModel,
      flags: runtime?.flags ?? {},
    };
  });
}

interface RouteContext {
  cfg: Config;
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  query: URLSearchParams;
  auth: AuthContext;
}

async function handleApi(ctx: RouteContext): Promise<void> {
  const { cfg, req, res, pathname, query } = ctx;

  // GET /admin/api/health — quick liveness probe for the UI
  if (req.method === "GET" && pathname === "/admin/api/health") {
    // userAgent is "mimo2codex/<version>"; split out the version part for
    // the footer (cli.ts is the only place that has the package.json version
    // and it stashes it on cfg.userAgent during startup).
    const version = cfg.userAgent.startsWith("mimo2codex/")
      ? cfg.userAgent.slice("mimo2codex/".length)
      : cfg.userAgent;
    const restart = isRestartRequired() ? getRestartInfo() : null;
    return sendJson(res, 200, {
      ok: true,
      dataDir: cfg.dataDir,
      version,
      authMode: cfg.authMode,
      maintenance: isMaintenance(),
      restartRequired: !!restart,
      restartReason: restart?.reason ?? null,
      restartTargetDir: restart?.targetDir ?? null,
    });
  }

  // GET /admin/api/desktop/sentinel — tell the admin UI whether it's running
  // INSIDE the Electron desktop shell. The sidecar process spawned by the
  // desktop main has MIMO2CODEX_DESKTOP_PARENT=1 injected into its env (see
  // package/desktop/src/paths.ts → SidecarPaths.env). The admin React UI uses
  // this to decide whether to show the "Open Desktop Settings" button — it
  // only makes sense when there IS a desktop shell to call back to. This
  // endpoint is unauthenticated on purpose: the answer is the same for every
  // caller and contains no secrets.
  if (req.method === "GET" && pathname === "/admin/api/desktop/sentinel") {
    return sendJson(res, 200, {
      inDesktop: process.env.MIMO2CODEX_DESKTOP_PARENT === "1",
    });
  }

  // POST /admin/api/desktop/signal — body { action: "open-settings" }. The
  // sidecar writes a one-line JSON to <dataDir>/.desktop-signal.json, which
  // the Electron main watches via fs.watch and acts on (e.g. opening the
  // Settings window). This indirection avoids exposing a custom protocol or
  // running Electron's preload bridge inside the admin BrowserWindow.
  // Locked to the in-desktop case so a stray POST from a browser tab on a
  // CLI install can't make anything happen.
  if (req.method === "POST" && pathname === "/admin/api/desktop/signal") {
    if (process.env.MIMO2CODEX_DESKTOP_PARENT !== "1") {
      return sendError(
        res,
        404,
        "not_in_desktop",
        "this endpoint is only available when running inside the desktop shell"
      );
    }
    type Body = { action?: unknown };
    const body = await readJsonBody<Body>(req);
    const action = typeof body.action === "string" ? body.action : null;
    if (action !== "open-settings") {
      return sendError(res, 400, "invalid_action", "action must be 'open-settings'");
    }
    try {
      const { writeFileSync } = await import("node:fs");
      const signalPath = join(cfg.dataDir, ".desktop-signal.json");
      writeFileSync(
        signalPath,
        JSON.stringify({ action, ts: Date.now() }) + "\n",
        "utf8"
      );
      log.info("desktop signal written", { signalPath, action });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      log.error("failed to write desktop signal", { error: (err as Error).message });
      return sendError(res, 500, "signal_write_failed", (err as Error).message);
    }
  }

  // GET /admin/api/data-dir/info — current path + resolution source for the
  // settings UI. The SPA renders different copy depending on whether the user
  // can actually change the path (pointer/default) or not (cli/env).
  if (req.method === "GET" && pathname === "/admin/api/data-dir/info") {
    // Re-resolve *without* the CLI override (which we no longer have access to
    // after boot) to learn what env/pointer/default would have produced. Then
    // compare against cfg.dataDir — if they diverge, the operator passed
    // --data-dir at boot, so the UI must be read-only.
    const info = resolveDataDirInfo(undefined, process.env);
    const current = cfg.dataDir;
    let source: "cli" | "env" | "pointer" | "default";
    if (info.envOverride && current === info.envOverride) {
      source = "env";
    } else if (info.pointerValue && current === info.pointerValue) {
      source = "pointer";
    } else if (current === info.defaultDir) {
      source = "default";
    } else {
      source = "cli";
    }
    return sendJson(res, 200, {
      current,
      source,
      defaultDir: info.defaultDir,
      envOverride: info.envOverride,
      pointerValue: info.pointerValue,
      pointerPath: pointerFilePath(),
      editable: source === "default" || source === "pointer",
    });
  }

  // POST /admin/api/data-dir/preview — body { targetDir }. Returns whether
  // the target is acceptable and how big the planned copy is.
  if (req.method === "POST" && pathname === "/admin/api/data-dir/preview") {
    if (isRestartRequired()) {
      return sendError(
        res,
        409,
        "restart_required",
        "a previous migration already succeeded — restart the process before starting another"
      );
    }
    type Body = { targetDir?: unknown };
    const body = await readJsonBody<Body>(req);
    if (typeof body.targetDir !== "string") {
      return sendError(res, 400, "invalid_body", "targetDir is required");
    }
    const result = previewMigration(cfg.dataDir, body.targetDir);
    return sendJson(res, 200, result);
  }

  // POST /admin/api/data-dir/migrate — body { targetDir }. SSE stream of
  // progress events. Connection ends after `done` or `error`. The server
  // stays in maintenance mode and the restartRequired flag flips to true on
  // success; the SPA shows a persistent banner until the user restarts.
  if (req.method === "POST" && pathname === "/admin/api/data-dir/migrate") {
    if (isRestartRequired()) {
      return sendError(
        res,
        409,
        "restart_required",
        "a previous migration already succeeded — restart the process before starting another"
      );
    }
    if (isMaintenance()) {
      return sendError(
        res,
        409,
        "maintenance_in_progress",
        "a migration is already in progress"
      );
    }
    type Body = { targetDir?: unknown };
    const body = await readJsonBody<Body>(req);
    if (typeof body.targetDir !== "string" || !body.targetDir) {
      return sendError(res, 400, "invalid_body", "targetDir is required");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const write = (evt: MigrationEvent): void => {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    };
    try {
      await runMigration(cfg.dataDir, body.targetDir, write);
    } catch (err) {
      // Defensive — runMigration emits its own error events; this catches
      // anything that escapes the inner try/catches.
      write({
        type: "error",
        code: "internal_error",
        message: (err as Error).message,
      });
      log.error("data-dir migration crashed", {
        error: (err as Error).message,
      });
    }
    res.end();
    return;
  }

  // GET /admin/api/auth/me — returns the active user or null. In authMode=off
  // always returns { user: null, authMode: "off" } so the SPA can detect the
  // mode without 401-checking. In authMode=on returns the resolved user;
  // unauthenticated callers see { user: null, authMode: "on" } and the SPA
  // routes them to /admin/login.
  if (req.method === "GET" && pathname === "/admin/api/auth/me") {
    let allowRegister = false;
    try {
      allowRegister = getSetting("auth.allowRegister") === "1";
    } catch {
      // settings not available (e.g. pre-migration startup) — default off.
    }
    return sendJson(res, 200, {
      authMode: cfg.authMode,
      user: ctx.auth.user ? publicUser(ctx.auth.user) : null,
      // Hint for SPA: when authMode=on AND no users exist yet, the bootstrap
      // page should be shown instead of login.
      needsBootstrap: cfg.authMode === "on" && safeCountUsers() === 0,
      // Whether the Login page should surface a "create account" link.
      allowRegister: cfg.authMode === "on" && allowRegister,
    });
  }

  // POST /admin/api/auth/login { username, password } → sets session cookie.
  if (req.method === "POST" && pathname === "/admin/api/auth/login") {
    if (cfg.authMode !== "on") {
      return sendError(res, 400, "auth_off", "login is unavailable in local mode");
    }
    const body = await readJsonBody<{ username?: unknown; password?: unknown }>(req);
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return sendError(res, 400, "invalid_body", "username and password are required");
    }
    const user = findUserByUsername(body.username);
    if (!user || !user.password_hash || user.status !== "active") {
      return sendError(res, 401, "invalid_credentials", "incorrect username or password");
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      return sendError(res, 401, "invalid_credentials", "incorrect username or password");
    }
    const { token } = createSession({
      userId: user.id,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      ip: req.socket?.remoteAddress ?? null,
      ttlMs: SESSION_TTL_MS,
    });
    res.setHeader("Set-Cookie", buildSessionCookie(token, sessionCookieOpts(cfg)));
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // POST /admin/api/auth/register { username, password, displayName? }
  // Self-registration. Only accepted when authMode=on AND the operator has
  // flipped the `auth.allowRegister` setting on (default OFF). Result user
  // is a normal (non-admin) account, immediately signed in.
  if (req.method === "POST" && pathname === "/admin/api/auth/register") {
    if (cfg.authMode !== "on") {
      return sendError(res, 400, "auth_off", "registration is unavailable in local mode");
    }
    const allowed = (() => {
      try {
        return getSetting("auth.allowRegister") === "1";
      } catch {
        return false;
      }
    })();
    if (!allowed) {
      return sendError(res, 403, "register_disabled", "open registration is disabled by admin");
    }
    const body = await readJsonBody<{
      username?: unknown;
      password?: unknown;
      displayName?: unknown;
    }>(req);
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return sendError(res, 400, "invalid_body", "username and password are required");
    }
    if (body.password.length < 8) {
      return sendError(res, 400, "weak_password", "password must be at least 8 characters");
    }
    if (findUserByUsername(body.username)) {
      return sendError(res, 409, "username_taken", "username is already in use");
    }
    const hash = await hashPassword(body.password);
    const user = createUser({
      username: body.username,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      passwordHash: hash,
      isAdmin: false,
    });
    log.info(`user self-registered: username=${user.username}`);
    const { token } = createSession({
      userId: user.id,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      ip: req.socket?.remoteAddress ?? null,
      ttlMs: SESSION_TTL_MS,
    });
    res.setHeader("Set-Cookie", buildSessionCookie(token, sessionCookieOpts(cfg)));
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // POST /admin/api/auth/logout — clears session cookie + DB row (if any).
  if (req.method === "POST" && pathname === "/admin/api/auth/logout") {
    if (ctx.auth.session) deleteSession(ctx.auth.session.id);
    res.setHeader("Set-Cookie", clearSessionCookieHeader(cfg.cookieSecure));
    return sendJson(res, 200, { ok: true });
  }

  // POST /admin/api/bootstrap { username, password, displayName? }
  // Creates the first admin. Valid only while the users table is empty AND
  // authMode=on. Standard first-run-wizard pattern (Jellyfin / Nextcloud /
  // Synology): whoever sets the password first wins. The race window is
  // between container start and the operator opening /admin/.
  if (req.method === "POST" && pathname === "/admin/api/bootstrap") {
    if (cfg.authMode !== "on") {
      return sendError(res, 400, "auth_off", "bootstrap is unavailable in local mode");
    }
    if (safeCountUsers() > 0) {
      return sendError(res, 409, "already_initialized", "an admin user already exists");
    }
    const body = await readJsonBody<{
      username?: unknown;
      password?: unknown;
      displayName?: unknown;
    }>(req);
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return sendError(res, 400, "invalid_body", "username and password are required");
    }
    if (body.password.length < 8) {
      return sendError(res, 400, "weak_password", "password must be at least 8 characters");
    }
    const hash = await hashPassword(body.password);
    const user = createUser({
      username: body.username,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      passwordHash: hash,
      isAdmin: true,
    });
    log.info(`first admin created via bootstrap: username=${user.username}`);
    const { token } = createSession({
      userId: user.id,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      ip: req.socket?.remoteAddress ?? null,
      ttlMs: SESSION_TTL_MS,
    });
    res.setHeader("Set-Cookie", buildSessionCookie(token, sessionCookieOpts(cfg)));
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // GET /admin/api/users — admin-only. Returns each user with their lifetime
  // request/token usage joined from chat_logs (v5 schema). Empty stats (new
  // user, never made a request) come through as zeros.
  if (req.method === "GET" && pathname === "/admin/api/users") {
    if (!requireAdmin(ctx)) return;
    let usage: ReturnType<typeof aggregateUsagePerUser> = [];
    try {
      usage = aggregateUsagePerUser();
    } catch {
      // Pre-v5 DB shouldn't be reachable in normal operation, but defensively
      // fall back to empty usage so the page still loads.
    }
    const byUser = new Map(usage.map((u) => [u.user_id, u]));
    return sendJson(res, 200, {
      users: listUsers().map((u) => ({
        ...publicUser(u),
        request_count: byUser.get(u.id)?.request_count ?? 0,
        total_tokens: byUser.get(u.id)?.total_tokens ?? 0,
        last_activity: byUser.get(u.id)?.last_activity ?? null,
      })),
    });
  }

  // POST /admin/api/users { username, password, displayName?, isAdmin? }
  if (req.method === "POST" && pathname === "/admin/api/users") {
    if (!requireAdmin(ctx)) return;
    const body = await readJsonBody<{
      username?: unknown;
      password?: unknown;
      displayName?: unknown;
      isAdmin?: unknown;
    }>(req);
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return sendError(res, 400, "invalid_body", "username and password required");
    }
    if (body.password.length < 8) {
      return sendError(res, 400, "weak_password", "password must be at least 8 characters");
    }
    if (findUserByUsername(body.username)) {
      return sendError(res, 409, "username_taken", "username is already in use");
    }
    const hash = await hashPassword(body.password);
    const user = createUser({
      username: body.username,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      passwordHash: hash,
      isAdmin: body.isAdmin === true,
    });
    log.info(`user created by admin: username=${user.username} admin=${user.is_admin}`);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // GET /admin/api/auth/oauth-providers — publicly readable so the login
  // page can render the right set of social-login buttons. No secret material
  // is exposed; only {provider, enabled}.
  if (req.method === "GET" && pathname === "/admin/api/auth/oauth-providers") {
    if (cfg.authMode !== "on") {
      return sendJson(res, 200, { providers: [] });
    }
    let rows: ReturnType<typeof listOAuthClients> = [];
    try {
      rows = listOAuthClients();
    } catch {
      // settings db could be unopened in degenerate setups — return empty.
    }
    return sendJson(res, 200, {
      providers: rows
        .filter((r) => r.enabled)
        .map((r) => ({ provider: r.provider, callback_url: r.callback_url })),
    });
  }

  // GET /admin/api/oauth-clients — admin-only list (full metadata, no secret).
  if (req.method === "GET" && pathname === "/admin/api/oauth-clients") {
    if (!requireAdmin(ctx)) return;
    return sendJson(res, 200, { clients: listOAuthClients() });
  }

  // PUT /admin/api/oauth-clients/:provider — admin upsert. clientSecret may
  // be omitted on subsequent edits to preserve the existing ciphertext.
  // DELETE /admin/api/oauth-clients/:provider — admin remove.
  {
    const m = /^\/admin\/api\/oauth-clients\/(gitee|github)$/.exec(pathname);
    if (m) {
      if (!requireAdmin(ctx)) return;
      const provider = m[1] as OAuthProvider;
      if (req.method === "PUT") {
        const body = await readJsonBody<{
          clientId?: unknown;
          clientSecret?: unknown;
          callbackUrl?: unknown;
          enabled?: unknown;
        }>(req);
        if (
          typeof body.clientId !== "string" ||
          typeof body.callbackUrl !== "string"
        ) {
          return sendError(res, 400, "invalid_body", "clientId and callbackUrl required");
        }
        const { key } = loadMasterKey(cfg.dataDir);
        try {
          upsertOAuthClient(
            {
              provider,
              clientId: body.clientId,
              clientSecret:
                typeof body.clientSecret === "string" && body.clientSecret.length > 0
                  ? body.clientSecret
                  : null,
              callbackUrl: body.callbackUrl,
              enabled: body.enabled === true,
            },
            key
          );
        } catch (err) {
          return sendError(res, 400, "invalid_body", (err as Error).message);
        }
        log.info(`oauth client upserted: provider=${provider} enabled=${body.enabled === true}`);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        const deleted = deleteOAuthClient(provider);
        return sendJson(res, 200, { deleted });
      }
    }
  }

  // GET /admin/api/me/api-keys — current user's bearer tokens (no secret).
  if (req.method === "GET" && pathname === "/admin/api/me/api-keys") {
    if (!requireUser(ctx)) return;
    const rows = listApiKeys(ctx.auth.user!.id).map((r) => ({
      id: r.id,
      name: r.name,
      key_prefix: r.key_prefix,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }));
    return sendJson(res, 200, { api_keys: rows });
  }

  // POST /admin/api/me/api-keys { name } — mint a new bearer token. Plaintext
  // is returned EXACTLY ONCE in the response — the UI must surface it
  // immediately because the hash-only storage means we can't show it again.
  if (req.method === "POST" && pathname === "/admin/api/me/api-keys") {
    if (!requireUser(ctx)) return;
    const body = await readJsonBody<{ name?: unknown }>(req);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "default";
    const { token, row } = createApiKey(ctx.auth.user!.id, name);
    return sendJson(res, 200, {
      token,
      api_key: {
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
      },
    });
  }

  // DELETE /admin/api/me/api-keys/:id — revoke (soft-delete) one of the
  // current user's keys. We use soft-delete so future logs can still attribute
  // older requests to a named key.
  {
    const m = /^\/admin\/api\/me\/api-keys\/(\d+)$/.exec(pathname);
    if (m && req.method === "DELETE") {
      if (!requireUser(ctx)) return;
      const ok = revokeApiKey(ctx.auth.user!.id, Number(m[1]));
      if (!ok) return sendError(res, 404, "not_found", "no such api key");
      return sendJson(res, 200, { revoked: true });
    }
  }

  // GET /admin/api/me/upstream-keys — BYOK provider list (no ciphertext).
  if (req.method === "GET" && pathname === "/admin/api/me/upstream-keys") {
    if (!requireUser(ctx)) return;
    return sendJson(res, 200, { upstream_keys: listUpstreamKeys(ctx.auth.user!.id) });
  }

  // PUT /admin/api/me/upstream-keys/:providerId { apiKey } — set / replace.
  // DELETE /admin/api/me/upstream-keys/:providerId — clear.
  {
    const m = /^\/admin\/api\/me\/upstream-keys\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (m) {
      if (!requireUser(ctx)) return;
      const providerId = m[1];
      // Validate the provider exists — both built-in and any user-declared
      // generic are acceptable targets.
      if (!PROVIDER_LIST.find((p) => p.id === providerId)) {
        return sendError(res, 404, "unknown_provider", `provider ${providerId} not registered`);
      }
      if (req.method === "PUT") {
        const body = await readJsonBody<{ apiKey?: unknown }>(req);
        if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
          return sendError(res, 400, "invalid_body", "apiKey is required");
        }
        const { key } = loadMasterKey(cfg.dataDir);
        setUpstreamKey(ctx.auth.user!.id, providerId, body.apiKey.trim(), key);
        return sendJson(res, 200, { ok: true, provider_id: providerId });
      }
      if (req.method === "DELETE") {
        const deleted = deleteUpstreamKey(ctx.auth.user!.id, providerId);
        return sendJson(res, 200, { deleted });
      }
    }
  }

  // GET / PUT /admin/api/auth/register-policy — admin-only toggle for
  // self-registration. Mirrors the settings.auth.allowRegister setting but
  // gives the UI a focused endpoint without exposing the whole settings KV.
  if (pathname === "/admin/api/auth/register-policy") {
    if (req.method === "GET") {
      if (!requireAdmin(ctx)) return;
      let allowRegister = false;
      try {
        allowRegister = getSetting("auth.allowRegister") === "1";
      } catch {
        /* default false */
      }
      return sendJson(res, 200, { allowRegister });
    }
    if (req.method === "PUT") {
      if (!requireAdmin(ctx)) return;
      const body = await readJsonBody<{ allowRegister?: unknown }>(req);
      if (typeof body.allowRegister !== "boolean") {
        return sendError(res, 400, "invalid_body", "allowRegister: boolean is required");
      }
      setSetting("auth.allowRegister", body.allowRegister ? "1" : "0");
      log.info(`auth.allowRegister set to ${body.allowRegister} via admin UI`);
      return sendJson(res, 200, { allowRegister: body.allowRegister });
    }
  }

  // PATCH /admin/api/users/:id { displayName?, isAdmin?, status?, password? }
  {
    const m = /^\/admin\/api\/users\/(\d+)$/.exec(pathname);
    if (m && req.method === "PATCH") {
      if (!requireAdmin(ctx)) return;
      const id = Number(m[1]);
      const body = await readJsonBody<{
        displayName?: unknown;
        isAdmin?: unknown;
        status?: unknown;
        password?: unknown;
      }>(req);
      const patch: Parameters<typeof updateUser>[1] = {};
      if (typeof body.displayName === "string" || body.displayName === null) {
        patch.displayName = body.displayName as string | null;
      }
      if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
      if (body.status === "active" || body.status === "disabled") patch.status = body.status;
      if (typeof body.password === "string") {
        if (body.password.length < 8) {
          return sendError(res, 400, "weak_password", "password must be at least 8 characters");
        }
        patch.passwordHash = await hashPassword(body.password);
      }
      const updated = updateUser(id, patch);
      if (!updated) return sendError(res, 404, "not_found", `no user with id ${id}`);
      return sendJson(res, 200, { user: publicUser(updated) });
    }
  }

  if (req.method === "GET" && pathname === "/admin/api/providers") {
    return sendJson(res, 200, { providers: providerStateFor(cfg) });
  }

  // GET /admin/api/generic-providers
  // Returns the raw spec list from providers.json + metadata about where
  // the file lives. The admin UI uses this to populate its editor.
  if (req.method === "GET" && pathname === "/admin/api/generic-providers") {
    const loc = locateProvidersFile(process.env, cfg.dataDir);
    if (!loc) {
      // dataDir is unset (admin runs without persistence) — no canonical
      // path to edit. UI surfaces this as a read-only banner.
      return sendJson(res, 200, {
        specs: [],
        path: null,
        source: null,
        exists: false,
        editable: false,
        notice:
          "no providers.json location available — admin UI cannot edit when --no-admin is set",
      });
    }
    let specs: GenericProviderSpec[] = [];
    if (loc.exists) {
      try {
        specs = readSpecsFromFile(loc.path);
      } catch (err) {
        if (err instanceof GenericLoaderError) {
          return sendJson(res, 200, {
            specs: [],
            path: loc.path,
            source: loc.source,
            exists: true,
            editable: true,
            error: err.message,
          });
        }
        throw err;
      }
    }
    return sendJson(res, 200, {
      specs,
      path: loc.path,
      source: loc.source,
      exists: loc.exists,
      editable: true,
    });
  }

  // PUT /admin/api/generic-providers
  // Body: { providers: GenericProviderSpec[] }
  // Validates every spec, then atomically writes to providers.json. A
  // restart is still required for the change to take effect (the in-memory
  // registry is initialized once at startup).
  if (req.method === "PUT" && pathname === "/admin/api/generic-providers") {
    const loc = locateProvidersFile(process.env, cfg.dataDir);
    if (!loc) {
      return sendError(
        res,
        400,
        "no_writable_location",
        "no providers.json path is available — set MIMO2CODEX_DATA_DIR or restart without --no-admin"
      );
    }
    let body: { providers?: unknown };
    try {
      body = await readJsonBody<{ providers?: unknown }>(req);
    } catch (err) {
      return sendError(res, 400, "invalid_json", (err as Error).message);
    }
    if (!Array.isArray(body.providers)) {
      return sendError(res, 400, "invalid_body", "body must include providers: array");
    }
    try {
      writeSpecsToFile(loc.path, body.providers as GenericProviderSpec[]);
    } catch (err) {
      if (err instanceof GenericLoaderError) {
        return sendError(res, 400, "validation_failed", err.message);
      }
      return sendError(res, 500, "write_failed", (err as Error).message);
    }
    log.info(
      `providers.json updated via admin UI (${(body.providers as unknown[]).length} entries, restart required)`
    );
    return sendJson(res, 200, {
      ok: true,
      path: loc.path,
      restartRequired: true,
    });
  }

  // GET /admin/api/thinking-state
  // PUT /admin/api/thinking-state body { disabled?: boolean, forceHighEffort?: boolean }
  // PUT 写 settings.thinking.disabled / .forceHighEffort（同一请求可只改一个，未传字段不变）。
  // GET 返回两个开关的 effective + cliOverride 标志。disableThinking 受 CLI flag 控制；
  // forceHighEffort 目前仅 settings 控制。
  if (pathname === "/admin/api/thinking-state") {
    if (req.method === "GET") {
      const cliOverride = cfg.disableThinkingFromCli ?? null;
      const disabledFromSetting = (() => {
        try {
          return getSetting("thinking.disabled") === "1";
        } catch {
          return false;
        }
      })();
      const forceHighEffortFromSetting = (() => {
        try {
          return getSetting("thinking.forceHighEffort") === "1";
        } catch {
          return false;
        }
      })();
      const effective = cliOverride !== null ? cliOverride : disabledFromSetting;
      return sendJson(res, 200, {
        effective,
        cliOverride,
        setting: disabledFromSetting,
        forceHighEffort: forceHighEffortFromSetting,
      });
    }
    if (req.method === "PUT") {
      const body = await readJsonBody<{ disabled?: unknown; forceHighEffort?: unknown }>(req);
      let changed = false;
      if (typeof body.disabled === "boolean") {
        setSetting("thinking.disabled", body.disabled ? "1" : "0");
        log.info(`thinking.disabled set to ${body.disabled} via admin UI`);
        changed = true;
      }
      if (typeof body.forceHighEffort === "boolean") {
        setSetting("thinking.forceHighEffort", body.forceHighEffort ? "1" : "0");
        log.info(`thinking.forceHighEffort set to ${body.forceHighEffort} via admin UI`);
        changed = true;
      }
      if (!changed) {
        return sendError(
          res,
          400,
          "invalid_body",
          "body must include at least one of: disabled (boolean), forceHighEffort (boolean)",
        );
      }
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 405, "method_not_allowed", "use GET or PUT");
  }

  // GET /admin/api/provider-presets
  // Returns the known-vendor preset metadata (matchBaseUrl / matchModelPrefix /
  // recommendedSpec) so the admin UI can auto-fill features when the user types
  // a known vendor's baseUrl/model into the New/Edit Generic Provider form. No
  // auth concerns — this is static metadata baked into the binary.
  if (req.method === "GET" && pathname === "/admin/api/provider-presets") {
    return sendJson(res, 200, { presets: PROVIDER_PRESETS });
  }

  // GET /admin/api/setup-snippets?provider=<id>
  // Returns every Codex-integration snippet variant (default auth.json,
  // env-key, cc-switch) so the Setup page can render all three tabs in one
  // round-trip. When `provider` is omitted, defaults to the configured
  // default provider — same fallback the CLI uses.
  if (req.method === "GET" && pathname === "/admin/api/setup-snippets") {
    const hint = query.get("provider") ?? cfg.defaultProviderId;
    const bundle = buildSnippetBundle(hint, { host: cfg.host, port: cfg.port });
    return sendJson(res, 200, {
      bundle,
      defaultProviderId: cfg.defaultProviderId,
      providers: PROVIDER_LIST.map((p) => ({
        id: p.id,
        shortcut: p.shortcut,
        display_name: p.displayName,
      })),
    });
  }

  // /admin/api/providers/:id/models
  const provModels = pathname.match(/^\/admin\/api\/providers\/([^/]+)\/models$/);
  if (provModels) {
    const id = provModels[1];
    if (!isProviderId(id)) return sendError(res, 404, "unknown_provider", `unknown provider ${id}`);
    if (req.method === "GET") {
      return sendJson(res, 200, { models: listModels(id) });
    }
    if (req.method === "POST") {
      const body = await readJsonBody<
        Partial<{ upstream_id: string; display_name: string; context_window: number | null }>
      >(req);
      if (!body.upstream_id) return sendError(res, 400, "missing_upstream_id", "upstream_id required");
      // Default new user-added models to a 1M context window — matches the
      // builtin MiMo / DeepSeek caps so the generated Codex toml doesn't
      // preemptively /compact, and matches user expectation that "newly
      // added models advertise the same window as the rest of the catalog".
      // Explicit values from the client (including null) still win.
      const contextWindow =
        body.context_window === undefined ? 1_000_000 : body.context_window;
      try {
        const row = insertCustomModel(id as ProviderId, {
          upstream_id: body.upstream_id,
          display_name: body.display_name,
          context_window: contextWindow,
        });
        return sendJson(res, 201, { model: row });
      } catch (err) {
        return sendError(res, 400, "insert_failed", (err as Error).message);
      }
    }
    return sendError(res, 405, "method_not_allowed", "use GET or POST");
  }

  // /admin/api/models/:id
  const modelId = pathname.match(/^\/admin\/api\/models\/(\d+)$/);
  if (modelId) {
    const id = Number(modelId[1]);
    if (req.method === "PATCH") {
      const body = await readJsonBody<Record<string, unknown>>(req);
      try {
        const row = patchModel(id, body);
        if (!row) return sendError(res, 404, "not_found", `model ${id} not found`);
        return sendJson(res, 200, { model: row });
      } catch (err) {
        return sendError(res, 400, "patch_failed", (err as Error).message);
      }
    }
    if (req.method === "DELETE") {
      try {
        const ok = deleteModel(id);
        if (!ok) return sendError(res, 404, "not_found", `model ${id} not found`);
        return sendJson(res, 200, { deleted: true });
      } catch (err) {
        return sendError(res, 400, "delete_failed", (err as Error).message);
      }
    }
    return sendError(res, 405, "method_not_allowed", "use PATCH or DELETE");
  }

  // /admin/api/aliases
  if (pathname === "/admin/api/aliases") {
    if (req.method === "GET") {
      const provider = query.get("provider") ?? undefined;
      return sendJson(res, 200, { aliases: listModelAliases(provider) });
    }
    if (req.method === "POST") {
      const body = await readJsonBody<{ alias?: string; providerId?: string; upstreamId?: string }>(req);
      if (!body.alias || !body.providerId || !body.upstreamId) {
        return sendError(res, 400, "missing_fields", "alias, providerId, and upstreamId required");
      }
      upsertModelAlias(body.alias, body.providerId, body.upstreamId);
      return sendJson(res, 201, { alias: body.alias, providerId: body.providerId, upstreamId: body.upstreamId });
    }
    return sendError(res, 405, "method_not_allowed", "use GET or POST");
  }

  // /admin/api/aliases/:alias
  const aliasMatch = pathname.match(/^\/admin\/api\/aliases\/(.+)$/);
  if (aliasMatch) {
    const alias = decodeURIComponent(aliasMatch[1]);
    if (req.method === "DELETE") {
      const ok = deleteModelAlias(alias);
      if (!ok) return sendError(res, 404, "not_found", `alias "${alias}" not found`);
      return sendJson(res, 200, { deleted: true });
    }
    return sendError(res, 405, "method_not_allowed", "use DELETE");
  }

  if (req.method === "GET" && pathname === "/admin/api/logs") {
    const provider = query.get("provider") ?? undefined;
    const model = query.get("model") ?? undefined;
    const statusMin = query.get("statusMin") ? Number(query.get("statusMin")) : undefined;
    const statusMax = query.get("statusMax") ? Number(query.get("statusMax")) : undefined;
    const from = query.get("from") ? Number(query.get("from")) : undefined;
    const to = query.get("to") ? Number(query.get("to")) : undefined;
    const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
    const offset = query.get("offset") ? Number(query.get("offset")) : undefined;
    return sendJson(res, 200, {
      logs: queryLogs({ provider, model, statusMin, statusMax, from, to, limit, offset }),
    });
  }

  if (req.method === "GET" && pathname === "/admin/api/stats/errors") {
    const range = query.get("range") ?? "24h";
    return sendJson(res, 200, aggregateErrors(range));
  }

  if (req.method === "GET" && pathname === "/admin/api/stats/latency") {
    const range = query.get("range") ?? "24h";
    return sendJson(res, 200, aggregateLatency(range));
  }

  if (req.method === "GET" && pathname === "/admin/api/provider-health") {
    // Window defaults to 1h; allow override via ?ms=<ms> for ad-hoc widening.
    const ms = query.get("ms") ? Number(query.get("ms")) : undefined;
    return sendJson(res, 200, { rows: aggregateProviderHealth(ms) });
  }

  if (req.method === "DELETE" && pathname === "/admin/api/logs") {
    const before = query.get("before");
    if (!before) return sendError(res, 400, "missing_before", "?before=<ts_ms> required");
    const removed = deleteLogsBefore(Number(before));
    return sendJson(res, 200, { removed });
  }

  // /admin/api/logs/:id — single log row including request_body + response_body.
  // Kept off the list endpoint so a 100-row table fetch doesn't haul megabytes
  // of payload across the wire on every refresh.
  const logIdMatch = pathname.match(/^\/admin\/api\/logs\/(\d+)$/);
  if (logIdMatch && req.method === "GET") {
    const id = Number(logIdMatch[1]);
    const row = getLogById(id);
    if (!row) return sendError(res, 404, "not_found", `log ${id} not found`);
    return sendJson(res, 200, { log: row });
  }

  if (req.method === "GET" && pathname === "/admin/api/mappings") {
    return sendJson(res, 200, { mappings: aggregateMappings() });
  }

  if (req.method === "GET" && pathname === "/admin/api/stats") {
    const range = query.get("range") ?? "24h";
    return sendJson(res, 200, aggregateStats(range));
  }

  // Per-bucket token timeseries for the dashboard chart. Dense (every
  // bucket in the window appears in `buckets`, zero-filled). Bucket size
  // is `?bucket=day` (default) or `?bucket=hour`.
  if (req.method === "GET" && pathname === "/admin/api/stats/timeseries") {
    const range = query.get("range") ?? "7d";
    const bucketParam = query.get("bucket");
    const bucket = bucketParam === "hour" ? "hour" : "day";
    return sendJson(res, 200, aggregateTokensTimeseries(range, bucket));
  }

  if (req.method === "GET" && pathname === "/admin/api/settings") {
    return sendJson(res, 200, { settings: listSettings() });
  }

  const settingKey = pathname.match(/^\/admin\/api\/settings\/([^/]+)$/);
  if (settingKey) {
    const key = decodeURIComponent(settingKey[1]);
    if (req.method === "PUT") {
      if (isForbiddenSettingKey(key)) {
        return sendError(
          res,
          400,
          "forbidden_setting",
          `${key} cannot be stored in the UI — set the corresponding env var instead (MIMO_API_KEY, DS_API_KEY, DEEPSEEK_API_KEY) and restart mimo2codex.`
        );
      }
      const body = await readJsonBody<{ value?: unknown }>(req);
      if (typeof body.value !== "string") {
        return sendError(res, 400, "invalid_value", "value must be a string");
      }
      try {
        setSetting(key, body.value);
        return sendJson(res, 200, { key, value: body.value });
      } catch (err) {
        if (err instanceof ForbiddenSettingError) {
          return sendError(res, 400, "forbidden_setting", err.message);
        }
        throw err;
      }
    }
    if (req.method === "DELETE") {
      const ok = deleteSetting(key);
      if (!ok) return sendError(res, 404, "not_found", `setting ${key} not found`);
      return sendJson(res, 200, { deleted: true });
    }
    return sendError(res, 405, "method_not_allowed", "use PUT or DELETE");
  }

  // ──────────── Codex 启用 (replaces ccswitch) ────────────
  //
  // codex-state: read-only snapshot of ~/.codex/ ownership + backup list +
  // active runtime override. UI reads this on every page load so it can
  // surface the right warnings (e.g. "your auth.json has a real OpenAI key,
  // overwriting will back it up").
  if (req.method === "GET" && pathname === "/admin/api/codex-state") {
    const state = readCodexState();
    return sendJson(res, 200, {
      ...state,
      activeOverride: getActiveOverride(),
    });
  }

  // codex-targets: aggregated (provider × model) pickable from the UI.
  // Built-in models come from PROVIDER_LIST; custom models come from the
  // sqlite models table. We surface hasKey so the UI can disable the
  // runtime-override button on providers without an api key (the file-write
  // button is fine without a key — the user might be setting up first).
  if (req.method === "GET" && pathname === "/admin/api/codex-targets") {
    const state = readCodexState();
    const override = getActiveOverride();
    const targets: Array<Record<string, unknown>> = [];
    for (const p of PROVIDER_LIST) {
      const runtime = cfg.providers[p.id];
      // Built-in catalog (declared by Provider.builtinModels).
      for (const m of p.builtinModels) {
        if (m.deprecatedAfter) continue;
        targets.push({
          providerId: p.id,
          providerDisplayName: p.displayName,
          providerKey: tomlProviderKeyFor(p.id),
          modelId: m.id,
          displayName: m.displayName ?? null,
          contextWindow: m.contextWindow ?? null,
          maxOutputTokens: m.maxOutputTokens ?? null,
          source: "builtin",
          hasKey: !!runtime,
          isCurrentOverride:
            override?.providerId === p.id && override?.modelId === m.id,
        });
      }
      // Custom models from the admin's models table — only when admin/db
      // is up (we're inside the admin router, so it is).
      try {
        const customRows = listModels(p.id);
        for (const row of customRows) {
          if (row.is_builtin === 1) continue; // dedup against builtinModels above
          targets.push({
            providerId: p.id,
            providerDisplayName: p.displayName,
            providerKey: tomlProviderKeyFor(p.id),
            modelId: row.upstream_id,
            displayName: row.display_name ?? null,
            contextWindow: row.context_window ?? null,
            maxOutputTokens: null,
            source: "custom",
            hasKey: !!runtime,
            isCurrentOverride:
              override?.providerId === p.id && override?.modelId === row.upstream_id,
          });
        }
      } catch {
        // listModels needs db open; skip silently if it's not.
      }
    }
    return sendJson(res, 200, {
      targets,
      activeOverride: override,
      authJsonOwner: state.authJsonOwner,
    });
  }

  // codex-apply: write ~/.codex/auth.json + config.toml for (provider, model).
  // Replaces ccswitch. The user must restart Codex for changes to take effect.
  if (req.method === "POST" && pathname === "/admin/api/codex-apply") {
    let body: { providerId?: unknown; modelId?: unknown };
    try {
      body = await readJsonBody<{ providerId?: unknown; modelId?: unknown }>(req);
    } catch (err) {
      return sendError(res, 400, "invalid_json", (err as Error).message);
    }
    if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
      return sendError(res, 400, "invalid_body", "providerId and modelId must be strings");
    }
    if (!isProviderId(body.providerId)) {
      return sendError(res, 400, "unknown_provider", `unknown provider ${body.providerId}`);
    }
    const provider = PROVIDERS[body.providerId];
    // Validate the model exists in either the built-in catalog or the
    // custom-models table. Forwarding an arbitrary unknown id would write
    // a config Codex can't actually use.
    const builtinHit = provider.builtinModels.some((m) => m.id === body.modelId);
    let customHit = false;
    if (!builtinHit) {
      try {
        customHit = listModels(provider.id).some((r) => r.upstream_id === body.modelId);
      } catch {
        /* db not open — only built-in validation available */
      }
    }
    if (!builtinHit && !customHit) {
      return sendError(
        res,
        400,
        "unknown_model",
        `model "${body.modelId}" is not in ${provider.id}'s catalog`
      );
    }
    // Build the SnippetTarget the writer expects. Reuse resolveSnippetTarget
    // for the default, then override modelId so we honor the user's pick.
    const baseTarget = resolveSnippetTarget(body.providerId);
    const targetModelMeta = provider.builtinModels.find((m) => m.id === body.modelId);
    const target = {
      ...baseTarget,
      modelId: body.modelId,
      contextWindow: targetModelMeta?.contextWindow ?? baseTarget.contextWindow,
      maxOutputTokens: targetModelMeta?.maxOutputTokens ?? baseTarget.maxOutputTokens,
    };
    try {
      const userId = ctx.auth.user?.id ?? null;
      // First-ever apply for this user (or local timeline): snapshot the
      // pre-existing ~/.codex state as `initial` so the user can always
      // roll back to "what was there before mimo2codex touched anything".
      // Server-mode containers can't read the user's machine, so this is
      // best-effort and only fires in local mode where the path resolves
      // to the host filesystem.
      if (cfg.authMode !== "on" && !hasInitialHistory(userId)) {
        try {
          captureInitialCodexSnapshot(userId);
        } catch {
          // If ~/.codex doesn't exist yet, that's the genuine "initial" —
          // skip the snapshot; future restores simply have no rollback target.
        }
      }

      // Render the would-be config from a single source of truth. Both modes
      // store these strings in history; local mode also calls applyCodex()
      // to write them to disk via the existing backup-aware path.
      const { authJson, configToml } = buildCcSwitchFiles(
        { host: cfg.host, port: cfg.port },
        target
      );

      let backupTs: number | null = null;
      let authBackup: string | null = null;
      let tomlBackup: string | null = null;
      let authJsonOwnerBefore: "mimo2codex" | "external" | "missing" = "missing";

      if (cfg.authMode !== "on") {
        const result = applyCodex(target, { host: cfg.host, port: cfg.port });
        backupTs = result.backupTs;
        authBackup = result.authBackup;
        tomlBackup = result.tomlBackup;
        authJsonOwnerBefore = result.authJsonOwnerBefore;
        log.info(
          `codex profile applied via webui: provider=${provider.id} model=${body.modelId} ` +
            `authJsonOwnerBefore=${result.authJsonOwnerBefore} backupTs=${result.backupTs}`
        );
      } else {
        log.info(
          `codex profile recorded for user=${userId ?? "?"}: provider=${provider.id} model=${body.modelId} ` +
            `(server-mode — no local file write)`
        );
      }

      const history = appendCodexHistory({
        userId,
        kind: "apply",
        providerId: provider.id,
        modelId: body.modelId,
        authJson,
        configToml,
        note: null,
      });

      return sendJson(res, 200, {
        ok: true,
        backupTs,
        authBackup,
        tomlBackup,
        authJsonOwnerBefore,
        restartRequired: true,
        historyId: history.id,
        // In server mode, the UI must show the download CTA instead of the
        // "we wrote files locally" success message.
        bundleUrl:
          cfg.authMode === "on"
            ? `/admin/api/codex-history/${history.id}/bundle`
            : null,
      });
    } catch (err) {
      log.error("codex-apply failed", { error: (err as Error).message });
      return sendError(res, 500, "apply_failed", (err as Error).message);
    }
  }

  // GET /admin/api/codex-history — list rows for the current user (or the
  // shared local timeline when authMode≠on).
  if (req.method === "GET" && pathname === "/admin/api/codex-history") {
    if (cfg.authMode === "on" && !ctx.auth.user) {
      return sendError(res, 401, "no_session", "session required");
    }
    const userId = cfg.authMode === "on" ? ctx.auth.user?.id ?? null : null;
    const rows = listCodexHistory(userId, 50).map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      provider_id: r.provider_id,
      model_id: r.model_id,
      note: r.note,
    }));
    return sendJson(res, 200, { history: rows });
  }

  // GET /admin/api/codex-history/:id/bundle — return the rendered files +
  // ready-to-run apply scripts for either platform.
  {
    const m = /^\/admin\/api\/codex-history\/(\d+)\/bundle$/.exec(pathname);
    if (m && req.method === "GET") {
      const id = Number(m[1]);
      const row = getCodexHistoryById(id);
      if (!row) return sendError(res, 404, "not_found", `no history row id=${id}`);
      // Scope check: per-user in server mode; in local mode only the NULL
      // (shared) timeline is accessible.
      if (cfg.authMode !== "on" && row.user_id !== null) {
        return sendError(res, 403, "forbidden", "row belongs to a user; local mode cannot access");
      }
      if (cfg.authMode === "on" && (row.user_id == null || row.user_id !== ctx.auth.user?.id)) {
        return sendError(res, 403, "forbidden", "row does not belong to the current user");
      }
      // We return the stored auth.json verbatim — including the
      // "mimo2codex-local" placeholder. Users go to /admin/account, mint a
      // key explicitly, and paste it into the downloaded auth.json before
      // running the apply script. Earlier iterations auto-minted a key per
      // download, which was confusing (silent key creation, multiple keys
      // accumulating for one user, no clear UX moment for the user to copy
      // the value somewhere). Explicit > implicit.
      return sendJson(res, 200, {
        history: {
          id: row.id,
          ts: row.ts,
          kind: row.kind,
          provider_id: row.provider_id,
          model_id: row.model_id,
          note: row.note,
        },
        files: {
          authJson: row.auth_json,
          configToml: row.config_toml,
        },
        scripts: {
          posix: renderApplyShellScript({
            authJson: row.auth_json,
            configToml: row.config_toml,
            providerId: row.provider_id ?? "?",
            modelId: row.model_id ?? "?",
          }),
          powershell: renderApplyPowerShellScript({
            authJson: row.auth_json,
            configToml: row.config_toml,
            providerId: row.provider_id ?? "?",
            modelId: row.model_id ?? "?",
          }),
        },
        // Kept for response-shape stability with previous releases.
        mintedKey: null,
      });
    }
  }

  // POST /admin/api/codex-import { authJson, configToml, providerId?, modelId?, note? }
  // User uploads an auth.json + config.toml pair (typically from another
  // machine) and we file it as a new history row of kind='apply'. Same UX
  // shape as a normal apply: local mode also writes the files to ~/.codex/,
  // server mode just records and the user later downloads the bundle.
  if (req.method === "POST" && pathname === "/admin/api/codex-import") {
    if (cfg.authMode === "on" && !ctx.auth.user) {
      return sendError(res, 401, "no_session", "session required");
    }
    const body = await readJsonBody<{
      authJson?: unknown;
      configToml?: unknown;
      providerId?: unknown;
      modelId?: unknown;
      note?: unknown;
    }>(req);
    if (typeof body.authJson !== "string" || typeof body.configToml !== "string") {
      return sendError(res, 400, "invalid_body", "authJson and configToml are required strings");
    }
    if (body.authJson.length > 64 * 1024 || body.configToml.length > 64 * 1024) {
      return sendError(res, 400, "too_large", "uploaded file exceeds 64KB");
    }
    // Cheap shape validation so users can't accidentally upload non-JSON or
    // non-TOML and end up with broken Codex configs at restore time.
    try {
      const parsed = JSON.parse(body.authJson);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    } catch (err) {
      return sendError(res, 400, "invalid_auth_json", `auth.json must be valid JSON: ${(err as Error).message}`);
    }
    const userId = cfg.authMode === "on" ? ctx.auth.user?.id ?? null : null;
    if (cfg.authMode !== "on" && !hasInitialHistory(userId)) {
      try {
        captureInitialCodexSnapshot(userId);
      } catch {
        /* best effort */
      }
    }
    // In local mode we write the uploaded files straight to disk so users get
    // the same one-click experience as a regular Apply.
    if (cfg.authMode !== "on") {
      try {
        const authPath = authJsonPath();
        const tomlPath = configTomlPath();
        // Hand-roll the backup ts so both halves stay paired.
        const ts = Date.now();
        // Lazily import the file helpers — they're already pulled in by
        // applyCodex's path, but referencing through "../codex/files.js" keeps
        // the import surface tidy.
        const { atomicWrite, backupFile } = await import("../codex/files.js");
        backupFile(authPath, ts);
        backupFile(tomlPath, ts);
        atomicWrite(authPath, body.authJson);
        atomicWrite(tomlPath, body.configToml);
      } catch (err) {
        return sendError(res, 500, "write_failed", (err as Error).message);
      }
    }
    const history = appendCodexHistory({
      userId,
      kind: "apply",
      providerId: typeof body.providerId === "string" ? body.providerId : null,
      modelId: typeof body.modelId === "string" ? body.modelId : null,
      authJson: body.authJson,
      configToml: body.configToml,
      note: typeof body.note === "string" ? body.note : "imported from local",
    });
    log.info(
      `codex import recorded: user=${userId ?? "?"} historyId=${history.id} ` +
        `provider=${typeof body.providerId === "string" ? body.providerId : "n/a"}`
    );
    return sendJson(res, 200, {
      ok: true,
      historyId: history.id,
      restartRequired: cfg.authMode !== "on",
      bundleUrl:
        cfg.authMode === "on"
          ? `/admin/api/codex-history/${history.id}/bundle`
          : null,
    });
  }

  // GET /admin/api/codex-current-bundle — "export the currently-active config
  // to my local machine" entry point. Finds the most recent apply (per-user
  // in server mode, NULL timeline in local mode) and reuses the bundle
  // endpoint's renderer + mint-key flow.
  if (req.method === "GET" && pathname === "/admin/api/codex-current-bundle") {
    if (cfg.authMode === "on" && !ctx.auth.user) {
      return sendError(res, 401, "no_session", "session required");
    }
    const userId = cfg.authMode === "on" ? ctx.auth.user?.id ?? null : null;
    const history = listCodexHistory(userId, 50);
    const target = history.find((r) => r.kind !== "initial") ?? history[0];
    if (!target) {
      return sendError(
        res,
        404,
        "no_history",
        "no Codex config has been applied yet — apply one from this page first"
      );
    }
    // Redirect to the existing bundle endpoint so all the mint-key + script-
    // rendering logic stays in one place.
    res.statusCode = 302;
    res.setHeader("Location", `/admin/api/codex-history/${target.id}/bundle`);
    res.end();
    return;
  }

  // DELETE /admin/api/codex-history/:id — drop a non-initial row from the
  // current user's timeline. Initial rows are protected (they're the only
  // path back to the pre-mimo2codex state).
  {
    const m = /^\/admin\/api\/codex-history\/(\d+)$/.exec(pathname);
    if (m && req.method === "DELETE") {
      if (cfg.authMode === "on" && !ctx.auth.user) {
        return sendError(res, 401, "no_session", "session required");
      }
      const id = Number(m[1]);
      const userId = cfg.authMode === "on" ? ctx.auth.user?.id ?? null : null;
      const ok = deleteCodexHistory(id, userId);
      if (!ok) return sendError(res, 400, "delete_blocked", "row missing or is the protected initial snapshot");
      return sendJson(res, 200, { deleted: true });
    }
  }

  // codex-backups: manual delete. Used by the UI's trash button on each
  // backup row. Preserved pairs (those that captured an external auth.json)
  // require `?force=1` so a careless click can't lose the only path back
  // to the user's original Codex config.
  const backupTsMatch = pathname.match(/^\/admin\/api\/codex-backups\/(\d+)$/);
  if (backupTsMatch && req.method === "DELETE") {
    const ts = Number(backupTsMatch[1]);
    const force = query.get("force") === "1" || query.get("force") === "true";
    try {
      const removed = deleteBackupPair(ts, { force });
      log.info(`codex backup deleted: ts=${ts} force=${force} files=${removed}`);
      return sendJson(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("no backup pair")) {
        return sendError(res, 404, "not_found", msg);
      }
      if (msg.includes("preserved")) {
        return sendError(res, 400, "preserved_backup", msg);
      }
      return sendError(res, 500, "delete_failed", msg);
    }
  }

  // codex-restore: undo a previous apply by restoring both files from a
  // paired backup. ts comes from /codex-state.backups.
  if (req.method === "POST" && pathname === "/admin/api/codex-restore") {
    let body: { ts?: unknown };
    try {
      body = await readJsonBody<{ ts?: unknown }>(req);
    } catch (err) {
      return sendError(res, 400, "invalid_json", (err as Error).message);
    }
    if (typeof body.ts !== "number" || !Number.isFinite(body.ts)) {
      return sendError(res, 400, "invalid_body", "ts must be a number");
    }
    try {
      restoreCodex(body.ts);
      log.info(`codex profile restored from backup ts=${body.ts}`);
      // Record the restore in history (local-mode timeline). We re-read the
      // now-restored files so the entry reflects what was actually written.
      try {
        const userId = cfg.authMode === "on" ? ctx.auth.user?.id ?? null : null;
        const authPath = authJsonPath();
        const tomlPath = configTomlPath();
        appendCodexHistory({
          userId,
          kind: "restore",
          providerId: null,
          modelId: null,
          authJson: existsSync(authPath) ? readFileSync(authPath, "utf-8") : "",
          configToml: existsSync(tomlPath) ? readFileSync(tomlPath, "utf-8") : "",
          note: `restored from backup ts=${body.ts}`,
        });
      } catch {
        // History recording is best-effort; the actual restore already succeeded.
      }
      return sendJson(res, 200, { ok: true, restartRequired: true });
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes("no backup pair")
        ? "not_found"
        : msg.includes("incomplete")
          ? "incomplete_pair"
          : "restore_failed";
      const status = code === "not_found" ? 404 : 400;
      return sendError(res, status, code, msg);
    }
  }

  // active-override: runtime model override stored in settings DB. Pass-0
  // of selectProvider() honors it before any normal routing logic.
  if (req.method === "GET" && pathname === "/admin/api/active-override") {
    return sendJson(res, 200, { override: getActiveOverride() });
  }
  if (req.method === "PUT" && pathname === "/admin/api/active-override") {
    let body: { providerId?: unknown; modelId?: unknown };
    try {
      body = await readJsonBody<{ providerId?: unknown; modelId?: unknown }>(req);
    } catch (err) {
      return sendError(res, 400, "invalid_json", (err as Error).message);
    }
    if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
      return sendError(res, 400, "invalid_body", "providerId and modelId must be strings");
    }
    if (!isProviderId(body.providerId)) {
      return sendError(res, 400, "unknown_provider", `unknown provider ${body.providerId}`);
    }
    // Require the provider to have a runtime (api key); without it the
    // override would be silently ignored at request time and the user
    // would think the switch worked.
    if (!cfg.providers[body.providerId]) {
      return sendError(
        res,
        400,
        "provider_has_no_key",
        `provider ${body.providerId} has no api key configured — override would have no effect`
      );
    }
    setActiveOverride(body.providerId, body.modelId);
    log.info(`active override set: provider=${body.providerId} model=${body.modelId}`);
    return sendJson(res, 200, { override: { providerId: body.providerId, modelId: body.modelId } });
  }
  if (req.method === "DELETE" && pathname === "/admin/api/active-override") {
    clearActiveOverride();
    log.info("active override cleared");
    return sendJson(res, 200, { deleted: true });
  }

  // codex-dir: get / set / clear the codex directory override. The override
  // is stored in settings.codex.dir; codexDir() in src/codex/paths.ts reads
  // it before falling back to CODEX_HOME env or ~/.codex. GET returns the
  // currently-effective dir + the override source (so the UI can show
  // "default" vs "env" vs "user-set"), PUT validates and writes, DELETE
  // clears the override.
  if (pathname === "/admin/api/codex-dir") {
    if (req.method === "GET") {
      const override = getSetting("codex.dir");
      const envOverride = process.env.CODEX_HOME ?? null;
      const source: "user" | "env" | "default" = override
        ? "user"
        : envOverride
          ? "env"
          : "default";
      const effective = readCodexState().codexDir;
      return sendJson(res, 200, { effective, override, envOverride, source });
    }
    if (req.method === "PUT") {
      const body = await readJsonBody<{ dir?: unknown }>(req);
      if (typeof body.dir !== "string" || !body.dir.trim()) {
        return sendError(res, 400, "invalid_body", "dir must be a non-empty string");
      }
      const dir = body.dir.trim();
      if (!pathIsAbsolute(dir)) {
        return sendError(
          res,
          400,
          "not_absolute",
          `codex dir must be an absolute path; got ${dir}`
        );
      }
      // Tolerate non-existent paths — the user may be configuring this before
      // Codex is installed, or before mkdir-ing the dir themselves. Only
      // reject if the path exists AND points at a non-directory (a file or
      // device), which is unambiguously wrong.
      if (existsSync(dir)) {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
          return sendError(
            res,
            400,
            "not_a_directory",
            `${dir} exists but is not a directory`
          );
        }
      }
      setSetting("codex.dir", dir);
      log.info(`codex dir override set: ${dir}`);
      return sendJson(res, 200, { effective: dir, override: dir, source: "user" });
    }
    if (req.method === "DELETE") {
      deleteSetting("codex.dir");
      log.info("codex dir override cleared");
      const envOverride = process.env.CODEX_HOME ?? null;
      const effective = readCodexState().codexDir;
      return sendJson(res, 200, {
        effective,
        override: null,
        envOverride,
        source: envOverride ? "env" : "default",
      });
    }
    return sendError(res, 405, "method_not_allowed", "use GET / PUT / DELETE");
  }

  // probe-model: send a minimal chat / responses ping to the upstream so the
  // user can verify a (provider, model) actually works end-to-end (api key
  // valid, base url reachable, model id recognized) before flipping Codex
  // to it. Times out at PROBE_TIMEOUT_MS so a hung upstream can't lock up
  // the admin UI.
  if (req.method === "POST" && pathname === "/admin/api/probe-model") {
    const body = await readJsonBody<{ providerId?: unknown; modelId?: unknown }>(req);
    if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
      return sendError(res, 400, "invalid_body", "providerId and modelId must be strings");
    }
    if (!isProviderId(body.providerId)) {
      return sendError(res, 400, "unknown_provider", `unknown provider ${body.providerId}`);
    }
    const provider = PROVIDERS[body.providerId];
    const runtime = cfg.providers[body.providerId];
    if (!runtime) {
      return sendJson(res, 200, {
        ok: false,
        latencyMs: 0,
        error: {
          code: "no_api_key",
          message: `provider ${body.providerId} has no API key configured`,
        },
      });
    }

    const PROBE_TIMEOUT_MS = 15_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    const start = Date.now();
    try {
      const upstreamCfg = {
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        userAgent: cfg.userAgent,
        enhanceError: provider.enhanceError,
        // Probes don't carry conversation history — context overflow is
        // impossible by construction, so the "friendly" rewrite has nothing
        // to do; passthrough keeps any upstream 400 verbatim for debugging.
        contextOverflowMode: "passthrough" as const,
      };
      let httpRes: Response;
      let upstreamPath: string;
      if (provider.wireApi === "responses") {
        const responsesBody: ResponsesRequest = {
          model: body.modelId,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "ping" }],
            },
          ],
          stream: false,
          max_output_tokens: 16,
        } as ResponsesRequest;
        upstreamPath = "/responses";
        httpRes = await callResponsesPassthrough(upstreamCfg, responsesBody, ac.signal);
      } else {
        const chatBody: ChatRequest = {
          model: body.modelId,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          max_completion_tokens: 16,
        };
        upstreamPath = "/chat/completions";
        httpRes = await callOpenAICompat(upstreamCfg, chatBody, ac.signal);
      }
      const json = (await httpRes.json()) as Record<string, unknown>;
      const latencyMs = Date.now() - start;
      const sample = extractProbeSample(json);
      return sendJson(res, 200, {
        ok: true,
        latencyMs,
        statusCode: httpRes.status,
        upstreamPath,
        sample,
      });
    } catch (err) {
      const latencyMs = Date.now() - start;
      if ((err as Error).name === "AbortError") {
        return sendJson(res, 200, {
          ok: false,
          latencyMs,
          error: {
            code: "timeout",
            message: `probe exceeded ${PROBE_TIMEOUT_MS}ms — upstream slow or unreachable`,
          },
        });
      }
      if (err instanceof UpstreamError) {
        return sendJson(res, 200, {
          ok: false,
          latencyMs,
          statusCode: err.status,
          error: { code: err.code, message: err.message },
        });
      }
      return sendJson(res, 200, {
        ok: false,
        latencyMs,
        error: { code: "unknown", message: (err as Error).message },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Update-check endpoints ─────────────────────────────────────────────
  // Layered so the webui can: poll status without touching the network, force
  // a fresh check on demand, kick off the actual update with streamed log
  // output, and persist a "stop bugging me" preference.
  if (req.method === "GET" && pathname === "/admin/api/update-status") {
    return sendJson(res, 200, buildUpdateStatusPayload(cfg));
  }

  if (req.method === "POST" && pathname === "/admin/api/check-update") {
    const version = parseCurrentVersion(cfg);
    try {
      const status = await resolveStatus({
        currentVersion: version,
        dataDir: cfg.dataDir || null,
        ttlMs: 0, // user explicitly asked: always hit the network
      });
      return sendJson(res, 200, decorateStatus(status, cfg));
    } catch (err) {
      return sendError(res, 502, "network_failure", (err as Error).message);
    }
  }

  if (req.method === "POST" && pathname === "/admin/api/update") {
    // Stream the update's stdout/stderr to the browser via SSE. After the
    // last frame, schedule a graceful shutdown so the user re-launches into
    // the upgraded binary. The frontend shows a "please restart" message
    // when the connection drops cleanly.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const writeEvent = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      writeEvent("start", { ts: Date.now() });
      const result = await runUpdate({
        onLine: (line, stream) => writeEvent("line", { line, stream }),
      });
      writeEvent("done", {
        exitCode: result.exitCode,
        method: result.method,
        skipped: result.skipped,
      });
      res.end();
      // Only schedule self-shutdown on a successful update — keep the server
      // alive on failure so the user can retry from the webui.
      if (!result.skipped && result.exitCode === 0) {
        log.info("update succeeded via webui — scheduling shutdown");
        setTimeout(() => process.exit(0), 500).unref();
      }
    } catch (err) {
      writeEvent("error", { message: (err as Error).message });
      res.end();
    }
    return;
  }

  if (req.method === "POST" && pathname === "/admin/api/update-preference") {
    type PrefBody = { updateCheckDisabled?: unknown; ignoredVersion?: unknown };
    const body = await readJsonBody<PrefBody>(req);
    if (typeof body.updateCheckDisabled === "boolean") {
      setSetting("updateCheckDisabled", body.updateCheckDisabled ? "1" : "0");
    }
    if (typeof body.ignoredVersion === "string") {
      setSetting("ignoredVersion", body.ignoredVersion);
    } else if (body.ignoredVersion === null) {
      deleteSetting("ignoredVersion");
    }
    return sendJson(res, 200, buildUpdateStatusPayload(cfg));
  }

  return sendError(res, 404, "not_found", `no admin route for ${req.method} ${pathname}`);
}

// Decorate a raw UpdateStatus with method/command (for the "view command"
// modal) and the user's persistent prefs (so the UI can hide banners they
// already dismissed).
function decorateStatus(status: UpdateStatus, _cfg: Config): Record<string, unknown> {
  const method = detectUpdateMethod();
  const disabled = getSetting("updateCheckDisabled") === "1";
  const ignored = getSetting("ignoredVersion");
  const effectivelyDismissed =
    !!status.latest && ignored != null && compareVersions(status.latest, ignored) <= 0;
  return {
    ...status,
    method: method.method,
    command: method.command,
    rootDir: method.rootDir,
    preferences: {
      updateCheckDisabled: disabled,
      ignoredVersion: ignored,
      effectivelyDismissed,
    },
  };
}

function parseCurrentVersion(cfg: Config): string {
  return cfg.userAgent.startsWith("mimo2codex/")
    ? cfg.userAgent.slice("mimo2codex/".length)
    : cfg.userAgent;
}

// Opportunistic background refresh: every GET /update-status (i.e. every
// webui mount + every "Check now" idle poll) sees if the cache is past the
// 6h TTL and, if so, fires a single un-awaited refresh. The current request
// still returns the stale cached value (fast), and the *next* request picks
// up the freshly-written cache. Combined with the frontend's 3-second
// follow-up fetch on mount, a single page refresh surfaces new versions
// within ~3 seconds without ever blocking on the network.
//
// Deduped via `inflightUpdateRefresh` so concurrent webui tabs don't
// stampede the npm registry — at most one in-flight refresh per process.
let inflightUpdateRefresh: Promise<unknown> | null = null;
function maybeKickBackgroundRefresh(cfg: Config): void {
  const dataDir = cfg.dataDir || null;
  if (!dataDir) return;
  const version = parseCurrentVersion(cfg);
  const cached = getCachedStatus({ currentVersion: version, dataDir });
  const stale =
    cached.checkedAt === null || Date.now() - cached.checkedAt >= DEFAULT_TTL_MS;
  if (!stale) return;
  if (inflightUpdateRefresh) return;
  inflightUpdateRefresh = refreshCacheInBackground({
    currentVersion: version,
    dataDir,
  })
    .catch(() => {
      // Network / DNS failures must not break the admin endpoint — the
      // cache just stays stale until the next attempt.
    })
    .finally(() => {
      inflightUpdateRefresh = null;
    });
}

function buildUpdateStatusPayload(cfg: Config): Record<string, unknown> {
  const version = parseCurrentVersion(cfg);
  maybeKickBackgroundRefresh(cfg);
  const status = getCachedStatus({
    currentVersion: version,
    dataDir: cfg.dataDir || null,
  });
  return decorateStatus(status, cfg);
}

// Pull a short, human-readable text snippet out of an upstream chat /
// responses success body. Best-effort: probes mostly care about success/fail,
// but echoing the model's actual greeting confirms the wire is end-to-end.
function extractProbeSample(json: Record<string, unknown>): string | null {
  // Chat completions: choices[0].message.content
  const choices = json.choices as unknown;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    const content = msg?.content;
    if (typeof content === "string") return content.slice(0, 200);
  }
  // Responses API: output[0].content[0].text or output_text shortcut.
  const outputText = json.output_text;
  if (typeof outputText === "string") return outputText.slice(0, 200);
  const output = json.output as unknown;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const text = (c as Record<string, unknown>)?.text;
          if (typeof text === "string") return text.slice(0, 200);
        }
      }
    }
  }
  return null;
}

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(STATIC_ROOT)) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      `Admin UI not built. Expected static bundle at ${STATIC_ROOT}.\n` +
        "Run `npm run web:build` (or `npm run build:all`) to populate dist/web/.\n"
    );
    return;
  }
  // Strip /admin prefix.
  const rel = pathname.replace(/^\/admin\/?/, "") || "index.html";
  const safe = normalize(rel).replace(/^[/\\]+/, "");
  if (safe.includes("..")) {
    res.statusCode = 400;
    res.end("bad path");
    return;
  }
  let filePath = join(STATIC_ROOT, safe);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath)) {
    // SPA fallback
    filePath = join(STATIC_ROOT, "index.html");
    if (!existsSync(filePath)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
  }
  const ct = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", ct);
  // Cache policy:
  //   - /admin/assets/*  →  Vite hashes the filename (index-<hash>.js), so
  //     the content is forever-immutable. Letting the browser cache these
  //     aggressively makes refreshes near-instant.
  //   - Everything else (index.html, favicon.ico, …) must revalidate so a
  //     mimo2codex upgrade actually surfaces the new bundle on next refresh
  //     instead of getting served the previous version from browser cache.
  if (pathname.startsWith("/admin/assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  }
  res.end(readFileSync(filePath));
}

export async function handleAdmin(
  cfg: Config,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext = { user: null, via: "none" }
): Promise<void> {
  const { pathname, query } = parseUrl(req);
  try {
    if (pathname.startsWith("/admin/api/")) {
      await handleApi({ cfg, req, res, pathname, query, auth });
      return;
    }
    if (req.method === "GET" && (pathname === "/admin" || pathname.startsWith("/admin/"))) {
      serveStatic(res, pathname);
      return;
    }
    sendError(res, 404, "not_found", `no admin route for ${req.method} ${pathname}`);
  } catch (err) {
    log.error("admin handler error", { error: (err as Error).message, stack: (err as Error).stack });
    if (!res.headersSent) sendError(res, 500, "internal_error", (err as Error).message);
  }
}

function requireUser(ctx: RouteContext): boolean {
  // Per-user endpoints (BYOK, my-API-keys) only exist when authMode=on AND
  // the caller has a session. In local mode the response makes no sense —
  // there's nothing to scope by.
  if (ctx.cfg.authMode !== "on") {
    sendError(
      ctx.res,
      400,
      "auth_off",
      "this endpoint requires authMode=on (per-user state is not tracked in local mode)"
    );
    return false;
  }
  if (!ctx.auth.user) {
    sendError(ctx.res, 401, "no_session", "session required");
    return false;
  }
  return true;
}

function requireAdmin(ctx: RouteContext): boolean {
  // Admin endpoints are reachable in two modes:
  //   - authMode≠on: no users exist; treat caller as having full access.
  //   - authMode=on: require an authenticated admin user.
  if (ctx.cfg.authMode !== "on") return true;
  if (!ctx.auth.user || ctx.auth.user.is_admin !== 1) {
    sendError(ctx.res, 403, "forbidden", "admin privileges required");
    return false;
  }
  return true;
}

function safeCountUsers(): number {
  try {
    return countUsers();
  } catch {
    return 0;
  }
}

// Snapshot the current ~/.codex/auth.json + config.toml into history as
// `initial`. Called once per user (or once for the shared local timeline)
// before the first apply, so we always have a rollback target representing
// the user's pre-mimo2codex state.
function captureInitialCodexSnapshot(userId: number | null): void {
  const authPath = authJsonPath();
  const tomlPath = configTomlPath();
  const auth = existsSync(authPath) ? readFileSync(authPath, "utf-8") : null;
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf-8") : null;
  // If neither file exists, there's no "original" to preserve — but we still
  // record an empty initial row so subsequent restores have a sentinel that
  // means "remove our writes" (consumers treat empty strings as 'delete').
  appendCodexHistory({
    userId,
    kind: "initial",
    providerId: null,
    modelId: null,
    authJson: auth ?? "",
    configToml: toml ?? "",
    note: "snapshot of pre-existing ~/.codex state",
  });
}
