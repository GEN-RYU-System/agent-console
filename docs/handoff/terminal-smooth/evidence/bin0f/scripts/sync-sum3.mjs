import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const lag = [], l2r = [], rafGap = []; let rg = 0, rgParsedL = 0, rgNoL = 0, rgSync = 0; const ex = [];
for (const s of d.scenarios.filter((x) => x.group === "C-30notch")) {
  const t0 = s.wheel[0].t;
  s.wr.forEach((w) => lag.push(w[1] - w[0]));
  // 絵の終わり(2026l)を含む write が読み終わった時刻
  const Lp = []; s.recv.forEach((r, i) => { if (r.sl > 0 && s.wr[i]) Lp.push(s.wr[i][1]); });
  const R = s.render.map((x) => x.t);
  for (const l of Lp) { const r = R.find((x) => x >= l); if (r !== undefined) l2r.push(r - l); }
  for (let i = 1; i < s.sync.length; i++) rafGap.push(s.sync[i][0] - s.sync[i - 1][0]);
  for (let i = 1; i < R.length; i++) { const a = R[i - 1], b = R[i]; if (b - a > 33) { rg++;
    const pl = Lp.filter((x) => x > a && x < b - 17).length; const sy = s.sync.filter((x) => x[0] > a && x[0] < b); const on = sy.filter((x) => x[1]).length;
    if (pl) rgParsedL++; else rgNoL++; if (on) rgSync++;
    if (pl && ex.length < 12) ex.push(`D@${(a - t0).toFixed(0)}+${(b - a).toFixed(0)} 読み終えた絵${pl}枚 同期中rAF${on}/${sy.length}`); } }
}
console.log(`write を読み終えるまで p50/p90/max = ${q(lag,.5).toFixed(1)}/${q(lag,.9).toFixed(1)}/${Math.max(...lag).toFixed(1)} ms`);
console.log(`絵を読み終えてから描くまで p50/p90/max = ${q(l2r,.5).toFixed(1)}/${q(l2r,.9).toFixed(1)}/${Math.max(...l2r).toFixed(1)} ms 枚数=${l2r.length}`);
console.log(`rAF の間 p50/p90/max = ${q(rafGap,.5).toFixed(1)}/${q(rafGap,.9).toFixed(1)}/${Math.max(...rafGap).toFixed(1)}  33ms超=${rafGap.filter(x=>x>33).length}`);
console.log(`描画の33ms超の間=${rg}: 間の中で絵を読み終えていた=${rgParsedL} / いなかった=${rgNoL} / 同期中のrAFあり=${rgSync}`);
ex.forEach((x) => console.log("  ", x));
