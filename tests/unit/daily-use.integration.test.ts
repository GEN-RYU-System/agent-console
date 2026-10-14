import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
let worktree: string;
const sent: string[] = [];

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-daily-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({
    claudeBin: stub,
    maxSessions: 40,
    sendNotification: (body) => sent.push(body),
    // 実機の命令は `... --resume`（id なし）。ここでは作業場所と、AC_RESUME_ID が渡らないことを出力する
    resumeCommand: ["/bin/sh", "-c", "echo RESUMED_WT cwd=$PWD id=[$AC_RESUME_ID]; cat"],
    mainResumeCommand: ["/bin/sh", "-c", "echo RESUMED_MAIN cwd=$PWD id=[$AC_RESUME_ID]; cat"],
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
  // 1 つの it に何度も ps・bash を起動する手順を詰めると、負荷時に 5 秒に近づく。順に進む手順を it ごとに分ける
  let id = "";
  let pid = 0;
  let ringBefore = "";
  let write: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    id = await newSession("echo", "notify-me");
    pid = pidOf(id);
    write = vi.spyOn(h.sessions, "write");
    await vi.waitFor(() => expect(ringOf(id)).toContain("READY"));
    ringBefore = ringOf(id);
  });
  afterAll(() => write.mockRestore());

  it("does not notify for the first observation or for idle -> busy", async () => {
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    setAgents([row(pid, "busy")]);
    await h.hub.pollAgents();
    expect(sent).toEqual([]);
  });

  it("notifies once on busy -> idle and counts unread", async () => {
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect(sent).toEqual(["claude-name: 指示待ち"]);
    await h.hub.pollAgents();
    expect(sent).toHaveLength(1);
    expect((await viewOf(id)).unread).toBe(1);
  });

  it("clears the unread count when the row is read", async () => {
    expect((await api("POST", `/api/sessions/${id}/read`)).status).toBe(200);
    expect((await viewOf(id)).unread).toBe(0);
  });

  it("writes nothing to the terminal while detecting, notifying and marking as read", async () => {
    // 区切りの検知・通知・未読の処理は、端末に 1 バイトも書かない
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(ringOf(id)).toBe(ringBefore);
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

  it("K3/K4: sends /rename at once when idle; queues without writing to the terminal when busy, waiting, waitingFor or unknown", async () => {
    const id = await newSession("echo", "rename-me");
    const pid = pidOf(id);
    for (const rows of [
      [row(pid, "busy")],
      [row(pid, "waiting", { waitingFor: "permission prompt" })],
      [row(pid, "idle", { waitingFor: "input needed" })],
    ]) {
      setAgents(rows);
      const res = await api("POST", `/api/sessions/${id}/rename`, { name: "next" });
      expect(res).toMatchObject({ status: 200, json: { mode: "queued" } });
      expect((await viewOf(id)).pendingName).toBe("next");
    }
    writeFileSync(rowsFile, "not json");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "next" })).json).toEqual({ mode: "queued" });
    await settle();
    expect(ringOf(id)).not.toContain("/rename");

    setAgents([row(pid, "idle")]);
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "next-name" })).json).toEqual({ mode: "claude" });
    await vi.waitFor(() => expect(ringOf(id)).toContain("/rename next-name"));
    // K6: 待機中にすぐ変えたので、予約は消えている
    expect((await viewOf(id)).pendingName).toBeUndefined();
  });

  it("K5: sends the queued /rename once, only after idle (busy -> waiting -> idle)", async () => {
    const id = await newSession("echo", "queue-flow");
    const pid = pidOf(id);
    setAgents([row(pid, "busy")]);
    await h.hub.pollAgents();
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "after-work" })).json).toEqual({ mode: "queued" });
    setAgents([row(pid, "waiting", { waitingFor: "permission prompt" })]);
    await h.hub.pollAgents();
    await settle();
    expect(ringOf(id)).not.toContain("/rename");
    expect((await viewOf(id)).pendingName).toBe("after-work");
    setAgents([row(pid, "idle")]);
    const write = vi.spyOn(h.sessions, "write");
    await h.hub.pollAgents();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.anything(), "/rename after-work\r");
    await vi.waitFor(() => expect(ringOf(id)).toContain("/rename after-work"));
    write.mockClear();
    await h.hub.pollAgents();
    await settle();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    expect((await viewOf(id)).pendingName).toBeUndefined();
  });

  it("K5: does not send when the poll says idle but the fresh check says busy; the reservation stays", async () => {
    const id = await newSession("echo", "recheck");
    const pid = pidOf(id);
    setAgents([row(pid, "busy")]);
    await api("POST", `/api/sessions/${id}/rename`, { name: "still-queued" });
    const hub = h.hub as unknown as { agents: unknown };
    setAgents([row(pid, "idle")]);
    const check = vi.spyOn(h.hub, "checkInput").mockResolvedValueOnce({ ok: false, reason: "claude is busy", hasClaude: true });
    await h.hub.pollAgents();
    expect(check).toHaveBeenCalled();
    check.mockRestore();
    expect(hub.agents).not.toBeNull();
    await settle();
    expect(ringOf(id)).not.toContain("/rename");
    expect((await viewOf(id)).pendingName).toBe("still-queued");
  });

  it("K6: a second reservation overwrites the first; only the last name is sent", async () => {
    const id = await newSession("echo", "overwrite");
    const pid = pidOf(id);
    setAgents([row(pid, "busy")]);
    await api("POST", `/api/sessions/${id}/rename`, { name: "first-name" });
    await api("POST", `/api/sessions/${id}/rename`, { name: "second-name" });
    expect((await viewOf(id)).pendingName).toBe("second-name");
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    await vi.waitFor(() => expect(ringOf(id)).toContain("/rename second-name"));
    expect(ringOf(id)).not.toContain("first-name");
  });

  it("K6: drops the reservation when the session stops or is removed from the list", async () => {
    const id = await newSession("echo", "drop-removed");
    setAgents([row(pidOf(id), "busy")]);
    await api("POST", `/api/sessions/${id}/rename`, { name: "gone" });
    const pending = (h.hub as unknown as { pendingRenames: Map<string, string> }).pendingRenames;
    expect(pending.has(id)).toBe(true);
    h.sessions.get(id)?.term.kill();
    await vi.waitFor(async () => expect((await viewOf(id)).state).toBe("stopped"));
    setAgents([]);
    await h.hub.pollAgents();
    expect(pending.has(id)).toBe(false);
    expect((await viewOf(id)).pendingName).toBeUndefined();

    const removed = await newSession("echo", "drop-removed-2");
    setAgents([row(pidOf(removed), "busy")]);
    await api("POST", `/api/sessions/${removed}/rename`, { name: "gone2" });
    expect(pending.has(removed)).toBe(true);
    h.sessions.get(removed)?.term.kill();
    await vi.waitFor(async () => expect((await viewOf(removed)).state).toBe("stopped"));
    expect((await api("DELETE", `/api/sessions/${removed}`)).status).toBe(200);
    expect(pending.has(removed)).toBe(false);
  });

  it("K5: a reservation made while the state was unknown becomes an app-side rename once Claude is known to be absent", async () => {
    setAgents([]);
    const id = await newSession("echo", "unknown-then-none");
    writeFileSync(rowsFile, "not json");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "app-renamed" })).json).toEqual({ mode: "queued" });
    setAgents([]);
    await h.hub.pollAgents();
    await settle();
    expect(ringOf(id)).not.toContain("/rename");
    expect(await viewOf(id)).toMatchObject({ name: "app-renamed", hasClaude: false });
    expect((await viewOf(id)).pendingName).toBeUndefined();
  });

  it("uses the status at request time, not the one polled a few seconds ago", async () => {
    const id = await newSession("echo", "stale");
    const pid = pidOf(id);
    setAgents([row(pid, "idle")]);
    await h.hub.pollAgents();
    expect((await viewOf(id)).canInput).toBe(true);
    setAgents([row(pid, "busy")]); // 取得の後に busy になった。ポーリングはまだ古い idle を持っている
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "late" })).json).toEqual({ mode: "queued" });
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: "x" })).status).toBe(404);
    const created = await api("POST", "/api/quick-prompts", { label: "p", text: "late-text" });
    setAgents([row(pid, "waiting")]); // よく使う指示は作業中でも可。取得の後に確認待ちへ変わった場合だけ 409
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

  it("K7: refuses the quick-prompt check when the state cannot be read, and answers 409 to rename for stopped sessions", async () => {
    const id = await newSession("echo", "unknown-state");
    writeFileSync(rowsFile, "not json");
    const created = await api("POST", "/api/quick-prompts", { label: "u", text: "unknown-text" });
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(409);
    await api("DELETE", `/api/quick-prompts/${created.json.id as string}`);
    setAgents([]);
    const stopped = await newSession("short", "stopped");
    await vi.waitFor(async () => expect((await viewOf(stopped)).state).toBe("stopped"));
    expect((await api("POST", `/api/sessions/${stopped}/rename`, { name: "x" })).status).toBe(409);
    expect((await viewOf(stopped)).pendingName).toBeUndefined();
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

  it("K1-K3 moves prompts through the API: order changes, out-of-range and bad direction are 400, unknown id is 404", async () => {
    const a = (await api("POST", "/api/quick-prompts", { label: "mv-a", text: "1" })).json.id as string;
    const b = (await api("POST", "/api/quick-prompts", { label: "mv-b", text: "2" })).json.id as string;
    const labels = async (): Promise<string[]> => ((await api("GET", "/api/quick-prompts")).json.items as Array<{ label: string }>).map((i) => i.label);
    expect((await api("POST", `/api/quick-prompts/${b}/move`, { direction: "up" })).status).toBe(200);
    expect(await labels()).toEqual(["mv-b", "mv-a"]);
    expect((await api("POST", `/api/quick-prompts/${b}/move`, { direction: "up" })).status).toBe(400);
    expect((await api("POST", `/api/quick-prompts/${a}/move`, { direction: "down" })).status).toBe(400);
    expect(await labels()).toEqual(["mv-b", "mv-a"]);
    expect((await api("POST", `/api/quick-prompts/${a}/move`, { direction: "sideways" })).status).toBe(400);
    expect((await api("POST", `/api/quick-prompts/${a}/move`, {})).status).toBe(400);
    expect((await api("POST", "/api/quick-prompts/missing/move", { direction: "up" })).status).toBe(404);
    expect((await fetch(`${h.base}/api/quick-prompts/${a}/move`, { method: "POST" })).status).toBe(401);
    await api("DELETE", `/api/quick-prompts/${a}`);
    await api("DELETE", `/api/quick-prompts/${b}`);
  });

  it("answers 200 for busy and 409 for waiting Claude sessions", async () => {
    const created = await api("POST", "/api/quick-prompts", { label: "x", text: "y" });
    const id = await newSession("echo", "busy-target");
    const pid = pidOf(id);
    setAgents([row(pid, "busy")]);
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(200);
    setAgents([row(pid, "waiting")]);
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(409);
    setAgents([row(pid, "idle")]);
    expect((await api("POST", `/api/sessions/${id}/send-check`, { promptId: created.json.id })).status).toBe(200);
    await api("DELETE", `/api/quick-prompts/${created.json.id as string}`);
  });

  it("rejects text over 8KB and requires authentication", async () => {
    expect((await api("POST", "/api/quick-prompts", { label: "big", text: "a".repeat(8 * 1024 + 1) })).status).toBe(400);
    expect((await fetch(`${h.base}/api/quick-prompts`)).status).toBe(401);
  });
});

