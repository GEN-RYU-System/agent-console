import { readFileSync } from "node:fs";
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => Number.isFinite(x) ? x.toFixed(1) : "-";
const diffs = (a) => a.slice(1).map((v, i) => v - a[i]);
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  console.log(`\n## ${file}\nstarted ${d.startedAt} rows=${d.env.rows} cols=${d.env.cols} renderer=${d.env.renderer}`);
  const groups = {};
  for (const s of d.scenarios) (groups[s.group] ??= []).push(s);
  console.log("| 組 | 回 | load(前) | 受信数 中央 | 描画数 中央 | 描画間隔 p50/p90/max ms | 33ms超 合計 | 動いた時間 ms 中央 | rAF間隔 p50/p90/max | rAF 33ms超 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const [g, ss] of Object.entries(groups)) {
    const ri = [], rafi = []; let over = 0, rafOver = 0; const dur = [], rc = [], rn = [];
    for (const s of ss) {
      const r = s.render.map((x) => x.t); const di = diffs(r); ri.push(...di); over += di.filter((x) => x > 33).length;
      const ra = diffs(s.raf); rafi.push(...ra); rafOver += ra.filter((x) => x > 33).length;
      rc.push(s.recv.length); rn.push(s.render.length);
      if (s.wheel.length && r.length) dur.push(r.at(-1) - s.wheel[0].t);
    }
    console.log(`| ${g} | ${ss.length} | ${ss[0].pre?.load ?? ""} | ${q(rc, .5)} | ${q(rn, .5)} | ${f(q(ri, .5))}/${f(q(ri, .9))}/${f(Math.max(...ri, -Infinity))} | ${over} | ${f(q(dur, .5))} | ${f(q(rafi, .5))}/${f(q(rafi, .9))}/${f(Math.max(...rafi, -Infinity))} | ${rafOver}/${rafi.length} |`);
  }
}
