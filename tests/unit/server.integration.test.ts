import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SessionConflictError, SessionInputError } from "../../server/sessions.ts";
import { WorktreeError } from "../../server/worktree.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

interface RawResponse {
  status: number;
  body: string;
}

function raw(pathAndQuery: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: h.port, path: pathAndQuery, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function createSession(roleId: string, name = "s"): Promise<string> {
  const res = await raw("/api/sessions", { method: "POST", headers: authHeaders, body: JSON.stringify({ name, roleId }) });
  expect(res.status).toBe(201);
  return (JSON.parse(res.body) as { id: string }).id;
}

type WsResult = { status: number } | { ws: WebSocket; text: () => string };

function openWs(pathAndQuery: string, headers: Record<string, string>): Promise<WsResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${pathAndQuery}`, { headers });
    // バックログは open と同じ tick で届くことがあるため、メッセージ購読は作成直後に付ける
    let buf = "";
    ws.on("message", (d) => (buf += d.toString()));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on("open", () => resolve({ ws, text: () => buf }));
    ws.on("error", () => undefined);
  });
}

const goodWsHeaders = (): Record<string, string> => ({ Origin: h.base });

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("static serving", () => {
  it("serves index.html at / and as SPA fallback", async () => {
    expect((await raw("/")).body).toContain("index");
    expect((await raw("/some/route")).body).toContain("index");
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/a/../../secret.txt"])(
    "never serves files outside the static dir (%s)",
    async (p) => {
      const res = await raw(p);
      expect(res.body).not.toContain("TOP-SECRET");
    },
  );

  it("answers 400 for malformed percent-encoding", async () => {
    expect((await raw("/%E0%A4%A")).status).toBe(400);
  });
});

describe("Host header", () => {
  it("rejects an unexpected Host for static and API requests", async () => {
    expect((await raw("/", { headers: { Host: "evil.example" } })).status).toBe(421);
    expect((await raw("/api/state", { headers: { ...authHeaders, Host: "evil.example" } })).status).toBe(421);
  });

  it("accepts localhost:<port>", async () => {
    expect((await raw("/", { headers: { Host: `localhost:${h.port}` } })).status).toBe(200);
  });

  it("rejects an unexpected Host on WebSocket upgrade", async () => {
    const r = await openWs(`/ws/events?t=${TOKEN}`, { ...goodWsHeaders(), Host: "evil.example" });
    expect("status" in r && r.status).toBe(421);
  });
});

describe("API validation", () => {
  const post = (body: unknown, headers = authHeaders) =>
    raw("/api/sessions", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("requires a token", async () => {
    expect((await post({ name: "x", roleId: "echo" }, { "Content-Type": "application/json" } as never)).status).toBe(401);
  });

  it.each([
    [{ name: "", roleId: "echo" }],
    [{ name: "a".repeat(41), roleId: "echo" }],
    [{ name: "bad\u0007name", roleId: "echo" }],
    [{ name: "ok", roleId: "nope" }],
    [{ name: "ok", roleId: "wt", branch: "main" }],
    [{ name: 5, roleId: "echo" }],
  ])("rejects invalid input %j with 400", async (body) => {
    expect((await post(body)).status).toBe(400);
  });

  it("rejects malformed JSON and oversized bodies with 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ name: "x".repeat(70 * 1024), roleId: "echo" }))).status).toBe(400);
  });
});

describe("/ws/term", () => {
  it("rejects missing token (401) and wrong origin (403) and unknown session (404)", async () => {
    const id = await createSession("echo");
    const noToken = await openWs(`/ws/term?session=${id}`, goodWsHeaders());
    expect("status" in noToken && noToken.status).toBe(401);
    const badOrigin = await openWs(`/ws/term?session=${id}&t=${TOKEN}`, { Origin: "http://evil.example" });
    expect("status" in badOrigin && badOrigin.status).toBe(403);
    const unknown = await openWs(`/ws/term?session=nope&t=${TOKEN}`, goodWsHeaders());
    expect("status" in unknown && unknown.status).toBe(404);
  });

  it("streams output, accepts input, and replays the backlog to a new connection", async () => {
    const id = await createSession("echo");
    const first = await openWs(`/ws/term?session=${id}&t=${TOKEN}`, goodWsHeaders());
    if (!("ws" in first)) throw new Error("upgrade failed");
    const out = first;
    await waitFor(() => out.text().includes("READY"));
    first.ws.send(JSON.stringify({ type: "input", data: "ping-it\r" }));
    await waitFor(() => out.text().includes("ping-it"));
    first.ws.close();

    const second = await openWs(`/ws/term?session=${id}&t=${TOKEN}`, goodWsHeaders());
    if (!("ws" in second)) throw new Error("upgrade failed");
    const replay = second;
    await waitFor(() => replay.text().includes("READY") && replay.text().includes("ping-it"));
    second.ws.close();
  });

  it("closes only the offending connection on an oversized frame; the server and other sessions keep working", async () => {
    const victimId = await createSession("echo", "victim");
    const otherId = await createSession("echo", "other");
    const victim = await openWs(`/ws/term?session=${victimId}&t=${TOKEN}`, goodWsHeaders());
    const other = await openWs(`/ws/term?session=${otherId}&t=${TOKEN}`, goodWsHeaders());
    if (!("ws" in victim) || !("ws" in other)) throw new Error("upgrade failed");
    const otherOut = other;
    await waitFor(() => otherOut.text().includes("READY"));

    const closed = new Promise<number>((resolve) => victim.ws.on("close", (code) => resolve(code)));
    victim.ws.send("x".repeat(2 * 1024 * 1024));
    expect(await closed).toBe(1009);

    other.ws.send(JSON.stringify({ type: "input", data: "still-alive\r" }));
    await waitFor(() => otherOut.text().includes("still-alive"));
    expect((await raw("/api/state", { headers: authHeaders })).status).toBe(200);
    other.ws.close();
  });

  it("closes only the offending /ws/events connection on an oversized frame", async () => {
    const ev = await openWs(`/ws/events?t=${TOKEN}`, goodWsHeaders());
    if (!("ws" in ev)) throw new Error("upgrade failed");
    const closed = new Promise<number>((resolve) => ev.ws.on("close", (code) => resolve(code)));
    ev.ws.send("x".repeat(2 * 1024 * 1024));
    expect(await closed).toBe(1009);
    expect((await raw("/api/state", { headers: authHeaders })).status).toBe(200);
  });
});

describe("session lifecycle", () => {
  it("refuses to remove a running session (409) and removes a stopped one", async () => {
    const running = await createSession("echo", "running");
    expect((await raw(`/api/sessions/${running}`, { method: "DELETE", headers: authHeaders })).status).toBe(409);

    const stopped = await createSession("short", "stopped");
    await waitFor(() => h.sessions.get(stopped)?.exited === true);
    expect((await raw(`/api/sessions/${stopped}`, { method: "DELETE", headers: authHeaders })).status).toBe(200);
    expect(h.sessions.get(stopped)).toBeUndefined();
    expect((await raw(`/api/sessions/${stopped}`, { method: "DELETE", headers: authHeaders })).status).toBe(404);
  });

  it("reports a stopped session as stopped in the snapshot", async () => {
    const id = await createSession("short", "stopped2");
    await waitFor(() => h.sessions.get(id)?.exited === true);
    const snap = await h.hub.snapshot();
    expect(snap.sessions.find((s) => s.id === id)?.state).toBe("stopped");
  });
});

describe("session cap reservation", () => {
  it("counts a session being created (worktree in progress) against the cap", async () => {
    const small = await startHarness({ maxSessions: 1 });
    try {
      const results = await Promise.allSettled([
        small.sessions.create({ name: "a", roleId: "wt", branch: "release/aa" }),
        small.sessions.create({ name: "b", roleId: "wt", branch: "release/bb" }),
      ]);
      const reasons = results.map((r) => (r.status === "rejected" ? r.reason : null));
      expect(reasons.filter((r) => r instanceof SessionInputError && /too many/.test(r.message)).length).toBe(1);
      expect(reasons.filter((r) => r instanceof WorktreeError).length).toBe(1);
      // 予約は解放されている: 通常の役割は作れる
      await expect(small.sessions.create({ name: "c", roleId: "echo" })).resolves.toBeDefined();
    } finally {
      await small.close();
    }
  });

  it("exports a conflict error type used for 409", () => {
    expect(new SessionConflictError("x")).toBeInstanceOf(Error);
  });
});

describe("/api/ledger", () => {
  it("surfaces a missing lookup script as an error, not as unregistered cards", async () => {
    const res = await raw("/api/ledger/refresh", { method: "POST", headers: authHeaders });
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body) as { groups: { UNREGISTERED: unknown[] }; errors: { message: string }[] };
    expect(snap.errors.length).toBeGreaterThan(0);
    expect(snap.groups.UNREGISTERED).toEqual([]);
  });
});
