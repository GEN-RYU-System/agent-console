import { readFileSync } from "node:fs";
const [rawF, trF] = process.argv.slice(2);
const d = JSON.parse(readFileSync(rawF, "utf8")); const T0 = d.timeOrigin;
const tr = readFileSync(trF, "utf8").trim().split("\n").map((l) => { const [k, t, n] = l.split(" "); return { k, t: +t, n: +n }; });
for (const s of d.scenarios.filter((s) => s.group === "C-30notch")) {
  const a = T0 + s.wheel[0].t, b = T0 + Math.max(s.render.at(-1).t, s.recv.at(-1).t);
  const O = tr.filter((x) => x.k === "O" && x.t >= a && x.t <= b);
  const R = s.recv.map((x) => T0 + x.t), D = s.render.map((x) => T0 + x.t);
  const big = (arr, name) => arr.slice(1).map((v, i) => [arr[i], v - arr[i]]).filter(([, g]) => g > 100).map(([t, g]) => `${name}@${(t - a).toFixed(0)}+${g.toFixed(0)}`);
  const bytes = O.reduce((p, x) => p + x.n, 0);
  console.log(`run: O=${O.length} bytes=${bytes} lastWheel=${(T0 + s.wheel.at(-1).t - a).toFixed(0)} lastO=${(O.at(-1).t - a).toFixed(0)} lastR=${(R.at(-1) - a).toFixed(0)} lastD=${(D.at(-1) - a).toFixed(0)}`);
  console.log("  ", [...big(O.map((x) => x.t), "O"), ...big(R, "R"), ...big(D, "D")].join(" "));
  // 描画1回あたりの受け数
  const per = D.map((t, i) => R.filter((r) => r <= t && (i === 0 || r > D[i - 1])).length);
  console.log("   recv per render:", per.join(","));
}
