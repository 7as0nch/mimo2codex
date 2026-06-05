import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { respToResponses } from "./translate/respToResponses.js";
import { pipeChatStreamToResponses, type StreamPipelineResult } from "./translate/streamToSse.js";
import { iterChatStreamChunks } from "./upstream/chatStream.js";
import {
  callOpenAICompat,
  callResponsesPassthrough,
  UpstreamError,
} from "./upstream/openaiCompatClient.js";
import { BUILTIN_PROVIDERS, PROVIDER_LIST, PROVIDERS } from "./providers/registry.js";
import type { Provider, ProviderModel, ProviderRuntime } from "./providers/types.js";
import { makeServerResponseSink } from "./util/sse.js";
import { log } from "./util/log.js";
import type { ChatRequest, ChatResponse, ChatUsage, ResponsesRequest } from "./translate/types.js";
import { handleAdmin } from "./admin/router.js";
import { authGuard } from "./auth/middleware.js";
import { resolveRuntimeForUser } from "./auth/byok.js";
import { handleOAuthRoutes } from "./auth/oauthRoutes.js";
import type { UserRow } from "./db/users.js";
import { insertLog, type ChatLogEntry } from "./db/logs.js";
import { getActiveOverride, type ActiveOverride } from "./db/overrides.js";
import { getSetting } from "./db/settings.js";
import { applyLogBodyMode, resolveLogBodyMode, runLogMaintenance } from "./logging/settings.js";
import { redactSensitive } from "./util/redact.js";
import { isMaintenance, getMaintenanceMessage } from "./util/maintenance.js";

// Wraps getActiveOverride() so the per-request DB lookup is safe when:
//   - admin is disabled (no DB open → getDb() would throw),
//   - the settings table is missing for any reason,
//   - the rows have been deleted concurrently.
// Returns null in every error path; selectProvider treats null as "no override".
function readActiveOverrideSafely(cfg: Config): ActiveOverride | null {
  if (!cfg.adminEnabled) return null;
  try {
    return getActiveOverride();
  } catch {
    return null;
  }
}

// disableThinking 三段解析：CLI/env (cfg.disableThinkingFromCli) > admin settings DB > false。
// CLI 显式设了 true/false 都尊重；CLI 没设时查 settings.thinking.disabled（"1"=开）。
// 每个请求开始时调一次，让 admin UI 修改 settings 后**无需重启**立刻生效。
function resolveDisableThinking(cfg: Config): boolean {
  if (cfg.disableThinkingFromCli !== undefined) return cfg.disableThinkingFromCli;
  if (!cfg.adminEnabled) return false;
  try {
    return getSetting("thinking.disabled") === "1";
  } catch {
    return false;
  }
}

// forceHighEffort 解析：admin settings DB → false。当前没暴露 CLI flag（如有需求再加）。
// 与 disableThinking 不同维度：disableThinking=true 时本开关被忽略。
function resolveForceHighEffort(cfg: Config): boolean {
  if (!cfg.adminEnabled) return false;
  try {
    return getSetting("thinking.forceHighEffort") === "1";
  } catch {
    return false;
  }
}

// silentRewrite 解析：env (cfg.silentRewriteFromCli) > admin settings DB > true。
// 注意默认是 **静默**（true）—— admin UI 顶部「更多」里有快速开关。每请求调一次，
// admin 改了立即生效，无需重启。
function resolveSilentRewrite(cfg: Config): boolean {
  if (cfg.silentRewriteFromCli !== undefined) return cfg.silentRewriteFromCli;
  if (!cfg.adminEnabled) return true;
  try {
    const s = getSetting("logging.silentRewrite");
    return s === null ? true : s !== "0";
  } catch {
    return true;
  }
}

const KEEPALIVE_INTERVAL_MS = 15_000;

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function errorEnvelope(status: number, code: string, message: string): {
  error: { type: string; code: string; message: string; status: number };
} {
  return {
    error: {
      type:
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_exceeded"
            : status >= 500
              ? "server_error"
              : "invalid_request_error",
      code,
      message,
      status,
    },
  };
}

export interface SelectedProvider {
  provider: Provider;
  runtime: ProviderRuntime;
  upstreamModel: string;
  // Resolved ProviderModel for upstreamModel, when the provider's catalog
  // knew it. Carries contextWindow so the upstream client can enrich
  // "context length exceeded" errors with the actual cap.
  modelInfo: ProviderModel | null;
  // Set when the client-supplied model id was NOT a known model for the
  // routed provider and we fell back to a different upstream id. Surfaced
  // in logs so the rewrite is visible (vs. silently changing the model id
  // and confusing the user when capabilities like vision diverge).
  rewriteNotice: { from: string; to: string; reason: string } | null;
}

function recordLog(cfg: Config, entry: Omit<ChatLogEntry, "ts">): void {
  if (!cfg.adminEnabled) return;
  const ts = Date.now();
  setImmediate(() => {
    try {
      const bodies = applyLogBodyMode(resolveLogBodyMode(cfg), entry.status_code, {
        requestBody: entry.request_body,
        responseBody: entry.response_body,
      });
      insertLog({
        ...entry,
        ts,
        request_body: bodies.requestBody,
        response_body: bodies.responseBody,
      });
    } catch (err) {
      log.warn("chat_logs insert failed", { error: (err as Error).message });
    }
  });
}

// Returns a recordLog bound to the calling user — every chat_logs insert it
// produces carries the user_id column. Used as a local shadow inside each
// /v1/* handler so existing call sites don't need editing.
function userLogger(user: UserRow | null): typeof recordLog {
  if (!user) return recordLog;
  const userId = user.id;
  return (cfg: Config, entry: Omit<ChatLogEntry, "ts">): void => {
    if (!cfg.adminEnabled) return;
    const ts = Date.now();
    setImmediate(() => {
      try {
        const bodies = applyLogBodyMode(resolveLogBodyMode(cfg), entry.status_code, {
          requestBody: entry.request_body,
          responseBody: entry.response_body,
        });
        insertLog({
          ...entry,
          ts,
          user_id: userId,
          request_body: bodies.requestBody,
          response_body: bodies.responseBody,
        });
      } catch (err) {
        log.warn("chat_logs insert failed", { error: (err as Error).message });
      }
    });
  };
}

