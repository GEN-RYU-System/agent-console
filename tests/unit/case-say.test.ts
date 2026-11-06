import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../hooks/ac-case-say.mjs";
import { caseSayText, caseSayVerdict, Hub, type CaseSayPorts } from "../../server/hub.ts";
import { parseConfig, type Config } from "../../server/config.ts";
import type { AgentRow } from "../../server/agents.ts";
import type { Session, SessionManager } from "../../server/sessions.ts";
import type { PaneSendResult } from "../../server/terminal-host/types.ts";
import { RESERVE_TOKEN, startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 30000 });

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CALLER = "22222222-2222-4222-8222-222222222222";
const MAIN_PID = 4242;
const PANE = "%21";
const STEP = "step1.md";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

// ---------------------------------------------------------------- Hub.caseSay（偽の窓・偽の tmux・偽の ps・本物のファイル）

interface World {
  dir: string;
  CH: string;
  R: string;
  sends: Array<{ pane: string; pid: number; data: string }>;
  hub: Hub;
  session: Session;
  /** 試験が差し替える状態 */
  s: {
    exited: boolean;
    closing: boolean;
    isCase: boolean;
    reattached: boolean;
    main: { pid: number; lstart: string } | undefined;
    lstart: string | null;
    pane: { paneId: string; panePid: number; windows: number; panes: number } | null;
    writeState: { writable: boolean; pending: number } | undefined;
    real: string | undefined;
    rows: AgentRow[] | null;
    table: Array<{ pid: number; ppid: number; rssKb: number; cpu: number }> | null;
    sendResults: PaneSendResult[];
    sendThrows: boolean;
    queryPid: number | null;
    onSleep: () => void;
  };
  removed: Array<(id: string) => void>;
  config: Config;
}

function writeState(w: World, obj: Record<string, unknown> | string, pid = MAIN_PID): void {
  mkdirSync(path.join(w.CH, "sessions"), { recursive: true });
  writeFileSync(path.join(w.CH, "sessions", `${pid}.json`), typeof obj === "string" ? obj : JSON.stringify(obj));
}

function makeWorld(over: { versions?: string[] } = {}): World {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-case-say-"));
  const CH = path.join(dir, "case-home");
  const R = path.join(dir, "R");
  mkdirSync(R, { recursive: true });
  writeFileSync(path.join(R, STEP), "# 手順\n");
  const s: World["s"] = {
    exited: false,
    closing: false,
    isCase: true,
    reattached: false,
    main: { pid: MAIN_PID, lstart: "Wed Nov  5 10:00:00 2026" },
    lstart: "Wed Nov  5 10:00:00 2026",
    pane: { paneId: PANE, panePid: MAIN_PID, windows: 1, panes: 1 },
    writeState: { writable: true, pending: 0 },
    real: "/Users/x/.local/share/claude/versions/2.1.318",
    rows: [],
    table: [{ pid: MAIN_PID, ppid: 1, rssKb: 0, cpu: 0 }],
    sendResults: [],
    sendThrows: false,
    queryPid: MAIN_PID,
    onSleep: () => undefined,
  };
  const sends: World["sends"] = [];
  const term = {
    pid: MAIN_PID,
    writeState: () => s.writeState,
    sendToPane: async (pane: string, pid: number, data: string): Promise<PaneSendResult> => {
      sends.push({ pane, pid, data });
      if (s.sendThrows) throw new Error("boom");
      return s.sendResults.shift() ?? { written: true };
    },
    queryPanePid: async () => s.queryPid,
  };
  const session = { id: CASE_ID, term, exited: false, reattached: false } as unknown as Session;
  Object.defineProperty(session, "exited", { get: () => s.exited });
  Object.defineProperty(session, "reattached", { get: () => s.reattached });
  const removed: Array<(id: string) => void> = [];
  const sessions = {
    onChange: () => undefined,
    onRemoved: (l: (id: string) => void) => removed.push(l),
    get: (id: string) => (id === CASE_ID ? session : undefined),
    isClosing: () => s.closing,
    caseHomeOf: () => (s.isCase && !s.exited ? CH : undefined),
    caseRootOf: () => (s.isCase && !s.exited ? R : undefined),
    caseMainProcesses: () => new Map(s.main === undefined ? [] : [[CASE_ID, s.main]]),
    casePaneInfo: () => s.pane,
    caseClaudeRealOf: () => s.real,
  } as unknown as SessionManager;
  const config = { caseSayClaudeVersions: over.versions ?? ["2.1.318"], pasteSubmitDelayMs: 5, claudeBin: "claude", notify: { macos: false } } as unknown as Config;
  const ports: CaseSayPorts = {
    readLstart: () => s.lstart,
    readTable: async () => {
      if (s.table === null) throw new Error("ps failed");
      return s.table;
    },
    fetchAgents: async () => s.rows,
    sleep: async () => s.onSleep(),
  };
  const hub = new Hub(config, sessions, null, { caseSay: ports });
  const w: World = { dir, CH, R, sends, hub, session, s, removed, config };
  writeState(w, { pid: MAIN_PID, status: "idle", sessionId: "x" });
  return w;
}

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const say = (): ReturnType<Hub["caseSay"]> => w.hub.caseSay({ caseId: CASE_ID, stepFile: STEP });
const expectRefused = async (reason: string): Promise<void> => {
  const r = await say();
  expect(r.status, JSON.stringify(r)).toBe(409);
  expect(r.reason).toBe(reason);
  expect(w.sends).toHaveLength(0);
};

