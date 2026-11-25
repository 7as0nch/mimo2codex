import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenericProvider, GenericProviderSpecError } from "../src/providers/generic.js";
import {
  loadGenericProviders,
  GenericLoaderError,
} from "../src/providers/genericLoader.js";
import {
  byClientModel,
  byShortcut,
  initRegistry,
  isProviderId,
  PROVIDERS,
} from "../src/providers/registry.js";

// Tests for the generic-provider factory, loader, and registry integration.
// Each test resets the registry to built-ins-only in afterEach so they don't
// leak state.

afterEach(() => {
  initRegistry([]);
});

describe("createGenericProvider", () => {
  it("builds a working provider from a minimal spec", () => {
    const p = createGenericProvider({
      id: "qwen",
      displayName: "Qwen",
      baseUrl: "https://example.com/v1",
      envKey: "QWEN_API_KEY",
      defaultModel: "qwen3-max",
    });
    expect(p.id).toBe("qwen");
    expect(p.shortcut).toBe("qwen"); // defaults to id
    expect(p.defaultModel).toBe("qwen3-max");
    expect(p.wireApi).toBe("chat");
    expect(p.envKeys).toEqual(["QWEN_API_KEY"]);
    // baseUrlEnv is derived from envKey (strip _API_KEY suffix)
    expect(p.baseUrlEnv).toBe("QWEN_BASE_URL");
  });

  it("rejects reserved built-in ids", () => {
    expect(() =>
      createGenericProvider({
        id: "mimo",
        displayName: "Conflict",
        baseUrl: "https://x.example/v1",
        envKey: "X_API_KEY",
        defaultModel: "x",
      })
    ).toThrow(GenericProviderSpecError);
    expect(() =>
      createGenericProvider({
        id: "deepseek",
        displayName: "Conflict",
        baseUrl: "https://x.example/v1",
        envKey: "X_API_KEY",
        defaultModel: "x",
      })
    ).toThrow(GenericProviderSpecError);
  });

  it("rejects ids with spaces or special chars", () => {
    expect(() =>
      createGenericProvider({
        id: "with space",
        displayName: "Bad",
        baseUrl: "https://x.example/v1",
        envKey: "X_API_KEY",
        defaultModel: "x",
      })
    ).toThrow(GenericProviderSpecError);
  });

  it("resolveModel passes through any id when no models declared", () => {
    const p = createGenericProvider({
      id: "g",
      displayName: "G",
      baseUrl: "https://x.example/v1",
      envKey: "G_API_KEY",
      defaultModel: "x",
    });
    expect(p.resolveModel("anything")?.id).toBe("anything");
    expect(p.resolveModel("unknown:tag@2")?.id).toBe("unknown:tag@2");
  });

  it("resolveModel strictly matches when models are declared", () => {
    const p = createGenericProvider({
      id: "q",
      displayName: "Q",
      baseUrl: "https://x.example/v1",
      envKey: "Q_API_KEY",
      defaultModel: "q3-max",
      models: [
        { id: "q3-max" },
        { id: "q3-flash", aliases: ["q-flash"] },
      ],
    });
    expect(p.resolveModel("q3-max")?.id).toBe("q3-max");
    expect(p.resolveModel("q3-flash")?.id).toBe("q3-flash");
    expect(p.resolveModel("q-flash")?.id).toBe("q3-flash"); // alias
    expect(p.resolveModel("random-id")).toBeNull();
  });

  it("preprocessResponses strips MiMo-specific thinking fields", () => {
    const p = createGenericProvider({
      id: "g",
      displayName: "G",
      baseUrl: "https://x.example/v1",
      envKey: "G_API_KEY",
      defaultModel: "x",
    });
    const chat = p.preprocessResponses(
      {
        model: "x",
        input: [{ type: "message", role: "user", content: "hi" }],
      },
      { runtime: { apiKey: "k", baseUrl: "u", flags: {} }, exposeReasoning: true }
    );
    expect(chat.thinking).toBeUndefined();
    expect(chat.enable_thinking).toBeUndefined();
  });
});

