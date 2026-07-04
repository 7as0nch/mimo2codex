import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { modelSupportsImages, reqToChat } from "../translate/reqToChat.js";
import type { PreprocessCtx, Provider, ProviderEnhancedError, ProviderModel } from "./types.js";

// Marker MiMo emits in 400 responses when web_search is forwarded but the
// account doesn't have the Web Search Plugin activated.
const WEB_SEARCH_DISABLED_MARKER = "webSearchEnabled is false";

const WEB_SEARCH_HINT =
  "MiMo Web Search Plugin is not activated for this account. " +
  "Either activate it at https://platform.xiaomimimo.com/#/console/plugin (separately billed) " +
  "and restart mimo2codex, OR turn OFF web search in mimo2codex (Codex Enable page → " +
  "Thinking & Override → Web search, or run without --web-search). Web search is off by " +
  "default; you only see this if it was explicitly enabled without the plugin.";

// Per https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/image-understanding,
// only `mimo-v2.5` accepts image input; `mimo-v2.5-pro` (and the retired v2
// variants) do not — they return 404 "No endpoints found that support image
// input" if sent images. The retired `mimo-v2-omni` is aliased to `mimo-v2.5`,
// so image input keeps working for clients still sending the old name.
//
// maxOutputTokens defaults match
// https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api `max_completion_tokens`:
//   v2.5-pro / v2.5-pro-ultraspeed: 131072  |  v2.5: 32768
//
// contextWindow is 1M for every model — MiMo's real published context window
// (NOT a fabricated number; an earlier comment here wrongly claimed the real
// cap was 128K). Declaring it keeps the generated `model_context_window` in the
// user's Codex config.toml large enough that Codex doesn't preemptively
// /compact at a small window (some Codex builds default to 256K and 400 when we
// declare a smaller cap than they prepare for). If a conversation genuinely
// exceeds the model's window the upstream 400s and our `detectContextOverflow`
// handler surfaces a friendly /compact hint (see src/upstream/contextOverflow.ts);
// mimo2codex's own auto-compaction also kicks in at ~80% of this window first.
const MIMO_CONTEXT_WINDOW = 1_000_000;

const BUILTIN_MODELS: readonly ProviderModel[] = [
  {
    id: "mimo-v2.5-pro",
    // Retired `mimo-v2-pro` is transparently aliased here — MiMo's official
    // replacement, API params fully compatible. Existing config.toml files
    // sending the old name keep working and hit the live model.
    aliases: ["mimo-v2-pro"],
    displayName: "MiMo V2.5 Pro",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    // MiMo V2.5 Pro UltraSpeed (issue #70) — 1T-param flagship "experience"
    // mode, 500-1000 tok/s. Per the official spec it's text-only with deep
    // thinking + tool calling; web search is NOT listed, so supportsWebSearch
    // is false. Same 1M window and 131072 max output as Pro.
    //
    // Access: limited daily approval — must be applied for at
    // https://platform.xiaomimimo.com/ultraspeed — and it's served ONLY on the
    // pay-as-you-go API host (sk- keys). Token-plan / subscription (tp- keys)
    // accounts can't use it. `note` surfaces this in the config.toml snippet.
    id: "mimo-v2.5-pro-ultraspeed",
    displayName: "MiMo V2.5 Pro UltraSpeed",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: false,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
    note: "apply to enable (limited); API / pay-as-you-go (sk-) key only — token-plan/subscription can't use it",
    paygOnly: true,
  },
  {
    id: "mimo-v2.5",
    // Retired `mimo-v2-omni` and `mimo-v2-flash` are both officially replaced
    // by `mimo-v2.5`, so both are aliased here. NOTE this is a behavior change
    // for old flash users: v2.5 defaults thinking ON (flash was off) and does
    // support vision. Thinking-mode sampling is normalized in normalizeMimoBody
    // (see MIMO_THINKING_STRIPS_SAMPLING).
    aliases: ["mimo-v2-omni", "mimo-v2-flash"],
    displayName: "MiMo V2.5 (Vision)",
    supportsImages: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 32_768,
  },
];

