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
import { BugOutlined, WindowsOutlined, DesktopOutlined, ThunderboltOutlined, AppstoreOutlined } from "@ant-design/icons";

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
      en: "Computer Use, now pure Node (no Trope CUA)",
      zh: "Computer Use 改为纯 Node（不再依赖 Trope CUA）",
    },
    summary: {
      en: "The computer-use plugin is rewritten on nut.js — just npm install, no compiler. Optional glowing on-desktop cursor and a live Monitor page. Plus a Windows CLI launcher and a provider-config fix.",
      zh: "computer-use 插件用 nut.js 重写——npm install 即可，无需编译。可选真实桌面发光光标与实时监看页。另含 Windows CLI 启动器与 provider 配置修复。",
    },
    highlights: [
      {
        kind: "new",
        icon: <DesktopOutlined />,
        title: {
          en: "Computer Use rewritten in pure Node (nut.js)",
          zh: "Computer Use 插件改为纯 Node（nut.js）",
        },
        description: {
          en: "No more Trope CUA / Xcode / .NET build. nut.js drives mouse, keyboard and screenshots. Vision models act on the screenshot; text-only models act on OCR'd targets with click coordinates.",
          zh: "不再需要 Trope CUA / Xcode / .NET 编译。nut.js 直接操作鼠标、键盘与截图。视觉模型看截图操作，纯文本模型靠 OCR 文字坐标操作。",
        },
        location: { en: "Plugins → MiMo Computer Use", zh: "插件 → MiMo Computer Use" },
        ctaLabel: { en: "Open Plugins", zh: "打开插件页" },
        ctaPath: "/plugins",
      },
      {
        kind: "new",
        icon: <ThunderboltOutlined />,
        title: {
          en: "Glowing desktop cursor + live Monitor",
          zh: "桌面发光光标 + 实时监看页",
        },
        description: {
          en: "Optionally install Electron for a glowing cursor + click ripples on the real desktop (with a Stop/Resume control). The new Computer Use Monitor page streams the AI's actions live — no Electron required.",
          zh: "可选安装 Electron，在真实桌面显示发光光标 + 点击波纹（含停止/恢复按钮）。新的「Computer Use 监看」页实时显示 AI 操作——不装 Electron 也能看。",
        },
        location: { en: "Computer Use Monitor (left nav)", zh: "左侧导航 → Computer Use 监看" },
        ctaLabel: { en: "Open Monitor", zh: "打开监看页" },
        ctaPath: "/computer-use",
      },
      {
        kind: "improved",
        icon: <AppstoreOutlined />,
        title: {
          en: "Plugins page is now a card marketplace",
          zh: "插件页改成卡片市场",
        },
        description: {
          en: "Browse plugins as cards and click one for a detail drawer (enable, install deps, open the Monitor). A \"Contribute a plugin\" card links to docweb, which also has a new Plugins page listing the built-in plugin with its version.",
          zh: "插件以卡片网格浏览，点开右侧详情抽屉（启用、安装依赖、打开监看页）。新增「欢迎投稿插件」卡链接到 docweb——docweb 也有了新的插件页，列出自带插件及其版本号。",
        },
        location: { en: "Plugins (left nav)", zh: "左侧导航 → 插件" },
        ctaLabel: { en: "Open Plugins", zh: "打开插件页" },
        ctaPath: "/plugins",
      },
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