describe("loadGenericProviders", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m2c-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] when no file and no env vars are set", () => {
    const result = loadGenericProviders({}, tmp);
    expect(result).toEqual([]);
  });

  it("loads providers from providers.json under dataDir", () => {
    writeFileSync(
      join(tmp, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "qwen",
            displayName: "Qwen",
            baseUrl: "https://example.com/v1",
            envKey: "QWEN_API_KEY",
            defaultModel: "qwen3-max",
          },
        ],
      })
    );
    const result = loadGenericProviders({}, tmp);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("qwen");
  });

  it("MIMO2CODEX_PROVIDERS_FILE override takes precedence", () => {
    const overridePath = join(tmp, "elsewhere.json");
    writeFileSync(
      overridePath,
      JSON.stringify({
        providers: [
          {
            id: "kimi",
            displayName: "Kimi",
            baseUrl: "https://example.com/v1",
            envKey: "KIMI_API_KEY",
            defaultModel: "k",
          },
        ],
      })
    );
    // Default location does NOT exist; only the override does.
    const result = loadGenericProviders(
      { MIMO2CODEX_PROVIDERS_FILE: overridePath },
      tmp
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("kimi");
  });

  it("env-only single-instance shortcut when no file present", () => {
    const result = loadGenericProviders(
      {
        GENERIC_BASE_URL: "https://example.com/v1",
        GENERIC_DEFAULT_MODEL: "test-model",
      },
      tmp
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("generic");
    expect(result[0].defaultModel).toBe("test-model");
  });

  it("throws on duplicate ids within the file", () => {
    writeFileSync(
      join(tmp, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "x",
            displayName: "X",
            baseUrl: "https://a.example/v1",
            envKey: "X_API_KEY",
            defaultModel: "m",
          },
          {
            id: "x",
            displayName: "X2",
            baseUrl: "https://b.example/v1",
            envKey: "X_API_KEY",
            defaultModel: "m",
          },
        ],
      })
    );
    expect(() => loadGenericProviders({}, tmp)).toThrow(GenericLoaderError);
  });

  it("throws on invalid JSON", () => {
    writeFileSync(join(tmp, "providers.json"), "not json {");
    expect(() => loadGenericProviders({}, tmp)).toThrow(GenericLoaderError);
  });

  it("throws when reserved id appears in spec", () => {
    writeFileSync(
      join(tmp, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "mimo",
            displayName: "Collision",
            baseUrl: "https://x.example/v1",
            envKey: "X_API_KEY",
            defaultModel: "m",
          },
        ],
      })
    );
    expect(() => loadGenericProviders({}, tmp)).toThrow(GenericLoaderError);
  });
});

describe("initRegistry / runtime registration", () => {
  it("registers generics alongside built-ins", () => {
    const generic = createGenericProvider({
      id: "qwen",
      displayName: "Qwen",
      baseUrl: "https://example.com/v1",
      envKey: "QWEN_API_KEY",
      defaultModel: "qwen3-max",
      models: [{ id: "qwen3-max" }],
    });
    initRegistry([generic]);
    expect(PROVIDERS.qwen).toBe(generic);
    expect(PROVIDERS.mimo).toBeDefined();
    expect(PROVIDERS.deepseek).toBeDefined();
    expect(isProviderId("qwen")).toBe(true);
    expect(isProviderId("nonexistent")).toBe(false);
    expect(byShortcut("qwen")?.id).toBe("qwen");
  });

  it("byClientModel routes to a declared-models generic", () => {
    initRegistry([
      createGenericProvider({
        id: "qwen",
        displayName: "Qwen",
        baseUrl: "https://example.com/v1",
        envKey: "QWEN_API_KEY",
        defaultModel: "qwen3-max",
        models: [{ id: "qwen3-max", contextWindow: 262144 }],
      }),
    ]);
    expect(byClientModel("qwen3-max")?.id).toBe("qwen");
    // Existing built-in routing still works.
    expect(byClientModel("mimo-v2.5-pro")?.id).toBe("mimo");
    expect(byClientModel("deepseek-v4-pro")?.id).toBe("deepseek");
  });

  it("byClientModel skips open-catalog generics so they don't hijack routing", () => {
    // A generic with no declared models accepts any id via passthrough. It
    // must NOT win byClientModel against built-in ids — otherwise sending
    // `mimo-v2.5-pro` would route to the generic instead of mimo.
    initRegistry([
      createGenericProvider({
        id: "openrouter",
        displayName: "OpenRouter",
        baseUrl: "https://example.com/v1",
        envKey: "OPENROUTER_API_KEY",
        defaultModel: "any",
      }),
    ]);
    expect(byClientModel("mimo-v2.5-pro")?.id).toBe("mimo");
    expect(byClientModel("anything-else")).toBeUndefined();
  });

  it("rejects duplicate-id generic at init time", () => {
    const a = createGenericProvider({
      id: "dup",
      displayName: "A",
      baseUrl: "https://a.example/v1",
      envKey: "A_API_KEY",
      defaultModel: "m",
    });
    const b = createGenericProvider({
      id: "dup",
      displayName: "B",
      baseUrl: "https://b.example/v1",
      envKey: "B_API_KEY",
      defaultModel: "m",
    });
    expect(() => initRegistry([a, b])).toThrow();
  });

  it("initRegistry([]) restores built-ins-only state", () => {
    initRegistry([
      createGenericProvider({
        id: "tmp",
        displayName: "Tmp",
        baseUrl: "https://x.example/v1",
        envKey: "T_API_KEY",
        defaultModel: "m",
      }),
    ]);
    expect(PROVIDERS.tmp).toBeDefined();
    initRegistry([]);
    expect(PROVIDERS.tmp).toBeUndefined();
    expect(PROVIDERS.mimo).toBeDefined();
    expect(PROVIDERS.deepseek).toBeDefined();
  });
});

