import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseCloneDir } from "../../server/case-clone.ts";
import { CASE_PROXY_PORT, CaseSandboxUnavailableError, writeCaseRoom } from "../../server/case-sandbox.ts";
import type { RoleConfig } from "../../server/config.ts";
import { restoreOnStartup } from "../../server/restore.ts";
import { SessionConflictError, SessionInputError, SessionManager } from "../../server/sessions.ts";
import { newSession, probeSession } from "../../server/terminal-host/tmux-runner.ts";
import { git, makeCaseRepo, pointOriginAtB, type CaseRepo } from "./helpers/case-repo.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";
import { cleanupSockets, processStart, testSocket, tmuxRun } from "./helpers/tmux-env.ts";

// tmux の probe が呼ばれるかを見るため、本物を包んだ spy にする（振る舞いは変えない）。newSession は失敗を作るために同じく包む
vi.mock("../../server/terminal-host/tmux-runner.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../server/terminal-host/tmux-runner.ts")>();
  return { ...mod, probeSession: vi.fn(mod.probeSession), newSession: vi.fn(mod.newSession) };
});

// room.sb の書き込みを失敗させる・空振りさせるため、本物を包んだ spy にする（既定は本物のまま）
vi.mock("../../server/case-sandbox.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../server/case-sandbox.ts")>();
  return { ...mod, writeCaseRoom: vi.fn(mod.writeCaseRoom) };
});

// create() が決める id を試験から指定できるよう、randomUUID を包む（既定は本物のまま）
vi.mock("node:crypto", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:crypto")>();
  return { ...mod, randomUUID: vi.fn(mod.randomUUID) };
});

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const CASE_ROLE: RoleConfig = {
  id: "case",
  labelKey: "role.discordCase",
  // 端末の幅で折り返されないよう、環境は T の中のファイルに 1 行ずつ書く
  command: ["/bin/sh", "-c", 'printf "%s\\n" "$AC_CASE_SETTINGS" "$AC_CASE_GH_DIR" "$AC_CASE_REPORT" "$AC_CASE_TMP" "$AC_CASE_SHELL" "$AC_DISCORD_CASE" "$AC_CASE_ROOM" "$AC_CASE_HOME" "$AC_CLAUDE_BIN" "$AC_CASE_PROXY" > "$AC_CASE_TMP/env.txt"; echo READY; cat'],
  needsWorktree: false,
  reservable: false,
  caseSandbox: true,
};

interface Ctx {
  r: CaseRepo;
  h: Harness;
  H: string;
  D: string;
  tmpRoot: string;
  /** 偽の claude の実体（一時の置き場に作った実行できるファイル） */
  claude: string;
  socket: string | null;
  restoreEnv: () => void;
}
let ctx: Ctx | undefined;
const c = (): Ctx => ctx as Ctx;

interface SetupOptions {
  sandboxExec?: string | null;
  configMaxSessions?: number;
  /** tmux の専用ソケット。既定は専用の名前を作る。null なら tmux を使わない（terminalHost を direct にする） */
  tmux?: string | null;
  tmuxPath?: string;
  /** null なら claude の実体を作らない */
  claude?: null;
  macosOk?: boolean;
  proxyListening?: boolean;
}

