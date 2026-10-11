// 設計 §7 の検査。違反は file:line を出して exit 1。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const violations = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(path.join(root, "src")).map((f) => path.relative(root, f));
const isTest = (f) => /\.test\.(ts|tsx)$/.test(f);

function scan(files, pattern, message) {
  for (const file of files) {
    const lines = readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) violations.push(`${file}:${i + 1}: ${message}: ${line.trim()}`);
    });
  }
}

// ① 色直値（src の css/tsx/ts。i18n 辞書 json は対象外）
const styleFiles = srcFiles.filter((f) => /\.(css|tsx|ts)$/.test(f));
scan(styleFiles, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, "色の直値");

// ② pages 配下の生要素
const pageFiles = srcFiles.filter((f) => f.startsWith("src/pages/") && f.endsWith(".tsx"));
scan(pageFiles, /<(button|input|select|textarea)\b/, "生の入力部品（金型を使う）");

// ③ JSX テキストの日本語直書き（テストファイルは対象外）
const tsxFiles = srcFiles.filter((f) => f.endsWith(".tsx") && !isTest(f));
const JA = /[぀-ヿ㐀-鿿]/;
for (const file of tsxFiles) {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, "");
    const isComment = /^\s*(\*|\/\*)/.test(line);
    if (!isComment && JA.test(code)) violations.push(`${file}:${i + 1}: 日本語の直書き（t() 経由にする）: ${line.trim()}`);
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
