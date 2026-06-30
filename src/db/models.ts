import { getDb } from "./index.js";
import type { ProviderId } from "../providers/types.js";

export interface ModelRow {
  id: number;
  provider_id: string;
  upstream_id: string;
  display_name: string | null;
  supports_images: number;
  supports_reasoning: number;
  supports_web_search: number;
  context_window: number | null;
  is_builtin: number;
  deprecated_after: string | null;
  reasoning_effort: string | null;
  sort_order: number;
}

export function listModels(providerId?: ProviderId): ModelRow[] {
  if (providerId) {
    return getDb()
      .prepare("SELECT * FROM models WHERE provider_id = ? ORDER BY sort_order, upstream_id")
      .all(providerId) as ModelRow[];
  }
  return getDb()
    .prepare("SELECT * FROM models ORDER BY provider_id, sort_order, upstream_id")
    .all() as ModelRow[];
}

export function getModelById(id: number): ModelRow | null {
  return (getDb().prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined) ?? null;
}

export interface ModelInput {
  upstream_id: string;
  display_name?: string | null;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  supports_web_search?: boolean;
  context_window?: number | null;
  deprecated_after?: string | null;
  reasoning_effort?: string | null;
  sort_order?: number;
}

export function insertCustomModel(providerId: ProviderId, input: ModelInput): ModelRow {
  const info = getDb()
    .prepare(
      `INSERT INTO models (
        provider_id, upstream_id, display_name,
        supports_images, supports_reasoning, supports_web_search,
        context_window, is_builtin, deprecated_after, reasoning_effort, sort_order
      ) VALUES (
        @provider_id, @upstream_id, @display_name,
        @supports_images, @supports_reasoning, @supports_web_search,
        @context_window, 0, @deprecated_after, @reasoning_effort, @sort_order
      )`
    )
    .run({
      provider_id: providerId,
      upstream_id: input.upstream_id,
      display_name: input.display_name ?? null,
      supports_images: input.supports_images ? 1 : 0,
      supports_reasoning: input.supports_reasoning ? 1 : 0,
      supports_web_search: input.supports_web_search ? 1 : 0,
      context_window: input.context_window ?? null,
      deprecated_after: input.deprecated_after ?? null,
      reasoning_effort: input.reasoning_effort ?? null,
      sort_order: input.sort_order ?? 100,
    });
  return getModelById(Number(info.lastInsertRowid))!;
}

export function patchModel(id: number, patch: Partial<ModelInput>): ModelRow | null {
  const existing = getModelById(id);
  if (!existing) return null;
  if (existing.is_builtin) {
    throw new Error("builtin models cannot be modified — add a custom model instead");
  }
  const merged = {
    upstream_id: patch.upstream_id ?? existing.upstream_id,
    display_name: patch.display_name === undefined ? existing.display_name : patch.display_name,
    supports_images:
      patch.supports_images === undefined
        ? existing.supports_images
        : patch.supports_images
          ? 1
          : 0,
    supports_reasoning:
      patch.supports_reasoning === undefined
        ? existing.supports_reasoning
        : patch.supports_reasoning
          ? 1
          : 0,
    supports_web_search:
      patch.supports_web_search === undefined
        ? existing.supports_web_search
        : patch.supports_web_search
          ? 1
          : 0,
    context_window:
      patch.context_window === undefined ? existing.context_window : patch.context_window,
    deprecated_after:
      patch.deprecated_after === undefined ? existing.deprecated_after : patch.deprecated_after,
    reasoning_effort:
      patch.reasoning_effort === undefined ? existing.reasoning_effort : patch.reasoning_effort,
    sort_order: patch.sort_order ?? existing.sort_order,
  };
  getDb()
    .prepare(
      `UPDATE models SET
        upstream_id = @upstream_id,
        display_name = @display_name,
        supports_images = @supports_images,
        supports_reasoning = @supports_reasoning,
        supports_web_search = @supports_web_search,
        context_window = @context_window,
        deprecated_after = @deprecated_after,
        reasoning_effort = @reasoning_effort,
        sort_order = @sort_order
      WHERE id = @id`
    )
    .run({ ...merged, id });
  return getModelById(id);
}

export function deleteModel(id: number): boolean {
  const existing = getModelById(id);
  if (!existing) return false;
  if (existing.is_builtin) {
    throw new Error("builtin models cannot be deleted");
  }
  const info = getDb().prepare("DELETE FROM models WHERE id = ?").run(id);
  return info.changes > 0;
}

