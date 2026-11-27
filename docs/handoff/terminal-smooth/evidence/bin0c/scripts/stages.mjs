// 便0c: 段ごとの間の集計。使い方: node stages.mjs <claude-raw.json> <trace.txt>
import { readFileSync } from "node:fs";
const [rawF, trF] = process.argv.slice(2);
const d = JSON.parse(readFileSync(rawF, "utf8"));
const T0 = d.timeOrigin;
const tr = readFileSync(trF, "utf8").trim().split("\n").map((l) => { const [k, t, n] = l.split(" "); return { k, t: Number(t), n: Number(n) }; });
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => Number.isFinite(x) ? x.toFixed(1) : "-";
const gaps = (a) => a.slice(1).map((v, i) => v - a[i]);
const groups = {};
for (const s of d.scenarios) if (s.wheel?.length) (groups[s.group] ??= []).push(s);
console.log("| 組 | 回 | 送信→サーバー受け(W) p50/p90 | W→tmuxの最初の返り p50/p90 | tmuxの返りの33ms超の間 / 最大 | サーバー送り(O)→ブラウザ受け p50/p90/max | ブラウザ受けの33ms超の間 / 最大 | 描画の33ms超の間 / 最大 | 通数 O/受け |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [g, ss] of Object.entries(groups)) {
  const sw = [], wc = [], ol = []; let cG = 0, rG = 0, dG = 0, cM = 0, rM = 0, dM = 0, nO = 0, nR = 0;
  for (const s of ss) {
    const a = T0 + s.wheel[0].t, endB = Math.max(...[s.render.at(-1)?.t ?? 0, s.recv.at(-1)?.t ?? 0]);
    const b = T0 + endB;
    const W = tr.filter((x) => x.k === "W" && x.t >= a - 5 && x.t <= b);
    const C = tr.filter((x) => x.k === "C" && x.t >= a && x.t <= b).map((x) => x.t);
    const O = tr.filter((x) => x.k === "O" && x.t >= a && x.t <= b).map((x) => x.t);
    const R = s.recv.map((x) => T0 + x.t);
    const D = s.render.map((x) => T0 + x.t);
    for (const se of s.send) { const t = T0 + se.t; const w = W.find((x) => x.t >= t - 2); if (w) sw.push(w.t - t); }
    for (const w of W) { const c = C.find((x) => x > w.t); if (c) wc.push(c - w.t); }
    // O と受けは順に対にする（同じ数のときだけ）
    nO += O.length; nR += R.length;
    if (O.length === R.length) for (let i = 0; i < O.length; i++) ol.push(R[i] - O[i]);
    const cg = gaps(C), rg = gaps(R), dg = gaps(D);
    cG += cg.filter((x) => x > 33).length; rG += rg.filter((x) => x > 33).length; dG += dg.filter((x) => x > 33).length;
    cM = Math.max(cM, ...cg, 0); rM = Math.max(rM, ...rg, 0); dM = Math.max(dM, ...dg, 0);
  }
  console.log(`| ${g} | ${ss.length} | ${f(q(sw, .5))}/${f(q(sw, .9))} | ${f(q(wc, .5))}/${f(q(wc, .9))} | ${cG} / ${f(cM)} | ${f(q(ol, .5))}/${f(q(ol, .9))}/${f(Math.max(...ol, -Infinity))} | ${rG} / ${f(rM)} | ${dG} / ${f(dM)} | ${nO}/${nR} |`);
}
