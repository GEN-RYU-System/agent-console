import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const c = { quiet: 0, lateOnly: 0, parsedL: 0, total: 0, syncAtRaf: 0 }; let openMs = 0, spanMs = 0;
for (const s of d.scenarios.filter((x) => x.group === "C-30notch")) {
  const Lp = [], Hp = []; s.recv.forEach((r, i) => { if (r.sl > 0) Lp.push(s.wr[i][1]); if (r.sh > 0) Hp.push(s.wr[i][1]); });
  for (const h of Hp) { const l = Lp.find((x) => x >= h); if (l !== undefined) openMs += l - h; }
  spanMs += (Lp.at(-1) ?? 0) - (Hp[0] ?? 0);
  const W = s.wr.map((w) => w[1]); const R = s.render.map((x) => x.t);
  for (let i = 1; i < R.length; i++) { const a = R[i - 1], b = R[i]; if (b - a <= 33) continue; c.total++;
    const anyW = W.filter((x) => x > a && x < b).length; const early = Lp.filter((x) => x > a && x < b - 17).length; const late = Lp.filter((x) => x >= b - 17 && x < b).length;
    if (s.sync.some((x) => x[0] > a && x[0] < b && x[1])) c.syncAtRaf++;
    if (early) c.parsedL++; else if (late) c.lateOnly++; else if (!anyW) c.quiet++; }
}
console.log(`描画の33ms超の間 ${c.total}: 間の前半で絵を読み終えていたのに描かなかった ${c.parsedL} / 絵の終わりが間の最後の17ms に来た ${c.lateOnly} / その間 Claude から何も来ていなかった ${c.quiet} / 残り ${c.total - c.parsedL - c.lateOnly - c.quiet}`);
console.log(`同期中に rAF が当たった間 ${c.syncAtRaf}`);
console.log(`出力の続く時間のうち「絵の途中（同期中）」だった割合 = ${(100 * openMs / spanMs).toFixed(1)}%`);
