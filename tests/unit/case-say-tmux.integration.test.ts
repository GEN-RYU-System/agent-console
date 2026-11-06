import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlParser, type ControlBlock } from "../../server/terminal-host/tmux-protocol.ts";
import { newSession, tmuxVersion } from "../../server/terminal-host/tmux-runner.ts";
import { TmuxControlTerminal } from "../../server/terminal-host/tmux-terminal.ts";
import { cleanupSockets, CONF, REQUIRE_TMUX, TMUX, testSocket, tmuxRun, waitFor } from "./helpers/tmux-env.ts";

vi.setConfig({ testTimeout: 30000 });

// design conversation-consent §14-10-7 K31 の本物の tmux の試験。専用ソケットで窓を作り、制御の接続から条件付きの送り方を
// 「条件が合う場合」と「外れる場合」で 1 回ずつ出し、応答がどちらも 2 つで、2 つ目が空と NO になり、続けて出した display の応答が正しい命令に渡ることを確かめる。
// CI の ubuntu で回す。Mac では回さない（darwin は skip）。
const available = TMUX !== null && process.platform !== "darwin";
const suite = available || (REQUIRE_TMUX && process.platform !== "darwin") ? describe : describe.skip;

suite("case-say conditional send (real tmux, dedicated socket)", () => {
  const socket = testSocket();
  const name = "ac-00000000-0000-0000-0000-0000000000aa";
  let panePid = 0;
  let paneId = "";

  beforeAll(() => {
    if (TMUX === null) throw new Error("tmux is required in CI but was not found");
    // その場の tmux の版を記録する
    console.log(`[case-say-tmux] ${tmuxVersion(TMUX) ?? "(version unknown)"}`);
    const ctx = { tmux: TMUX, socket, conf: CONF };
    panePid = newSession(ctx, { name, cols: 120, rows: 30, cwd: "/tmp", command: ["/bin/sh", "-c", "cat"], env: {} }, { PATH: process.env.PATH ?? "" });
    paneId = tmuxRun(socket, ["display", "-p", "-t", `=${name}:`, "#{pane_id}"]).stdout.trim();
  });
  afterAll(() => cleanupSockets());

  const capture = (): string => tmuxRun(socket, ["capture-pane", "-p", "-t", paneId]).stdout;
  const cond = (pid: number, hex: string): string => `if-shell -F -t ${paneId} '#{==:#{pane_pid},${pid}}' 'send-keys -t ${paneId} -H ${hex}' 'display -p NO'`;

  it("raw control connection: two responses for both a matching and a non-matching condition; the next display answers the right command", async () => {
    const client = spawn(TMUX as string, ["-u", "-L", socket, "-f", CONF, "-C", "attach-session", "-t", `=${name}`], { stdio: ["pipe", "pipe", "ignore"] });
    const parser = new ControlParser();
    const blocks: ControlBlock[] = [];
    client.stdout.on("data", (c: Buffer) => {
      for (const ev of parser.push(c)) if (ev.kind === "block") blocks.push(ev.block);
    });
    try {
      expect(await waitFor(() => blocks.length >= 1)).toBe(true); // attach 自身の応答
      const base = blocks.length;
      // 条件が合う（pid が同じ）: 2 つ目は空。 外れる: 2 つ目は NO。 続けて display
      client.stdin.write(`${cond(panePid, "6f 6b")}\n`);
      expect(await waitFor(() => blocks.length >= base + 2)).toBe(true);
      client.stdin.write(`${cond(panePid + 1, "7a 7a")}\n`);
      expect(await waitFor(() => blocks.length >= base + 4)).toBe(true);
      client.stdin.write(`display -p -t ${paneId} '#{pane_pid}'\n`);
      expect(await waitFor(() => blocks.length >= base + 5)).toBe(true);
      const got = blocks.slice(base);
      expect(got.map((b) => b.ok)).toEqual([true, true, true, true, true]);
      expect(got[0].lines).toEqual([]);
      expect(got[1].lines).toEqual([]);
      expect(got[2].lines).toEqual([]);
      expect(got[3].lines).toEqual(["NO"]);
      expect(got[4].lines).toEqual([String(panePid)]);
      expect(await waitFor(() => capture().includes("ok"))).toBe(true);
      expect(capture()).not.toContain("zz");
    } finally {
      client.stdin.end();
      client.kill();
    }
  });

  it("TmuxControlTerminal.sendToPane writes when the pid matches and refuses (writes nothing) when it does not", async () => {
    const term = new TmuxControlTerminal({
      ctx: { tmux: TMUX as string, socket, conf: CONF },
      name,
      pid: panePid,
      env: { PATH: process.env.PATH ?? "" },
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      expect(await waitFor(() => term.writeState().writable)).toBe(true);
      expect(await term.sendToPane(paneId, panePid, "alpha")).toEqual({ written: true });
      expect(await waitFor(() => capture().includes("alpha"))).toBe(true);
      expect(await term.sendToPane(paneId, panePid + 1, "omega")).toEqual({ written: false, reason: "not_written" });
      expect(capture()).not.toContain("omega");
      expect(await term.queryPanePid(paneId)).toBe(panePid);
      // 区画の番号が無いときも、書かずに「書いていない」と読む
      expect(await term.sendToPane("%9999", panePid, "gone")).toEqual({ written: false, reason: "not_written" });
      expect(capture()).not.toContain("gone");
      expect(await term.queryPanePid(paneId)).toBe(panePid);
    } finally {
      term.release();
    }
  });
});
