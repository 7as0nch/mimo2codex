import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import zhCommon from "./locales/zh-CN/common.json";
import zhNav from "./locales/zh-CN/nav.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhLogs from "./locales/zh-CN/logs.json";
import zhDashboard from "./locales/zh-CN/dashboard.json";
import zhProviders from "./locales/zh-CN/providers.json";
import zhSetup from "./locales/zh-CN/setup.json";
import zhModels from "./locales/zh-CN/models.json";
import zhCodexEnable from "./locales/zh-CN/codexEnable.json";
import zhSessions from "./locales/zh-CN/sessions.json";
import zhKeyBanner from "./locales/zh-CN/keyBanner.json";
import zhUpdate from "./locales/zh-CN/update.json";
import zhTour from "./locales/zh-CN/tour.json";
import zhAuth from "./locales/zh-CN/auth.json";
import zhDataDir from "./locales/zh-CN/dataDir.json";
import zhWhatsNew from "./locales/zh-CN/whatsNew.json";
import zhPlugins from "./locales/zh-CN/plugins.json";
import zhComputerUse from "./locales/zh-CN/computeruse.json";
import enCommon from "./locales/en-US/common.json";
import enNav from "./locales/en-US/nav.json";
import enSettings from "./locales/en-US/settings.json";
import enLogs from "./locales/en-US/logs.json";
import enDashboard from "./locales/en-US/dashboard.json";
import enProviders from "./locales/en-US/providers.json";
import enSetup from "./locales/en-US/setup.json";
import enModels from "./locales/en-US/models.json";
import enCodexEnable from "./locales/en-US/codexEnable.json";
import enSessions from "./locales/en-US/sessions.json";
import enKeyBanner from "./locales/en-US/keyBanner.json";
import enUpdate from "./locales/en-US/update.json";
import enTour from "./locales/en-US/tour.json";
import enAuth from "./locales/en-US/auth.json";
import enDataDir from "./locales/en-US/dataDir.json";
import enWhatsNew from "./locales/en-US/whatsNew.json";
import enPlugins from "./locales/en-US/plugins.json";
import enComputerUse from "./locales/en-US/computeruse.json";

export const SUPPORTED_LANGS = ["zh-CN", "en-US"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: SupportedLang = "zh-CN";

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": {
      common: zhCommon,
      nav: zhNav,
      settings: zhSettings,
      logs: zhLogs,
      dashboard: zhDashboard,
      providers: zhProviders,
      setup: zhSetup,
      models: zhModels,
      codexEnable: zhCodexEnable,
      sessions: zhSessions,
      keyBanner: zhKeyBanner,
      update: zhUpdate,
      tour: zhTour,
      auth: zhAuth,
      dataDir: zhDataDir,
      whatsNew: zhWhatsNew,
      plugins: zhPlugins,
      computeruse: zhComputerUse,
    },
    "en-US": {
      common: enCommon,
      nav: enNav,
      settings: enSettings,
      logs: enLogs,
      dashboard: enDashboard,
      providers: enProviders,
      setup: enSetup,
      models: enModels,
      codexEnable: enCodexEnable,
      sessions: enSessions,
      keyBanner: enKeyBanner,
      update: enUpdate,
      tour: enTour,
      auth: enAuth,
      dataDir: enDataDir,
      whatsNew: enWhatsNew,
      plugins: enPlugins,
      computeruse: enComputerUse,
    },
  },
  lng: DEFAULT_LANG,
  fallbackLng: DEFAULT_LANG,
  defaultNS: "common",
  ns: [
    "common",
    "nav",
    "settings",
    "logs",
    "dashboard",
    "providers",
    "setup",
    "models",
    "codexEnable",
    "sessions",
    "keyBanner",
    "update",
    "tour",
    "auth",
    "dataDir",
    "whatsNew",
    "plugins",
    "computeruse",
  ],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  missingKeyHandler: (lngs, ns, key) => {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] missing key: ${ns}:${key} for ${lngs.join(",")}`);
  },
  saveMissing: true,
});

export default i18n;