describe("resume targets (K1-K4)", () => {
  const mainRoot = (): string => realpathSync(path.join(h.dir, "root"));

  it("K1: lists the main checkout (Opus role) and each worktree except the main one (Sonnet role) with the branch name", async () => {
    const list = await api("GET", "/api/resume-targets");
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([
      { kind: "main", path: mainRoot(), branch: expect.any(String), roleId: "resumable-main" },
      { kind: "worktree", path: worktree, branch: "release/one", roleId: "resumable" },
    ]);
    expect((await fetch(`${h.base}/api/resume-targets`)).status).toBe(401);
  });

  it("K2: resuming the main row starts the Opus resume command in the main checkout (no session id passed)", async () => {
    const resumed = await api("POST", "/api/sessions/resume", { kind: "main", path: mainRoot() });
    expect(resumed.status).toBe(201);
    const id = resumed.json.id as string;
    await vi.waitFor(() => expect(ringOf(id)).toContain(`RESUMED_MAIN cwd=${mainRoot()} id=[]`));
    expect(h.sessions.get(id)?.cwd).toBe(mainRoot());
    expect(h.sessions.get(id)?.roleId).toBe("resumable-main");
  });

  it("K3: resuming a worktree row starts the Sonnet resume command in that worktree", async () => {
    const resumed = await api("POST", "/api/sessions/resume", { kind: "worktree", path: worktree });
    expect(resumed.status).toBe(201);
    const id = resumed.json.id as string;
    await vi.waitFor(() => expect(ringOf(id)).toContain(`RESUMED_WT cwd=${worktree} id=[]`));
    expect(h.sessions.get(id)?.cwd).toBe(worktree);
    expect(h.sessions.get(id)?.roleId).toBe("resumable");
    expect(h.sessions.get(id)?.name).toBe("resume: release/one");
  });

  it("K4: rejects a place that is neither the main checkout nor in git worktree list (outside, missing, relative, symlink, wrong kind, bad body)", async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-outside-")));
    const link = path.join(h.dir, "link-outside");
    symlinkSync(outside, link);
    const bad: Array<Record<string, unknown>> = [
      { kind: "worktree", path: outside },
      { kind: "worktree", path: "/" },
      { kind: "worktree", path: path.join(h.dir, "missing") },
      { kind: "worktree", path: "wt-one" },
      { kind: "worktree", path: "../.." },
      { kind: "worktree", path: link },
      { kind: "main", path: worktree },
      { kind: "worktree", path: mainRoot() },
      { kind: "other", path: worktree },
      { path: worktree },
      { kind: "worktree" },
      { sessionId: "11111111-1111-4111-8111-111111111111" },
    ];
    const before = h.sessions.list().length;
    for (const body of bad) expect((await api("POST", "/api/sessions/resume", body)).status, JSON.stringify(body)).toBe(400);
    expect(h.sessions.list().length).toBe(before);
  });
});

describe("memory (K6)", () => {
  it("does not run ps through hub.snapshot for names (names come from the last snapshot)", async () => {
    const snapshot = vi.spyOn(h.hub, "snapshot");
    await api("GET", "/api/memory");
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
  });

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
