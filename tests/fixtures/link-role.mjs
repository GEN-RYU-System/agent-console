// e2e 用の役割プロセス（端末リンクの試験用。Claude Code の端末の状態の代役）。生モードで 1 行ずつ命令を受け取る。
//   show <パス> : 画面を消して左上に `LINK <パス> END` を出す
//   mouse       : マウス報告（1000h・1003h・1006h）を有効にする
//   alt         : 別画面（1049h）に入る
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
process.stdin.setRawMode(true);
console.log(`READY ${process.cwd()}`);
let line = "";
process.stdin.on("data", (chunk) => {
  for (const ch of chunk.toString()) {
    if (ch !== "\r" && ch !== "\n") {
      line += ch;
      continue;
    }
    const cmd = line;
    line = "";
    if (cmd === "mouse") process.stdout.write("\u001b[?1000h\u001b[?1003h\u001b[?1006h");
    else if (cmd === "alt") process.stdout.write("\u001b[?1049h");
    else if (cmd.startsWith("show ")) process.stdout.write(`\u001b[2J\u001b[HLINK ${cmd.slice(5)} END`);
  }
});
