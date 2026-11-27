import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const s of d.scenarios.filter((x) => x.group === "C-30notch" || x.group === "B-1notch")) {
  const t0 = s.wheel[0]?.t ?? s.recv[0]?.t ?? 0;
  const sh = s.recv.reduce((a, r) => a + (r.sh || 0), 0), sl = s.recv.reduce((a, r) => a + (r.sl || 0), 0);
  const syncOn = s.sync.filter((x) => x[1]).length;
  const ltSum = s.lt.reduce((a, x) => a + x[1], 0);
  const gaps = [];
  for (let i = 1; i < s.render.length; i++) { const a = s.render[i - 1].t, b = s.render[i].t; if (b - a > 100) {
    const rc = s.recv.filter((r) => r.t > a && r.t < b).length;
    const sy = s.sync.filter((x) => x[0] > a && x[0] < b); const on = sy.filter((x) => x[1]).length;
    const lt = s.lt.filter((x) => x[0] < b && x[0] + x[1] > a).map((x) => x[1].toFixed(0));
    gaps.push(`D@${(a - t0).toFixed(0)}+${(b - a).toFixed(0)} 受け${rc} 同期中${on}/${sy.length} 長い処理[${lt.join(",")}]`); } }
  console.log(`${s.group} dir=${s.dir} recv=${s.recv.length} render=${s.render.length} 2026h=${sh} 2026l=${sl} 同期中のrAF=${syncOn}/${s.sync.length} 長い処理=${s.lt.length}件 計${ltSum.toFixed(0)}ms`);
  for (const g of gaps) console.log("   ", g);
}
