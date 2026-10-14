// 工程0 の試験用: pane（または pty）の中で動く小さなプログラム。使い方: node inner.mjs <scenario>
import { appendFileSync } from "node:fs";
const scenario = process.argv[2];
const out = (s) => process.stdout.write(s);

const burst = /^scroll(\d*)$/.exec(scenario ?? "");
if (burst) {
  // N 行（既定 300）を 1 回でまとめて出して、そのまま待つ（スクロールバックの確認用）
  const n = burst[1] === "" ? 300 : Number(burst[1]);
  let text = "";
  for (let i = 1; i <= n; i++) text += `line ${i}\r\n`;
  out(text);
  out("SCROLL-DONE\r\n");
  setInterval(() => undefined, 1000);
}

if (scenario === "plain" || scenario === "bp" || scenario === "mouse" || scenario === "bpmouse") {
  // モード要求の有無で ESC の遅れが変わるかの切り分け用
  process.stdin.setRawMode(true);
  process.stdin.resume();
  if (scenario.startsWith("bp")) out("\x1b[?2004h");
  if (scenario.endsWith("mouse")) out("\x1b[?1000h\x1b[?1006h");
  out("READY\r\n");
  process.stdin.on("data", (d) => appendFileSync(process.env.HEXLOG, `${Date.now()} ${d.toString("hex")}\n`));
  setInterval(() => undefined, 1000);
}

if (scenario === "keys") {
  // 生のキー入力を 16 進で表示する。括弧付き貼り付け・マウス・OSC 52 を要求する。
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out(`ENV TERM=${process.env.TERM} LANG=${process.env.LANG} AC_RESUME_ID=${process.env.AC_RESUME_ID ?? ""} TOKEN=[${process.env.AGENT_CONSOLE_TOKEN ?? ""}] COLUMNS=${process.stdout.columns} ROWS=${process.stdout.rows}\r\n`);
  out("\x1b[?2004h"); // bracketed paste
  out("\x1b[?1000h\x1b[?1006h"); // mouse tracking (SGR)
  out("\x1b]52;c;aGVsbG8=\x07"); // OSC 52: "hello"
  out("日本語OK\r\n");
  out("KEYS-READY\r\n");
  // 受け取ったバイトは、画面の再描画に左右されないよう、ファイル（HEXLOG）へ 1 回の read ごとに 1 行で残す
  process.stdin.on("data", (d) => {
    appendFileSync(process.env.HEXLOG, `${Date.now()} ${d.toString("hex")}\n`);
    out(`HEX:${d.toString("hex").slice(0, 40)}\r\n`);
  });
  process.stdout.on("resize", () => out(`RESIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`));
  setInterval(() => undefined, 1000);
}

if (scenario === "scrollslow") {
  // 1 行ずつ少し間をあけて 300 行（claude の出力に近い流れ方）
  let i = 0;
  const t = setInterval(() => {
    i += 1;
    out(`line ${i}\r\n`);
    if (i >= 300) {
      clearInterval(t);
      out("SCROLL-DONE\r\n");
      setInterval(() => undefined, 1000);
    }
  }, 8);
}
