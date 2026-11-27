// 使い方: node scripts/measure-smooth/run.mjs [reps=5] [--o3]
// 道A（node-pty 直結 + @xterm/headless）と道B（tmux -L ac-smooth-test + dist-server の TmuxControlTerminal）を交互に測る。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { COLS, ROWS, Recorder, analyze, makeConversation, newHeadless, screenText, sleep } from "./lib.mjs";
const require = createRequire(import.meta.url);
const pty = require("node-pty");

const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.join(root, "docs/handoff/terminal-smooth/evidence");
const rawDir = path.join(outDir, "raw");
fs.mkdirSync(rawDir, { recursive: true });
const reps = Number(process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : 5);
const doO3 = process.argv.includes("--o3");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const cwd = process.env.MEASURE_CWD;
if (!cwd) throw new Error("MEASURE_CWD を指定する");
fs.mkdirSync(cwd, { recursive: true });

const SOCKET = "ac-smooth-test";
const CONF = path.join(root, "ops/tmux/agent-console.tmux.conf");
const { TmuxControlTerminal } = await import(path.join(root, "dist-server/server/terminal-host/tmux-terminal.js"));
const { newSession, findTmux } = await import(path.join(root, "dist-server/server/terminal-host/tmux-runner.js"));
const tmux = findTmux(undefined);
const ctx = { tmux, socket: SOCKET, conf: CONF };
const logger = { info() {}, warn: (m) => console.error("[tmux warn]", m) };

const conv = makeConversation(cwd);
const claudeArgs = (extra) => ["--resume", conv.id, ...extra];
const baseEnv = () => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && k !== "TMUX" && k !== "TMUX_PANE") e[k] = v;
  e.TERM = "xterm-256color";
  e.LANG = e.LANG || "C.UTF-8";
  return e;
};

/** 道ごとの「開く」。返す物: write, close, onData 登録済みの recorder と headless */
async function open(route, extra) {
  const rec = new Recorder();
  let write = () => {};
  const term = newHeadless((d) => write(d));
  let closer = () => {};
  if (route === "A") {
    const env = baseEnv();
    delete env.TMUX;
    const p = pty.spawn("claude", claudeArgs(extra), { name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env });
    write = (d) => p.write(d);
    p.onData((s) => {
      rec.onChunk(s);
      term.write(s);
    });
    closer = () => {
      try {
        p.kill();
      } catch {}
    };
  } else {
    const name = `ac-${conv.id.slice(0, 8)}-${Date.now() % 100000}`;
    const env = baseEnv();
    const pid = newSession(ctx, { name, cols: COLS, rows: ROWS, cwd, command: ["claude", ...claudeArgs(extra)], env: {} }, env);
    const t = new TmuxControlTerminal({ ctx, name, pid, env, logger });
    write = (d) => t.write(d);
    t.onReplay((s) => term.write(s));
    t.onData((s) => {
      rec.onChunk(s);
      term.write(s);
    });
    closer = () => {
      t.kill();
      t.release();
    };
    // 接続（先入れ）が済むまで待つ
    for (let i = 0; i < 200 && !t.writeState().writable; i++) await sleep(25);
  }
  return { rec, term, write: (d) => write(d), close: closer };
}

const OPS = {
  async O1(h) {
    const text = "あいうえおabcde".repeat(4);
    for (const ch of text) {
      h.rec.markInput();
      h.write(ch);
      await sleep(80);
    }
  },
  async O2(h) {
    for (const dir of [64, 65]) {
      for (let i = 0; i < 30; i++) {
        h.rec.markInput();
        h.write(`\x1b[<${dir};60;20M`);
        await sleep(33);
      }
    }
  },
  async O3(h) {
    h.write("1から40まで1行ずつ数字だけ書いて");
    await sleep(300);
    h.rec.markInput();
    h.write("\r");
    const t0 = performance.now();
    await sleep(2000);
    await h.rec.settle(120000 - (performance.now() - t0) > 0 ? 120000 : 1);
  },
};

async function measure(route, op, n) {
  const extra = op === "O3" ? ["--model", "sonnet"] : [];
  const h = await open(route, extra);
  const log = { route, op, n, loadBefore: os.loadavg()[0] };
  const ok = await h.rec.settle(60000);
  log.startSettled = ok;
  if (!ok) {
    fs.writeFileSync(path.join(outDir, "blocked.txt"), `起動後に落ち着かない (${route} ${op} ${n})\n` + screenText(h.term));
  }
  log.startScreen = screenText(h.term);
  h.rec.chunks.length = 0;
  h.rec.recording = true;
  const t0 = performance.now();
  await OPS[op](h);
  await h.rec.settle(10000);
  const tEnd = performance.now();
  h.rec.recording = false;
  log.loadAfter = os.loadavg()[0];
  log.durationMs = tEnd - t0;
  log.finalScreen = screenText(h.term);
  const updates = analyze(h.rec.chunks, h.rec.inputs);
  log.updates = updates;
  h.close();
  await sleep(300);
  // 生データ: 1 塊 1 行
  const lines = h.rec.chunks.map((c) => JSON.stringify({ route, op, n, tMs: +(c.t - t0).toFixed(3), bytes: c.bytes, h2026: c.h, l2026: c.l, afterInput: c.inputIdx }));
  fs.writeFileSync(path.join(rawDir, `${route}-${op}-${n}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
  fs.writeFileSync(path.join(rawDir, `${route}-${op}-${n}.meta.json`), JSON.stringify({ ...log, inputs: h.rec.inputs.map((i) => ({ idx: i.idx, tMs: +(i.t - t0).toFixed(3) })), updates: undefined, updateSummary: updates }, null, 1));
  return log;
}

const summary = [];
const ops = ["O1", "O2"].filter((o) => !only || only === o);
for (const op of ops) {
  for (let n = 1; n <= reps; n++) {
    for (const route of ["A", "B"]) {
      const log = await measure(route, op, n);
      console.log(route, op, n, "chunks-updates", log.updates.length, "load", log.loadBefore.toFixed(2), "->", log.loadAfter.toFixed(2));
      summary.push(log);
    }
  }
}
if (doO3 || only === "O3") {
  for (const route of ["A", "B"]) {
    const log = await measure(route, "O3", 1);
    console.log(route, "O3", "updates", log.updates.length);
    summary.push(log);
  }
}
fs.writeFileSync(path.join(rawDir, "summary.json"), JSON.stringify(summary, null, 1));
process.exit(0);
