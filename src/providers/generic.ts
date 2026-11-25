import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { reqToChat } from "../translate/reqToChat.js";
import {
  applyMinimaxCompat,
  type MinimaxCompatFeatures,
} from "../translate/minimaxCompat.js"; // minimax-compat: 后处理 sanitizer
import {
  applyEnhanceErrorPreset,
  PROVIDER_PRESETS,
  type ProviderPresetId,
} from "./presets.js";
import type {
  PreprocessCtx,
  Provider,
  ProviderEnhancedError,
  ProviderModel,
} from "./types.js";

// Spec format for a single generic OpenAI-compatible provider. Users declare
// these in providers.json (or via GENERIC_* env vars for the single-instance
// shortcut). The factory below turns each spec into a runtime Provider that
// plugs into the existing registry / routing / preprocessing pipeline.
export interface GenericProviderSpec {
  id: string;
  shortcut?: string;
  displayName?: string;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  // Default "chat" — translate Responses → ChatCompletions before forwarding.
  // Set "responses" when the upstream natively speaks the Codex Responses API
  // and translation would strip fields the upstream understands.
  wireApi?: "chat" | "responses";
  // When omitted or empty, any client-supplied model id is forwarded verbatim
  // (no rewrite to defaultModel). Provide entries here only when you want
  // print-config to fill in context_window / max_output_tokens.
  models?: ProviderModel[];
  features?: {
    webSearch?: boolean;
    forceParallelToolCalls?: boolean;
    /**
     * 选填。命中预设时（"sensenova" / "minimax"）generic 的 enhanceError hook 会用
     * src/providers/presets.ts 中内置的硬编码诊断翻译表把上游模糊化的 400 翻成
     * 可读 hint（比如 SenseNova 的 "Errors in message queue response"）。默认 unset
     * → 行为与之前完全一致（hook 返回 null）。
     */
    enhanceErrorPreset?: ProviderPresetId;
  } & MinimaxCompatFeatures; // minimax-compat: 把 sanitizer 的子开关合并进 features 命名空间
  docsUrl?: string;
  // minimax-compat: 当 models 为空且本 provider 是默认 provider 时，让 resolveModel
  // 返回 null 以触发 selectProvider fallback 将 upstreamModel 改写为 defaultModel。
  // 适用于 MiniMax 等用 env-var 单实例接入、客户端会发任意未知模型名（如 "gpt-5.5"）
  // 的场景。默认 false → 保持既有"开放目录直通"（Ollama/OpenRouter 用法）不变。
  forceDefaultModel?: boolean;
}

const RESERVED_IDS = new Set(["mimo", "deepseek"]);

