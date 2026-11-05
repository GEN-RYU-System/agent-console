import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandQueue, conditionalSendCommand, conditionalSendCommands, conditionalWritten, isPaneId } from "../../server/terminal-host/tmux-protocol.ts";
import { TmuxControlTerminal } from "../../server/terminal-host/tmux-terminal.ts";
import { sleep, waitFor } from "./helpers/tmux-env.ts";

/**
 * 偽の tmux（control mode）で、case-say の送る部品（区画 %N 宛て・ため込まない・条件付き）を動かす。本物の tmux・ソケットには触れない。
 * FAKE_SAY: ok = 2 つの応答（2 つ目が空）/ no = 2 つ目が NO / err1 = 1 つ目が %error で応答が 1 つで終わる / err2 = 1 つ目 %end・2 つ目 %error /
 *           odd = 2 つ目が空でも NO でもない / silent = 答えない
 * FAKE_LOG: 受けた命令（1 行ずつ追記）。FAKE_STARTS: 起動のたびに 1 行追記
 */
const FAKE = `
const fs = require("node:fs");
if (process.argv.includes("has-session")) process.exit(0);
if (process.env.FAKE_STARTS) fs.appendFileSync(process.env.FAKE_STARTS, "start\\n");
const say = process.env.FAKE_SAY;
const block = (num, lines, ok = true) => "%begin 1 " + num + " 1\\n" + lines.map((l) => l + "\\n").join("") + (ok ? "%end" : "%error") + " 1 " + num + " 1\\n";
process.stdout.write("%begin 1 100 0\\n%end 1 100 0\\n");
if (process.env.FAKE_NO_STARTUP === "1") { process.stdin.resume(); return; }
let buf = "";
let consumed = 0;
let num = 101;
process.stdin.on("data", (d) => {
  buf += d;
  const ls = buf.split("\\n");
  ls.pop();
  let out = "";
  for (; consumed < ls.length; consumed++) {
    const line = ls[consumed];
    if (consumed < 3) {
      if (consumed === 0) out += block(num++, ["4242 0 0 0 0 1 default 0 4294967295 4294967295 0 1 []"]);
      else out += block(num++, []);
      continue;
    }
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + "\\n");
    if (line.startsWith("if-shell")) {
      if (say === "ok") out += block(num++, []) + block(num++, []);
      else if (say === "no") out += block(num++, []) + block(num++, ["NO"]);
      else if (say === "err1") out += block(num++, ["cannot parse"], false);
      else if (say === "err2") out += block(num++, []) + block(num++, ["boom"], false);
      else if (say === "odd") out += block(num++, []) + block(num++, ["SOMETHING"]);
    } else if (line.startsWith("display -p -t")) {
      out += block(num++, [process.env.FAKE_PANE_PID || "4242"]);
    } else {
      out += block(num++, []);
    }
  }
  if (out) process.stdout.write(out);
});
`;

