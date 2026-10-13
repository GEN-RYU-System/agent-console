import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeUsage } from "../../hooks/ac-statusline.mjs";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let h: Harness;
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function usage(auth = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}/api/usage`, { headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} });
  return { status: res.status, json: (await res.json()) as Json };
}
const file = () => path.join(h.config.dataDir, "usage.json");

beforeAll(async () => {
  h = await startHarness();
  mkdirSync(h.config.dataDir, { recursive: true });
});
afterAll(async () => {
  await h.close();
});

describe("K6/K8: GET /api/usage", () => {
  it("認証が要る", async () => {
    expect((await usage(false)).status).toBe(401);
  });
  it("usage.json が無ければ {status:'none'}", async () => {
    expect(await usage()).toEqual({ status: 200, json: { status: "none" } });
  });
  it("命令が書いた値を、そのまま {status:'ok', observedAt, fiveHour?, sevenDay?} で返す", async () => {
    writeUsage(h.config.dataDir, { fiveHour: { usedPercentage: 23, resetsAt: 1791887400 }, sevenDay: { usedPercentage: 41, resetsAt: 1792141200 } }, NOW);
    expect(await usage()).toEqual({
      status: 200,
      json: { status: "ok", observedAt: NOW, fiveHour: { usedPercentage: 23, resetsAt: 1791887400 }, sevenDay: { usedPercentage: 41, resetsAt: 1792141200 } },
    });
  });
  it("壊れていれば {status:'invalid'}。ファイルは書き換えない（読むだけ）", async () => {
    writeFileSync(file(), "{broken");
    expect(await usage()).toEqual({ status: 200, json: { status: "invalid" } });
    expect(readFileSync(file(), "utf8")).toBe("{broken");
  });
  it("書き込みの口は無い（POST は 404）", async () => {
    const res = await fetch(`${h.base}/api/usage`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(res.status).toBe(404);
  });
});
