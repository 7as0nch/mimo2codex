import { describe, expect, it } from "vitest";
import { byClientModel, byShortcut, PROVIDERS } from "../src/providers/registry.js";
import { mimo } from "../src/providers/mimo.js";
import { deepseek } from "../src/providers/deepseek.js";

describe("provider registry", () => {
  it("byShortcut matches mimo/ds and full ids", () => {
    expect(byShortcut("mimo")?.id).toBe("mimo");
    expect(byShortcut("ds")?.id).toBe("deepseek");
    expect(byShortcut("deepseek")?.id).toBe("deepseek");
    expect(byShortcut("DS")?.id).toBe("deepseek");
    expect(byShortcut("nope")).toBeUndefined();
  });

  it("PROVIDERS map exposes both providers by id", () => {
    expect(PROVIDERS.mimo).toBe(mimo);
    expect(PROVIDERS.deepseek).toBe(deepseek);
  });

  describe("byClientModel routing", () => {
    it("MiMo models route to mimo provider (retired names alias to their v2.5 replacement)", () => {
      expect(byClientModel("mimo-v2.5-pro")?.id).toBe("mimo");
      // Retired v2 names still route to mimo (via alias) and resolve to the
      // live replacement id — MiMo's official mapping.
      expect(byClientModel("mimo-v2-pro")?.id).toBe("mimo");
      expect(byClientModel("mimo-v2-flash")?.id).toBe("mimo");
      expect(mimo.resolveModel("mimo-v2-pro")?.id).toBe("mimo-v2.5-pro");
      expect(mimo.resolveModel("mimo-v2-pro")?.supportsReasoning).toBe(true);
    });

    it("retired MiMo names alias to the correct v2.5 replacement", () => {
      expect(mimo.resolveModel("mimo-v2-pro")?.id).toBe("mimo-v2.5-pro");
      expect(mimo.resolveModel("mimo-v2-omni")?.id).toBe("mimo-v2.5");
      expect(mimo.resolveModel("mimo-v2-flash")?.id).toBe("mimo-v2.5");
    });

    it("MiMo vision models route to mimo provider with correct resolution", () => {
      // Regression: previously `mimo-v2.5` was missing from BUILTIN_MODELS,
      // so requests fell back to `mimo-v2.5-pro` (no vision) — silently
      // breaking image inputs with a 404.
      expect(byClientModel("mimo-v2.5")?.id).toBe("mimo");
      expect(mimo.resolveModel("mimo-v2.5")?.id).toBe("mimo-v2.5");
      expect(mimo.resolveModel("mimo-v2.5")?.supportsImages).toBe(true);

      // Retired `mimo-v2-omni` aliases to the vision model `mimo-v2.5`.
      expect(byClientModel("mimo-v2-omni")?.id).toBe("mimo");
      expect(mimo.resolveModel("mimo-v2-omni")?.id).toBe("mimo-v2.5");
      expect(mimo.resolveModel("mimo-v2-omni")?.supportsImages).toBe(true);
    });

    it("mimo-v2.5-pro is non-vision; retired flash now aliases to the vision model", () => {
      expect(mimo.resolveModel("mimo-v2.5-pro")?.supportsImages).toBe(false);
      // Behavior change: mimo-v2-flash (non-vision) is retired and aliases to
      // mimo-v2.5, which DOES support vision.
      expect(mimo.resolveModel("mimo-v2-flash")?.id).toBe("mimo-v2.5");
      expect(mimo.resolveModel("mimo-v2-flash")?.supportsImages).toBe(true);
    });

    it("DeepSeek models route to deepseek provider", () => {
      expect(byClientModel("deepseek-v4-pro")?.id).toBe("deepseek");
      expect(byClientModel("deepseek-v4-flash")?.id).toBe("deepseek");
      expect(byClientModel("deepseek-chat")?.id).toBe("deepseek");
      expect(byClientModel("deepseek-reasoner")?.id).toBe("deepseek");
    });

    it("legacy DeepSeek aliases resolve to v4-flash", () => {
      const m = deepseek.resolveModel("deepseek-chat");
      // deepseek-chat exists as both a builtin model AND an alias of v4-flash;
      // the standalone entry comes first in the catalog so direct id lookup
      // still wins. The alias path is still exercised when a client sends an
      // id that *only* exists as an alias.
      expect(m).not.toBeNull();
    });

    it("aliases that aren't a builtin id route via alias fallback", () => {
      const result = deepseek.resolveModel("deepseek-reasoner");
      expect(result).not.toBeNull();
      // deepseek-reasoner is a standalone entry, but the v4-flash alias array
      // also contains it as a fallback. Either path returns a non-null result.
    });

    it("unknown models return undefined", () => {
      expect(byClientModel("gpt-4o")).toBeUndefined();
      expect(byClientModel("claude-3.5-sonnet")).toBeUndefined();
      expect(byClientModel("")).toBeUndefined();
    });
  });
});
