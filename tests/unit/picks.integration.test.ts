import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PICKER_ORIGIN, PICKER_TOKEN, startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

let h: Harness;
let rowsFile: string;
let sessionId = "";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
const UUID_A = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pick(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://example.com/p",
    title: "題名",
    selector: "#root > p",
    tag: "p",
    attrs: { id: "x" },
    text: "本文",
    html: '<p id="x">本文</p>',
    style: { "font-size": "14px" },
    rect: { x: 1, y: 2, w: 3, h: 4 },
    dpr: 2,
    vw: 1200,
    imageBase64: PNG.toString("base64"),
    ...over,
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: Record<string, unknown>;
}

/** fetch では Host・Origin を自由に付けられないので、素の http で送る。 */
function raw(method: string, p: string, headers: Record<string, string>, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: h.port, method, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        } catch {
          /* 画像など */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json });
      });
    });
    req.on("error", (e) => {
      // 本文が大きすぎて先に 403 を返されたときは接続が切られることがある
      if ((e as { code?: string }).code === "EPIPE" || (e as { code?: string }).code === "ECONNRESET") resolve({ status: -1, headers: {}, body: Buffer.alloc(0), json: {} });
      else reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const extHeaders = (over: Record<string, string> = {}): Record<string, string> => ({
  Origin: PICKER_ORIGIN,
  "x-ac-picker-token": PICKER_TOKEN,
  "Content-Type": "application/json",
  ...over,
});
const ingest = (body: unknown, headers: Record<string, string> = extHeaders()): Promise<Reply> =>
  raw("POST", "/api/picks", { Host: `127.0.0.1:${h.port}`, ...headers }, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
const authed = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const api = (method: string, p: string, body?: unknown): Promise<Reply> =>
  raw(method, p, { ...authed, Host: `127.0.0.1:${h.port}` }, body === undefined ? undefined : JSON.stringify(body));
const items = (r: Reply): Array<Record<string, unknown>> => r.json.items as Array<Record<string, unknown>>;

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-picks-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, maxSessions: 8, pickMaxKeep: 5, pickSendMaxBytes: 6000, pickHtmlInPromptChars: 300 });
  const created = await api("POST", "/api/sessions", { name: "picks-s", roleId: "echo" });
  sessionId = created.json.id as string;
});
afterAll(async () => {
  await h.close();
});

