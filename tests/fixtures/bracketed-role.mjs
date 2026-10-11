// e2e 用の役割プロセス（括弧付き貼付モードを有効にする端末アプリの代役）。受け取った入力の全体（連結）を JSON 文字列で表示する。
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
process.stdin.setRawMode(true);
console.log(`READY ${process.cwd()}`);
process.stdout.write("\u001b[?2004h");
// 届いたバイト列は読み取りの区切りに関係なく連結して表示する（1 回の読み取りにまとまるか 2 回に分かれるかは環境で変わる）
let received = "";
process.stdin.on("data", (chunk) => {
  received += chunk.toString();
  console.log(`ALL:${JSON.stringify(received)}`);
});
