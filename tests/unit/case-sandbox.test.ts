import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_HOOK_FILE, BOARD_GUARD_HOOK_FILE, HOOK_SPECS, addHandlers } from "../../server/activity-hooks.ts";
import { hookPathIn } from "../../server/activity-setup.ts";
import { createCaseClone } from "../../server/case-clone.ts";
import {
  buildCaseRoomProfile,
  buildCaseSettings,
  CASE_ALLOW_READ,
  CASE_ALLOW_WRITE,
  CASE_ALLOWED_DOMAINS,
  CASE_DENY_READ,
  CASE_DENY_READ_SANDBOX,
  CASE_DENY_WRITE,
  CASE_MAIN_ONLY_DOMAINS,
  CASE_PROTECTED_WRITE,
  CASE_PROXY_PORT,
  CASE_ROOM_BASE,
  CASE_ROOM_MACH,
  CASE_ROOM_READ_NAMED,
  CaseSandboxUnavailableError,
  caseProxyDomains,
  casePaths,
  removeCaseFiles,
  resolveClaudeReal,
  rewriteCaseClaudeJson,
  writeCaseFiles,
  writeCaseRoom,
  type CaseParams,
  type CaseRoomOptions,
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
    CH: c.CH,
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
  sandbox: Record<string, unknown>;
  hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }> } & Record<string, unknown>;
};
const CONSOLE_PORT = 4319;
const settingsOf = (p: CaseParams): Settings => buildCaseSettings(p, CONSOLE_PORT) as unknown as Settings;
const abs = (p: string): string => p.replace(/^\/+/, "");
const rules = (list: string[], tool: string): string[] => list.filter((r) => r.startsWith(`${tool}(//`) && r.endsWith("/**)")).map((r) => "/" + r.slice(`${tool}(//`.length, -"/**)".length));
const bare = (list: string[], tool: string): string[] => list.filter((r) => r.startsWith(`${tool}(//`) && !r.endsWith("/**)")).map((r) => "/" + r.slice(`${tool}(//`.length, -1));

