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
import { BugOutlined, WindowsOutlined } from "@ant-design/icons";

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
  highlights: ReleaseHighlight[];
}

// ── Entries ──────────────────────────────────────────────────────────────
// Most recent first. We keep ONLY the latest version here so the in-app
// "What's new" modal stays tight — older release detail lives in
// doc/tag-log.{md,zh.md} for users who want the full history.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.5.23",
    date: "2026-06-03",
    title: {
      en: "Windows CLI launcher + provider-config fix",
      zh: "Windows CLI 启动器 + provider 配置修复",
    },
    summary: {
      en: "Run Codex CLI in an isolated profile; plus a fix for the admin UI going 404 after saving a provider with a duplicate shortcut.",
      zh: "用隔离配置跑 Codex CLI；并修复了保存重复 shortcut 的 provider 后后台变 404 的问题。",
    },
    highlights: [
      {
        kind: "new",
        icon: <WindowsOutlined />,
        title: {
          en: "Windows: isolated Codex CLI launcher",
          zh: "Windows：隔离的 Codex CLI 启动器",
        },
        description: {
          en: "Run Codex CLI against MiMo without touching the ~/.codex used by Codex Desktop — a PowerShell script uses a separate CODEX_HOME and auto-starts the proxy.",
          zh: "用 Codex CLI 经 mimo2codex 接 MiMo，又不动 Codex 桌面端的 ~/.codex——PowerShell 脚本用独立 CODEX_HOME 并自动拉起代理。",
        },
        location: { en: "scripts/codex-mimo-isolated.ps1", zh: "scripts/codex-mimo-isolated.ps1" },
      },
      {
        kind: "fixed",
        icon: <BugOutlined />,
        title: {
          en: "Saving a provider no longer breaks the admin UI",
          zh: "shortcut冲突 保存 provider 不再把后台搞挂",
        },
        description: {
          en: "A generic provider whose shortcut collided with a built-in (mimo/ds) or another provider could disable the admin database on the next start (/admin/ 404). It's now rejected at save time, and DB seeding skips duplicates instead of crashing.",
          zh: "某个 generic provider 的 shortcut 撞上内置（mimo/ds）或其它 provider 时，下次启动会让 admin 数据库不可用（/admin/ 404）。现在保存时就拦下，且 seeding 会跳过重复项而不是崩溃。",
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