async function setup(opts: SetupOptions = {}): Promise<Ctx> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-sesscase-")));
  const r = makeCaseRepo({ rootDir: dir, mName: "root" });
  const restoreEnv = pointOriginAtB(r.B, ["https://x@github.com/test/repo.git"]);
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const fakeSandbox = path.join(bin, "sandbox-exec");
  writeFileSync(fakeSandbox, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeSandbox, 0o755);
  const tmpRoot = path.join(dir, "tmproot");
  mkdirSync(tmpRoot, { recursive: true });
  // claude の実体: リンクを作り、実体の道（realpath）が AC_CLAUDE_BIN になることを確かめられるようにする
  const claude = path.join(bin, "claude-real");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
  const claudeLink = path.join(bin, "claude");
  symlinkSync(claude, claudeLink);
  const socket = opts.tmux === null ? null : (opts.tmux ?? testSocket());
  const h = await startHarness({
    dir,
    extraRoles: [CASE_ROLE],
    claudeBin: opts.claude === null ? path.join(bin, "no-such-claude") : claudeLink,
    caseRoomMacosOk: opts.macosOk ?? true,
    caseProxyListening: () => opts.proxyListening ?? true,
    ...(opts.configMaxSessions !== undefined ? { configMaxSessions: opts.configMaxSessions } : {}),
    ...(socket !== null ? { terminalHost: "tmux" as const, tmuxSocket: socket, ...(opts.tmuxPath !== undefined ? { tmuxPath: opts.tmuxPath } : {}) } : {}),
    sandboxExecPath: opts.sandboxExec === null ? path.join(bin, "missing-sandbox-exec") : fakeSandbox,
    caseShellPath: path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh"),
    caseGuardPath: path.join(process.cwd(), "ops", "case", "case-guard.mjs"),
    caseHomeDir: r.H,
    caseTmpRoot: tmpRoot,
  });
  ctx = { r, h, H: r.H, D: h.config.dataDir, tmpRoot, claude: realpathSync(claude), socket, restoreEnv };
  return ctx;
}

afterEach(async () => {
  if (ctx === undefined) return;
  const { h, r, restoreEnv } = ctx;
  ctx = undefined;
  await h.close();
  cleanupSockets();
  restoreEnv();
  r.cleanup();
});