describe("buildCaseSettings", () => {
  it("builds the permission denies from the same arrays the room profile uses (one source), and leaves only sandbox.enabled: false", () => {
    const p = params();
    const s = settingsOf(p);
    expect(rules(s.permissions.deny, "Edit")).toEqual(CASE_DENY_WRITE(p));
    expect(bare(s.permissions.deny, "Edit")).toEqual(CASE_DENY_WRITE(p));
    expect(rules(s.permissions.deny, "Read")).toEqual(CASE_DENY_READ(p));
    expect(bare(s.permissions.deny, "Read")).toEqual(CASE_DENY_READ(p));
    expect(s.sandbox).toEqual({ enabled: false });
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
      `${p.R}/.claude`, `${p.D}/hooks`, `${p.D}/activity`, `${p.H}/.claude`, `${p.H}/.claude.json`, `${p.H}/.zshrc`, `/private/tmp/claude-${uid}`, p.M,
    ]) expect(dw).toContain(x);
    expect(CASE_DENY_READ(p)).toContain(path.join(p.H, ".claude", ".credentials.json"));
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
    const base = addHandlers({}, p.nodeBin, p.hookPath, { skip: [BOARD_GUARD_HOOK_FILE], activityArgs: ["--post", `http://127.0.0.1:${CONSOLE_PORT}/api/agent/case-activity`] }).settings as { hooks: Record<string, unknown[]> };
    expect(s.hooks.PreToolUse.slice(1)).toEqual(base.hooks.PreToolUse);
    for (const [event, groups] of Object.entries(base.hooks)) if (event !== "PreToolUse") expect(s.hooks[event]).toEqual(groups);
  });

  it("has no board-guard in the hooks, sends the activity hooks to the console, and every guard script is named in CASE_ROOM_READ_NAMED", () => {
    const p = params();
    const s = settingsOf(p);
    const handlers = Object.values(s.hooks).flatMap((groups) => (groups as Array<{ hooks: Array<{ args?: string[] }> }>).flatMap((g) => g.hooks));
    const scripts = new Set(handlers.map((h) => (h.args ?? [])[0]));
    expect([...scripts].some((x) => x.endsWith(BOARD_GUARD_HOOK_FILE))).toBe(false);
    // HOOK_SPECS から board-guard を除いた数（件の見張り 1 本を足す）
    expect(handlers).toHaveLength(HOOK_SPECS.filter((x) => x.file !== BOARD_GUARD_HOOK_FILE).length + 1);
    const activity = handlers.filter((h) => (h.args ?? [])[0] === p.hookPath);
    expect(activity.length).toBeGreaterThan(0);
    for (const h of activity) expect(h.args).toEqual([p.hookPath, "--post", `http://127.0.0.1:${CONSOLE_PORT}/api/agent/case-activity`]);
    const named = CASE_ROOM_READ_NAMED({ ...p, claudeReal: "/x/claude" });
    for (const script of scripts) expect(named, script).toContain(script);
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
    const out = await writeCaseFiles(forWrite(p), ID, CONSOLE_PORT);
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
    // case-home は件ごとに 0o700 で作る（D/case-home も 0o700）
    expect(modeOf(p.CH)).toBe(0o700);
    expect(modeOf(path.dirname(p.CH))).toBe(0o700);
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
    await expect(writeCaseFiles(forWrite(p), ID, CONSOLE_PORT)).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(readFileSync(path.join(target, "keep"), "utf8")).toBe("x");
    expect(lstatSync(path.join(tmp, "tmp", "acc")).isSymbolicLink()).toBe(true);
    // 失敗では自分が作った物は消える
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
    expect(existsSync(p.GH)).toBe(false);
    expect(existsSync(p.CH)).toBe(false);
  });

  it("fails when T already exists and keeps what was in it", async () => {
    const p = params();
    mkdirSync(p.T, { recursive: true });
    writeFileSync(path.join(p.T, "keep"), "x");
    await expect(writeCaseFiles(forWrite(p), ID, CONSOLE_PORT)).rejects.toBeInstanceOf(CaseSandboxUnavailableError);
    expect(readFileSync(path.join(p.T, "keep"), "utf8")).toBe("x");
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
  });

  it("accepts a P that already is a real directory of ours", async () => {
    const p = params();
    mkdirSync(path.dirname(p.T), { mode: 0o700 });
    await writeCaseFiles(forWrite(p), ID, CONSOLE_PORT);
    expect(statSync(p.T).isDirectory()).toBe(true);
  });

  it("removeCaseFiles deletes the case files, and T only with tmp: true; a non-UUID id deletes nothing", async () => {
    const p = params();
    await writeCaseFiles(forWrite(p), ID, CONSOLE_PORT);
    const other = params({}, OTHER);
    await writeCaseFiles(forWrite(other), OTHER, CONSOLE_PORT);
    await removeCaseFiles(p.D, "../cases");
    await removeCaseFiles(p.D, "not-a-uuid", { tmp: true, tmpRoot: path.join(tmp, "tmp") });
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(true);
    expect(existsSync(p.CH)).toBe(true);
    await removeCaseFiles(p.D, ID);
    expect(existsSync(path.join(p.D, "cases", ID))).toBe(false);
    expect(existsSync(p.GH)).toBe(false);
    expect(existsSync(p.CH)).toBe(false);
    expect(existsSync(other.CH)).toBe(true);
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

// ---- 部屋（room.sb）----

/** SBPL の最上位の式に分ける（文字列 "…" と正規表現 #"…" の中の括弧は数えない） */
function splitForms(text: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === ";" && depth === 0) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) forms.push(text.slice(start, i + 1));
    }
  }
  return forms;
}
const CLAUDE_REAL = "/opt/claude/versions/2.1.311";
const roomOpts = (): CaseRoomOptions => ({ proxyPort: CASE_PROXY_PORT, consolePort: CONSOLE_PORT, claudeReal: CLAUDE_REAL, guardScript: "/repo/ops/case/case-guard.mjs" });
const quoted = (x: string): string => JSON.stringify(x);
const chClaudeJsonTmpForTest = (CH: string): string => `^${CH.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")}/\\.claude\\.json\\.tmp\\.[0-9]+\\.${"[0-9a-f]".repeat(12)}$`;
const formsStarting = (profile: string, head: string): string[] => splitForms(profile).filter((f) => f.startsWith(head + "\n") || f.startsWith(head + " ") || f === head);
const subpathsOf = (form: string): string[] => [...form.matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/g)].map((m) => JSON.parse(m[1]) as string);
const literalsOf = (form: string): string[] => [...form.matchAll(/\(literal ("(?:[^"\\]|\\.)*")\)/g)].map((m) => JSON.parse(m[1]) as string);
const regexesOf = (form: string): string[] => [...form.matchAll(/\(regex #"((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
const covered = (form: string, target: string): boolean => subpathsOf(form).some((d) => target === d || target.startsWith(d + "/")) || literalsOf(form).includes(target) || regexesOf(form).some((r) => new RegExp(r).test(target));

describe("buildCaseRoomProfile", () => {
  const prof = (over: Partial<CaseParams> = {}): { p: CaseParams; text: string; full: CaseParams & { claudeReal: string } } => {
    const p = params(over);
    return { p, text: buildCaseRoomProfile(p, roomOpts()), full: { ...p, guardScript: roomOpts().guardScript, claudeReal: CLAUDE_REAL } };
  };

  it("starts with deny default and the base, and puts every list path into a rule", () => {
    const { p, text, full } = prof();
    expect(text.startsWith("(version 1)\n(deny default)\n")).toBe(true);
    expect(text).toContain(CASE_ROOM_BASE);
    const denyRead = formsStarting(text, "(deny file-read*")[0];
    for (const d of [...CASE_DENY_READ_SANDBOX(p), ...CASE_DENY_READ(p)]) expect(subpathsOf(denyRead), d).toContain(d);
    const reopen = formsStarting(text, "(allow file-read*").find((f) => f.includes("(subpath")) as string;
    for (const a of CASE_ALLOW_READ(p)) expect(subpathsOf(reopen), a).toContain(a);
    for (const n of CASE_ROOM_READ_NAMED(full)) expect(n === p.CH ? subpathsOf(reopen) : literalsOf(reopen), n).toContain(n);
    const writeAllow = formsStarting(text, "(allow file-write*")[0];
    for (const w of CASE_ALLOW_WRITE(p)) expect(subpathsOf(writeAllow), w).toContain(w);
    const writeDeny = formsStarting(text, "(deny file-write*")[0];
    for (const d of CASE_DENY_WRITE(p)) expect(subpathsOf(writeDeny), d).toContain(d);
    for (const r of CASE_PROTECTED_WRITE(p)) expect(regexesOf(writeDeny), r).toContain(r);
    // 道は realpath の絶対パス
    for (const x of [p.W, p.R, p.T, p.CH, p.D, p.H]) expect(path.isAbsolute(x)).toBe(true);
  });

  it("denies file-write after allowing it (the later rule wins)", () => {
    const { text } = prof();
    expect(text.indexOf("(allow file-write*")).toBeGreaterThan(-1);
    expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
    const lastDeny = text.lastIndexOf("(deny file-write-unlink file-write-create");
    expect(lastDeny).toBeGreaterThan(text.indexOf("(deny file-write*"));
  });

  it("has no (allow file-read* after the re-open block (REVIEW INVARIANT)", () => {
    const { text } = prof();
    const reads = [...text.matchAll(/\(allow file-read\*/g)].map((m) => m.index as number);
    // 全体を許す 1 つ目と、開け直しの塊の 2 つ目だけ
    expect(reads).toHaveLength(2);
    expect(text.slice(reads[0], reads[0] + "(allow file-read*)".length)).toBe("(allow file-read*)");
    const reopenEnd = text.indexOf("\n)", reads[1]);
    expect(text.slice(reopenEnd)).not.toContain("(allow file-read*");
  });

  it("names every CASE_ROOM_READ_NAMED path as a literal (CH as a subpath) and never re-denies one", () => {
    const { p, text, full } = prof();
    const named = CASE_ROOM_READ_NAMED(full);
    expect(named).toEqual(expect.arrayContaining([
      path.join(p.D, "cases", ID, "settings.json"), path.join(p.D, "cases", ID, "case.json"), "/repo/ops/case/case-guard.mjs",
      path.join(p.D, "hooks", ACTIVITY_HOOK_FILE), path.join(p.D, "hooks", "ac-routine-guard.mjs"), path.join(p.D, "hooks", "server-kill-guard.mjs"), CLAUDE_REAL, p.CH,
    ]));
    // git の設定の 4 つは CASE_ALLOW_READ にあり、ここには足さない
    for (const g of [".gitconfig", path.join(".config", "git", "config")]) expect(named).not.toContain(path.join(p.H, g));
    const denies = formsStarting(text, "(deny file-read*");
    const reopen = formsStarting(text, "(allow file-read*").find((f) => f.includes("(subpath")) as string;
    for (const n of named) {
      if (n === p.CH) continue;
      expect(literalsOf(reopen), n).toContain(n);
      for (const d of denies.slice(1)) expect(covered(d, n), `${n} re-denied`).toBe(false);
    }
    // room.sb 自身と、固定した会話の番号は開けない
    expect(named).not.toContain(path.join(p.D, "cases", ID, "room.sb"));
    expect(named).not.toContain(path.join(p.D, "cases", ID, "session-id"));
  });

  it("no re-open path is an ancestor of a denied path, or the denied path is re-denied afterwards", () => {
    const { p, text } = prof();
    const denies = formsStarting(text, "(deny file-read*");
    const reopened = [...CASE_ALLOW_READ(p), p.CH];
    const denied = [...new Set([...CASE_DENY_READ_SANDBOX(p), ...CASE_DENY_READ(p)])];
    for (const d of denied) for (const a of reopened) if (d.startsWith(a + "/")) expect(subpathsOf(denies[1] ?? ""), `${a} covers ${d}`).toContain(d);
    // 本物の並びでは、再拒否の塊は出ない
    expect(denies).toHaveLength(1);
    // 開け直しの道の下に拒否の道があれば再拒否が出る（D を W の下に置いた形）
    const W = casePaths({ id: ID, H: path.join(tmp, "home"), D: path.join(tmp, "data"), tmpRoot: path.join(tmp, "tmp") }).W;
    const nested = buildCaseRoomProfile(params({ D: path.join(W, "d") }), roomOpts());
    const again = formsStarting(nested, "(deny file-read*");
    expect(again.length).toBeGreaterThan(1);
    expect(subpathsOf(again[1])).toContain(path.join(W, "d", "cases"));
  });

  it("re-opens unlink / create for W, R, T and the case-home records only (no subpath of the case-home root)", () => {
    const { p, text } = prof();
    const reopen = formsStarting(text, "(allow file-write-unlink file-write-create")[0];
    for (const x of [p.W, p.R, p.T, ...["projects", "sessions", "session-env", "shell-snapshots", "tasks", "teams"].map((n) => path.join(p.CH, n))]) expect(subpathsOf(reopen), x).toContain(x);
    expect(literalsOf(reopen)).toEqual(expect.arrayContaining([path.join(p.CH, ".last-cleanup"), path.join(p.CH, ".claude.json")]));
    expect(subpathsOf(reopen)).not.toContain(p.CH);
    const write = formsStarting(text, "(allow file-write*")[0];
    expect(subpathsOf(write)).not.toContain(p.CH);
    expect(literalsOf(write)).toEqual(expect.arrayContaining([path.join(p.CH, ".last-cleanup"), path.join(p.CH, ".claude.json"), "/dev/null"]));
    // 開け直しは移動の塞ぎのあと
    expect(text.indexOf("(allow file-write-unlink file-write-create")).toBeGreaterThan(text.indexOf("(deny file-write-unlink file-write-create"));
  });

  it("opens the case-home companions (.claude.json.lock, history.jsonl, .claude.json.tmp.<pid>.<12 hex>) in both the create re-open and the write allow", () => {
    const { p, text } = prof();
    const reopen = formsStarting(text, "(allow file-write-unlink file-write-create")[0];
    const write = formsStarting(text, "(allow file-write*")[0];
    const tmpRe = chClaudeJsonTmpForTest(p.CH);
    for (const form of [reopen, write]) {
      expect(literalsOf(form)).toEqual(expect.arrayContaining([path.join(p.CH, "history.jsonl"), path.join(p.CH, ".claude.json.lock")]));
      expect(regexesOf(form)).toContain(tmpRe);
      expect(covered(form, `${p.CH}/.claude.json.tmp.20273.0c36f211e77d`)).toBe(true);
      for (const bad of [".claude.json.tmp.20273.0c36f211e77", ".claude.json.tmp.x.0c36f211e77d", ".claude.json.tmp.20273.0c36f211e77d/x", ".claude.json.evil", ".claude.json.backup.1", "backups/.claude.json.tmp.1.0c36f211e77d"]) expect(covered(form, `${p.CH}/${bad}`), bad).toBe(false);
      expect(subpathsOf(form)).not.toContain(p.CH);
      expect(literalsOf(form).some((l) => l.includes("backup"))).toBe(false);
    }
  });

  it("uses no {n} repetition in any regex of the room profile (Seatbelt does not accept it)", () => {
    const { text } = prof();
    const all = regexesOf(text);
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(r.includes("{"), r).toBe(false);
  });

  it("blocks moving a denied path and every ancestor directory of it (literal)", () => {
    const { p, text } = prof();
    const block = formsStarting(text, "(deny file-write-unlink file-write-create")[0];
    const denied = [...new Set([...CASE_DENY_READ_SANDBOX(p), ...CASE_DENY_READ(p)])];
    for (const d of denied) {
      expect(subpathsOf(block), d).toContain(d);
      for (let a = path.dirname(d); a !== "/"; a = path.dirname(a)) expect(literalsOf(block), `${a} (ancestor of ${d})`).toContain(a);
    }
    expect(literalsOf(block)).not.toContain("/");
  });

  it("builds the nested .git / .claude regexes from W, R, CH only (never T) and ends them with the name", () => {
    const { p, text } = prof();
    const block = formsStarting(text, "(deny file-write-unlink file-write-create").at(-1) as string;
    const nested = regexesOf(block).filter((r) => /\\\.\[gG\]\[iI\]\[tT\]\$$|\\\.\[cC\]\[lL\]\[aA\]\[uU\]\[dD\]\[eE\]\$$/.test(r));
    expect(nested).toHaveLength(6);
    const roots = [p.W, p.R, p.CH].map((x) => x.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&"));
    for (const r of nested) {
      expect(roots.some((x) => r.startsWith(`^${x}/(.+/)?`)), r).toBe(true);
      expect(new RegExp(r).test(`${p.T}/.git`), r).toBe(false);
      expect(new RegExp(r).test(`${p.T}/sub/.claude`), r).toBe(false);
    }
    const re = (x: string): RegExp => new RegExp(nested.filter((r) => r.startsWith(`^${roots[0]}/`) && r.includes(x))[0]);
    expect(re("[gG]").test(`${p.W}/sub/.git`)).toBe(true);
    expect(re("[gG]").test(`${p.W}/sub/.GIT`)).toBe(true);
    expect(re("[gG]").test(`${p.W}/.git/index.lock`)).toBe(false);
    expect(re("[cC]").test(`${p.W}/a/b/.claude`)).toBe(true);
    expect(re("[cC]").test(`${p.W}/.claude/settings.json`)).toBe(false);
    // 根と .claude・.git の literal
    for (const X of [p.W, p.R, p.CH]) expect(literalsOf(block)).toEqual(expect.arrayContaining([X, path.join(X, ".claude"), path.join(X, ".git")]));
  });

  it("puts the case-home settings names (B) in both the write deny and the create block, and none in the write allow", () => {
    const { p, text } = prof();
    const writeDeny = formsStarting(text, "(deny file-write*")[0];
    const block = formsStarting(text, "(deny file-write-unlink file-write-create").at(-1) as string;
    const names = ["remote-settings.json", "remote-settings.json.synced-at", "plugins", "backups", "settings.json", "agents", "hooks", "commands", "skills", "CLAUDE.md"];
    for (const form of [writeDeny, block]) {
      for (const n of names) expect(covered(form, path.join(p.CH, n)), n).toBe(true);
      expect(covered(form, path.join(p.CH, "plugins", "x", "y"))).toBe(true);
      expect(covered(form, path.join(p.CH, "policy-limits-abc.json"))).toBe(true);
      // (A) の記録は塞がない
      expect(covered(form, path.join(p.CH, "projects", "x", "a.jsonl"))).toBe(false);
    }
    const allow = formsStarting(text, "(allow file-write*")[0];
    for (const n of [...names, "Remote-Settings.json", "REMOTE-SETTINGS.JSON", "Settings.json", "PLUGINS", "other"]) expect(covered(allow, path.join(p.CH, n)), n).toBe(false);
    expect(covered(allow, path.join(p.CH, "projects", "x"))).toBe(true);
    expect(covered(allow, path.join(p.CH, ".claude.json"))).toBe(true);
  });

  it("protects .claude/workflows and .claude/scheduled_tasks.json under W and R (and CH), case-insensitively", () => {
    const { p } = prof();
    const regs = CASE_PROTECTED_WRITE(p).map((r) => new RegExp(r));
    const hit = (x: string): boolean => regs.some((r) => r.test(x));
    for (const X of [p.W, p.R, p.CH]) {
      expect(hit(`${X}/.claude/workflows/x.js`), X).toBe(true);
      expect(hit(`${X}/sub/.claude/scheduled_tasks.json`), X).toBe(true);
      expect(hit(`${X}/.CLAUDE/Scheduled_Tasks.JSON`), X).toBe(true);
      expect(hit(`${X}/sub/.cLaUdE/settings.json`), X).toBe(true);
      expect(hit(`${X}/.GIT/hooks/x`), X).toBe(true);
      expect(hit(`${X}/.mcp.json`), X).toBe(true);
      expect(hit(`${X}/HEAD`), X).toBe(true);
    }
    expect(hit(`${p.T}/.claude/workflows/x`)).toBe(false);
    expect(hit(`${p.W}/src/index.ts`)).toBe(false);
  });

  it("has full mach-lookup names only, no AppleEvents / lsopen, and none of the keychain services", () => {
    const { text } = prof();
    expect(CASE_ROOM_MACH.every((m) => !m.includes("*"))).toBe(true);
    expect(CASE_ROOM_MACH).toContain("com.apple.trustd.agent");
    expect(CASE_ROOM_MACH).not.toContain("com.apple.SecurityServer");
    expect(CASE_ROOM_MACH).not.toContain("com.apple.securityd.xpc");
    expect(text).not.toContain("global-name-prefix");
    expect(text).not.toMatch(/appleevent|lsopen|SecurityServer|securityd/);
    const mach = formsStarting(text, "(allow mach-lookup");
    expect(mach).toHaveLength(1);
    expect([...mach[0].matchAll(/\(global-name ("[^"]+")\)/g)].map((m) => JSON.parse(m[1]))).toEqual([...CASE_ROOM_MACH]);
    // srt から写した塊には出どころの注記がある
    expect(text).toContain("; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:");
  });

  it("allows the network only to the proxy and the console ports, and file-ioctl only on /dev files and the TTY parameter", () => {
    const { text } = prof();
    const net = splitForms(text).filter((f) => /^\(allow network/.test(f));
    expect(net).toEqual([`(allow network-outbound (remote ip "localhost:${CASE_PROXY_PORT}") (remote ip "localhost:${CONSOLE_PORT}"))`]);
    expect(text).not.toMatch(/network-bind|network-inbound|network\*|unix/);
    const ioctl = splitForms(text).filter((f) => f.startsWith("(allow file-ioctl"));
    const targets = ioctl.flatMap((f) => [...f.matchAll(/\(literal ("[^"]+"|\(param "TTY"\))\)/g)].map((m) => m[1]));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper", "/dev/tty", '(param "TTY")']).toContain(t.replace(/^"|"$/g, ""));
    expect(targets).toContain('(param "TTY")');
    expect(text).not.toContain("/dev/ttys");
  });

  it("quotes paths with spaces, escapes a double quote in a string, and refuses one inside a regex path", () => {
    const { text, p } = prof({ M: path.join(tmp, "main dir") });
    expect(text).toContain(`(subpath ${quoted(path.join(tmp, "main dir"))})`);
    expect(buildCaseRoomProfile({ ...p, M: '/x/"y' }, roomOpts())).toContain('(subpath "/x/\\"y")');
    expect(() => buildCaseRoomProfile({ ...p, W: '/x/"y' }, roomOpts())).toThrow(CaseSandboxUnavailableError);
  });

  it("caseProxyDomains is CASE_ALLOWED_DOMAINS without the local two plus CASE_MAIN_ONLY_DOMAINS", () => {
    expect(caseProxyDomains()).toEqual([...CASE_ALLOWED_DOMAINS.filter((d) => d !== "127.0.0.1" && d !== "localhost"), ...CASE_MAIN_ONLY_DOMAINS]);
    expect(caseProxyDomains()).toEqual(["api.github.com", "github.com", "api.salesanchor.jp", "api.anthropic.com"]);
    expect(CASE_PROXY_PORT).toBe(18124);
  });
});

describe("writeCaseRoom", () => {
  const roomDir = (p: CaseParams): string => path.join(p.D, "cases", ID);
  const setup = (): CaseParams => {
    const p = params();
    mkdirSync(roomDir(p), { recursive: true });
    return p;
  };

  it("writes room.sb with mode 0600 and the same text as buildCaseRoomProfile", () => {
    const p = setup();
    const file = writeCaseRoom(p, roomOpts());
    expect(file).toBe(path.join(roomDir(p), "room.sb"));
    expect(readFileSync(file, "utf8")).toBe(buildCaseRoomProfile(p, roomOpts()));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(roomDir(p))).toEqual(["room.sb"]);
  });

  it("removes leftover room.sb.*.tmp files before writing", () => {
    const p = setup();
    writeFileSync(path.join(roomDir(p), "room.sb.abc.tmp"), "old");
    writeFileSync(path.join(roomDir(p), "settings.json"), "{}");
    writeCaseRoom(p, roomOpts());
    expect(readdirSync(roomDir(p)).sort()).toEqual(["room.sb", "settings.json"]);
  });

  it("fails with the fixed message and removes the old room.sb when the temp write fails", () => {
    const p = setup();
    writeCaseRoom(p, roomOpts());
    const boom = (): never => {
      throw new Error("disk full");
    };
    let thrown: unknown;
    try {
      writeCaseRoom(p, { ...roomOpts(), io: { writeFileSync: boom as never } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CaseSandboxUnavailableError);
    expect((thrown as Error).message).toBe("sandbox unavailable: room profile could not be written");
    expect(existsSync(path.join(roomDir(p), "room.sb"))).toBe(false);
  });

  it("fails and leaves no temp file or room.sb when the rename fails", () => {
    const p = setup();
    writeCaseRoom(p, roomOpts());
    expect(() => writeCaseRoom(p, { ...roomOpts(), io: { renameSync: (() => { throw new Error("EXDEV"); }) as never } })).toThrow(CaseSandboxUnavailableError);
    expect(readdirSync(roomDir(p))).toEqual([]);
  });

  it("fails when the case directory is missing", () => {
    const p = params();
    expect(() => writeCaseRoom(p, roomOpts())).toThrow("sandbox unavailable: room profile could not be written");
  });
});

describe("rewriteCaseClaudeJson", () => {
  const read = (CH: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(CH, ".claude.json"), "utf8")) as Record<string, unknown>;
  let CH: string;
  let W: string;
  beforeEach(() => {
    CH = path.join(tmp, "ch");
    W = path.join(tmp, "w");
    mkdirSync(CH);
    mkdirSync(W);
  });

  it("keeps only the allowed keys with scalar values and adds the onboarding / trust marks", () => {
    writeFileSync(path.join(CH, ".claude.json"), JSON.stringify({ userID: "u1", machineID: "m1", firstStartTime: "2026-01-01T00:00:00Z", firstStartVersion: "2.1.0", migrationVersion: 7, opusProMigrationComplete: true, sonnet1m45MigrationComplete: false, hasCompletedOnboarding: false, projects: { "/x": { hasTrustDialogAccepted: false } } }));
    rewriteCaseClaudeJson(CH, W);
    expect(read(CH)).toEqual({
      userID: "u1", machineID: "m1", firstStartTime: "2026-01-01T00:00:00Z", firstStartVersion: "2.1.0", migrationVersion: 7, opusProMigrationComplete: true, sonnet1m45MigrationComplete: false,
      hasCompletedOnboarding: true, projects: { [W]: { hasTrustDialogAccepted: true } },
    });
    expect(statSync(path.join(CH, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(CH)).toEqual([".claude.json"]);
  });

  it("drops keys of the wrong type and every other key (mcpServers and so on)", () => {
    writeFileSync(path.join(CH, ".claude.json"), JSON.stringify({ userID: { a: 1 }, machineID: ["x"], firstStartTime: null, migrationVersion: "7", mcpServers: { evil: { command: "x" } }, cachedGrowthBookFeatures: { a: 1 }, pluginUsage: {}, seenNotifications: [] }));
    rewriteCaseClaudeJson(CH, W);
    const out = read(CH);
    expect(Object.keys(out).sort()).toEqual(["hasCompletedOnboarding", "migrationVersion", "projects"]);
    expect(out.migrationVersion).toBe("7");
  });

  it("treats a missing, broken, array or symlinked file as empty", () => {
    rewriteCaseClaudeJson(CH, W);
    expect(Object.keys(read(CH)).sort()).toEqual(["hasCompletedOnboarding", "projects"]);
    writeFileSync(path.join(CH, ".claude.json"), "{ not json");
    rewriteCaseClaudeJson(CH, W);
    expect(Object.keys(read(CH)).sort()).toEqual(["hasCompletedOnboarding", "projects"]);
    writeFileSync(path.join(CH, ".claude.json"), "[1,2]");
    rewriteCaseClaudeJson(CH, W);
    expect(Object.keys(read(CH)).sort()).toEqual(["hasCompletedOnboarding", "projects"]);
    const secret = path.join(tmp, "secret.json");
    writeFileSync(secret, JSON.stringify({ userID: "from-link" }));
    rmSync(path.join(CH, ".claude.json"));
    symlinkSync(secret, path.join(CH, ".claude.json"));
    rewriteCaseClaudeJson(CH, W);
    expect(read(CH).userID).toBeUndefined();
    expect(lstatSync(path.join(CH, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(secret, "utf8"))).toEqual({ userID: "from-link" });
  });

  it("writes the realpath of W as the trusted project", () => {
    const link = path.join(tmp, "wlink");
    symlinkSync(W, link);
    rewriteCaseClaudeJson(CH, link);
    expect(Object.keys(read(CH).projects as object)).toEqual([W]);
  });

  it("throws CaseSandboxUnavailableError when the case-home is not writable (missing)", () => {
    expect(() => rewriteCaseClaudeJson(path.join(tmp, "nope"), W)).toThrow(CaseSandboxUnavailableError);
  });
});

describe("resolveClaudeReal", () => {
  it("takes a path with a slash as is, searches PATH from the left otherwise, and returns the realpath", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    mkdirSync(a);
    mkdirSync(b);
    const real = path.join(tmp, "versions", "2.1.311");
    mkdirSync(path.dirname(real));
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(a, "claude"), "x", { mode: 0o644 });
    symlinkSync(real, path.join(b, "claude"));
    expect(resolveClaudeReal("claude", `${a}${path.delimiter}${b}`)).toBe(real);
    expect(resolveClaudeReal(path.join(b, "claude"), undefined)).toBe(real);
    expect(resolveClaudeReal("claude", a)).toBeNull();
    expect(resolveClaudeReal("claude", undefined)).toBeNull();
    expect(resolveClaudeReal(path.join(tmp, "nothing"), "")).toBeNull();
  });
});

// sandbox-exec を本当に動かす（macOS だけ。ほかでは skip）
describe.skipIf(process.platform !== "darwin")("room.sb under sandbox-exec (darwin only)", () => {
  it("lets W be written and blocks the rest", () => {
    const p = params({ nodeBin: process.execPath });
    for (const d of [p.W, p.R, p.T, p.CH, path.join(p.W, ".git", "hooks"), path.join(p.W, "sub", ".Claude", "agents"), path.join(p.H, "other"), path.join(tmp, "outside"), path.join(p.D, "cases", ID)]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(p.H, "other", "secret"), "s");
    const real = realpathSync("/bin/sh");
    writeCaseRoom(p, { ...roomOpts(), claudeReal: real });
    const room = path.join(p.D, "cases", ID, "room.sb");
    const sh = (cmd: string): number | null => spawnSync("/usr/bin/sandbox-exec", ["-f", room, "-D", "TTY=/dev/null", "/bin/sh", "-c", cmd], { encoding: "utf8" }).status;
    expect(sh(`echo ok > '${p.W}/f'`)).toBe(0);
    expect(sh(`echo x > '${tmp}/outside/f'`)).not.toBe(0);
    expect(sh(`echo x > '${p.W}/.git/hooks/x'`)).not.toBe(0);
    expect(sh(`echo x > '${p.W}/sub/.Claude/agents/x'`)).not.toBe(0);
    expect(sh(`echo x > '${p.CH}/remote-settings.json'`)).not.toBe(0);
    expect(sh(`mv '${p.W}/.git' '${p.W}/g'`)).not.toBe(0);
    expect(sh(`cat '${p.H}/other/secret'`)).not.toBe(0);
  });
});
