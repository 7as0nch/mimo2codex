import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { reqToChat } from "../translate/reqToChat.js";
import type { PreprocessCtx, Provider, ProviderModel } from "./types.js";

// Builtin DeepSeek model catalog. Source: https://api-docs.deepseek.com/zh-cn/
// All current DeepSeek models share the same window: 1M input / 384K max output.
// `deepseek-chat` and `deepseek-reasoner` are the legacy aliases that route to
// `deepseek-v4-flash` (non-thinking / thinking respectively); they're announced
// for deprecation 2026-07-24. We keep them as aliases for backwards compat.
const DEEPSEEK_CONTEXT = 1_000_000;

const BUILTIN_MODELS: readonly ProviderModel[] = [
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    supportsReasoning: true,
    reasoningEffort: "max",
    contextWindow: DEEPSEEK_CONTEXT,
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    aliases: ["deepseek-chat", "deepseek-reasoner"],
    supportsReasoning: true,
    reasoningEffort: "max",
    contextWindow: DEEPSEEK_CONTEXT,
  },
  {
    id: "deepseek-chat",
    displayName: "DeepSeek Chat (legacy)",
    deprecatedAfter: "2026-07-24",
    contextWindow: DEEPSEEK_CONTEXT,
  },
  {
    id: "deepseek-reasoner",
    displayName: "DeepSeek Reasoner (legacy)",
    supportsReasoning: true,
    deprecatedAfter: "2026-07-24",
    contextWindow: DEEPSEEK_CONTEXT,
  },
];

export const deepseek: Provider = {
  id: "deepseek",
  shortcut: "ds",
  displayName: "DeepSeek",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  baseUrlEnv: "DEEPSEEK_BASE_URL",
  envKeys: ["DS_API_KEY", "DEEPSEEK_API_KEY"] as const,
  defaultModel: "deepseek-v4-pro",
  builtinModels: BUILTIN_MODELS,

  detectFlags(_apiKey, _baseUrl) {
    return {};
  },

  resolveModel(clientModel) {
    for (const m of BUILTIN_MODELS) {
      if (m.id === clientModel) return m;
      if (m.aliases?.includes(clientModel)) return m;
    }
    return null;
  },

  preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest {
    // DeepSeek is OpenAI Chat Completions compatible. No `web_search` builtin
    // (drop those tools), no MiMo-style force-parallel override (respect the
    // client's value).
    const chat = reqToChat(req, {
      forceParallelToolCalls: false,
      enableWebSearch: false,
      imageDropDir: ctx.dataDir,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    // `enable_thinking` is a MiMo-only legacy field reqToChat sometimes emits;
    // DeepSeek doesn't recognize it. The structured `thinking: {type: ...}`
    // field IS what DeepSeek wants and is preserved below.
    delete chat.enable_thinking;
    normalizeDeepseekBody(chat, ctx.reasoningEffort);
    // The V4 family REQUIRES `reasoning_content` to be echoed back on every
    // prior assistant message in thinking mode (400: "The reasoning_content
    // in the thinking mode must be passed back to the API"). reqToChat
    // already re-injects it from Codex's reasoning items, so we leave it
    // alone. The legacy `deepseek-reasoner` is the inverse — it 400s if
    // reasoning_content IS present in the input — so we strip there.
    if (isLegacyR1Model(chat.model)) {
      stripReasoningContent(chat);
    }
    return chat;
  },

  preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest {
    const out = { ...req };
    delete out.enable_thinking;
    if (ctx.disableThinking) {
      out.thinking = { type: "disabled" };
      // 不设 reasoning_effort —— DeepSeek 文档只列 high/max，"none" 上游会报错。
      // normalizeDeepseekBody 内部已经在 thinking:disabled + reasoning_effort:"none"
      // 时 strip 那个字段，作为兜底（也清掉客户端可能误传的）。
    }
    normalizeDeepseekBody(out, ctx.reasoningEffort);
    if (isLegacyR1Model(out.model)) {
      out.messages = out.messages.map(cloneWithoutReasoning);
    }
    return out;
  },

  enhanceError(_ctx) {
    return null;
  },
};

// Legacy DeepSeek-R1 (`deepseek-reasoner`) rejects requests whose input
// includes `reasoning_content`. The V4 family (deepseek-v4-pro, v4-flash) is
// the opposite — it REQUIRES the field on prior assistant messages whenever
// thinking mode is on. So strip only for R1.
function isLegacyR1Model(model: string): boolean {
  return model === "deepseek-reasoner";
}

// Per https://api-docs.deepseek.com/zh-cn/guides/thinking_mode :
//   - `thinking: {type: "enabled"|"disabled"}` goes in the request body
//   - `reasoning_effort` defaults to "high" for normal requests (Claude Code /
//     OpenCode-style agents auto-promote to "max"); we conservatively pick
//     "high" for codex.
//   - In thinking mode, `temperature` / `top_p` / `presence_penalty` /
//     `frequency_penalty` are silently ignored upstream; strip them client-side
//     so the request matches the eventual behavior.
function normalizeDeepseekBody(chat: ChatRequest, reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"): void {
  if (chat.thinking === undefined) {
    chat.thinking = { type: "enabled" };
  }
  // 思考关闭时 reasoning_effort 是无关字段，不要硬注默认值；同时清掉客户端误传的
  // "none"（DeepSeek 不接受，会上游 400）。其他用户显式传的值（low/medium/high/max）
  // 保留，DeepSeek 会自行忽略或 fallback。
  if (chat.thinking?.type === "disabled") {
    if (chat.reasoning_effort === "none") {
      delete chat.reasoning_effort;
    }
  } else if (chat.reasoning_effort === undefined) {
    chat.reasoning_effort = reasoningEffort ?? "high";
  }
  if (chat.thinking?.type === "enabled") {
    delete chat.temperature;
    delete chat.top_p;
    delete chat.presence_penalty;
    delete chat.frequency_penalty;
  }
}

function cloneWithoutReasoning(m: ChatRequest["messages"][number]): ChatRequest["messages"][number] {
  if (!("reasoning_content" in m) || m.reasoning_content == null) return m;
  const { reasoning_content: _drop, ...rest } = m;
  void _drop;
  return rest;
}

function stripReasoningContent(chat: ChatRequest): void {
  for (let i = 0; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.reasoning_content !== undefined) {
      chat.messages[i] = cloneWithoutReasoning(m);
    }
  }
}
