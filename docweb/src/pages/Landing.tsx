import { Link } from "react-router-dom";
import { Button, App as AntdApp } from "antd";
import {
  GithubOutlined,
  ApiOutlined,
  BranchesOutlined,
  BulbOutlined,
  ContainerOutlined,
  SearchOutlined,
  ToolOutlined,
  CheckCircleFilled,
  ArrowRightOutlined,
  DownloadOutlined,
  CodeOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import { useTranslation, Trans } from "react-i18next";
import { IMAGES } from "../assets/images";

const GITHUB_URL = "https://github.com/7as0nch/mimo2codex";
const ISSUES_URL = "https://github.com/7as0nch/mimo2codex/issues";

interface Provider {
  slug: string;
  name: string;
  tag: string;
}

const PROVIDER_GRID: Provider[] = [
  { slug: "env-setup", name: "MiMo V2.5", tag: "Xiaomi · default" },
  { slug: "env-setup", name: "DeepSeek", tag: "V3.2" },
  { slug: "kimi", name: "Kimi", tag: "Moonshot K2" },
  { slug: "minimax", name: "MiniMax", tag: "M3" },
  { slug: "sensenova", name: "SenseNova", tag: "Flash-Lite" },
];

function CodeLine({ children }: { children: string }) {
  const { message } = AntdApp.useApp();
  return (
    <div className="code-block">
      <button
        type="button"
        className="copy"
        onClick={() => {
          void navigator.clipboard.writeText(children).then(() => {
            message.success("Copied");
          });
        }}
      >
        Copy
      </button>
      {children}
    </div>
  );
}

export default function Landing() {
  const { t } = useTranslation("landing");

  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-inner">
          <div>
            <h1>{t("hero.title")}</h1>
            <p className="hero-sub">
              <Trans
                i18nKey="landing:hero.subtitle"
                components={{ 1: <strong /> }}
              />
            </p>
            {/*
              Hero quick-intro bullets. These sit between the subtitle and the
              CTA buttons so visitors get a "what is this" answer without
              having to scroll to the features section. Three lines max — any
              more and the hero becomes a wall of text.
            */}
            <ul className="hero-bullets">
              <li>
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.bullets.0")}
              </li>
              <li>
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.bullets.1")}
              </li>
              <li>
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.bullets.2")}
              </li>
            </ul>
            <div className="hero-cta">
              {/* Primary CTA is the desktop download — fastest path to a
                  working install for non-CLI users. The previous "Get Started"
                  (now demoted to secondary) leads to env-setup docs, which
                  matters more for developers who plan to install via npm. */}
              <Link to="/download">
                <Button type="primary" size="large" icon={<DownloadOutlined />}>
                  {t("hero.ctaDownload")}
                </Button>
              </Link>
              <Link to="/docs/env-setup">
                <Button size="large">
                  {t("hero.ctaPrimary")} <ArrowRightOutlined />
                </Button>
              </Link>
              <Button
                size="large"
                icon={<GithubOutlined />}
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
              >
                {t("hero.ctaSecondary")}
              </Button>
            </div>
            <div className="hero-badges">
              <span className="hero-badge">
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.badges.node")}
              </span>
              <span className="hero-badge">
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.badges.license")}
              </span>
              <span className="hero-badge">
                <CheckCircleFilled style={{ color: "#52c41a" }} />{" "}
                {t("hero.badges.openai")}
              </span>
            </div>
          </div>
          <div className="hero-image">
            <img src={IMAGES.npmInstall} alt="npm install mimo2codex demo" />
            <div className="caption">{t("hero.caption")}</div>
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────── */}
      <section className="section">
        <div className="section-inner">
          <div className="section-head">
            <h2>{t("features.title")}</h2>
            <p>{t("features.subtitle")}</p>
          </div>
          <div className="features">
            <FeatureCard
              icon={<ApiOutlined />}
              title={t("features.items.codex.title")}
              body={t("features.items.codex.body")}
            />
            <FeatureCard
              icon={<BranchesOutlined />}
              title={t("features.items.providers.title")}
              body={t("features.items.providers.body")}
            />
            <FeatureCard
              icon={<BulbOutlined />}
              title={t("features.items.thinking.title")}
              body={t("features.items.thinking.body")}
            />
            <FeatureCard
              icon={<ContainerOutlined />}
              title={t("features.items.docker.title")}
              body={t("features.items.docker.body")}
            />
            <FeatureCard
              icon={<SearchOutlined />}
              title={t("features.items.websearch.title")}
              body={t("features.items.websearch.body")}
            />
            <FeatureCard
              icon={<ToolOutlined />}
              title={t("features.items.mimoskill.title")}
              body={t("features.items.mimoskill.body")}
            />
          </div>
        </div>
      </section>

      {/* ── Showcase ──────────────────────────────────────────── */}
      <section className="section section-alt">
        <div className="section-inner">
          <div className="section-head">
            <h2>{t("showcase.title")}</h2>
            <p>{t("showcase.subtitle")}</p>
          </div>

          <div className="showcase">
            <img src={IMAGES.dashboard} alt="admin dashboard overview" />
            <div className="showcase-text">
              <h3>{t("showcase.dashboard.heading")}</h3>
              <p className="lead">{t("showcase.dashboard.lead")}</p>
              <ul>
                <li>{t("showcase.dashboard.points.0")}</li>
                <li>{t("showcase.dashboard.points.1")}</li>
                <li>{t("showcase.dashboard.points.2")}</li>
              </ul>
            </div>
          </div>

          <div className="showcase reverse">
            <img src={IMAGES.logs} alt="admin logs view with expanded request" />
            <div className="showcase-text">
              <h3>{t("showcase.logs.heading")}</h3>
              <p className="lead">{t("showcase.logs.lead")}</p>
              <ul>
                <li>{t("showcase.logs.points.0")}</li>
                <li>{t("showcase.logs.points.1")}</li>
                <li>{t("showcase.logs.points.2")}</li>
                <li>{t("showcase.logs.points.3")}</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Three deployment options ───────────────────────────── */}
      <section className="section">
        <div className="section-inner">
          <div className="section-head">
            <h2>{t("quickstart.title")}</h2>
            <p>{t("quickstart.subtitle")}</p>
          </div>
          <div className="quick-steps">
            <div className="qstep">
              <span className="qstep-num">
                <CodeOutlined />
              </span>
              <h4>{t("quickstart.steps.cli.title")}</h4>
              <p>{t("quickstart.steps.cli.body")}</p>
              <CodeLine>npm install -g mimo2codex</CodeLine>
            </div>
            <div className="qstep">
              <span className="qstep-num">
                <ContainerOutlined />
              </span>
              <h4>{t("quickstart.steps.docker.title")}</h4>
              <p>{t("quickstart.steps.docker.body")}</p>
              <Link to="/docs/auth-deployment">
                <Button type="primary" ghost>
                  {t("quickstart.steps.docker.cta")} <ArrowRightOutlined />
                </Button>
              </Link>
            </div>
            <div className="qstep">
              <span className="qstep-num">
                <DesktopOutlined />
              </span>
              <h4>{t("quickstart.steps.desktop.title")}</h4>
              <p>{t("quickstart.steps.desktop.body")}</p>
              <Link to="/download">
                <Button type="primary" icon={<DownloadOutlined />}>
                  {t("quickstart.steps.desktop.cta")}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Provider matrix ───────────────────────────────────── */}
      <section className="section section-alt">
        <div className="section-inner">
          <div className="section-head">
            <h2>{t("providers.title")}</h2>
            <p>{t("providers.subtitle")}</p>
          </div>
          <div className="provider-grid">
            {PROVIDER_GRID.map((p, i) => (
              <Link key={i} to={`/docs/${p.slug}`} className="provider-tile">
                <div className="name">{p.name}</div>
                <div className="tag">{p.tag}</div>
              </Link>
            ))}
          </div>
          <div className="provider-extra">
            <Link to="/docs/generic-providers">{t("providers.extra")} →</Link>
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────── */}
      <section className="section section-dark">
        <div className="cta-inner">
          <h2>{t("cta.title")}</h2>
          <p>{t("cta.subtitle")}</p>
          <div className="hero-cta" style={{ justifyContent: "center" }}>
            <Link to="/docs">
              <Button size="large" type="primary" ghost>
                {t("cta.primary")} <ArrowRightOutlined />
              </Button>
            </Link>
            <Button
              size="large"
              ghost
              icon={<GithubOutlined />}
              href={ISSUES_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("cta.secondary")}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="feature-card">
      <div className="feature-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