function usageFromChatResponse(u: ChatUsage | undefined): {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
} {
  if (!u)
    return {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      cached_tokens: null,
    };
  return {
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? null,
  };
}

// Stringify and redact a value before persisting to chat_logs.request_body
// or response_body. Returns null on serialization failure so a corrupt body
// never blocks the log insert.
function bodyForLog(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return redactSensitive(text);
  } catch {
    return null;
  }
}

function countToolCallsInChatResponse(resp: ChatResponse | undefined): number | null {
  if (!resp || !Array.isArray(resp.choices)) return null;
  let n = 0;
  for (const c of resp.choices) {
    if (c.message?.tool_calls) n += c.message.tool_calls.length;
  }
  return n;
}

// Route a request to a provider based on the client-supplied model field:
//   1. Walk every registered provider (built-ins first, then user-declared
//      generics). Pick the first one whose catalog contains the client model
//      AND has an API key configured. This lets generics shadow built-in
//      model names when the built-in has no key — e.g. an internal MiMo
//      proxy declared as a generic can serve `mimo-v2.5-pro` without the
//      built-in MiMo provider intercepting and triggering a rewrite.
//   2. If no provider with a key matches, use the configured default
//      provider; the body.model is rewritten to the default provider's
//      defaultModel so we never forward an unknown id.
//
// Whenever the model id is rewritten on the way out (e.g. an unknown
// `mimo-v2.5-vision-preview` is fallen back to `mimo-v2.5-pro`), we attach a
// `rewriteNotice` so callers can log/persist the mismatch. Silent rewrites
// hide capability mismatches like vision support and are the root of bugs
// where a client thinks it's calling `mimo-v2.5` but the proxy sent
// `mimo-v2.5-pro` upstream.
// Compute built-in provider IDs from the canonical source in registry.ts.
// Generic providers are forbidden from using these (RESERVED_IDS in generic.ts),
// so checking the id reliably distinguishes built-ins from user-declared generics.
const BUILTIN_IDS = new Set(BUILTIN_PROVIDERS.map((p) => p.id));

// Optional "force this (provider, model)" hint from the admin UI's
// runtime-override feature. selectProvider does not read this from the DB
// itself — the call site fetches it and passes it in, keeping selectProvider
// pure and testable in isolation.
export interface ProviderOverride {
  providerId: string;
  modelId: string;
}

export function selectProvider(
  clientModel: string,
  cfg: Config,
  override?: ProviderOverride | null
): SelectedProvider {
  // Pass 0: runtime override set via the webui. Always wins over normal
  // routing — but only when both the provider is registered AND has a
  // runtime (api key) available. Stale overrides (provider removed from
  // providers.json after restart, or env key dropped) fall through to the
  // normal 3-pass logic so requests don't hard-fail on a bad override.
  if (override && override.providerId && override.modelId) {
    const p = PROVIDERS[override.providerId as keyof typeof PROVIDERS];
    const runtime = p ? cfg.providers[p.id] : null;
    if (p && runtime) {
      const resolved = p.resolveModel(override.modelId);
      const upstreamModel = resolved?.id ?? override.modelId;
      return {
        provider: p,
        runtime,
        upstreamModel,
        modelInfo: resolved ?? p.resolveModel(p.defaultModel),
        rewriteNotice: resolved
          ? null
          : {
              from: clientModel,
              to: upstreamModel,
              reason: `runtime override → ${p.id}/${override.modelId} (model id not in provider catalog, forwarded verbatim)`,
            },
      };
    }
    // override unusable → fall through silently
  }

  // Pass 1: user-declared generic providers (non-empty models, has key).
  // Generics take priority over built-ins so that an internal MiMo/DeepSeek
  // proxy declared as a generic can serve the same model names (e.g.
  // `mimo-v2.5-pro`) without the built-in intercepting.
  for (const p of PROVIDER_LIST) {
    if (BUILTIN_IDS.has(p.id)) continue;
    const isOpenCatalog = !p.builtinModels || p.builtinModels.length === 0;
    if (isOpenCatalog) continue;
    if (!p.resolveModel(clientModel)) continue;
    const runtime = cfg.providers[p.id];
    if (!runtime) continue;
    const resolved = p.resolveModel(clientModel);
    return {
      provider: p,
      runtime,
      upstreamModel: resolved?.id ?? p.defaultModel,
      modelInfo: resolved ?? p.resolveModel(p.defaultModel),
      rewriteNotice: resolved
        ? null
        : {
            from: clientModel,
            to: p.defaultModel,
            reason: "matched provider catalog but unknown model id → using provider's defaultModel",
          },
    };
  }

  // Pass 2: built-in providers (mimo, deepseek) — only reached when no
  // generic claimed this model id.
  for (const p of PROVIDER_LIST) {
    if (!BUILTIN_IDS.has(p.id)) continue;
    if (!p.resolveModel(clientModel)) continue;
    const runtime = cfg.providers[p.id];
    if (!runtime) continue;
    const resolved = p.resolveModel(clientModel);
    return {
      provider: p,
      runtime,
      upstreamModel: resolved?.id ?? p.defaultModel,
      modelInfo: resolved ?? p.resolveModel(p.defaultModel),
      rewriteNotice: resolved
        ? null
        : {
            from: clientModel,
            to: p.defaultModel,
            reason: "matched provider catalog but unknown model id → using provider's defaultModel",
          },
    };
  }

  // No provider with a key matches → fall back to the default provider.
  const provider = PROVIDERS[cfg.defaultProviderId];
  const runtime = cfg.providers[cfg.defaultProviderId];
  if (!runtime) {
    throw new Error(`provider ${cfg.defaultProviderId} has no runtime (missing api key)`);
  }
  const resolved = provider.resolveModel(clientModel);
  const upstreamModel = resolved?.id ?? provider.defaultModel;
  return {
    provider,
    runtime,
    upstreamModel,
    modelInfo: resolved ?? provider.resolveModel(provider.defaultModel),
    rewriteNotice: resolved
      ? null
      : {
          from: clientModel,
          to: upstreamModel,
          reason: `unknown client model — falling back to ${cfg.defaultProviderId} provider's defaultModel`,
        },
  };
}

