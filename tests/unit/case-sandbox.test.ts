import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addHandlers } from "../../server/activity-hooks.ts";
import { hookPathIn } from "../../server/activity-setup.ts";
import { createCaseClone } from "../../server/case-clone.ts";
import {
  buildCaseSettings,
  CASE_ALLOW_READ,
  CASE_ALLOW_WRITE,
  CASE_ALLOWED_DOMAINS,
  CASE_DENY_READ,
  CASE_DENY_READ_SANDBOX,
  CASE_DENY_WRITE,
  CaseSandboxUnavailableError,
  casePaths,
  removeCaseFiles,
  writeCaseFiles,
  type CaseParams,
} from "../../server/case-sandbox.ts";
import { makeCaseRepo, pointOriginAtB, pushToB, type CaseRepo } from "./helpers/case-repo.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "22222222-3333-4444-8555-666666666666";
const uid = process.getuid?.() ?? 0;

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-casesb-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function params(over: Partial<CaseParams> = {}, id = ID): CaseParams {
  const H = path.join(tmp, "home");
  const D = path.join(tmp, "data");
  mkdirSync(H, { recursive: true });
  mkdirSync(D, { recursive: true });
  const c = casePaths({ id, H, D, tmpRoot: path.join(tmp, "tmp") });
  mkdirSync(path.join(tmp, "tmp"), { recursive: true });
  return {
    M: path.join(tmp, "main"),
    W: c.W,
    T: c.T,
    D: c.D,
    H: c.H,
    R: c.R,
    GH: c.GH,
    guardScript: "/repo/ops/case/case-guard.mjs",
    nodeBin: process.execPath,
    caseFile: path.join(c.D, "cases", id, "case.json"),
    hookPath: hookPathIn(c.D),
    ...over,
  };
}
type Settings = {
  permissions: { defaultMode: string; disableBypassPermissionsMode: string; allow: string[]; deny: string[]; blockReadsOutsideWorkingDirectories?: unknown; additionalDirectories?: unknown };
  disableAutoMode: string;
  includeGitInstructions: boolean;
  sandbox: { filesystem: Record<string, string[]>; network: { allowedDomains: string[] } };
  hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }> } & Record<string, unknown>;
};
const settingsOf = (p: CaseParams): Settings => buildCaseSettings(p) as unknown as Settings;
const abs = (p: string): string => p.replace(/^\/+/, "");
const rules = (list: string[], tool: string): string[] => list.filter((r) => r.startsWith(`${tool}(//`) && r.endsWith("/**)")).map((r) => "/" + r.slice(`${tool}(//`.length, -"/**)".length));
const bare = (list: string[], tool: string): string[] => list.filter((r) => r.startsWith(`${tool}(//`) && !r.endsWith("/**)")).map((r) => "/" + r.slice(`${tool}(//`.length, -1));

