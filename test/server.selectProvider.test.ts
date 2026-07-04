import { describe, expect, it, afterEach } from "vitest";
import { paygOnlyBlock, selectProvider } from "../src/server.js";
import type { Config } from "../src/config.js";
import { initRegistry } from "../src/providers/registry.js";
import { createGenericProvider } from "../src/providers/generic.js";
import type { ProviderModel, ProviderRuntime } from "../src/providers/types.js";

// Build a minimal Config for routing tests. Only fields read by selectProvider
// matter: defaultProviderId, providers map. Everything else is filled with
// stable defaults so the shape compiles.
function makeConfig(opts: {
  defaultProviderId: string;
  providers: Record<string, ProviderRuntime | null>;
}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    exposeReasoning: true,
    verbose: false,
    userAgent: "mimo2codex/test",
    defaultProviderId: opts.defaultProviderId as Config["defaultProviderId"],
    providers: opts.providers as Config["providers"],
    isTokenPlan: false,
    dataDir: "",
    adminEnabled: false,
  };
}

const fakeRuntime: ProviderRuntime = {
  apiKey: "sk-test",
  baseUrl: "https://example.test/v1",
  flags: {},
};

const companyMimoSpec = {
  id: "company-mimo",
  displayName: "Company MiMo Proxy",
  baseUrl: "https://internal.example/v1",
  envKey: "COMPANY_MIMO_API_KEY",
  defaultModel: "mimo-v2.5-pro",
  models: [{ id: "mimo-v2.5-pro", contextWindow: 128_000 }],
};

afterEach(() => {
  // Restore built-ins-only registry so each test starts from a clean slate.
  initRegistry([]);
});

describe("selectProvider routing priority (PR #6 regression)", () => {
  it("case A: generic with declared model + key wins over built-in mimo with key", () => {
    initRegistry([createGenericProvider(companyMimoSpec)]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null, "company-mimo": fakeRuntime },
    });
    const sel = selectProvider("mimo-v2.5-pro", cfg);
    expect(sel.provider.id).toBe("company-mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case B: generic claims model but has no key → falls through to built-in mimo", () => {
    initRegistry([createGenericProvider(companyMimoSpec)]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null, "company-mimo": null },
    });
    const sel = selectProvider("mimo-v2.5-pro", cfg);
    expect(sel.provider.id).toBe("mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case C: only generic has key; built-in mimo has no key → generic wins (PR #6's core fix)", () => {
    initRegistry([createGenericProvider(companyMimoSpec)]);
    // defaultProviderId stays as the generic itself so buildConfig wouldn't
    // throw; before PR #6 this case still routed via the broken fall-through.
    const cfg = makeConfig({
      defaultProviderId: "company-mimo",
      providers: { mimo: null, deepseek: null, "company-mimo": fakeRuntime },
    });
    const sel = selectProvider("mimo-v2.5-pro", cfg);
    expect(sel.provider.id).toBe("company-mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case D: open-catalog generic does NOT hijack a built-in model id", () => {
    // Generic without `models[]` accepts any model id via passthrough. It must
    // not be picked when the request maps to a built-in catalog id.
    initRegistry([
      createGenericProvider({
        id: "openrouter",
        displayName: "OpenRouter",
        baseUrl: "https://openrouter.example/v1",
        envKey: "OPENROUTER_API_KEY",
        defaultModel: "any",
      }),
    ]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null, openrouter: fakeRuntime },
    });
    const sel = selectProvider("mimo-v2.5-pro", cfg);
    expect(sel.provider.id).toBe("mimo");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case E: completely unknown model id falls back to default provider with rewriteNotice", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null },
    });
    const sel = selectProvider("gpt-99-turbo", cfg);
    expect(sel.provider.id).toBe("mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro"); // mimo's defaultModel
    expect(sel.rewriteNotice).not.toBeNull();
    expect(sel.rewriteNotice?.from).toBe("gpt-99-turbo");
    expect(sel.rewriteNotice?.to).toBe("mimo-v2.5-pro");
  });

  it("case F: built-in catalog hit yields rewriteNotice === null", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: fakeRuntime },
    });
    const sel = selectProvider("deepseek-v4-pro", cfg);
    expect(sel.provider.id).toBe("deepseek");
    expect(sel.upstreamModel).toBe("deepseek-v4-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case H: mimo-v2.5-pro-ultraspeed routes verbatim (issue #70 — not downgraded to pro)", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null },
    });
    const sel = selectProvider("mimo-v2.5-pro-ultraspeed", cfg);
    expect(sel.provider.id).toBe("mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro-ultraspeed");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("case I: retired v2 names alias to their v2.5 replacement (clean resolve, no rewriteNotice)", () => {
    // MiMo retired the v2 generation (offline 2026-06-30). Old names still work
    // via `aliases` and resolve to the live upstream — NOT a fallback rewrite,
    // so rewriteNotice stays null and the correct replacement is picked.
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null },
    });
    for (const [oldName, upstream] of [
      ["mimo-v2-pro", "mimo-v2.5-pro"],
      ["mimo-v2-omni", "mimo-v2.5"],
      ["mimo-v2-flash", "mimo-v2.5"],
    ] as const) {
      const sel = selectProvider(oldName, cfg);
      expect(sel.provider.id, oldName).toBe("mimo");
      expect(sel.upstreamModel, oldName).toBe(upstream);
      expect(sel.rewriteNotice, oldName).toBeNull();
    }
  });
});

