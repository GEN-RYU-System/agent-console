// 工程0 K3/R1/R4: 本物の claude を tmux の中で動かし、作業の途中でアプリのサーバー役（この node）の attach だけを切って、つなぎ直す。
// 使い方: node real-claude.mjs <repoDir> <workDir(信頼済みの捨てディレクトリ)> <outJson> [socket]
// 実行は 1 回だけ（週の使用量が上限に近いため）。sonnet に短い依頼を 1 つ出す。
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [repoDir, workDir, outJson, socketArg] = process.argv.slice(2);
const socket = socketArg ?? "acstep0";
const require = createRequire(path.join(repoDir, "package.json"));
const pty = require("node-pty");
const { chromium } = require("playwright");
const TMUX = "/opt/homebrew/bin/tmux";
const CONF = path.join(repoDir, "ops/tmux/agent-console.tmux.conf");
const COLS = 120;
const ROWS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCK = new Set(["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"]);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !BLOCK.has(k)) env[k] = v;
env.TERM = "xterm-256color";
env.LANG = "ja_JP.UTF-8";
const tmux = (...args) => execFileSync(TMUX, ["-u", "-L", socket, "-f", CONF, ...args], { env, encoding: "utf8" });
const name = "ac-step0-claude";
const stamp = () => new Date().toISOString().slice(11, 23);
const events = [];
const note = (m) => { events.push(`${stamp()} ${m}`); console.log(`${stamp()} ${m}`); };
const screen = () => tmux("capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", "-400");
const panePid = () => tmux("display", "-p", "-t", `=${name}:`, "#{pane_pid}").trim();
// pane の子孫のうち、command に claude を含むプロセス（pid と command の先頭 60 字）
const kids = (pid) => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const seen = new Set([Number(pid)]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); grew = true; } }
  return rows.filter((r) => seen.has(r.pid) && r.pid !== Number(pid) && /claude/i.test(r.cmd)).map((r) => `${r.pid}:${r.cmd.slice(0, 60)}`);
};