const listOrEmpty = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);
const nothingLeft = (x: Ctx): void => {
  expect(listOrEmpty(path.join(x.H, "worktrees", "discord-cases"))).toEqual([]);
  expect(listOrEmpty(path.join(x.D, "cases"))).toEqual([]);
  expect(listOrEmpty(path.join(x.D, "case-gh"))).toEqual([]);
  expect(listOrEmpty(path.join(x.D, "case-home"))).toEqual([]);
  expect(listOrEmpty(path.join(x.tmpRoot, "acc"))).toEqual([]);
};
const post = async (x: Ctx, p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`${x.h.base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

/** 起動した命令が T に書いた環境（1 行ずつ） */
const envOf = async (T: string): Promise<string[]> => {
  const file = path.join(T, "env.txt");
  await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, "utf8").endsWith("\n")).toBe(true));
  return readFileSync(file, "utf8").split("\n").slice(0, -1);
};

describe("create() for a caseSandbox role", () => {
  beforeEach(async () => {
    await setup();
  });

  it("makes the clone, the case files, the case-home and T, opens it in W with ten variables, no worktree script and no probe", async () => {
    const x = c();
    vi.mocked(probeSession).mockClear();
    const s = await x.h.sessions.create({ name: "case-1", roleId: "case" });
    const W = caseCloneDir(x.H, s.id);
    expect(s.cwd).toBe(W);
    expect(existsSync(path.join(W, ".git"))).toBe(true);
    expect(s.branch).toBe(`release/discord-case-${s.id.slice(0, 8)}`);
    expect(existsSync(path.join(x.D, "cases", s.id, "settings.json"))).toBe(true);
    expect(existsSync(path.join(x.D, "cases", s.id, "case.json"))).toBe(true);
    expect(existsSync(path.join(x.tmpRoot, "acc", s.id.slice(0, 8)))).toBe(true);
    const vars = await envOf(path.join(x.tmpRoot, "acc", s.id.slice(0, 8)));
    expect(vars).toEqual([
      path.join(x.D, "cases", s.id, "settings.json"),
      path.join(x.D, "case-gh", s.id),
      path.join(x.tmpRoot, "CC報告ファイル", "discord-case", s.id),
      path.join(x.tmpRoot, "acc", s.id.slice(0, 8)),
      path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh"),
      `manual-${s.id}:1`,
      path.join(x.D, "cases", s.id, "room.sb"),
      path.join(x.D, "case-home", s.id),
      x.claude,
      `http://127.0.0.1:${CASE_PROXY_PORT}`,
    ]);
    // room.sb は起動の前に書かれ、case-home は 0o700 で、claude の実体は room.sb の literal と同じ文字列
    expect(statSync(path.join(x.D, "case-home", s.id)).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(x.D, "cases", s.id, "room.sb"), "utf8")).toContain(`(literal ${JSON.stringify(x.claude)})`);
    // 新しく起動したので、case-home の .claude.json は書き直されている
    const claudeJson = JSON.parse(readFileSync(path.join(x.D, "case-home", s.id, ".claude.json"), "utf8")) as { hasCompletedOnboarding: boolean; projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    expect(claudeJson.projects[W]).toEqual({ hasTrustDialogAccepted: true });
    expect(vi.mocked(probeSession)).not.toHaveBeenCalled();
    // Sales Anchor の worktree は作っていない
    expect(git(x.r.M, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("refuses a branch name (409) and leaves no clone", async () => {
    const x = c();
    await expect(x.h.sessions.create({ name: "b", roleId: "case", branch: "release/x" })).rejects.toBeInstanceOf(SessionConflictError);
    const res = await post(x, "/api/sessions", { name: "b", roleId: "case", branch: "release/x" });
    expect(res.status).toBe(409);
    nothingLeft(x);
  });

  it("leaves nothing behind when the clone cannot be made (origin url with a user)", async () => {
    const x = c();
    git(x.r.M, "remote", "set-url", "origin", "https://x@github.com/test/repo.git");
    await expect(x.h.sessions.create({ name: "f", roleId: "case" })).rejects.toThrow();
    nothingLeft(x);
    expect(x.h.sessions.occupiedCount()).toBe(0);
  });

  it("a T that already exists makes create() fail, and its contents and nothing else are left", async () => {
    const x = c();
    const known = "99999999-8888-4777-8666-555555555555";
    const T = path.join(x.tmpRoot, "acc", known.slice(0, 8));
    mkdirSync(T, { recursive: true });
    writeFileSync(path.join(T, "keep"), "x");
    vi.mocked(randomUUID).mockReturnValueOnce(known as never);
    await expect(x.h.sessions.create({ name: "t", roleId: "case" })).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(readFileSync(path.join(T, "keep"), "utf8")).toBe("x");
    expect(listOrEmpty(path.join(x.H, "worktrees", "discord-cases"))).toEqual([]);
    expect(listOrEmpty(path.join(x.D, "cases"))).toEqual([]);
    expect(listOrEmpty(path.join(x.D, "case-gh"))).toEqual([]);
    expect(x.h.sessions.occupiedCount()).toBe(0);
  });

  it("restore() fails when settings.json is missing, cwd differs, or report / tmp are missing; and opens when all is right", async () => {
    const x = c();
    const s = await x.h.sessions.create({ name: "r", roleId: "case" });
    const id = s.id;
    const W = s.cwd;
    const dir = path.join(x.D, "cases", id);
    const info = JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8")) as { report: string; tmp: string };
    await x.h.sessions.close(id);
    const reopen = (cwd = W) => x.h.sessions.restore({ role: CASE_ROLE, name: "r", cwd, branch: null, id });
    // 正しいとき: 同じ id・同じ cwd で開く（確かめの前に取り除く）
    const ok = reopen();
    expect(ok.id).toBe(id);
    expect(ok.cwd).toBe(W);
    await x.h.sessions.close(id);
    expect(() => reopen(x.r.M)).toThrow(CaseSandboxUnavailableError);
    rmSync(info.report, { recursive: true });
    expect(() => reopen()).toThrow(CaseSandboxUnavailableError);
    mkdirSync(info.report, { recursive: true });
    rmSync(info.tmp, { recursive: true });
    expect(() => reopen()).toThrow(CaseSandboxUnavailableError);
    mkdirSync(info.tmp, { recursive: true });
    rmSync(path.join(dir, "settings.json"));
    expect(() => reopen()).toThrow(CaseSandboxUnavailableError);
  });

  it("restoreOnStartup: a wrong cwd or a tampered clone is missingCwd; a right clone opens without classifyCwd", async () => {
    const x = c();
    const s = await x.h.sessions.create({ name: "start", roleId: "case" });
    const id = s.id;
    const W = s.cwd;
    await x.h.sessions.close(id);
    const deps = { config: x.h.config, sessions: x.h.sessions, hub: x.h.hub, store: x.h.store, recorder: x.h.recorder };
    const attempt = async (cwd: string) => {
      await x.h.store.save([{ id, roleId: "case", name: "start", cwd, ...(s.branch ? { branch: s.branch } : {}) }]);
      return restoreOnStartup(deps);
    };
    expect(await attempt(x.r.M)).toEqual([{ reason: "missingCwd", name: "start" }]);
    expect(x.h.sessions.get(id)).toBeUndefined();
    writeFileSync(path.join(W, ".git", "commondir"), ".\n");
    expect(await attempt(W)).toEqual([{ reason: "missingCwd", name: "start" }]);
    rmSync(path.join(W, ".git", "commondir"));
    expect(await attempt(W)).toEqual([]);
    expect(x.h.sessions.get(id)?.cwd).toBe(W);
  });

  it("resume() is refused (a case role has no resumeCommand)", async () => {
    const x = c();
    expect(() => x.h.sessions.resume({ roleId: "case", name: "n", cwd: x.r.M })).toThrow("role cannot resume sessions");
    expect(() => x.h.sessions.resume({ roleId: "case", name: "n", cwd: x.r.M })).toThrow(SessionInputError);
  });

  it("a role that is not a case role opens as before (no case check)", async () => {
    const x = c();
    const s = await x.h.sessions.create({ name: "plain", roleId: "echo" });
    expect(s.cwd).toBe(x.h.config.salesanchorRoot);
    nothingLeft(x);
  });
});

describe("create() with the sandbox unavailable", () => {
  it("throws CaseSandboxUnavailableError, opens nothing, removes every file, and answers 503 over HTTP", async () => {
    const x = await setup({ sandboxExec: null });
    await expect(x.h.sessions.create({ name: "u", roleId: "case" })).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(x.h.sessions.list()).toHaveLength(0);
    nothingLeft(x);
    const res = await post(x, "/api/sessions", { name: "u", roleId: "case" });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "sandbox unavailable" });
    nothingLeft(x);
    expect(x.h.sessions.occupiedCount()).toBe(0);
  });
});

