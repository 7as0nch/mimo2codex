import { Card, Tag, Space, Typography, Button, Divider } from "antd";
import { DesktopOutlined, HeartOutlined, RightOutlined, AppstoreOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface Bi {
  en: string;
  zh: string;
}
interface PluginEntry {
  id: string;
  name: string;
  version: string;
  builtin: boolean;
  category: Bi;
  blurb: Bi;
  caps: Bi[];
}

// Built-in plugins shipped with mimo2codex. Versioned just like the desktop app
// (the version lives in plugins/<id>/package.json — keep this in sync on bump).
const PLUGINS: PluginEntry[] = [
  {
    id: "mimo-computer-use",
    name: "MiMo Computer Use",
    version: "0.2.0",
    builtin: true,
    category: { en: "Computer Use", zh: "电脑控制" },
    blurb: {
      en: "Let MiMo / DeepSeek / any OpenAI-compatible model operate the desktop — click, type, scroll, screenshot. Pure Node (nut.js): just npm install, no Trope CUA, no Xcode/.NET toolchain. Vision models act on the screenshot; text-only models act on OCR'd text targets. An optional Electron overlay draws a glowing cursor on the real desktop, and an admin Monitor page streams the AI's actions live.",
      zh: "让 MiMo / DeepSeek / 任意 OpenAI 兼容模型操作桌面——点击、输入、滚动、截图。纯 Node（nut.js）：npm install 即可，无需 Trope CUA、无需 Xcode/.NET 工具链。视觉模型看截图操作，纯文本模型靠 OCR 文字坐标操作。可选 Electron overlay 在真实桌面显示发光光标，管理台还有实时监看页。",
    },
    caps: [
      { en: "Mouse / keyboard / screenshot via nut.js", zh: "nut.js 鼠标 / 键盘 / 截图" },
      { en: "A+C perception (vision image + OCR coordinates)", zh: "A+C 感知（视觉截图 + OCR 坐标）" },
      { en: "Glowing desktop cursor (optional Electron)", zh: "真实桌面发光光标（可选 Electron）" },
      { en: "Live admin Monitor page", zh: "管理台实时监看页" },
    ],
  },
];

export default function Plugins() {
  const { t, i18n } = useTranslation("plugins");
  const lang: "en" | "zh" = i18n.language.startsWith("zh") ? "zh" : "en";

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <AppstoreOutlined style={{ fontSize: 44, color: "#4f46e5" }} />
        <Typography.Title level={2} style={{ marginBottom: 4, marginTop: 12 }}>
          {t("title")}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 16 }}>
          {t("subtitle")}
        </Typography.Paragraph>
      </div>

      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {PLUGINS.map((p) => (
          <Card key={p.id}>
            <Space align="start" size={16} style={{ width: "100%" }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  flexShrink: 0,
                  borderRadius: 14,
                  background: "linear-gradient(135deg,#6366f1,#4f46e5)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 26,
                }}
              >
                <DesktopOutlined />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space wrap align="center" size={8}>
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    {p.name}
                  </Typography.Title>
                  <Tag color="blue">v{p.version}</Tag>
                  {p.builtin && <Tag color="purple">{t("builtin")}</Tag>}
                  <Tag>{p.category[lang]}</Tag>
                </Space>
                <Typography.Paragraph style={{ marginTop: 10, marginBottom: 10 }}>
                  {p.blurb[lang]}
                </Typography.Paragraph>
                <Space wrap size={6}>
                  {p.caps.map((c) => (
                    <Tag key={c.en} bordered={false} style={{ background: "#f5f5ff", color: "#4f46e5" }}>
                      {c[lang]}
                    </Tag>
                  ))}
                </Space>
                <Divider style={{ margin: "14px 0" }} />
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {t("enableHint")}
                </Typography.Text>
              </div>
            </Space>
          </Card>
        ))}

        {/* Contribution CTA — routes to the idea-submission page. */}
        <Card style={{ borderStyle: "dashed" }}>
          <Space align="start" size={16} style={{ width: "100%" }}>
            <div
              style={{
                width: 56,
                height: 56,
                flexShrink: 0,
                borderRadius: 14,
                background: "#fff0f6",
                color: "#eb2f96",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
              }}
            >
              <HeartOutlined />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {t("contribute.title")}
              </Typography.Title>
              <Typography.Paragraph style={{ marginTop: 10, marginBottom: 12 }}>
                {t("contribute.desc")}
              </Typography.Paragraph>
              <Link to="/ideas/new">
                <Button type="primary" icon={<HeartOutlined />}>
                  {t("contribute.cta")} <RightOutlined />
                </Button>
              </Link>
            </div>
          </Space>
        </Card>
      </Space>
    </div>
  );
}
