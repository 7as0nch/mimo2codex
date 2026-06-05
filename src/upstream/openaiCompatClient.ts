import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { log, redactKey } from "../util/log.js";
import type { ProviderEnhancedError } from "../providers/types.js";
import { detectContextOverflow, detectMalformedJsonField } from "./contextOverflow.js";

export type ContextOverflowMode = "friendly" | "passthrough";

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  enhanceError?: (ctx: { status: number; snippet?: string }) => ProviderEnhancedError | null;
  // When set to "friendly" (default), upstream 400 responses that look like
  // context-window overflows are rewritten to a structured bilingual message
  // guiding the user to run /compact in codex. "passthrough" preserves the
  // raw upstream error verbatim.
  contextOverflowMode?: ContextOverflowMode;
  // Routed model metadata, used to enrich the friendly overflow message with
  // the upstream model id and its context-window cap.
  modelInfo?: { id: string; contextWindow?: number };
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  // Transient-failure retry. Defaults come from env
  // (MIMO2CODEX_UPSTREAM_MAX_RETRIES / _RETRY_BASE_MS) when unset. maxRetries
  // is the number of *extra* attempts after the first (so 6 ⇒ up to 7 tries).
  // The default budget (6 retries, exp backoff capped at 12s) spans ~28s so a
  // multi-second quota 429 outlasts the limit instead of bubbling up to Codex.
  maxRetries?: number;
  retryBaseMs?: number;
}

export class UpstreamError extends Error {
  status: number;
  bodySnippet?: string;
  code: string;