// minimax-compat: forceDefaultModel switches open-catalog generics into
// "rewrite-to-defaultModel" mode (needed for MiniMax env-var single-instance
// where Codex sends arbitrary model names like "gpt-5.5").
describe("createGenericProvider — forceDefaultModel (minimax-compat)", () => {
  it("forceDefaultModel: true makes open-catalog resolveModel return null", () => {
    const p = createGenericProvider({
      id: "minimax",
      displayName: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      envKey: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M2.7",
      forceDefaultModel: true,
    });
    expect(p.resolveModel("gpt-5.5")).toBeNull();
    expect(p.resolveModel("anything-else")).toBeNull();
    expect(p.resolveModel("MiniMax-M2.7")).toBeNull(); // still no declared catalog
  });

  it("forceDefaultModel: false (default) keeps open-catalog passthrough", () => {
    const p = createGenericProvider({
      id: "ollama",
      displayName: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      envKey: "OLLAMA_API_KEY",
      defaultModel: "qwen2.5-coder:7b",
    });
    expect(p.resolveModel("anything")?.id).toBe("anything");
  });

  it("forceDefaultModel does NOT affect strict-catalog providers", () => {
    const p = createGenericProvider({
      id: "minimax",
      displayName: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      envKey: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M2.7",
      models: [{ id: "MiniMax-M2.7" }],
      forceDefaultModel: true, // still set but should be ignored when models[] is non-empty
    });
    expect(p.resolveModel("MiniMax-M2.7")?.id).toBe("MiniMax-M2.7");
    expect(p.resolveModel("unknown")).toBeNull();
  });
});

