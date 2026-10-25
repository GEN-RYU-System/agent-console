import { describe, expect, it } from "vitest";
import { createDiscordApi, type FetchFn } from "../../server/discord-api.ts";

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function fake(reply: { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; throws?: Error }): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    if (reply.throws) throw reply.throws;
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    const h = reply.headers ?? {};
    return { status: reply.status ?? 200, headers: { get: (n) => h[n] ?? null }, text: async () => text };
  };
  return { fetch: f, calls };
}
const TOKEN = "fake-token-marker";
const CH = "100000000000000003";
const msg = (over: Record<string, unknown> = {}) => ({ id: "100000000000000010", channel_id: CH, author: { id: "100000000000000004" }, content: "hello", timestamp: "2026-10-25T00:00:00.000000+00:00", type: 0, ...over });
const HOOK = "https://discord.com/api/webhooks/100000000000000001/fake_hook";

describe("listMessagesAfter", () => {
  it("builds the URL with limit=100, no after on first read, and a Bot header", async () => {
    const f = fake({ body: [msg()] });
    const r = await createDiscordApi(f.fetch).listMessagesAfter(TOKEN, CH, null);
    expect(r).toEqual({ ok: true, value: [msg()] });
    expect(f.calls[0]?.url).toBe(`https://discord.com/api/v10/channels/${CH}/messages?limit=100`);
    expect(f.calls[0]?.method).toBe("GET");
    expect(f.calls[0]?.headers.Authorization).toBe(`Bot ${TOKEN}`);
  });
  it("adds after when given", async () => {
    const f = fake({ body: [] });
    await createDiscordApi(f.fetch).listMessagesAfter(TOKEN, CH, "100000000000000009");
    expect(f.calls[0]?.url).toBe(`https://discord.com/api/v10/channels/${CH}/messages?limit=100&after=100000000000000009`);
  });
  it("keeps only the used fields", async () => {
    const f = fake({ body: [msg({ extra: "x", author: { id: "100000000000000004", bot: true, username: "n" }, webhook_id: "100000000000000007" })] });
    const r = await createDiscordApi(f.fetch).listMessagesAfter(TOKEN, CH, null);
    expect(r).toEqual({ ok: true, value: [msg({ author: { id: "100000000000000004", bot: true }, webhook_id: "100000000000000007" })] });
  });
  it("badJson for a non-array, a missing field, or non-JSON", async () => {
    for (const reply of [{ body: { a: 1 } }, { body: [msg({ id: undefined })] }, { body: [msg({ type: "0" })] }, { raw: "not json" }]) {
      expect(await createDiscordApi(fake(reply).fetch).listMessagesAfter(TOKEN, CH, null)).toEqual({ ok: false, kind: "failed", reason: "badJson" });
    }
  });
});

describe("failures are discriminated", () => {
  const call = (reply: Parameters<typeof fake>[0]) => createDiscordApi(fake(reply).fetch).getCurrentUser(TOKEN);
  it("429 prefers the body retry_after (seconds, fractional) and rounds up to ms", async () => {
    expect(await call({ status: 429, body: { retry_after: 1.5, global: false }, headers: { "Retry-After": "9" } })).toEqual({ ok: false, kind: "rateLimited", retryAfterMs: 1500 });
  });
  it("429 falls back to the Retry-After header", async () => {
    expect(await call({ status: 429, raw: "", headers: { "Retry-After": "3" } })).toEqual({ ok: false, kind: "rateLimited", retryAfterMs: 3000 });
  });
  it("429 with neither gives null", async () => {
    expect(await call({ status: 429, raw: "oops" })).toEqual({ ok: false, kind: "rateLimited", retryAfterMs: null });
  });
  it("401 / 403 / 404 / 500", async () => {
    expect(await call({ status: 401 })).toEqual({ ok: false, kind: "unauthorized" });
    expect(await call({ status: 403 })).toEqual({ ok: false, kind: "forbidden", status: 403 });
    expect(await call({ status: 404 })).toEqual({ ok: false, kind: "notFound", status: 404 });
    expect(await call({ status: 500 })).toEqual({ ok: false, kind: "failed", reason: "http", status: 500 });
  });
  it("network failure and timeout", async () => {
    expect(await call({ throws: new Error("ECONNRESET secret-marker") })).toEqual({ ok: false, kind: "failed", reason: "network" });
    const t = new Error("t");
    t.name = "TimeoutError";
    expect(await call({ throws: t })).toEqual({ ok: false, kind: "failed", reason: "timeout" });
  });
  it("badJson for a 200 with a wrong shape", async () => {
    expect(await call({ body: { nope: 1 } })).toEqual({ ok: false, kind: "failed", reason: "badJson" });
  });
});

describe("getChannel / getCurrentUser", () => {
  it("returns guild_id, or null when missing / null (not badJson)", async () => {
    const api = (body: unknown) => createDiscordApi(fake({ body }).fetch).getChannel(TOKEN, CH);
    expect(await api({ id: CH, guild_id: "100000000000000002" })).toEqual({ ok: true, value: { guild_id: "100000000000000002" } });
    expect(await api({ id: CH })).toEqual({ ok: true, value: { guild_id: null } });
    expect(await api({ id: CH, guild_id: null })).toEqual({ ok: true, value: { guild_id: null } });
  });
  it("uses the right URLs", async () => {
    const f = fake({ body: { id: "100000000000000001" } });
    await createDiscordApi(f.fetch).getCurrentUser(TOKEN);
    expect(f.calls[0]?.url).toBe("https://discord.com/api/v10/users/@me");
    const g = fake({ body: {} });
    await createDiscordApi(g.fetch).getChannel(TOKEN, CH);
    expect(g.calls[0]?.url).toBe(`https://discord.com/api/v10/channels/${CH}`);
  });
});

describe("executeWebhook", () => {
  it("posts with wait=true, no Authorization, content cut at 2000, no mentions", async () => {
    const f = fake({ status: 200, body: { id: "x" } });
    const r = await createDiscordApi(f.fetch).executeWebhook(HOOK, "あ".repeat(2500));
    expect(r).toEqual({ ok: true, value: null });
    expect(f.calls[0]?.url).toBe(`${HOOK}?wait=true`);
    expect(f.calls[0]?.method).toBe("POST");
    expect(f.calls[0]?.headers.Authorization).toBeUndefined();
    expect(f.calls[0]?.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(f.calls[0]?.body ?? "{}") as { content: string; allowed_mentions: { parse: string[] } };
    expect(body.content).toHaveLength(2000);
    expect(body.allowed_mentions.parse).toEqual([]);
  });
  it("204 is a failure (wait is not in effect)", async () => {
    expect(await createDiscordApi(fake({ status: 204 }).fetch).executeWebhook(HOOK, "x")).toEqual({ ok: false, kind: "failed", reason: "http", status: 204 });
  });
});

describe("host check", () => {
  it("does not call fetch for a non-discord.com host", async () => {
    const f = fake({ status: 200 });
    const api = createDiscordApi(f.fetch);
    expect(await api.executeWebhook("https://evil.example/api/webhooks/1/a", "x")).toEqual({ ok: false, kind: "failed", reason: "badHost" });
    expect(await api.executeWebhook("https://discordapp.com/api/webhooks/1/a", "x")).toEqual({ ok: false, kind: "failed", reason: "badHost" });
    expect(await api.executeWebhook("not a url", "x")).toEqual({ ok: false, kind: "failed", reason: "badHost" });
    expect(f.calls).toHaveLength(0);
  });
});