describe("the window limit also covers case creation (v0.47.0 maxSessions)", () => {
  it("is refused with 400 when full, and leaves no clone or case files", async () => {
    const x = await setup({ configMaxSessions: 1 });
    await x.h.sessions.create({ name: "e", roleId: "echo" });
    await expect(x.h.sessions.create({ name: "c", roleId: "case" })).rejects.toThrow("too many sessions");
    const res = await post(x, "/api/sessions", { name: "c", roleId: "case" });
    expect(res.status).toBe(400);
    nothingLeft(x);
  });

  it("two creates started together: the second is refused while the first makes its clone", async () => {
    const x = await setup({ configMaxSessions: 1 });
    const results = await Promise.allSettled([x.h.sessions.create({ name: "a", roleId: "case" }), x.h.sessions.create({ name: "b", roleId: "case" })]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ message: "too many sessions" });
    expect(readdirSync(path.join(x.H, "worktrees", "discord-cases"))).toHaveLength(1);
  });
});

describe("tmux: the probe", () => {
  const SOCKET = "ac-test-sessions-case";
  afterEach(() => {
    spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
  });

  it("is skipped for a new case session, and still called for a restore of a plain role", async () => {
    const x = await setup({ tmux: SOCKET });
    vi.mocked(probeSession).mockClear();
    const s = await x.h.sessions.create({ name: "tm", roleId: "case" });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(vi.mocked(probeSession)).not.toHaveBeenCalled();
    const echo = x.h.config.roles.find((r) => r.id === "echo") as RoleConfig;
    x.h.sessions.restore({ role: echo, name: "plain", cwd: x.h.config.salesanchorRoot, branch: null, id: randomUUID() });
    expect(vi.mocked(probeSession)).toHaveBeenCalledTimes(1);
  });
});