// 当 features.enhanceErrorPreset 命中已知厂商预设时，把 preset.recommendedSpec.features
// 中**缺失**的字段补到运行时 features 上。用户已显式配置的字段不会被覆盖（"" / false 也算
// 显式，因为 genericLoader 在 parse 时只在字段为对应类型时才放进 store）。
//
// 这条兜底的存在意义：在新增 sanitizer 子开关后，老 providers.json 的 features 块不带这些
// 字段，但用户选过 `enhanceErrorPreset: "sensenova"` 已经明确表态"我要 sensenova 整套保护"。
// 老配置无需手改 providers.json，重启即享受新开关。前端 UI 仍按 providers.json 原文显示 ——
// 已显式存的字段一致；新字段在 UI 显示为未勾，但运行时实际生效（这是可接受的最小不一致）。
function augmentFeaturesWithPreset(
  features: NonNullable<GenericProviderSpec["features"]>,
): NonNullable<GenericProviderSpec["features"]> {
  if (!features.enhanceErrorPreset) return features;
  const preset = PROVIDER_PRESETS.find((p) => p.id === features.enhanceErrorPreset);
  if (!preset) return features;
  const out = { ...features };
  for (const [k, v] of Object.entries(preset.recommendedSpec.features)) {
    if (k === "enhanceErrorPreset") continue;
    if ((out as Record<string, unknown>)[k] === undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export class GenericProviderSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenericProviderSpecError";
  }
}

export function validateSpec(spec: GenericProviderSpec): void {
  if (!spec.id || typeof spec.id !== "string") {
    throw new GenericProviderSpecError("generic provider spec missing id");
  }
  if (RESERVED_IDS.has(spec.id)) {
    throw new GenericProviderSpecError(
      `generic provider id "${spec.id}" conflicts with a built-in provider — pick a different id`
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(spec.id)) {
    throw new GenericProviderSpecError(
      `generic provider id "${spec.id}" must be alphanumeric + dash/underscore (no spaces, no slashes)`
    );
  }
  if (!spec.baseUrl) {
    throw new GenericProviderSpecError(`generic provider "${spec.id}" missing baseUrl`);
  }
  if (!spec.envKey) {
    throw new GenericProviderSpecError(`generic provider "${spec.id}" missing envKey`);
  }
  if (!spec.defaultModel) {
    throw new GenericProviderSpecError(`generic provider "${spec.id}" missing defaultModel`);
  }
  if (spec.wireApi && spec.wireApi !== "chat" && spec.wireApi !== "responses") {
    throw new GenericProviderSpecError(
      `generic provider "${spec.id}" has invalid wireApi "${spec.wireApi}" — must be "chat" or "responses"`
    );
  }
}

export function createGenericProvider(spec: GenericProviderSpec): Provider {
  validateSpec(spec);

  const declaredModels: readonly ProviderModel[] = spec.models ?? [];
  const hasDeclaredModels = declaredModels.length > 0;
  const wireApi = spec.wireApi ?? "chat";
  // 用户写在 providers.json 的原始 features。下面 augment 一次得到"运行时"用的版本。
  const features = augmentFeaturesWithPreset(spec.features ?? {});

  // Look up the declared model's image-input capability for the upstream
  // model id (post-alias). Returns undefined when the provider has no
  // declared catalog (open-catalog / forceDefaultModel passthrough) or the
  // id isn't a declared model — callers fall back to the hardcoded check.
  function resolveSupportsImages(upstreamModel: string | undefined): boolean | undefined {
    if (!hasDeclaredModels || !upstreamModel) return undefined;
    for (const m of declaredModels) {
      if (m.id === upstreamModel) return m.supportsImages;
      if (m.aliases?.includes(upstreamModel)) return m.supportsImages;
    }
    return undefined;
  }

  return {
    id: spec.id,
    shortcut: spec.shortcut ?? spec.id,
    displayName: spec.displayName ?? spec.id,
    defaultBaseUrl: spec.baseUrl,
    baseUrlEnv: `${spec.envKey.replace(/_API_KEY$/i, "")}_BASE_URL`,
    envKeys: [spec.envKey] as const,
    defaultModel: spec.defaultModel,
    builtinModels: declaredModels,
    wireApi,
    docsUrl: spec.docsUrl,

    detectFlags(_apiKey, _baseUrl) {
      return {};
    },

    resolveModel(clientModel) {
      if (!hasDeclaredModels) {
        // minimax-compat: forceDefaultModel 时返回 null，让 selectProvider 把
        // upstreamModel 改写为本 provider 的 defaultModel（用于 MiniMax 等
        // 需要把任意客户端模型名强制覆盖为单一上游模型的场景）。
        if (spec.forceDefaultModel) return null;
        // Untyped passthrough — accept any model id and let the upstream
        // validate. This is the design choice that matches Codex's habit of
        // "whatever model = "..." is in config.toml gets sent verbatim".
        return { id: clientModel };
      }
      for (const m of declaredModels) {
        if (m.id === clientModel) return m;
        if (m.aliases?.includes(clientModel)) return m;
      }
      return null;
    },

    preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest {
      const chat = reqToChat(req, {
        forceParallelToolCalls: !!features.forceParallelToolCalls,
        enableWebSearch: !!features.webSearch,
        imageDropDir: ctx.dataDir,
        disableThinking: ctx.disableThinking,
        forceHighEffort: ctx.forceHighEffort,
        upstreamModel: ctx.upstreamModel,
        // Forward the declared model's image-input capability so generic
        // providers with vision models (e.g. MiniMax-M3) actually keep
        // image parts instead of being stripped by the MiMo-only hardcoded
        // modelSupportsImages() check. Without this, `supportsImages` in
        // providers.json was UI-only.
        supportsImages: resolveSupportsImages(ctx.upstreamModel),
      });
      // Generic OpenAI-compat upstreams don't understand MiMo's `thinking` family —
      // strip it. 然后**自己**翻成 sensenova 等接受的 reasoning_effort:"none"，
      // 因为 reqToChat 只发标准 thinking 信号、不知道下游是谁。
      delete chat.thinking;
      delete chat.enable_thinking;
      if (ctx.disableThinking) {
        chat.reasoning_effort = "none";
      }
      return applyMinimaxCompat(chat, features); // minimax-compat: 关闭时是恒等
    },

    preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest {
      const out = { ...req };
      delete out.thinking;
      delete out.enable_thinking;
      if (ctx.disableThinking) {
        // chat completions 路径：直接覆盖 reasoning_effort 表达"关思考"。
        // sensenova 接受 "none"；其他 generic 上游可能不识别但通常忽略未知值。
        out.reasoning_effort = "none";
      }
      return applyMinimaxCompat(out, features); // minimax-compat: 关闭时是恒等
    },

    preprocessResponsesPassthrough(req: ResponsesRequest, _ctx: PreprocessCtx): ResponsesRequest {
      // Identity passthrough — the routing layer will substitute `model`
      // separately. Hook exists so users can later override for upstream
      // quirks without changing the server's branching logic.
      return req;
    },

    enhanceError({ status, snippet }): ProviderEnhancedError | null {
      // 未设 enhanceErrorPreset → 行为与之前完全一致（return null）。
      if (features.enhanceErrorPreset) {
        return applyEnhanceErrorPreset(features.enhanceErrorPreset, status, snippet);
      }
      return null;
    },

    // minimax-compat: 响应侧 inline <think>...</think> 切分开关。features.minimaxCompat
    // 一键预设包揽；也可独立打开 features.extractThinkTags（部分 GLM/Qwen-thinking
    // 模型同样是 inline think 格式）。
    responseFlags: {
      extractInlineThink: !!features.minimaxCompat || !!features.extractThinkTags,
    },
  };
}
