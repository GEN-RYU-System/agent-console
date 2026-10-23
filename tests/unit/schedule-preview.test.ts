import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

interface Reply { status: number; json: Record<string, unknown> }
const send = (port: number, method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json: Record<string, unknown> = {}; try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 本文なし */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

const MIN = 60_000;
const date = new Date(Date.now() + 3 * 24 * 60 * MIN).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const q = (o: Record<string, string>): string => `/api/schedule/preview?${new URLSearchParams(o)}`;
const auditLines = (h: Harness): number => { const f = path.join(h.config.dataDir, "routine-audit.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0; };

describe("GET /api/schedule/preview", () => {
  let h: Harness;
  const ui = (method: string, url: string, body?: unknown) => send(h.port, method, url, { Authorization: `Bearer ${TOKEN}` }, body);
  const getPreview = (o: Record<string, string>) => ui("GET", q(o));
  beforeAll(async () => {
    h = await startHarness();
    expect((await ui("POST", "/api/reservations", { name: "resv", roleId: "echo", cwd: h.config.salesanchorRoot, date, time: "10:00", promptText: "p" })).status).toBe(201);
    expect((await ui("POST", "/api/routines", { name: "rout", roleId: "echo", cwd: h.config.salesanchorRoot, weekdays: [0, 1, 2, 3, 4, 5, 6], timeHHmm: "16:00", promptText: "p", enabled: true })).status).toBe(201);
  }, 30_000);
  afterAll(async () => { await h.close(); });

  it("V1 no auth gives 401", async () => {
    expect((await send(h.port, "GET", q({ kind: "reservation", date, time: "10:30" }), {})).status).toBe(401);
  });

  it("V2 reservation: overlap, no overlap, bad date", async () => {
    const hit = await getPreview({ kind: "reservation", date, time: "10:30" });
    expect(hit.status).toBe(200);
    expect(hit.json).toMatchObject({ ready: true, overlap: { name: "resv", kind: "reservation", at: `${date}T10:00+09:00` } });
    const none = await getPreview({ kind: "reservation", date, time: "12:00" });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ ready: true, overlap: null });
    expect((await getPreview({ kind: "reservation", date: "2026-13-40", time: "12:00" })).status).toBe(400);
    expect((await getPreview({ kind: "reservation", date, time: "25:00" })).status).toBe(400);
  });

  it("V3 routine: overlap, no overlap, excludeId, and bad inputs", async () => {
    const list = await ui("GET", "/api/routines");
    const id = (list.json.items as Array<{ id: string }>)[0].id;
    const hit = await getPreview({ kind: "routine", weekdays: "1,2", time: "16:30" });
    expect(hit.status).toBe(200);
    expect(hit.json).toMatchObject({ ready: true, overlap: { name: "rout", kind: "routine" } });
    expect((await getPreview({ kind: "routine", weekdays: "1,2", time: "18:00" })).json).toEqual({ ready: true, overlap: null });
    expect((await getPreview({ kind: "routine", weekdays: "1,2", time: "16:30", excludeId: id })).json).toEqual({ ready: true, overlap: null });
    expect((await getPreview({ kind: "routine", weekdays: "", time: "16:30" })).json).toEqual({ ready: true, overlap: null });
    expect((await getPreview({ kind: "routine", weekdays: "7", time: "16:30" })).status).toBe(400);
    expect((await getPreview({ kind: "routine", weekdays: "1,1", time: "16:30" })).status).toBe(400);
    expect((await getPreview({ kind: "routine", weekdays: "1", time: "24:00" })).status).toBe(400);
    expect((await getPreview({ kind: "routine", weekdays: "1", time: "16:30", excludeId: "x".repeat(201) })).status).toBe(400);
    expect((await getPreview({ kind: "x", time: "16:30" })).status).toBe(400);
  });

  it("V4 calling it changes no reservation, routine or audit row", async () => {
    const before = { r: h.reservations.list().length, t: h.routines.list().length, a: auditLines(h) };
    await getPreview({ kind: "reservation", date, time: "10:30" });
    await getPreview({ kind: "routine", weekdays: "1", time: "16:30" });
    expect({ r: h.reservations.list().length, t: h.routines.list().length, a: auditLines(h) }).toEqual(before);
  });
});