describe("paygOnlyBlock (issue #70 — UltraSpeed needs a PAYG key)", () => {
  const ultraspeed = {
    id: "mimo-v2.5-pro-ultraspeed",
    displayName: "MiMo V2.5 Pro UltraSpeed",
    paygOnly: true,
  } as ProviderModel;
  const pro = { id: "mimo-v2.5-pro" } as ProviderModel;

  it("blocks a payg-only model on a token-plan (tp-) runtime", () => {
    const msg = paygOnlyBlock(ultraspeed, {
      apiKey: "tp-x",
      baseUrl: "x",
      flags: { isTokenPlan: true },
    });
    expect(msg).toMatch(/pay-as-you-go/i);
  });

  it("allows a payg-only model on a pay-as-you-go (sk-) runtime", () => {
    expect(
      paygOnlyBlock(ultraspeed, { apiKey: "sk-x", baseUrl: "x", flags: { isTokenPlan: false } })
    ).toBeNull();
  });

  it("never blocks a model that isn't payg-only", () => {
    expect(
      paygOnlyBlock(pro, { apiKey: "tp-x", baseUrl: "x", flags: { isTokenPlan: true } })
    ).toBeNull();
  });

  it("handles null modelInfo", () => {
    expect(
      paygOnlyBlock(null, { apiKey: "tp-x", baseUrl: "x", flags: { isTokenPlan: true } })
    ).toBeNull();
  });
});