describe("buildCaseSettings", () => {
  it("builds the permission denies and the sandbox lists from the same arrays (one source)", () => {
    const p = params();
    const s = settingsOf(p);
    expect(rules(s.permissions.deny, "Edit")).toEqual(CASE_DENY_WRITE(p));
    expect(bare(s.permissions.deny, "Edit")).toEqual(CASE_DENY_WRITE(p));
    expect(rules(s.permissions.deny, "Read")).toEqual(CASE_DENY_READ(p));
    expect(bare(s.permissions.deny, "Read")).toEqual(CASE_DENY_READ(p));
    expect(s.sandbox.filesystem.denyWrite).toEqual(CASE_DENY_WRITE(p));
    expect(s.sandbox.filesystem.denyRead).toEqual(CASE_DENY_READ_SANDBOX(p));
    expect(s.sandbox.filesystem.allowWrite).toEqual(CASE_ALLOW_WRITE(p));
    expect(s.sandbox.filesystem.allowRead).toEqual(CASE_ALLOW_READ(p));
  });

  it("sets the permission mode, disables bypass/auto mode and git instructions, and names T for Read", () => {
    const p = params();
    const s = settingsOf(p);
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(s.disableAutoMode).toBe("disable");
    expect(s.includeGitInstructions).toBe(false);
    expect(s.permissions.allow).toContain(`Read(//${abs(p.T)}/**)`);
    for (const bareTool of ["Edit", "Write", "Read", "WebFetch", "WebSearch"]) expect(s.permissions.allow).not.toContain(bareTool);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
    expect(s.permissions.additionalDirectories).toBeUndefined();
  });

  it("denies writes to the protected paths", () => {
    const p = params();
    const dw = CASE_DENY_WRITE(p);
    for (const x of [
      `${p.W}/.git/hooks`, `${p.W}/.git/config`, `${p.W}/.git/commondir`, `${p.W}/.git/objects/info/alternates`, `${p.W}/.claude`, `${p.W}/.mcp.json`,
      `${p.R}/.claude`, `${p.D}/hooks`, `/private/tmp/claude-${uid}`, p.M,
    ]) expect(dw).toContain(x);
  });

  it("opens the sandbox reads from the home: deny list, allow list, the git config files and the node home", () => {
    const p = params();
    const dr = CASE_DENY_READ_SANDBOX(p);
    const ar = CASE_ALLOW_READ(p);
    const P = path.dirname(p.T);
    expect(dr).toEqual(expect.arrayContaining([p.H, p.M, P, ...CASE_DENY_READ(p)]));
    for (const d of CASE_DENY_READ(p)) {
      for (const a of ar) expect(d === a || d.startsWith(a + "/"), `${a} must not cover ${d}`).toBe(false);
    }
    expect(ar).toContain(p.T);
    expect(ar).not.toContain(P);
    expect(CASE_ALLOW_WRITE(p)).not.toContain(P);
    expect(CASE_DENY_WRITE(p)).not.toContain(P);
    expect(ar).not.toContain(path.join(p.H, ".config", "git"));
    for (const f of ["config", "ignore", "attributes"]) expect(ar).toContain(path.join(p.H, ".config", "git", f));
    expect(ar).toContain(path.join(p.H, ".gitconfig"));
    expect(CASE_DENY_READ(p)).toEqual(expect.arrayContaining([path.join(p.H, ".config", "git", "credentials"), path.join(p.H, ".git-credentials")]));
    // node が H の外なら nodeHome は入らない
    expect(ar).toHaveLength(8);
  });

  it("adds the node home only when it is under H, and refuses H itself or a direct child of H", () => {
    const p = params();
    const nested = path.join(p.H, ".nvm", "v22", "bin", "node");
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "");
    expect(CASE_ALLOW_READ({ ...p, nodeBin: nested })).toContain(path.join(p.H, ".nvm", "v22"));
    const direct = path.join(p.H, "node-v22", "bin", "node");
    mkdirSync(path.dirname(direct), { recursive: true });
    writeFileSync(direct, "");
    expect(() => CASE_ALLOW_READ({ ...p, nodeBin: direct })).toThrow(CaseSandboxUnavailableError);
    const home = path.join(p.H, "bin", "node");
    mkdirSync(path.dirname(home), { recursive: true });
    writeFileSync(home, "");
    expect(() => CASE_ALLOW_READ({ ...p, nodeBin: home })).toThrow(CaseSandboxUnavailableError);
  });

  it("puts the case guard first in PreToolUse and keeps every other group of addHandlers as is", () => {
    const p = params();
    const s = settingsOf(p);
    const first = s.hooks.PreToolUse[0];
    expect(first.matcher).toBe("*");
    expect(first.hooks[0]).toMatchObject({ type: "command", command: p.nodeBin, onFailure: "block" });
    expect((first.hooks[0].args as string[])[1]).toBe(p.caseFile);
    const base = addHandlers({}, p.nodeBin, p.hookPath).settings as { hooks: Record<string, unknown[]> };
    expect(s.hooks.PreToolUse.slice(1)).toEqual(base.hooks.PreToolUse);
    for (const [event, groups] of Object.entries(base.hooks)) if (event !== "PreToolUse") expect(s.hooks[event]).toEqual(groups);
  });

  it("allows writes to W, R and T only, and five domains", () => {
    const p = params();
    const s = settingsOf(p);
    expect(s.sandbox.filesystem.allowWrite).toEqual([p.W, p.R, p.T]);
    expect(s.sandbox.network.allowedDomains).toEqual([...CASE_ALLOWED_DOMAINS]);
    expect(s.sandbox.network.allowedDomains).toHaveLength(5);
  });
});

