import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleConfig } from "../../server/config.ts";
import { OPEN_SESSIONS_FILE } from "../../server/session-store.ts";
import { isRestoreEnabled, restoreOnStartup, startOpenSessionRestore, type RestoreNotice } from "../../server/restore.ts";
import { descendantPids, readProcessTable } from "../../server/process-tree.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const BAD_ID = "11111111-1111-4111-8111-11111111111$(touch /tmp/pwned)";

const CLOSE_GRACE_MS = 600;
const STAGGER_MS = 250;
/** SIGHUP だけで閉じる経路の確認用。SIGKILL への切替（この猶予の後）に入ったかどうかを、負荷下の遅れと区別できる大きさにする */
const SIGHUP_ONLY_GRACE_MS = 10000;
/** 端末（pty）の出力・子プロセスの出現を待つ時間。既定の 1000ms は負荷で足りない */
const WAIT = { timeout: 5000 };
/** 負荷下で遅れうる試験の全体の上限 */
const SLOW_TEST_MS = 30000;
// 端末の起動を待つ試験は、負荷下で既定の 5000ms では足りない。このファイル全体に適用する
vi.setConfig({ testTimeout: SLOW_TEST_MS });

/** 復元の試験用の役割: 通常の起動と、復元の起動（AC_RESUME_ID を環境変数で受ける）を出力で区別する */
const EXTRA_ROLES: RoleConfig[] = [
  {
    id: "restorable",
    labelKey: "role.opusDesigner",
    command: ["/bin/sh", "-c", "echo FRESH cwd=$PWD id=[$AC_RESUME_ID]; cat"],
    restoreCommand: ["/bin/sh", "-c", "echo RESTORED cwd=$PWD id=[$AC_RESUME_ID]; cat"],
    needsWorktree: false,
  },
  // SIGHUP と SIGTERM を無視して居座る端末（SIGKILL に切り替わる）
  { id: "stubborn", labelKey: "role.shell", command: ["/bin/sh", "-c", "trap '' HUP TERM; sleep 300 & wait"], needsWorktree: false },
  // 端末（sh）は SIGHUP で終わるが、子の sleep は SIGHUP を無視して残る
  { id: "leaky", labelKey: "role.shell", command: ["/bin/sh", "-c", "(trap '' HUP; exec sleep 300) & wait"], needsWorktree: false },
];

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(h: Harness, method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function newSession(h: Harness, roleId: string, name: string): Promise<string> {
  const res = await api(h, "POST", "/api/sessions", { name, roleId });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

const fileOf = (h: Harness): string => path.join(h.config.dataDir, OPEN_SESSIONS_FILE);
const readList = (h: Harness): { version: number; items: Array<Record<string, unknown>> } => JSON.parse(readFileSync(fileOf(h), "utf8"));
const putFile = (h: Harness, content: string): void => {
  mkdirSync(h.config.dataDir, { recursive: true });
  writeFileSync(fileOf(h), content);
};
const writeList = (h: Harness, items: unknown[]): void => putFile(h, JSON.stringify({ version: 1, items }));
const sessionOf = (h: Harness, id: string) => h.sessions.get(id) as NonNullable<ReturnType<Harness["sessions"]["get"]>>;
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 試験が失敗しても、その試験が作ったセッションを後続の試験へ残さない */
async function closeAllSessions(h: Harness): Promise<void> {
  for (const s of [...h.sessions.list()]) await h.sessions.close(s.id).catch(() => undefined);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("close a running session (K1, SIGHUP path)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ recorder: true, closeGraceMs: SIGHUP_ONLY_GRACE_MS, extraRoles: EXTRA_ROLES });
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(async () => {
    await closeAllSessions(h);
  });

  it("ends the terminal process and removes the row from the list", async () => {
    const id = await newSession(h, "echo", "closing");
    const pid = sessionOf(h, id).term.pid;
    await vi.waitFor(() => expect(sessionOf(h, id).ring.snapshot()).toContain("READY"), WAIT);
    const started = Date.now();
    const res = await api(h, "POST", `/api/sessions/${id}/close`);
    expect(res.status).toBe(200);
    // SIGHUP で終わるので、SIGKILL への切替（猶予）を待たない。猶予は 10 秒なので、負荷で数百 ms 遅れても、猶予まで待った（SIGKILL の経路に入った）場合とは区別できる
    expect(Date.now() - started).toBeLessThan(SIGHUP_ONLY_GRACE_MS);
    expect(h.sessions.get(id)).toBeUndefined();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), WAIT);
    const state = await api(h, "GET", "/api/state");
    expect((state.json.sessions as Array<{ id: string }>).some((s) => s.id === id)).toBe(false);
  }, SLOW_TEST_MS);
});

