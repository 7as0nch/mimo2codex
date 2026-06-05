import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, openDb } from "../src/db/index.js";
import { insertLog, queryLogs } from "../src/db/logs.js";
import type { Config } from "../src/config.js";
import {
  applyLogBodyMode,
  resolveLogBodyMode,
  resolveLogRetentionDays,
  runLogMaintenance,
} from "../src/logging/settings.js";
import { setSetting } from "../src/db/settings.js";

let dataDir: string;

const cfg: Config = {
  host: "127.0.0.1",
  port: 8788,
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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "m2c-log-settings-"));
  openDb(dataDir);
  cfg.dataDir = dataDir;
  cfg.logBodyModeFromCli = undefined;
  cfg.logRetentionDaysFromCli = undefined;
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("logging settings", () => {
  it("defaults to full body capture and no retention window", () => {
    expect(resolveLogBodyMode(cfg)).toBe("full");
    expect(resolveLogRetentionDays(cfg)).toBeNull();
  });

  it("uses settings values when no env override is present", () => {
    setSetting("logging.bodyMode", "errors-only");
    setSetting("logging.retentionDays", "14");
    expect(resolveLogBodyMode(cfg)).toBe("errors-only");
    expect(resolveLogRetentionDays(cfg)).toBe(14);
  });

  it("env overrides win over settings for body mode and retention", () => {
    setSetting("logging.bodyMode", "off");
    setSetting("logging.retentionDays", "30");
    cfg.logBodyModeFromCli = "full";
    cfg.logRetentionDaysFromCli = 7;
    expect(resolveLogBodyMode(cfg)).toBe("full");
    expect(resolveLogRetentionDays(cfg)).toBe(7);
  });

  it("errors-only keeps bodies for failures and strips them for success", () => {
    expect(
      applyLogBodyMode("errors-only", 200, { requestBody: '{"a":1}', responseBody: '{"b":2}' })
    ).toEqual({
      requestBody: null,
      responseBody: null,
    });
    expect(
      applyLogBodyMode("errors-only", 502, { requestBody: '{"a":1}', responseBody: '{"b":2}' })
    ).toEqual({
      requestBody: '{"a":1}',
      responseBody: '{"b":2}',
    });
  });

  it("off strips bodies regardless of status code", () => {
    expect(
      applyLogBodyMode("off", 500, { requestBody: '{"a":1}', responseBody: '{"b":2}' })
    ).toEqual({
      requestBody: null,
      responseBody: null,
    });
  });

  it("maintenance run deletes logs older than configured retention", () => {
    const now = Date.UTC(2026, 4, 30);
    insertLog({
      ts: now - 20 * 24 * 60 * 60 * 1000,
      request_id: "old",
      provider_id: "mimo",
      client_model: "mimo-v2.5-pro",
      upstream_model: "mimo-v2.5-pro",
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
    });
    insertLog({
      ts: now - 2 * 24 * 60 * 60 * 1000,
      request_id: "new",
      provider_id: "mimo",
      client_model: "mimo-v2.5-pro",
      upstream_model: "mimo-v2.5-pro",
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
    });
    setSetting("logging.retentionDays", "7");

    const result = runLogMaintenance(cfg, now);

    expect(result).toEqual({ retentionDays: 7, removed: 1 });
    expect(queryLogs({ limit: 10 }).map((row) => row.request_id)).toEqual(["new"]);
  });
});
