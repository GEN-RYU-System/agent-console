// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchState, wsUrl } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("sends same-origin credentials and no Authorization header or token in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchState();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0];
    expect(url).toBe("/api/state");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("throws ApiError carrying the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    await expect(fetchState()).rejects.toMatchObject({ status: 401, message: "unauthorized" });
    await expect(fetchState()).rejects.toBeInstanceOf(ApiError);
  });

  it("builds ws URLs without any token and drops the page query", () => {
    window.history.replaceState(null, "", "/?t=leaked&x=1");
    const url = wsUrl("/ws/term", { session: "abc" });
    expect(url).toMatch(/^ws:\/\/[^/]+\/ws\/term\?session=abc$/);
    expect(url).not.toContain("leaked");
  });
});
