// 便0g: 描く番（_renderRows）を同期中で見送った回数、描画の33ms超の間との対応、フレームの分かれ方
import fs from "node:fs";
const [file, trace] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const q = (a, p) => { if (!a.length) return "-"; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const out = [];
let tot = { gaps: 0, withSkip: 0, noCall: 0, other: 0, rr: 0, rrSkip: 0, recv: 0, recvSplit: 0, recvBytes1024: 0, renders: 0 };
for (const s of j.scenarios.filter((x) => x.name === "C-30notch")) {
  const rr = s.rr || [], R = (s.render || []).map((x) => x.t), recv = s.recv || [];
  const skip = rr.filter((x) => x[1] === 1).length;
  const gaps = [];
  for (let i = 1; i < R.length; i++) if (R[i] - R[i - 1] > 33) gaps.push([R[i - 1], R[i]]);
  let withSkip = 0, noCall = 0, other = 0;
  for (const [a, b] of gaps) {
    const inG = rr.filter((x) => x[0] > a + 1 && x[0] < b - 1);
    if (inG.some((x) => x[1] === 1)) withSkip++;
    else if (inG.length === 0) noCall++;
    else other++;
  }
  const split = recv.filter((x) => (x.sh || 0) !== (x.sl || 0)).length;
  const b1024 = recv.filter((x) => x.bytes === 1024).length;
  const framed = recv.filter((x) => (x.sh || 0) + (x.sl || 0) > 0).length;
  out.push(`- dir=${s.dir} 描画=${R.length} 描く番=${rr.length}（うち同期中で見送り=${skip}） 描画の33ms超の間=${gaps.length}（中に見送りあり=${withSkip} / 描く番の呼び出し自体なし=${noCall} / 呼び出しはあり見送りなし=${other}） 受け=${recv.length}（印を含む=${framed}、h と l の数が合わない=${split}、ちょうど1024バイト=${b1024}）`);
  tot.gaps += gaps.length; tot.withSkip += withSkip; tot.noCall += noCall; tot.other += other; tot.rr += rr.length; tot.rrSkip += skip; tot.recv += recv.length; tot.recvSplit += split; tot.recvBytes1024 += b1024; tot.renders += R.length;
}
out.push(`- 合計: ${JSON.stringify(tot)}`);
if (trace) {
  const L = fs.readFileSync(trace, "utf8").trim().split("\n").map((l) => l.split(" "));
  const O = L.filter((x) => x[0] === "O"), C = L.filter((x) => x[0] === "C");
  const oSplit = O.filter((x) => x[3] !== x[4]).length, oFramed = O.filter((x) => +x[3] + +x[4] > 0).length;
  const oLen = O.map((x) => +x[2]);
  const cLen = C.map((x) => +x[2]);
  const lenHist = {}; for (const n of oLen) if (n >= 900) lenHist[n] = (lenHist[n] || 0) + 1;
  const top = Object.entries(lenHist).sort((a, b) => b[1] - a[1]).slice(0, 5);
  out.push(`- サーバー（tmux から読んだ %output 1件ずつ、全場面）: 件数=${O.length} 印を含む=${oFramed} h と l の数が合わない=${oSplit} 長さ p50/p90/max=${q(oLen, .5)}/${q(oLen, .9)}/${q(oLen, 1)} 900文字以上で多い長さ=${JSON.stringify(top)}`);
  out.push(`- サーバー（tmux の標準出力の塊）: 件数=${C.length} 長さ p50/p90/max=${q(cLen, .5)}/${q(cLen, .9)}/${q(cLen, 1)}`);
}
console.log(out.join("\n"));
