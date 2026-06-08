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
import { BugOutlined } from "@ant-design/icons";

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
    version: "0.5.24",
    date: "2026-06-07",
    title: {
      en: "No more “stream disconnected” on long sessions / images",
      zh: "长会话 / 图片不再「stream disconnected」断流",
    },
    summary: {
      en: "Fixes streams disconnecting on large contexts and image uploads, and makes the request-body cap configurable.",
      zh: "修复大上下文与上传图片导致的断流，并让请求体上限可配置。",
    },
    highlights: [
      {
        kind: "fixed",
        icon: <BugOutlined />,
        title: {
          en: "Fewer “stream disconnected” drops on big contexts / images",
          zh: "大上下文 / 图片导致的「stream disconnected」断流更少",
        },
        description: {
          en: "Long prefills (large conversations or base64 images) used to outrun Node's 300s upstream timeout, disconnecting the stream. The upstream timeout is now 10 min and configurable, timeouts no longer retry-storm, and the proxy keeps the connection alive with keepalives during prefill.",
          zh: "长 prefill（大会话或 base64 图片）过去会超过 Node 默认的 300s 上游超时而断流。现在上游超时改为 10 分钟且可配置，超时不再重试风暴，prefill 期间代理用 keepalive 保活连接。",
        },
        location: {
          en: "Tune via MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS / _BODY_TIMEOUT_MS (0 = off)",
          zh: "可用 MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS / _BODY_TIMEOUT_MS 调整（0 = 关闭）",
        },
      },
      {
        kind: "fixed",
        icon: <BugOutlined />,
        title: {
          en: "Large image uploads no longer disconnect",
          zh: "上传超大图片不再断连",
        },
        description: {
          en: "The request-body cap was a hard-coded 16MB and overflow killed the socket mid-upload (seen by Codex as a connection error). It's now 64MB by default and configurable, and overflow returns a clean 413 instead.",
          zh: "请求体上限原本硬编码 16MB，超限会在上传途中断开套接字（Codex 看到的是连接错误）。现在默认 64MB 且可配置，超限改为返回干净的 413。",
        },
        location: {
          en: "Tune via MIMO2CODEX_MAX_REQUEST_BODY_MB",
          zh: "可用 MIMO2CODEX_MAX_REQUEST_BODY_MB 调整",
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