describe("close a running session (K1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ recorder: true, closeGraceMs: CLOSE_GRACE_MS, extraRoles: EXTRA_ROLES });
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(async () => {
    await closeAllSessions(h);
  });

  it("removes a stopped session like the existing remove, and returns 404 for an unknown id", async () => {
    const id = await newSession(h, "short", "already-stopped");
    await vi.waitFor(() => expect(sessionOf(h, id).exited).toBe(true), WAIT);
    expect((await api(h, "POST", `/api/sessions/${id}/close`)).status).toBe(200);
    expect(h.sessions.get(id)).toBeUndefined();
    expect((await api(h, "POST", `/api/sessions/${id}/close`)).status).toBe(404);
  });

  it("sends SIGKILL after the grace period to a terminal that ignores SIGHUP, and leaves no descendant process", async () => {
    const id = await newSession(h, "stubborn", "stubborn");
    const session = sessionOf(h, id);
    await vi.waitFor(async () => expect(descendantPids(session.term.pid, await readProcessTable()).size).toBeGreaterThan(1), WAIT);
    const family = [...descendantPids(session.term.pid, await readProcessTable())];
    const started = Date.now();
    expect((await api(h, "POST", `/api/sessions/${id}/close`)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 50);
    await vi.waitFor(() => expect(family.filter(isAlive)).toEqual([]), { timeout: 3000 });
  }, SLOW_TEST_MS);

  it("kills a descendant that survives the terminal's exit (SIGHUP ignored by the child)", async () => {
    const id = await newSession(h, "leaky", "leaky");
    const session = sessionOf(h, id);
    await vi.waitFor(async () => expect(descendantPids(session.term.pid, await readProcessTable()).size).toBeGreaterThan(1), WAIT);
    const family = [...descendantPids(session.term.pid, await readProcessTable())];
    expect((await api(h, "POST", `/api/sessions/${id}/close`)).status).toBe(200);
    await vi.waitFor(() => expect(family.filter(isAlive)).toEqual([]), { timeout: 3000 });
  }, SLOW_TEST_MS);

  it("requires authentication", async () => {
    const res = await fetch(`${h.base}/api/sessions/x/close`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("restore list contents (K2, K7)", () => {
  // 試験ごとに新しい harness（新しい dataDir）を使う。前の試験が残す記録の書き込みと競合させず、失敗しても後続へセッションを残さないため
  let h: Harness;
  beforeEach(async () => {
    const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-restore-stub-"));
    const rowsFile = path.join(stubDir, "rows.json");
    writeFileSync(rowsFile, "[]");
    const stub = path.join(stubDir, "claude-stub.sh");
    writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
    chmodSync(stub, 0o755);
    h = await startHarness({ recorder: true, claudeBin: stub, extraRoles: EXTRA_ROLES });
    (h as unknown as { rowsFile: string }).rowsFile = rowsFile;
  });
  afterEach(async () => {
    await h.close();
  });
  const setAgents = (rows: unknown[]): void => writeFileSync((h as unknown as { rowsFile: string }).rowsFile, JSON.stringify(rows));
  const settle = async (): Promise<void> => {
    await h.recorder.sync();
  };

  it("holds only running sessions, with role, name, cwd and branch, in a 600 file", async () => {
    const a = await newSession(h, "echo", "alpha");
    const b = await newSession(h, "short", "beta-ends");
    await vi.waitFor(() => expect(sessionOf(h, b).exited).toBe(true), WAIT);
    await settle();
    const list = readList(h);
    expect(list.version).toBe(1);
    expect(list.items).toEqual([{ roleId: "echo", name: "alpha", cwd: sessionOf(h, a).cwd }]);
    expect(statSync(fileOf(h)).mode & 0o777).toBe(0o600);
  });

  it("drops a session that ends by itself and one that is closed by hand", async () => {
    const c = await newSession(h, "echo", "to-close");
    await settle();
    expect(readList(h).items.map((i) => i.name)).toContain("to-close");
    await api(h, "POST", `/api/sessions/${c}/close`);
    await vi.waitFor(() => expect(readList(h).items.map((i) => i.name)).not.toContain("to-close"));
    const d = await newSession(h, "echo", "to-exit");
    await settle();
    sessionOf(h, d).term.write("\x04"); // Ctrl+D: 自分で終わる
    await vi.waitFor(() => expect(readList(h).items.map((i) => i.name)).not.toContain("to-exit"));
  }, SLOW_TEST_MS);

  it("records the Claude sessionId when the periodic poll learns it, and the Claude-side name", async () => {
    const id = await newSession(h, "restorable", "named-here");
    setAgents([{ pid: sessionOf(h, id).term.pid, status: "idle", name: "claude-side-name", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    await vi.waitFor(() => {
      const item = readList(h).items.find((i) => i.claudeSessionId === ID_A);
      expect(item).toMatchObject({ roleId: "restorable", name: "claude-side-name", claudeSessionId: ID_A });
    });
  });

  it("saves again when the periodic poll shows a different Claude-side name", async () => {
    const id = await newSession(h, "echo", "before-rename");
    const pid = sessionOf(h, id).term.pid;
    setAgents([{ pid, status: "idle", name: "first-claude-name", cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    await vi.waitFor(() => expect(readList(h).items.map((i) => i.name)).toContain("first-claude-name"));
    setAgents([{ pid, status: "idle", name: "second-claude-name", cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    await vi.waitFor(() => {
      const names = readList(h).items.map((i) => i.name);
      expect(names).toContain("second-claude-name");
      expect(names).not.toContain("first-claude-name");
    });
  });

  it("never saves a sessionId that is not a UUID (K7)", async () => {
    const id = await newSession(h, "restorable", "bad-id");
    for (const bad of [BAD_ID, "not-a-uuid", "ABCDEF01-2345-4678-89AB-CDEF01234567", "../../etc/passwd", ""]) {
      setAgents([{ pid: sessionOf(h, id).term.pid, status: "idle", sessionId: bad, cwd: "/", startedAt: 1 }]);
      await h.hub.pollAgents();
    }
    h.sessions.setClaudeSessionId(id, BAD_ID);
    await settle();
    const item = readList(h).items.find((i) => i.name === "bad-id") as Record<string, unknown>;
    expect(item).toBeDefined();
    expect("claudeSessionId" in item).toBe(false);
    expect(readFileSync(fileOf(h), "utf8")).not.toContain("pwned");
  });

  it("drops a non-UUID sessionId found in the file when loading", async () => {
    writeList(h, [{ roleId: "echo", name: "x", cwd: "/", claudeSessionId: BAD_ID }]);
    const items = await h.store.load();
    expect(items).toEqual([{ roleId: "echo", name: "x", cwd: "/" }]);
    await settle(); // 後続の試験のために正しい内容へ戻る
  });
});

describe("shutdown keeps the list (K3)", () => {
  it("does not change the file when the server stops and every terminal is killed", async () => {
    const h = await startHarness({ recorder: true });
    await newSession(h, "echo", "survivor-1");
    await newSession(h, "echo", "survivor-2");
    await h.recorder.sync();
    const before = readFileSync(fileOf(h), "utf8");
    expect(readList(h).items).toHaveLength(2);

    // index.ts の shutdown と同じ順序
    h.sessions.beginShutdown();
    h.sessions.killAll();
    await vi.waitFor(() => expect(h.sessions.list().every((s) => s.exited)).toBe(true));
    await h.recorder.sync();
    await sleep(300);
    expect(readFileSync(fileOf(h), "utf8")).toBe(before);
    await h.close();
  });
});

describe("restore on startup (K4, K5, K6, K8)", () => {
  // 試験ごとに新しい harness（新しい dataDir）を使う（K8 を含む）。前の試験（closeAll 等）が残す記録の書き込みと競合させず、失敗しても後続へセッションを残さないため
  let h: Harness;
  let root: string;
  beforeEach(async () => {
    h = await startHarness({ recorder: true, restoreStaggerMs: STAGGER_MS, maxSessions: 4, extraRoles: EXTRA_ROLES });
    root = h.config.salesanchorRoot;
  });
  afterEach(async () => {
    await h.close();
  });
  const run = (): Promise<RestoreNotice[]> =>
    restoreOnStartup({ config: h.config, sessions: h.sessions, hub: h.hub, store: h.store, recorder: h.recorder });
  const ringOf = (name: string): string => {
    const s = h.sessions.list().find((x) => x.name === name);
    return s ? s.ring.snapshot() : "";
  };
  const closeAll = async (): Promise<void> => {
    for (const s of [...h.sessions.list()]) await h.sessions.close(s.id);
  };

  it("K4: reopens with restoreCommand and AC_RESUME_ID when the sessionId is known, otherwise with the normal command, keeping the saved name", async () => {
    writeList(h, [
      { roleId: "restorable", name: "with-id", cwd: root, claudeSessionId: ID_A },
      { roleId: "restorable", name: "without-id", cwd: root },
      { roleId: "echo", name: "shell-with-id", cwd: root, claudeSessionId: ID_B },
    ]);
    const notices = await run();
    expect(notices).toEqual([]);
    await vi.waitFor(() => expect(ringOf("with-id")).toContain("RESTORED"), WAIT);
    expect(ringOf("with-id")).toContain(`id=[${ID_A}]`);
    expect(ringOf("with-id")).toContain(`cwd=${root}`);
    await vi.waitFor(() => expect(ringOf("without-id")).toContain("FRESH"), WAIT);
    expect(ringOf("without-id")).toContain("id=[]");
    // restoreCommand を持たない役割は、sessionId があっても通常の命令（環境変数も渡さない）
    await vi.waitFor(() => expect(ringOf("shell-with-id")).toContain("READY"), WAIT);
    expect(ringOf("shell-with-id")).not.toContain(ID_B);
    // 復元後の写しに sessionId が残り、もう一度再起動しても続きを開ける
    await h.recorder.sync();
    expect(readList(h).items.map((i) => [i.name, i.claudeSessionId])).toEqual([
      ["with-id", ID_A],
      ["without-id", undefined],
      ["shell-with-id", undefined],
    ]);
    await closeAll();
  });

  it("K7: a non-UUID sessionId in the list is never passed to the command", async () => {
    writeList(h, [{ roleId: "restorable", name: "evil", cwd: root, claudeSessionId: BAD_ID }]);
    expect(await run()).toEqual([]);
    await vi.waitFor(() => expect(ringOf("evil")).toContain("FRESH"), WAIT);
    expect(ringOf("evil")).toContain("id=[]");
    expect(ringOf("evil")).not.toContain("pwned");
    await closeAll();
  });

  it("K5: drops items whose working directory is missing, outside, or whose role is unknown, and reports them", async () => {
    const outside = realOs();
    writeList(h, [
      { roleId: "echo", name: "ok-one", cwd: root },
      { roleId: "echo", name: "gone-dir", cwd: path.join(root, "no-such-worktree") },
      { roleId: "echo", name: "outside-dir", cwd: outside },
      { roleId: "no-such-role", name: "no-role", cwd: root },
    ]);
    const notices = await run();
    expect(notices).toEqual([
      { reason: "missingCwd", name: "gone-dir" },
      { reason: "missingCwd", name: "outside-dir" },
      { reason: "unknownRole", name: "no-role" },
    ]);
    expect(h.sessions.list().map((s) => s.name)).toEqual(["ok-one"]);
    // 画面へ: /api/state の restoreNotices に載る
    const state = await api(h, "GET", "/api/state");
    expect(state.json.restoreNotices).toEqual(notices);
    // 外した項目はリストからも消える
    await h.recorder.sync();
    expect(readList(h).items.map((i) => i.name)).toEqual(["ok-one"]);
    await closeAll();
  });

  it("K6: starts one at a time with the configured interval, and does not exceed maxSessions", async () => {
    writeList(h, [1, 2, 3, 4, 5].map((n) => ({ roleId: "echo", name: `many-${n}`, cwd: root })));
    const notices = await run();
    const created = h.sessions.list().map((s) => s.createdAt);
    expect(created).toHaveLength(4);
    for (let i = 1; i < created.length; i++) expect(created[i] - created[i - 1]).toBeGreaterThanOrEqual(STAGGER_MS - 30);
    expect(notices).toEqual([{ reason: "overLimit", name: "many-5" }]);
    await closeAll();
  });

  it("K8: a corrupt list is not overwritten; the server keeps running and reports it", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 99, items: [] })]) {
      putFile(h, content);
      const notices = await run();
      expect(notices).toEqual([{ reason: "unreadable" }]);
      // その後に新しいセッションを作っても、壊れたファイルは上書きしない
      const id = await newSession(h, "echo", "after-corrupt");
      await h.recorder.sync().catch(() => undefined);
      expect(readFileSync(fileOf(h), "utf8")).toBe(content);
      await h.sessions.close(id);
      const state = await api(h, "GET", "/api/state");
      expect(state.status).toBe(200);
      expect(state.json.restoreNotices).toEqual([{ reason: "unreadable" }]);
    }
  });

  it("starts normally when there is no list", async () => {
    await closeAll();
    writeList(h, []);
    expect(await run()).toEqual([]);
    expect(h.sessions.list()).toEqual([]);
  });
});

/** 本店でも worktree でもない、実在する場所（一時フォルダ） */
function realOs(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ac-outside-"));
}

describe("AGENT_CONSOLE_RESTORE=off (self-diagnosis server must not touch the restore list)", () => {
  it("is disabled only for the exact string off", () => {
    expect(isRestoreEnabled({ AGENT_CONSOLE_RESTORE: "off" })).toBe(false);
    for (const v of [undefined, "", "OFF", "0", "false", "on", " off"]) expect(isRestoreEnabled({ AGENT_CONSOLE_RESTORE: v })).toBe(true);
    expect(isRestoreEnabled({})).toBe(true);
  });

  it("with off: never loads or saves the store, starts no session, and the recorder stays inactive", async () => {
    const h = await startHarness({ closeGraceMs: 300 });
    const load = vi.spyOn(h.store, "load");
    const save = vi.spyOn(h.store, "save");
    putFile(h, JSON.stringify({ version: 1, items: [{ roleId: "echo", name: "must-not-open", cwd: h.config.salesanchorRoot }] }));
    const before = readFileSync(fileOf(h), "utf8");
    const result = await startOpenSessionRestore({ AGENT_CONSOLE_RESTORE: "off" }, { config: h.config, sessions: h.sessions, hub: h.hub, store: h.store, recorder: h.recorder });
    expect(result).toBeNull();
    await newSession(h, "echo", "created-after");
    await h.recorder.sync();
    await sleep(200);
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(h.sessions.list().map((s) => s.name)).toEqual(["created-after"]);
    expect(readFileSync(fileOf(h), "utf8")).toBe(before);
    await h.close();
  });

  it("without the variable: restores as usual (loads the store)", async () => {
    const h = await startHarness({ closeGraceMs: 300 });
    const load = vi.spyOn(h.store, "load");
    putFile(h, JSON.stringify({ version: 1, items: [{ roleId: "echo", name: "reopened", cwd: h.config.salesanchorRoot }] }));
    expect(await startOpenSessionRestore({}, { config: h.config, sessions: h.sessions, hub: h.hub, store: h.store, recorder: h.recorder })).toEqual([]);
    expect(load).toHaveBeenCalled();
    expect(h.sessions.list().map((s) => s.name)).toEqual(["reopened"]);
    await h.close();
  });
});

describe("sessions opened by a routine are ordinary sessions in open-sessions.json", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ recorder: true, closeGraceMs: CLOSE_GRACE_MS, extraRoles: EXTRA_ROLES });
  });
  afterAll(async () => {
    await closeAllSessions(h);
    await h.close();
  });

  it("K8 records a session opened the way a routine opens it, like any other", async () => {
    const role = h.config.roles.find((r) => r.id === "restorable") as RoleConfig;
    const ordinary = await newSession(h, "restorable", "ordinary");
    h.sessions.restore({ role, name: "routine", cwd: h.config.salesanchorRoot, branch: null });
    await h.recorder.sync();
    const names = readList(h).items.map((i) => i.name);
    expect(names).toEqual(["ordinary", "routine"]);
    expect(h.sessions.get(ordinary)).toBeDefined();
  });
});