describe("the room checks (⑧〜⑬) each stop the case with 503, and nothing is left", () => {
  /** arm は失敗を仕掛ける関数（作成と HTTP の 2 回分を仕掛けるため 2 回呼ぶ） */
  const expectUnavailable = async (x: Ctx, message?: string, arm?: () => void): Promise<void> => {
    arm?.();
    arm?.();
    const err = await x.h.sessions.create({ name: "u", roleId: "case" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CaseSandboxUnavailableError);
    if (message !== undefined) expect((err as Error).message).toContain(message);
    expect(x.h.sessions.list()).toHaveLength(0);
    expect(x.h.sessions.occupiedCount()).toBe(0);
    nothingLeft(x);
    const res = await post(x, "/api/sessions", { name: "u", roleId: "case" });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "sandbox unavailable" });
    nothingLeft(x);
  };
  const realWriteCaseRoom = async (): Promise<typeof writeCaseRoom> => (await vi.importActual<typeof import("../../server/case-sandbox.ts")>("../../server/case-sandbox.ts")).writeCaseRoom;

  it("⑧ room.sb is missing", async () => {
    const x = await setup();
    await expectUnavailable(x, "room profile is missing", () => vi.mocked(writeCaseRoom).mockImplementationOnce(() => ""));
  });

  it("room.sb cannot be written (create)", async () => {
    const x = await setup();
    await expectUnavailable(x, "room profile could not be written", () =>
      vi.mocked(writeCaseRoom).mockImplementationOnce(() => {
        throw new CaseSandboxUnavailableError("sandbox unavailable: room profile could not be written");
      }),
    );
  });

  it("room.sb cannot be written (reopen): a directory in its place, and the old room.sb is gone", async () => {
    const x = await setup();
    const s = await x.h.sessions.create({ name: "rw", roleId: "case" });
    const room = path.join(x.D, "cases", s.id, "room.sb");
    await x.h.sessions.close(s.id);
    rmSync(room);
    mkdirSync(room);
    expect(() => x.h.sessions.restore({ role: CASE_ROLE, name: "rw", cwd: s.cwd, branch: null, id: s.id })).toThrow(CaseSandboxUnavailableError);
    expect(x.h.sessions.get(s.id)).toBeUndefined();
  });

  it("⑨ the proxy is not listening", async () => {
    const x = await setup({ proxyListening: false });
    await expectUnavailable(x, "case proxy is not listening");
  });

  it("⑩ the case-home is missing (reopen)", async () => {
    const x = await setup();
    const s = await x.h.sessions.create({ name: "ch", roleId: "case" });
    await x.h.sessions.close(s.id);
    rmSync(path.join(x.D, "case-home", s.id), { recursive: true });
    expect(() => x.h.sessions.restore({ role: CASE_ROLE, name: "ch", cwd: s.cwd, branch: null, id: s.id })).toThrow("case-home is missing");
  });

  it("⑪ the macOS version is not the recorded one", async () => {
    const x = await setup({ macosOk: false });
    await expectUnavailable(x, "macOS version is not accepted");
  });

  it("⑫ the claude binary cannot be found (room.sb is not written), or differs from the literal in room.sb", async () => {
    const x = await setup({ claude: null });
    vi.mocked(writeCaseRoom).mockClear();
    await expectUnavailable(x, "claude binary not found");
    expect(vi.mocked(writeCaseRoom)).not.toHaveBeenCalled();
    await x.h.close();
    ctx = undefined;
    const y = await setup();
    const real = await realWriteCaseRoom();
    await expectUnavailable(y, "claude binary differs from the room profile", () => vi.mocked(writeCaseRoom).mockImplementationOnce((p, o) => real(p, { ...o, claudeReal: "/another/claude" })));
  });

  it("⑬ the terminal is not tmux (direct) or tmux cannot be used: never opened with node-pty", async () => {
    const direct = await setup({ tmux: null });
    await expectUnavailable(direct, "tmux is required for case sessions");
    await direct.h.close();
    ctx = undefined;
    const missing = await setup({ tmuxPath: "/nonexistent/tmux" });
    await expectUnavailable(missing, "tmux is required for case sessions");
  });

  it("a tmux session that cannot be created does not fall back to node-pty", async () => {
    const x = await setup();
    await expectUnavailable(x, "tmux session could not be created", () =>
      vi.mocked(newSession).mockImplementationOnce(() => {
        throw new Error("tmux new-session failed");
      }),
    );
    expect(x.h.sessions.terminalNotices()).toEqual([]);
  });
});

