import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayManager, nextRelayName, resolveRelayDir, type RelayTiming, type RelayView } from "../../server/relay.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError } from "../../server/sessions.ts";

describe("K8 nextRelayName", () => {
  const n = (display: string, app = "app") => nextRelayName(display, app);
  it("増やす・付ける", () => {
    expect(n("設計 09/15 10:30")).toBe("設計 09/15 10:30 2");
    expect(n("設計 09/15 10:30 2")).toBe("設計 09/15 10:30 3");
    expect(n("Agent Console2")).toBe("Agent Console3");
    expect(n("v9")).toBe("v10");
    expect(n("x009")).toBe("x010");
    expect(n("設計")).toBe("設計2");
    expect(n("設計２")).toBe("設計２2");
  });
  it("40 字を超えるときは数字より前を縮める。絵文字を途中で切らない", () => {
    const long = n("あ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("2")).toBe(true);
    const emoji = n("😀".repeat(20) + "9");
    expect(emoji.length).toBeLessThanOrEqual(40);
    expect(emoji.endsWith("10")).toBe(true);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
  it("制御文字は除いて扱い、空になればアプリ側の名前", () => {
    expect(n("設計\u001b[31m3")).toBe("設計[31m4");
    expect(n("\u001b\u0007", "アプリ")).toBe("アプリ2");
    expect(n("   ", "アプリ5")).toBe("アプリ6");
  });
});

describe("resolveRelayDir", () => {
  it("config が優先。無ければポート未指定のときだけ既定", () => {
    expect(resolveRelayDir({ relayDir: "/x" }, { AGENT_CONSOLE_PORT: "1" })).toBe("/x");
    expect(resolveRelayDir({}, { AGENT_CONSOLE_PORT: "4400" })).toBeNull();
    expect(resolveRelayDir({}, {})).toBe(path.join(os.homedir(), "CC報告ファイル-keep", "relay"));
    expect(resolveRelayDir({}, { AGENT_CONSOLE_PORT: "" })).toBe(path.join(os.homedir(), "CC報告ファイル-keep", "relay"));
  });
});

type Verdict = { ok: boolean; hasClaude: boolean; reason?: string };
const TIMING: RelayTiming = { pollMs: 5, quietMs: 60, readyPollMs: 5, readyTimeoutMs: 100, namePollMs: 5, nameTimeoutMs: 20, handoffTimeoutMs: 400, doneKeepMs: 40 };
const OLD_ID = "abcdef12-0000-4000-8000-000000000001";
const NOW = () => new Date("2026-10-14T00:00:00.000Z"); // 09:00:00 JST

interface FakeSession { id: string; name: string; roleId: string; cwd: string; branch: string | null; exited: boolean }

const setup = async (opts: { noRelayDir?: boolean; capacity?: boolean | (() => boolean); restoreThrows?: Error; role?: string; oldExited?: boolean; pending?: boolean; oldName?: string } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ac-relay-"));
  const relayDir = path.join(root, "relay");
  const old: FakeSession = { id: OLD_ID, name: "設計 5", roleId: opts.role ?? "echo", cwd: "/work/tree", branch: "feat/x", exited: opts.oldExited ?? false };
  const all: FakeSession[] = [old];
  const sessions = {
    get: vi.fn((id: string) => all.find((s) => s.id === id)),
    hasCapacity: vi.fn(() => (typeof opts.capacity === "function" ? opts.capacity() : opts.capacity ?? true)),
    restore: vi.fn((input: { role: { id: string }; name: string; cwd: string; branch: string | null; manualInitialName?: boolean }) => {
      if (opts.restoreThrows) throw opts.restoreThrows;
      const s: FakeSession = { id: `new-${all.length}`, name: input.name, roleId: "echo", cwd: input.cwd, branch: input.branch, exited: false };
      all.push(s);
      return s;
    }),
  };
  const calls: string[] = [];
  const state = { oldVerdict: { ok: true, hasClaude: true } as Verdict, newVerdict: { ok: true, hasClaude: true } as Verdict, peekOk: true, submitOld: true, submitNew: true, sendName: true, names: new Map<string, string>(), relays: [] as RelayView[][] };
  const hub = {
    checkInput: vi.fn(async (id: string) => (id === OLD_ID ? state.oldVerdict : state.newVerdict)),
    peekInput: vi.fn(async () => ({ ok: state.peekOk, hasClaude: state.peekOk })),
    submitText: vi.fn(async (id: string, text: string) => { calls.push(`submit:${id}:${text}`); return id === OLD_ID ? state.submitOld : state.submitNew; }),
    sendName: vi.fn((id: string, name: string) => { calls.push(`name:${id}:${name}`); if (state.sendName) state.names.set(id, name); return state.sendName; }),
    displayNames: vi.fn(() => (opts.oldName ? new Map([[OLD_ID, opts.oldName], ...state.names]) : state.names)),
    hasPendingWork: vi.fn(() => opts.pending ?? false),
    setRelays: vi.fn((r: RelayView[]) => { state.relays.push(JSON.parse(JSON.stringify(r)) as RelayView[]); }),
  };
  const config = { roles: [{ id: "echo", needsWorktree: false, command: ["echo"] }, { id: "account-login", needsWorktree: false, command: ["x"] }] };
  const manager = new RelayManager({ config: config as never, sessions: sessions as never, hub: hub as never, relayDir: opts.noRelayDir ? null : relayDir }, NOW, TIMING);
  return { manager, sessions, hub, state, calls, relayDir, root, old, all };
};

const folderOf = async (relayDir: string): Promise<string> => {
  const entries = await readdir(relayDir);
  expect(entries).toHaveLength(1);
  return path.join(relayDir, entries[0]);
};
const noFolder = async (relayDir: string): Promise<void> => {
  await expect(stat(relayDir)).rejects.toThrow();
};
let managers: RelayManager[] = [];
afterEach(() => { for (const m of managers) m.stop(); managers = []; vi.restoreAllMocks(); });
const track = <T extends { manager: RelayManager }>(x: T): T => { managers.push(x.manager); return x; };

describe("K9 RelayManager の流れ", () => {
  it("決まった順に進み、HANDOFF.md ができるまで launching に進まない。新しいセッションは古い cwd・branch・新しい名前・manualInitialName で開く", async () => {
    const t = track(await setup());
    const { relayId } = await t.manager.start(OLD_ID);
    const folder = await folderOf(t.relayDir);
    expect(path.basename(folder)).toBe("20261014-090000-abcdef12");
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(t.relayDir)).mode & 0o777).toBe(0o700);
    const file = path.join(folder, "HANDOFF.md");
    // 書き終わっていない間は進まない
    await new Promise((r) => setTimeout(r, 120));
    expect(t.sessions.restore).not.toHaveBeenCalled();
    expect(t.manager.list()[0]).toMatchObject({ relayId, phase: "handoff", oldName: "設計 5", newName: "設計 6" });
    expect(t.calls[0]).toContain(`submit:${OLD_ID}:`);
    expect(t.calls[0]).toContain(file);
    await writeFile(file, "# 引き継ぎ\n");
    await t.manager.settled();
    expect(t.sessions.restore).toHaveBeenCalledTimes(1);
    expect(t.sessions.restore.mock.calls[0][0]).toMatchObject({ name: "設計 6", cwd: "/work/tree", branch: "feat/x", manualInitialName: true });
    expect(t.sessions.restore.mock.calls[0][0].role.id).toBe("echo");
    expect((t.sessions.restore.mock.calls[0][0] as unknown as { claudeSessionId?: string }).claudeSessionId).toBeUndefined();
    expect(t.calls[1]).toBe("name:new-1:設計 6");
    expect(t.calls[2]).toContain("submit:new-1:");
    expect(t.calls[2]).toContain(file);
    expect(t.calls[2]).toContain("「設計 5」");
    expect(t.manager.list()[0]).toMatchObject({ phase: "done", newSessionId: "new-1" });
    expect(t.old.exited).toBe(false);
    const phases = t.state.relays.map((r) => r[0].phase).filter((p, k, a) => k === 0 || a[k - 1] !== p);
    expect(phases).toEqual(["handoff", "launching", "sending", "done"]);
  });

  it("作業中を一度も見ないまま quietMs 過ぎたら完了する（書き終えが早かった道）", async () => {
    const t = track(await setup());
    await t.manager.start(OLD_ID);
    const folder = await folderOf(t.relayDir);
    await writeFile(path.join(folder, "HANDOFF.md"), "x");
    await t.manager.settled();
    expect(t.manager.list()[0].phase).toBe("done");
  });

  it("作業中を一度見て、手すきに戻ったら quietMs を待たずに完了する", async () => {
    const t = track(await setup());
    await t.manager.start(OLD_ID);
    const folder = await folderOf(t.relayDir);
    await writeFile(path.join(folder, "HANDOFF.md"), "x");
    t.state.peekOk = false;
    await new Promise((r) => setTimeout(r, 20));
    t.state.peekOk = true;
    const started = Date.now();
    await t.manager.settled();
    expect(t.manager.list()[0].phase).toBe("done");
    expect(Date.now() - started).toBeLessThan(TIMING.quietMs);
  });

  it("done・failed の記録は doneKeepMs 後に消える", async () => {
    const t = track(await setup({ capacity: false }));
    // start の時点では空きが必要なので、受け付け後に塞ぐ
    let calls = 0;
    t.sessions.hasCapacity.mockImplementation(() => ++calls <= 1);
    await t.manager.start(OLD_ID);
    await writeFile(path.join(await folderOf(t.relayDir), "HANDOFF.md"), "x");
    await t.manager.settled();
    expect(t.manager.list()[0]).toMatchObject({ phase: "failed", reason: "full" });
    await new Promise((r) => setTimeout(r, TIMING.doneKeepMs + 40));
    expect(t.manager.list()).toEqual([]);
  });

  it("古い名前の制御文字は新しい側の文に入れない", async () => {
    const t = track(await setup({ oldName: "設計\u001b[31m 5" }));
    await t.manager.start(OLD_ID);
    await writeFile(path.join(await folderOf(t.relayDir), "HANDOFF.md"), "x");
    await t.manager.settled();
    const last = t.calls[t.calls.length - 1];
    expect(last).toContain("「設計[31m 5」");
    expect(last).not.toContain("\u001b");
  });
});

describe("K10 失敗", () => {
  const rejects = async (p: Promise<unknown>, cls: new (m: string) => Error, msg: string) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(cls);
    expect((e as Error).message).toBe(msg);
  };

  it("409 の各条件ではフォルダを作らない", async () => {
    const cases: [string, Parameters<typeof setup>[0], (t: Awaited<ReturnType<typeof setup>>) => void][] = [
      ["relay not configured", { noRelayDir: true }, () => undefined],
      ["session is stopped", { oldExited: true }, () => undefined],
      ["role cannot relay", { role: "account-login" }, () => undefined],
      ["role cannot relay", { role: "ghost" }, () => undefined],
      ["pending work", { pending: true }, () => undefined],
      ["too many sessions", { capacity: false }, () => undefined],
      ["not idle", {}, (t) => { t.state.oldVerdict = { ok: false, hasClaude: true }; }],
      ["not idle", {}, (t) => { t.state.oldVerdict = { ok: true, hasClaude: false }; }],
    ];
    for (const [message, opts, tweak] of cases) {
      const t = track(await setup(opts));
      tweak(t);
      await rejects(t.manager.start(OLD_ID), SessionConflictError, message);
      await noFolder(t.relayDir);
      expect(t.hub.submitText).not.toHaveBeenCalled();
    }
  });

  it("無いセッションは 404 相当", async () => {
    const t = track(await setup());
    await rejects(t.manager.start("nope"), SessionNotFoundError, "session not found");
    await noFolder(t.relayDir);
  });

  it("進行中の古い側・新しい側は relay in progress", async () => {
    const t = track(await setup());
    await t.manager.start(OLD_ID);
    await rejects(t.manager.start(OLD_ID), SessionConflictError, "relay in progress");
    await writeFile(path.join(await folderOf(t.relayDir), "HANDOFF.md"), "x");
    await t.manager.settled();
    // 完了後は同じセッションからもう一度始められる（新しいフォルダ）
    expect(t.manager.list()[0].phase).toBe("done");
  });

  it("同時の 2 回の開始は片方だけが通る", async () => {
    const t = track(await setup());
    const results = await Promise.allSettled([t.manager.start(OLD_ID), t.manager.start(OLD_ID)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await readdir(t.relayDir)).toHaveLength(1);
  });

  const runToEnd = async (t: Awaited<ReturnType<typeof setup>>, write = true) => {
    await t.manager.start(OLD_ID);
    if (write) await writeFile(path.join(await folderOf(t.relayDir), "HANDOFF.md"), "x");
    await t.manager.settled();
    return t.manager.list()[0];
  };

  it("send_failed（手順1）", async () => {
    const t = track(await setup());
    t.state.submitOld = false;
    expect(await runToEnd(t, false)).toMatchObject({ phase: "failed", reason: "send_failed" });
    expect(t.sessions.restore).not.toHaveBeenCalled();
  });

  it("send_failed（手順5）。開いたセッションは残る", async () => {
    const t = track(await setup());
    t.state.submitNew = false;
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "send_failed", newSessionId: "new-1" });
  });

  it("handoff_timeout は新しいセッションを開かない（ファイルが途中まであっても）", async () => {
    const t = track(await setup());
    t.state.peekOk = false;
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "handoff_timeout" });
    expect(t.sessions.restore).not.toHaveBeenCalled();
  });

  it("gone: 古いセッションが終了したら止まる", async () => {
    const t = track(await setup());
    await t.manager.start(OLD_ID);
    t.old.exited = true;
    await t.manager.settled();
    expect(t.manager.list()[0]).toMatchObject({ phase: "failed", reason: "gone" });
  });

  it("full: hasCapacity が false", async () => {
    const t = track(await setup());
    let n = 0;
    t.sessions.hasCapacity.mockImplementation(() => ++n <= 1);
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "full" });
    expect(t.sessions.restore).not.toHaveBeenCalled();
  });

  it("full: restore が too many sessions を投げる", async () => {
    const t = track(await setup({ restoreThrows: new SessionInputError("too many sessions") }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "full" });
  });

  it("start_failed: restore がそれ以外を投げる", async () => {
    const t = track(await setup({ restoreThrows: new Error("boom") }));
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "start_failed" });
  });

  it("not_ready（手順4）。開いたセッションは残る", async () => {
    const t = track(await setup());
    const orig = t.hub.checkInput.getMockImplementation() as (id: string) => Promise<Verdict>;
    t.hub.checkInput.mockImplementation(async (id: string) => (id === OLD_ID ? orig(id) : { ok: false, hasClaude: true }));
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "not_ready", newSessionId: "new-1" });
    expect(t.hub.submitText).toHaveBeenCalledTimes(1);
  });

  it("not_ready（手順5。名前の後に入力待ちに戻らない）", async () => {
    const t = track(await setup());
    t.hub.checkInput.mockImplementation(async (id: string) => {
      if (id === OLD_ID) return { ok: true, hasClaude: true };
      return t.hub.sendName.mock.calls.length > 0 ? { ok: false, hasClaude: true } : { ok: true, hasClaude: true };
    });
    expect(await runToEnd(t)).toMatchObject({ phase: "failed", reason: "not_ready", newSessionId: "new-1" });
    expect(t.hub.submitText).toHaveBeenCalledTimes(1);
  });
});
