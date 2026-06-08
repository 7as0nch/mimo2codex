import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { modelSupportsImages, reqToChat } from "../translate/reqToChat.js";
import type { PreprocessCtx, Provider, ProviderEnhancedError, ProviderModel } from "./types.js";

// Marker MiMo emits in 400 responses when web_search is forwarded but the
// account doesn't have the Web Search Plugin activated.
const WEB_SEARCH_DISABLED_MARKER = "webSearchEnabled is false";

const WEB_SEARCH_HINT =
  "MiMo Web Search Plugin is not activated for this account. " +
  "Activate it at https://platform.xiaomimimo.com/#/console/plugin (separately billed) " +
  "and restart mimo2codex. The model has decided to call web_search; if your account " +
  "doesn't include the plugin, this request will keep failing until activated.";

// Per https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/image-understanding,
// only `mimo-v2.5` and `mimo-v2-omni` accept image input. The pro/flash
// variants do not — they return 404 "No endpoints found that support image
// input" if sent images.
//
// maxOutputTokens defaults match
// https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api `max_completion_tokens`:
//   pro / v2-pro: 131072  |  v2.5 / omni: 32768  |  flash: 65536
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
    displayName: "MiMo V2.5 Pro",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    id: "mimo-v2-pro",
    displayName: "MiMo V2 Pro",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    id: "mimo-v2.5",
    displayName: "MiMo V2.5 (Vision)",
    supportsImages: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 32_768,
  },
  {
    id: "mimo-v2-omni",
    displayName: "MiMo V2 Omni (Vision + Audio)",
    supportsImages: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 32_768,
  },
  {
    id: "mimo-v2-flash",
    displayName: "MiMo V2 Flash",
    supportsImages: false,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 65_536,
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

// Models whose upstream default for `thinking` is "disabled" — we leave the
// field off the request so the upstream-side default kicks in.
const MIMO_THINKING_DEFAULT_DISABLED = new Set(["mimo-v2-flash"]);

// Models that, per official docs, ignore custom `temperature` while in
// thinking mode (the upstream forces it to its recommended 1.0). We strip
// the field client-side so the request matches the eventual behavior.
const MIMO_THINKING_FIXES_TEMPERATURE = new Set(["mimo-v2.5-pro", "mimo-v2.5"]);

// Normalize a chat-completions body for MiMo upstream per
// https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api :
//   - inject thinking default by model id (flash → leave off; others → enabled)
//   - drop `temperature` on mimo-v2.5-pro / mimo-v2.5 in thinking mode
//   - drop `tool_choice` when set to a non-"auto" value (upstream removes it)
function normalizeMimoBody(chat: ChatRequest, modelId: string): ChatRequest {
  if (chat.thinking === undefined && !MIMO_THINKING_DEFAULT_DISABLED.has(modelId)) {
    chat.thinking = { type: "enabled" };
  }
  if (
    chat.thinking?.type === "enabled" &&
    MIMO_THINKING_FIXES_TEMPERATURE.has(modelId)
  ) {
    delete chat.temperature;
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
    return BUILTIN_MODELS.find((m) => m.id === clientModel) ?? null;
  },

  // Vision capability lives here (MiMo-specific): only `mimo-v2.5` and
  // `*-omni` accept images. Exposing it as a provider method is what scopes
  // the multimodal fallback to MiMo — other providers don't implement it.
  supportsVision(model) {
    return modelSupportsImages(model);
  },

  preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest {
    // mimo2codex's two default-on behaviors that compensate for MiMo's weaker
    // agentic-coding training compared to GPT-5 / Claude:
    //   - parallel_tool_calls: true        ← batch tool calls per turn
    //   - web_search forwarded to MiMo     ← model decides when to search
    //
    // Token-plan accounts don't have the Web Search Plugin, so we proactively
    // strip web_search before forwarding (avoids 400 "webSearchEnabled is false").
    const chat = reqToChat(req, {
      forceParallelToolCalls: true,
      enableWebSearch: !ctx.runtime.flags.isTokenPlan,
      imageDropDir: ctx.dataDir,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    return normalizeMimoBody(chat, req.model);
  },

  preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest {
    // Chat passthrough: forward verbatim. MiMo is itself Chat-Completions-native.
    const out = { ...req };
    if (ctx.disableThinking) {
      // mimo 上游用 thinking:{type:"disabled"} 关思考。**不要**碰 reasoning_effort ——
      // mimo schema 只接受 low/medium/high，"none" 会 400。
      out.thinking = { type: "disabled" };
    }
    return normalizeMimoBody(out, out.model);
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