describe("K31: Hub.caseSay judgement 4 to 9", () => {
  it("sends exactly one paste and one conditional Enter, both addressed to the pane number and the recorded pid", async () => {
    const r = await say();
    expect(r.status).toBe(200);
    expect(w.sends).toEqual([
      { pane: PANE, pid: MAIN_PID, data: `${PASTE_START}${caseSayText(w.R, STEP)}${PASTE_END}` },
      { pane: PANE, pid: MAIN_PID, data: "\r" },
    ]);
    expect(caseSayText("/r", "a.md")).toBe("/r/a.md を読み、書いてある手順を順に行ってください。");
    expect(r.claudeVersion).toBe("2.1.318");
    expect(r.textSha16).toMatch(/^[0-9a-f]{16}$/);
    expect(r.stepSha16).toMatch(/^[0-9a-f]{16}$/);
    expect(w.hub.writing.has(CASE_ID)).toBe(false);
    // 印が付いていないので、続けてもう一度送れる
    expect((await say()).status).toBe(200);
  });

  it("4: refuses (writing nothing) when the destination is not the recorded window", async () => {
    w.s.exited = true;
    await expectRefused("no_session");
    w.s.exited = false;
    w.s.closing = true;
    await expectRefused("closing");
    w.s.closing = false;
    w.s.isCase = false;
    await expectRefused("not_case_session");
    w.s.isCase = true;
    w.s.reattached = true;
    await expectRefused("reattached");
    w.s.reattached = false;
    w.s.main = undefined;
    await expectRefused("no_main_record");
    w.s.main = { pid: MAIN_PID, lstart: "Wed Nov  5 10:00:00 2026" };
    w.s.lstart = "Wed Nov  5 11:11:11 2026";
    await expectRefused("main_changed");
    w.s.lstart = null;
    await expectRefused("main_changed");
    w.s.lstart = "Wed Nov  5 10:00:00 2026";
    // 窓の形（区画の入れ替え・分割・窓の追加）
    for (const pane of [null, { paneId: PANE, panePid: 9999, windows: 1, panes: 1 }, { paneId: PANE, panePid: MAIN_PID, windows: 2, panes: 1 }, { paneId: PANE, panePid: MAIN_PID, windows: 1, panes: 2 }]) {
      w.s.pane = pane;
      await expectRefused(pane === null ? "pane_unreadable" : "pane_changed");
    }
  });

  it("4: refuses with terminal_not_ready when the connection cannot write now or writes are buffered (0 writes)", async () => {
    for (const st of [{ writable: false, pending: 0 }, { writable: true, pending: 1 }, undefined]) {
      w.s.writeState = st;
      await expectRefused("terminal_not_ready");
    }
  });

  it("5: a stop mark refuses the next call", async () => {
    w.s.sendResults = [{ written: false, reason: "not_written" }];
    expect((await say()).reason).toBe("pane_changed_during_paste");
    w.sends.length = 0;
    await expectRefused("stopped_after_paste");
  });

  it("6: refuses when the step file is missing, a symlink, a hard link, too big, or R is a symlink", async () => {
    await expect(w.hub.caseSay({ caseId: CASE_ID, stepFile: "nope.md" })).resolves.toMatchObject({ status: 409, reason: "step_file_unusable" });
    symlinkSync(path.join(w.R, STEP), path.join(w.R, "link.md"));
    await expect(w.hub.caseSay({ caseId: CASE_ID, stepFile: "link.md" })).resolves.toMatchObject({ reason: "step_file_unusable" });
    linkSync(path.join(w.R, STEP), path.join(w.R, "hard.md"));
    await expect(w.hub.caseSay({ caseId: CASE_ID, stepFile: "hard.md" })).resolves.toMatchObject({ reason: "step_file_unusable" });
    writeFileSync(path.join(w.R, "big.md"), "x".repeat(64 * 1024 + 1));
    await expect(w.hub.caseSay({ caseId: CASE_ID, stepFile: "big.md" })).resolves.toMatchObject({ reason: "step_file_unusable" });
    writeFileSync(path.join(w.R, "edge.md"), "x".repeat(64 * 1024));
    // 64KiB ちょうどは読める（ただし hard.md を作った後の STEP は nlink 2 になるので別名で確かめる）
    await expect(w.hub.caseSay({ caseId: CASE_ID, stepFile: "edge.md" })).resolves.toMatchObject({ status: 200 });
    w.sends.length = 0;
    const real = path.join(w.dir, "real-R");
    mkdirSync(real);
    writeFileSync(path.join(real, STEP), "x");
    rmSync(w.R, { recursive: true, force: true });
    symlinkSync(real, w.R);
    await expectRefused("step_file_unusable");
  });

  it("7: refuses unless exactly one readable state file says idle with no wait key", async () => {
    writeState(w, { pid: MAIN_PID, status: "busy" });
    await expectRefused("claude_not_idle");
    writeState(w, { pid: MAIN_PID, status: "idle", waitingFor: "permission" });
    await expectRefused("claude_waiting");
    writeState(w, { pid: MAIN_PID, status: "idle", Pending_WAIT_state: null });
    await expectRefused("claude_waiting");
    writeState(w, { pid: MAIN_PID + 1, status: "idle" });
    await expectRefused("state_file_pid_mismatch");
    writeState(w, { status: "idle" });
    await expectRefused("state_file_pid_mismatch");
    writeState(w, "not json");
    await expectRefused("state_file_unreadable");
    rmSync(path.join(w.CH, "sessions", `${MAIN_PID}.json`));
    await expectRefused("state_file_unreadable");
    // 子孫が 2 つあり、どちらの状態ファイルも読めるときは決められない
    writeState(w, { pid: MAIN_PID, status: "idle" });
    writeState(w, { pid: 4300, status: "idle" }, 4300);
    w.s.table = [{ pid: MAIN_PID, ppid: 1, rssKb: 0, cpu: 0 }, { pid: 4300, ppid: MAIN_PID, rssKb: 0, cpu: 0 }];
    await expectRefused("state_file_unreadable");
    // 子孫でない pid の状態ファイルは数えない
    rmSync(path.join(w.CH, "sessions", "4300.json"));
    writeState(w, { pid: 5000, status: "busy" }, 5000);
    w.s.table = [{ pid: MAIN_PID, ppid: 1, rssKb: 0, cpu: 0 }];
    expect((await say()).status).toBe(200);
  });

  it("7: a state file that is a symlink is not read; a failed ps or agents fetch refuses", async () => {
    rmSync(path.join(w.CH, "sessions", `${MAIN_PID}.json`));
    writeFileSync(path.join(w.dir, "elsewhere.json"), JSON.stringify({ pid: MAIN_PID, status: "idle" }));
    symlinkSync(path.join(w.dir, "elsewhere.json"), path.join(w.CH, "sessions", `${MAIN_PID}.json`));
    await expectRefused("state_file_unreadable");
    rmSync(path.join(w.CH, "sessions", `${MAIN_PID}.json`));
    writeState(w, { pid: MAIN_PID, status: "idle" });
    w.s.table = null;
    await expectRefused("process_list_unavailable");
    w.s.table = [{ pid: MAIN_PID, ppid: 1, rssKb: 0, cpu: 0 }];
    w.s.rows = null;
    await expectRefused("agents_unavailable");
  });

  it("7: an agents row for a descendant must also be idle without waitingFor; no row means the state file decides", () => {
    const state = { filePid: 7, pid: 7, status: "idle", waitKeys: [] };
    const pids = new Set([7]);
    expect(caseSayVerdict({ state, pids, rows: [] })).toEqual({ ok: true });
    expect(caseSayVerdict({ state, pids, rows: [{ pid: 99, status: "busy" }] })).toEqual({ ok: true });
    expect(caseSayVerdict({ state, pids, rows: [{ pid: 7, status: "idle" }] })).toEqual({ ok: true });
    expect(caseSayVerdict({ state, pids, rows: [{ pid: 7, status: "waiting" }] })).toEqual({ ok: false, reason: "claude_not_idle" });
    expect(caseSayVerdict({ state, pids, rows: [{ pid: 7, status: "idle", waitingFor: "approve" }] })).toEqual({ ok: false, reason: "claude_not_idle" });
    expect(caseSayVerdict({ state: undefined, pids, rows: [] })).toEqual({ ok: false, reason: "state_file_unreadable" });
  });

  it("8: refuses when the write mark is already taken", async () => {
    expect(w.hub.tryBeginWrite(CASE_ID)).toBe(true);
    await expectRefused("write_in_progress");
    w.hub.endWrite(CASE_ID);
    expect((await say()).status).toBe(200);
  });

  // 貼り付けを書いた後の各終わり方: Enter 0 回か印あり、次の呼び出しが 409
  const afterPaste: Array<{ name: string; setup: () => void; reason: string; enters: number }> = [
    { name: "the paste itself is not written", setup: () => { w.s.sendResults = [{ written: false, reason: "not_written" }]; }, reason: "pane_changed_during_paste", enters: 0 },
    { name: "the paste throws", setup: () => { w.s.sendThrows = true; }, reason: "exception", enters: 0 },
    { name: "the window exits during the wait", setup: () => { w.s.onSleep = () => { w.s.exited = true; }; }, reason: "state_changed_before_enter", enters: 0 },
    { name: "the window starts closing during the wait", setup: () => { w.s.onSleep = () => { w.s.closing = true; }; }, reason: "state_changed_before_enter", enters: 0 },
    { name: "the main process changes during the wait", setup: () => { w.s.onSleep = () => { w.s.lstart = "Thu Nov  6 00:00:00 2026"; }; }, reason: "state_changed_before_enter", enters: 0 },
    { name: "the pane number changes during the wait", setup: () => { w.s.onSleep = () => { w.s.pane = { paneId: "%22", panePid: MAIN_PID, windows: 1, panes: 1 }; }; }, reason: "state_changed_before_enter", enters: 0 },
    { name: "claude stops being idle during the wait", setup: () => { w.s.onSleep = () => writeState(w, { pid: MAIN_PID, status: "busy" }); }, reason: "state_changed_before_enter", enters: 0 },
    { name: "claude starts waiting during the wait", setup: () => { w.s.onSleep = () => writeState(w, { pid: MAIN_PID, status: "idle", waitingFor: "x" }); }, reason: "state_changed_before_enter", enters: 0 },
    { name: "the conditional Enter reads NO", setup: () => { w.s.sendResults = [{ written: true }, { written: false, reason: "not_written" }]; }, reason: "enter_not_sent", enters: 1 },
    { name: "the conditional Enter has no response", setup: () => { w.s.sendResults = [{ written: true }, { written: false, reason: "no_response" }]; }, reason: "enter_not_sent", enters: 1 },
    { name: "the pane pid differs after sending", setup: () => { w.s.queryPid = 9999; }, reason: "enter_not_confirmed", enters: 1 },
    { name: "the pane pid cannot be read after sending", setup: () => { w.s.queryPid = null; }, reason: "enter_not_confirmed", enters: 1 },
  ];
  for (const c of afterPaste) {
    it(`9: when ${c.name}: Enter is sent ${c.enters} time(s) at most and the next call is a 409 stop`, async () => {
      c.setup();
      // Hub は例外をそのまま投げる（受け口が 409 exception にする）。止めの印は finally で付く
      const r = await say().catch(() => ({ status: 409, reason: "exception" }));
      expect(r.status).toBe(409);
      expect(r.reason).toBe(c.reason);
      expect(w.sends.filter((x) => x.data === "\r")).toHaveLength(c.enters);
      expect(w.sends[0].data.startsWith(PASTE_START)).toBe(true);
      expect(w.hub.writing.has(CASE_ID)).toBe(false);
      // 次の呼び出し: 状態を直しても 409（印）。何も書かない
      w.s.exited = false;
      w.s.closing = false;
      w.s.lstart = "Wed Nov  5 10:00:00 2026";
      w.s.pane = { paneId: PANE, panePid: MAIN_PID, windows: 1, panes: 1 };
      writeState(w, { pid: MAIN_PID, status: "idle" });
      w.s.sendThrows = false;
      w.s.sendResults = [];
      w.s.queryPid = MAIN_PID;
      w.s.onSleep = () => undefined;
      w.sends.length = 0;
      await expectRefused("stopped_after_paste");
    });
  }

  it("5: the stop mark goes away when the window is replaced by a new one or the item is removed from the list", async () => {
    w.s.sendResults = [{ written: false, reason: "not_written" }];
    await say();
    w.sends.length = 0;
    await expectRefused("stopped_after_paste");
    for (const l of w.removed) l(CASE_ID);
    expect((await say()).status).toBe(200);
  });

  it("a refusal before the paste leaves no stop mark", async () => {
    writeState(w, { pid: MAIN_PID, status: "busy" });
    await expectRefused("claude_not_idle");
    writeState(w, { pid: MAIN_PID, status: "idle" });
    expect((await say()).status).toBe(200);
  });
});

