// 測定の共通部品（設計 docs/handoff/terminal-smooth/design.md §4）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export const COLS = 120;
export const ROWS = 40;
export const SETTLE_MS = 500;
export const QUIET_MS = 50;
export const GAP_MS = 8;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 合成の会話記録（60 往復・各 5〜15 行）。~/.claude/projects/<cwd を - にした名前>/<id>.jsonl に置く */
export function makeConversation(cwd) {
  const id = crypto.randomUUID();
  const dir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let parent = null;
  let t = Date.parse("2026-11-01T00:00:00Z");
  const base = { isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.332", gitBranch: "" };
  const rnd = (seed) => {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  };
  const r = rnd(42);
  const body = (who, n) => Array.from({ length: n }, (_, i) => `${who}の発言 ${n}行中の${i + 1}行目: 合成の会話です。abc def ghi ${Math.floor(r() * 1e6)}`).join("\n");
  for (let i = 0; i < 60; i++) {
    const u = crypto.randomUUID();
    lines.push({ ...base, parentUuid: parent, type: "user", message: { role: "user", content: body("利用者", 5 + Math.floor(r() * 11)) }, uuid: u, timestamp: new Date((t += 1000)).toISOString() });
    const a = crypto.randomUUID();
    lines.push({
      ...base,
      parentUuid: u,
      type: "assistant",
      message: { id: `msg_${a.replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: body("Claude", 5 + Math.floor(r() * 11)) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } },
      uuid: a,
      timestamp: new Date((t += 1000)).toISOString(),
    });
    parent = a;
  }
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { id, file };
}

export function newHeadless(onReply) {
  const { Terminal } = require("@xterm/headless");
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  term.onData((d) => onReply(d));
  return term;
}

export function screenText(term) {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push((b.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** 受信の記録。chunks: {t, bytes, h, l, inputIdx} */
export class Recorder {
  constructor() {
    this.chunks = [];
    this.inputs = [];
    this.inputIdx = -1;
    this.last = performance.now();
    this.recording = false;
  }
  onChunk(s) {
    this.last = performance.now();
    if (!this.recording) return;
    const bytes = Buffer.byteLength(s);
    this.chunks.push({ t: this.last, bytes, h: s.split("\x1b[?2026h").length - 1, l: s.split("\x1b[?2026l").length - 1, inputIdx: this.inputIdx });
  }
  markInput() {
    this.inputIdx += 1;
    this.inputs.push({ t: performance.now(), idx: this.inputIdx });
  }
  async settle(max = 60000) {
    const t0 = performance.now();
    while (performance.now() - this.last < SETTLE_MS && performance.now() - t0 < max) await sleep(20);
    while (performance.now() - this.last < SETTLE_MS) {
      if (performance.now() - t0 > max) return false;
      await sleep(20);
    }
    return true;
  }
}

/** 更新（1 回 = 入力 1 つの後、QUIET_MS 何も来ないまでの塊）に切り、U1〜U6 の素を返す。
 * 入力の間隔が QUIET_MS より短い操作でも、入力ごとに更新を分ける（次の入力が来たら区切る）。 */
export function analyze(chunks, inputs) {
  // 同期状態は全体の流れで追う
  let on = false;
  const marked = chunks.map((c) => {
    const inside = on || c.h > 0;
    // 塊の中の最後の 2026h/2026l の並びで状態を決める（h と l の数と順序の厳密さは塊単位の近似: 数の差で足し引き）
    if (c.h > c.l) on = true;
    else if (c.l > c.h) on = false;
    else if (c.h > 0) on = on; // 同数なら閉じて出る（開始前の状態が開いていれば開いたまま）
    return { ...c, inside };
  });
  const updates = [];
  for (const inp of inputs) {
    const mine = marked.filter((c) => c.inputIdx === inp.idx);
    let cur = [];
    for (const c of mine) {
      if (cur.length && c.t - cur[cur.length - 1].t >= QUIET_MS) {
        updates.push({ input: inp, chunks: cur });
        cur = [];
      }
      cur.push(c);
    }
    if (cur.length) updates.push({ input: inp, chunks: cur });
  }
  return updates.map((u) => {
    const cs = u.chunks;
    let u4 = 0;
    for (let i = 0; i < cs.length - 1; i++) if (!cs[i].inside && cs[i + 1].t - cs[i].t >= GAP_MS) u4++;
    return {
      inputIdx: u.input.idx,
      u1: cs.length,
      u2: cs[cs.length - 1].t - cs[0].t,
      u3: cs.every((c) => c.inside),
      u4,
      u5: cs[cs.length - 1].t - u.input.t,
      u6: cs.reduce((s, c) => s + c.bytes, 0),
      h: cs.reduce((s, c) => s + c.h, 0),
      l: cs.reduce((s, c) => s + c.l, 0),
    };
  });
}

export function pct(arr, p) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}
