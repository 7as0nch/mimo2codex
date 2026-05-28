import { useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  Navigate,
} from "react-router-dom";
import { ConfigProvider, Layout, Menu, theme as antdTheme } from "antd";
import type { MenuProps } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { useTranslation } from "react-i18next";
import {
  AppstoreOutlined,
  CodeOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  UserOutlined,
} from "@ant-design/icons";

import { api } from "./api/client";
import { AppConfigProvider, useAppConfig } from "./contexts/AppConfigContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppHeader } from "./components/AppHeader";
import { UpdateBanner } from "./components/UpdateBanner";
import { RestartRequiredBanner } from "./components/RestartRequiredBanner";
import { WhatsNewModal } from "./components/WhatsNewModal";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Logs } from "./pages/logs";
import { Providers } from "./pages/providers";
import { CodexEnable } from "./pages/codex";
import { LoginPage } from "./pages/Login";
import { BootstrapPage } from "./pages/Bootstrap";
import { AccountPage } from "./pages/Account";
import { RegisterPage } from "./pages/Register";
import { UsersPage } from "./pages/Users";
import { Spin } from "antd";
import { TeamOutlined } from "@ant-design/icons";

const GITHUB_REPO = "https://github.com/7as0nch/mimo2codex";
const { Sider, Content, Footer: AntFooter } = Layout;

interface MenuEntry {
  path: string;
  key: keyof MenuLabels;
  icon: React.ReactNode;
  element: React.ReactNode;
}

interface MenuLabels {
  dashboard: string;
  codexEnable: string;
  providers: string;
  models: string;
  logs: string;
}

const MENU: MenuEntry[] = [
  { path: "/", key: "dashboard", icon: <DashboardOutlined />, element: <Dashboard /> },
  { path: "/codex", key: "codexEnable", icon: <CodeOutlined />, element: <CodexEnable /> },
  { path: "/providers", key: "providers", icon: <AppstoreOutlined />, element: <Providers /> },
  { path: "/models", key: "models", icon: <DatabaseOutlined />, element: <Models /> },
  { path: "/logs", key: "logs", icon: <FileTextOutlined />, element: <Logs /> },
];

export function App() {
  return (
    <AppConfigProvider>
      <AuthProvider>
        <ThemedRoot />
      </AuthProvider>
    </AppConfigProvider>
  );
}

function ThemedRoot() {
  const { resolvedTheme, lang } = useAppConfig();
  const algorithm =
    resolvedTheme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm;
  const antdLocale = lang === "en-US" ? enUS : zhCN;

  return (
    <ConfigProvider
      theme={{ algorithm, cssVar: true, hashed: false }}
      locale={antdLocale}
    >
      <BrowserRouter basename="/admin">
        <AuthGate />
      </BrowserRouter>
    </ConfigProvider>
  );
}

// Routes the user to the correct top-level surface based on the resolved auth
// state. Order matters:
//   1. While the /auth/me probe is in-flight we show a spinner instead of
//      flashing the login form for an instant on every page load.
//   2. authMode='on' + no users yet → bootstrap page (first-run setup).
//   3. authMode='on' + not logged in → login page.
//   4. Anything else (local mode OR logged-in server mode) → main shell.
function AuthGate() {
  const { loading, authMode, user, needsBootstrap } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Spin size="large" />
      </div>
    );
  }
  if (authMode === "on" && needsBootstrap) return <BootstrapPage />;
  if (authMode === "on" && !user) {
    // Allow the register page through even without a session; RegisterPage
    // itself surfaces a "disabled" notice when open registration is off.
    if (location.pathname === "/register") return <RegisterPage />;
    return <LoginPage />;
  }
  return <Shell />;
}