const setClaude = (status: string): void => {
  const pid = h.sessions.get(sessionId)?.term.pid as number;
  writeFileSync(rowsFile, JSON.stringify([{ pid, status, name: "n", sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/", startedAt: 1 }]));
};

describe("K6: who may send a pick", () => {
  it("accepts the fixed extension origin with the right token and JSON, with no Bearer token, and answers 201 with a UUID", async () => {
    const res = await ingest(pick());
    expect(res.status).toBe(201);
    expect(res.json.id).toMatch(UUID_A);
    await api("DELETE", `/api/picks/${res.json.id as string}`);
  });

  it("answers 403 for a wrong or missing Origin (the app's own origin, another extension, a web page, none)", async () => {
    for (const origin of [`http://127.0.0.1:${h.port}`, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "https://evil.example", "chrome-extension://cifnedlggndeehoejlfapbhepekgikaoX", undefined]) {
      const headers = extHeaders();
      if (origin === undefined) delete headers.Origin;
      else headers.Origin = origin;
      expect((await ingest(pick(), headers)).status, String(origin)).toBe(403);
    }
  });

  it("answers 403 for a missing, wrong or differently sized token", async () => {
    for (const token of [undefined, "", "x", "ab".repeat(31), "cd".repeat(32), `${PICKER_TOKEN}0`]) {
      const headers = extHeaders();
      if (token === undefined) delete headers["x-ac-picker-token"];
      else headers["x-ac-picker-token"] = token;
      expect((await ingest(pick(), headers)).status, String(token)).toBe(403);
    }
  });

  it("answers 403 when the content type is not JSON", async () => {
    expect((await ingest(JSON.stringify(pick()), extHeaders({ "Content-Type": "text/plain" }))).status).toBe(403);
    expect((await ingest(JSON.stringify(pick()), extHeaders({ "Content-Type": "application/x-www-form-urlencoded" }))).status).toBe(403);
  });

  it("takes bodies up to 2MiB (more than the usual 64KiB) and answers 403 above that", async () => {
    const midSize = Buffer.from(JSON.stringify(pick({ imageBase64: Buffer.concat([PNG, Buffer.alloc(300 * 1024, 1)]).toString("base64") })));
    expect(midSize.length).toBeGreaterThan(64 * 1024);
    const ok = await ingest(midSize);
    expect(ok.status).toBe(201);
    await api("DELETE", `/api/picks/${ok.json.id as string}`);
    const huge = Buffer.from(JSON.stringify(pick({ text: "x", imageError: "y".repeat(2 * 1024 * 1024) })));
    const res = await ingest(huge);
    expect([403, -1]).toContain(res.status);
    expect((await api("GET", "/api/picks")).json.items).toEqual([]);
  });

  it("answers 400 for a body the extension signed correctly but that is not a pick", async () => {
    expect((await ingest({ url: "javascript:alert(1)" })).status).toBe(400);
    expect((await ingest("{not json")).status).toBe(400);
    expect((await ingest(pick({ text: "あ".repeat(501) }))).status).toBe(400);
  });

  it("a Bearer token alone does not open the endpoint (it is for the extension only)", async () => {
    expect((await raw("POST", "/api/picks", { ...authed, Host: `127.0.0.1:${h.port}` }, JSON.stringify(pick()))).status).toBe(403);
  });

  it("everything else under /api/picks needs the Bearer token: GET list, image, PUT, DELETE, mark-sent, send-check", async () => {
    const bare = { Host: `127.0.0.1:${h.port}`, "Content-Type": "application/json" };
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [m, p] of [
      ["GET", "/api/picks"],
      ["GET", `/api/picks/${id}/image`],
      ["PUT", `/api/picks/${id}`],
      ["DELETE", `/api/picks/${id}`],
      ["POST", "/api/picks/mark-sent"],
      ["POST", `/api/sessions/${sessionId}/picks/send-check`],
      ["OPTIONS", "/api/picks"],
    ] as const) {
      const res = await raw(m, p, bare, m === "GET" || m === "OPTIONS" ? undefined : "{}");
      expect(res.status, `${m} ${p}`).toBe(401);
    }
    // 拡張の Origin と合言葉を付けても、受け取り口以外は開かない
    const withExt = await raw("GET", "/api/picks", { Host: `127.0.0.1:${h.port}`, ...extHeaders() });
    expect(withExt.status).toBe(401);
  });

  it("a request to the endpoint with a foreign Host is refused (421) like every other route", async () => {
    expect((await raw("POST", "/api/picks", { ...extHeaders(), Host: "evil.example" }, JSON.stringify(pick()))).status).toBe(421);
  });

  it("answers no CORS headers at all", async () => {
    const res = await ingest(pick());
    expect(Object.keys(res.headers).filter((k) => k.toLowerCase().startsWith("access-control"))).toEqual([]);
    await api("DELETE", `/api/picks/${res.json.id as string}`);
  });

  it("answers 403 to everything when the picker is not set up (token null)", async () => {
    const off = await startHarness({ picker: { extensionOrigin: PICKER_ORIGIN, token: null, extensionDir: "/x" } });
    try {
      const res = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: off.port, method: "POST", path: "/api/picks", agent: false, headers: { Host: `127.0.0.1:${off.port}`, ...extHeaders() } }, (r) => resolve(r.statusCode ?? 0));
        req.on("error", reject);
        req.end(JSON.stringify(pick()));
      });
      expect(res).toBe(403);
    } finally {
      await off.close();
    }
  });
});

