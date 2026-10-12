// e2e 用の役割プロセス（全角の句読点・括弧と ※ の行を出す。K1/K3 の描画の確認用）。
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
// 端末の列数 N を読み、各行を「ラベル＋対象の文字を埋めて N-1 桁＋|」で出す。日本語は 2 桁として数える。
// 出力は、SIZE が落ち着く（端末の大きさ合わせが済む）のを待つため、列数が 2 秒変わらなくなってから 1 回だけ出す。
const A = "端末の書体：英数字は今の書体（Menlo）のまま、日本語だけをヒラギノ明朝にします。次の3つ";
const B = "と同じ版（v0.7.0）でまとめて入れます。アプリ専用の登録ファイル（src/tokens.app.css）に足して使う";
const PUNCT = "，．、。（）「」・：！？ ABC";
const STABLE_MS = 2000;
const POLL_MS = 100;
const wide = (s) => [...s].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);

/** 列数を超えない範囲で unit を繰り返して 1 行にする（日本語は 2 桁） */
function filled(label, unit, cols) {
  let line = label;
  while (wide(line) + wide(unit) <= cols - 1) line += unit;
  return `${line}|`;
}

console.log(`READY ${process.cwd()}`);
let lastCols = process.stdout.columns;
let stableSince = Date.now();
process.stdout.on("resize", () => {
  lastCols = process.stdout.columns;
  stableSince = Date.now();
});
const timer = setInterval(() => {
  if (Date.now() - stableSince < STABLE_MS) return;
  clearInterval(timer);
  const cols = lastCols;
  const rows = [
    `COLS=${cols}`,
    `ascii ${"x".repeat(Math.max(0, cols - 8))}|`,
    "s1 " + A,
    "s2 " + B,
    "pu " + PUNCT,
    filled("pj ", "，．、。（）「」", cols),
    filled("ref ", "※", cols),
    filled("ja ", "あ", cols),
  ];
  process.stdout.write("\x1b[2J\x1b[H" + rows.join("\r\n") + "\r\nPUNCT-DONE\r\n");
}, POLL_MS);
process.stdin.resume();
