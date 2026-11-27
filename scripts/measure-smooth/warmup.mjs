// 初回の準備（設計 §4-2）: 道A で claude を起動し、Enter を最大6回。毎回の画面を evidence/warmup.txt に足す。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { COLS, ROWS, Recorder, newHeadless, screenText, sleep } from "./lib.mjs";
const require = createRequire(import.meta.url);
const pty = require("node-pty");
const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "docs/handoff/terminal-smooth/evidence/warmup.txt");
const cwd = process.env.MEASURE_CWD;
fs.mkdirSync(cwd, { recursive: true });
fs.appendFileSync(out, "\n##### 4回目の実行（フォルダの信頼: 測定フォルダのみ下矢印1回+Enter）#####\n");
const env = { ...process.env, TERM: "xterm-256color" };
delete env.TMUX; delete env.TMUX_PANE;
const rec = new Recorder();
let p;
const term = newHeadless((d) => p.write(d));
p = pty.spawn("claude", [], { name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env });
p.onData((s) => { rec.onChunk(s); term.write(s); });
const BAD = /log ?in|log ?out|sign ?in|authenticat|api key|subscription|account|ログイン/i;
const add = (t) => fs.appendFileSync(out, t + "\n");
await rec.settle(30000); await sleep(500);
let pressed = 0, status = "LIMIT";
for (let i = 0; i <= 6; i++) {
  const s = screenText(term);
  add(`===== 画面 ${i}（Enter ${pressed} 回押した後）=====\n${s}`);
  if (BAD.test(s)) { status = "LOGIN_SCREEN"; break; }
  if (/❯\s*$|^\s*>\s|\? for shortcuts|Try "/m.test(s) && !/Choose the text style|trust|Do you want|Press Enter/i.test(s)) { status = "READY"; break; }
  if (i === 6) break;
  if (/Accessing workspace/.test(s) && /trust this folder/.test(s)) {
    if (!/^\s*\/tmp\/measure-smooth-cwd\s*$/m.test(s)) { status = "BLOCKED_OTHER_FOLDER"; break; }
    p.write("\x1b[B"); await sleep(300);
  }
  p.write("\r"); pressed++;
  await sleep(1000); await rec.settle(15000);
}
add(`===== 結果: ${status}（Enter ${pressed} 回）=====`);
console.log(status, pressed);
try { p.write("\x03"); await sleep(300); p.write("\x03"); await sleep(300); p.kill(); } catch {}
process.exit(0);