describe("K2, K8: what is saved and what the screen can read", () => {
  let id = "";
  it("saves the JSON and PNG under picks/ with 700/600, and lists the pick with all fields", async () => {
    const created = await ingest(pick({ title: "保存する題名" }));
    id = created.json.id as string;
    const dir = path.join(h.config.dataDir, "picks");
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.png`]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, `${id}.png`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, `${id}.png`)).equals(PNG)).toBe(true);
    const list = await api("GET", "/api/picks");
    expect(list.status).toBe(200);
    expect(list.json.extensionDir).toBe(path.join(h.config.dataDir, "chrome-extension"));
    const got = items(list).find((p) => p.id === id) as Record<string, unknown>;
    expect(got).toMatchObject({ url: "https://example.com/p", title: "保存する題名", selector: "#root > p", tag: "p", attrs: { id: "x" }, text: "本文", html: '<p id="x">本文</p>', style: { "font-size": "14px" }, rect: { x: 1, y: 2, w: 3, h: 4 }, dpr: 2, vw: 1200, hasImage: true, note: "" });
  });

  it("serves the image as image/png with no-store, and 404 for a pick without an image", async () => {
    const res = await api("GET", `/api/picks/${id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.equals(PNG)).toBe(true);
    const noImage = (await ingest(pick({ imageBase64: undefined }))).json.id as string;
    expect((await api("GET", `/api/picks/${noImage}/image`)).status).toBe(404);
    await api("DELETE", `/api/picks/${noImage}`);
  });

  it("drops an image that is not a PNG, saves the pick with imageError", async () => {
    const r = await ingest(pick({ imageBase64: Buffer.from("not a png at all").toString("base64") }));
    expect(r.status).toBe(201);
    const got = items(await api("GET", "/api/picks")).find((p) => p.id === r.json.id) as Record<string, unknown>;
    expect(got.hasImage).toBe(false);
    expect(String(got.imageError)).toMatch(/png/i);
    await api("DELETE", `/api/picks/${r.json.id as string}`);
  });

  it("answers 400 for an id that is not a UUID on image, PUT and DELETE", async () => {
    for (const bad of ["abc", "0b6f1c0e", "0B6F1C0E-5D2A-4B7E-9A31-8C2F4D1E7A90", "abc.png", "x%00y"]) {
      expect((await api("GET", `/api/picks/${bad}/image`)).status, `image ${bad}`).toBe(400);
      expect((await api("PUT", `/api/picks/${bad}`, { note: "x" })).status, `put ${bad}`).toBe(400);
      expect((await api("DELETE", `/api/picks/${bad}`)).status, `delete ${bad}`).toBe(400);
    }
  });

  it("never reads outside picks/ for a dot-dot id (the URL is normalised away from the route: 404, nothing leaks)", async () => {
    for (const bad of ["..", "%2e%2e", "..%2f..%2fsecret"]) {
      const res = await api("GET", `/api/picks/${bad}/image`);
      expect([400, 404], bad).toContain(res.status);
      expect(res.body.toString("utf8")).not.toContain("TOP-SECRET");
    }
  });

  it("answers 404 for a UUID that does not exist", async () => {
    expect((await api("PUT", "/api/picks/00000000-0000-4000-8000-000000000000", { note: "x" })).status).toBe(404);
  });

  it("writes the note, and deletes the pick with its two files", async () => {
    expect((await api("PUT", `/api/picks/${id}`, { note: "ここを青に" })).status).toBe(200);
    expect(items(await api("GET", "/api/picks")).find((p) => p.id === id)?.note).toBe("ここを青に");
    expect((await api("PUT", `/api/picks/${id}`, { note: "a\u001bb" })).status).toBe(400);
    expect((await api("DELETE", `/api/picks/${id}`)).status).toBe(200);
    expect(readdirSync(path.join(h.config.dataDir, "picks"))).toEqual([]);
  });

  it("keeps only pickMaxKeep (5 here) of the newest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await ingest(pick({ title: `n${i}` }))).json.id as string);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(items(await api("GET", "/api/picks")).map((p) => p.title)).toEqual(["n6", "n5", "n4", "n3", "n2"]);
    for (const x of ids.slice(2)) await api("DELETE", `/api/picks/${x}`);
  });
});

