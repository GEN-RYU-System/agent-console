import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAIRING_TTL_MS } from "../../server/auth.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const MAX = 4096;
let h: Harness;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 9)]);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

function raw(method: string, p: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: h.port, method, path: p, headers: { Host: `127.0.0.1:${h.port}`, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          /* 本文なし */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", (e) => {
      if ((e as { code?: string }).code === "EPIPE" || (e as { code?: string }).code === "ECONNRESET") resolve({ status: -1, json: {} });
      else reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = { "Content-Type": "application/json" };
const bearer = { Authorization: `Bearer ${TOKEN}`, ...json };
const upload = (data: unknown, headers: Record<string, string> = bearer): Promise<Reply> => raw("POST", "/api/uploads", headers, JSON.stringify({ data }));
const b64 = (b: Buffer): string => b.toString("base64");
const uploadsDir = (): string => path.join(h.config.dataDir, "uploads");

beforeAll(async () => {
  h = await startHarness({ uploadMaxBytes: MAX, uploadMaxKeep: 3 });
});
afterAll(async () => {
  await h.close();
});

describe("POST /api/uploads (K4/K5)", () => {
  it("saves a PNG and a JPEG, answers 201 with an absolute path under dataDir/uploads (mode 600)", async () => {
    const a = await upload(b64(PNG));
    const b = await upload(b64(JPEG));
    expect([a.status, b.status]).toEqual([201, 201]);
    const pa = a.json.path as string;
    expect(path.isAbsolute(pa)).toBe(true);
    expect(path.dirname(pa)).toBe(uploadsDir());
    expect(pa.endsWith(".png")).toBe(true);
    expect((b.json.path as string).endsWith(".jpg")).toBe(true);
    expect(readFileSync(pa).equals(PNG)).toBe(true);
    expect(statSync(pa).mode & 0o777).toBe(0o600);
  });

  it("answers 400 for a non-image, bad base64, a missing field and a non-string", async () => {
    const before = readdirSync(uploadsDir()).length;
    expect((await upload(b64(Buffer.from("hello world, not an image")))).status).toBe(400);
    expect((await upload("***not base64***")).status).toBe(400);
    expect((await upload("")).status).toBe(400);
    expect((await upload(123)).status).toBe(400);
    expect((await raw("POST", "/api/uploads", bearer, JSON.stringify({}))).status).toBe(400);
    expect(readdirSync(uploadsDir()).length).toBe(before);
  });

  it("answers 413 above uploadMaxBytes, and still accepts a body at exactly the limit", async () => {
    const over = Buffer.concat([PNG, Buffer.alloc(MAX - PNG.length + 1, 1)]);
    const exact = Buffer.concat([PNG, Buffer.alloc(MAX - PNG.length, 1)]);
    expect((await upload(b64(over))).status).toBe(413);
    expect((await upload(b64(exact))).status).toBe(201);
    // 本文そのものが大きすぎる場合（base64 の上限を十分に超える）も 413
    expect((await upload("A".repeat(MAX * 4))).status).toBe(413);
  });

  it("keeps only uploadMaxKeep (3 here) files", async () => {
    for (let i = 0; i < 5; i++) expect((await upload(b64(PNG))).status).toBe(201);
    expect(readdirSync(uploadsDir()).filter((n) => /\.(png|jpg)$/.test(n))).toHaveLength(3);
  });
});

describe("POST /api/uploads sits inside the existing auth (K6)", () => {
  it("401 without a credential and with a wrong one", async () => {
    expect((await upload(b64(PNG), json)).status).toBe(401);
    expect((await upload(b64(PNG), { ...json, Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("403 for a session token without an allowed Origin, and 201 with the app's own Origin", async () => {
    const session = h.auth.consumePairingCode(h.auth.issuePairingCode(PAIRING_TTL_MS)) as string;
    const headers = { ...json, Authorization: `Bearer ${session}` };
    expect((await upload(b64(PNG), headers)).status).toBe(403);
    expect((await upload(b64(PNG), { ...headers, Origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(b64(PNG), { ...headers, Origin: `http://127.0.0.1:${h.port}` })).status).toBe(201);
  });
});

describe("/api/state hands the screen the two values it needs (4. SSOT)", () => {
  it("returns terminalSmoothScrollMs and uploadMaxBytes from the config", async () => {
    const r = await raw("GET", "/api/state", bearer);
    expect(r.status).toBe(200);
    expect(r.json.terminalSmoothScrollMs).toBe(125);
    expect(r.json.uploadMaxBytes).toBe(MAX);
  });
});