// MiMo runs two hosts:
//   - pay-as-you-go (`sk-*` keys): https://api.xiaomimimo.com/v1
//   - token-plan (`tp-*` keys):    https://token-plan-cn.xiaomimimo.com/v1
// Sending a tp-* key to the pay-as-you-go host (or vice versa) yields a 401.
const PAYG_BASE_URL = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";

function isTokenPlanRuntime(apiKey: string, baseUrl: string): boolean {
  return /token-plan/i.test(baseUrl) || apiKey.startsWith("tp-");
}

// web_search is forwarded to MiMo only when the user explicitly opted in
// (ctx.webSearchEnabled) AND the account isn't token-plan (tp- never has the
// plugin). Default off — the Web Search Plugin is separately billed and off by
// default, so forwarding it unprompted 400s ("webSearchEnabled is false").
function webSearchAllowed(ctx: PreprocessCtx): boolean {
  return ctx.webSearchEnabled === true && !ctx.runtime.flags.isTokenPlan;
}

// Models whose upstream default for `thinking` is "disabled" — we leave the
// field off the request so the upstream-side default kicks in. Empty since the
// retirement of `mimo-v2-flash` (2026-06-30): every live model defaults thinking
// ON. Kept as a named set so a future disabled-by-default model can be re-added.
const MIMO_THINKING_DEFAULT_DISABLED = new Set<string>([]);

// Models that, per official docs, ignore custom `temperature` / `top_p` while in
// thinking mode (the upstream forces temperature:1.0 and top_p:0.95). We strip
// both client-side so the request matches the eventual behavior. Scoped to the
// v2.5 reasoning family; kept as an explicit set (not an unconditional strip) so
// a future MiMo model that DOES honor custom sampling isn't silently overridden.
const MIMO_THINKING_STRIPS_SAMPLING = new Set([
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro-ultraspeed",
]);

// Normalize a chat-completions body for MiMo upstream per
// https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api :
//   - inject thinking default by model id (all live models → enabled)
//   - drop `temperature` / `top_p` on the v2.5 family in thinking mode
//   - drop `tool_choice` when set to a non-"auto" value (upstream removes it)
// `modelId` is the UPSTREAM model id (post-alias), not the client literal — so a
// retired name aliased to v2.5 gets the v2.5 normalization.
function normalizeMimoBody(chat: ChatRequest, modelId: string): ChatRequest {
  if (chat.thinking === undefined && !MIMO_THINKING_DEFAULT_DISABLED.has(modelId)) {
    chat.thinking = { type: "enabled" };
  }
  if (
    chat.thinking?.type === "enabled" &&
    MIMO_THINKING_STRIPS_SAMPLING.has(modelId)
  ) {
    delete chat.temperature;
    delete chat.top_p;
  }
  if (chat.tool_choice && chat.tool_choice !== "auto") {
    delete chat.tool_choice;
  }
  // mimo schema 仅允许 reasoning_effort ∈ {low, medium, high}；"none" 是 sensenova 扩展，
  // 走错了路径会 400。任何形如 thinking:disabled 的请求都不需要这个字段，直接 strip 防御。
  if (chat.thinking?.type === "disabled" && chat.reasoning_effort === "none") {
    delete chat.reasoning_effort;
  }
  return chat;
}