describe("K42: the claude version must be in the allowed list (4b)", () => {
  it("refuses with claude_version_unverified and writes nothing when the version is not in the list, not a version shape, or the list is the default []", async () => {
    w.s.real = "/x/claude/versions/2.1.319";
    const r1 = await say();
    expect(r1).toMatchObject({ status: 409, reason: "claude_version_unverified", claudeVersion: "2.1.319" });
    for (const real of ["/x/bin/claude", "/x/versions/2.1", "/x/versions/2.1.318-beta", "/x/versions/v2.1.318", "/x/versions/2.1.318.1", undefined]) {
      w.s.real = real;
      const r = await say();
      expect(r, String(real)).toMatchObject({ status: 409, reason: "claude_version_unverified", claudeVersion: "" });
    }
    expect(w.sends).toHaveLength(0);
    rmSync(w.dir, { recursive: true, force: true });
    w = makeWorld({ versions: [] });
    expect(await say()).toMatchObject({ status: 409, reason: "claude_version_unverified", claudeVersion: "2.1.318" });
    expect(w.sends).toHaveLength(0);
  });

  it("passes on to judgement 5 and later when the version is in the list; an earlier refusal carries no version field", async () => {
    expect((await say()).status).toBe(200);
    w.s.pane = null;
    const early = await say();
    expect(early.reason).toBe("pane_unreadable");
    expect("claudeVersion" in early).toBe(false);
  });
});

