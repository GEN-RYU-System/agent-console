import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxControlTerminal } from "../../server/terminal-host/tmux-terminal.ts";
import { CommandQueue } from "../../server/terminal-host/tmux-protocol.ts";
import { sleep, waitFor } from "./helpers/tmux-env.ts";

/**
 * 偽の tmux（control mode の応答を台本どおりに返す）で TmuxControlTerminal を動かす。本物の tmux・ソケットには触れない。
 * FAKE_MODE: "tail" = 4本目の %end と同じ塊に %output が続く / "stale" = 番号が古い応答が先に来る
 * FAKE_LOG: 受けた命令を書き出すファイル
 */
const FAKE = `
const fs = require("node:fs");
if (process.argv.includes("has-session")) process.exit(0);
const mode = process.env.FAKE_MODE;
const block = (num, lines) => "%begin 1 " + num + " 1\\n" + lines.map((l) => l + "\\n").join("") + "%end 1 " + num + " 1\\n";
process.stdout.write("%begin 1 100 0\\n%end 1 100 0\\n");
let buf = "";
let answered = false;
process.stdin.on("data", (d) => {
  buf += d;
  if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, buf);
  const lines = buf.split("\\n").filter(Boolean);
  if (!answered && lines.length >= 4) {
    answered = true;
    let out = "";
    if (mode === "stale") out += block(50, ["stale"]);
    out += block(101, ["4242 0 0 0 0 1 default 0 4294967295 4294967295 0 []"]);
    out += block(102, []);
    out += block(103, []);
    out += block(104, ["visible"]);
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

function open(mode: string) {
  const events: string[] = [];
  const warns: string[] = [];
  const term = new TmuxControlTerminal({
    ctx: { tmux: tmuxPath, socket: "ac-test-fake", conf: "/dev/null" },
    name: "ac-00000000-0000-0000-0000-000000000000",
    pid: 0,
    env: { PATH: process.env.PATH ?? "", FAKE_MODE: mode },
    logger: { info: () => undefined, warn: (m) => warns.push(m) },
  });
  term.onReplay(() => events.push("replay"));
  term.onData((d) => events.push(`data:${JSON.stringify(d)}`));
  return { term, events, warns };
}

describe("TmuxControlTerminal with a scripted tmux", () => {
  it("R2: an %output in the same chunk as the 4th %end is kept, and arrives after the replay", async () => {
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
