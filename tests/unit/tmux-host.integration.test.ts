import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { Terminal } from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoleConfig } from "../../server/config.ts";
import { restoreHeldFiles } from "../../server/held-merge.ts";
import { restoreOnStartup } from "../../server/restore.ts";
import { sessionName } from "../../server/terminal-host/tmux-protocol.ts";
import { newSession, probeSession, tmuxVersion, tmuxVersionAtLeast } from "../../server/terminal-host/tmux-runner.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";
import { cleanupSockets, CONF, processStart, REQUIRE_TMUX, sleep, testSocket, TMUX, tmuxRun, waitFor } from "./helpers/tmux-env.ts";

vi.setConfig({ testTimeout: 40000 });

const ROLES: RoleConfig[] = [
  { id: "cat", labelKey: "role.shell", command: ["/bin/sh", "-c", "echo READY; cat"], needsWorktree: false },
  { id: "raw", labelKey: "role.shell", command: ["/bin/sh", "-c", "stty raw -echo; echo RAWREADY; cat"], needsWorktree: false },
  { id: "scroll", labelKey: "role.shell", command: ["/bin/sh", "-c", "i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo ROW$i; done; cat"], needsWorktree: false },
  { id: "utf8", labelKey: "role.shell", command: ["/bin/sh", "-c", "i=0; while [ $i -lt 400 ]; do i=$((i+1)); printf '日本語😀テスト%s\\n' $i; done; cat"], needsWorktree: false },
  { id: "count", labelKey: "role.shell", command: ["/bin/sh", "-c", "i=0; while :; do i=$((i+1)); echo L$i; sleep 0.004; done"], needsWorktree: false },
  { id: "env", labelKey: "role.shell", command: ["/bin/sh", "-c", "printf 'LANG_IS=[%s] TOKEN_IS=[%s]\\n' \"$LANG\" \"$AGENT_CONSOLE_TOKEN\"; cat"], needsWorktree: false },
  { id: "big", labelKey: "role.shell", command: ["/bin/sh", "-c", "stty raw -echo; read x; yes ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 | head -c 10485760; echo; echo BIGDONE; cat"], needsWorktree: false },
  {
    id: "paint",
    labelKey: "role.shell",
    command: [
      "/bin/sh",
      "-c",
      "printf '\\033[?2004h\\033[?1h'; printf '\\033[31mRED\\033[0m \\033[1;44mBOLDBLUE\\033[0m \\033[38;5;208mORANGE\\033[0m \\033[48;2;10;20;30mTRUE\\033[0m \\033[7mREV\\033[0m\\n'; printf 'plain line\\n'; cat",
    ],
    needsWorktree: false,
  },
  { id: "kids", labelKey: "role.shell", command: ["/bin/sh", "-c", "sleep 300 & sleep 301 & wait"], needsWorktree: false },
];

/** AC_TMUX_TIMING=1 の時だけ、設計 §7 の所要時間の閾値を判定する（単独実行用）。全試験の並列実行では数倍に揺れるので、値はログに出すだけ（参考値） */
const TIMING = process.env.AC_TMUX_TIMING === "1";
const ESC_MEDIAN_MAX_MS = 20;
const BIG_OUTPUT_MAX_MS = 1000;
const REATTACH_X12_MAX_MS = 1000;

const tmuxAvailable = TMUX !== null;
const suite = tmuxAvailable || REQUIRE_TMUX ? describe : describe.skip;
if (!tmuxAvailable && !REQUIRE_TMUX) console.warn("[tmux-host.integration] tmux not found: tests skipped (set CI=true to make this a failure)");

