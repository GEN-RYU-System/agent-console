// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, cancelChatQueue, checkChatSend, clearSessionToken, fetchChat, fetchState, getSessionToken, logout, openSocket, queueChat, redeemCode, setSessionToken, uploadImage, wsUrl } from "./api";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const lastCall = (m: ReturnType<typeof vi.fn>) => (m.mock.calls as unknown as Array<[string, RequestInit]>).at(-1) as [string, RequestInit];

describe("session token storage", () => {
  it("lives in sessionStorage only (never a cookie or localStorage)", () => {
    setSessionToken("tok");
    expect(window.sessionStorage.getItem("ac.session")).toBe("tok");
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(getSessionToken()).toBe("tok");
    clearSessionToken();
    expect(getSessionToken()).toBeNull();
  });
});

describe("chat requests (v0.11.0)", () => {
  it("fetchChat asks for the items after `since`, and sends the epoch only when known", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchChat("s 1", 0, null);
    expect(lastCall(fetchMock)[0]).toBe("/api/sessions/s%201/chat?since=0");
    await fetchChat("s1", 7, "e/1");
    expect(lastCall(fetchMock)[0]).toBe("/api/sessions/s1/chat?since=7&epoch=e%2F1");
  });

  it("checkChatSend posts the text as JSON to chat/send-check", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "こんにちは", submitDelayMs: 2000 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkChatSend("s1", "こんにちは")).resolves.toEqual({ text: "こんにちは", submitDelayMs: 2000 });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/sessions/s1/chat/send-check");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "こんにちは" });
  });

  it("queueChat posts the text to chat/queue, and cancelChatQueue deletes the item (id is URL-encoded)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "q1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(queueChat("s1", "予約")).resolves.toEqual({ id: "q1" });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/sessions/s1/chat/queue");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "予約" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(cancelChatQueue("s 1", "q/1")).resolves.toEqual({ ok: true });
    const [delUrl, delInit] = lastCall(fetchMock);
    expect(delUrl).toBe("/api/sessions/s%201/chat/queue/q%2F1");
    expect(delInit.method).toBe("DELETE");
  });
});

describe("api requests", () => {
  it("sends the session token as a Bearer header and no token in the URL", async () => {
    setSessionToken("tok");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchState();
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/state");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("sends no Authorization header when there is no session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await fetchState();
  });

  it("throws ApiError carrying the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    await expect(fetchState()).rejects.toMatchObject({ status: 401, message: "unauthorized" });
    await expect(fetchState()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("redeemCode", () => {
  it("posts the code and returns the session token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "t1", expiresInSec: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await redeemCode("abc")).toBe("t1");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/pair/redeem");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "abc" });
  });

  it("rejects with the status on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid or expired code" }), { status: 401 })));
    await expect(redeemCode("x")).rejects.toMatchObject({ status: 401 });
  });
});

describe("logout", () => {
  it("calls the server and clears the token, even when the call fails", async () => {
    setSessionToken("tok");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
    expect(lastCall(fetchMock)[0]).toBe("/api/logout");
    expect(getSessionToken()).toBeNull();
  });
});

describe("WebSocket", () => {
  it("builds ws URLs without any token and drops the page query", () => {
    window.history.replaceState(null, "", "/?t=leaked&x=1");
    const url = wsUrl("/ws/term", { session: "abc" });
    expect(url).toMatch(/^ws:\/\/[^/]+\/ws\/term\?session=abc$/);
    expect(url).not.toContain("leaked");
  });

  it("authenticates with the ac.<token> subprotocol", () => {
    const calls: Array<[string, string[]]> = [];
    class Fake {
      constructor(url: string, protocols: string[]) {
        calls.push([url, protocols]);
      }
    }
    vi.stubGlobal("WebSocket", Fake);
    setSessionToken("tok");
    openSocket("/ws/events");
    expect(calls[0][1]).toEqual(["ac.tok"]);
    expect(calls[0][0]).not.toContain("tok");
    clearSessionToken();
    openSocket("/ws/events");
    expect(calls[1][1]).toEqual([]);
  });
});

describe("uploadImage (K4)", () => {
  it("POSTs the bytes as base64 in JSON to /api/uploads with the Bearer token, and returns the path", async () => {
    setSessionToken("tok");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "/d/uploads/x.png" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])], { type: "image/png" });
    await expect(uploadImage(blob)).resolves.toEqual({ path: "/d/uploads/x.png" });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/uploads");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ data: "iVBORw0KGgr/" });
  });

  it("encodes a large file without overflowing the call stack", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "/p" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const size = 3 * 1024 * 1024;
    await uploadImage(new Blob([new Uint8Array(size)]));
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as { data: string };
    expect(body.data.length).toBe((size / 3) * 4);
  });

  it("throws ApiError with the status when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "too large" }), { status: 413 })));
    await expect(uploadImage(new Blob([new Uint8Array([1])]))).rejects.toMatchObject({ status: 413 });
  });
});