export const mimo: Provider = {
  id: "mimo",
  shortcut: "mimo",
  displayName: "MiMo (via mimo2codex)",
  defaultBaseUrl: PAYG_BASE_URL,
  baseUrlEnv: "MIMO_BASE_URL",
  envKeys: ["MIMO_API_KEY"] as const,
  defaultModel: "mimo-v2.5-pro",
  builtinModels: BUILTIN_MODELS,

  detectFlags(apiKey, baseUrl) {
    return { isTokenPlan: isTokenPlanRuntime(apiKey, baseUrl) };
  },

  inferBaseUrlFromKey(apiKey) {
    if (apiKey.startsWith("tp-")) return TOKEN_PLAN_BASE_URL;
    if (apiKey.startsWith("sk-")) return PAYG_BASE_URL;
    return null;
  },

  resolveModel(clientModel) {
    // Match by id first, then by `aliases` — this is how retired names
    // (`mimo-v2-pro` → `mimo-v2.5-pro`, `mimo-v2-omni`/`mimo-v2-flash` →
    // `mimo-v2.5`) resolve to their live replacement. The returned model's `id`
    // becomes the upstream model, so the alias is a clean resolve (no rewrite
    // notice). Mirrors deepseek.ts.
    for (const m of BUILTIN_MODELS) {
      if (m.id === clientModel) return m;
      if (m.aliases?.includes(clientModel)) return m;
    }
    return null;
  },

  // Vision capability lives here (MiMo-specific): only `mimo-v2.5` accepts
  // images (the `*-omni` substring branch in modelSupportsImages is kept for
  // the aliased/legacy omni name). Exposing it as a provider method is what
  // scopes the multimodal fallback to MiMo — other providers don't implement it.
  supportsVision(model) {
    return modelSupportsImages(model);
  },

  preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest {
    // parallel_tool_calls is forced on (batches tool calls per turn) to
    // compensate for MiMo's weaker agentic-coding training vs GPT-5 / Claude.
    //
    // web_search is forwarded ONLY when explicitly opted in (the global "web
    // search" toggle) and the account isn't token-plan. It's OFF by default
    // because the Web Search Plugin is separately billed and forwarding it
    // unprompted 400s "webSearchEnabled is false".
    const chat = reqToChat(req, {
      forceParallelToolCalls: true,
      enableWebSearch: webSearchAllowed(ctx),
      imageDropDir: ctx.dataDir,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    // Key normalization off the UPSTREAM model (post-alias), not the client
    // literal — a retired name aliased to v2.5 must get v2.5's thinking/sampling
    // rules. ctx.upstreamModel is always set in production (resolved id ??
    // defaultModel); the fallback only covers direct unit-test callers.
    return normalizeMimoBody(chat, ctx.upstreamModel ?? req.model);
  },

  preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest {
    // Chat passthrough: forward verbatim. MiMo is itself Chat-Completions-native.
    const out = { ...req };
    if (ctx.disableThinking) {
      // mimo 上游用 thinking:{type:"disabled"} 关思考。**不要**碰 reasoning_effort ——
      // mimo schema 只接受 low/medium/high，"none" 会 400。
      out.thinking = { type: "disabled" };
    }
    // Same web_search gate as preprocessResponses: drop the builtin web_search
    // tool unless explicitly opted in (and not token-plan), so a passthrough
    // chat request can't 400 on an account without the plugin. Reassigning a
    // new array leaves the caller's req.tools untouched.
    if (!webSearchAllowed(ctx) && Array.isArray(out.tools)) {
      const filtered = out.tools.filter((t) => (t as { type?: string }).type !== "web_search");
      if (filtered.length !== out.tools.length) out.tools = filtered;
    }
    // Key off the upstream model (post-alias), same as preprocessResponses.
    // out.model is still the client literal here (the server overwrites it with
    // the upstream id only after this returns), so keying off it would mis-apply
    // the v2.5 rules to an aliased legacy name.
    return normalizeMimoBody(out, ctx.upstreamModel ?? out.model);
  },

  enhanceError({ status, snippet }): ProviderEnhancedError | null {
    if (status === 400 && snippet?.includes(WEB_SEARCH_DISABLED_MARKER)) {
      return {
        code: "web_search_plugin_not_activated",
        message: `${WEB_SEARCH_HINT} (raw: ${snippet})`,
      };
    }
    return null;
  },
};
