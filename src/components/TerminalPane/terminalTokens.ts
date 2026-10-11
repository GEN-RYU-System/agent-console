const DEFAULT_ROOT_FONT_PX = 16;
const FONT_SIZE_TOKEN = "--font-sm";
const FONT_FAMILY_TOKEN = "--ac-font-mono";

/** `0.85rem` / `13px` のような CSS 長さを px 数値にする。解釈できなければ null。 */
export function cssLengthToPx(value: string, rootPx: number): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*(px|rem|em)\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "px" ? n : n * rootPx;
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  theme: { background: string; foreground: string; cursor: string; selectionBackground: string };
}

/** 色と文字サイズを Sales Anchor のトークンから読む（直値を持たない）。ダーク切替後に再読込できる。 */
export function readTerminalAppearance(): TerminalAppearance {
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || DEFAULT_ROOT_FONT_PX;
  const fontSize = cssLengthToPx(tokenValue(FONT_SIZE_TOKEN), rootPx) ?? rootPx;
  return {
    fontFamily: tokenValue(FONT_FAMILY_TOKEN),
    fontSize,
    theme: {
      background: tokenValue("--bg-surface"),
      foreground: tokenValue("--text-primary"),
      cursor: tokenValue("--text-primary"),
      selectionBackground: tokenValue("--bg-active"),
    },
  };
}
