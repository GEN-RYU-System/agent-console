import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { disabledIntakeStatus, type DiscordIntakeStatus } from "../../server/discord-intake.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const get = (port: number, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/discord-intake/status", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 本文なし */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end();
  });

const closers: Harness[] = [];
afterAll(async () => { for (const h of closers) await h.close(); });

describe("GET /api/discord-intake/status", () => {
  it("認証なしは 401", async () => {
    const h = await startHarness();
    closers.push(h);
    expect((await get(h.port, {})).status).toBe(401);
  });
  it("受け口を渡さないと notStarted（disabled）", async () => {
    const h = await startHarness();
    closers.push(h);
    const r = await get(h.port, { Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(JSON.parse(JSON.stringify(disabledIntakeStatus())));
    expect([r.json.state, r.json.reason]).toEqual(["disabled", "notStarted"]);
  });
  it("渡した受け口の status() をそのまま返す", async () => {
    const fake: DiscordIntakeStatus = { ...disabledIntakeStatus(), state: "running", reason: null, consecutiveFailures: 2 };
    const h = await startHarness({ discordIntake: { status: () => fake } });
    closers.push(h);
    const r = await get(h.port, { Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(JSON.parse(JSON.stringify(fake)));
  });
});
