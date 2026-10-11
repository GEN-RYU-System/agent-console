import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CHALLENGE_TTL_MS, PAIRING_TTL_MS, SESSION_MAX_MS } from "../../server/auth.ts";
import { clientProof, serverProof } from "../../server/pair-proof.ts";
import { COMMIT, startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

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

const seenSetCookie: string[] = [];

function raw(pathAndQuery: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: h.port, path: pathAndQuery, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.headers["set-cookie"]) seenSetCookie.push(String(res.headers["set-cookie"]));
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const json = { "Content-Type": "application/json" };
const bearer = { Authorization: `Bearer ${TOKEN}`, ...json };
const post = (path: string, body: unknown, headers: Record<string, string> = json) =>
  raw(path, { method: "POST", headers, body: JSON.stringify(body) });
const CNONCE = "ab".repeat(16);

/** launcher と同じ手順（チャレンジ → サーバー証明の検証 → クライアント証明）でペアリングコードを得る。 */
async function newCode(): Promise<string> {
  const ch = await post("/api/pair/challenge", { cnonce: CNONCE });
  expect(ch.status).toBe(200);
  const { snonce, proof } = JSON.parse(ch.body) as { snonce: string; proof: string };
  expect(proof).toBe(serverProof(TOKEN, CNONCE, snonce));
  const res = await post("/api/pair", { cnonce: CNONCE, snonce, proof: clientProof(TOKEN, CNONCE, snonce) });
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { code: string }).code;
}

async function sessionToken(): Promise<string> {
  const res = await post("/api/pair/redeem", { code: await newCode() }, { ...json, Origin: h.base });
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { token: string }).token;
}

function wsStatus(headers: Record<string, string>, protocols?: string[]): Promise<{ status: number; protocol?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/events`, protocols, { headers });
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on("open", () => {
      const protocol = ws.protocol;
      ws.close();
      resolve({ status: 101, protocol });
    });
    ws.on("error", () => undefined);
  });
}

describe("/healthz", () => {
  it("answers 200 with ok, version and commit without authentication", async () => {
    const res = await raw("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ ok: true, version: "9.9.9", commit: COMMIT }));
  });

  it("checks the Host header", async () => {
    expect((await raw("/healthz", { headers: { Host: "evil.example" } })).status).toBe(421);
    expect((await raw("/healthz", { headers: { Host: `localhost:${h.port}` } })).status).toBe(421);
  });
});

describe("?t= and cookies are gone", () => {
  it("?t= is rejected for API and WebSocket", async () => {
    expect((await raw(`/api/state?t=${TOKEN}`)).status).toBe(401);
    expect((await wsStatus({ Origin: h.base })).status).toBe(401);
  });

  it("never sets a cookie, on any response", async () => {
    const token = await sessionToken();
    await raw("/", {});
    await raw("/pair?code=x");
    await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } });
    await raw("/healthz");
    await post("/api/pair/redeem", { code: "nope" }, { ...json, Origin: h.base });
    expect(seenSetCookie).toEqual([]);
  });
});

describe("mutual authentication endpoints", () => {
  it("POST /api/pair/challenge returns snonce and the server proof, without any authentication", async () => {
    const res = await post("/api/pair/challenge", { cnonce: CNONCE });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { snonce: string; proof: string };
    expect(body.snonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.proof).toBe(serverProof(TOKEN, CNONCE, body.snonce));
    // 長期秘密は応答のどこにも出ない
    expect(res.body).not.toContain(TOKEN);
  });

  it("rejects a malformed cnonce with 400", async () => {
    expect((await post("/api/pair/challenge", { cnonce: "zz" })).status).toBe(400);
    expect((await post("/api/pair/challenge", {})).status).toBe(400);
    expect((await post("/api/pair/challenge", [])).status).toBe(400);
  });

  it("POST /api/pair no longer accepts the secret as Bearer (abolished)", async () => {
    expect((await raw("/api/pair", { method: "POST", headers: bearer, body: "{}" })).status).toBe(401);
    expect((await raw("/api/pair", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "" })).status).toBe(400);
  });

  it("rejects a wrong client proof, and the snonce cannot be retried", async () => {
    const ch = JSON.parse((await post("/api/pair/challenge", { cnonce: CNONCE })).body) as { snonce: string };
    expect((await post("/api/pair", { cnonce: CNONCE, snonce: ch.snonce, proof: "00".repeat(32) })).status).toBe(401);
    expect((await post("/api/pair", { cnonce: CNONCE, snonce: ch.snonce, proof: clientProof(TOKEN, CNONCE, ch.snonce) })).status).toBe(401);
  });

  it("rejects the server proof presented as the client proof", async () => {
    const ch = JSON.parse((await post("/api/pair/challenge", { cnonce: CNONCE })).body) as { snonce: string; proof: string };
    expect((await post("/api/pair", { cnonce: CNONCE, snonce: ch.snonce, proof: ch.proof })).status).toBe(401);
  });

  it("expires the snonce after 30 seconds", async () => {
    const ch = JSON.parse((await post("/api/pair/challenge", { cnonce: CNONCE })).body) as { snonce: string };
    h.clock.advance(CHALLENGE_TTL_MS + 1000);
    expect((await post("/api/pair", { cnonce: CNONCE, snonce: ch.snonce, proof: clientProof(TOKEN, CNONCE, ch.snonce) })).status).toBe(401);
  });

  it("checks the Host header", async () => {
    expect((await post("/api/pair/challenge", { cnonce: CNONCE }, { ...json, Host: "evil.example" })).status).toBe(421);
  });
});

describe("redeeming a pairing code", () => {
  it("returns a session token (12 hours) once, then 401 for a reused code", async () => {
    const code = await newCode();
    const first = await post("/api/pair/redeem", { code }, { ...json, Origin: h.base });
    expect(first.status).toBe(200);
    const body = JSON.parse(first.body) as { token: string; expiresInSec: number };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSec).toBe(12 * 60 * 60);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const again = await post("/api/pair/redeem", { code }, { ...json, Origin: h.base });
    expect(again.status).toBe(401);
    expect(again.headers["cache-control"]).toBe("no-store");
  });

  it("answers 401 for an expired code (31 seconds)", async () => {
    const code = await newCode();
    h.clock.advance(PAIRING_TTL_MS + 1000);
    expect((await post("/api/pair/redeem", { code }, { ...json, Origin: h.base })).status).toBe(401);
  });

  it("answers 401 for wrong codes and for the long-term secret", async () => {
    for (const code of ["", "nope", TOKEN]) expect((await post("/api/pair/redeem", { code }, { ...json, Origin: h.base })).status).toBe(401);
  });

  it("requires an own Origin (browser flow) and checks the Host", async () => {
    const code = await newCode();
    expect((await post("/api/pair/redeem", { code })).status).toBe(403);
    expect((await post("/api/pair/redeem", { code }, { ...json, Origin: "http://evil.example" })).status).toBe(403);
    expect((await post("/api/pair/redeem", { code }, { ...json, Origin: h.base, Host: "evil.example" })).status).toBe(421);
    // 拒否された試行ではコードは消費されない
    expect((await post("/api/pair/redeem", { code }, { ...json, Origin: h.base })).status).toBe(200);
  });

  it("serves the SPA at /pair (the page redeems the code itself) and never redeems on GET", async () => {
    const code = await newCode();
    const page = await raw(`/pair?code=${code}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("index");
    // GET では消費されない（まだ引換えできる）
    expect((await post("/api/pair/redeem", { code }, { ...json, Origin: h.base })).status).toBe(200);
  });
});

