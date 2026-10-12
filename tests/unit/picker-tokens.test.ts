import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 生成の道具は .mjs（型宣言なし）
import { buildPickerTokensCss, PICKER_TOKEN_MAP, REM_PX } from "../../scripts/build-picker-tokens.mjs";

const SA_SRC = path.resolve(".sa-cache", "frontend", "src");
const build = buildPickerTokensCss as (srcDir: string) => string;
const MAP = PICKER_TOKEN_MAP as Record<string, string>;

function fakeSa(files: { tokens: string; index: string }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-sa-"));
  writeFileSync(path.join(dir, "tokens.css"), files.tokens);
  writeFileSync(path.join(dir, "index.css"), files.index);
  return dir;
}
const MIN_TOKENS = `:root {
  --space-2: 8px;
  --space-2px: 2px;
  --radius-md: 6px;
  --font-sm: 0.85rem;
}`;
const MIN_INDEX = `@import "./tokens.css";
:root {
  --accent: #1e3a8a;
  --tooltip-bg: rgba(26, 32, 44, 0.92);
  --tooltip-text: #ffffff;
}
@media (prefers-color-scheme: dark) { :root { --accent: #000001; } }
:root.force-dark { --accent: #5b8dd9; --tooltip-text: #0f172a; }`;

describe("buildPickerTokensCss (K9, §3-5)", () => {
  it("makes a :host block with the seven --pick-… values, using the light theme only", () => {
    const css = build(fakeSa({ tokens: MIN_TOKENS, index: MIN_INDEX }));
    expect(css).toMatch(/^\/\*[\s\S]*?\*\/\s*:host \{/);
    const decl = Object.fromEntries([...css.matchAll(/(--pick-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    expect(Object.keys(decl).sort()).toEqual(Object.keys(MAP).sort());
    expect(Object.keys(decl)).toHaveLength(7);
    expect(decl["--pick-frame-color"]).toBe("#1e3a8a");
    expect(decl["--pick-guide-bg"]).toBe("rgba(26, 32, 44, 0.92)");
    expect(decl["--pick-guide-color"]).toBe("#ffffff");
    expect(decl["--pick-frame-width"]).toBe("2px");
    expect(decl["--pick-space"]).toBe("8px");
    expect(decl["--pick-radius"]).toBe("6px");
  });

  it("turns rem into px with the browser default 16px when SA's index.css sets no html font-size", () => {
    expect(REM_PX).toBe(16);
    const css = build(fakeSa({ tokens: MIN_TOKENS, index: MIN_INDEX }));
    expect(css).toContain("--pick-font-size: 13.6px;");
  });

  it("follows var() chains down to the value, with and without fallbacks", () => {
    const tokens = MIN_TOKENS.replace("--space-2: 8px;", "--space-2: var(--base-gap);\n  --base-gap: var(--missing, 8px);");
    const css = build(fakeSa({ tokens, index: MIN_INDEX }));
    expect(css).toContain("--pick-space: 8px;");
  });

  it("stops with the token name when a token is missing or the chain loops", () => {
    expect(() => build(fakeSa({ tokens: MIN_TOKENS.replace("--radius-md: 6px;", ""), index: MIN_INDEX }))).toThrow(/--radius-md/);
    expect(() => build(fakeSa({ tokens: MIN_TOKENS.replace("--space-2: 8px;", "--space-2: var(--space-2);"), index: MIN_INDEX }))).toThrow(/--space-2/);
  });

  it("matches the real Sales Anchor tokens in .sa-cache (frontend/src/index.css and tokens.css)", () => {
    const index = readFileSync(path.join(SA_SRC, "index.css"), "utf8");
    const tokens = readFileSync(path.join(SA_SRC, "tokens.css"), "utf8");
    const pick = (src: string, name: string): string => (new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(src)?.[1] ?? "").trim();
    const css = build(SA_SRC);
    const get = (name: string): string => (new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1] ?? "").trim();
    // 左は生成物、右は SA の元ファイルの最初の宣言（= ライトの :root）を別の道具で読んだ値
    expect(get("--pick-frame-color")).toBe(pick(index, "--accent"));
    expect(get("--pick-guide-bg")).toBe(pick(index, "--tooltip-bg"));
    expect(get("--pick-guide-color")).toBe(pick(index, "--tooltip-text"));
    expect(get("--pick-space")).toBe(pick(tokens, "--space-2"));
    expect(get("--pick-frame-width")).toBe(pick(tokens, "--space-2px"));
    expect(get("--pick-radius")).toBe(pick(tokens, "--radius-md"));
    expect(Number.parseFloat(get("--pick-font-size"))).toBeCloseTo(Number.parseFloat(pick(tokens, "--font-sm")) * 16, 5);
    // 解決しきれていない var() は残らない
    expect(css).not.toMatch(/var\(/);
  });

  it("every value in the SA map names a token that exists in the real SA tokens", () => {
    for (const token of Object.values(MAP)) {
      const found = ["index.css", "tokens.css"].some((f) => readFileSync(path.join(SA_SRC, f), "utf8").includes(`${token}:`));
      expect(found, token).toBe(true);
    }
  });

  it("the extension's own css uses nothing but var(--pick-…) of those seven names (no literal sizes or colors)", () => {
    const own = readFileSync(path.resolve("extension", "picker.css"), "utf8");
    const used = new Set([...own.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    for (const name of used) expect(Object.keys(MAP), name).toContain(name);
  });

  it("fails clearly when the SA cache is missing", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "ac-sa-empty-"));
    mkdirSync(path.join(empty, "x"));
    expect(() => build(empty)).toThrow(/sa-sync/);
  });
});