describe("selectProvider runtime override (client model takes precedence)", () => {
  it("a RECOGNIZED client model wins over a runtime override (new priority)", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: fakeRuntime },
    });
    // Codex explicitly asks for a known mimo model. The override must NOT
    // hijack a model the user configured — client model wins.
    const sel = selectProvider("mimo-v2.5-pro", cfg, {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(sel.provider.id).toBe("mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("the override applies when the client model is NOT recognized", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: fakeRuntime },
    });
    // Unknown client id → no provider catalog matches → the override is the
    // next-priority pick (instead of silently rewriting to the default model).
    const sel = selectProvider("gpt-99-unknown", cfg, {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(sel.provider.id).toBe("deepseek");
    expect(sel.upstreamModel).toBe("deepseek-v4-pro");
    expect(sel.rewriteNotice).toBeNull();
  });

  it("override with unknown providerId is ignored → unrecognized model falls to default", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null },
    });
    const sel = selectProvider("gpt-99-unknown", cfg, {
      providerId: "ghost-provider",
      modelId: "ghost-model",
    });
    expect(sel.provider.id).toBe("mimo"); // default fallback
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).not.toBeNull();
  });

  it("override at a provider with no runtime is ignored → falls to default", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null }, // deepseek has no key
    });
    const sel = selectProvider("gpt-99-unknown", cfg, {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(sel.provider.id).toBe("mimo");
    expect(sel.rewriteNotice).not.toBeNull();
  });

  it("override with an unknown modelId forwards verbatim when the client model is unrecognized", () => {
    initRegistry([]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: fakeRuntime },
    });
    const sel = selectProvider("gpt-99-unknown", cfg, {
      providerId: "deepseek",
      modelId: "deepseek-experimental-99",
    });
    expect(sel.provider.id).toBe("deepseek");
    // Unknown ids forwarded verbatim so the upstream can decide.
    expect(sel.upstreamModel).toBe("deepseek-experimental-99");
    expect(sel.rewriteNotice).not.toBeNull();
    expect(sel.rewriteNotice?.reason).toContain("runtime override");
  });

  it("override=null preserves all existing behavior (no regression)", () => {
    initRegistry([createGenericProvider(companyMimoSpec)]);
    const cfg = makeConfig({
      defaultProviderId: "mimo",
      providers: { mimo: fakeRuntime, deepseek: null, "company-mimo": fakeRuntime },
    });
    const sel = selectProvider("mimo-v2.5-pro", cfg, null);
    // Same as case A.
    expect(sel.provider.id).toBe("company-mimo");
    expect(sel.upstreamModel).toBe("mimo-v2.5-pro");
    expect(sel.rewriteNotice).toBeNull();
  });
});

// minimax-compat: forceDefaultModel routing — verifies the env-var single-instance
// MiniMax flow where Codex sends an arbitrary model name like "gpt-5.5" and it
// must be rewritten to the provider's defaultModel rather than forwarded verbatim.
describe("selectProvider — forceDefaultModel fallback (minimax-compat)", () => {
  it("case L: forceDefaultModel generic as default rewrites unknown ids to defaultModel", () => {
    initRegistry([
      createGenericProvider({
        id: "minimax",
        displayName: "MiniMax M2.7",
        baseUrl: "https://api.minimaxi.com/v1",
        envKey: "MINIMAX_API_KEY",
        defaultModel: "MiniMax-M2.7",
        forceDefaultModel: true,
      }),
    ]);
    const cfg = makeConfig({
      defaultProviderId: "minimax",
      providers: { mimo: null, deepseek: null, minimax: fakeRuntime },
    });
    const sel = selectProvider("gpt-5.5", cfg);
    expect(sel.provider.id).toBe("minimax");
    expect(sel.upstreamModel).toBe("MiniMax-M2.7");
    expect(sel.rewriteNotice).not.toBeNull();
    expect(sel.rewriteNotice?.from).toBe("gpt-5.5");
    expect(sel.rewriteNotice?.to).toBe("MiniMax-M2.7");
  });

  it("case M: open-catalog generic without forceDefaultModel preserves passthrough", () => {
    initRegistry([
      createGenericProvider({
        id: "ollama",
        displayName: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        envKey: "OLLAMA_API_KEY",
        defaultModel: "qwen2.5-coder:7b",
        // forceDefaultModel intentionally not set → open-catalog passthrough
      }),
    ]);
    const cfg = makeConfig({
      defaultProviderId: "ollama",
      providers: { mimo: null, deepseek: null, ollama: fakeRuntime },
    });
    const sel = selectProvider("custom:tag", cfg);
    expect(sel.provider.id).toBe("ollama");
    // Forwarded verbatim, no rewrite
    expect(sel.upstreamModel).toBe("custom:tag");
    expect(sel.rewriteNotice).toBeNull();
  });
});
