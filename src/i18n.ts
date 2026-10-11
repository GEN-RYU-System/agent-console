import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import saJa from "@sa/locales/ja.json";
import appJa from "./locales/ja.json";

type Dict = { [key: string]: string | Dict };

function deepMerge(base: Dict, extra: Dict): Dict {
  const out: Dict = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      typeof value === "object" && typeof current === "object" ? deepMerge(current as Dict, value as Dict) : value;
  }
  return out;
}

void i18n.use(initReactI18next).init({
  resources: { ja: { translation: deepMerge(saJa as Dict, appJa as Dict) } },
  lng: "ja",
  fallbackLng: "ja",
  interpolation: { escapeValue: false },
});

export default i18n;
