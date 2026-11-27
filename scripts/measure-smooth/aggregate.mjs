// 使い方: node scripts/measure-smooth/aggregate.mjs  → raw/*.meta.json を集計して表を標準出力に出す
import fs from "node:fs";
import path from "node:path";
import { pct } from "./lib.mjs";
const raw = path.resolve(import.meta.dirname, "../../docs/handoff/terminal-smooth/evidence/raw");
const get = (r, o, n) => JSON.parse(fs.readFileSync(path.join(raw, `${r}-${o}-${n}.meta.json`), "utf8"));
const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const rows = [];
for (const op of ["O1", "O2"]) for (const r of ["A", "B"]) {
  const us = [], loads = [];
  for (let n = 1; n <= 5; n++) { const m = get(r, op, n); us.push(...m.updateSummary); loads.push(`${m.loadBefore}→${m.loadAfter}`); }
  const c = (k) => us.map((u) => u[k]);
  rows.push(`| ${r} | ${op} | ${us.length} | ${pct(c("u1"), 50)}/${pct(c("u1"), 90)} | ${f(pct(c("u2"), 50))}/${f(pct(c("u2"), 90))} | ${f((us.filter((u) => u.u3).length / us.length) * 100)}% | ${c("u4").reduce((a, b) => a + b, 0)} | ${f(pct(c("u5"), 50))}/${f(pct(c("u5"), 90))} | ${pct(c("u6"), 50)} | ${loads.join(" ")} |`);
}
console.log("| 道 | 操作 | 更新数 | U1 塊数 p50/p90 | U2 広がりms p50/p90 | U3 同期% | U4 途中の絵 合計 | U5 入力→最後ms p50/p90 | U6 バイト p50 | G2 load(前→後) 1〜5回 |\n|---|---|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
console.log("\nG1");
for (const op of ["O1", "O2"]) for (let n = 1; n <= 5; n++) {
  const a = get("A", op, n).finalScreen.split("\n"), b = get("B", op, n).finalScreen.split("\n");
  const diff = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i + 1);
  console.log(op, n, diff.length ? `不一致 行${diff.join(",")}` : "一致");
  for (const i of diff.slice(0, 3)) console.log(`   A行${i}: ${JSON.stringify(a[i - 1])}\n   B行${i}: ${JSON.stringify(b[i - 1])}`);
}
console.log("\nO3");
for (const r of ["A", "B"]) { const m = get(r, "O3", 1); const us = m.updateSummary; console.log(r, "updates", us.length, "durationMs", f(m.durationMs), "load", m.loadBefore, "→", m.loadAfter, "chunksUnits u1sum", us.reduce((a, u) => a + u.u1, 0), "u3", us.filter((u) => u.u3).length, "u4", us.reduce((a, u) => a + u.u4, 0)); }