describe("the case main process and .claude.json on reattach / relaunch", () => {
  it("records the pane pid with its start time; a reattach keeps .claude.json as is, a relaunch rewrites it; closing removes the record", async () => {
    const x = await setup();
    const s = await x.h.sessions.create({ name: "pid", roleId: "case" });
    const main = x.h.sessions.caseMainProcesses().get(s.id);
    expect(main?.pid).toBeGreaterThan(0);
    expect(main?.lstart).toBe(processStart(main?.pid as number));
    const claudeJson = path.join(x.D, "case-home", s.id, ".claude.json");
    // サーバーが起き直った形: 同じ tmux に別の SessionManager をつなぐ（セッションは tmux に残る）
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { evil: { command: "x" } } }));
    x.h.sessions.killAll();
    const options = { sandboxExecPath: path.join(path.dirname(x.claude), "sandbox-exec"), caseRoomMacosOk: true, caseProxyListening: () => true, caseHomeDir: x.H, caseTmpRoot: x.tmpRoot, caseShellPath: path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh"), caseGuardPath: path.join(process.cwd(), "ops", "case", "case-guard.mjs") };
    const m2 = new SessionManager(x.h.config, options);
    expect(m2.caseMainProcesses().size).toBe(0);
    const again = m2.restore({ role: CASE_ROLE, name: "pid", cwd: s.cwd, branch: null, id: s.id });
    expect(again.reattached).toBe(true);
    expect(JSON.parse(readFileSync(claudeJson, "utf8"))).toEqual({ mcpServers: { evil: { command: "x" } } });
    expect(m2.caseMainProcesses().get(s.id)).toEqual(main);
    m2.killAll();
    // tmux のセッションが無くなった: 新しく起動する。.claude.json は残すキーだけに書き直される
    expect(tmuxRun(x.socket as string, ["kill-session", "-t", `=ac-${s.id}`]).status).toBe(0);
    const m3 = new SessionManager(x.h.config, options);
    const fresh = m3.restore({ role: CASE_ROLE, name: "pid", cwd: s.cwd, branch: null, id: s.id });
    expect(fresh.reattached).not.toBe(true);
    const rewritten = JSON.parse(readFileSync(claudeJson, "utf8")) as Record<string, unknown>;
    expect(rewritten.mcpServers).toBeUndefined();
    expect(rewritten.hasCompletedOnboarding).toBe(true);
    expect(m3.caseMainProcesses().get(s.id)?.pid).toBeGreaterThan(0);
    await m3.close(s.id);
    expect(m3.caseMainProcesses().has(s.id)).toBe(false);
  });

  it("the copy returned by caseMainProcesses() does not change the manager's record", async () => {
    const x = await setup();
    const s = await x.h.sessions.create({ name: "cp", roleId: "case" });
    (x.h.sessions.caseMainProcesses() as Map<string, unknown>).delete(s.id);
    expect(x.h.sessions.caseMainProcesses().has(s.id)).toBe(true);
  });
});