function rewriteWarning(notice: { from: string; to: string; reason: string }): {
  code: string;
  message: string;
} {
  return {
    code: "client_model_rewritten",
    message: `client model "${notice.from}" was rewritten to upstream "${notice.to}" — ${notice.reason}. If you wanted the original id, add it to the provider's builtinModels or configure an alias.`,
  };
}

// ---------------------------------------------------------------------------
// Vision (multimodal) fallback
// ---------------------------------------------------------------------------

// 读取 DB 设置，返回 vision fallback 模型名；未启用或 admin 关闭时返回 null。
function resolveVisionFallback(cfg: Config): string | null {
  if (!cfg.adminEnabled) return null;
  try {
    if (getSetting("codex.visionFallbackEnabled") !== "1") return null;
    const model = getSetting("codex.visionFallbackModel");
    return model || "mimo-v2.5";
  } catch {
    return null;
  }
}

// 检测 Responses API 请求是否包含图片（input_image 类型）。
export function requestContainsImages(payload: ResponsesRequest): boolean {
  if (!Array.isArray(payload.input)) return false;
  for (const item of payload.input) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "input_image") return true;
      }
    }
    // function_call_output 也可能包含图片（tool 返回的图片）
    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      for (const part of item.output) {
        if (part.type === "input_image") return true;
      }
    }
  }
  return false;
}

// 检测 Chat Completions API 请求是否包含图片（image_url 类型）。
export function chatRequestContainsImages(payload: ChatRequest): boolean {
  if (!Array.isArray(payload.messages)) return false;
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url") return true;
      }
    }
  }
  return false;
}

/**
 * 从 Codex 请求的 tools 数组中提取 namespace 映射：toolName → namespaceName。
 * Codex Desktop 期望响应中的 function_call 带 namespace 字段才能路由到正确 handler。
 */
function buildNamespaceMap(payload: ResponsesRequest): Map<string, string> | undefined {
  if (!payload.tools || payload.tools.length === 0) return undefined;
  const map = new Map<string, string>();
  for (const t of payload.tools) {
    if (t.type === "namespace") {
      const ns = t as unknown as { name?: string; tools?: Array<{ name?: string }> };
      if (ns.name && Array.isArray(ns.tools)) {
        for (const inner of ns.tools) {
          if (inner.name) map.set(inner.name, ns.name);
        }
      }
    }
  }
  return map.size > 0 ? map : undefined;
}

