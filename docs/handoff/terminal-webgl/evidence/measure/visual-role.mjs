// 比較用の役: 端末の列数が落ち着いてから、同じ内容を1回だけ出す
const STABLE_MS = 2000;
let lastCols = process.stdout.columns, since = Date.now();
process.stdout.on("resize", () => { lastCols = process.stdout.columns; since = Date.now(); });
console.log("READY");
const wide = (s) => [...s].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
function filled(label, unit, cols) { let l = label; while (wide(l) + wide(unit) <= cols - 1) l += unit; return `${l}|`; }
const t = setInterval(() => {
  if (Date.now() - since < STABLE_MS) return;
  clearInterval(t);
  const cols = lastCols;
  const E = "\x1b[";
  const rows = [
    `COLS=${cols} ROWS=${process.stdout.rows}`,
    "pu1 端末の書体：英数字は今の書体（Menlo）のまま、日本語だけをヒラギノ明朝にします。次の3つ",
    "pu2 と同じ版（v0.7.0）でまとめて入れます。アプリ専用の登録ファイル（src/tokens.app.css）に足して使う",
    "pu3 句読点の確認、。，．、。（）「」・：！？ ABC",
    filled("pj ", "，．、。（）「」", cols),
    "pe " + "あ".repeat((cols - 7) / 2) + "、。",
    "pf " + "あ".repeat((cols - 7) / 2) + "。」",
    filled("ja ", "あ", cols),
    `ascii ${"x".repeat(Math.max(0, cols - 8))}|`,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 {}[]()<>=+-*/\\|;:'\",.?!@#$%^&_~`",
    "┌──────────────┐  ━━━━━━━━━━━━━━",
    "│ box drawing  │  ┃ heavy line",
    "└──────────────┘  ━━━━━━━━━━━━━━",
    [31, 32, 33, 34, 35, 36].map((c) => `${E}${c}mANSI${c}${E}0m`).join(" "),
    [31, 32, 33, 34, 35, 36].map((c) => `${E}1;${c}mBOLD${c}${E}0m`).join(" "),
    `${E}1mbold${E}0m ${E}4munderline${E}0m ${E}1;4mbold+underline${E}0m ${E}3mitalic${E}0m ${E}7mreverse${E}0m ${E}2mdim${E}0m`,
    `${E}1m太字の日本語${E}0m ${E}4m下線の日本語${E}0m ${E}31m赤い日本語、。${E}0m ${E}44;37m青地に白${E}0m`,
  ];
  process.stdout.write("\x1b[2J\x1b[H" + rows.join("\r\n") + "\r\nVISUAL-DONE\r\n");
}, 100);
process.stdin.resume();