const hosts: Harness[] = [];
async function start(socket: string, opts: { dir?: string; terminalHost?: "tmux" | "direct" } = {}): Promise<Harness> {
  const h = await startHarness({ terminalHost: opts.terminalHost ?? "tmux", tmuxSocket: socket, recorder: true, extraRoles: ROLES, closeGraceMs: 3000, ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  hosts.push(h);
  return h;
}
/** サーバーの停止を再現する: 停止の印 → 全 control client を閉じる（tmux 本体は残る） */
async function stopServer(h: Harness): Promise<void> {
  h.sessions.beginShutdown();
  await h.close();
}
const textOf = (h: Harness, id: string): string => (h.sessions.get(id) as NonNullable<ReturnType<Harness["sessions"]["get"]>>).ring.snapshot();
const mk = async (h: Harness, roleId: string, name: string): Promise<string> => (await h.sessions.create({ name, roleId })).id;
const paneOf = (socket: string, id: string): string => tmuxRun(socket, ["display", "-p", "-t", `=${sessionName(id)}:`, "#{pane_pid}"]).stdout.trim();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

suite("tmux host (real tmux, dedicated socket)", () => {
  beforeAll(() => {
    if (!tmuxAvailable) throw new Error("tmux is required in CI but was not found");
    process.env.AGENT_CONSOLE_TOKEN = "SECRET-TOKEN-SHOULD-NOT-LEAK";
  });
  afterAll(async () => {
    delete process.env.AGENT_CONSOLE_TOKEN;
    for (const h of hosts) await h.close().catch(() => undefined);
    cleanupSockets();
  });

  it("K1/K2/K9/K13: server restart keeps pid and start time; restore reattaches without resume", async () => {
    const socket = testSocket();
    const h1 = await start(socket);
    const ids = [await mk(h1, "cat", "one"), await mk(h1, "cat", "two"), await mk(h1, "cat", "three")];
    const before = ids.map((id) => ({ id, pid: h1.sessions.get(id)!.term.pid, start: processStart(h1.sessions.get(id)!.term.pid) }));
    for (const b of before) expect(String(b.pid)).toBe(paneOf(socket, b.id)); // K9
    await waitFor(() => ids.every((id) => textOf(h1, id).includes("READY")));
    const dir = h1.dir;
    await h1.recorder.sync(); // 保存リストの書き込み
    await stopServer(h1);
    for (const b of before) expect(alive(b.pid)).toBe(true);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h2 = await start(socket, { dir });
    await restoreOnStartup({ config: h2.config, sessions: h2.sessions, hub: h2.hub, store: h2.store, recorder: h2.recorder });
    const logged = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(logged).toContain("open-sessions: つなぎ直し 3・resume 0"); // K2
    for (const b of before) {
      const s = h2.sessions.get(b.id)!;
      expect(s.reattached).toBe(true);
      expect(s.term.pid).toBe(b.pid);
      expect(processStart(b.pid)).toBe(b.start); // K1
    }
    // 先入れ: 画面の内容が戻り、入力も通る
    await waitFor(() => ids.every((id) => textOf(h2, id).includes("READY")));
    h2.sessions.write(h2.sessions.get(ids[0])!, "ping\r");
    expect(await waitFor(() => textOf(h2, ids[0]).includes("ping"))).toBe(true);
    for (const id of ids) await h2.sessions.close(id);
  });

  it("K13: a session opened the way a routine opens it survives a restart and is counted as reattached", async () => {
    const socket = testSocket();
    const h1 = await start(socket);
    const role = h1.config.roles.find((r) => r.id === "cat") as RoleConfig;
    // routine は restore({ role, name, cwd, branch }) で開く（server/routines.ts の open）
    const routine = h1.sessions.restore({ role, name: "routine-0900", cwd: h1.config.salesanchorRoot, branch: null });
    const ordinary = await mk(h1, "cat", "ordinary");
    const before = [routine.id, ordinary].map((id) => ({ id, pid: h1.sessions.get(id)!.term.pid, start: processStart(h1.sessions.get(id)!.term.pid) }));
    await waitFor(() => before.every((b) => textOf(h1, b.id).includes("READY")));
    await h1.recorder.sync();
    const dir = h1.dir;
    await stopServer(h1);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h2 = await start(socket, { dir });
    await restoreOnStartup({ config: h2.config, sessions: h2.sessions, hub: h2.hub, store: h2.store, recorder: h2.recorder });
    const logged = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(logged).toContain("open-sessions: つなぎ直し 2・resume 0");
    for (const b of before) {
      const s = h2.sessions.get(b.id)!;
      expect(s.reattached).toBe(true);
      expect(s.term.pid).toBe(b.pid);
      expect(processStart(b.pid)).toBe(b.start);
    }
    for (const b of before) await h2.sessions.close(b.id);
  });

  it("K14: after a rollback round trip (lists held, then merged back) has-session finds the pane alive and new-session is never called", async () => {
    const socket = testSocket();
    const bin = mkdtempSync(path.join(os.tmpdir(), "ac-tmux-logger-"));
    const logFile = path.join(bin, "calls.log");
    const wrapper = path.join(bin, "tmux");
    writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${logFile}"\nexec "${TMUX as string}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const startLogged = async (dir?: string): Promise<Harness> => {
      const h = await startHarness({ terminalHost: "tmux", tmuxSocket: socket, tmuxPath: wrapper, recorder: true, extraRoles: ROLES, closeGraceMs: 3000, ...(dir !== undefined ? { dir } : {}) });
      hosts.push(h);
      return h;
    };
    try {
      const h1 = await startLogged();
      const ids = [await mk(h1, "cat", "k14-a"), await mk(h1, "cat", "k14-b")];
      const before = ids.map((id) => ({ id, pid: h1.sessions.get(id)!.term.pid, start: processStart(h1.sessions.get(id)!.term.pid) }));
      await waitFor(() => ids.every((id) => textOf(h1, id).includes("READY")));
      await h1.recorder.sync();
      const dir = h1.dir;
      const dataDir = h1.config.dataDir;
      await stopServer(h1);
      // 切戻し: 保存リストを退避（scripts/lib/ac-common.sh の ac_hold_file と同じ名前の移動）→ 前の版が動く間 tmux の本体はそのまま
      renameSync(path.join(dataDir, "open-sessions.json"), path.join(dataDir, "open-sessions.tmux-held.json"));
      for (const b of before) expect(alive(b.pid)).toBe(true);
      // 再び tmux を知っている版を起動: 退避を戻してから復元
      expect(existsSync(path.join(dataDir, "open-sessions.tmux-held.json"))).toBe(true);
      const mark = readFileSync(logFile, "utf8").split("\n").length;
      const h2 = await startLogged(dir);
      await restoreHeldFiles(h2.config.dataDir, { log: () => undefined, error: () => undefined });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await restoreOnStartup({ config: h2.config, sessions: h2.sessions, hub: h2.hub, store: h2.store, recorder: h2.recorder });
      const logged = logSpy.mock.calls.map((c) => String(c[0]));
      logSpy.mockRestore();
      const calls = readFileSync(logFile, "utf8").split("\n").slice(mark - 1).filter(Boolean);
      expect(calls.some((c) => c.includes("new-session"))).toBe(false);
      expect(calls.some((c) => c.includes("display") && c.includes("#{pane_pid}"))).toBe(true);
      expect(logged).toContain("open-sessions: つなぎ直し 2・resume 0");
      for (const b of before) {
        expect(h2.sessions.get(b.id)!.term.pid).toBe(b.pid);
        expect(processStart(b.pid)).toBe(b.start);
        expect(tmuxRun(socket, ["has-session", "-t", `=${sessionName(b.id)}`]).status).toBe(0);
      }
      for (const b of before) await h2.sessions.close(b.id);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("K4: closing kills the pane and its descendants (with and without a client)", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const a = await mk(h, "kids", "with-client");
    const b = await mk(h, "kids", "no-client");
    await sleep(500);
    const pids = [a, b].map((id) => h.sessions.get(id)!.term.pid);
    h.sessions.get(b)!.term.release(); // client を外した状態
    await sleep(300);
    await h.sessions.close(a);
    await h.sessions.close(b);
    for (const id of [a, b]) expect(tmuxRun(socket, ["has-session", "-t", `=${sessionName(id)}`]).status).not.toBe(0);
    expect(await waitFor(() => pids.every((p) => !alive(p)))).toBe(true);
  });

  it("K5: =name matches exactly (ac-a vs ac-ab)", () => {
    const socket = testSocket();
    const ctx = { tmux: TMUX as string, socket, conf: CONF };
    const env = { PATH: process.env.PATH ?? "" };
    newSession(ctx, { name: "ac-a", cols: 80, rows: 24, cwd: "/tmp", command: ["/bin/cat"], env: {} }, env);
    newSession(ctx, { name: "ac-ab", cols: 80, rows: 24, cwd: "/tmp", command: ["/bin/cat"], env: {} }, env);
    expect(tmuxRun(socket, ["has-session", "-t", "=ac-a"]).status).toBe(0);
    expect(tmuxRun(socket, ["kill-session", "-t", "=ac-a"]).status).toBe(0);
    expect(tmuxRun(socket, ["has-session", "-t", "=ac-a"]).status).not.toBe(0);
    expect(tmuxRun(socket, ["has-session", "-t", "=ac-ab"]).status).toBe(0);
    tmuxRun(socket, ["kill-server"]);
  });

  it("K6: bytes match exactly (Japanese, emoji, control bytes, 64KB paste); Esc latency is small", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const id = await mk(h, "raw", "raw");
    expect(await waitFor(() => textOf(h, id).includes("RAWREADY"))).toBe(true);
    const s = h.sessions.get(id)!;
    const live: string[] = [];
    s.term.onData((d) => live.push(d));
    const payload = "あいう😀abc\x03\x1b[A\t漢字\x7f";
    h.sessions.write(s, payload);
    expect(await waitFor(() => live.join("").includes(payload))).toBe(true);
    live.length = 0;
    const big = `${"x".repeat(65536)}END`;
    h.sessions.write(s, big);
    expect(await waitFor(() => live.join("").endsWith("END"), 15000)).toBe(true);
    expect(live.join("")).toBe(big);
    // Esc の往復（中央値）
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      live.length = 0;
      const t0 = performance.now();
      h.sessions.write(s, "\x1b");
      await waitFor(() => live.join("").includes("\x1b"), 2000, 1);
      times.push(performance.now() - t0);
      await sleep(30);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)];
    console.log(`[K6] esc median=${median.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms (timing check ${TIMING ? "on" : "off"})`);
    if (TIMING) expect(median).toBeLessThanOrEqual(ESC_MEDIAN_MAX_MS);
    await h.sessions.close(id);
  });

  it("K7: 300 lines stay in scrollback and survive a restart; pane is not in a mode", async () => {
    const socket = testSocket();
    const h1 = await start(socket);
    const id = await mk(h1, "scroll", "scroll");
    expect(await waitFor(() => textOf(h1, id).includes("ROW300"))).toBe(true);
    const cap = tmuxRun(socket, ["capture-pane", "-p", "-S", "-", "-t", `=${sessionName(id)}:`]).stdout;
    for (let i = 1; i <= 300; i++) expect(cap).toContain(`ROW${i}\n`);
    expect(tmuxRun(socket, ["display", "-p", "-t", `=${sessionName(id)}:`, "#{pane_in_mode}"]).stdout.trim()).toBe("0");
    await sleep(300);
    const dir = h1.dir;
    await stopServer(h1);
    const h2 = await start(socket, { dir });
    await restoreOnStartup({ config: h2.config, sessions: h2.sessions, hub: h2.hub, store: h2.store, recorder: h2.recorder });
    expect(await waitFor(() => textOf(h2, id).includes("ROW300"))).toBe(true);
    const text = textOf(h2, id);
    for (let i = 1; i <= 300; i++) expect(text).toContain(`ROW${i}\r\n`);
    await h2.sessions.close(id);
  });

  it("K8: five quick resizes end at the last size", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const id = await mk(h, "cat", "resize");
    await sleep(500);
    const s = h.sessions.get(id)!;
    for (const [c, r] of [[90, 25], [100, 26], [110, 27], [120, 28], [133, 31]]) {
      h.sessions.resize(s, c, r);
      await sleep(40);
    }
    await sleep(1000);
    expect(tmuxRun(socket, ["display", "-p", "-t", `=${sessionName(id)}:`, "#{pane_width}x#{pane_height}"]).stdout.trim()).toBe("133x31");
    await h.sessions.close(id);
  });

  it("K10/K11: no U+FFFD for multibyte output; pane env has LANG; server env has no blocked key", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const u = await mk(h, "utf8", "utf8");
    const e = await mk(h, "env", "env");
    expect(await waitFor(() => textOf(h, u).includes("テスト400"))).toBe(true);
    expect(textOf(h, u)).not.toContain("�");
    expect(textOf(h, u)).toContain("日本語😀テスト1\r\n");
    expect(await waitFor(() => textOf(h, e).includes("LANG_IS="))).toBe(true);
    expect(textOf(h, e)).toContain("LANG_IS=[ja_JP.UTF-8] TOKEN_IS=[]");
    expect(tmuxRun(socket, ["show-environment", "-t", `=${sessionName(e)}`, "LANG"]).stdout.trim()).toBe("LANG=ja_JP.UTF-8");
    const globalEnv = tmuxRun(socket, ["show-environment", "-g"]).stdout;
    expect(globalEnv).not.toContain("AGENT_CONSOLE_TOKEN");
    await h.sessions.close(u);
    await h.sessions.close(e);
  });

  it("K12: killing only the client reattaches within 1s; killing the pane marks exited", async () => {
    const socket = testSocket();
    const h = await start(socket, {});
    const id = await mk(h, "cat", "k12");
    const s = h.sessions.get(id)!;
    const pid = s.term.pid;
    await sleep(500);
    const pgrep = (): number[] =>
      spawnSync("pgrep", ["-f", "--", `-L ${socket} .*-C attach-session .*=${sessionName(id)}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
    const clients = pgrep();
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) process.kill(c, "SIGKILL");
    await sleep(100);
    const t0 = Date.now();
    expect(await waitFor(() => pgrep().length > 0, 3000, 10)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(s.exited).toBe(false);
    expect(s.term.pid).toBe(pid);
    await sleep(500);
    h.sessions.write(s, "after\r");
    expect(await waitFor(() => textOf(h, id).includes("after"))).toBe(true);
    tmuxRun(socket, ["kill-session", "-t", `=${sessionName(id)}`]);
    expect(await waitFor(() => s.exited, 5000)).toBe(true);
  });

  it("K17: reattaching during continuous numbered output leaves no gap or duplicate", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const id = await mk(h, "count", "count");
    const s = h.sessions.get(id)!;
    await sleep(800);
    for (let round = 0; round < 4; round++) {
      const clients = spawnSync("pgrep", ["-f", "--", `-L ${socket} .*-C attach-session .*=${sessionName(id)}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
      for (const c of clients) process.kill(c, "SIGKILL");
      await sleep(1500);
      const text = textOf(h, id);
      const nums = [...text.matchAll(/L(\d+)\r?\n/g)].map((m) => Number(m[1]));
      expect(nums.length).toBeGreaterThan(20);
      for (let i = 1; i < nums.length; i++) expect(nums[i], `round ${round} index ${i}`).toBe(nums[i - 1] + 1);
    }
    await h.sessions.close(id);
  });

  it("K17 (screen): after reattaching, the xterm.js screen (chars, colors, attributes), cursor and modes equal tmux's own capture-pane -p -e and pane_private_modes", async () => {
    const socket = testSocket();
    const h1 = await start(socket);
    const id = await mk(h1, "paint", "paint");
    expect(await waitFor(() => textOf(h1, id).includes("plain line"))).toBe(true);
    await h1.recorder.sync();
    const dir = h1.dir;
    await stopServer(h1);
    const h2 = await start(socket, { dir });
    await restoreOnStartup({ config: h2.config, sessions: h2.sessions, hub: h2.hub, store: h2.store, recorder: h2.recorder });
    expect(await waitFor(() => textOf(h2, id).includes("plain line"))).toBe(true);
    await sleep(300);
    const target = `=${sessionName(id)}:`;
    const COLS = 120;
    const ROWS = 30;
    const feed = async (data: string): Promise<Terminal> => {
      const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
      await new Promise<void>((resolve) => t.write(data, resolve));
      return t;
    };
    const ours = await feed(textOf(h2, id));
    const cap = tmuxRun(socket, ["capture-pane", "-p", "-e", "-t", target]).stdout;
    const theirs = await feed(`\x1b[H\x1b[2J${cap.replace(/\n/g, "\r\n")}`);
    const cellOf = (t: Terminal, y: number, x: number): string => {
      const c = t.buffer.active.getLine(y)?.getCell(x);
      if (!c) return "none";
      return [c.getChars() || " ", c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isInverse()].join("|");
    };
    // 内容のある 2 行を、文字・前景・背景・太字・反転まで 1 セルずつ比べる
    for (let y = 0; y < 2; y++) for (let x = 0; x < 60; x++) expect(cellOf(ours, y, x), `cell ${y},${x}`).toBe(cellOf(theirs, y, x));
    expect(ours.buffer.active.getLine(0)?.translateToString(true)).toContain("RED BOLDBLUE ORANGE TRUE REV");
    // 色が実際に付いている（比べる相手が全部空でないこと）
    expect(cellOf(ours, 0, 0)).not.toBe(cellOf(ours, 0, 4));
    // カーソル位置とモード（モードは pane_private_modes が要る tmux 3.8 以上だけ比べる）
    const version = tmuxVersion(TMUX as string);
    const hasModes = tmuxVersionAtLeast(version, 3, 8) !== false;
    console.warn(`[K17 screen] ${version ?? "tmux version unknown"}: mode comparison ${hasModes ? "on" : "skipped (tmux < 3.8 has no pane_private_modes)"}`);
    if (!hasModes && process.env.CI === "true" && process.platform === "linux") {
      expect.fail(`CI(ubuntu) の tmux は 3.8 以上であること（${version}）。モード比較が黙って消えないよう失敗にする`);
    }
    const info = tmuxRun(socket, ["display", "-p", "-t", target, "#{cursor_x} #{cursor_y} #{pane_private_modes}"]).stdout.trim();
    const m = /^(\d+) (\d+)(?: \[?([^\]]*)\]?)?$/.exec(info);
    expect(m, info).not.toBeNull();
    expect(ours.buffer.active.cursorX).toBe(Number(m![1]));
    expect(ours.buffer.active.cursorY).toBe(Number(m![2]));
    if (hasModes) {
      const modes = (m![3] ?? "").split(",").map((v) => Number(v.replace(/^\?/, "")));
      expect(modes).toContain(2004);
      expect(ours.modes.bracketedPasteMode).toBe(modes.includes(2004));
      expect(ours.modes.applicationCursorKeysMode).toBe(modes.includes(1));
      expect(ours.modes.bracketedPasteMode).toBe(true);
      expect(ours.modes.applicationCursorKeysMode).toBe(true);
    }
    await h2.sessions.close(id);
  });

  it("tmux missing: falls back to direct with a one-time notice", async () => {
    const h = await startHarness({ terminalHost: "tmux", tmuxSocket: testSocket(), extraRoles: ROLES, tmuxPath: "/nonexistent/tmux" });
    hosts.push(h);
    expect(h.sessions.terminalNotices()).toEqual([{ reason: "tmuxMissing" }]);
    const id = await mk(h, "cat", "direct");
    expect(await waitFor(() => textOf(h, id).includes("READY"))).toBe(true);
    await h.sessions.close(id);
  });

  it("10MB of output arrives intact (sha256); time is judged only with AC_TMUX_TIMING=1 (design target 1s when run alone)", async () => {
    const socket = testSocket();
    const h = await start(socket);
    const id = await mk(h, "big", "big");
    await sleep(300);
    const s = h.sessions.get(id)!;
    const chunks: string[] = [];
    let total = 0;
    s.term.onData((d) => {
      chunks.push(d);
      total += Buffer.byteLength(d);
    });
    const line = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\n";
    const N = 10485760;
    const expected = line.repeat(Math.ceil(N / line.length)).slice(0, N);
    const t0 = performance.now();
    h.sessions.write(s, "\n");
    expect(await waitFor(() => chunks.join("").includes("BIGDONE"), 60000, 5)).toBe(true);
    const ms = performance.now() - t0;
    const got = chunks.join("");
    const body = got.slice(0, got.indexOf("BIGDONE") - 1);
    console.log(`[10MB] ${ms.toFixed(0)}ms, received ${total} bytes (timing check ${TIMING ? "on" : "off"})`);
    expect(createHash("sha256").update(body).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
    if (TIMING) expect(ms).toBeLessThanOrEqual(BIG_OUTPUT_MAX_MS);
    await h.sessions.close(id);
  }, 90000);

  it("12 reattaches: the time is judged only with AC_TMUX_TIMING=1 (design target 1s when run alone)", async () => {
    const socket = testSocket();
    const h1 = await start(socket);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await mk(h1, "cat", `n${i}`));
    await sleep(500);
    const dir = h1.dir;
    await stopServer(h1);
    const h2 = await start(socket, { dir });
    const role = h2.config.roles.find((r) => r.id === "cat")!;
    // 同期の問い合わせ（display -p）12 本だけの時間と、restore 12 件全体（control client の起動を含む）の時間
    const env = { PATH: process.env.PATH ?? "", LANG: "ja_JP.UTF-8" };
    const p0 = performance.now();
    for (const id of ids) probeSession({ tmux: TMUX as string, socket, conf: CONF }, sessionName(id), env);
    const probeMs = performance.now() - p0;
    const t0 = performance.now();
    for (const id of ids) h2.sessions.restore({ role, name: id, cwd: h2.config.salesanchorRoot, branch: null, id });
    const ms = performance.now() - t0;
    console.log(`[reattach x12] probe(spawnSync) ${probeMs.toFixed(0)}ms, restore total ${ms.toFixed(0)}ms (timing check ${TIMING ? "on" : "off"})`);
    if (TIMING) {
      expect(probeMs).toBeLessThanOrEqual(REATTACH_X12_MAX_MS);
      expect(ms).toBeLessThanOrEqual(REATTACH_X12_MAX_MS);
    }
    for (const id of ids) await h2.sessions.close(id);
  });
});

describe("tmux host: node SIGKILL leaves the pane alive (§7)", () => {
  afterAll(() => cleanupSockets());
  (tmuxAvailable || REQUIRE_TMUX ? it : it.skip)("pane survives SIGKILL of the server process", async () => {
    const socket = testSocket();
    const script = path.join(process.cwd(), "tests", "unit", "helpers", "tmux-server-role.mts");
    const child = spawn(process.execPath, ["--import", "tsx", script, socket], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    expect(await waitFor(() => /PID=\d+/.test(out), 15000)).toBe(true);
    const pid = Number(/PID=(\d+)/.exec(out)![1]);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    await sleep(500);
    expect(alive(pid)).toBe(true);
    expect(tmuxRun(socket, ["list-sessions"]).status).toBe(0);
    tmuxRun(socket, ["kill-server"]);
  });
});
