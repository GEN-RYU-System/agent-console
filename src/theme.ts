/*
 * テーマ（ライト/ダーク）の保存と <html> への反映。
 * 規則の正本は Sales Anchor の frontend/src/contexts/ThemeContext.tsx
 * （クラス操作: :52-60、キー名と値 theme=light|dark: :41-49、初期値 light: :64）。
 * SA の ThemeProvider は SA の認証と /staff/me API に依存し import できないため、規則だけを薄く再実装する。
 * SA とはオリジンが違うので、設定は同期しない。
 * 保存先は Cookie ではなく localStorage（127.0.0.1 の Cookie はポートで分離されないため。段階1.5 で Cookie を全廃した設計と一貫）。
 */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
const DARK_CLASS = "force-dark";

export function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 保存できなくても表示は切り替わる（次回起動はライトに戻る）
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle(DARK_CLASS, theme === "dark");
}
