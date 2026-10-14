// 工程0 の試験台: 本物の xterm.js（アプリと同じ 6.0.0）を Chromium で動かし、node-pty の出力をそのまま書き込む。
// direct = 今の作り（pty で直接起動）/ tmux = tmux の中で起動して attach をつなぐ。
// 使い方: node rig.mjs <repoDir> <direct|tmux> <scenario> <outJson> [socket]
//   scenario: scroll | keys
// 使い捨ての tmux ソケット（既定 acstep0）と、捨ての dataDir だけを使う。
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [repoDir, mode, scenario, outJson, socketArg] = process.argv.slice(2);
const socket = socketArg ?? "acstep0";
const require = createRequire(path.join(repoDir, "package.json"));
const pty = require("node-pty");
const { chromium } = require("playwright");
const TMUX = "/opt/homebrew/bin/tmux";
const CONF = process.env.AC_CONF ?? path.join(repoDir, "ops/tmux/agent-console.tmux.conf");
const INNER = path.join(repoDir, "docs/handoff/keep-sessions/step0-scripts/inner.mjs");
const COLS = 100;
const ROWS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCK = new Set(["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"]);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !BLOCK.has(k)) env[k] = v;
env.TERM = "xterm-256color";
env.LANG = "ja_JP.UTF-8";
const tmux = (...args) => execFileSync(TMUX, ["-u", "-L", socket, "-f", CONF, ...args], { env, encoding: "utf8" });
const name = "ac-step0-rig";
const HEXLOG = `/tmp/kspr-hexlog-${mode}.txt`;
writeFileSync(HEXLOG, "");
const cmd = ["/usr/local/bin/node", INNER, scenario.startsWith("esc") ? (scenario.split(":")[1] ?? "keys") : scenario];

