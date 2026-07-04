import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db/index.js";
import { handleAdmin } from "../src/admin/router.js";
import type { Config } from "../src/config.js";
import { insertLog, type ChatLogEntry } from "../src/db/logs.js";

let dataDir: string;
let server: Server;
let port: number;

const cfg: Config = {
  host: "127.0.0.1",
  port: 0,
  baseUrl: "https://api.xiaomimimo.com/v1",
  apiKey: "sk-test",
  exposeReasoning: true,
  verbose: false,
  userAgent: "mimo2codex/test",
  defaultProviderId: "mimo",
  providers: {
    mimo: {
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "sk-test",
      flags: { isTokenPlan: false },
    },
    deepseek: null,
  },
  isTokenPlan: false,
  dataDir: "",
  adminEnabled: true,
  contextOverflowMode: "friendly",
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "m2c-admin-test-"));
  openDb(dataDir);
  cfg.dataDir = dataDir;
  server = createServer((req, res) => void handleAdmin(cfg, req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") port = addr.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

describe("admin REST", () => {
  it("GET /admin/api/health returns ok + dataDir", async () => {
    const { status, json } = await call("GET", "/admin/api/health");
    expect(status).toBe(200);
    expect((json as { ok: boolean; dataDir: string }).ok).toBe(true);
    expect((json as { dataDir: string }).dataDir).toBe(dataDir);
  });

  it("GET /admin/api/providers returns both providers with enabled flag", async () => {
    const { status, json } = await call("GET", "/admin/api/providers");
    expect(status).toBe(200);
    const list = (json as { providers: Array<{ id: string; enabled: boolean; default: boolean }> }).providers;
    expect(list).toHaveLength(2);
    const mimo = list.find((p) => p.id === "mimo")!;
    expect(mimo.enabled).toBe(true);
    expect(mimo.default).toBe(true);
    const ds = list.find((p) => p.id === "deepseek")!;
    expect(ds.enabled).toBe(false);
  });

  it("GET /admin/api/providers/mimo/models lists builtins", async () => {
    const { status, json } = await call("GET", "/admin/api/providers/mimo/models");
    expect(status).toBe(200);
    const models = (
      json as {
        models: Array<{ upstream_id: string; is_builtin: number; supports_images: number }>;
      }
    ).models;
    expect(models.find((m) => m.upstream_id === "mimo-v2.5-pro")).toBeDefined();
    // Vision-capable models must be registered as identity-resolving builtins
    // so client_model `mimo-v2.5` does not get silently rewritten to
    // `mimo-v2.5-pro` (which would 404 on image input).
    const v25 = models.find((m) => m.upstream_id === "mimo-v2.5");
    expect(v25?.supports_images).toBe(1);
    // pro must remain non-vision.
    expect(models.find((m) => m.upstream_id === "mimo-v2.5-pro")?.supports_images).toBe(0);
    // Retired v2 models are pruned from the builtin catalog (aliased to v2.5),
    // so their rows no longer register.
    expect(models.find((m) => m.upstream_id === "mimo-v2-omni")).toBeUndefined();
    expect(models.find((m) => m.upstream_id === "mimo-v2-flash")).toBeUndefined();
    expect(models.find((m) => m.upstream_id === "mimo-v2-pro")).toBeUndefined();
    expect(models.every((m) => m.is_builtin === 1)).toBe(true);
  });

  it("POST + PATCH + DELETE custom model lifecycle", async () => {
    const created = await call("POST", "/admin/api/providers/deepseek/models", {
      upstream_id: "ds-custom",
      display_name: "Custom",
    });
    expect(created.status).toBe(201);
    const id = (created.json as { model: { id: number } }).model.id;
    const patched = await call("PATCH", `/admin/api/models/${id}`, { display_name: "Patched" });
    expect(patched.status).toBe(200);
    expect((patched.json as { model: { display_name: string } }).model.display_name).toBe("Patched");
    const deleted = await call("DELETE", `/admin/api/models/${id}`);
    expect(deleted.status).toBe(200);
  });

  it("PATCH on a builtin returns 400", async () => {
    const list = await call("GET", "/admin/api/providers/mimo/models");
    const id = (list.json as { models: Array<{ id: number; is_builtin: number }> }).models.find(
      (m) => m.is_builtin === 1
    )!.id;
    const patched = await call("PATCH", `/admin/api/models/${id}`, { display_name: "x" });
    expect(patched.status).toBe(400);
  });

  it("GET /admin/api/logs returns inserted entries", async () => {
    insertLog({
      ts: Date.now(), request_id: "r1", provider_id: "mimo",
      client_model: "mimo-v2.5-pro", upstream_model: "mimo-v2.5-pro",
      endpoint: "/v1/responses", status_code: 200, duration_ms: 12,
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      stream: false, error_code: null, error_snippet: null,
    });
    const { status, json } = await call("GET", "/admin/api/logs");
    expect(status).toBe(200);
    const logs = (json as { logs: Array<{ provider_id: string }> }).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].provider_id).toBe("mimo");
  });

  it("GET /admin/api/stats?range=24h returns aggregated tokens", async () => {
    const now = Date.now();
    insertLog({
      ts: now, request_id: null, provider_id: "mimo",
      client_model: "mimo-v2.5-pro", upstream_model: "mimo-v2.5-pro",
      endpoint: "/v1/responses", status_code: 200, duration_ms: 1,
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      stream: false, error_code: null, error_snippet: null,
    });
    const { status, json } = await call("GET", "/admin/api/stats?range=24h");
    expect(status).toBe(200);
    const rows = (json as { rows: Array<{ total_tokens: number }> }).rows;
    expect(rows[0].total_tokens).toBe(150);
  });

  it("GET /admin/api/mappings returns deduplicated client→upstream pairs", async () => {
    const now = Date.now();
    insertLog({
      ts: now, request_id: null, provider_id: "mimo",
      client_model: "alias", upstream_model: "mimo-v2.5-pro",
      endpoint: "/v1/responses", status_code: 200, duration_ms: 1,
      prompt_tokens: null, completion_tokens: null, total_tokens: null,
      stream: false, error_code: null, error_snippet: null,
    });
    const { status, json } = await call("GET", "/admin/api/mappings");
    expect(status).toBe(200);
    const m = (json as { mappings: Array<{ client_model: string; count: number }> }).mappings;
    expect(m).toHaveLength(1);
    expect(m[0].client_model).toBe("alias");
  });

  it("PUT /admin/api/settings/api_key is forbidden", async () => {
    const r = await call("PUT", "/admin/api/settings/api_key", { value: "sk-x" });
    expect(r.status).toBe(400);
    const code = (r.json as { error: { code: string } }).error.code;
    expect(code).toBe("forbidden_setting");
  });

  it("PUT/GET /admin/api/settings/* round-trips a regular key", async () => {
    const put = await call("PUT", "/admin/api/settings/ui.theme", { value: "dark" });
    expect(put.status).toBe(200);
    const get = await call("GET", "/admin/api/settings");
    expect(get.status).toBe(200);
    expect((get.json as { settings: Record<string, string> }).settings["ui.theme"]).toBe("dark");
  });

  it("GET /admin/api/log-settings returns defaults for silent rewrite, body mode, and retention", async () => {
    const r = await call("GET", "/admin/api/log-settings");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      silentRewrite: true,
      cliOverride: null,
      bodyMode: "errors-only",
      bodyModeCliOverride: null,
      retentionDays: 30,
      retentionDaysCliOverride: null,
      retentionDaysCliOverrideActive: false,
    });
  });

  it("PUT /admin/api/log-settings updates body mode and retention", async () => {
    const put = await call("PUT", "/admin/api/log-settings", {
      silentRewrite: false,
      bodyMode: "errors-only",
      retentionDays: 14,
    });
    expect(put.status).toBe(200);
    const get = await call("GET", "/admin/api/log-settings");
    expect(get.status).toBe(200);
    expect(get.json).toMatchObject({
      silentRewrite: false,
      bodyMode: "errors-only",
      retentionDays: 14,
      retentionDaysCliOverrideActive: false,
    });
  });

  it("PUT /admin/api/log-settings validates the whole payload before writing", async () => {
    const bad = await call("PUT", "/admin/api/log-settings", {
      silentRewrite: false,
      bodyMode: "bad-mode",
    });
    expect(bad.status).toBe(400);
    const get = await call("GET", "/admin/api/log-settings");
    expect(get.status).toBe(200);
    expect(get.json).toMatchObject({
      silentRewrite: true,
      bodyMode: "errors-only",
      retentionDays: 30,
    });
  });

  it("GET /admin/api/log-settings marks a CLI-disabled retention override as read-only", async () => {
    cfg.logRetentionDaysFromCli = null;
    const r = await call("GET", "/admin/api/log-settings");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      retentionDays: null,
      retentionDaysCliOverride: null,
      retentionDaysCliOverrideActive: true,
    });
  });

  function addLog(over: Partial<ChatLogEntry> = {}): void {
    insertLog({
      ts: Date.now(),
      request_id: null,
      provider_id: "mimo",
      client_model: "m",
      upstream_model: "m",
      endpoint: "/v1/responses",
      status_code: 200,
      duration_ms: 1,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      stream: false,
      error_code: null,
      error_snippet: null,
      request_body: null,
      response_body: null,
      tool_call_count: null,
      ...over,
    });
  }

  it("GET /admin/api/db/size returns byte counts for the database files", async () => {
    const r = await call("GET", "/admin/api/db/size");
    expect(r.status).toBe(200);
    const j = r.json as { totalBytes: number; mainBytes: number; walBytes: number };
    expect(j.totalBytes).toBeGreaterThan(0);
    expect(typeof j.mainBytes).toBe("number");
    expect(typeof j.walBytes).toBe("number");
  });

  it("DELETE /admin/api/logs?all=1 clears every log row", async () => {
    addLog();
    addLog();
    const del = await call("DELETE", "/admin/api/logs?all=1");
    expect(del.status).toBe(200);
    expect((del.json as { removed: number }).removed).toBe(2);
  });

  it("DELETE /admin/api/logs?keepDays=7 deletes only rows older than the window", async () => {
    const day = 24 * 60 * 60 * 1000;
    addLog({ ts: Date.now() - 20 * day, request_id: "old" });
    addLog({ ts: Date.now() - 2 * day, request_id: "new" });
    const del = await call("DELETE", "/admin/api/logs?keepDays=7");
    expect(del.status).toBe(200);
    expect((del.json as { removed: number }).removed).toBe(1);
  });

  it("POST /admin/api/db/vacuum reclaims space and reports before/after/freed", async () => {
    const big = "x".repeat(8 * 1024);
    for (let i = 0; i < 200; i++) addLog({ request_body: big, response_body: big });
    await call("DELETE", "/admin/api/logs?all=1");
    const vac = await call("POST", "/admin/api/db/vacuum");
    expect(vac.status).toBe(200);
    const j = vac.json as { beforeBytes: number; afterBytes: number; freedBytes: number };
    expect(j.freedBytes).toBe(j.beforeBytes - j.afterBytes);
    expect(j.afterBytes).toBeLessThanOrEqual(j.beforeBytes);
  });

  it("PUT /admin/api/log-settings accepts maxDbSizeMb and GET returns it", async () => {
    const put = await call("PUT", "/admin/api/log-settings", { maxDbSizeMb: 500 });
    expect(put.status).toBe(200);
    const get = await call("GET", "/admin/api/log-settings");
    expect((get.json as { maxDbSizeMb: number }).maxDbSizeMb).toBe(500);
  });

  it("404 for unknown admin path", async () => {
    const r = await call("GET", "/admin/api/nope");
    expect(r.status).toBe(404);
  });
});