describe("the unsent count in the state (§3-3)", () => {
  it("is picksUnsent in /api/state and follows arrivals, marking as sent, and deletion", async () => {
    const state = async (): Promise<number> => ((await api("GET", "/api/state")).json.picksUnsent as number);
    expect(await state()).toBe(0);
    const a = (await ingest(pick())).json.id as string;
    const b = (await ingest(pick())).json.id as string;
    expect(await state()).toBe(2);
    expect((await api("POST", "/api/picks/mark-sent", { ids: [a] })).status).toBe(200);
    expect(await state()).toBe(1);
    await api("DELETE", `/api/picks/${b}`);
    expect(await state()).toBe(0);
    await api("DELETE", `/api/picks/${a}`);
  });
});

describe("K3, K4, K7: send-check and mark-sent", () => {
  let a = "";
  let b = "";
  beforeAll(async () => {
    a = (await ingest(pick({ title: "一つ目" }))).json.id as string;
    b = (await ingest(pick({ title: "二つ目", imageBase64: undefined }))).json.id as string;
    await api("PUT", `/api/picks/${a}`, { note: "一つ目の指示" });
    await api("PUT", `/api/picks/${b}`, { note: "二つ目の指示" });
  });

  it("K7: refuses with 409 and the reason while Claude is working or waiting", async () => {
    for (const status of ["busy", "waiting"]) {
      setClaude(status);
      const res = await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: [a] });
      expect(res.status, status).toBe(409);
      expect(String(res.json.error)).toContain(status);
    }
  });

  it("returns one request text, the ids and the submit delay when Claude is idle; the picks stay unsent until mark-sent", async () => {
    setClaude("idle");
    const res = await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: [a, b] });
    expect(res.status).toBe(200);
    expect(res.json.ids).toEqual([a, b]);
    expect(res.json.submitDelayMs).toBe(h.config.pasteSubmitDelayMs);
    const text = String(res.json.text);
    const nonce = /<<<REFERENCE-([0-9a-f]{12})/.exec(text)?.[1] as string;
    expect(nonce).toBeTruthy();
    expect(text).toContain(`INSTRUCTION-${nonce}>>>`);
    expect(text).toContain(`画像: ${path.join(h.config.dataDir, "picks", `${a}.png`)}`);
    expect(text).toContain("[部品1] 一つ目の指示");
    expect(text).toContain("[部品2] 二つ目の指示");
    expect(text).toContain("HTML（先頭300字）");
    expect(items(await api("GET", "/api/picks")).every((p) => p.sentAt === undefined)).toBe(true);
    const marked = await api("POST", "/api/picks/mark-sent", { ids: [a, b, "00000000-0000-4000-8000-000000000000"] });
    expect(marked.status).toBe(200);
    expect(items(await api("GET", "/api/picks")).every((p) => typeof p.sentAt === "number")).toBe(true);
  });

  it("makes a different random suffix every time", async () => {
    setClaude("idle");
    const t1 = String((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: [a] })).json.text);
    const t2 = String((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: [a] })).json.text);
    expect(/REFERENCE-([0-9a-f]{12})/.exec(t1)?.[1]).not.toBe(/REFERENCE-([0-9a-f]{12})/.exec(t2)?.[1]);
  });

  it("400 for no ids, ids that are not UUIDs, or too many; 404 for an unknown pick or session", async () => {
    setClaude("idle");
    expect((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: [] })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: ["../x"] })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, {})).status).toBe(400);
    expect((await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(404);
    expect((await api("POST", "/api/sessions/00000000-0000-4000-8000-000000000000/picks/send-check", { ids: [a] })).status).toBe(404);
    expect((await api("POST", "/api/picks/mark-sent", { ids: "x" })).status).toBe(400);
  });

  it("400 when the text would be over pickSendMaxBytes (6000 here)", async () => {
    setClaude("idle");
    const bigIds: string[] = [];
    for (let i = 0; i < 3; i++) bigIds.push((await ingest(pick({ html: "あ".repeat(400), text: "い".repeat(400), title: `big${i}` }))).json.id as string);
    const res = await api("POST", `/api/sessions/${sessionId}/picks/send-check`, { ids: bigIds });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/too long/);
  });
});
