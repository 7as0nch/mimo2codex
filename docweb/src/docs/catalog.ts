export type DocGroup =
  | "getting-started"
  | "providers"
  | "deployment"
  | "reference";

export interface DocMeta {
  slug: string;
  group: DocGroup;
  title: { en: string; zh: string };
  summary: { en: string; zh: string };
}

export const DOC_CATALOG: DocMeta[] = [
  {
    slug: "env-setup",
    group: "getting-started",
    title: {
      en: ".env Quick Setup",
      zh: "环境配置快速开始",
    },
    summary: {
      en: "Per-OS .env loader scripts and one-shot setup for macOS / Linux / Windows.",
      zh: "跨平台 .env 加载脚本与一键启动方案（macOS / Linux / Windows）。",
    },
  },
  {
    slug: "codex-enable",
    group: "getting-started",
    title: {
      en: "Codex Enable",
      zh: "Codex 接入",
    },
    summary: {
      en: "One-click model switching from the web admin console (v0.2.6+).",
      zh: "在 Web 管理控制台一键切换模型（v0.2.6+）。",
    },
  },
  {
    slug: "codex-cli-isolated-windows",
    group: "getting-started",
    title: {
      en: "Isolated Windows Codex CLI",
      zh: "Windows 隔离 Codex CLI",
    },
    summary: {
      en: "Let Codex CLI use MiMo on Windows without touching the ~/.codex used by Codex Desktop.",
      zh: "Windows 下让 Codex CLI 走 MiMo，又不动 Codex 桌面端的 ~/.codex。",
    },
  },
  {
    slug: "docker",
    group: "deployment",
    title: {
      en: "Docker Deployment",
      zh: "Docker 部署",
    },
    summary: {
      en: "Container images for amd64 and arm64; docker-compose recipes.",
      zh: "支持 amd64 与 arm64 的容器镜像；docker-compose 部署方案。",
    },
  },
  {
    slug: "auth-deployment",
    group: "deployment",
    title: {
      en: "Auth & multi-user deployment",
      zh: "鉴权与多用户部署",
    },
    summary: {
      en: "Server-mode auth, bootstrap URL, multi-user deployment (v0.2.16+).",
      zh: "Server 模式鉴权、bootstrap URL、多用户部署（v0.2.16+）。",
    },
  },
  {
    slug: "kimi",
    group: "providers",
    title: { en: "Kimi (Moonshot)", zh: "接入 Kimi（Moonshot）" },
    summary: {
      en: "Wire up Kimi K2 via the Moonshot AI API.",
      zh: "通过 Moonshot AI API 接入 Kimi K2。",
    },
  },
  {
    slug: "minimax",
    group: "providers",
    title: { en: "MiniMax", zh: "接入 MiniMax" },
    summary: {
      en: "Configure MiniMax M2 with its API quirks handled automatically.",
      zh: "配置 MiniMax M2，API 兼容性细节自动处理。",
    },
  },
  {
    slug: "sensenova",
    group: "providers",
    title: { en: "SenseNova", zh: "接入 SenseNova（商汤日日新）" },
    summary: {
      en: "SenseNova Flash-Lite gateway integration (v0.2.9+).",
      zh: "商汤日日新 Flash-Lite 网关接入（v0.2.9+）。",
    },
  },
  {
    slug: "generic-providers",
    group: "providers",
    title: {
      en: "Generic OpenAI-compatible providers",
      zh: "通用 OpenAI 兼容 Provider",
    },
    summary: {
      en: "Add any OpenAI-compatible endpoint via providers.json.",
      zh: "通过 providers.json 添加任意 OpenAI 兼容端点。",
    },
  },
  {
    slug: "mimoskill",
    group: "deployment",
    title: { en: "mimoskill", zh: "mimoskill 扩展技能" },
    summary: {
      en: "Python helper scripts (stdlib only) for OCR, image gen, pet gen.",
      zh: "纯 stdlib Python 辅助脚本（OCR / 图片生成 / Pet 生成）。",
    },
  },
  {
    slug: "proxy-faq",
    group: "reference",
    title: { en: "Proxy / Network FAQ", zh: "代理与网络 FAQ" },
    summary: {
      en: "Common proxy and network gotchas on macOS and Windows.",
      zh: "macOS 与 Windows 上常见的代理与网络问题。",
    },
  },
  {
    slug: "connector-plugins",
    group: "reference",
    title: { en: "Connector plugins", zh: "Connector 插件" },
    summary: {
      en: "Why Codex Desktop connectors (GitHub / Gmail / …) can't be proxied, and the fallback.",
      zh: "为什么 Codex 桌面端的 connector（GitHub / Gmail …）无法被代理，以及兜底方案。",
    },
  },
  {
    slug: "community-feedback",
    group: "reference",
    title: { en: "Community feedback", zh: "社区反馈" },
    summary: {
      en: "Contributor feedback that drove real changes, kept in-tree.",
      zh: "驱动了实际改动的社区反馈，保留在代码库里。",
    },
  },
  {
    slug: "tag-log",
    group: "reference",
    title: { en: "Tag log", zh: "版本标签日志" },
    summary: {
      en: "Version tags and release notes.",
      zh: "版本标签与发版记录。",
    },
  },
];

export const DOC_GROUP_ORDER: DocGroup[] = [
  "getting-started",
  "providers",
  "deployment",
  "reference",
];

export function findDoc(slug: string): DocMeta | undefined {
  return DOC_CATALOG.find((d) => d.slug === slug);
}

export function groupedDocs(): Record<DocGroup, DocMeta[]> {
  const out = {
    "getting-started": [],
    providers: [],
    deployment: [],
    reference: [],
  } as Record<DocGroup, DocMeta[]>;
  for (const doc of DOC_CATALOG) {
    out[doc.group].push(doc);
  }
  return out;
}
