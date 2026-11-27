// 描く番の呼び出しが無かった 33ms 超の間に、新しい出力を読み終えたか（wr の読み終わり時刻）
import fs from "node:fs";
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let noCall = 0, noCallNoWrite = 0, noCallWithWrite = 0; const wrote = [];
for (const s of j.scenarios.filter((x) => x.name === "C-30notch")) {
  const rr = s.rr || [], R = (s.render || []).map((x) => x.t), wr = s.wr || [];
  for (let i = 1; i < R.length; i++) {
    const a = R[i - 1], b = R[i]; if (b - a <= 33) continue;
    if (rr.some((x) => x[0] > a + 1 && x[0] < b - 1)) continue;
    noCall++;
    const w = wr.filter((x) => x[1] > a + 1 && x[1] < b - 17);
    if (w.length === 0) noCallNoWrite++; else { noCallWithWrite++; wrote.push(`${(b - a).toFixed(0)}ms:${w.length}件`); }
  }
}
console.log(`呼び出しなしの間=${noCall} うち 間の中（終わりの17ms前まで）に読み終えた出力なし=${noCallNoWrite} / あり=${noCallWithWrite} ${wrote.join(" ")}`);