describe("loadGenericProviders — GENERIC_FORCE_DEFAULT_MODEL env var (minimax-compat)", () => {
  it("GENERIC_FORCE_DEFAULT_MODEL=1 sets forceDefaultModel on env-var single-instance", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "m2c-test-"));
    try {
      const result = loadGenericProviders(
        {
          GENERIC_BASE_URL: "https://api.minimaxi.com/v1",
          GENERIC_DEFAULT_MODEL: "MiniMax-M2.7",
          GENERIC_FORCE_DEFAULT_MODEL: "1",
        },
        tmp2,
      );
      expect(result).toHaveLength(1);
      // resolveModel should now return null for any client model id
      expect(result[0].resolveModel("gpt-5.5")).toBeNull();
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("no GENERIC_FORCE_DEFAULT_MODEL → open-catalog passthrough preserved", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "m2c-test-"));
    try {
      const result = loadGenericProviders(
        {
          GENERIC_BASE_URL: "http://127.0.0.1:11434/v1",
          GENERIC_DEFAULT_MODEL: "qwen2.5-coder:7b",
        },
        tmp2,
      );
      expect(result).toHaveLength(1);
      expect(result[0].resolveModel("qwen2.5-coder:7b")?.id).toBe("qwen2.5-coder:7b");
      expect(result[0].resolveModel("anything")?.id).toBe("anything");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("createGenericProvider — enhanceErrorPreset (sensenova)", () => {
  it("unset enhanceErrorPreset → enhanceError returns null (legacy behavior)", () => {
    const p = createGenericProvider({
      id: "any-generic",
      baseUrl: "https://example.com/v1",
      envKey: "ANY_KEY",
      defaultModel: "any",
    });
    expect(p.enhanceError({ status: 400, snippet: "anything" })).toBeNull();
  });

  it("enhanceErrorPreset: sensenova translates 'Errors in message queue response'", () => {
    const p = createGenericProvider({
      id: "sensenova-generic",
      baseUrl: "https://token.sensenova.cn/v1",
      envKey: "SENSENOVA_API_KEY",
      defaultModel: "sensenova-6.7-flash-lite",
      features: { enhanceErrorPreset: "sensenova" },
    });
    const out = p.enhanceError({
      status: 400,
      snippet: '{"error":{"message":"Errors in message queue response","code":"3"}}',
    });
    expect(out).not.toBeNull();
    expect(out?.code).toBe("sensenova_request_validation_failed");
    expect(out?.message).toMatch(/dropResponseFormat/);
  });

  it("enhanceErrorPreset: sensenova catches invalid temperature", () => {
    const p = createGenericProvider({
      id: "sensenova-generic",
      baseUrl: "https://token.sensenova.cn/v1",
      envKey: "SENSENOVA_API_KEY",
      defaultModel: "sensenova-6.7-flash-lite",
      features: { enhanceErrorPreset: "sensenova" },
    });
    const out = p.enhanceError({
      status: 400,
      snippet: '{"error":{"message":"invalid temperature, should in [0,2]."}}',
    });
    expect(out?.code).toBe("sensenova_temperature_out_of_range");
  });

  it("enhanceErrorPreset: sensenova auto-augments missing sanitizer features at runtime", () => {
    // 老配置：用户只配了 enhanceErrorPreset，没显式配 dropNonFunctionTools / dropResponseFormat 等
    const p = createGenericProvider({
      id: "old-sensenova",
      baseUrl: "https://token.sensenova.cn/v1",
      envKey: "SENSENOVA_API_KEY",
      defaultModel: "sensenova-6.7-flash-lite",
      features: { enhanceErrorPreset: "sensenova" },
    });
    // 运行 preprocessChat：tools 数组带 web_search 应该被 dropNonFunctionTools 兜底过滤掉
    const chat = p.preprocessChat(
      {
        model: "sensenova-6.7-flash-lite",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: "f1", parameters: {} } },
          { type: "web_search" } as unknown as never,
        ],
      } as never,
      { runtime: { apiKey: "k", baseUrl: "u", flags: {} }, exposeReasoning: true },
    );
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools?.[0]?.type).toBe("function");
  });

  it("enhanceErrorPreset: sensenova passes through unrelated 400 (returns null)", () => {
    const p = createGenericProvider({
      id: "sensenova-generic",
      baseUrl: "https://token.sensenova.cn/v1",
      envKey: "SENSENOVA_API_KEY",
      defaultModel: "sensenova-6.7-flash-lite",
      features: { enhanceErrorPreset: "sensenova" },
    });
    expect(
      p.enhanceError({ status: 401, snippet: "unauthorized" }),
    ).toBeNull();
    expect(
      p.enhanceError({ status: 400, snippet: "some unrelated error" }),
    ).toBeNull();
  });
});

