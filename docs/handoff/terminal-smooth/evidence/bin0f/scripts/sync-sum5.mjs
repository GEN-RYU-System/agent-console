import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const win = []; let on = 0, span = 0; const g = { total: 0, syncLong: 0, other: 0 }; const ex = [];
for (const s of d.scenarios.filter((x) => x.group === "C-30notch")) {
  const W = s.wr; if (!W.length) continue; const t0 = s.wheel[0].t;
  // 同期中の区間 = sync=1 になった write の終わり → 次に sync=0 になった write の終わり
  const iv = []; let st = null;
  for (const w of W) { if (w[3] && st === null) st = w[1]; if (!w[3] && st !== null) { iv.push([st, w[1]]); st = null; } }
  iv.forEach(([a, b]) => { win.push(b - a); on += b - a; }); span += W.at(-1)[1] - W[0][1];
  const R = s.render.map((x) => x.t);
  for (let i = 1; i < R.length; i++) { const a = R[i - 1], b = R[i]; if (b - a <= 33) continue; g.total++;
    const inGap = iv.map(([x, y]) => Math.min(y, b) - Math.max(x, a)).filter((v) => v > 0); const sum = inGap.reduce((p, v) => p + v, 0);
    if (sum >= 16.7) g.syncLong++; else g.other++;
    if (ex.length < 10) ex.push(`D@${(a - t0).toFixed(0)}+${(b - a).toFixed(0)} 同期中だった時間 計${sum.toFixed(0)}ms（${inGap.length}区間）`); }
}
console.log(`同期中の1区間の長さ p50/p90/max = ${q(win,.5).toFixed(1)}/${q(win,.9).toFixed(1)}/${Math.max(...win).toFixed(1)} ms 区間数=${win.length}`);
console.log(`出力が続く時間のうち同期中の割合 = ${(100 * on / span).toFixed(1)}%`);
console.log(`描画の33ms超の間 ${g.total}: 間のうち16.7ms以上が同期中 = ${g.syncLong} / それ以外 = ${g.other}`);
ex.forEach((x) => console.log("  ", x));
