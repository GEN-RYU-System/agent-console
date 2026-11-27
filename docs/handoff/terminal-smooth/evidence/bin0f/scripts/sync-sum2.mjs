import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const agg = { rg33: 0, rg33_noL: 0, rg33_withL: 0, lgap33: 0, open: [] };
for (const s of d.scenarios.filter((x) => x.group === "C-30notch")) {
  const L = s.recv.filter((r) => r.sl > 0).map((r) => r.t); const H = s.recv.filter((r) => r.sh > 0).map((r) => r.t);
  // 1枚の絵を送るのにかかった時間: h を受けてから次の l を受けるまで
  for (const h of H) { const l = L.find((x) => x >= h); if (l !== undefined) agg.open.push(l - h); }
  for (let i = 1; i < L.length; i++) if (L[i] - L[i - 1] > 33) agg.lgap33++;
  for (let i = 1; i < s.render.length; i++) { const a = s.render[i - 1].t, b = s.render[i].t; if (b - a > 33) { agg.rg33++; const lIn = L.filter((x) => x > a && x < b - 17).length; if (lIn) agg.rg33_withL++; else agg.rg33_noL++; } }
}
console.log(`30ノッチ4回: 描画の33ms超の間=${agg.rg33}（間の中に絵の終わり(2026l)が届いていた=${agg.rg33_withL}、届いていなかった=${agg.rg33_noL}）`);
console.log(`絵の終わり同士の33ms超の間=${agg.lgap33}`);
console.log(`1枚の絵を受け終わるまで(h→l) p50/p90/max = ${q(agg.open, .5).toFixed(1)}/${q(agg.open, .9).toFixed(1)}/${Math.max(...agg.open).toFixed(1)} ms 枚数=${agg.open.length}`);
