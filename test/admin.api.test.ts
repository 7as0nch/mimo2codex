import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db/index.js";
import { handleAdmin } from "../src/admin/router.js";
import type { Config } from "../src/config.js";
import { insertLog } from "../src/db/logs.js";

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

  it("GET /admin/api/plugins lists the built-in computer-use plugin", async () => {
    const { status, json } = await call("GET", "/admin/api/plugins");
    expect(status).toBe(200);
    const plugins = (json as { plugins: Array<{ id: string; envKey: string; installed: boolean }> }).plugins;
    expect(plugins.find((p) => p.id === "mimo-computer-use")).toMatchObject({
      envKey: "MIMO2CODEX_PLUGIN",
      installed: true,
    });
  });

  it("PUT /admin/api/plugins/mimo-computer-use hot-writes Codex config when env is unset", async () => {
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    try {
      const enabled = await call("PUT", "/admin/api/plugins/mimo-computer-use", { enabled: true });
      expect(enabled.status).toBe(200);
      const configPath = join(process.env.CODEX_HOME, "config.toml");
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf-8")).toContain("[mcp_servers.mimo-computer-use]");

      const disabled = await call("PUT", "/admin/api/plugins/mimo-computer-use", { enabled: false });
      expect(disabled.status).toBe(200);
      expect(readFileSync(configPath, "utf-8")).not.toContain("[mcp_servers.mimo-computer-use]");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("PUT /admin/api/plugins/mimo-computer-use is locked when MIMO2CODEX_PLUGIN set the env override", async () => {
    cfg.computerUsePluginFromEnv = true;
    try {
      const resp = await call("PUT", "/admin/api/plugins/mimo-computer-use", { enabled: false });
      expect(resp.status).toBe(409);
      expect((resp.json as { error: { code: string } }).error.code).toBe("env_override");
    } finally {
      cfg.computerUsePluginFromEnv = undefined;
    }
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
    expect(models.find((m) => m.upstream_id === "mimo-v2-omni")?.supports_images).toBe(1);
    // pro/flash must remain non-vision
    expect(models.find((m) => m.upstream_id === "mimo-v2.5-pro")?.supports_images).toBe(0);
    expect(models.find((m) => m.upstream_id === "mimo-v2-flash")?.supports_images).toBe(0);
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
