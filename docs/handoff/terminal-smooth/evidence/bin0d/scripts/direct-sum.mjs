import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("modes:", r.modes.map((m) => m.replace("\x1b", "ESC")).join(" "));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const g = {};
for (const s of r.scenarios) { const c = s.chunks; const gaps = c.slice(1).map((v, i) => v - c[i]); (g[s.group] ??= []).push({ n: c.length, bytes: s.bytes, gaps, big: c.slice(1).map((v, i) => [c[i] - s.start, v - c[i]]).filter(([, x]) => x > 100).map(([t, x]) => `@${t.toFixed(0)}+${x.toFixed(0)}`) }); }
console.log("| 組 | 回 | 出力の塊 中央 | 間 p50/p90 ms | 33ms超の間 合計 | 100ms超の間 合計 | 最大 ms |"); console.log("|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(g)) { const all = v.flatMap((x) => x.gaps); console.log(`| ${k} | ${v.length} | ${q(v.map((x) => x.n), .5)} | ${q(all, .5).toFixed(1)}/${q(all, .9).toFixed(1)} | ${all.filter((x) => x > 33).length} | ${all.filter((x) => x > 100).length} | ${Math.max(...all).toFixed(0)} |`); }
for (const [k, v] of Object.entries(g)) v.forEach((x, i) => console.log(k, i + 1, "bytes", x.bytes, x.big.join(" ")));
