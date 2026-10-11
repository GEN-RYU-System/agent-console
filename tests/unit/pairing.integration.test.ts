import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PAIRING_TTL_MS, SESSION_MAX_MS } from "../../server/auth.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

interface Raw {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function raw(pathAndQuery: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: h.port, path: pathAndQuery, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function newCode(): Promise<string> {
  const res = await raw("/api/pair", { method: "POST", headers: bearer });
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { code: string }).code;
}

/** ペアリングしてセッション Cookie（name=value）を得る。 */
async function pairedCookie(): Promise<string> {
  const res = await raw(`/pair?code=${await newCode()}`);
  expect(res.status).toBe(303);
  const setCookie = (res.headers["set-cookie"] as string[])[0];
  return setCookie.split(";")[0];
}

function wsStatus(pathAndQuery: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${pathAndQuery}`, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => undefined);
  });
}

describe("/healthz", () => {
  it("answers 200 ok without authentication", async () => {
    const res = await raw("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("checks the Host header", async () => {
    expect((await raw("/healthz", { headers: { Host: "evil.example" } })).status).toBe(421);
    expect((await raw("/healthz", { headers: { Host: `localhost:${h.port}` } })).status).toBe(421);
  });
});

describe("?t= is gone", () => {
  it("is rejected for API and WebSocket", async () => {
    expect((await raw(`/api/state?t=${TOKEN}`)).status).toBe(401);
    expect(await wsStatus(`/ws/events?t=${TOKEN}`, { Origin: h.base })).toBe(401);
  });
});

describe("POST /api/pair", () => {
  it("needs the server secret as Bearer", async () => {
    expect((await raw("/api/pair", { method: "POST" })).status).toBe(401);
    expect((await raw("/api/pair", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("cannot be called with a session cookie (no self-renewal)", async () => {
    const cookie = await pairedCookie();
    const res = await raw("/api/pair", { method: "POST", headers: { Cookie: cookie, Origin: h.base } });
    expect(res.status).toBe(401);
  });

  it("returns a one-time code that lives 30 seconds", async () => {
    const res = await raw("/api/pair", { method: "POST", headers: bearer });
    const body = JSON.parse(res.body) as { code: string; expiresInSec: number };
    expect(body.code).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSec).toBe(30);
  });
});

describe("GET /pair", () => {
  it("consumes the code, sets an HttpOnly / SameSite=Strict / Path=/ cookie and redirects to /", async () => {
    const res = await raw(`/pair?code=${await newCode()}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    const cookie = (res.headers["set-cookie"] as string[])[0];
    expect(cookie).toMatch(/^ac_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400$/);
    expect(cookie).not.toMatch(/Secure/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("answers 401 (with the SPA page for the guidance screen) for a reused code", async () => {
    const code = await newCode();
    expect((await raw(`/pair?code=${code}`)).status).toBe(303);
    const again = await raw(`/pair?code=${code}`);
    expect(again.status).toBe(401);
    expect(again.body).toContain("index");
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("answers 401 for an expired code (31 seconds)", async () => {
    const code = await newCode();
    h.clock.advance(PAIRING_TTL_MS + 1000);
    expect((await raw(`/pair?code=${code}`)).status).toBe(401);
  });

  it("answers 401 for a missing, wrong or secret-valued code", async () => {
    expect((await raw("/pair")).status).toBe(401);
    expect((await raw("/pair?code=nope")).status).toBe(401);
    expect((await raw(`/pair?code=${TOKEN}`)).status).toBe(401);
  });

  it("checks the Host header", async () => {
    expect((await raw(`/pair?code=${await newCode()}`, { headers: { Host: "evil.example" } })).status).toBe(421);
  });
});

describe("session cookie authentication", () => {
  it("authenticates API reads", async () => {
    const cookie = await pairedCookie();
    expect((await raw("/api/state", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await raw("/api/state", { headers: { Cookie: "ac_session=wrong" } })).status).toBe(401);
  });

  it("expires after 24 hours", async () => {
    const cookie = await pairedCookie();
    h.clock.advance(SESSION_MAX_MS + 1000);
    expect((await raw("/api/state", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it.each(["POST", "DELETE"])("requires an own Origin for %s (missing or foreign is 403)", async (method) => {
    const cookie = await pairedCookie();
    const target = method === "POST" ? "/api/ledger/refresh" : "/api/sessions/none";
    const base = { Cookie: cookie, "Content-Type": "application/json" };
    expect((await raw(target, { method, headers: base })).status).toBe(403);
    expect((await raw(target, { method, headers: { ...base, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await raw(target, { method, headers: { ...base, Origin: "null" } })).status).toBe(403);
    // 自分の Origin なら Origin 検査を通る（DELETE は存在しない ID なので 404、POST は 200）
    const ok = await raw(target, { method, headers: { ...base, Origin: h.base } });
    expect(ok.status).toBe(method === "POST" ? 200 : 404);
  });

  it("does not require an Origin for Bearer calls (CLI)", async () => {
    expect((await raw("/api/ledger/refresh", { method: "POST", headers: bearer })).status).toBe(200);
  });

  it("authenticates WebSockets and still requires the Origin", async () => {
    const cookie = await pairedCookie();
    expect(await wsStatus("/ws/events", { Cookie: cookie, Origin: h.base })).toBe(101);
    expect(await wsStatus("/ws/events", { Cookie: cookie })).toBe(403);
    expect(await wsStatus("/ws/events", { Cookie: cookie, Origin: "http://evil.example" })).toBe(403);
    expect(await wsStatus("/ws/events", { Origin: h.base })).toBe(401);
  });
});

describe("/api/state", () => {
  it("includes the app version for the footer", async () => {
    const res = await raw("/api/state", { headers: bearer });
    expect((JSON.parse(res.body) as { appVersion: string }).appVersion).toBe("9.9.9");
  });
});
