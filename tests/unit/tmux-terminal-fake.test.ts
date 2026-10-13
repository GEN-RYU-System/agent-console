import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxControlTerminal } from "../../server/terminal-host/tmux-terminal.ts";
import { CommandQueue } from "../../server/terminal-host/tmux-protocol.ts";
import { sleep, waitFor } from "./helpers/tmux-env.ts";

/**
 * 偽の tmux（control mode の応答を台本どおりに返す）で TmuxControlTerminal を動かす。本物の tmux・ソケットには触れない。
 * FAKE_MODE: "tail" = 3本目の %end と同じ塊に %output が続く / "stale" = 番号が古い応答が先に来る
 *   "readydie" = 最初の応答だけ返して終わる（has-session は alive） / "plain" = 先入れに普通に答える
 * FAKE_LOG: 受けた命令を書き出すファイル
 */
const FAKE = `
const fs = require("node:fs");
if (process.argv.includes("has-session")) process.exit(0);
const mode = process.env.FAKE_MODE;
const block = (num, lines) => "%begin 1 " + num + " 1\\n" + lines.map((l) => l + "\\n").join("") + "%end 1 " + num + " 1\\n";
process.stdout.write("%begin 1 100 0\\n%end 1 100 0\\n");
if (mode === "readydie") setTimeout(() => process.exit(0), 30);
let buf = "";
let answered = false;
// drift: 命令を受けるたびに pane の出力が3行進む台本（履歴と可視を別の命令で取ると間の行が欠ける）
let total = 10;
let nextNum = 101;
let consumed = 0;
const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(String(i)); return r; };
function drift(line) {
  if (line.startsWith("display")) return block(nextNum++, ["4242 0 " + (total - 3) + " 0 0 1 default 0 4294967295 4294967295 0 3 []"]);
  if (!line.startsWith("capture-pane")) return "";
  if (line.includes(" -a ")) return block(nextNum++, []);
  let lines;
  if (line.includes("-S -")) lines = range(1, total);
  else lines = range(total - 2, total);
  total += 3;
  return block(nextNum++, lines);
}
process.stdin.on("data", (d) => {
  buf += d;
  if (mode === "drift") {
    const ls = buf.split("\\n");
    ls.pop();
    let out = "";
    for (; consumed < ls.length; consumed++) out += drift(ls[consumed]);
    if (out) process.stdout.write(out);
    return;
  }
  if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, buf);
  const lines = buf.split("\\n").filter(Boolean);
  if (!answered && lines.length >= 3 && mode !== "readydie") {
    answered = true;
    let out = "";
    if (mode === "stale") out += block(50, ["stale"]);
    out += block(101, ["4242 0 0 0 0 1 default 0 4294967295 4294967295 0 1 []"]);
    out += block(102, ["visible"]);
    out += block(103, []);
    if (mode === "tail" || mode === "stale") out += "%output %0 TAIL\\\\015\\\\012\\n";
    process.stdout.write(out);
  }
});
`;

let dir = "";
let tmuxPath = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-fake-tmux-"));
  const js = path.join(dir, "fake.cjs");
  writeFileSync(js, FAKE);
  tmuxPath = path.join(dir, "tmux");
  writeFileSync(tmuxPath, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(tmuxPath, 0o755);
  mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function open(mode: string, reattachIntervalMs?: number, extraEnv: Record<string, string> = {}) {
  const events: string[] = [];
  const warns: string[] = [];
  const term = new TmuxControlTerminal({
    ctx: { tmux: tmuxPath, socket: "ac-test-fake", conf: "/dev/null" },
    name: "ac-00000000-0000-0000-0000-000000000000",
    pid: 0,
    env: { PATH: process.env.PATH ?? "", FAKE_MODE: mode, ...extraEnv },
    logger: { info: () => undefined, warn: (m) => warns.push(m) },
    ...(reattachIntervalMs !== undefined ? { reattachIntervalMs } : {}),
  });
  const replays: string[] = [];
  term.onReplay((d) => {
    replays.push(d);
    events.push("replay");
  });
  term.onData((d) => events.push(`data:${JSON.stringify(d)}`));
  const statuses: string[] = [];
  term.onStatus((st) => statuses.push(st));
  return { term, events, warns, statuses, replays };
}

describe("TmuxControlTerminal with a scripted tmux", () => {
  it("S1: history and the visible screen come from one capture; lines that scroll in while replaying leave no gap or overlap", async () => {
    const { term, replays } = open("drift");
    expect(await waitFor(() => replays.length >= 1, 5000)).toBe(true);
    const m = /\x1b\[3J([\d\r\n]*)/.exec(replays[0]);
    const nums = (m?.[1] ?? "").split("\r\n").map(Number);
    expect(nums.length).toBeGreaterThan(0);
    nums.forEach((n, i) => expect(n).toBe(nums[0] + i));
    expect(nums[0]).toBe(1);
    term.release();
  });

  it("R2: an %output in the same chunk as the 3rd %end is kept, and arrives after the replay", async () => {
    const { term, events } = open("tail");
    expect(await waitFor(() => events.length >= 2, 5000)).toBe(true);
    expect(events).toEqual(["replay", 'data:"TAIL\\r\\n"']);
    expect(term.pid).toBe(4242);
    term.release();
  });

  it("R3: a response whose number is not newer than the last one is dropped with a warning; the replay still completes", async () => {
    const { term, events, warns } = open("stale");
    expect(await waitFor(() => events.length >= 2, 5000)).toBe(true);
    expect(events).toEqual(["replay", 'data:"TAIL\\r\\n"']);
    expect(warns.some((w) => w.includes("50"))).toBe(true);
    await sleep(50);
    term.release();
  });
});

describe("CommandQueue numbering (R3)", () => {
  it("takes a waiter only for a number newer than the last seen one", () => {
    const q = new CommandQueue<string>();
    q.markSeen(100);
    q.enqueue("a");
    q.enqueue("b");
    expect(q.take(99)).toBeUndefined();
    expect(q.take(100)).toBeUndefined();
    expect(q.size).toBe(2);
    expect(q.take(105)).toBe("a");
    expect(q.take(105)).toBeUndefined();
    expect(q.take(107)).toBe("b");
    expect(q.take(108)).toBeUndefined();
  });
});

describe("R7: retry count and the pending-input limit", () => {
  it("a client that answers once and then dies every time still stops after 3 attempts (the count is not reset by the first answer)", async () => {
    const { term, statuses } = open("readydie", 20);
    expect(await waitFor(() => statuses.includes("failed"), 5000)).toBe(true);
    term.release();
  });

  it("input held while not connected is capped at 64KB: the new input is refused (old input is kept) with a warning", async () => {
    const log = path.join(dir, "stdin.log");
    const { term, warns } = open("plain", undefined, { FAKE_LOG: log });
    term.write("a".repeat(40000));
    term.write("b".repeat(40000)); // 合計 80000 > 65536 → 断る
    expect(warns.some((w) => w.includes("pending input"))).toBe(true);
    // 接続後に溜めた物が流れる: 古い入力（a）は届き、断った入力（b）は届かない
    const read = (): string => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    };
    expect(await waitFor(() => (read().match(/send-keys/g) ?? []).length >= 40, 8000)).toBe(true);
    const sent = read();
    expect(sent).toContain(" 61 ");
    expect(sent).not.toContain(" 62 ");
    term.release();
  });
});