  constructor(opts: { status: number; message: string; code: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet;
  }
}

function buildUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${normalizedPath}`;
}

function authHeader(apiKey: string): Record<string, string> {
  // Both MiMo and DeepSeek accept the OpenAI-style Bearer scheme, which is
  // also more universally supported by intermediaries than the api-key header.
  return { Authorization: `Bearer ${apiKey}` };
}

async function readSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return undefined;
  }
}

// Native fetch surfaces a generic "fetch failed" Error; the actionable detail
// (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / EHOSTUNREACH, plus the address that
// failed) lives on err.cause from undici. Expose both so logs and the 502
// payload can name the underlying cause — critical for proxy / network bugs.
interface FetchErrorDetail {
  error: string;
  cause?: string;
  code?: string;
}
function describeFetchError(err: unknown): FetchErrorDetail {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return {
    error: e.message,
    cause: e.cause?.message,
    code: e.cause?.code,
  };
}

// Statuses worth retrying: rate limits + transient upstream/gateway failures.
// 429 is the big one — without proxy-side retry, Codex burns its own
// `request_max_retries` and surfaces "exceeded retry limit, last status: 429".
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// How long to wait before the next attempt. Honors a numeric or HTTP-date
// `Retry-After` header (capped so Codex doesn't time out waiting on us), else
// exponential backoff with jitter.
function retryDelayMs(res: Response | null, attempt: number, baseMs: number): number {
  const CAP = 10_000;
  if (res) {
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, CAP);
      const when = Date.parse(ra);
      if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), CAP);
    }
  }
  const exp = baseMs * 2 ** attempt;
  return Math.min(exp, 12_000) + Math.floor(Math.random() * 250);
}

// setTimeout that rejects (AbortError) if the request is cancelled mid-wait,
// so a Codex cancel during backoff doesn't leave us sleeping.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      return reject(e);
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultErrorCode(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "server_error";
  return "bad_request";
}

export async function callOpenAICompat(
  cfg: UpstreamConfig,
  body: ChatRequest,
  signal: AbortSignal
): Promise<Response> {
  return await postUpstream(cfg, "/chat/completions", body, signal, {
    summary: {
      model: body.model,
      stream: !!body.stream,
      messages: body.messages.length,
      tools: body.tools?.length ?? 0,
    },
    streaming: !!body.stream,
  });
}

// Direct Responses-API passthrough. Used when Provider.wireApi === "responses"
// — the body is sent untouched to the upstream's /v1/responses endpoint.
// Lets generic providers that natively speak the Codex Responses API skip
// the Chat-Completions translation round-trip.
export async function callResponsesPassthrough(
  cfg: UpstreamConfig,
  body: ResponsesRequest,
  signal: AbortSignal
): Promise<Response> {
  return await postUpstream(cfg, "/responses", body, signal, {
    summary: {
      model: body.model,
      stream: !!body.stream,
      inputItems: Array.isArray(body.input) ? body.input.length : 0,
      tools: body.tools?.length ?? 0,
    },
    streaming: !!body.stream,
  });
}

async function postUpstream(
  cfg: UpstreamConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
  meta: { summary: Record<string, unknown>; streaming: boolean }
): Promise<Response> {
  const url = buildUrl(cfg.baseUrl, path);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: meta.streaming ? "text/event-stream" : "application/json",
    "User-Agent": cfg.userAgent,
    ...authHeader(cfg.apiKey),
  };

  log.debug(`upstream POST ${url}`, { ...meta.summary, apiKey: redactKey(cfg.apiKey) });
  log.debug("upstream POST body", body);

  const maxRetries = cfg.maxRetries ?? envInt("MIMO2CODEX_UPSTREAM_MAX_RETRIES", 6, 0, 12);
  const baseMs = cfg.retryBaseMs ?? envInt("MIMO2CODEX_UPSTREAM_RETRY_BASE_MS", 500, 50, 5_000);
  const serialized = JSON.stringify(body);

  const doFetch = (): Promise<Response> =>
    fetch(url, { method: "POST", headers, body: serialized, signal });

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await doFetch();
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      // Network-level failure (connect refused / DNS / reset). Retry with
      // backoff like a transient status, then give up with a 502.
      if (attempt < maxRetries) {
        const delay = retryDelayMs(null, attempt, baseMs);
        log.warn(
          `upstream connect failed, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
          describeFetchError(err)
        );
        await abortableSleep(delay, signal);
        attempt++;
        continue;
      }
      const detail = describeFetchError(err);
      throw new UpstreamError({
        status: 502,
        code: "upstream_unreachable",
        message: detail.code
          ? `failed to reach upstream: ${detail.error} (${detail.code}${detail.cause ? `: ${detail.cause}` : ""})`
          : `failed to reach upstream: ${detail.error}`,
      });
    }

    if (res.ok) return res;

    // Transient status (rate limit / gateway) → consume the body and retry so
    // a brief 429 doesn't bubble up to Codex and break the session.
    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const snippet = await readSnippet(res);
      const delay = retryDelayMs(res, attempt, baseMs);
      log.warn(
        `upstream ${res.status} ${res.statusText}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        { snippet: snippet?.slice(0, 200) }
      );
      await abortableSleep(delay, signal);
      attempt++;
      continue;
    }

    // Terminal failure: build the (possibly enhanced) error and throw.
    const snippet = await readSnippet(res);
    // Provider-specific enhancement runs first so dedicated rules (e.g. MiMo's
    // "webSearchEnabled is false" hint) keep winning over the generic
    // context-overflow detector below.
    let enhanced = cfg.enhanceError?.({ status: res.status, snippet });
    if (!enhanced && (cfg.contextOverflowMode ?? "friendly") === "friendly") {
      enhanced = detectContextOverflow({
        status: res.status,
        snippet,
        modelId: cfg.modelInfo?.id,
        contextWindow: cfg.modelInfo?.contextWindow,
      });
    }
    if (!enhanced) {
      // Independent of contextOverflowMode — the malformed-field hint is a
      // diagnostic, not a UX rewrite of a known-bad-prompt case. Surface it
      // even when contextOverflowMode === "passthrough".
      enhanced = detectMalformedJsonField({ status: res.status, snippet });
    }
    const code = enhanced?.code ?? defaultErrorCode(res.status);
    const message = enhanced?.message ?? `upstream returned ${res.status}: ${snippet ?? "(no body)"}`;
    if (enhanced) {
      log.warn(enhanced.message);
    }
    throw new UpstreamError({
      status: res.status,
      code,
      message,
      bodySnippet: snippet,
    });
  }
}
