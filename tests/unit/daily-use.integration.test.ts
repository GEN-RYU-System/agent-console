import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

let h: Harness;
/** `claude agents --json`（今動いている一覧）の中身 */
let rowsFile: string;
/** `claude agents --all --json`（過去を含む一覧）の中身 */
let allFile: string;
let worktree: string;
const sent: string[] = [];

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-daily-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  allFile = path.join(stubDir, "all.json");
  writeFileSync(rowsFile, "[]");
  writeFileSync(allFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) if [ "$2" = "--all" ]; then cat "${allFile}"; else cat "${rowsFile}"; fi;; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({
    claudeBin: stub,
    sendNotification: (body) => sent.push(body),
    resumeCommand: ["/bin/sh", "-c", "echo RESUMED=$AC_RESUME_ID; cat"],
  });
  // 再開の試験用に、本店（コミット 1 つ）とそのワークツリーを作る
  const root = realpathSync(path.join(h.dir, "root"));
  const git = (...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root });
  git("commit", "-q", "--allow-empty", "-m", "seed");
  worktree = path.join(h.dir, "wt-one");
  git("worktree", "add", "-q", "-b", "release/one", worktree);
  worktree = realpathSync(worktree);
});
afterAll(async () => {
  await h.close();
});

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function newSession(roleId: string, name: string): Promise<string> {
  const res = await api("POST", "/api/sessions", { name, roleId });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

const writeRows = (file: string, rows: unknown[]): void => writeFileSync(file, JSON.stringify(rows));
const setAgents = (rows: unknown[]): void => writeRows(rowsFile, rows);
const sessionOf = (id: string) => h.sessions.get(id) as NonNullable<ReturnType<typeof h.sessions.get>>;
const pidOf = (id: string): number => sessionOf(id).term.pid;
const ringOf = (id: string): string => sessionOf(id).ring.snapshot();
const row = (pid: number, status: string, extra: Record<string, unknown> = {}) => ({ pid, status, name: "claude-name", sessionId: ID_A, cwd: "/", startedAt: 1, ...extra });
const viewOf = async (id: string): Promise<Record<string, unknown>> => {
  const state = await api("GET", "/api/state");
  return (state.json.sessions as Array<Record<string, unknown>>).find((s) => s.id === id) as Record<string, unknown>;
};
/** 端末に届いたものを落ち着くまで待ってから読む（cat が書いたものが ring に入る時間） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe("break notifications (K1)", () => {
  it("notifies once on busy -> idle, counts unread, clears it when read, and writes nothing to the terminal", async () => {
    const id = await newSession("echo", "notify-me");
    const pid = pidOf(id);
    const write = vi.spyOn(h.sessions, "write");
    await vi.waitFor(() => expect(ringOf(id)).toContain("READY"));
    const ringBefore = ringOf(id);

    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect(sent).toEqual([]);
    expect((await viewOf(id)).unread).toBe(0);

    setAgents([row(pid, "busy")]);
    await h.hub.pollAgents();
    expect(sent).toEqual([]);

    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect(sent).toEqual(["claude-name: 待機"]);
    expect((await viewOf(id)).unread).toBe(1);

    await h.hub.pollAgents();
    expect(sent).toHaveLength(1);

    expect((await api("POST", `/api/sessions/${id}/read`)).status).toBe(200);
    expect((await viewOf(id)).unread).toBe(0);

    // 区切りの検知・通知・未読の処理は、端末に 1 バイトも書かない
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(ringOf(id)).toBe(ringBefore);
    write.mockRestore();
  });

  it("does not notify when the claude lookup fails", async () => {
    const before = sent.length;
    writeFileSync(rowsFile, "not json");
    await h.hub.pollAgents();
    expect(sent).toHaveLength(before);
    setAgents([]);
  });

  it("returns 404 when marking an unknown session as read", async () => {
    expect((await api("POST", "/api/sessions/nope/read")).status).toBe(404);
  });

  it("forgets the previous status and unread of a session removed from the list", async () => {
    const id = await newSession("short", "gone-soon");
    await vi.waitFor(async () => expect((await viewOf(id)).state).toBe("stopped"));
    const forget = vi.spyOn((h.hub as unknown as { tracker: { forget: (id: string) => void } }).tracker, "forget");
    expect((await api("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    expect(forget).toHaveBeenCalledWith(id);
    forget.mockRestore();
  });
});

describe("input safety: /rename and quick prompts only when Claude is idle (M1/L1)", () => {
  it("shows Claude's name, and canInput follows the polled status", async () => {
    const id = await newSession("echo", "app-name");
    const pid = pidOf(id);
    setAgents([row(pid, "busy")]);
    await h.hub.pollAgents();
    expect(await viewOf(id)).toMatchObject({ name: "claude-name", hasClaude: true, canInput: false });
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect(await viewOf(id)).toMatchObject({ canInput: true });
  });

  it("sends /rename only when idle, and answers 409 with a reason for busy, waiting and waitingFor", async () => {
    const id = await newSession("echo", "rename-me");
    const pid = pidOf(id);
    for (const [rows, reason] of [
      [[row(pid, "busy")], "claude is busy"],
      [[row(pid, "waiting", { waitingFor: "permission prompt" })], "claude is waiting"],
      [[row(pid, "idle", { waitingFor: "input needed" })], "waiting for input"],
    ] as const) {
      setAgents([...rows]);
      const res = await api("POST", `/api/sessions/${id}/rename`, { name: "next" });
      expect(res.status).toBe(409);
      expect(String(res.json.error)).toContain(reason);
    }
    await settle();
    expect(ringOf(id)).not.toContain("/rename");

    setAgents([row(pid, "idle")]);
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "next-name" })).json).toEqual({ mode: "claude" });
    await vi.waitFor(() => expect(ringOf(id)).toContain("/rename next-name"));
  });

  it("uses the status at request time, not the one polled a few seconds ago", async () => {
    const id = await newSession("echo", "stale");
    const pid = pidOf(id);
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect((await viewOf(id)).canInput).toBe(true);
    setAgents([row(pid, "busy")]); // 取得の後に busy になった。ポーリングはまだ古い idle を持っている
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "late" })).status).toBe(409);
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: "x" })).status).toBe(404);
    const created = await api("POST", "/api/quick-prompts", { label: "p", text: "late-text" });
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(409);
    await settle();
    expect(ringOf(id)).not.toContain("late");
    await api("DELETE", `/api/quick-prompts/${created.json.id as string}`);
  });

  it("renames the app-side name for a session without Claude, and validates the name", async () => {
    setAgents([]);
    const id = await newSession("echo", "plain");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "renamed" })).json).toEqual({ mode: "app" });
    await h.hub.pollAgents();
    expect((await viewOf(id)).name).toBe("renamed");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "" })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "a\nb" })).status).toBe(400);
  });

  it("refuses everything when the Claude state cannot be read, and for stopped sessions", async () => {
    const id = await newSession("echo", "unknown-state");
    writeFileSync(rowsFile, "not json");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "x" })).status).toBe(409);
    setAgents([]);
    const stopped = await newSession("short", "stopped");
    await vi.waitFor(async () => expect((await viewOf(stopped)).state).toBe("stopped"));
    expect((await api("POST", `/api/sessions/${stopped}/rename`, { name: "x" })).status).toBe(409);
  });
});

describe("quick prompts (K3)", () => {
  it("manages prompts through the API; send-check returns the text after a fresh state check and never writes to the terminal", async () => {
    const created = await api("POST", "/api/quick-prompts", { label: "テスト実行", text: "run-the-tests" });
    expect(created.status).toBe(201);
    const promptId = created.json.id as string;
    expect(((await api("GET", "/api/quick-prompts")).json.items as unknown[]).length).toBe(1);
    expect((await api("PUT", `/api/quick-prompts/${promptId}`, { label: "テスト実行2", text: "run-the-tests-now" })).status).toBe(200);

    setAgents([]);
    const id = await newSession("echo", "target");
    await vi.waitFor(() => expect(ringOf(id)).toContain("READY"));
    const write = vi.spyOn(h.sessions, "write");
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId })).json).toEqual({ text: "run-the-tests-now" });
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(ringOf(id)).not.toContain("run-the-tests-now");
    write.mockRestore();

    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: "missing" })).status).toBe(404);
    expect((await api("DELETE", `/api/quick-prompts/${promptId}`)).status).toBe(200);
    expect(((await api("GET", "/api/quick-prompts")).json.items as unknown[]).length).toBe(0);
  });

  it("answers 409 for busy and waiting Claude sessions", async () => {
    const created = await api("POST", "/api/quick-prompts", { label: "x", text: "y" });
    const id = await newSession("echo", "busy-target");
    const pid = pidOf(id);
    for (const status of ["busy", "waiting"]) {
      setAgents([row(pid, status)]);
      expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(409);
    }
    setAgents([row(pid, "idle")]);
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(200);
    await api("DELETE", `/api/quick-prompts/${created.json.id as string}`);
  });

  it("rejects text over 8KB and requires authentication", async () => {
    expect((await api("POST", "/api/quick-prompts", { label: "big", text: "a".repeat(8 * 1024 + 1) })).status).toBe(400);
    expect((await fetch(`${h.base}/api/quick-prompts`)).status).toBe(401);
  });
});

describe("past sessions (K4)", () => {
  const mainRoot = (): string => realpathSync(path.join(h.dir, "root"));

  it("lists every row with its reason, and resumes only a worktree session with the id in AC_RESUME_ID", async () => {
    writeRows(allFile, [
      { pid: 99991, status: "idle", name: "old work", sessionId: ID_A, cwd: worktree, startedAt: 300 },
      { pid: 99992, status: "idle", name: "designer", sessionId: ID_B, cwd: mainRoot(), startedAt: 200 },
      { pid: 99993, status: "idle", name: "elsewhere", sessionId: ID_C, cwd: "/", startedAt: 100 },
    ]);
    setAgents([]);
    const list = await api("GET", "/api/past-sessions");
    expect((list.json.items as Array<{ sessionId: string; blocked: string | null }>).map((i) => [i.sessionId, i.blocked])).toEqual([
      [ID_A, null],
      [ID_B, "main"],
      [ID_C, "outside"],
    ]);

    const resumed = await api("POST", "/api/sessions/resume", { sessionId: ID_A });
    expect(resumed.status).toBe(201);
    await vi.waitFor(() => expect(ringOf(resumed.json.id as string)).toContain(`RESUMED=${ID_A}`));
    expect(h.sessions.get(resumed.json.id as string)?.cwd).toBe(worktree);
  });

  it("rejects the main checkout, a directory outside, an invalid id and an unknown id", async () => {
    expect((await api("POST", "/api/sessions/resume", { sessionId: ID_B })).status).toBe(400);
    expect((await api("POST", "/api/sessions/resume", { sessionId: ID_C })).status).toBe(400);
    expect((await api("POST", "/api/sessions/resume", { sessionId: "x;id" })).status).toBe(400);
    expect((await api("POST", "/api/sessions/resume", { sessionId: "44444444-4444-4444-8444-444444444444" })).status).toBe(404);
  });

  it("refuses with 409 when the sessionId is in the list of sessions running right now (any terminal), and marks it in the list", async () => {
    setAgents([{ pid: 55555, status: "busy", name: "running elsewhere", sessionId: ID_A, cwd: worktree, startedAt: 1 }]);
    const res = await api("POST", "/api/sessions/resume", { sessionId: ID_A });
    expect(res.status).toBe(409);
    const list = await api("GET", "/api/past-sessions");
    expect((list.json.items as Array<{ sessionId: string; blocked: string | null }>).find((i) => i.sessionId === ID_A)?.blocked).toBe("running");
    setAgents([]);
  });

  it("refuses when it cannot confirm the session is not running", async () => {
    writeFileSync(rowsFile, "not json");
    expect((await api("POST", "/api/sessions/resume", { sessionId: ID_A })).status).toBe(409);
    setAgents([]);
  });
});

describe("memory (K6)", () => {
  it("returns per-session (display name), server and system memory", async () => {
    const id = await newSession("echo", "mem");
    setAgents([row(pidOf(id), "idle", { name: "display-from-claude" })]);
    await h.hub.pollAgents();
    const res = await api("GET", "/api/memory");
    expect(res.status).toBe(200);
    const sessions = res.json.sessions as Array<{ id: string; name: string; rssMb: number }>;
    const mine = sessions.find((s) => s.id === id);
    expect(mine?.name).toBe("display-from-claude");
    expect(mine?.rssMb).toBeGreaterThan(0);
    expect(res.json.serverRssMb as number).toBeGreaterThan(0);
    const system = res.json.system as { totalMb: number; freePercent: number; usedPercent: number } | null;
    if (system !== null) expect(system.freePercent + system.usedPercent).toBe(100);
  });
});
