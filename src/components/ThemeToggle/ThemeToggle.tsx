import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconToggleButton } from "@sa/components/IconToggleButton";
import { THEME_ICONS } from "@sa/constants/icons";
import { applyTheme, readStoredTheme, storeTheme, type Theme } from "../../theme";

/** フッターのライト/ダーク切替。押下＝ダーク。端末（xterm）は <html> の class 変化を TerminalPane が拾って追従する。 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const isDark = theme === "dark";

  const toggle = (): void => {
    const next: Theme = isDark ? "light" : "dark";
    storeTheme(next);
    applyTheme(next);
    setTheme(next);
  };

  return (
    <IconToggleButton
      pressed={isDark}
      onClick={toggle}
      iconOff={THEME_ICONS.light}
      iconOn={THEME_ICONS.dark}
      aria-label={isDark ? t("nav.switchToLight") : t("nav.switchToDark")}
    />
  );
}
