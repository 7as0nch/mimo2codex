import Database from "better-sqlite3";
import { join } from "node:path";
import { MIGRATIONS } from "./schema.js";
import { PROVIDER_LIST } from "../providers/registry.js";
import { log } from "../util/log.js";

export type DB = Database.Database;

let instance: DB | null = null;
let instancePath: string | null = null;

export function openDb(dataDir: string): DB {
  const dbPath = join(dataDir, "data.db");
  if (instance && instancePath === dbPath) return instance;
  if (instance) {
    instance.close();
    instance = null;
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  seedBuiltins(db);
  instance = db;
  instancePath = dbPath;
  log.debug(`sqlite opened at ${dbPath}`);
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
    instancePath = null;
  }
}

export function getDb(): DB {
  if (!instance) {
    throw new Error("db not opened — call openDb(dataDir) before getDb()");
  }
  return instance;
}

function applyMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      m.version,
      Date.now()
    );
    log.debug(`applied schema migration v${m.version}`);
  }
}

// Drop providers whose shortcut already appeared (first writer wins). The
// providers.shortcut column is UNIQUE, so a dirty providers.json carrying a
// duplicate shortcut would otherwise crash the whole seed transaction with
// "UNIQUE constraint failed: providers.shortcut" — which the cli.ts catch then
// turns into a disabled admin (/admin/ 404). Skipping the offender keeps admin
// alive so the user can fix it. Exported for testing. (issue #63)
export function dedupeProvidersByShortcut<T extends { id: string; shortcut: string }>(
  list: readonly T[]
): { kept: T[]; skipped: Array<{ provider: T; conflictsWith: string }> } {
  const byShortcut = new Map<string, T>();
  const kept: T[] = [];
  const skipped: Array<{ provider: T; conflictsWith: string }> = [];
  for (const p of list) {
    const existing = byShortcut.get(p.shortcut);
    if (existing) {
      skipped.push({ provider: p, conflictsWith: existing.id });
    } else {
      byShortcut.set(p.shortcut, p);
      kept.push(p);
    }
  }
  return { kept, skipped };
}

function seedBuiltins(db: DB): void {
  // Provider rows sync source-of-truth fields on every boot — display_name,
  // base_url, default_model and api_key_env are runtime-essential, so the DB
  // never lags behind code changes (e.g. a base_url switch in mimo.ts must
  // take effect on the next start without manual DB intervention).
  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, shortcut, display_name, base_url, default_model, api_key_env, updated_at)
    VALUES (@id, @shortcut, @display_name, @base_url, @default_model, @api_key_env, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      shortcut = excluded.shortcut,
      display_name = excluded.display_name,
      base_url = excluded.base_url,
      default_model = excluded.default_model,
      api_key_env = excluded.api_key_env,
      updated_at = excluded.updated_at
  `);
  // Builtin model rows likewise track source on each boot. The UI refuses to
  // edit builtin rows (patchModel guard), so there's no user state to preserve
  // here — capabilities, context window and display name all come from the
  // provider declaration in providers/*.ts.
  const upsertModel = db.prepare(`
    INSERT INTO models (
      provider_id, upstream_id, display_name,
      supports_images, supports_reasoning, supports_web_search,
      context_window, is_builtin, deprecated_after, sort_order
    ) VALUES (
      @provider_id, @upstream_id, @display_name,
      @supports_images, @supports_reasoning, @supports_web_search,
      @context_window, 1, @deprecated_after, @sort_order
    )
    ON CONFLICT(provider_id, upstream_id) DO UPDATE SET
      display_name = excluded.display_name,
      supports_images = excluded.supports_images,
      supports_reasoning = excluded.supports_reasoning,
      supports_web_search = excluded.supports_web_search,
      context_window = excluded.context_window,
      is_builtin = 1,
      deprecated_after = excluded.deprecated_after,
      sort_order = excluded.sort_order
  `);
  // Drop builtin rows whose upstream_id has been removed from source. This
  // is what prunes legacy seeds like the old "mimo-v2.5-pro[1m]" variant
  // after we consolidated the catalog. User-created custom models
  // (is_builtin=0) are never touched here.
  const pruneStale = db.prepare(
    `DELETE FROM models
     WHERE provider_id = @provider_id
       AND is_builtin = 1
       AND upstream_id NOT IN (SELECT value FROM json_each(@keep_json))`
  );

  const now = Date.now();
  const { kept, skipped } = dedupeProvidersByShortcut(PROVIDER_LIST);
  for (const s of skipped) {
    log.warn(
      `provider "${s.provider.id}" skipped during DB seed: shortcut "${s.provider.shortcut}" ` +
        `already used by "${s.conflictsWith}" — give it a unique shortcut in providers.json`
    );
  }
  const tx = db.transaction(() => {
    for (const p of kept) {
      upsertProvider.run({
        id: p.id,
        shortcut: p.shortcut,
        display_name: p.displayName,
        base_url: p.defaultBaseUrl,
        default_model: p.defaultModel,
        api_key_env: p.envKeys.join(","),
        updated_at: now,
      });
      const keep: string[] = [];
      let order = 0;
      for (const m of p.builtinModels) {
        keep.push(m.id);
        upsertModel.run({
          provider_id: p.id,
          upstream_id: m.id,
          display_name: m.displayName ?? null,
          supports_images: m.supportsImages ? 1 : 0,
          supports_reasoning: m.supportsReasoning ? 1 : 0,
          supports_web_search: m.supportsWebSearch ? 1 : 0,
          context_window: m.contextWindow ?? null,
          deprecated_after: m.deprecatedAfter ?? null,
          sort_order: order++,
        });
      }
      pruneStale.run({ provider_id: p.id, keep_json: JSON.stringify(keep) });
    }
  });
  tx();
}
