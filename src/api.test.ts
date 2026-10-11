// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearSessionToken, fetchState, getSessionToken, logout, openSocket, redeemCode, setSessionToken, wsUrl } from "./api";

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
