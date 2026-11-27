// 複数回の A-oneline をまとめて 送信→最初の描画 の p50/p90
import fs from "node:fs";
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const d = [];
for (const f of process.argv.slice(2)) { const j = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const s of j.scenarios.filter((x) => x.name === "A-oneline")) { const R = (s.render || []).map((x) => x.t);
    for (const x of s.send || []) { const r = R.find((t) => t >= x.t); if (r !== undefined) d.push(r - x.t); } } }
console.log(`n=${d.length} p50=${q(d, 0.5).toFixed(1)} p90=${q(d, 0.9).toFixed(1)} max=${Math.max(...d).toFixed(1)}`);
