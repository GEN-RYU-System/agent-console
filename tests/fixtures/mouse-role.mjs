// e2e 用の役割プロセス（マウス追跡を有効にする端末アプリ＝Claude の代役）。
// 受け取った入力の全体（連結）から、SGR のホイール信号（下向き 65・上向き 64）の数を数え直して `WHEEL:<下>:<上>` を表示する。
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
process.stdin.setRawMode(true);
console.log(`READY ${process.cwd()}`);
// 1003h: 動きも含めた全マウス追跡 / 1006h: SGR 形式
process.stdout.write("\u001b[?1003h\u001b[?1006h");
// 届いたバイト列は読み取りの区切りに関係なく連結し、毎回全体を数え直す（ESC [ < の途中で区切られても最終値は正しい）
let received = "";
process.stdin.on("data", (chunk) => {
  received += chunk.toString();
  const down = (received.match(/\x1b\[<65;/g) ?? []).length;
  const up = (received.match(/\x1b\[<64;/g) ?? []).length;
  console.log(`WHEEL:${down}:${up}`);
});
