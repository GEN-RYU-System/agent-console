// Chrome 拡張の見た目の値を、Sales Anchor のトークンから作る（設計 §3-5）。
// 拡張の中は Shadow DOM で :root が効かないため、tokens.css をそのまま写さず、必要な値だけを解決した `:host { --pick-…: 値 }` にする。
// 正本は SA のトークン。出力の extension/picker-tokens.css は、ビルドのたびに作り直す写し（.gitignore 済み）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 拡張が使う 7 つの値と、対応する SA のトークン名（どれも明るい画面の値）。 */
export const PICKER_TOKEN_MAP = {
  "--pick-frame-color": "--accent",
  "--pick-frame-width": "--space-2px",
  "--pick-guide-color": "--tooltip-text",
  "--pick-guide-bg": "--tooltip-bg",
  "--pick-space": "--space-2",
  "--pick-radius": "--radius-md",
  "--pick-font-size": "--font-sm",
};

/** rem を px に直す基準。SA の index.css は html の font-size を決めていないので、ブラウザの既定の 16px。 */
export const REM_PX = 16;
const SA_FILES = ["tokens.css", "index.css"];

/** コメントを空白にして、最上位の規則だけを見る。セレクタが ":root" と完全一致する規則の宣言を集める（.force-dark・@media の中は見ない）。 */
function lightRootDeclarations(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out = new Map();
  let depth = 0;
  let selectorStart = 0;
  let body = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        const selector = text.slice(selectorStart, i).trim();
        body = selector === ":root" ? { start: i + 1 } : null;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (body !== null) {
          for (const decl of text.slice(body.start, i).split(";")) {
            const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
            if (m) out.set(m[1], m[2]);
          }
        }
        body = null;
        selectorStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      selectorStart = i + 1; // @import など、本体の無い規則
    }
  }
  return out;
}

function remToPx(value) {
  return value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Number.parseFloat((Number.parseFloat(n) * REM_PX).toFixed(4))}px`);
}

function resolve(name, vars, trail = []) {
  if (trail.includes(name)) throw new Error(`token cycle: ${[...trail, name].join(" -> ")}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`token not found: ${name}`);
  return remToPx(substitute(raw, vars, [...trail, name]));
}

/** value の中の var(--x) と var(--x, 代わりの値) を、値まで解決する。 */
function substitute(value, vars, trail) {
  let out = value;
  for (let guard = 0; guard < 50; guard += 1) {
    const m = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/.exec(out);
    if (!m) return out;
    const replacement = vars.has(m[1]) ? resolve(m[1], vars, trail) : m[2] !== undefined && m[2] !== "" ? m[2] : resolve(m[1], vars, trail);
    out = out.slice(0, m.index) + replacement + out.slice(m.index + m[0].length);
  }
  throw new Error(`too many nested var() in: ${value}`);
}

/** SA の frontend/src（.sa-cache の中）から、extension/picker-tokens.css の中身を作る。 */
export function buildPickerTokensCss(saSrcDir) {
  const vars = new Map();
  for (const file of SA_FILES) {
    const full = path.join(saSrcDir, file);
    if (!existsSync(full)) throw new Error(`${full} がありません。先に npm run sa-sync を実行してください`);
    for (const [k, v] of lightRootDeclarations(readFileSync(full, "utf8"))) vars.set(k, v);
  }
  const lines = Object.entries(PICKER_TOKEN_MAP).map(([pick, sa]) => `  ${pick}: ${resolve(sa, vars)}; /* ${sa} */`);
  return [
    "/* 生成物: scripts/build-picker-tokens.mjs が Sales Anchor のトークンから作る。直接編集しない（ビルドのたびに作り直す） */",
    ":host {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(here, "..", "extension", "picker-tokens.css");
  try {
    writeFileSync(out, buildPickerTokensCss(path.join(here, "..", ".sa-cache", "frontend", "src")));
    console.log(`build-picker-tokens: ${path.relative(process.cwd(), out)}`);
  } catch (err) {
    console.error(`build-picker-tokens: ${err.message}`);
    process.exit(1);
  }
}
