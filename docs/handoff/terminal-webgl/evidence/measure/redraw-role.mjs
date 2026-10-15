// 測定用の役割（Claude の代役）: 代替画面＋マウス追跡。wheel の信号（SGR 64/65）を1つ受けるたびに、全画面を描き直す。
// 1行目は「SIG:<受けた信号の総数>」。マーカー（agent-console-e2e-role）を argv に持つ。
process.stdin.setRawMode(true);
const E = "\x1b[";
process.stdout.write(`${E}?1049h${E}?1003h${E}?1006h`);
let received = "";
let sig = 0;
const COLORS = [31, 32, 33, 34, 35, 36];
const wide = (ch) => /[　-鿿＀-￯]/.test(ch);
/** 表示幅（全角 2）で cells 桁以内に切る */
function clip(text, cells) {
  let out = "", n = 0;
  for (const ch of text) { const w = wide(ch) ? 2 : 1; if (n + w > cells) break; out += ch; n += w; }
  return out;
}
function frame() {
  const cols = process.stdout.columns, rows = process.stdout.rows;
  const lines = [`SIG:${sig}`];
  for (let r = 1; r < rows; r++) {
    const c = COLORS[(r + sig) % COLORS.length];
    const head = `row ${String(r + sig).padStart(5)} `;
    const body = clip(head + "あいうえお abcdefghij 0123456789 ".repeat(8), cols - 1);
    lines.push(`${E}${c}m${body}${E}0m`);
  }
  process.stdout.write(`${E}H` + lines.map((l) => `${l}${E}K`).join("\r\n"));
}
console.log("READY");
frame();
process.stdin.on("data", (chunk) => {
  received += chunk.toString();
  const n = (received.match(/\x1b\[<6[45];/g) ?? []).length;
  if (n !== sig) { sig = n; frame(); }
});
process.stdout.on("resize", frame);