describe("config: caseSayRoles and caseSayClaudeVersions", () => {
  const base = {
    port: 4319,
    salesanchorRoot: "~/salesanchor",
    newWorktreeScript: "scripts/new-worktree.sh",
    ledgerLookupScript: "scripts/ledger-lookup.sh",
    ledgerDir: ".claude-pipeline/active-work.d",
    claudeBin: "claude",
    agentsPollMs: 3000,
    ledgerPollMs: 60000,
    ringBufferBytes: 1048576,
    roles: [
      { id: "opus-designer", labelKey: "role.opus", command: ["/bin/zsh", "-i"], needsWorktree: false },
      { id: "discord-case", labelKey: "role.shell", command: ["/bin/zsh", "-i"], needsWorktree: false, reservable: false, caseSandbox: true },
    ],
  };
  it("defaults: caseSayRoles is [opus-designer] and the code default for the version list is empty", () => {
    const c = parseConfig(base);
    expect(c.caseSayRoles).toEqual(["opus-designer"]);
    expect(c.caseSayClaudeVersions).toEqual([]);
  });
  it("a role id that is not in roles, or a case role, is a startup error", () => {
    expect(() => parseConfig({ ...base, caseSayRoles: ["nope"] })).toThrow(/caseSayRoles has unknown role id nope/);
    expect(() => parseConfig({ ...base, caseSayRoles: ["discord-case"] })).toThrow(/caseSandbox.*caseSayRoles/);
    expect(() => parseConfig({ ...base, caseSayRoles: "opus-designer" })).toThrow(/caseSayRoles/);
  });
  it("an element of caseSayClaudeVersions that is not a version shape is a startup error", () => {
    expect(parseConfig({ ...base, caseSayClaudeVersions: ["2.1.318", "10.0.1"] }).caseSayClaudeVersions).toEqual(["2.1.318", "10.0.1"]);
    for (const bad of ["2.1", "v2.1.318", "2.1.318-beta", "", " 2.1.318", "../2.1.318", 2, null]) {
      expect(() => parseConfig({ ...base, caseSayClaudeVersions: [bad] }), String(bad)).toThrow(/caseSayClaudeVersions/);
    }
    expect(() => parseConfig({ ...base, caseSayClaudeVersions: "2.1.318" })).toThrow(/caseSayClaudeVersions/);
  });
  it("the shipped agent-console.config.json allows 2.1.318", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect(shipped.caseSayClaudeVersions).toEqual(["2.1.318", "2.1.319"]);
  });
});