let dir = "";
let tmuxPath = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-say-fake-tmux-"));
  const js = path.join(dir, "fake.cjs");
  writeFileSync(js, FAKE.replace('process.stdin.resume(); return;', 'process.stdin.resume(); setInterval(() => undefined, 1000);'));
  tmuxPath = path.join(dir, "tmux");
  writeFileSync(tmuxPath, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(tmuxPath, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function open(say: string, extraEnv: Record<string, string> = {}) {
  seq += 1;
  const log = path.join(dir, `log-${seq}`);
  const starts = path.join(dir, `starts-${seq}`);
  const term = new TmuxControlTerminal({
    ctx: { tmux: tmuxPath, socket: "ac-test-say-fake", conf: "/dev/null" },
    name: "ac-00000000-0000-0000-0000-000000000000",
    pid: 4242,
    env: { PATH: process.env.PATH ?? "", FAKE_SAY: say, FAKE_LOG: log, FAKE_STARTS: starts, ...extraEnv },
    logger: { info: () => undefined, warn: () => undefined },
    reattachIntervalMs: 20,
  });
  const lines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const startCount = (): number => (existsSync(starts) ? readFileSync(starts, "utf8").split("\n").filter(Boolean).length : 0);
  return { term, lines, startCount };
}
const ready = (term: TmuxControlTerminal): Promise<boolean> => waitFor(() => term.writeState().writable, 5000);

describe("conditional send commands (protocol)", () => {
  it("builds the if-shell -F form with the pane number as target, the pid condition and a NO else branch", () => {
    expect(conditionalSendCommand("%7", 4242, Buffer.from("hi"))).toBe("if-shell -F -t %7 '#{==:#{pane_pid},4242}' 'send-keys -t %7 -H 68 69' 'display -p NO'");
    expect(conditionalSendCommand("%7", 4242, Buffer.from("\r"))).toContain("-H 0d'");
  });
  it("splits over 1000 bytes into one command per chunk", () => {
    const cmds = conditionalSendCommands("%3", 99, "a".repeat(2500));
    expect(cmds).toHaveLength(3);
    for (const c of cmds) expect(c.startsWith("if-shell -F -t %3 ")).toBe(true);
  });
  it("refuses a pane id or pid in a wrong form", () => {
    expect(isPaneId("%12")).toBe(true);
    for (const bad of ["12", "%", "%1;kill-server", "=ac-x:", "%1 2"]) expect(() => conditionalSendCommand(bad, 1, Buffer.from("x"))).toThrow();
    expect(() => conditionalSendCommand("%1", 0, Buffer.from("x"))).toThrow();
    expect(() => conditionalSendCommand("%1", 1.5, Buffer.from("x"))).toThrow();
  });
  it("reads written only when both blocks are %end and the second is empty", () => {
    const b = (ok: boolean, lines: string[]) => ({ num: 1, flags: 1, ok, lines });
    expect(conditionalWritten(b(true, []), b(true, []))).toBe(true);
    expect(conditionalWritten(b(true, []), b(true, ["NO"]))).toBe(false);
    expect(conditionalWritten(b(false, []), b(true, []))).toBe(false);
    expect(conditionalWritten(b(true, []), b(false, []))).toBe(false);
    expect(conditionalWritten(b(true, []), b(true, ["x"]))).toBe(false);
  });
  it("CommandQueue.drain empties the waiting list", () => {
    const q = new CommandQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    expect(q.drain()).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });
});

describe("TmuxControlTerminal.sendToPane / writeState / queryPanePid with a scripted tmux", () => {
  it("writes nothing and does not buffer before the connection is ready; writeState reports the pending writes", async () => {
    const { term, lines } = open("ok", { FAKE_NO_STARTUP: "1" });
    expect(term.writeState()).toEqual({ writable: false, pending: 0 });
    expect(await term.sendToPane("%7", 4242, "x")).toEqual({ written: false, reason: "not_writable" });
    term.write("buffered");
    expect(term.writeState()).toEqual({ writable: false, pending: 1 });
    expect(lines()).toEqual([]);
    term.release();
  });

  it("reports writable with no pending writes once ready", async () => {
    const { term } = open("ok");
    expect(await ready(term)).toBe(true);
    expect(term.writeState()).toEqual({ writable: true, pending: 0 });
    term.release();
  });

  it("sends one if-shell command per call, targeted at the pane number, and reads two blocks as written", async () => {
    const { term, lines } = open("ok");
    expect(await ready(term)).toBe(true);
    expect(await term.sendToPane("%7", 4242, "hello")).toEqual({ written: true });
    expect(lines()).toEqual(["if-shell -F -t %7 '#{==:#{pane_pid},4242}' 'send-keys -t %7 -H 68 65 6c 6c 6f' 'display -p NO'"]);
    // 続けて出した display の応答が、正しい命令に渡る
    expect(await term.queryPanePid("%7")).toBe(4242);
    term.release();
  });

  it("reads a NO second block as not written (no reconnect needed)", async () => {
    const { term, startCount } = open("no");
    expect(await ready(term)).toBe(true);
    expect(await term.sendToPane("%7", 4242, "hello")).toEqual({ written: false, reason: "not_written" });
    expect(term.writeState().writable).toBe(true);
    expect(startCount()).toBe(1);
    term.release();
  });

  it("reads a second %error and an unexpected second content as not written", async () => {
    for (const say of ["err2", "odd"]) {
      const { term } = open(say);
      expect(await ready(term)).toBe(true);
      expect(await term.sendToPane("%7", 4242, "hello")).toEqual({ written: false, reason: "not_written" });
      term.release();
    }
  });

  it("on a first %error, empties the waiting queue and reconnects", async () => {
    const { term, startCount } = open("err1");
    expect(await ready(term)).toBe(true);
    expect(await term.sendToPane("%7", 4242, "hello")).toEqual({ written: false, reason: "not_written" });
    // 待ち行列は空で、接続が取り直されるまで書ける状態にならない
    expect((term as unknown as { queue: CommandQueue<unknown> }).queue.size).toBe(0);
    expect(term.writeState().writable).toBe(false);
    expect(await waitFor(() => startCount() >= 2, 5000)).toBe(true);
    expect(await ready(term)).toBe(true);
    term.release();
  });

  it("sends a message over 1000 bytes one command at a time, and stops at the first one that is not written", async () => {
    const ok = open("ok");
    expect(await ready(ok.term)).toBe(true);
    expect(await ok.term.sendToPane("%7", 4242, "a".repeat(2500))).toEqual({ written: true });
    expect(ok.lines()).toHaveLength(3);
    ok.term.release();
    const no = open("no");
    expect(await ready(no.term)).toBe(true);
    expect(await no.term.sendToPane("%7", 4242, "a".repeat(2500))).toEqual({ written: false, reason: "not_written" });
    expect(no.lines()).toHaveLength(1);
    no.term.release();
  });

  it("returns invalid for a malformed pane id without writing", async () => {
    const { term, lines } = open("ok");
    expect(await ready(term)).toBe(true);
    expect(await term.sendToPane("=ac-x:", 4242, "x")).toEqual({ written: false, reason: "invalid" });
    await sleep(30);
    expect(lines()).toEqual([]);
    term.release();
  });

  it("queryPanePid returns null when the pane pid cannot be read", async () => {
    const { term } = open("ok", { FAKE_PANE_PID: "oops" });
    expect(await ready(term)).toBe(true);
    expect(await term.queryPanePid("%7")).toBeNull();
    term.release();
  });
});