describe("loadGenericProviders — providers.json forceDefaultModel + features.minimaxCompat", () => {
  it("forceDefaultModel and features are passed through from JSON", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "m2c-test-"));
    try {
      writeFileSync(
        join(tmp2, "providers.json"),
        JSON.stringify({
          providers: [
            {
              id: "minimax",
              displayName: "MiniMax M2.7",
              baseUrl: "https://api.minimaxi.com/v1",
              envKey: "MINIMAX_API_KEY",
              defaultModel: "MiniMax-M2.7",
              forceDefaultModel: true,
              features: { minimaxCompat: true, forceParallelToolCalls: true },
            },
          ],
        }),
      );
      const result = loadGenericProviders({}, tmp2);
      expect(result).toHaveLength(1);
      const p = result[0];
      expect(p.id).toBe("minimax");
      expect(p.resolveModel("gpt-5.5")).toBeNull(); // forceDefaultModel respected

      // preprocessResponses should strip MiniMax-rejected fields end-to-end,
      // but PRESERVE stream_options + parallel_tool_calls (OpenAI standard fields,
      // dropping them breaks admin DB token statistics).
      const chat = p.preprocessResponses(
        {
          model: "MiniMax-M2.7",
          instructions: "sys A",
          stream: true,
          tool_choice: "auto",
          input: [{ type: "message", role: "user", content: "hi" }],
        },
        { runtime: { apiKey: "k", baseUrl: "u", flags: {} }, exposeReasoning: true },
      );
      expect("tool_choice" in chat).toBe(false);
      // OpenAI standard fields kept; needed for token usage roundtrip.
      expect(chat.stream_options).toEqual({ include_usage: true });
      expect(chat.parallel_tool_calls).toBe(true); // forceParallelToolCalls
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// input-capability: a generic provider whose declared model carries
// `supportsImages: true` must forward image parts to the upstream instead of
// letting reqToChat strip them via the MiMo-only hardcoded check.
describe("createGenericProvider — supportsImages metadata (input-capability)", () => {
  it("forwards image parts when the declared model sets supportsImages: true", () => {
    const p = createGenericProvider({
      id: "minimax",
      displayName: "MiniMax",
      baseUrl: "https://api.minimax.io/v1",
      envKey: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M3",
      models: [{ id: "MiniMax-M3", supportsImages: true }],
    });
    const chat = p.preprocessResponses(
      {
        model: "MiniMax-M3",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "describe this" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAAA",
              },
            ],
          },
        ],
      },
      {
        runtime: { apiKey: "k", baseUrl: "u", flags: {} },
        exposeReasoning: true,
        upstreamModel: "MiniMax-M3",
      },
    );
    const userMsg = chat.messages.find((m) => m.role === "user")!;
    const parts = userMsg.content as Array<{ type: string; image_url?: unknown }>;
    // Image survived (not stripped to a text placeholder).
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    expect(parts.find((p) => p.type === "image_url")?.image_url).toEqual({
      url: "data:image/png;base64,AAAA",
      detail: undefined,
    });
  });

  it("strips image parts when the declared model omits supportsImages", () => {
    const p = createGenericProvider({
      id: "textonly",
      displayName: "TextOnly",
      baseUrl: "https://x.example/v1",
      envKey: "TEXT_API_KEY",
      defaultModel: "text-1",
      models: [{ id: "text-1" }], // no supportsImages
    });
    const chat = p.preprocessResponses(
      {
        model: "text-1",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAAA",
              },
            ],
          },
        ],
      },
      {
        runtime: { apiKey: "k", baseUrl: "u", flags: {} },
        exposeReasoning: true,
        upstreamModel: "text-1",
      },
    );
    const userMsg = chat.messages.find((m) => m.role === "user")!;
    // partsToChatContent collapses text-only payloads to a string.
    const raw = userMsg.content;
    const parts = (typeof raw === "string" ? [{ type: "text", text: raw }] : raw) as Array<{ type: string; text?: string }>;
    // No image_url part forwarded; the strip notice is appended instead.
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
    expect(parts.some((p) => p.type === "text" && typeof p.text === "string" && /omitted/i.test(p.text))).toBe(true);
  });

  it("open-catalog provider (no declared models) falls back to hardcoded check", () => {
    // No models[] → no metadata to consult → reqToChat keeps using
    // modelSupportsImages(), which is false for non-MiMo ids.
    const p = createGenericProvider({
      id: "open",
      displayName: "Open",
      baseUrl: "https://x.example/v1",
      envKey: "OPEN_API_KEY",
      defaultModel: "any",
    });
    const chat = p.preprocessResponses(
      {
        model: "any",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAAA",
              },
            ],
          },
        ],
      },
      {
        runtime: { apiKey: "k", baseUrl: "u", flags: {} },
        exposeReasoning: true,
        upstreamModel: "any",
      },
    );
    const userMsg = chat.messages.find((m) => m.role === "user")!;
    const raw = userMsg.content;
    const parts = (typeof raw === "string" ? [{ type: "text", text: raw }] : raw) as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
  });
});
