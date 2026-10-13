import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoleConfig } from "../../server/config.ts";
import { restoreOnStartup } from "../../server/restore.ts";
import { sessionName } from "../../server/terminal-host/tmux-protocol.ts";
import { newSession, probeSession } from "../../server/terminal-host/tmux-runner.ts";
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
  { id: "kids", labelKey: "role.shell", command: ["/bin/sh", "-c", "sleep 300 & sleep 301 & wait"], needsWorktree: false },
];

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
    await sleep(300); // 保存リストの書き込み
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
    console.log(`[K6] esc median=${median.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms`);
    expect(median).toBeLessThanOrEqual(20);
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

  it("tmux missing: falls back to direct with a one-time notice", async () => {
    const h = await startHarness({ terminalHost: "tmux", tmuxSocket: testSocket(), extraRoles: ROLES, tmuxPath: "/nonexistent/tmux" });
    hosts.push(h);
    expect(h.sessions.terminalNotices()).toEqual([{ reason: "tmuxMissing" }]);
    const id = await mk(h, "cat", "direct");
    expect(await waitFor(() => textOf(h, id).includes("READY"))).toBe(true);
    await h.sessions.close(id);
  });

  it("10MB of output arrives intact (sha256); time is logged (design target 1s when run alone)", async () => {
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
    expect(await waitFor(() => chunks.join("").includes("BIGDONE"), 20000, 5)).toBe(true);
    const ms = performance.now() - t0;
    const got = chunks.join("");
    const body = got.slice(0, got.indexOf("BIGDONE") - 1);
    console.log(`[10MB] ${ms.toFixed(0)}ms, received ${total} bytes`);
    expect(createHash("sha256").update(body).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
    // 設計の目安は 1 秒（単独実行で約 1 秒弱）。全試験を並列で流すと数倍になるため、ここでは取りこぼしの検出用に 10 秒で止める。実測値はログに出す
    expect(ms).toBeLessThan(10000);
    await h.sessions.close(id);
  });

  it("12 reattaches: the synchronous part is timed (design target 1s when run alone)", async () => {
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
    console.log(`[reattach x12] probe(spawnSync) ${probeMs.toFixed(0)}ms, restore total ${ms.toFixed(0)}ms`);
    // 設計の目安は合計 1 秒（単独実行で probe 約 0.14 秒）。全試験の並列実行では数倍になるため、ここでは退行の検出用に余裕を持たせる。実測値はログに出す
    expect(probeMs).toBeLessThan(4000);
    expect(ms).toBeLessThan(6000);
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
