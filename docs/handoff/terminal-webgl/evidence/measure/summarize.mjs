// 生の測定値（raw/*.json）から、組ごとの中央値と、その 4 つの中央値を出す（LPW: 組ごとに中央値→その中央値の中央値）
import { readFileSync, writeFileSync } from "node:fs";
const median = (a) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const dir = new URL("../raw/", import.meta.url).pathname;
const out = {};
const k1 = JSON.parse(readFileSync(dir + "k1-raw.json", "utf8"));
const metrics = ["spanMs", "framesOver33", "rendererCpuSec", "cpuPerRowMs", "longtaskMaxMs", "signals"];
out.k1 = { perPair: k1.pairs.map((p) => ({ pair: p.pair, load: p.load, loadAfter: p.loadAfter, mem: p.mem, dom: Object.fromEntries(metrics.map((m) => [m, p.trials.dom[m]])), webgl: Object.fromEntries(metrics.map((m) => [m, p.trials.webgl[m]])) })), median4: {} };
for (const m of metrics) out.k1.median4[m] = { dom: median(k1.pairs.map((p) => p.trials.dom[m])), webgl: median(k1.pairs.map((p) => p.trials.webgl[m])) };
out.k1.pass = Object.fromEntries(["spanMs", "framesOver33", "rendererCpuSec"].map((m) => [m, out.k1.median4[m].webgl < out.k1.median4[m].dom]));
try {
  const k2 = JSON.parse(readFileSync(dir + "k2-raw.json", "utf8"));
  const per = k2.pairs.map((p) => ({ pair: p.pair, load: p.load, loadAfter: p.loadAfter, mem: p.mem, domMedian: median(p.trials.dom.commitToRenderMs), webglMedian: median(p.trials.webgl.commitToRenderMs), domNull: p.trials.dom.commitToRenderMs.filter((x) => x === null).length, webglNull: p.trials.webgl.commitToRenderMs.filter((x) => x === null).length }));
  const d = median(per.map((p) => p.domMedian)), w = median(per.map((p) => p.webglMedian));
  out.k2 = { perPair: per, median4: { dom: d, webgl: w }, ratio: w / d, pass: w <= d * 1.2 };
} catch { /* K2 未測定 */ }
writeFileSync(dir + "summary.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
