import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en-US/common.json";
import enLanding from "./locales/en-US/landing.json";
import enDocs from "./locales/en-US/docs.json";
import enIdeas from "./locales/en-US/ideas.json";
import enDownload from "./locales/en-US/download.json";
import enPlugins from "./locales/en-US/plugins.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhLanding from "./locales/zh-CN/landing.json";
import zhDocs from "./locales/zh-CN/docs.json";
import zhIdeas from "./locales/zh-CN/ideas.json";
import zhDownload from "./locales/zh-CN/download.json";
import zhPlugins from "./locales/zh-CN/plugins.json";

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, landing: enLanding, docs: enDocs, ideas: enIdeas, download: enDownload, plugins: enPlugins },
    zh: { common: zhCommon, landing: zhLanding, docs: zhDocs, ideas: zhIdeas, download: zhDownload, plugins: zhPlugins },
  },
  lng: "zh",
  fallbackLng: "en",
  defaultNS: "common",
  ns: ["common", "landing", "docs", "ideas", "download", "plugins"],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export default i18n;