async function handleResponses(
  cfg: Config,
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow | null
): Promise<void> {
  // Shadow the module-level recordLog with a user-bound version. Every
  // chat_logs insert from this handler is automatically tagged with user_id.
  const recordLog = userLogger(user);
  let payload: ResponsesRequest;
  try {
    payload = await readJsonBody<ResponsesRequest>(req);
  } catch (err) {
    return sendJson(
      res,
      400,
      errorEnvelope(400, "invalid_json", `failed to parse request body: ${(err as Error).message}`)
    );
  }
  if (!payload.model) {
    return sendJson(
      res,
      400,
      errorEnvelope(400, "missing_model", "request body must include 'model'")
    );
  }

  log.debug("incoming POST /v1/responses", {
    model: payload.model,
    stream: !!payload.stream,
    hasInput: Array.isArray(payload.input) ? payload.input.length : (typeof payload.input === "string" ? payload.input.length : "n/a"),
    hasInstructions: typeof payload.instructions === "string" ? payload.instructions.length : 0,
    keys: Object.keys(payload),
  });
  log.debug("incoming POST /v1/responses raw body", payload);

  // Health-check probe short-circuit. Tools like cc-switch's "test connection"
  // send POST /v1/responses with just `{model, stream}` and no input — our
  // translation would forward `messages: []` to the upstream, which 400s.
  // Detect the probe shape (no input, no instructions) and answer with a
  // synthetic 200 without burning an upstream call.
  if (isResponsesProbe(payload)) {
    log.debug("matched probe shape — returning synthetic 200 without upstream call");
    return respondToResponsesProbe(payload, res, !!payload.stream);
  }

  const selectedRaw = selectProvider(
    payload.model,
    cfg,
    readActiveOverrideSafely(cfg)
  );
  // 多模态 fallback：仅对声明了 vision 能力的 provider（目前只有 MiMo）生效，
  // 不影响其他 provider/模型。请求含图片但当前 model 看不了图 → 切到 vision 模型。
  const visionFallbackModel = resolveVisionFallback(cfg);
  const supportsVision = selectedRaw.provider.supportsVision?.bind(selectedRaw.provider);
  if (visionFallbackModel && supportsVision) {
    const effectiveModel = selectedRaw.upstreamModel;
    if (!supportsVision(effectiveModel) && requestContainsImages(payload)) {
      const resolved = selectedRaw.provider.resolveModel(visionFallbackModel);
      // Guard against cross-provider misrouting: only rewrite when the active
      // provider actually knows this vision model. Otherwise (e.g. DeepSeek
      // active + default "mimo-v2.5") we'd hand the provider's key to a model
      // it can't serve. Skip the fallback and keep the original model instead.
      if (!resolved) {
        log.warn("vision fallback skipped: active provider can't resolve fallback model", {
          provider: selectedRaw.provider.id,
          from: effectiveModel,
          fallbackModel: visionFallbackModel,
        });
      } else {
        selectedRaw.rewriteNotice = {
          from: effectiveModel,
          to: resolved.id,
          reason: `multimodal fallback — request contains images but model "${effectiveModel}" does not support vision`,
        };
        selectedRaw.upstreamModel = resolved.id;
        selectedRaw.modelInfo = resolved;
        log.info("vision fallback applied", {
          from: effectiveModel,
          to: resolved.id,
          provider: selectedRaw.provider.id,
        });
      }
    }
  }
  const { provider, upstreamModel, modelInfo, rewriteNotice } = selectedRaw;
  // BYOK: if a logged-in user has stored their own upstream API key for this
  // provider, swap it into the runtime. Local-mode / shared-key users keep
  // the existing runtime untouched.
  const { runtime, source: apiKeySource } = resolveRuntimeForUser(
    selectedRaw.runtime,
    provider.id,
    user,
    cfg
  );
  log.debug(`routing to provider=${provider.id}`, {
    baseUrl: runtime.baseUrl,
    clientModel: payload.model,
    upstreamModel,
    wireApi: provider.wireApi ?? "chat",
    apiKeySource,
  });
  if (rewriteNotice && !resolveSilentRewrite(cfg)) {
    // INFO, not WARN — this is a graceful fallback, not an error. The request
    // continues normally with the provider's default model. Kept visible (not
    // debug) because silent rewrites can mask capability mismatches (e.g. a
    // vision request silently routed to a non-vision default model).
    // Set MIMO2CODEX_SILENT_REWRITE=1 to suppress this message.
    log.info("model fallback applied — client sent unknown model id, request continues with provider default", {
      provider: provider.id,
      from: rewriteNotice.from,
      to: rewriteNotice.to,
      reason: rewriteNotice.reason,
    });
  }

  if (provider.wireApi === "responses") {
    return await handleResponsesPassthrough(
      cfg,
      req,
      res,
      payload,
      {
        provider,
        runtime,
        upstreamModel,
        modelInfo,
        rewriteNotice,
      },
      user
    );
  }

  const chat = provider.preprocessResponses(payload, {
    runtime,
    exposeReasoning: cfg.exposeReasoning,
    dataDir: cfg.dataDir,
    disableThinking: resolveDisableThinking(cfg),
    forceHighEffort: resolveForceHighEffort(cfg),
    upstreamModel,
  });
  chat.model = upstreamModel;
  chat.stream = !!payload.stream;
  const stream = !!payload.stream;

  const namespaceMap = buildNamespaceMap(payload);

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const startedAt = Date.now();
  const requestBodySnapshot = bodyForLog(payload);
  const rewriteLogFields = rewriteNotice && !resolveSilentRewrite(cfg)
    ? (() => {
        const w = rewriteWarning(rewriteNotice);
        return { error_code: w.code, error_snippet: w.message };
      })()
    : { error_code: null, error_snippet: null };
  const baseEntry = {
    request_id: null as string | null,
    provider_id: provider.id,
    client_model: payload.model,
    upstream_model: upstreamModel,
    endpoint: "/v1/responses",
    stream,
    request_body: requestBodySnapshot,
  };

  if (!stream) {
    try {
      const upstreamRes = await callOpenAICompat(
        {
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
          userAgent: cfg.userAgent,
          enhanceError: provider.enhanceError.bind(provider),
          contextOverflowMode: cfg.contextOverflowMode,
          modelInfo: modelInfo
            ? { id: modelInfo.id, contextWindow: modelInfo.contextWindow }
            : { id: upstreamModel },
        },
        chat,
        ac.signal
      );
      const chatJson = (await upstreamRes.json()) as ChatResponse;
      const responses = respToResponses(chatJson, payload, {
        exposeReasoning: cfg.exposeReasoning,
        // minimax-compat: 把 inline <think>...</think> 切到 reasoning_content。
        // 仅当 provider 声明开了（generic provider 的 features.minimaxCompat 或
        // features.extractThinkTags），其他 provider 这里是 undefined → 既有行为。
        extractInlineThink: !!provider.responseFlags?.extractInlineThink,
        namespaceMap,
      });
      sendJson(res, 200, responses);
      recordLog(cfg, {
        ...baseEntry,
        request_id: chatJson.id ?? null,
        status_code: 200,
        duration_ms: Date.now() - startedAt,
        ...usageFromChatResponse(chatJson.usage),
        ...rewriteLogFields,
        response_body: bodyForLog(responses),
        tool_call_count: countToolCallsInChatResponse(chatJson),
      });
      return;
    } catch (err) {
      if (err instanceof UpstreamError) {
        sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
        recordLog(cfg, {
          ...baseEntry,
          status_code: err.status,
          duration_ms: Date.now() - startedAt,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          error_code: err.code,
          error_snippet: err.bodySnippet ?? err.message,
          response_body: null,
          tool_call_count: null,
        });
        return;
      }
      log.error("non-stream request failed", { error: (err as Error).message });
      sendJson(res, 500, errorEnvelope(500, "internal_error", (err as Error).message));
      recordLog(cfg, {
        ...baseEntry,
        status_code: 500,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error_code: "internal_error",
        error_snippet: (err as Error).message,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
  }

  // Streaming path.
  let upstreamRes: Response;
  try {
    upstreamRes = await callOpenAICompat(
      {
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        userAgent: cfg.userAgent,
        enhanceError: provider.enhanceError.bind(provider),
        contextOverflowMode: cfg.contextOverflowMode,
        modelInfo: modelInfo
          ? { id: modelInfo.id, contextWindow: modelInfo.contextWindow }
          : { id: upstreamModel },
      },
      chat,
      ac.signal
    );
  } catch (err) {
    if (err instanceof UpstreamError) {
      sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
      recordLog(cfg, {
        ...baseEntry,
        status_code: err.status,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error_code: err.code,
        error_snippet: err.bodySnippet ?? err.message,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
    log.error("stream request failed (pre-stream)", { error: (err as Error).message });
    sendJson(res, 500, errorEnvelope(500, "internal_error", (err as Error).message));
    recordLog(cfg, {
      ...baseEntry,
      status_code: 500,
      duration_ms: Date.now() - startedAt,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error_code: "internal_error",
      error_snippet: (err as Error).message,
      response_body: null,
      tool_call_count: null,
    });
    return;
  }

  const sink = makeServerResponseSink(res);
  const keepalive = setInterval(() => sink.comment("keepalive"), KEEPALIVE_INTERVAL_MS);
  res.on("close", () => clearInterval(keepalive));

  let streamError: Error | null = null;
  let pipeResult: StreamPipelineResult | undefined;
  try {
    const chunks = iterChatStreamChunks(upstreamRes);
    pipeResult = await pipeChatStreamToResponses(
      sink,
      { chunks },
      payload,
      {
        exposeReasoning: cfg.exposeReasoning,
        // minimax-compat: 同 respToResponses 调用点，对 inline-think 上游开启切分。
        extractInlineThink: !!provider.responseFlags?.extractInlineThink,
        namespaceMap,
      }
    );
  } catch (err) {
    streamError = err as Error;
    log.error("stream request failed (mid-stream)", { error: streamError.message });
    if (!sink.closed()) {
      sink.write("error", {
        type: "error",
        code: "server_error",
        message: streamError.message,
        sequence_number: 9999,
      });
      sink.end();
    }
  } finally {
    clearInterval(keepalive);
    const u = pipeResult?.usage;
    recordLog(cfg, {
      ...baseEntry,
      status_code: streamError ? 500 : 200,
      duration_ms: Date.now() - startedAt,
      prompt_tokens: u?.input_tokens ?? null,
      completion_tokens: u?.output_tokens ?? null,
      total_tokens: u?.total_tokens ?? null,
      cached_tokens: u?.input_tokens_details?.cached_tokens ?? null,
      error_code: streamError ? "stream_error" : rewriteLogFields.error_code,
      error_snippet: streamError ? streamError.message : rewriteLogFields.error_snippet,
      response_body: bodyForLog(pipeResult?.response),
      tool_call_count: pipeResult?.toolCallCount ?? null,
    });
  }
}

// wireApi === "responses" path: forward Codex's Responses payload directly to
// the upstream's /v1/responses endpoint, with no Chat-Completions translation.
// Streaming pipes raw SSE bytes; non-streaming JSON is forwarded verbatim.
async function handleResponsesPassthrough(
  cfg: Config,
  req: IncomingMessage,
  res: ServerResponse,
  payload: ResponsesRequest,
  selected: {
    provider: Provider;
    runtime: ProviderRuntime;
    upstreamModel: string;
    modelInfo: SelectedProvider["modelInfo"];
    rewriteNotice: SelectedProvider["rewriteNotice"];
  },
  user: UserRow | null
): Promise<void> {
  const recordLog = userLogger(user);
  const { provider, runtime, upstreamModel, modelInfo, rewriteNotice } = selected;
  const stream = !!payload.stream;

  const preprocessed =
    provider.preprocessResponsesPassthrough?.(payload, {
      runtime,
      exposeReasoning: cfg.exposeReasoning,
    }) ?? payload;
  // The routing layer determined upstreamModel; honor it over whatever the
  // provider hook returned. preprocess hooks shouldn't normally rewrite model.
  const forwardBody: ResponsesRequest = {
    ...preprocessed,
    model: upstreamModel,
    stream,
  };

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const startedAt = Date.now();
  const requestBodySnapshot = bodyForLog(payload);
  const rewriteLogFields = rewriteNotice && !resolveSilentRewrite(cfg)
    ? (() => {
        const w = rewriteWarning(rewriteNotice);
        return { error_code: w.code, error_snippet: w.message };
      })()
    : { error_code: null, error_snippet: null };
  const baseEntry = {
    request_id: null as string | null,
    provider_id: provider.id,
    client_model: payload.model,
    upstream_model: upstreamModel,
    endpoint: "/v1/responses",
    stream,
    request_body: requestBodySnapshot,
  };

  // Non-streaming path: parse upstream JSON and forward verbatim.
  if (!stream) {
    try {
      const upstreamRes = await callResponsesPassthrough(
        {
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
          userAgent: cfg.userAgent,
          enhanceError: provider.enhanceError.bind(provider),
          contextOverflowMode: cfg.contextOverflowMode,
          modelInfo: modelInfo
            ? { id: modelInfo.id, contextWindow: modelInfo.contextWindow }
            : { id: upstreamModel },
        },
        forwardBody,
        ac.signal
      );
      const json = (await upstreamRes.json()) as Record<string, unknown>;
      sendJson(res, 200, json);
      const usage = (json.usage ?? {}) as Record<string, unknown>;
      const cachedFromResponses =
        (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
      recordLog(cfg, {
        ...baseEntry,
        request_id: typeof json.id === "string" ? json.id : null,
        status_code: 200,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        completion_tokens:
          typeof usage.output_tokens === "number" ? usage.output_tokens : null,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
        cached_tokens: typeof cachedFromResponses === "number" ? cachedFromResponses : null,
        ...rewriteLogFields,
        response_body: bodyForLog(json),
        tool_call_count: null,
      });
      return;
    } catch (err) {
      if (err instanceof UpstreamError) {
        sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
        recordLog(cfg, {
          ...baseEntry,
          status_code: err.status,
          duration_ms: Date.now() - startedAt,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          error_code: err.code,
          error_snippet: err.bodySnippet ?? err.message,
          response_body: null,
          tool_call_count: null,
        });
        return;
      }
      log.error("responses passthrough non-stream failed", { error: (err as Error).message });
      sendJson(res, 500, errorEnvelope(500, "internal_error", (err as Error).message));
      recordLog(cfg, {
        ...baseEntry,
        status_code: 500,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error_code: "internal_error",
        error_snippet: (err as Error).message,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
  }

  // Streaming path: pipe upstream SSE bytes directly to the client.
  let upstreamRes: Response;
  try {
    upstreamRes = await callResponsesPassthrough(
      {
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        userAgent: cfg.userAgent,
        enhanceError: provider.enhanceError.bind(provider),
        contextOverflowMode: cfg.contextOverflowMode,
        modelInfo: modelInfo
          ? { id: modelInfo.id, contextWindow: modelInfo.contextWindow }
          : { id: upstreamModel },
      },
      forwardBody,
      ac.signal
    );
  } catch (err) {
    if (err instanceof UpstreamError) {
      sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
      recordLog(cfg, {
        ...baseEntry,
        status_code: err.status,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error_code: err.code,
        error_snippet: err.bodySnippet ?? err.message,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
    log.error("responses passthrough stream pre-request failed", {
      error: (err as Error).message,
    });
    sendJson(res, 500, errorEnvelope(500, "internal_error", (err as Error).message));
    recordLog(cfg, {
      ...baseEntry,
      status_code: 500,
      duration_ms: Date.now() - startedAt,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error_code: "internal_error",
      error_snippet: (err as Error).message,
      response_body: null,
      tool_call_count: null,
    });
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, KEEPALIVE_INTERVAL_MS);
  res.on("close", () => clearInterval(keepalive));

  let streamError: Error | null = null;
  try {
    if (!upstreamRes.body) {
      throw new Error("upstream responded without a body");
    }
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        res.write(Buffer.from(value));
      }
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    streamError = err as Error;
    log.error("responses passthrough mid-stream failed", { error: streamError.message });
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: streamError.message, sequence_number: 9999 })}\n\n`
      );
      res.end();
    }
  } finally {
    clearInterval(keepalive);
    recordLog(cfg, {
      ...baseEntry,
      status_code: streamError ? 500 : 200,
      duration_ms: Date.now() - startedAt,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error_code: streamError ? "stream_error" : rewriteLogFields.error_code,
      error_snippet: streamError ? streamError.message : rewriteLogFields.error_snippet,
      response_body: null,
      tool_call_count: null,
    });
  }
}

// Probe-shape detection for POST /v1/responses. cc-switch's "test connection"
// (and similar health-checks) send `{model, stream}` with no `input` and no
// `instructions` — forwarding would give the upstream `messages: []` and a
// 400. So we short-circuit those with a synthetic 200.
//
// issue #31: OpenAI's Responses API accepts `input` as either a string or an
// array of message items. The previous check only matched the array form,
// causing CodeX Desktop's `{input: "write hello world"}` requests to be
// misidentified as probes and returned with an empty `output: []` (no
// upstream call) — looks like "model said nothing" with zero error signal.
// The string branch was added by 85339098-afk (PR #31).
//
// Exported so a focused unit test can lock the rule without spinning up the
// full HTTP server + mock upstream.
export function isResponsesProbe(payload: ResponsesRequest): boolean {
  const hasInput =
    (typeof payload.input === "string" && payload.input.length > 0) ||
    (Array.isArray(payload.input) && payload.input.length > 0);
  const hasInstructions =
    typeof payload.instructions === "string" && payload.instructions.length > 0;
  return !hasInput && !hasInstructions;
}

function respondToResponsesProbe(
  payload: ResponsesRequest,
  res: ServerResponse,
  stream: boolean
): void {
  const id = `resp_probe_${Date.now()}`;
  const created_at = Math.floor(Date.now() / 1000);
  const completed = {
    id,
    object: "response",
    created_at,
    status: "completed",
    model: payload.model,
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    parallel_tool_calls: true,
    tool_choice: "auto",
    text: { format: { type: "text" } },
    reasoning: { effort: null, summary: null },
    incomplete_details: null,
    error: null,
    metadata: null,
  };
  if (!stream) {
    sendJson(res, 200, completed);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const inProgress = { ...completed, status: "in_progress" };
  res.write(
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: inProgress, sequence_number: 0 })}\n\n`
  );
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed, sequence_number: 1 })}\n\n`
  );
  res.end();
}

function respondToChatProbe(
  payload: ChatRequest,
  res: ServerResponse,
  stream: boolean
): void {
  const id = `chatcmpl_probe_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: payload.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const chunk = (delta: object, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: payload.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant", content: "" }, null));
  res.write(chunk({}, "stop"));
  res.write(`data: [DONE]\n\n`);
  res.end();
}

async function handleChatPassthrough(
  cfg: Config,
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow | null
): Promise<void> {
  const recordLog = userLogger(user);
  let payload: ChatRequest;
  try {
    payload = await readJsonBody<ChatRequest>(req);
  } catch (err) {
    return sendJson(
      res,
      400,
      errorEnvelope(400, "invalid_json", `failed to parse request body: ${(err as Error).message}`)
    );
  }
  if (!payload.model) {
    return sendJson(
      res,
      400,
      errorEnvelope(400, "missing_model", "request body must include 'model'")
    );
  }

  log.debug("incoming POST /v1/chat/completions", {
    model: payload.model,
    stream: !!payload.stream,
    messages: Array.isArray(payload.messages) ? payload.messages.length : "n/a",
    keys: Object.keys(payload),
  });
  log.debug("incoming POST /v1/chat/completions raw body", payload);

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    log.debug("matched probe shape — returning synthetic 200 without upstream call");
    return respondToChatProbe(payload, res, !!payload.stream);
  }

  const selectedRaw = selectProvider(
    payload.model,
    cfg,
    readActiveOverrideSafely(cfg)
  );
  // 多模态 fallback（chat completions 路径）：仅对声明了 vision 能力的 provider
  // （目前只有 MiMo）生效，不影响其他 provider/模型。
  const visionFallbackModel = resolveVisionFallback(cfg);
  const supportsVision = selectedRaw.provider.supportsVision?.bind(selectedRaw.provider);
  if (visionFallbackModel && supportsVision) {
    const effectiveModel = selectedRaw.upstreamModel;
    if (!supportsVision(effectiveModel) && chatRequestContainsImages(payload)) {
      const resolved = selectedRaw.provider.resolveModel(visionFallbackModel);
      // Guard against cross-provider misrouting: only rewrite when the active
      // provider actually knows this vision model. Otherwise (e.g. DeepSeek
      // active + default "mimo-v2.5") we'd hand the provider's key to a model
      // it can't serve. Skip the fallback and keep the original model instead.
      if (!resolved) {
        log.warn("vision fallback skipped: active provider can't resolve fallback model", {
          provider: selectedRaw.provider.id,
          from: effectiveModel,
          fallbackModel: visionFallbackModel,
        });
      } else {
        selectedRaw.rewriteNotice = {
          from: effectiveModel,
          to: resolved.id,
          reason: `multimodal fallback — request contains images but model "${effectiveModel}" does not support vision`,
        };
        selectedRaw.upstreamModel = resolved.id;
        selectedRaw.modelInfo = resolved;
        log.info("vision fallback applied", {
          from: effectiveModel,
          to: resolved.id,
          provider: selectedRaw.provider.id,
        });
      }
    }
  }
  const { provider, upstreamModel, modelInfo, rewriteNotice } = selectedRaw;
  const { runtime, source: apiKeySource } = resolveRuntimeForUser(
    selectedRaw.runtime,
    provider.id,
    user,
    cfg
  );
  log.debug(`routing chat passthrough to provider=${provider.id}`, {
    clientModel: payload.model,
    upstreamModel,
    apiKeySource,
  });
  if (rewriteNotice && !resolveSilentRewrite(cfg)) {
    // INFO, not WARN — see handleResponses for the rationale.
    log.info("model fallback applied — client sent unknown model id, request continues with provider default", {
      provider: provider.id,
      from: rewriteNotice.from,
      to: rewriteNotice.to,
      reason: rewriteNotice.reason,
    });
  }

  const body = provider.preprocessChat(payload, {
    runtime,
    exposeReasoning: cfg.exposeReasoning,
    disableThinking: resolveDisableThinking(cfg),
    forceHighEffort: resolveForceHighEffort(cfg),
    upstreamModel,
  });
  body.model = upstreamModel;

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const startedAt = Date.now();
  const requestBodySnapshot = bodyForLog(payload);
  const rewriteLogFields = rewriteNotice && !resolveSilentRewrite(cfg)
    ? (() => {
        const w = rewriteWarning(rewriteNotice);
        return { error_code: w.code, error_snippet: w.message };
      })()
    : { error_code: null, error_snippet: null };
  const baseEntry = {
    request_id: null as string | null,
    provider_id: provider.id,
    client_model: payload.model,
    upstream_model: upstreamModel,
    endpoint: "/v1/chat/completions",
    stream: !!payload.stream,
    request_body: requestBodySnapshot,
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await callOpenAICompat(
      {
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        userAgent: cfg.userAgent,
        enhanceError: provider.enhanceError.bind(provider),
        contextOverflowMode: cfg.contextOverflowMode,
        modelInfo: modelInfo
          ? { id: modelInfo.id, contextWindow: modelInfo.contextWindow }
          : { id: upstreamModel },
      },
      body,
      ac.signal
    );
  } catch (err) {
    if (err instanceof UpstreamError) {
      sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
      recordLog(cfg, {
        ...baseEntry,
        status_code: err.status,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error_code: err.code,
        error_snippet: err.bodySnippet ?? err.message,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
    log.error("chat passthrough failed", { error: (err as Error).message });
    sendJson(res, 500, errorEnvelope(500, "internal_error", (err as Error).message));
    recordLog(cfg, {
      ...baseEntry,
      status_code: 500,
      duration_ms: Date.now() - startedAt,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error_code: "internal_error",
      error_snippet: (err as Error).message,
      response_body: null,
      tool_call_count: null,
    });
    return;
  }

  const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);

  if (payload.stream) {
    if (!upstreamRes.body) {
      res.end();
      recordLog(cfg, {
        ...baseEntry,
        status_code: 200,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        ...rewriteLogFields,
        response_body: null,
        tool_call_count: null,
      });
      return;
    }
    const reader = upstreamRes.body.getReader();
    let streamError: Error | null = null;
    // Buffer the SSE bytes as they fly through so we can persist the
    // assembled response body and pull usage / tool_calls out of the final
    // chunk. This is a passthrough so we don't decode events — just keep
    // the raw text and parse the trailing `data:` lines after the stream
    // completes.
    const collectedChunks: Buffer[] = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.from(value);
          collectedChunks.push(buf);
          res.write(buf);
        }
      }
    } catch (err) {
      streamError = err as Error;
      log.error("chat passthrough stream error", { error: streamError.message });
    } finally {
      res.end();
      const collected = Buffer.concat(collectedChunks).toString("utf-8");
      const { usage, toolCallCount } = summarizeChatSseStream(collected);
      recordLog(cfg, {
        ...baseEntry,
        status_code: streamError ? 500 : 200,
        duration_ms: Date.now() - startedAt,
        ...usageFromChatResponse(usage),
        error_code: streamError ? "stream_error" : rewriteLogFields.error_code,
        error_snippet: streamError ? streamError.message : rewriteLogFields.error_snippet,
        response_body: collected ? redactSensitive(collected) : null,
        tool_call_count: toolCallCount,
      });
    }
    return;
  }

  const text = await upstreamRes.text();
  res.end(text);
  // Try to extract token usage from the JSON body so logs reflect cost.
  let usage: ChatUsage | undefined;
  let toolCallCount: number | null = null;
  try {
    const parsed = JSON.parse(text) as ChatResponse;
    usage = parsed.usage;
    toolCallCount = countToolCallsInChatResponse(parsed);
  } catch {
    // ignore
  }
  recordLog(cfg, {
    ...baseEntry,
    status_code: 200,
    duration_ms: Date.now() - startedAt,
    ...usageFromChatResponse(usage),
    ...rewriteLogFields,
    response_body: text ? redactSensitive(text) : null,
    tool_call_count: toolCallCount,
  });
}

// Walk the SSE bytes from a /v1/chat/completions stream and pluck out the
// final usage chunk plus the running set of tool_calls. We accept best-effort
// parsing — malformed lines are skipped silently.
function summarizeChatSseStream(text: string): {
  usage: ChatUsage | undefined;
  toolCallCount: number | null;
} {
  if (!text) return { usage: undefined, toolCallCount: null };
  let usage: ChatUsage | undefined;
  const toolCallIndices = new Set<number>();
  let sawAnyChunk = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        usage?: ChatUsage;
        choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number }> } }>;
      };
      sawAnyChunk = true;
      if (obj.usage) usage = obj.usage;
      const tc = obj.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(tc)) {
        for (const t of tc) {
          if (typeof t.index === "number") toolCallIndices.add(t.index);
        }
      }
    } catch {
      // skip malformed
    }
  }
  return {
    usage,
    toolCallCount: sawAnyChunk ? toolCallIndices.size : null,
  };
}