function Shell() {
  const { t } = useTranslation("nav");
  const { t: tAuth } = useTranslation("auth");
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const items: MenuProps["items"] = useMemo(() => {
    const base = MENU.map((m) => ({ key: m.path, icon: m.icon, label: t(m.key) }));
    if (user) {
      base.push({ key: "/account", icon: <UserOutlined />, label: tAuth("header.account") });
    }
    if (user?.is_admin) {
      base.push({ key: "/users", icon: <TeamOutlined />, label: tAuth("users.navLabel") });
    }
    return base;
  }, [t, tAuth, user]);

  // Pick the menu item that the current location belongs to. We iterate over
  // the dynamic items list (not just MENU) so /account and /users — only
  // added for some users — also light up the right entry. Sort by length
  // descending so the longest prefix wins (e.g. "/users" before "/").
  const selectedKey = useMemo(() => {
    // Defensive basename strip: react-router v6 normally hides /admin/ but
    // some history adapters leak it through and break the prefix match.
    let path = location.pathname || "/";
    if (path.startsWith("/admin/")) path = path.slice("/admin".length);
    if (path === "/admin") path = "/";
    if (path === "/") return "/";
    const keys = items
      .map((it) => (it as { key?: string })?.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0 && k !== "/")
      .sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (path === k || path.startsWith(k + "/")) return k;
    }
    return "/";
  }, [location.pathname, items]);

  return (
    <Layout style={{ height: "100vh", overflow: "hidden" }}>
      <Sider
        width={220}
        breakpoint="lg"
        collapsedWidth={64}
        style={{ height: "100vh", overflow: "auto" }}
      >
        <div
          style={{
            color: "rgba(255,255,255,0.95)",
            padding: "16px 20px",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          {t("title")}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={(info) => navigate(info.key)}
          style={{ borderInlineEnd: 0 }}
        />
      </Sider>
      <Layout style={{ height: "100vh" }}>
        <AppHeader />
        <Content
          style={{
            padding: "24px 28px",
            overflow: "auto",
            flex: "1 1 auto",
            minHeight: 0,
          }}
        >
          <RestartRequiredBanner />
          <UpdateBanner />
          <WhatsNewModal />
          <Routes>
            {MENU.map((m) => (
              <Route key={m.path} path={m.path} element={m.element} />
            ))}
            <Route path="/account" element={<AccountPage />} />
            <Route
              path="/users"
              element={user?.is_admin ? <UsersPage /> : <Navigate to="/" replace />}
            />
            {/* /register / /login are AuthGate-handled; for already-logged-in
                users hitting these paths, fall back to dashboard. */}
            <Route path="/register" element={<Navigate to="/" replace />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
        <AppFooter />
      </Layout>
    </Layout>
  );
}

function AppFooter() {
  const { t } = useTranslation();
  const { t: tUpdate } = useTranslation("update");
  const { versionInfo, forceCheckVersion } = useAppConfig();
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    api
      .health()
      .then((h) => setVersion(h.version))
      .catch(() => {
        /* footer is best-effort */
      });
  }, []);
  const onCheckNow = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    try {
      await forceCheckVersion();
    } finally {
      setChecking(false);
    }
  };
  const year = new Date().getFullYear();
  const showUpdateDot =
    versionInfo?.hasUpdate &&
    !versionInfo.preferences.effectivelyDismissed &&
    !versionInfo.preferences.updateCheckDisabled;
  return (
    <AntFooter style={{ textAlign: "center", padding: "16px 24px" }}>
      <div>
        <strong>mimo2codex</strong>
        {version && (
          <span style={{ marginLeft: 6, opacity: 0.65 }}>
            v{version}
            {showUpdateDot && (
              <span
                title={tUpdate("footer.updateAvailable", { latest: versionInfo?.latest })}
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#faad14",
                  marginLeft: 6,
                  verticalAlign: "middle",
                }}
              />
            )}
          </span>
        )}{" "}
        · © {year} ·{" "}
        <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noreferrer noopener">
          {t("footer.license")}
        </a>
        <span style={{ marginLeft: 12 }}>
          <a href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          {" · "}
          <a href={`${GITHUB_REPO}/issues`} target="_blank" rel="noreferrer noopener">
            {t("footer.feedback")}
          </a>
          {" · "}
          <a
            href="https://mimodoc.chengj.online/"
            target="_blank"
            rel="noreferrer noopener"
            title={t("footer.docsTooltip")}
            style={{ fontWeight: 500 }}
          >
            📖 {t("footer.docs")}
          </a>
          {" · "}
          <a
            onClick={(e) => {
              e.preventDefault();
              void onCheckNow();
            }}
            href="#"
            style={{ opacity: checking ? 0.5 : 1 }}
            title={
              versionInfo?.checkedAt
                ? `${tUpdate("footer.lastChecked")}: ${new Date(versionInfo.checkedAt).toLocaleString()}`
                : undefined
            }
          >
            {checking ? tUpdate("footer.checking") : tUpdate("footer.checkNow")}
          </a>
        </span>
      </div>
    </AntFooter>
  );
}
