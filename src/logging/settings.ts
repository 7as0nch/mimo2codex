import type { Config } from "../config.js";
import { deleteLogsBefore } from "../db/logs.js";
import { getSetting } from "../db/settings.js";

export type LogBodyMode = "full" | "errors-only" | "off";

export interface LogBodies {
  requestBody: string | null;
  responseBody: string | null;
}

const VALID_BODY_MODES = new Set<LogBodyMode>(["full", "errors-only", "off"]);

export function parseLogBodyMode(raw: string | null | undefined): LogBodyMode | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return VALID_BODY_MODES.has(normalized as LogBodyMode)
    ? (normalized as LogBodyMode)
    : null;
}

export function parseLogRetentionDays(raw: string | null | undefined): number | null | undefined {
  if (raw == null) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized === "0" || normalized === "off" || normalized === "false") return null;
  const n = Number(normalized);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export function resolveLogBodyMode(cfg: Config): LogBodyMode {
  if (cfg.logBodyModeFromCli) return cfg.logBodyModeFromCli;
  try {
    return parseLogBodyMode(getSetting("logging.bodyMode")) ?? "full";
  } catch {
    return "full";
  }
}

export function resolveLogRetentionDays(cfg: Config): number | null {
  if (cfg.logRetentionDaysFromCli !== undefined) return cfg.logRetentionDaysFromCli;
  try {
    return parseLogRetentionDays(getSetting("logging.retentionDays")) ?? null;
  } catch {
    return null;
  }
}

export function applyLogBodyMode(
  mode: LogBodyMode,
  statusCode: number,
  bodies: LogBodies
): LogBodies {
  if (mode === "off") return { requestBody: null, responseBody: null };
  if (mode === "errors-only" && statusCode < 400) {
    return { requestBody: null, responseBody: null };
  }
  return bodies;
}

export function runLogMaintenance(
  cfg: Config,
  now = Date.now()
): { retentionDays: number | null; removed: number } {
  const retentionDays = resolveLogRetentionDays(cfg);
  if (!cfg.adminEnabled || retentionDays === null) {
    return { retentionDays, removed: 0 };
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return {
    retentionDays,
    removed: deleteLogsBefore(cutoff),
  };
}
