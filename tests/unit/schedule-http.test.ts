import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => {
  const res = await fetch(`${h.base}${url}`, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* no body */ }
  return { status: res.status, json };
};
const item = { side: "secretary", kind: "todo", title: "http task", date: "2026-11-04", start: "10:00" };

describe("schedule items HTTP", () => {
  it("creates, lists, patches and deletes", async () => {
    const created = await call("POST", "/api/schedule/items", item);
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const list = await call("GET", "/api/schedule?from=2026-11-01&to=2026-11-30");
    expect(list.status).toBe(200);
    expect((list.json.items as Array<{ id: string }>).map((i) => i.id)).toContain(id);
    const patched = await call("PATCH", `/api/schedule/items/${id}`, { status: "done" });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ status: "done" });
    expect((await call("DELETE", `/api/schedule/items/${id}`)).json).toEqual({ ok: true });
    const after = await call("GET", "/api/schedule?from=2026-11-01&to=2026-11-30");
    expect((after.json.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(id);
  });

  it("answers 400 for bad input", async () => {
    expect((await call("POST", "/api/schedule/items", { ...item, date: "2026-02-30" })).status).toBe(400);
    expect((await call("POST", "/api/schedule/items", { ...item, start: "25:00" })).status).toBe(400);
    expect((await call("GET", "/api/schedule?from=2026-11-05&to=2026-11-01")).status).toBe(400);
    expect((await call("GET", "/api/schedule?from=2026-11-01&to=2026-12-13")).status).toBe(400);
    expect((await call("GET", "/api/schedule?from=2026-11-01&to=2026-12-12")).status).toBe(200);
    expect((await call("GET", "/api/schedule?from=nope&to=2026-11-01")).status).toBe(400);
    expect((await call("GET", "/api/schedule")).status).toBe(400);
  });

  it("answers 404 for unknown ids", async () => {
    expect((await call("PATCH", "/api/schedule/items/sch_nope", { title: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/schedule/items/sch_nope")).status).toBe(404);
  });

  it("requires authentication", async () => {
    expect((await call("GET", "/api/schedule?from=2026-11-01&to=2026-11-02", undefined, {})).status).toBe(401);
  });

  it("does not take over /api/schedule/preview", async () => {
    const res = await call("GET", `/api/schedule/preview?${new URLSearchParams({ kind: "routine", weekdays: "1", time: "10:00" })}`);
    expect(res.status).toBe(200);
    expect(res.json).not.toHaveProperty("items");
    expect((await call("GET", "/api/schedule/preview")).status).toBe(400);
  });
});