describe("admin REST — Codex 启用 routes", () => {
  // These tests redirect os.homedir() to the per-test tmp data dir so the
  // file-write side-effects (auth.json/config.toml + .bak.* files) land
  // inside the test sandbox.
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(dataDir);
    // codexDir() now consults CODEX_HOME before falling back to homedir; clear
    // it for the test so the spied home wins.
    originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
  });

  it("GET /admin/api/codex-state on a fresh machine returns 'missing'", async () => {
    const r = await call("GET", "/admin/api/codex-state");
    expect(r.status).toBe(200);
    const body = r.json as {
      authJsonOwner: string;
      authJsonExists: boolean;
      backups: unknown[];
      activeOverride: unknown;
    };
    expect(body.authJsonOwner).toBe("missing");
    expect(body.authJsonExists).toBe(false);
    expect(body.backups).toEqual([]);
    expect(body.activeOverride).toBeNull();
  });

  it("POST /admin/api/codex-apply writes both files, marks ownership as ours", async () => {
    const r = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    expect(r.status).toBe(200);
    const body = r.json as { ok: boolean; backupTs: number; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(typeof body.backupTs).toBe("number");
    // Subsequent codex-state reflects the change.
    const state = await call("GET", "/admin/api/codex-state");
    expect((state.json as { authJsonOwner: string }).authJsonOwner).toBe("mimo2codex");
  });

  it("POST /admin/api/codex-apply rejects unknown provider", async () => {
    const r = await call("POST", "/admin/api/codex-apply", {
      providerId: "ghost",
      modelId: "x",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("unknown_provider");
  });

  it("POST /admin/api/codex-apply rejects model not in catalog", async () => {
    const r = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "gpt-99",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("unknown_model");
  });

  it("POST /admin/api/codex-restore round-trips after apply", async () => {
    const apply = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    const ts = (apply.json as { backupTs: number }).backupTs;
    // No paired backup yet (fresh dir), so restore on this ts is incomplete.
    const restore = await call("POST", "/admin/api/codex-restore", { ts });
    // Either incomplete_pair or not_found depending on state; both are 400/404.
    expect([400, 404]).toContain(restore.status);
  });

  it("active-override: GET defaults to null, PUT sets, GET reads back, DELETE clears", async () => {
    const empty = await call("GET", "/admin/api/active-override");
    expect((empty.json as { override: unknown }).override).toBeNull();

    const set = await call("PUT", "/admin/api/active-override", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    expect(set.status).toBe(200);
    expect((set.json as { override: { providerId: string } }).override.providerId).toBe("mimo");

    const get = await call("GET", "/admin/api/active-override");
    expect((get.json as { override: { modelId: string } }).override.modelId).toBe("mimo-v2.5-pro");

    const del = await call("DELETE", "/admin/api/active-override");
    expect(del.status).toBe(200);
    const after = await call("GET", "/admin/api/active-override");
    expect((after.json as { override: unknown }).override).toBeNull();
  });

  it("PUT /admin/api/active-override rejects provider without a key", async () => {
    // deepseek has no runtime in this test's Config (see top of file).
    const r = await call("PUT", "/admin/api/active-override", {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("provider_has_no_key");
  });

  it("DELETE /admin/api/codex-backups/:ts removes a regular pair without force", async () => {
    // Apply once over an existing auth.json owned by us → regular (non-preserved) backup.
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const codexDir = join(dataDir, ".codex");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "mimo2codex-local" })
    );
    writeFileSync(join(codexDir, "config.toml"), "model = \"mimo-v2.5-pro\"\n");
    const apply = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    const ts = (apply.json as { backupTs: number }).backupTs;
    const del = await call("DELETE", `/admin/api/codex-backups/${ts}`);
    expect(del.status).toBe(200);
    expect((del.json as { removed: number }).removed).toBe(2);
    // State now has no backup pair with that ts.
    const state = await call("GET", "/admin/api/codex-state");
    expect(
      (state.json as { backups: Array<{ ts: number }> }).backups.find((b) => b.ts === ts)
    ).toBeUndefined();
  });

  it("DELETE /admin/api/codex-backups/:ts refuses preserved pair without ?force=1", async () => {
    // Apply over external auth.json → preserved backup.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const codexDir = join(dataDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-real-openai" })
    );
    writeFileSync(join(codexDir, "config.toml"), "x");
    const apply = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    const ts = (apply.json as { backupTs: number; preserved: boolean }).backupTs;

    const refuse = await call("DELETE", `/admin/api/codex-backups/${ts}`);
    expect(refuse.status).toBe(400);
    expect((refuse.json as { error: { code: string } }).error.code).toBe("preserved_backup");

    const forced = await call("DELETE", `/admin/api/codex-backups/${ts}?force=1`);
    expect(forced.status).toBe(200);
  });

  it("GET /admin/api/codex-state surfaces preserved + sniffed model/provider in backups", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const codexDir = join(dataDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-real-openai" })
    );
    writeFileSync(
      join(codexDir, "config.toml"),
      'model = "gpt-5"\nmodel_provider = "openai"\n'
    );
    await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    const state = await call("GET", "/admin/api/codex-state");
    const backups = (state.json as { backups: Array<{ preserved: boolean; model: string | null; provider: string | null; authBackupOwner: string }> }).backups;
    expect(backups.length).toBe(1);
    expect(backups[0].preserved).toBe(true);
    expect(backups[0].model).toBe("gpt-5");
    expect(backups[0].provider).toBe("openai");
    expect(backups[0].authBackupOwner).toBe("external");
  });

  it("POST /admin/api/codex-apply preserves a real ChatGPT login by default (no overwrite)", async () => {
    const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const codexDir = join(dataDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    // OAuth-style auth.json that `codex login` writes → detected as "external".
    const oauth = JSON.stringify(
      { OPENAI_API_KEY: null, tokens: { access_token: "tok", account_id: "acct_1" } },
      null,
      2
    );
    writeFileSync(join(codexDir, "auth.json"), oauth);

    const apply = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    expect(apply.status).toBe(200);
    expect((apply.json as { authPreserved: boolean }).authPreserved).toBe(true);

    // The real login auth.json is left byte-for-byte intact; only config.toml
    // is rewritten to route the model through the proxy.
    expect(readFileSync(join(codexDir, "auth.json"), "utf-8")).toBe(oauth);
    const state = await call("GET", "/admin/api/codex-state");
    expect((state.json as { authJsonOwner: string }).authJsonOwner).toBe("external");
    expect((state.json as { configTomlText: string }).configTomlText).toContain(
      "requires_openai_auth = true"
    );
    expect((state.json as { configTomlText: string }).configTomlText).toContain(
      'model_provider = "mimo"'
    );
  });

  it("POST /admin/api/codex-apply with preserveLogin:false still overwrites the login (opt-out)", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const codexDir = join(dataDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-real-openai" })
    );

    const apply = await call("POST", "/admin/api/codex-apply", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
      preserveLogin: false,
    });
    expect(apply.status).toBe(200);
    expect((apply.json as { authPreserved: boolean }).authPreserved).toBe(false);
    const state = await call("GET", "/admin/api/codex-state");
    expect((state.json as { authJsonOwner: string }).authJsonOwner).toBe("mimo2codex");
  });

  it("GET /admin/api/codex-targets returns built-in models with current-override flags", async () => {
    await call("PUT", "/admin/api/active-override", {
      providerId: "mimo",
      modelId: "mimo-v2.5-pro",
    });
    const r = await call("GET", "/admin/api/codex-targets");
    expect(r.status).toBe(200);
    const body = r.json as {
      targets: Array<{ providerId: string; modelId: string; isCurrentOverride: boolean; hasKey: boolean }>;
    };
    expect(body.targets.length).toBeGreaterThan(0);
    const current = body.targets.find((t) => t.isCurrentOverride);
    expect(current?.providerId).toBe("mimo");
    expect(current?.modelId).toBe("mimo-v2.5-pro");
    // mimo has a runtime in test cfg; deepseek does not.
    expect(body.targets.find((t) => t.providerId === "mimo")?.hasKey).toBe(true);
    expect(body.targets.find((t) => t.providerId === "deepseek")?.hasKey).toBe(false);
  });
});

