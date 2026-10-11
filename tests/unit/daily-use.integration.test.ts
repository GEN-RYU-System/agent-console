import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

let h: Harness;
let rowsFile: string;
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
    sendNotification: (body) => sent.push(body),
    resumeCommand: ["/bin/sh", "-c", "echo RESUMED=$AC_RESUME_ID; cat"],
  });
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

function setAgents(rows: unknown[]): void {
  writeFileSync(rowsFile, JSON.stringify(rows));
}

const pidOf = (id: string): number => (h.sessions.get(id) as NonNullable<ReturnType<typeof h.sessions.get>>).term.pid;
const ringOf = (id: string): string => (h.sessions.get(id) as NonNullable<ReturnType<typeof h.sessions.get>>).ring.snapshot();
const viewOf = async (id: string): Promise<Record<string, unknown>> => {
  const state = await api("GET", "/api/state");
  return (state.json.sessions as Array<Record<string, unknown>>).find((s) => s.id === id) as Record<string, unknown>;
};

describe("break notifications (K1)", () => {
  it("notifies once on busy -> idle, counts unread, and clears it when the row is read", async () => {
    const id = await newSession("echo", "notify-me");
    const pid = pidOf(id);
    setAgents([{ pid, status: "idle", name: "claude-name", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    expect(sent).toEqual([]);
    expect((await viewOf(id)).unread).toBe(0);

    setAgents([{ pid, status: "busy", name: "claude-name", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    expect(sent).toEqual([]);

    setAgents([{ pid, status: "idle", name: "claude-name", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    expect(sent).toEqual(["claude-name: 待機"]);
    expect((await viewOf(id)).unread).toBe(1);

    await h.hub.pollAgents();
    expect(sent).toHaveLength(1);

    expect((await api("POST", `/api/sessions/${id}/read`)).status).toBe(200);
    expect((await viewOf(id)).unread).toBe(0);
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
});

describe("rename (K2)", () => {
  it("shows Claude's name while Claude runs and sends /rename only when waiting or idle", async () => {
    const id = await newSession("echo", "app-name");
    const pid = pidOf(id);
    setAgents([{ pid, status: "busy", name: "from-claude", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    expect((await viewOf(id)).name).toBe("from-claude");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "next" })).status).toBe(409);

    setAgents([{ pid, status: "waiting", name: "from-claude", sessionId: ID_A, cwd: "/", startedAt: 1 }]);
    await h.hub.pollAgents();
    const ok = await api("POST", `/api/sessions/${id}/rename`, { name: "next-name" });
    expect(ok.json).toEqual({ mode: "claude" });
    await vi.waitFor(() => expect(ringOf(id)).toContain("/rename next-name"));
  });

  it("renames the app-side name when Claude is not running, and validates it", async () => {
    setAgents([]);
    const id = await newSession("echo", "plain");
    await h.hub.pollAgents();
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "renamed" })).json).toEqual({ mode: "app" });
    expect((await viewOf(id)).name).toBe("renamed");
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "" })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${id}/rename`, { name: "a\nb" })).status).toBe(400);
  });
});

describe("quick prompts (K3)", () => {
  it("creates, lists, updates, sends to the terminal and deletes", async () => {
    const created = await api("POST", "/api/quick-prompts", { label: "テスト実行", text: "run-the-tests" });
    expect(created.status).toBe(201);
    const promptId = created.json.id as string;
    expect(((await api("GET", "/api/quick-prompts")).json.items as unknown[]).length).toBe(1);

    const upd = await api("PUT", `/api/quick-prompts/${promptId}`, { label: "テスト実行2", text: "run-the-tests-now" });
    expect(upd.status).toBe(200);

    const id = await newSession("echo", "target");
    expect((await api("POST", `/api/sessions/${id}/send`, { promptId })).json).toEqual({ sent: true });
    await vi.waitFor(() => expect(ringOf(id)).toContain("run-the-tests-now"));

    expect((await api("POST", `/api/sessions/${id}/send`, { promptId: "missing" })).status).toBe(404);
    expect((await api("DELETE", `/api/quick-prompts/${promptId}`)).status).toBe(200);
    expect(((await api("GET", "/api/quick-prompts")).json.items as unknown[]).length).toBe(0);
  });

  it("rejects text over 8KB and requires authentication", async () => {
    expect((await api("POST", "/api/quick-prompts", { label: "big", text: "a".repeat(8 * 1024 + 1) })).status).toBe(400);
    const res = await fetch(`${h.base}/api/quick-prompts`);
    expect(res.status).toBe(401);
  });
});

describe("past sessions (K4)", () => {
  it("lists sessions from claude agents --all and resumes one with the id in AC_RESUME_ID", async () => {
    const root = realpathSync(path.join(h.dir, "root"));
    setAgents([
      { pid: 99991, status: "idle", name: "old work", sessionId: ID_A, cwd: root, startedAt: 100 },
      { pid: 99992, status: "idle", name: "elsewhere", sessionId: ID_B, cwd: "/", startedAt: 200 },
    ]);
    const list = await api("GET", "/api/past-sessions");
    expect((list.json.items as Array<{ sessionId: string }>).map((i) => i.sessionId)).toEqual([ID_B, ID_A]);

    const resumed = await api("POST", "/api/sessions/resume", { sessionId: ID_A });
    expect(resumed.status).toBe(201);
    await vi.waitFor(() => expect(ringOf(resumed.json.id as string)).toContain(`RESUMED=${ID_A}`));
    expect(h.sessions.get(resumed.json.id as string)?.cwd).toBe(root);
  });

  it("rejects an invalid id, an unknown id and a working directory outside the checkout", async () => {
    expect((await api("POST", "/api/sessions/resume", { sessionId: "x;id" })).status).toBe(400);
    expect((await api("POST", "/api/sessions/resume", { sessionId: "33333333-3333-4333-8333-333333333333" })).status).toBe(404);
    expect((await api("POST", "/api/sessions/resume", { sessionId: ID_B })).status).toBe(400);
  });
});

describe("memory (K6)", () => {
  it("returns per-session, server and system memory", async () => {
    const id = await newSession("echo", "mem");
    const res = await api("GET", "/api/memory");
    expect(res.status).toBe(200);
    const sessions = res.json.sessions as Array<{ id: string; rssMb: number }>;
    expect(sessions.find((s) => s.id === id)?.rssMb).toBeGreaterThan(0);
    expect(res.json.serverRssMb as number).toBeGreaterThan(0);
    const system = res.json.system as { totalMb: number; freePercent: number; usedPercent: number } | null;
    if (system !== null) expect(system.freePercent + system.usedPercent).toBe(100);
  });
});
