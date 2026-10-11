// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cssLengthToPx, readTerminalAppearance } from "./terminalTokens";

describe("cssLengthToPx", () => {
  it("converts rem and em using the root font size", () => {
    expect(cssLengthToPx("0.85rem", 16)).toBeCloseTo(13.6);
    expect(cssLengthToPx("1em", 20)).toBe(20);
  });
  it("passes px through", () => {
    expect(cssLengthToPx("13px", 16)).toBe(13);
  });
  it("returns null for unparsable values", () => {
    expect(cssLengthToPx("", 16)).toBeNull();
    expect(cssLengthToPx("calc(1rem + 2px)", 16)).toBeNull();
  });
});

describe("readTerminalAppearance", () => {
  afterEach(() => {
    for (const name of ["--font-sm", "--bg-surface", "--text-primary", "--bg-active"]) document.documentElement.style.removeProperty(name);
  });

  it("reads colors and the font size from the tokens", () => {
    const root = document.documentElement.style;
    root.setProperty("--font-sm", "0.5rem");
    root.setProperty("--bg-surface", "token-bg");
    root.setProperty("--text-primary", "token-fg");
    root.setProperty("--bg-active", "token-sel");
    const a = readTerminalAppearance();
    expect(a.theme).toEqual({ background: "token-bg", foreground: "token-fg", cursor: "token-fg", selectionBackground: "token-sel" });
    expect(a.fontSize).toBeCloseTo(8);
  });

  it("falls back to the root font size when the token is missing", () => {
    expect(readTerminalAppearance().fontSize).toBe(16);
  });
});