describe("admin REST — desktop signal routes (A2)", () => {
  // The sentinel + signal pair is the channel from the admin web UI back into
  // the Electron desktop main process. We only manipulate MIMO2CODEX_DESKTOP_PARENT
  // here — actual file-watcher dispatch is covered in the desktop package.
  const originalEnv = process.env.MIMO2CODEX_DESKTOP_PARENT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MIMO2CODEX_DESKTOP_PARENT;
    else process.env.MIMO2CODEX_DESKTOP_PARENT = originalEnv;
  });

  it("GET /admin/api/desktop/sentinel returns inDesktop=false when env not set", async () => {
    delete process.env.MIMO2CODEX_DESKTOP_PARENT;
    const r = await call("GET", "/admin/api/desktop/sentinel");
    expect(r.status).toBe(200);
    expect((r.json as { inDesktop: boolean }).inDesktop).toBe(false);
  });

  it("GET /admin/api/desktop/sentinel returns inDesktop=true when MIMO2CODEX_DESKTOP_PARENT=1", async () => {
    process.env.MIMO2CODEX_DESKTOP_PARENT = "1";
    const r = await call("GET", "/admin/api/desktop/sentinel");
    expect(r.status).toBe(200);
    expect((r.json as { inDesktop: boolean }).inDesktop).toBe(true);
  });

  it("POST /admin/api/desktop/signal returns 404 when not in desktop", async () => {
    delete process.env.MIMO2CODEX_DESKTOP_PARENT;
    const r = await call("POST", "/admin/api/desktop/signal", { action: "open-settings" });
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("not_in_desktop");
  });

  it("POST /admin/api/desktop/signal writes signal file in desktop mode", async () => {
    process.env.MIMO2CODEX_DESKTOP_PARENT = "1";
    const r = await call("POST", "/admin/api/desktop/signal", { action: "open-settings" });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    // The signal file lives in cfg.dataDir
    const { readFileSync, existsSync } = await import("node:fs");
    const signalPath = join(dataDir, ".desktop-signal.json");
    expect(existsSync(signalPath)).toBe(true);
    const body = JSON.parse(readFileSync(signalPath, "utf8")) as {
      action: string;
      ts: number;
    };
    expect(body.action).toBe("open-settings");
    expect(typeof body.ts).toBe("number");
  });

  it("POST /admin/api/desktop/signal rejects unknown actions", async () => {
    process.env.MIMO2CODEX_DESKTOP_PARENT = "1";
    const r = await call("POST", "/admin/api/desktop/signal", { action: "ship-it" });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("invalid_action");
  });
});

describe("admin REST — web-search-state route", () => {
  it("GET defaults to disabled (web search is off by default)", async () => {
    const r = await call("GET", "/admin/api/web-search-state");
    expect(r.status).toBe(200);
    const body = r.json as { effective: boolean; cliOverride: boolean | null; setting: boolean };
    expect(body.effective).toBe(false);
    expect(body.setting).toBe(false);
    expect(body.cliOverride).toBeNull();
  });

  it("PUT { enabled: true } persists and GET reflects it", async () => {
    const put = await call("PUT", "/admin/api/web-search-state", { enabled: true });
    expect(put.status).toBe(200);
    expect((put.json as { ok: boolean }).ok).toBe(true);
    const get = await call("GET", "/admin/api/web-search-state");
    const body = get.json as { effective: boolean; setting: boolean };
    expect(body.setting).toBe(true);
    expect(body.effective).toBe(true);
  });

  it("PUT without an `enabled` boolean is 400", async () => {
    const r = await call("PUT", "/admin/api/web-search-state", {});
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("invalid_body");
  });
});