function handleModels(cfg: Config, res: ServerResponse): void {
  // Aggregate the catalogs of every provider whose api key is configured. The
  // default provider's catalog comes first so existing tools that pick the top
  // entry keep their previous behavior.
  const ordered: Provider[] = [
    PROVIDERS[cfg.defaultProviderId],
    ...PROVIDER_LIST.filter((p) => p.id !== cfg.defaultProviderId),
  ];
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const p of ordered) {
    if (!cfg.providers[p.id]) continue;
    const ownedBy = p.id === "mimo" ? "xiaomi" : "deepseek";
    for (const m of p.builtinModels) {
      data.push({ id: m.id, object: "model", owned_by: ownedBy });
    }
  }
  sendJson(res, 200, { object: "list", data });
}

export function startServer(cfg: Config): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      sendJson(res, 200, {
        ok: true,
        name: "mimo2codex",
        provider: cfg.defaultProviderId,
        baseUrl: cfg.baseUrl,
      });
      return;
    }

    // Maintenance mode: while a data-directory migration is in progress, every
    // route except the admin endpoints that drive/observe the migration itself
    // returns 503 so the SQLite file stays untouched. The whitelist must keep
    // the SPA shell loading too (otherwise the user can't see the progress UI).
    if (isMaintenance()) {
      const allowAdmin =
        url.startsWith("/admin/api/health") ||
        url.startsWith("/admin/api/data-dir") ||
        // Allow the static SPA assets and admin shell so the page can stay open.
        (cfg.adminEnabled &&
          (url === "/admin" || url === "/admin/" ||
            (url.startsWith("/admin/") && !url.startsWith("/admin/api/"))));
      if (!allowAdmin) {
        res.statusCode = 503;
        res.setHeader("Retry-After", "60");
        sendJson(
          res,
          503,
          errorEnvelope(
            503,
            "maintenance_mode",
            getMaintenanceMessage() ??
              "server is migrating data directory; please wait or restart"
          )
        );
        return;
      }
    }

    // Resolve the calling user (or null in local mode). The guard may also
    // short-circuit with a 401 — in that case it sets `handled=true` and we
    // stop here.
    const guard = authGuard(cfg, req, res);
    if (guard.handled) return;

    // OAuth login/callback routes live outside /admin/ so providers can
    // redirect back to a stable path. The OAuth handler may set a session
    // cookie + 302 to /admin/, after which the SPA sees the user as logged in.
    if (url.startsWith("/oauth/")) {
      void handleOAuthRoutes(cfg, req, res).then((handled) => {
        if (!handled) {
          sendJson(res, 404, errorEnvelope(404, "not_found", `no route for ${req.method} ${url}`));
        }
      });
      return;
    }

    if (req.method === "GET" && url.startsWith("/v1/models")) {
      handleModels(cfg, res);
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/responses")) {
      void handleResponses(cfg, req, res, guard.ctx.user);
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      void handleChatPassthrough(cfg, req, res, guard.ctx.user);
      return;
    }
    if (cfg.adminEnabled && (url === "/admin" || url.startsWith("/admin/"))) {
      void handleAdmin(cfg, req, res, guard.ctx);
      return;
    }
    sendJson(res, 404, errorEnvelope(404, "not_found", `no route for ${req.method} ${url}`));
  });

  if (cfg.adminEnabled) {
    const maintain = () => {
      const result = runLogMaintenance(cfg);
      if (result.removed > 0) {
        log.info(
          `log maintenance removed ${result.removed} rows older than ${result.retentionDays} day(s)`
        );
      }
    };
    maintain();
    const tid = setInterval(maintain, 6 * 60 * 60 * 1000);
    server.on("close", () => clearInterval(tid));
  }

  server.listen(cfg.port, cfg.host);
  return server;
}