const xtermDir = path.join(repoDir, "node_modules/@xterm/xterm");
const server = createServer((req, res) => {
  if (req.url === "/xterm.js") res.setHeader("content-type", "text/javascript"), res.end(readFileSync(path.join(xtermDir, "lib/xterm.js")));
  else if (req.url === "/xterm.css") res.setHeader("content-type", "text/css"), res.end(readFileSync(path.join(xtermDir, "css/xterm.css")));
  else res.setHeader("content-type", "text/html"), res.end(`<!doctype html><link rel=stylesheet href=/xterm.css><body style="margin:0"><div id=t style="width:1000px;height:560px"></div><script src=/xterm.js></script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
const prompt = "Use the Bash tool to run exactly: sleep 30 && echo DONE . After it finishes, print the numbers 1 to 120 as plain text, one number per line (no code block, no commentary), then on the last line write FINISHED.";
const command = `claude --model sonnet --setting-sources project,local '${prompt}'`;

let attach = null;
let target = null; // 画面に書く先
const toPage = [];
await page.exposeFunction("acInput", (d) => { toPage.push(d); attach?.write(d); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.evaluate(({ cols, rows }) => { window.term = new Terminal({ cols, rows, scrollback: 2000 }); window.term.open(document.getElementById("t")); window.term.onData((d) => window.acInput(d)); }, { cols: COLS, rows: ROWS });

const rawLog = [];
function connect(label) {
  const t = pty.spawn(TMUX, ["-u", "-L", socket, "-f", CONF, "attach-session", "-E", "-t", `=${name}`], { name: "xterm-256color", cols: COLS, rows: ROWS, env });
  let pending = ""; let busy = false; let dead = false;
  const flush = () => { if (busy || dead) return; busy = true; setTimeout(async () => { const c = pending; pending = ""; busy = false; if (c) await page.evaluate((x) => window.term.write(x), c).catch(() => undefined); if (pending) flush(); }, 20); };
  t.onData((d) => { rawLog.push(`[${label}]`); rawLog.push(d); pending += d; flush(); });
  t.onExit((e) => { dead = true; note(`attach ${label} exited ${JSON.stringify(e)}`); });
  note(`attach ${label} pid=${t.pid}`);
  return t;
}

// STUB=1 のときは claude を使わず、同じ流れの偽プログラムで試験台だけを確かめる（使用量を使わない予行演習）
const stubCmd = "echo 'sleep 30 running'; sleep 8; echo DONE; i=1; while [ $i -le 120 ]; do echo $i; i=$((i+1)); sleep 0.03; done; echo FINISHED; sleep 600";
const argv = process.env.STUB === "1" ? ["/bin/sh", "-c", stubCmd] : ["/bin/zsh", "-ic", command];
tmux("new-session", "-d", "-s", name, "-x", String(COLS), "-y", String(ROWS), "-c", workDir, "--", ...argv);
const pane = panePid();
note(`new-session done. pane_pid=${pane}`);
attach = connect("A");

// 1. claude が sleep 30 の実行を始めるのを待つ
let started = false;
for (let i = 0; i < 120 && !started; i++) { await sleep(500); started = /sleep 30/.test(screen()); }
note(`sleep 30 visible on screen: ${started}`);
const psOf = (pid) => { try { return execFileSync("ps", ["-o", "pid=,ppid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8" }).trim().slice(0, 140); } catch { return "(gone)"; } };
const psBefore = psOf(pane);
note(`ps pane_pid before: ${psBefore}`);
const claudeBefore = kids(pane);
note(`children of pane_pid before: ${claudeBefore.join(",")}`);
const snapBefore = screen();
writeFileSync(outJson.replace(/\.json$/, ".before.txt"), snapBefore);

// 2. アプリのサーバーが再起動したのと同じこと: attach だけを終わらせる（SIGHUP）
await sleep(2000);
attach.kill();
attach = null;
note("attach A killed (SIGHUP) = server shutdown");
await sleep(500);
note(`pane_pid after kill = ${panePid()} (before ${pane}); list-clients=[${tmux("list-clients").trim()}]`);
// 3. 数秒おいて、新しいサーバーがつなぎ直す
await sleep(4000);
await page.evaluate(() => window.term.reset());
attach = connect("B");
note("attach B connected (new server)");

// 4. 作業が最後まで終わるのを待つ（FINISHED が出る）
let finished = false;
for (let i = 0; i < 240 && !finished; i++) { await sleep(500); const s = screen(); finished = /^\s*FINISHED\s*$/m.test(s) && /^\s*120\s*$/m.test(s); }
note(`FINISHED visible: ${finished}`);
await sleep(2000);
const psAfter = psOf(pane);
note(`ps pane_pid after: ${psAfter}`);
const claudeAfter = kids(pane);
note(`pane_pid now = ${panePid()}; children after: ${claudeAfter.join(",")}`);
const snapAfter = screen();
writeFileSync(outJson.replace(/\.json$/, ".after.txt"), snapAfter);

// 5. 画面側（xterm.js）の状態とホイール
const st = () => page.evaluate(() => { const b = window.term.buffer.active; const l = (i) => b.getLine(i)?.translateToString(true) ?? null; return { type: b.type, baseY: b.baseY, viewportY: b.viewportY, length: b.length, top: l(b.viewportY), bottom: l(b.viewportY + window.term.rows - 1), mouseTrackingMode: window.term.modes.mouseTrackingMode, bracketedPasteMode: window.term.modes.bracketedPasteMode }; });
const box = await page.locator("#t").boundingBox();
await page.mouse.move(box.x + 200, box.y + 200);
const result = { events, pane, tmuxVersion: execFileSync(TMUX, ["-V"], { encoding: "utf8" }).trim() };
result.xtermAfterFinish = await st();
const inBefore = toPage.length;
await page.mouse.wheel(0, -300);
await sleep(500);
result.xtermAfterWheelUp = await st();
result.bytesSentByWheel = toPage.slice(inBefore);
result.paneInMode = tmux("display", "-p", "-t", `=${name}:`, "#{pane_in_mode}").trim();
await page.mouse.wheel(0, 3000);
await sleep(300);
result.xtermAfterWheelDown = await st();
result.psBefore = psBefore;
result.psAfter = psAfter;
result.samePanePidAndStartTime = psBefore === psAfter;
result.sameClaudeChildren = JSON.stringify(claudeBefore) === JSON.stringify(claudeAfter);
result.sameSleepHistoryInTmux = /DONE/.test(snapAfter);
writeFileSync(outJson, JSON.stringify(result, null, 2));
writeFileSync(outJson.replace(/\.json$/, ".raw.txt"), rawLog.join("").replace(/\x1b/g, "\\e").replace(/\x07/g, "\\a"));
console.log(JSON.stringify(result, null, 2));
attach?.kill();
try { tmux("kill-session", "-t", `=${name}`); } catch { /* */ }
await browser.close();
server.close();
process.exit(0);
