import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as caseAgents from "../../server/case-agents.ts";
import { CASE_SESSION_FILE_MAX, readCaseClaudeSessionId } from "../../server/case-agents.ts";
import { Hub } from "../../server/hub.ts";
import { SessionManager } from "../../server/sessions.ts";

vi.mock("../../server/case-agents.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../server/case-agents.ts")>();
  return { ...mod, readCaseClaudeSessionId: vi.fn(mod.readCaseClaudeSessionId) };
});

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ac-caseagents-"));
  home = path.join(tmp, "ch");
  mkdirSync(path.join(home, "sessions"), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const put = (pid: number, body: unknown, dir = path.join(home, "sessions")): string => {
  const p = path.join(dir, `${pid}.json`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const pids = (...n: number[]): Set<number> => new Set(n);

describe("readCaseClaudeSessionId", () => {
  it("returns the sessionId of a file whose pid is in the set", () => {
    put(101, { pid: 101, sessionId: ID1, extra: "x" });
    expect(readCaseClaudeSessionId(home, pids(101, 5))).toBe(ID1);
  });
  it("ignores a pid that is not in the set, and a name / content pid mismatch", () => {
    put(101, { pid: 101, sessionId: ID1 });
    expect(readCaseClaudeSessionId(home, pids(102))).toBeUndefined();
    put(103, { pid: 104, sessionId: ID1 });
    expect(readCaseClaudeSessionId(home, pids(103))).toBeUndefined();
  });
  it("does not follow a symlinked file or a symlinked sessions directory", () => {
    const real = path.join(tmp, "real.json");
    writeFileSync(real, JSON.stringify({ pid: 101, sessionId: ID1 }));
    symlinkSync(real, path.join(home, "sessions", "101.json"));
    expect(readCaseClaudeSessionId(home, pids(101))).toBeUndefined();
    const home2 = path.join(tmp, "ch2");
    mkdirSync(home2);
    const realDir = path.join(tmp, "realsessions");
    mkdirSync(realDir);
    put(101, { pid: 101, sessionId: ID1 }, realDir);
    symlinkSync(realDir, path.join(home2, "sessions"));
    expect(readCaseClaudeSessionId(home2, pids(101))).toBeUndefined();
  });
  it("returns at once for a named pipe and for a hard-linked file", () => {
    execFileSync("mkfifo", [path.join(home, "sessions", "101.json")]);
    expect(readCaseClaudeSessionId(home, pids(101))).toBeUndefined();
    const p = put(102, { pid: 102, sessionId: ID1 });
    linkSync(p, path.join(tmp, "other-link"));
    expect(readCaseClaudeSessionId(home, pids(102))).toBeUndefined();
  });
  it("rejects a file over 64KiB, non-JSON, and an id that is not a UUID", () => {
    put(101, JSON.stringify({ pid: 101, sessionId: ID1, pad: "x".repeat(CASE_SESSION_FILE_MAX) }));
    expect(readCaseClaudeSessionId(home, pids(101))).toBeUndefined();
    put(102, "not json {");
    expect(readCaseClaudeSessionId(home, pids(102))).toBeUndefined();
    put(103, { pid: 103, sessionId: "abc" });
    expect(readCaseClaudeSessionId(home, pids(103))).toBeUndefined();
  });
  it("never opens <pid>.<hex>.key and other names", () => {
    writeFileSync(path.join(home, "sessions", "101.abcdef.key"), "{ broken");
    expect(() => readCaseClaudeSessionId(home, pids(101))).not.toThrow();
    expect(readCaseClaudeSessionId(home, pids(101))).toBeUndefined();
  });
  it("returns undefined when sessions/ is missing, or two files disagree", () => {
    expect(readCaseClaudeSessionId(path.join(tmp, "none"), pids(101))).toBeUndefined();
    put(101, { pid: 101, sessionId: ID1 });
    put(102, { pid: 102, sessionId: ID2 });
    expect(readCaseClaudeSessionId(home, pids(101, 102))).toBeUndefined();
  });
});

// 実物の SessionManager の caseHomeOf / clearCaseClaudeSessionId / setClaudeSessionId を、最小の中身で動かす
interface FakeSession { id: string; roleId: string; exited: boolean; claudeSessionId?: string; term: { pid: number } }
function makeSessions(list: FakeSession[]): { mgr: SessionManager; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const ctx = {
    sessions: new Map(list.map((s) => [s.id, s])),
    config: { roles: [{ id: "case", caseSandbox: true }, { id: "plain" }], dataDir: path.join(tmp, "data") },
    caseHomeDir: path.join(tmp, "ch-root"),
    caseTmpRoot: path.join(tmp, "tmp-root"),
    notify,
  };
  const proto = SessionManager.prototype as unknown as Record<string, unknown>;
  const mgr = {
    list: () => list,
    caseHomeOf: (id: string) => (proto.caseHomeOf as (id: string) => unknown).call(ctx, id),
    clearCaseClaudeSessionId: (id: string) => (proto.clearCaseClaudeSessionId as (id: string) => unknown).call(ctx, id),
    setClaudeSessionId: (id: string, v: unknown) => (proto.setClaudeSessionId as (id: string, v: unknown) => unknown).call(ctx, id, v),
    onChange: () => undefined,
    onRemoved: () => undefined,
  };
  return { mgr: mgr as unknown as SessionManager, notify };
}

describe("case session id in the hub (real caseHomeOf / clear / set)", () => {
  const CASE = "c0000000-0000-4000-8000-000000000001";
  const PLAIN = "c0000000-0000-4000-8000-000000000002";
  const CASE_B = "c0000000-0000-4000-8000-000000000003";
  const mk = (list: FakeSession[], agents: Array<{ pid: number; status: string; sessionId?: string }> | null) => {
    const { mgr, notify } = makeSessions(list);
    const hub = new Hub({ notify: { macos: false } } as never, mgr, null);
    (hub as unknown as { agents: unknown }).agents = agents;
    const run = (): Promise<void> => (hub as unknown as { detectBreaks(): Promise<void> }).detectBreaks();
    const caseHome = (mgr as unknown as { caseHomeOf(id: string): string | undefined }).caseHomeOf(CASE);
    return { run, notify, caseHome };
  };
  const base = (): FakeSession[] => [
    { id: CASE, roleId: "case", exited: false, term: { pid: process.pid } },
    { id: PLAIN, roleId: "plain", exited: false, term: { pid: 0 } },
  ];

  it("caseHomeOf is undefined for a non-case or a stopped session, and a path for a live case", () => {
    const list = [...base(), { id: CASE_B, roleId: "case", exited: true, term: { pid: 0 } }];
    const { mgr } = makeSessions(list);
    const m = mgr as unknown as { caseHomeOf(id: string): string | undefined };
    expect(m.caseHomeOf(PLAIN)).toBeUndefined();
    expect(m.caseHomeOf(CASE_B)).toBeUndefined();
    expect(m.caseHomeOf(CASE)).toContain(CASE);
  });

  it("attaches the id from sessions/<pid>.json, but not while claude agents --json failed", async () => {
    const list = base();
    const t = mk(list, null);
    mkdirSync(path.join(t.caseHome as string, "sessions"), { recursive: true });
    put(process.pid, { pid: process.pid, sessionId: ID1 }, path.join(t.caseHome as string, "sessions"));
    await t.run();
    expect(list[0].claudeSessionId).toBeUndefined();
    const t2 = mk(list, []);
    await t2.run();
    expect(list[0].claudeSessionId).toBe(ID1);
  });

  it("does not attach an id another session or an agents row already has", async () => {
    const list = base();
    list[1].claudeSessionId = ID1;
    const t = mk(list, []);
    mkdirSync(path.join(t.caseHome as string, "sessions"), { recursive: true });
    put(process.pid, { pid: process.pid, sessionId: ID1 }, path.join(t.caseHome as string, "sessions"));
    await t.run();
    expect(list[0].claudeSessionId).toBeUndefined();
    list[1].claudeSessionId = undefined;
    const t2 = mk(list, [{ pid: 999999, status: "idle", sessionId: ID1 }]);
    await t2.run();
    expect(list[0].claudeSessionId).toBeUndefined();
  });

  it("drops an id (also a restored one) that another session or an agents row holds, and does not notify when there is none", async () => {
    const list = base();
    list[0].claudeSessionId = ID1;
    list[1].claudeSessionId = ID1;
    const t = mk(list, []);
    await t.run();
    expect(list[0].claudeSessionId).toBeUndefined();
    list[0].claudeSessionId = ID2;
    const t2 = mk(list, [{ pid: 999999, status: "idle", sessionId: ID2 }]);
    await t2.run();
    expect(list[0].claudeSessionId).toBeUndefined();
    t2.notify.mockClear();
    await t2.run();
    expect(t2.notify).not.toHaveBeenCalled();
  });

  it("when a non-case session learns the same id from an agents row, the case loses it (a case row never gets it)", async () => {
    const list = base();
    list[0].claudeSessionId = ID1;
    list[1].term.pid = process.pid + 100000;
    const t = mk(list, [{ pid: list[1].term.pid, status: "idle", sessionId: ID1 }]);
    await t.run();
    expect(list[1].claudeSessionId).toBe(ID1);
    expect(list[0].claudeSessionId).toBeUndefined();
    // a stopped case holding the same id is cleared too
    const list2 = [...base(), { id: CASE_B, roleId: "case", exited: true, claudeSessionId: ID1, term: { pid: 0 } } as FakeSession];
    list2[1].term.pid = process.pid + 100000;
    const t2 = mk(list2, [{ pid: list2[1].term.pid, status: "idle", sessionId: ID1 }]);
    await t2.run();
    expect(list2[2].claudeSessionId).toBeUndefined();
  });

  it("does not turn the state unknown when reading throws", async () => {
    const list = base();
    const t = mk(list, []);
    mkdirSync(path.join(t.caseHome as string, "sessions"), { recursive: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(caseAgents.readCaseClaudeSessionId).mockImplementationOnce(() => { throw new Error("boom"); });
    await expect(t.run()).resolves.toBeUndefined();
    expect(caseAgents.readCaseClaudeSessionId).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