describe("writeCaseFiles / removeCaseFiles", () => {
  const modeOf = (f: string): number => statSync(f).mode & 0o777;
  const forWrite = (p: CaseParams): Omit<CaseParams, "caseFile"> => {
    const { caseFile: _c, ...rest } = p;
    void _c;
    return rest;
  };

  it("writes settings, case.json, the gh config without a token, R and T (directly under P)", async () => {
    const p = params();
    const out = await writeCaseFiles(forWrite(p), ID);
    for (const f of [out.settingsPath, out.caseFile, path.join(p.GH, "config.yml"), path.join(p.GH, "hosts.yml")]) expect(modeOf(f), f).toBe(0o600);
    const hosts = readFileSync(path.join(p.GH, "hosts.yml"), "utf8");
    expect(hosts).toContain("shingo-cc");
    expect(hosts).not.toContain("oauth_token");
    expect(readFileSync(path.join(p.GH, "config.yml"), "utf8")).toBe('version: "1"\n');
    const info = JSON.parse(readFileSync(out.caseFile, "utf8"));
    expect(info).toMatchObject({ worktree: p.W, report: p.R, tmp: p.T });
    expect(info.denyWrite).toEqual(CASE_DENY_WRITE(p));
    expect(info.denyRead).toEqual(CASE_DENY_READ(p));
    expect(statSync(p.R).isDirectory()).toBe(true);
    expect(statSync(p.T).isDirectory()).toBe(true);
    expect(path.dirname(p.T)).toBe(path.join(tmp, "tmp", "acc"));
    expect(modeOf(p.T)).toBe(0o700);
    // GH は読ませる（CASE_DENY_READ に入れず、書けない側に入れる）
    expect(CASE_DENY_READ(p)).not.toContain(p.GH);
    expect(CASE_DENY_WRITE(p)).toContain(path.join(p.D, "case-gh"));
  });

  it("refuses a symlink for P and leaves the link target alone", async () => {
    const p = params();
    const target = path.join(tmp, "elsewhere");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep"), "x");
    symlinkSync(target, path.join(tmp, "tmp", "acc"));
    await expect(writeCaseFiles(forWrite(p), ID)).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(readFileSync(path.join(target, "keep"), "utf8")).toBe("x");
    expect(lstatSync(path.join(tmp, "tmp", "acc")).isSymbolicLink()).toBe(true);
    // 失敗では自分が作った物は消える
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
    expect(existsSync(p.GH)).toBe(false);
  });

  it("fails when T already exists and keeps what was in it", async () => {
    const p = params();
    mkdirSync(p.T, { recursive: true });
    writeFileSync(path.join(p.T, "keep"), "x");
    await expect(writeCaseFiles(forWrite(p), ID)).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(readFileSync(path.join(p.T, "keep"), "utf8")).toBe("x");
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
  });

  it("accepts a P that already is a real directory of ours", async () => {
    const p = params();
    mkdirSync(path.dirname(p.T), { mode: 0o700 });
    await writeCaseFiles(forWrite(p), ID);
    expect(statSync(p.T).isDirectory()).toBe(true);
  });

  it("removeCaseFiles deletes the case files, and T only with tmp: true; a non-UUID id deletes nothing", async () => {
    const p = params();
    await writeCaseFiles(forWrite(p), ID);
    const other = params({}, OTHER);
    await writeCaseFiles(forWrite(other), OTHER);
    await removeCaseFiles(p.D, "../cases");
    await removeCaseFiles(p.D, "not-a-uuid", { tmp: true, tmpRoot: path.join(tmp, "tmp") });
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(true);
    await removeCaseFiles(p.D, ID);
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
    expect(existsSync(p.GH)).toBe(false);
    expect(existsSync(p.T)).toBe(true);
    await removeCaseFiles(p.D, ID, { tmp: true, tmpRoot: path.join(tmp, "tmp") });
    expect(existsSync(p.T)).toBe(false);
    expect(existsSync(path.dirname(p.T))).toBe(true);
    expect(existsSync(other.T)).toBe(true);
  });

  it("does not remove T through a P that is a symlink", async () => {
    const p = params();
    const target = path.join(tmp, "elsewhere");
    mkdirSync(path.join(target, ID.slice(0, 8)), { recursive: true });
    symlinkSync(target, path.join(tmp, "tmp", "acc"));
    await removeCaseFiles(p.D, ID, { tmp: true, tmpRoot: path.join(tmp, "tmp") });
    expect(existsSync(path.join(target, ID.slice(0, 8)))).toBe(true);
  });
});

describe("the ledger directory as a symlink in M", () => {
  let r: CaseRepo;
  let restore: () => void;
  beforeEach(() => {
    r = makeCaseRepo();
    restore = pointOriginAtB(r.B);
  });
  afterEach(() => {
    restore();
    r.cleanup();
  });

  it("createCaseClone throws and leaves no clone when active-work.d is a symlink", async () => {
    const outside = path.join(r.root, "outside-d");
    mkdirSync(outside);
    pushToB(r, "ledger dir as symlink", () => {
      rmSync(path.join(r.work, ".claude-pipeline", "active-work.d"), { recursive: true });
      symlinkSync(outside, path.join(r.work, ".claude-pipeline", "active-work.d"));
    });
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow();
    expect(existsSync(path.join(r.H, "worktrees", "discord-cases", ID))).toBe(false);
  });
});
