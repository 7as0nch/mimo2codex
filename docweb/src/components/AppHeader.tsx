import { NavLink, Link } from "react-router-dom";
import { Button, Space } from "antd";
import { GithubOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import LanguageSwitch from "./LanguageSwitch";

const GITHUB_URL = "https://github.com/7as0nch/mimo2codex";

export default function AppHeader() {
  const { t } = useTranslation("common");
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">m2</span>
        <span>{t("brand")}</span>
      </Link>
      <nav className="nav">
        <NavLink to="/" end>
          {t("nav.home")}
        </NavLink>
        <NavLink to="/docs">{t("nav.docs")}</NavLink>
        <NavLink to="/plugins">{t("nav.plugins")}</NavLink>
        <NavLink to="/download">{t("nav.download")}</NavLink>
        <NavLink to="/ideas">{t("nav.ideas")}</NavLink>
      </nav>
      <div className="spacer" />
      <Space className="actions" size={10}>
        <LanguageSwitch />
        <Button
          icon={<GithubOutlined />}
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </Button>
      </Space>
    </header>
  );
}
