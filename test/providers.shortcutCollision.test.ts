import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSpecsToFile,
  readSpecsFromFile,
  GenericLoaderError,
} from "../src/providers/genericLoader.js";
import { dedupeProvidersByShortcut } from "../src/db/index.js";
import type { GenericProviderSpec } from "../src/providers/generic.js";

// issue #63: providers.shortcut is UNIQUE, but nothing used to prevent a
// generic provider from claiming a shortcut already taken by a built-in
// (mimo / ds) or another generic. That let a bad providers.json save cleanly,
// then crash the next DB seed and disable admin (/admin/ 404).

function spec(
  over: Partial<GenericProviderSpec> & { id: string }
): GenericProviderSpec {
  return {
    baseUrl: "https://example.com/v1",
    envKey: `${over.id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    defaultModel: "m",
    ...over,
  };
}

function withTmp(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "m2c-shortcut-"));
  try {
    fn(join(dir, "providers.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeSpecsToFile — shortcut collision guard (issue #63)", () => {
  it("rejects a generic shortcut colliding with built-in mimo", () => {
    withTmp((f) =>
      expect(() =>
        writeSpecsToFile(f, [spec({ id: "x", shortcut: "mimo" })])
      ).toThrow(GenericLoaderError)
    );
  });

  it("rejects a generic shortcut colliding with built-in deepseek (ds)", () => {
    withTmp((f) =>
      expect(() =>
        writeSpecsToFile(f, [spec({ id: "x", shortcut: "ds" })])
      ).toThrow(GenericLoaderError)
    );
  });

  it("rejects two generics sharing the same shortcut", () => {
    withTmp((f) =>
      expect(() =>
        writeSpecsToFile(f, [
          spec({ id: "a", shortcut: "dup" }),
          spec({ id: "b", shortcut: "dup" }),
        ])
      ).toThrow(GenericLoaderError)
    );
  });

  it("rejects an omitted shortcut (defaults to id) that collides with another's explicit shortcut", () => {
    withTmp((f) =>
      // "b" has no shortcut → defaults to its id "b"; "a" explicitly took "b".
      expect(() =>
        writeSpecsToFile(f, [
          spec({ id: "a", shortcut: "b" }),
          spec({ id: "b" }),
        ])
      ).toThrow(GenericLoaderError)
    );
  });

  it("accepts unique shortcuts", () => {
    withTmp((f) =>
      expect(() =>
        writeSpecsToFile(f, [
          spec({ id: "a", shortcut: "qa" }),
          spec({ id: "b", shortcut: "qb" }),
        ])
      ).not.toThrow()
    );
  });
});

describe("readSpecsFromFile — kimi enhanceErrorPreset (was silently dropped)", () => {
  it("keeps enhanceErrorPreset: \"kimi\" through a write/read round-trip", () => {
    withTmp((f) => {
      writeSpecsToFile(f, [
        spec({ id: "kimi-x", features: { enhanceErrorPreset: "kimi" } }),
      ]);
      const read = readSpecsFromFile(f);
      expect(read[0].features?.enhanceErrorPreset).toBe("kimi");
    });
  });
});

describe("dedupeProvidersByShortcut (issue #63 seeding guard)", () => {
  it("keeps the first, skips later duplicates with conflict info", () => {
    const { kept, skipped } = dedupeProvidersByShortcut([
      { id: "a", shortcut: "s1" },
      { id: "b", shortcut: "s2" },
      { id: "c", shortcut: "s1" },
    ]);
    expect(kept.map((p) => p.id)).toEqual(["a", "b"]);
    expect(skipped).toEqual([
      { provider: { id: "c", shortcut: "s1" }, conflictsWith: "a" },
    ]);
  });

  it("returns everything when there is no collision", () => {
    const { kept, skipped } = dedupeProvidersByShortcut([
      { id: "a", shortcut: "s1" },
      { id: "b", shortcut: "s2" },
    ]);
    expect(kept).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });
});
