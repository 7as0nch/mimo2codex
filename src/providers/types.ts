import type { ChatRequest, ResponsesRequest } from "../translate/types.js";

// Provider id is a runtime-registered string. Built-ins are "mimo" / "deepseek";
// generic OpenAI-compatible providers loaded from providers.json contribute
// their own ids at startup. Kept as a type alias for semantic clarity at call
// sites that previously expected the literal union.
export type ProviderId = string;

export interface ProviderRuntime {
  baseUrl: string;
  apiKey: string;
  flags: Record<string, boolean>;
}

export interface ProviderModel {
  id: string;
  aliases?: string[];
  displayName?: string;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  // Per-model reasoning effort. "max" forces the highest thinking budget.
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  supportsWebSearch?: boolean;
  contextWindow?: number;
  // Optional per-model output cap. Used by cli.ts when emitting
  // `model_max_output_tokens` in the toml snippet. DeepSeek used to hardcode
  // 393_216 in cli.ts; with this field, generic providers can declare their
  // own caps uniformly.
  maxOutputTokens?: number;
  deprecatedAfter?: string;
  // Optional short access/availability note surfaced in the generated
  // config.toml model list (e.g. "apply to enable; API/PAYG key only").
  // Plain text, kept terse — it renders as a trailing `# <note>` comment.
  note?: string;
  // When true the model is only served on the pay-as-you-go API host; a
  // token-plan / subscription (tp-) key can't use it. The server rejects such a
  // request early with a clear message (see paygOnlyBlock in server.ts).
  paygOnly?: boolean;
}

export interface ProviderEnhancedError {
  code: string;
  message: string;
}

export interface PreprocessCtx {
  runtime: ProviderRuntime;
  exposeReasoning: boolean;
  // When the active model can't ingest images and the proxy strips them, the
  // proxy materializes the image bytes to disk here so the agent (Codex) can
  // pass the path to mimoskill/scripts/ocr.py. Empty/undefined → falls back
  // to os.tmpdir() inside reqToChat. Typically `cfg.dataDir`.
  dataDir?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  // 全局"关思考"开关：CLI --disable-thinking / env / admin UI 控制。
  // 各 provider 自己决定怎么落地到上游字段（mimo/deepseek: thinking:{type:"disabled"}；
  // sensenova/generic: reasoning_effort:"none"）。reqToChat 一并设两个，由 generic
  // provider 的 preprocessResponses 删掉 thinking，正好留 reasoning_effort 给 sensenova。
  disableThinking?: boolean;
  // 独立开关：兜底注入 reasoning_effort:"high"。当 Codex 没传 reasoning.effort 时主动让
  // 上游真高强度思考。默认 false，仅在 admin UI 显式打开时生效。disableThinking=true 时
  // 此开关被忽略（关思考路径接管）。
  forceHighEffort?: boolean;
  // 全局"联网搜索"开关：是否把 web_search 工具转发给上游。默认 undefined/false ——
  // MiMo 的 Web Search Plugin 单独计费、默认不开通，转发会 400 "webSearchEnabled is
  // false"。仅当用户在 CLI(--web-search) / env / admin UI 显式打开时为 true。各 provider
  // 自己决定是否参考（mimo 参考它且对 tp- 永远剥离；deepseek 硬关；generic 走 providers.json）。
  webSearchEnabled?: boolean;
  // The model id that's actually going to the upstream — after admin runtime
  // override / alias / provider defaultModel fallback. Capability checks
  // (vision, …) in reqToChat should follow THIS, not req.model (the client
  // literal). Without it, e.g. client `mimo-v2.5-pro` aliased to upstream
  // `mimo-v2.5` would still get images stripped because reqToChat would
  // judge by the non-vision client id.
  upstreamModel?: string;
}

export interface Provider {
  id: ProviderId;
  shortcut: string;
  displayName: string;
  defaultBaseUrl: string;
  baseUrlEnv: string;
  envKeys: readonly string[];
  defaultModel: string;
  builtinModels: readonly ProviderModel[];
  // Wire protocol toward the upstream. "chat" (default) goes through
  // reqToChat/respToResponses translation. "responses" pipes the Codex
  // Responses payload straight to the upstream's /v1/responses endpoint —
  // useful when the upstream natively speaks Responses (OpenAI, future
  // Chat-Completions-deprecated providers) and translation would only
  // strip fields the upstream actually understands.
  wireApi?: "chat" | "responses";
  // Optional doc URL surfaced in "missing API key" error messages instead
  // of the hardcoded mimo / deepseek console links.
  docsUrl?: string;

  detectFlags(apiKey: string, baseUrl: string): Record<string, boolean>;
  // Some providers route different key tiers to different hosts. MiMo's
  // `tp-*` keys live behind `token-plan-cn.xiaomimimo.com`, while `sk-*` keys
  // hit the main pay-as-you-go host. Return null when the key gives no signal
  // — callers will then fall back to defaultBaseUrl.
  inferBaseUrlFromKey?(apiKey: string): string | null;
  resolveModel(clientModel: string): ProviderModel | null;
  // Optional vision capability probe. ONLY providers that implement this take
  // part in the multimodal (vision) fallback: the server skips the whole
  // fallback when a provider omits it, so the feature stays MiMo-specific and
  // never rewrites models for DeepSeek / generic providers. Returns whether the
  // given model can accept image input.
  supportsVision?(model: string): boolean;
  preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest;
  preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest;
  // Lightweight hook for wireApi === "responses". Receives the original Codex
  // Responses payload; return the version to forward (model id rewrite,
  // field cleanup, etc). Default behavior when omitted is identity passthrough
  // with `model` substituted by the routing layer.
  preprocessResponsesPassthrough?(req: ResponsesRequest, ctx: PreprocessCtx): ResponsesRequest;
  enhanceError(ctx: { status: number; snippet?: string }): ProviderEnhancedError | null;
  // minimax-compat: 响应翻译层用到的开关。未实现时所有标记 false → 既有行为。
  // 目前只放 extractInlineThink（把 content 里的 <think>...</think> 切到 reasoning_content），
  // 后续若再加响应侧 sanitizer 共用这一个对象，避免接口爆炸。
  responseFlags?: {
    extractInlineThink?: boolean;
  };
}