// ---------------------------------------------------------------- 受け口（実 HTTP・Hub.caseSay は差し替え）と監査

interface Reply { status: number; json: Record<string, unknown> }
const send = (port: number, method: string, headers: Record<string, string>, body?: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: "/api/agent/case-say", headers: { Host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 本文なし */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

describe("K31/K34: POST /api/agent/case-say and the audit", () => {
  let h: Harness;
  const auth = { Authorization: `Bearer ${RESERVE_TOKEN}` };
  const audit = (): Array<Record<string, unknown>> => {
    try { return readFileSync(path.join(h.config.dataDir, "routine-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  const lastAudit = (): Record<string, unknown> => audit().at(-1) as Record<string, unknown>;
  const body = (over: Record<string, unknown> = {}): string => JSON.stringify({ caseId: CASE_ID, stepFile: STEP, callerSessionId: CALLER, ...over });
  let spy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    h = await startHarness({ caseSayRoles: ["echo"] });
    const caller = await h.sessions.create({ name: "designer", roleId: "echo" });
    h.sessions.setClaudeSessionId(caller.id, CALLER);
  });
  afterAll(async () => { await h.close(); });
  beforeEach(() => {
    spy = vi.spyOn(h.hub, "caseSay").mockResolvedValue({ status: 200, claudeVersion: "2.1.318", textSha16: "a".repeat(16), stepSha16: "b".repeat(16) });
  });
  afterEach(() => spy.mockRestore());

  it("1: non-POST is 405, an Origin header is 403, a missing or wrong token is 401 (nothing is sent)", async () => {
    expect((await send(h.port, "GET", auth)).status).toBe(405);
    expect((await send(h.port, "POST", { ...auth, Origin: "http://evil.example" }, body())).status).toBe(403);
    expect((await send(h.port, "POST", {}, body())).status).toBe(401);
    expect((await send(h.port, "POST", { Authorization: `Bearer ${"0".repeat(64)}` }, body())).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("2: a bad body (not JSON, over 4KiB, bad caseId, bad stepFile) is 400 and nothing is sent", async () => {
    expect((await send(h.port, "POST", auth, "not json")).status).toBe(400);
    expect((await send(h.port, "POST", auth, body({ pad: "x".repeat(5000) }))).status).toBe(400);
    expect((await send(h.port, "POST", auth, body({ caseId: "../x" }))).status).toBe(400);
    for (const stepFile of ["a.txt", "../a.md", "a..b.md", "a/b.md", ".md", `${"a".repeat(65)}.md`, "a b.md", 5]) {
      expect((await send(h.port, "POST", auth, body({ stepFile }))).status, String(stepFile)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ action: "caseSayRefused", outcome: "denied", reason: "bad_request" });
  });

  it("3: a caller that is not a caseSayRoles session is 403 and nothing is sent", async () => {
    expect((await send(h.port, "POST", auth, body({ callerSessionId: undefined }))).status).toBe(403);
    expect((await send(h.port, "POST", auth, body({ callerSessionId: "33333333-3333-4333-8333-333333333333" }))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ action: "caseSayRefused", reason: "forbidden_caller", caseId: CASE_ID, stepFile: STEP });
  });

  it("a role that is not in caseSayRoles is refused even if it can reserve", async () => {
    const h2 = await startHarness({ caseSayRoles: [], reserveRoles: ["echo"] });
    try {
      const c = await h2.sessions.create({ name: "r", roleId: "echo" });
      h2.sessions.setClaudeSessionId(c.id, CALLER);
      expect((await send(h2.port, "POST", auth, body())).status).toBe(403);
    } finally { await h2.close(); }
  });

  it("K34: a send writes one caseSay line with the ids, the roles and both hashes, and no body or token", async () => {
    const before = audit().length;
    const r = await send(h.port, "POST", auth, body());
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({ caseId: CASE_ID, stepFile: STEP });
    const lines = audit().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "caseSay", outcome: "ok", callerSessionId: CALLER, roleId: "echo", caseId: CASE_ID, stepFile: STEP, claudeVersion: "2.1.318", textSha16: "a".repeat(16), stepSha16: "b".repeat(16) });
    expect(JSON.stringify(lines)).not.toContain(RESERVE_TOKEN);
  });

  it("K34: each refusal writes one caseSayRefused line with the reason; a refusal before 4b has no version field", async () => {
    spy.mockResolvedValue({ status: 409, reason: "pane_changed" });
    let before = audit().length;
    const r = await send(h.port, "POST", auth, body());
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("pane_changed");
    let lines = audit().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "caseSayRefused", outcome: "denied", reason: "pane_changed", callerSessionId: CALLER, caseId: CASE_ID, stepFile: STEP });
    expect("claudeVersion" in lines[0]).toBe(false);
    spy.mockResolvedValue({ status: 409, reason: "claude_version_unverified", claudeVersion: "" });
    before = audit().length;
    expect((await send(h.port, "POST", auth, body())).status).toBe(409);
    lines = audit().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "caseSayRefused", reason: "claude_version_unverified", claudeVersion: "" });
  });

  it("an exception inside the send is a 409 with an audit line (the hub keeps its stop mark)", async () => {
    spy.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = audit().length;
    const r = await send(h.port, "POST", auth, body());
    err.mockRestore();
    expect(r.status).toBe(409);
    expect(audit().slice(before)).toHaveLength(1);
    expect(lastAudit()).toMatchObject({ action: "caseSayRefused", reason: "exception" });
  });

  it("with no token configured the route is always 401", async () => {
    const h3 = await startHarness({ reserve: { token: null } });
    try { expect((await send(h3.port, "POST", auth, body())).status).toBe(401); } finally { await h3.close(); }
  });
});

// ---------------------------------------------------------------- 命令 hooks/ac-case-say.mjs

describe("ac-case-say command", () => {
  let h: Harness;
  let dataDir: string;
  beforeAll(async () => {
    h = await startHarness({ caseSayRoles: ["echo"] });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ac-case-say-cmd-"));
    writeFileSync(path.join(dataDir, "reserve-token"), JSON.stringify({ port: h.port, token: RESERVE_TOKEN }));
    const caller = await h.sessions.create({ name: "designer", roleId: "echo" });
    h.sessions.setClaudeSessionId(caller.id, CALLER);
  });
  afterAll(async () => { await h.close(); rmSync(dataDir, { recursive: true, force: true }); });

  it("prints one line when sent and never prints the token", async () => {
    const spy = vi.spyOn(h.hub, "caseSay").mockResolvedValue({ status: 200 });
    const r = await runCommand({ argv: [CASE_ID, STEP], dataDir, callerSessionId: CALLER });
    spy.mockRestore();
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout + r.stderr).not.toContain(RESERVE_TOKEN);
  });

  it("prints the refusal reason on one line and exits 1", async () => {
    const spy = vi.spyOn(h.hub, "caseSay").mockResolvedValue({ status: 409, reason: "terminal_not_ready" });
    const r = await runCommand({ argv: [CASE_ID, STEP], dataDir, callerSessionId: CALLER });
    spy.mockRestore();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("409");
    expect(r.stderr).toContain("terminal_not_ready");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("takes the caller only from the environment value and is refused without it", async () => {
    const spy = vi.spyOn(h.hub, "caseSay").mockResolvedValue({ status: 200 });
    const r = await runCommand({ argv: [CASE_ID, STEP], dataDir });
    spy.mockRestore();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("403");
  });

  it("rejects a wrong number or shape of arguments before connecting", async () => {
    for (const argv of [[], [CASE_ID], [CASE_ID, STEP, "x"], ["nope", STEP], [CASE_ID, "../a.md"], [CASE_ID, "a.txt"], [CASE_ID, "a/b.md"]]) {
      const r = await runCommand({ argv, dataDir, callerSessionId: CALLER });
      expect(r.code, JSON.stringify(argv)).toBe(1);
      expect(r.stderr).toContain("使い方");
    }
  });

  it("fails with a reason (and no token) when dataDir/reserve-token is missing, broken, or the server is down", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "ac-case-say-cmd-"));
    expect((await runCommand({ argv: [CASE_ID, STEP], dataDir: empty, callerSessionId: CALLER })).stderr).toContain("reserve-token");
    writeFileSync(path.join(empty, "reserve-token"), "{bad");
    expect((await runCommand({ argv: [CASE_ID, STEP], dataDir: empty, callerSessionId: CALLER })).stderr).toContain("reserve-token");
    writeFileSync(path.join(empty, "reserve-token"), JSON.stringify({ port: 1, token: RESERVE_TOKEN }));
    const down = await runCommand({ argv: [CASE_ID, STEP], dataDir: empty, callerSessionId: CALLER });
    expect(down.code).toBe(1);
    expect(down.stderr).not.toContain(RESERVE_TOKEN);
    rmSync(empty, { recursive: true, force: true });
  });
});