describe("session token authentication", () => {
  it("authenticates API reads as Bearer", async () => {
    const token = await sessionToken();
    expect((await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await raw("/api/state", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("expires after 12 hours", async () => {
    const token = await sessionToken();
    h.clock.advance(SESSION_MAX_MS + 1000);
    expect((await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it.each(["POST", "DELETE"])("requires an own Origin for %s (missing or foreign is 403)", async (method) => {
    const token = await sessionToken();
    const target = method === "POST" ? "/api/ledger/refresh" : "/api/sessions/none";
    const base = { Authorization: `Bearer ${token}`, ...json };
    expect((await raw(target, { method, headers: base })).status).toBe(403);
    expect((await raw(target, { method, headers: { ...base, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await raw(target, { method, headers: { ...base, Origin: "null" } })).status).toBe(403);
    const ok = await raw(target, { method, headers: { ...base, Origin: h.base } });
    expect(ok.status).toBe(method === "POST" ? 200 : 404);
  });

  it("does not require an Origin for the long-term secret (CLI)", async () => {
    expect((await raw("/api/ledger/refresh", { method: "POST", headers: bearer })).status).toBe(200);
  });

  it("authenticates WebSockets by the ac.<token> subprotocol, echoes it, and still requires the Origin", async () => {
    const token = await sessionToken();
    const ok = await wsStatus({ Origin: h.base }, [`ac.${token}`]);
    expect(ok).toEqual({ status: 101, protocol: `ac.${token}` });
    expect((await wsStatus({}, [`ac.${token}`])).status).toBe(403);
    expect((await wsStatus({ Origin: "http://evil.example" }, [`ac.${token}`])).status).toBe(403);
    expect((await wsStatus({ Origin: h.base }, ["ac.wrong"])).status).toBe(401);
    expect((await wsStatus({ Origin: h.base }, [token])).status).toBe(401);
  });

  it("logout revokes the session on the server", async () => {
    const token = await sessionToken();
    const auth = { Authorization: `Bearer ${token}`, ...json, Origin: h.base };
    expect((await raw("/api/logout", { method: "POST", headers: auth })).status).toBe(200);
    expect((await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await wsStatus({ Origin: h.base }, [`ac.${token}`])).status).toBe(401);
    expect((await raw("/api/logout", { method: "POST", headers: auth })).status).toBe(401);
  });

  it("logout needs a session (the long-term secret cannot log out)", async () => {
    expect((await raw("/api/logout", { method: "POST", headers: bearer })).status).toBe(400);
  });
});

describe("/api/state", () => {
  it("includes the app version and the commit for the footer", async () => {
    const res = await raw("/api/state", { headers: bearer });
    const body = JSON.parse(res.body) as { appVersion: string; commit: string };
    expect(body.appVersion).toBe("9.9.9");
    expect(body.commit).toBe(COMMIT);
  });
});
