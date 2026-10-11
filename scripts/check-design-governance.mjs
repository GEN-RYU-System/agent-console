// 設計 §7 の検査（ADR-067 / ADR-144）。違反は file:line を出して exit 1。
// 許可する例外は ADR-067 の「許可される例外」（%・@media・calc 内の var・opacity 0/1・min-width 0）と、
// Sales Anchor の金型 CSS が実際に使っている 1px の枠線（border/outline のみ）に限る。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const violations = [];

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver " +
    "skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(path.join(root, "src")).map((f) => path.relative(root, f));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const isTest = (f) => /\.test\.(ts|tsx)$/.test(f);
const report = (file, line, message, text) => violations.push(`${file}:${line}: ${message}: ${text.trim()}`);

function scanLines(files, pattern, message) {
  for (const file of files) {
    read(file).split("\n").forEach((line, i) => {
      if (pattern.test(line)) report(file, i + 1, message, line);
    });
  }
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

// ① 色の直値（hex / rgb / hsl / 現代的な色関数）
const styleFiles = srcFiles.filter((f) => /\.(css|tsx|ts)$/.test(f));
scanLines(styleFiles, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, "色の直値");
scanLines(styleFiles, /\b(oklch|oklab|lab|lch|hwb)\(|(?<![\w-])color\(/, "色関数の直値");

// ①' CSS の named color / px・rem・em 直書き（宣言の値だけを見る）
const cssFiles = srcFiles.filter((f) => f.endsWith(".css"));
const LENGTH = /(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)\b/g;
for (const file of cssFiles) {
  const content = read(file).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // 宣言は `{` `}` `;` で区切って 1 つずつ見る（1 行に複数宣言があっても検出する）
  for (const chunk of content.matchAll(/[^{};]+/g)) {
    const text = chunk[0];
    if (/^\s*@media\b/.test(text)) continue; // ブレークポイントは CSS 変数が使えないため例外
    const decl = /^\s*([\w-]+)\s*:\s*([\s\S]*)$/.exec(text);
    if (!decl) continue;
    const [, prop, rawValue] = decl;
    const lineNo = lineOf(content, chunk.index + text.search(/\S/));
    const value = rawValue.replace(/url\([^)]*\)/g, "").replace(/"[^"]*"|'[^']*'/g, "");
    const withoutVar = value.replace(/var\(\s*--[\w-]+/g, "var(");
    for (const m of withoutVar.matchAll(/(?<![\w-])[a-zA-Z]+(?![\w-])/g)) {
      if (NAMED_COLORS.has(m[0].toLowerCase())) report(file, lineNo, "色名の直値", text);
    }
    for (const m of value.matchAll(LENGTH)) {
      const num = Number(m[1]);
      if (num === 0) continue;
      const isHairline = num === 1 && m[2] === "px" && /^(border|outline)(-|$)/.test(prop);
      if (!isHairline) report(file, lineNo, `${m[0]} の直書き（トークンを使う）`, text);
    }
  }
}

// ①'' TS/TSX のインライン style 内の数値・単位、数値の fontSize/lineHeight/letterSpacing
const codeFiles = srcFiles.filter((f) => /\.(tsx|ts)$/.test(f) && !isTest(f));
for (const file of codeFiles) {
  const content = read(file);
  for (const m of content.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    const body = m[1];
    const line = lineOf(content, m.index);
    const strings = [...body.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((s) => s[1] ?? s[2] ?? s[3] ?? "");
    const bare = body.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
    for (const n of bare.matchAll(/(?<![\w.])\d+(?:\.\d+)?/g)) {
      if (n[0] !== "0" && n[0] !== "1") report(file, line, `インライン style の数値 ${n[0]}`, body.replace(/\s+/g, " "));
    }
    for (const str of strings) {
      const withoutVar = str.replace(/var\(\s*--[\w-]+/g, "var(");
      if ([...withoutVar.matchAll(LENGTH)].some((l) => Number(l[1]) !== 0)) report(file, line, "インライン style の単位直書き", str);
      for (const w of withoutVar.matchAll(/(?<![\w-])[a-zA-Z]+(?![\w-])/g)) {
        if (NAMED_COLORS.has(w[0].toLowerCase())) report(file, line, "インライン style の色名", str);
      }
    }
  }
}
scanLines(codeFiles, /\b(fontSize|lineHeight|letterSpacing)\s*:\s*-?\d/, "数値の文字サイズ・行間の直書き");

// ② pages 配下の生要素
const pageFiles = srcFiles.filter((f) => f.startsWith("src/pages/") && f.endsWith(".tsx"));
scanLines(pageFiles, /<(button|input|select|textarea|a)[\s>]/, "生の要素（金型を使う）");

// ③ JSX テキストの日本語直書き（テストファイルは対象外）
const tsxFiles = srcFiles.filter((f) => f.endsWith(".tsx") && !isTest(f));
const JA = /[぀-ヿ㐀-鿿]/;
for (const file of tsxFiles) {
  read(file).split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, "");
    const isComment = /^\s*(\*|\/\*)/.test(line);
    if (!isComment && JA.test(code)) report(file, i + 1, "日本語の直書き（t() 経由にする）", line);
  });
}

// ④ .sa-cache がコミット対象に入っていない
const tracked = execFileSync("git", ["ls-files", ".sa-cache"], { encoding: "utf8" }).trim();
if (tracked !== "") {
  for (const f of tracked.split("\n")) violations.push(`${f}:1: .sa-cache がコミットされている`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(`design governance: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("design governance: OK");
