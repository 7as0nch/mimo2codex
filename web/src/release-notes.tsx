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
import {
  CloudDownloadOutlined,
  DesktopOutlined,
  FileTextOutlined,
  ToolOutlined,
} from "@ant-design/icons";

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
    version: "0.5.21",
    date: "2026-05-30",
    title: {
      en: "MiMo Computer Use plugin",
      zh: "MiMo Computer Use 插件",
    },
    summary: {
      en: "A built-in Codex MCP plugin for local desktop control, with Admin toggles, env locking, adapter detection, and guided install.",
      zh: "新增内置 Codex MCP 电脑控制插件，支持后台开关、环境变量锁定、adapter 检测与引导安装。",
    },
    highlights: [
      {
        kind: "new",
        icon: <DesktopOutlined />,
        title: { en: "MiMo Computer Use plugin", zh: "MiMo Computer Use 插件" },
        description: {
          en: "A new isolated Codex MCP plugin lets MiMo-compatible models drive macOS/Windows through detected or guided-installed adapters.",
          zh: "新增独立 Codex MCP 插件，让 MiMo 兼容模型通过检测或引导安装的 adapter 操控 macOS / Windows。",
        },
        location: { en: "plugins/mimo-computer-use", zh: "plugins/mimo-computer-use" },
      },
      {
        kind: "new",
        icon: <ToolOutlined />,
        title: { en: "Plugins page + MIMO2CODEX_PLUGIN", zh: "插件页 + MIMO2CODEX_PLUGIN" },
        description: {
          en: "Enable built-in plugins from Admin → Plugins, or lock CLI, desktop, and Docker deployments with MIMO2CODEX_PLUGIN.",
          zh: "可在 Admin → 插件 启用内置插件，也可用 MIMO2CODEX_PLUGIN 锁定命令行、桌面端和 Docker 部署。",
        },
        location: { en: "Left nav → Plugins", zh: "左侧导航 → 插件" },
        ctaLabel: { en: "Open", zh: "打开" },
        ctaPath: "/plugins",
      },
      {
        kind: "new",
        icon: <CloudDownloadOutlined />,
        title: { en: "First-use adapter install", zh: "首次 adapter 检测与安装" },
        description: {
          en: "Run npm run doctor / install-adapter, or let the MCP tool install Peekaboo on macOS and Windows-MCP on Windows with visible progress.",
          zh: "可运行 npm run doctor / install-adapter，也可让 MCP 工具安装 macOS Peekaboo 或 Windows-MCP 并显示进度。",
        },
      },
      {
        kind: "doc",
        icon: <FileTextOutlined />,
        title: { en: "Detailed plugin guide", zh: "插件详细说明" },
        description: {
          en: "New docs cover architecture, Admin/env enablement, mimoskill setup, packaging, and troubleshooting.",
          zh: "新增文档说明架构、Admin/env 启用、mimoskill 流程、打包方式与故障排查。",
        },
        location: { en: "doc/mimo-computer-use-plugin.zh.md", zh: "doc/mimo-computer-use-plugin.zh.md" },
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
