// e2e 用の役割プロセス（括弧付き貼付モードを有効にする端末アプリの代役）。受け取った入力を JSON 文字列で表示する。
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
process.stdin.setRawMode(true);
console.log(`READY ${process.cwd()}`);
process.stdout.write("\u001b[?2004h");
process.stdin.on("data", (chunk) => console.log(`GOT:${JSON.stringify(chunk.toString())}`));