// 画面の部品を配る小さな HTTP サーバー
const xtermDir = path.join(repoDir, "node_modules/@xterm/xterm");
const server = createServer((req, res) => {
  if (req.url === "/xterm.js") res.setHeader("content-type", "text/javascript"), res.end(readFileSync(path.join(xtermDir, "lib/xterm.js")));
  else if (req.url === "/xterm.css") res.setHeader("content-type", "text/css"), res.end(readFileSync(path.join(xtermDir, "css/xterm.css")));
  else res.setHeader("content-type", "text/html"), res.end(`<!doctype html><link rel=stylesheet href=/xterm.css><body style="margin:0"><div id=t style="width:900px;height:560px"></div><script src=/xterm.js></script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const rawLog = [];
let term;
let pending = "";
let flushing = false;
let pageReady = false;
let closed = false;
const flushSoon = () => {
  if (flushing || !pageReady || closed) return;
  flushing = true;
  setTimeout(async () => {
    const chunk = pending; pending = ""; flushing = false;
    if (closed || chunk === "") return;
    await page.evaluate((c) => window.term.write(c), chunk).catch(() => undefined);
    if (pending !== "") flushSoon();
  }, 20);
};
if (mode === "tmux") {
  tmux("new-session", "-d", "-s", name, "-x", String(COLS), "-y", String(ROWS), "-c", "/tmp", "-e", "AC_RESUME_ID=demo-resume", "-e", `HEXLOG=${HEXLOG}`, "--", ...cmd);
  term = pty.spawn(TMUX, ["-u", "-L", socket, "-f", CONF, "attach-session", "-E", "-t", `=${name}`], { name: "xterm-256color", cols: COLS, rows: ROWS, env });
} else {
  term = pty.spawn(cmd[0], cmd.slice(1), { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: "/tmp", env: { ...env, AC_RESUME_ID: "demo-resume", HEXLOG } });
}
const toPage = []; // 画面からの入力
// XDA_REPLY=1: tmux の XTVERSION 問い合わせ（\e[>q）に、サーバー側で代わりに答える（xterm.js は答えない）
let xdaAnswered = 0;
term.onData((d) => {
  rawLog.push(d); pending += d; flushSoon();
  if (process.env.XDA_REPLY === "1" && d.includes("\x1b[>q")) { term.write("\x1bP>|xterm.js(6.0.0)\x1b\\"); xdaAnswered += 1; }
});
await page.exposeFunction("acInput", (data) => { toPage.push(data); term.write(data); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate(({ cols, rows }) => {
  window.term = new Terminal({ cols, rows, scrollback: 2000 });
  window.term.open(document.getElementById("t"));
  window.term.onData((d) => window.acInput(d));
  window.written = [];
}, { cols: COLS, rows: ROWS });
pageReady = true;
flushSoon();

const state = () => page.evaluate(() => {
  const b = window.term.buffer.active;
  const line = (i) => b.getLine(i)?.translateToString(true) ?? null;
  return { type: b.type, baseY: b.baseY, viewportY: b.viewportY, length: b.length, line0: line(0), lineLast: line(b.length - 1), viewportTop: line(b.viewportY), viewportBottom: line(b.viewportY + window.term.rows - 1), mouseTrackingMode: window.term.modes.mouseTrackingMode, bracketedPasteMode: window.term.modes.bracketedPasteMode };
});
const result = { mode, scenario, tmuxVersion: mode === "tmux" ? execFileSync(TMUX, ["-V"], { encoding: "utf8" }).trim() : null };
await sleep(scenario === "scrollslow" ? 5000 : 1500);

if (/^scroll/.test(scenario)) {
  result.afterOutput = await state();
  const box = await page.locator("#t").boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  const inputBefore = toPage.length;
  await page.mouse.wheel(0, -300);
  await sleep(400);
  result.afterWheelUp = await state();
  result.bytesSentToPtyByWheel = toPage.slice(inputBefore);
  await page.mouse.wheel(0, 2000);
  await sleep(400);
  result.afterWheelDown = await state();
  if (mode === "tmux") result.paneInMode = tmux("display", "-p", "-t", `=${name}:`, "#{pane_in_mode}").trim();
  // 選択とコピー: 全選択の文字数（スクロールバックを含む）
  result.selectAllLength = await page.evaluate(() => { window.term.selectAll(); return window.term.getSelection().length; });
  result.selectAllHasLine1 = await page.evaluate(() => window.term.getSelection().includes("line 1\n"));
  // 画面の再描画（resize）後も壊れないか
  await page.evaluate(() => window.term.resize(80, 24));
  term.resize(80, 24);
  await sleep(800);
  result.afterResize = await state();
}

if (scenario.startsWith("esc")) {
  result.xdaAnsweredByServer = xdaAnswered;
  result.startupRepliesFromXterm = toPage.map((d) => d.replace(/\x1b/g, "\\e"));
  result.startupQueriesFromTmux = (rawLog.join("").match(/\x1b\[[>?]?[0-9;]*[c$q]|\x1b\][0-9]+;\?\x1b?\\?/g) ?? []).map((d) => d.replace(/\x1b/g, "\\e"));
  // Esc 単体を 10 回: 届くまでの時間（escape-time 0 の確認）
  const reads = () => readFileSync(HEXLOG, "utf8").split("\n").filter(Boolean).map((l) => { const [t, h] = l.split(" "); return { t: Number(t), hex: h }; });
  await page.locator(".xterm-helper-textarea").focus();
  result.esc = [];
  for (let n = 0; n < 10; n++) {
    const before = reads().length;
    const t0 = Date.now();
    await page.keyboard.press("Escape");
    let got = [];
    for (let i = 0; i < 40; i++) { await sleep(25); got = reads().slice(before); if (got.length > 0) break; }
    result.esc.push({ hex: got.map((g) => g.hex), latencyMs: got[0] ? got[0].t - t0 : null });
    await sleep(200);
  }
  const lat = result.esc.map((e) => e.latencyMs).filter((x) => x !== null).sort((a, b) => a - b);
  result.escLatencyMs = { min: lat[0], median: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1] };
}

if (scenario === "keys") {
  result.afterStart = await state();
  const reads = () => readFileSync(HEXLOG, "utf8").split("\n").filter(Boolean).map((l) => { const [t, h] = l.split(" "); return { t: Number(t), hex: h }; });
  const keys = [["Control+b", "Ctrl+B"], ["Escape", "Esc"], ["Shift+Enter", "Shift+Enter"], ["Enter", "Enter"], ["ArrowUp", "ArrowUp"], ["Control+c", "Ctrl+C"], ["a", "a"], ["Shift+Tab", "Shift+Tab"], ["Alt+b", "Alt+B"], ["Alt+Enter", "Alt+Enter"], ["Control+Shift+a", "Ctrl+Shift+A"]];
  await page.locator(".xterm-helper-textarea").focus();
  result.keys = [];
  for (const [key, label] of keys) {
    const before = reads().length;
    const t0 = Date.now();
    await page.keyboard.press(key);
    let got = [];
    for (let i = 0; i < 20; i++) { await sleep(50); got = reads().slice(before); if (got.length > 0) break; }
    await sleep(100);
    got = reads().slice(before);
    result.keys.push({ label, hex: got.map((g) => g.hex), firstLatencyMs: got[0] ? got[0].t - t0 : null });
  }
  // 貼り付け（1 回で届くか）。括弧付き貼り付けの印（1b5b3230307e ... 1b5b3230317e）で包まれているか
  let before = reads().length;
  await page.evaluate(() => window.term.paste("hello\nworld"));
  await sleep(700);
  let got = reads().slice(before).map((g) => g.hex);
  result.paste = { reads: got.length, joined: got.join(""), bracketed: got.join("").startsWith("1b5b3230307e") && got.join("").endsWith("1b5b3230317e") };
  // 長い貼り付け（4000 文字）
  before = reads().length;
  await page.evaluate(() => window.term.paste("x".repeat(4000)));
  await sleep(1200);
  got = reads().slice(before).map((g) => g.hex);
  const joined = got.join("");
  result.longPaste = { reads: got.length, bytes: joined.length / 2, startsWithBracket: joined.startsWith("1b5b3230307e"), endsWithBracket: joined.endsWith("1b5b3230317e"), xCount: (joined.match(/78/g) ?? []).length };
  // マウス（アプリがマウス追跡を要求している）: ホイールがそのまま中へ届くか
  const box = await page.locator("#t").boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  before = reads().length;
  await page.mouse.wheel(0, -100);
  await sleep(600);
  result.mouseWheel = { newInputs: reads().slice(before).map((g) => g.hex) };
  result.afterKeysState = await state();
  const all2 = rawLog.join("");
  result.outerSequences = { osc52: all2.includes("\x1b]52;"), osc52Raw: (all2.match(/\x1b\]52;[^\x07\x1b]*(\x07|\x1b\\)/) ?? [null])[0], mode2004h: all2.includes("\x1b[?2004h"), mode1000h: all2.includes("\x1b[?1000h"), mode1006h: all2.includes("\x1b[?1006h"), smcup1049h: all2.includes("\x1b[?1049h") };
  result.envLine = (all2.match(/ENV [^\r]*/) ?? [null])[0];
  result.japanese = all2.includes("日本語OK");
  // リサイズ
  term.resize(70, 20);
  await sleep(800);
  result.resizeSeen = (rawLog.join("").match(/RESIZE \d+x\d+/g) ?? []);
}

closed = true;
writeFileSync(outJson, JSON.stringify(result, null, 2));
writeFileSync(outJson.replace(/\.json$/, ".raw.txt"), rawLog.join("").replace(/\x1b/g, "\\e").replace(/\x07/g, "\\a"));
console.log(JSON.stringify(result, null, 2));
try { term.kill(); } catch { /* */ }
if (mode === "tmux") { try { tmux("kill-session", "-t", `=${name}`); } catch { /* */ } }
await browser.close();
server.close();
process.exit(0);
