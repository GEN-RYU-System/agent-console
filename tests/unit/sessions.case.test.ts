import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseCloneDir } from "../../server/case-clone.ts";
import { CaseSandboxUnavailableError } from "../../server/case-sandbox.ts";
import type { RoleConfig } from "../../server/config.ts";
import { restoreOnStartup } from "../../server/restore.ts";
import { SessionConflictError, SessionInputError } from "../../server/sessions.ts";
import { probeSession } from "../../server/terminal-host/tmux-runner.ts";
import { git, makeCaseRepo, pointOriginAtB, type CaseRepo } from "./helpers/case-repo.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

// tmux の probe が呼ばれるかを見るため、本物を包んだ spy にする（振る舞いは変えない）
vi.mock("../../server/terminal-host/tmux-runner.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../server/terminal-host/tmux-runner.ts")>();
  return { ...mod, probeSession: vi.fn(mod.probeSession) };
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
  command: ["/bin/sh", "-c", "echo ENV\\|$AC_CASE_SETTINGS\\|$AC_CASE_GH_DIR\\|$AC_CASE_REPORT\\|$AC_CASE_TMP\\|$AC_CASE_SHELL\\|$AC_DISCORD_CASE\\|END; cat"],
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
  restoreEnv: () => void;
}
let ctx: Ctx | undefined;
const c = (): Ctx => ctx as Ctx;

async function setup(opts: { sandboxExec?: string | null; configMaxSessions?: number; tmux?: string } = {}): Promise<Ctx> {
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
  const h = await startHarness({
    dir,
    extraRoles: [CASE_ROLE],
    ...(opts.configMaxSessions !== undefined ? { configMaxSessions: opts.configMaxSessions } : {}),
    ...(opts.tmux !== undefined ? { terminalHost: "tmux" as const, tmuxSocket: opts.tmux } : {}),
    sandboxExecPath: opts.sandboxExec === null ? path.join(bin, "missing-sandbox-exec") : fakeSandbox,
    caseShellPath: path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh"),
    caseGuardPath: path.join(process.cwd(), "ops", "case", "case-guard.mjs"),
    caseHomeDir: r.H,
    caseTmpRoot: tmpRoot,
  });
  ctx = { r, h, H: r.H, D: h.config.dataDir, tmpRoot, restoreEnv };
  return ctx;
}

afterEach(async () => {
  if (ctx === undefined) return;
  const { h, r, restoreEnv } = ctx;
  ctx = undefined;
  await h.close();
  restoreEnv();
  r.cleanup();
});

const listOrEmpty = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);
const nothingLeft = (x: Ctx): void => {
  expect(listOrEmpty(path.join(x.H, "worktrees", "discord-cases"))).toEqual([]);
  expect(listOrEmpty(path.join(x.D, "cases"))).toEqual([]);
  expect(listOrEmpty(path.join(x.D, "case-gh"))).toEqual([]);
  expect(listOrEmpty(path.join(x.tmpRoot, "acc"))).toEqual([]);
};
const post = async (x: Ctx, p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`${x.h.base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const ENV_LINE = /^ENV\|(.*)\|END$/m;

describe("create() for a caseSandbox role", () => {
  beforeEach(async () => {
    await setup();
  });

  it("makes the clone, the case files and T, opens it in W with six variables, no worktree script and no probe", async () => {
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
    await vi.waitFor(() => expect(ENV_LINE.test(s.ring.snapshot().replace(/\r/g, ""))).toBe(true));
    const vars = (ENV_LINE.exec(s.ring.snapshot().replace(/\r/g, "")) as RegExpExecArray)[1].split("|");
    expect(vars).toEqual([
      path.join(x.D, "cases", s.id, "settings.json"),
      path.join(x.D, "case-gh", s.id),
      path.join(x.tmpRoot, "CC報告ファイル", "discord-case", s.id),
      path.join(x.tmpRoot, "acc", s.id.slice(0, 8)),
      path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh"),
      `manual-${s.id}:1`,
    ]);
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
