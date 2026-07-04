// Release notes shown in the "What's New" modal on admin first-load after a
// version bump. Maintained as a hand-rolled data file (TSX, not JSON, so we
// can drop in icons and the occasional ReactNode without losing TS safety).
//
// How to add an entry when you ship a new version:
//   1. Bump package.json `version` (via `npm run release:patch` etc.).
//   2. Update doc/tag-log{,.zh}.md as before (the WhatsNew modal complements
//      tag-log, it does not replace it).
//   3. Prepend a new `ReleaseNote` to RELEASE_NOTES below. Most recent first.
//      The modal auto-shows it to users whose lastSeenVersion is below it.
//
// Keep entries user-facing and SHORT — one line per change. The full prose
// lives in doc/tag-log.{md,zh.md}; here we mirror every tag-log change briefly
// so the modal stays scannable. We keep ONLY the latest version's entry.

import type { ReactNode } from "react";

export interface BilingualText {
  en: string;
  zh: string;
}

export interface ReleaseHighlight {
  icon?: ReactNode;
  /** Section badge: "new" | "improved" | "fixed" | "doc" */
  kind?: "new" | "improved" | "fixed" | "doc";
  title: BilingualText;
  description: BilingualText;
  /** Plain-text breadcrumb so users can find the new feature themselves. */
  location?: BilingualText;
  /** Optional CTA. ctaPath wins → react-router navigate; else ctaHref opens new tab. */
  ctaLabel?: BilingualText;
  ctaPath?: string;
  ctaHref?: string;
}

export interface ReleaseNote {
  version: string; // semver "0.4.2"
  date: string;    // "2026-05-21" ISO
  title: BilingualText;
  summary?: BilingualText;
  /** Optional hero image for the release (shown under the summary). */
  image?: { src: string; alt: BilingualText };
  highlights: ReleaseHighlight[];
}

// ── Entries ──────────────────────────────────────────────────────────────
// Most recent first. We keep ONLY the latest version here so the in-app
// "What's new" modal stays tight — older release detail lives in
// doc/tag-log.{md,zh.md} for users who want the full history.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.5.29",
    date: "2026-07-04",
    title: {
      en: "MiMo v2 models retired — old names now auto-upgrade to v2.5",
      zh: "MiMo v2 模型下线——旧模型名自动升级到 v2.5",
    },
    summary: {
      en: "MiMo took its v2 models offline (2026-06-30). mimo2codex transparently maps the old names to their v2.5 replacements, so your existing config keeps working — no edits needed.",
      zh: "MiMo 已下线 v2 代模型(2026-06-30)。mimo2codex 会把旧模型名透明映射到对应的 v2.5 替代模型,你现有的配置无需修改即可继续使用。",
    },
    highlights: [
      {
        kind: "improved",
        title: {
          en: "Retired MiMo v2 names transparently upgrade to v2.5",
          zh: "退役的 MiMo v2 模型名透明升级到 v2.5",
        },
        description: {
          en: "MiMo retired mimo-v2-pro / mimo-v2-omni / mimo-v2-flash on 2026-06-30 — requests with those names now error upstream. mimo2codex maps them to their official replacements automatically: mimo-v2-pro → mimo-v2.5-pro, and mimo-v2-omni / mimo-v2-flash → mimo-v2.5. If your Codex config still uses an old name it keeps working and hits the right model, and the model list now shows only the current v2.5 models. Note: mimo-v2-flash's replacement (mimo-v2.5) thinks by default and supports images.",
          zh: "MiMo 已于 2026-06-30 下线 mimo-v2-pro / mimo-v2-omni / mimo-v2-flash——用这些名字请求会在上游报错。mimo2codex 会自动映射到官方替代模型:mimo-v2-pro → mimo-v2.5-pro,mimo-v2-omni / mimo-v2-flash → mimo-v2.5。如果你的 Codex 配置还在用旧名,也能继续用并命中正确模型,模型列表现在只显示在线的 v2.5 模型。注意:mimo-v2-flash 的替代模型(mimo-v2.5)默认开启思考且支持图片。",
        },
        location: {
          en: "Models page (catalog) & Codex Enable page → model selection",
          zh: "「模型」页(目录)与「Codex 启用」页 → 模型选择",
        },
        ctaLabel: { en: "Open Models", zh: "打开模型页" },
        ctaPath: "/models",
      },
      {
        kind: "fixed",
        title: {
          en: "Thinking mode now drops top_p too (matches MiMo v2.5)",
          zh: "思考模式现在也会去掉 top_p(与 MiMo v2.5 一致)",
        },
        description: {
          en: "In thinking mode the MiMo v2.5 models ignore custom temperature and top_p (the server forces 1.0 / 0.95). mimo2codex previously only stripped temperature; it now strips top_p as well, so your request matches what the model actually runs.",
          zh: "在思考模式下,MiMo v2.5 系列会忽略自定义的 temperature 和 top_p(服务端强制为 1.0 / 0.95)。mimo2codex 此前只去掉了 temperature,现在也会去掉 top_p,让请求与模型实际运行保持一致。",
        },
      },
    ],
  },
];

// ── Semver compare ────────────────────────────────────────────────────────
export function compareVersion(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^v/, "").split(".").map((n) => {
      const m = /^(\d+)/.exec(n);
      return m ? parseInt(m[1], 10) : 0;
    });
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

// Releases the user has not yet acknowledged, capped at the running version
// (so a release-notes.tsx entry for a *future* version doesn't leak through).
export function unseenReleases(
  lastSeen: string | null,
  current: string,
): ReleaseNote[] {
  const baseline = lastSeen ?? "0.0.0";
  return RELEASE_NOTES.filter(
    (n) =>
      compareVersion(n.version, baseline) > 0 &&
      compareVersion(n.version, current) <= 0,
  );
}
