import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

type Json = Record<string, unknown>;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("設定の maxSessions が窓の上限になる（便1 K1・K2）", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ configMaxSessions: 2, mainResumeCommand: ["/bin/sh", "-c", "cat"] });
  });
  afterAll(async () => {
    await h.close();
  });

  const post = async (p: string, body?: Json): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${h.base}${p}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const state = async (): Promise<Json> => (await (await fetch(`${h.base}/api/state`, { headers })).json()) as Json;
  const create = (name: string, roleId = "echo") => post("/api/sessions", { name, roleId });

  it("2 本開くと、create も resume も 400 too many sessions。1 本閉じれば開ける", async () => {
    const a = await create("a");
    const b = await create("b");
    expect([a.status, b.status]).toEqual([201, 201]);
    const s = await state();
    expect(s.maxSessions).toBe(2);
    expect(s.openCount).toBe(2);

    const full = await create("c");
    expect(full.status).toBe(400);
    expect(JSON.stringify(full.json)).toContain("too many sessions");
    expect(() => h.sessions.resume({ roleId: "resumable-main", name: "r", cwd: h.dir })).toThrow(/too many sessions/);

    expect((await post(`/api/sessions/${a.json.id as string}/close`)).status).toBe(200);
    expect((await state()).openCount).toBe(1);
    const again = await create("c");
    expect(again.status).toBe(201);
    expect((await post(`/api/sessions/${again.json.id as string}/close`)).status).toBe(200);
    expect((await post(`/api/sessions/${b.json.id as string}/close`)).status).toBe(200);
  });

  it("止まった窓 1 本と動いている窓 1 本では開けない（止まった窓も数える）", async () => {
    const stopped = await create("s", "short");
    await vi.waitFor(() => expect(h.sessions.get(stopped.json.id as string)?.exited).toBe(true));
    const live = await create("l");
    expect(live.status).toBe(201);
    expect((await state()).openCount).toBe(2);
    const full = await create("x");
    expect(full.status).toBe(400);
    expect(JSON.stringify(full.json)).toContain("too many sessions");
  });
});
