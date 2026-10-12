import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OPEN_SESSIONS_FILE } from "../../server/session-store.ts";
import { SessionInputError, SessionNotFoundError } from "../../server/sessions.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const SLOW_TEST_MS = 30000;
vi.setConfig({ testTimeout: SLOW_TEST_MS });
const WAIT = { timeout: 5000 };
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(h: Harness, method: string, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${p}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function newSession(h: Harness, name: string, roleId = "echo"): Promise<string> {
  const res = await api(h, "POST", "/api/sessions", { name, roleId });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

const names = (h: Harness): string[] => h.sessions.list().map((s) => s.name);
const fileNames = (h: Harness): string[] =>
  (JSON.parse(readFileSync(path.join(h.config.dataDir, OPEN_SESSIONS_FILE), "utf8")) as { items: Array<{ name: string }> }).items.map((i) => i.name);

describe("SessionManager.move / POST /api/sessions/:id/move (v0.10.0 K6)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ recorder: true });
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(async () => {
    for (const s of [...h.sessions.list()]) await h.sessions.close(s.id).catch(() => undefined);
  });

  it("moves a session to the given index, in both directions, keeping the others in order", async () => {
    const a = await newSession(h, "a");
    const b = await newSession(h, "b");
    const c = await newSession(h, "c");
    h.sessions.move(a, 2);
    expect(names(h)).toEqual(["b", "c", "a"]);
    h.sessions.move(a, 0);
    expect(names(h)).toEqual(["a", "b", "c"]);
    h.sessions.move(c, 1);
    expect(names(h)).toEqual(["a", "c", "b"]);
    expect(h.sessions.get(b)?.name).toBe("b");
  });

  it("does nothing, and does not notify, when the index does not change", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    const listener = vi.fn();
    const off = h.sessions.onChange(listener);
    h.sessions.move(a, 0);
    off();
    expect(listener).not.toHaveBeenCalled();
    expect(names(h)).toEqual(["a", "b"]);
  });

  it("notifies once when the order changes", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    const listener = vi.fn();
    const off = h.sessions.onChange(listener);
    h.sessions.move(a, 1);
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects an index that is not an integer, negative, or beyond the count (stopped sessions are counted)", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    for (const bad of [-1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(() => h.sessions.move(a, bad)).toThrow(SessionInputError);
    }
    expect(names(h)).toEqual(["a", "b"]);
  });

  it("throws SessionNotFoundError for an unknown id", async () => {
    await newSession(h, "a");
    expect(() => h.sessions.move("nope", 0)).toThrow(SessionNotFoundError);
  });

  it("API: 200 moves the session and the snapshot shows the new order", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    const res = await api(h, "POST", `/api/sessions/${a}/move`, { toIndex: 1 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ moved: true });
    const state = await api(h, "GET", "/api/state");
    expect((state.json.sessions as Array<{ name: string }>).map((s) => s.name)).toEqual(["b", "a"]);
  });

  it("API: 400 for a bad index, 404 for an unknown id, 401 without a token", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    expect((await api(h, "POST", `/api/sessions/${a}/move`, { toIndex: 9 })).status).toBe(400);
    expect((await api(h, "POST", `/api/sessions/${a}/move`, { toIndex: "0" })).status).toBe(400);
    expect((await api(h, "POST", `/api/sessions/${a}/move`, {})).status).toBe(400);
    expect((await api(h, "POST", "/api/sessions/nope/move", { toIndex: 0 })).status).toBe(404);
    const res = await fetch(`${h.base}/api/sessions/${a}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toIndex: 1 }) });
    expect(res.status).toBe(401);
    expect(names(h)).toEqual(["a", "b"]);
  });

  it("the open-sessions list (the order used when restoring) follows the new order", async () => {
    const a = await newSession(h, "a");
    await newSession(h, "b");
    const c = await newSession(h, "c");
    await vi.waitFor(() => expect(fileNames(h)).toEqual(["a", "b", "c"]), WAIT);
    expect((await api(h, "POST", `/api/sessions/${c}/move`, { toIndex: 0 })).status).toBe(200);
    await vi.waitFor(() => expect(fileNames(h)).toEqual(["c", "a", "b"]), WAIT);
    h.sessions.move(a, 2);
    await vi.waitFor(() => expect(fileNames(h)).toEqual(["c", "b", "a"]), WAIT);
  });
});
