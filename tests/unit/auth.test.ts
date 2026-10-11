import { describe, expect, it } from "vitest";
import {
  createAuth,
  DEV_PAIRING_TTL_MS,
  PAIRING_TTL_MS,
  resolveToken,
  SESSION_MAX_MS,
  SESSION_COOKIE_NAME,
} from "../../server/auth.ts";

function makeAuth() {
  const clock = { t: 1_000_000 };
  const auth = createAuth("secret-token", 4319, { now: () => clock.t });
  return { auth, clock };
}

describe("authenticate (Bearer / Cookie)", () => {
  it("accepts the secret as a Bearer header", () => {
    const { auth } = makeAuth();
    expect(auth.authenticate({ authorization: "Bearer secret-token" })).toBe("bearer");
  });

  it("rejects wrong, missing and different-length secrets without throwing", () => {
    const { auth } = makeAuth();
    expect(auth.authenticate({ authorization: "Bearer nope" })).toBeNull();
    expect(auth.authenticate({ authorization: "Bearer s" })).toBeNull();
    expect(auth.authenticate({ authorization: "Basic secret-token" })).toBeNull();
    expect(auth.authenticate({})).toBeNull();
  });

  it("accepts a session cookie created by pairing, among other cookies", () => {
    const { auth } = makeAuth();
    const sessionId = auth.consumePairingCode(auth.issuePairingCode(PAIRING_TTL_MS));
    expect(sessionId).not.toBeNull();
    expect(auth.authenticate({ cookie: `a=1; ${SESSION_COOKIE_NAME}=${sessionId}; b=2` })).toBe("cookie");
    expect(auth.authenticate({ cookie: `${SESSION_COOKIE_NAME}=wrong` })).toBeNull();
    expect(auth.authenticate({ cookie: `other=${sessionId}` })).toBeNull();
  });

  it("expires a session after 24 hours", () => {
    const { auth, clock } = makeAuth();
    const sessionId = auth.consumePairingCode(auth.issuePairingCode(PAIRING_TTL_MS)) as string;
    clock.t += SESSION_MAX_MS - 1;
    expect(auth.authenticate({ cookie: `${SESSION_COOKIE_NAME}=${sessionId}` })).toBe("cookie");
    clock.t += 2;
    expect(auth.authenticate({ cookie: `${SESSION_COOKIE_NAME}=${sessionId}` })).toBeNull();
  });
});

describe("pairing codes", () => {
  it("are 64 hex characters and unique", () => {
    const { auth } = makeAuth();
    const a = auth.issuePairingCode(PAIRING_TTL_MS);
    const b = auth.issuePairingCode(PAIRING_TTL_MS);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("can be used once only", () => {
    const { auth } = makeAuth();
    const code = auth.issuePairingCode(PAIRING_TTL_MS);
    expect(auth.consumePairingCode(code)).not.toBeNull();
    expect(auth.consumePairingCode(code)).toBeNull();
  });

  it("expire after 30 seconds", () => {
    const { auth, clock } = makeAuth();
    const ok = auth.issuePairingCode(PAIRING_TTL_MS);
    const late = auth.issuePairingCode(PAIRING_TTL_MS);
    clock.t += PAIRING_TTL_MS - 1;
    expect(auth.consumePairingCode(ok)).not.toBeNull();
    clock.t += 2;
    expect(auth.consumePairingCode(late)).toBeNull();
  });

  it("use a 5 minute lifetime for the development log code", () => {
    expect(PAIRING_TTL_MS).toBe(30_000);
    expect(DEV_PAIRING_TTL_MS).toBe(300_000);
    const { auth, clock } = makeAuth();
    const code = auth.issuePairingCode(DEV_PAIRING_TTL_MS);
    clock.t += DEV_PAIRING_TTL_MS - 1;
    expect(auth.consumePairingCode(code)).not.toBeNull();
  });

  it("reject unknown, empty and malformed codes", () => {
    const { auth } = makeAuth();
    for (const c of ["", "x", "0".repeat(64), "g".repeat(64), "a".repeat(10000)]) expect(auth.consumePairingCode(c)).toBeNull();
  });

  it("do not authenticate as Bearer", () => {
    const { auth } = makeAuth();
    const code = auth.issuePairingCode(PAIRING_TTL_MS);
    expect(auth.authenticate({ authorization: `Bearer ${code}` })).toBeNull();
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Strict, Path=/, 24h, and not Secure (plain http on 127.0.0.1)", () => {
    const { auth } = makeAuth();
    const cookie = auth.sessionCookie("abc");
    expect(cookie).toBe(`${SESSION_COOKIE_NAME}=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    expect(cookie).not.toMatch(/Secure/i);
  });
});

describe("origin and host", () => {
  const { auth } = makeAuth();
  it("allows only the own origin", () => {
    expect(auth.isOriginAllowed("http://127.0.0.1:4319")).toBe(true);
    expect(auth.isOriginAllowed("http://evil.example")).toBe(false);
    expect(auth.isOriginAllowed("http://localhost:4319")).toBe(false);
    expect(auth.isOriginAllowed(undefined)).toBe(false);
  });

  it("allows only 127.0.0.1:<port> as Host (same as Origin; localhost is rejected)", () => {
    expect(auth.isHostAllowed("127.0.0.1:4319")).toBe(true);
    expect(auth.isHostAllowed("localhost:4319")).toBe(false);
    expect(auth.isHostAllowed("LOCALHOST:4319")).toBe(false);
    expect(auth.isHostAllowed("evil.example:4319")).toBe(false);
    expect(auth.isHostAllowed("127.0.0.1:9999")).toBe(false);
    expect(auth.isHostAllowed("127.0.0.1")).toBe(false);
    expect(auth.isHostAllowed(undefined)).toBe(false);
  });
});

describe("resolveToken", () => {
  it("generates a random 64-hex token when no fixed token is given", () => {
    const a = resolveToken({});
    const b = resolveToken({ AGENT_CONSOLE_TOKEN: "" });
    expect(a.fixed).toBe(false);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).not.toBe(a.token);
  });

  it("accepts a fixed token of 32+ characters from [A-Za-z0-9_-]", () => {
    const t = "Abc_def-0123456789012345678901234567";
    expect(resolveToken({ AGENT_CONSOLE_TOKEN: t })).toEqual({ token: t, fixed: true });
  });

  it("rejects short tokens and tokens with other characters", () => {
    expect(() => resolveToken({ AGENT_CONSOLE_TOKEN: "short" })).toThrow(/AGENT_CONSOLE_TOKEN/);
    expect(() => resolveToken({ AGENT_CONSOLE_TOKEN: "a".repeat(31) + "!" })).toThrow(/AGENT_CONSOLE_TOKEN/);
    expect(() => resolveToken({ AGENT_CONSOLE_TOKEN: "a".repeat(40) + " " })).toThrow(/AGENT_CONSOLE_TOKEN/);
  });

  it("never puts the token value in the error message", () => {
    try {
      resolveToken({ AGENT_CONSOLE_TOKEN: "secret!value" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret!value");
    }
  });
});
