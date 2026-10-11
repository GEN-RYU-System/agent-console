import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_MS,
  createAuth,
  DEV_PAIRING_TTL_MS,
  PAIRING_TTL_MS,
  resolveToken,
  SESSION_MAX_MS,
} from "../../server/auth.ts";
import { clientProof, serverProof } from "../../server/pair-proof.ts";

const SECRET = "secret-token";
const CNONCE = "ab".repeat(16);

function makeAuth() {
  const clock = { t: 1_000_000 };
  const auth = createAuth(SECRET, 4319, { now: () => clock.t });
  return { auth, clock };
}

function newSession(auth: ReturnType<typeof makeAuth>["auth"]): string {
  const token = auth.consumePairingCode(auth.issuePairingCode(PAIRING_TTL_MS));
  if (token === null) throw new Error("pairing failed");
  return token;
}

describe("authenticate (secret Bearer / session token)", () => {
  it("accepts the secret as a Bearer header (CLI, dev, tests)", () => {
    const { auth } = makeAuth();
    expect(auth.authenticate({ authorization: `Bearer ${SECRET}` })).toBe("bearer");
  });

  it("rejects wrong, missing and different-length secrets without throwing", () => {
    const { auth } = makeAuth();
    expect(auth.authenticate({ authorization: "Bearer nope" })).toBeNull();
    expect(auth.authenticate({ authorization: "Bearer s" })).toBeNull();
    expect(auth.authenticate({ authorization: `Basic ${SECRET}` })).toBeNull();
    expect(auth.authenticate({})).toBeNull();
  });

  it("accepts a session token as Bearer and as an ac.<token> WebSocket subprotocol", () => {
    const { auth } = makeAuth();
    const token = newSession(auth);
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toBe("session");
    expect(auth.authenticate({ protocols: [`ac.${token}`] })).toBe("session");
    expect(auth.authenticate({ protocols: ["other", `ac.${token}`] })).toBe("session");
    expect(auth.authenticate({ protocols: [`ac.wrong`] })).toBeNull();
    expect(auth.authenticate({ protocols: [token] })).toBeNull();
    expect(auth.sessionFromProtocols([`ac.${token}`])).toBe(`ac.${token}`);
    expect(auth.sessionFromProtocols(["x"])).toBeNull();
  });

  it("expires a session after 12 hours", () => {
    const { auth, clock } = makeAuth();
    expect(SESSION_MAX_MS).toBe(12 * 60 * 60 * 1000);
    const token = newSession(auth);
    clock.t += SESSION_MAX_MS - 1;
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toBe("session");
    clock.t += 2;
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toBeNull();
  });

  it("revokes a session on logout", () => {
    const { auth } = makeAuth();
    const token = newSession(auth);
    expect(auth.revokeSession(token)).toBe(true);
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toBeNull();
    expect(auth.revokeSession(token)).toBe(false);
  });

  it("has no cookie API any more", () => {
    const { auth } = makeAuth();
    expect((auth as unknown as Record<string, unknown>).sessionCookie).toBeUndefined();
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

  it("become invalid immediately after use", () => {
    const { auth } = makeAuth();
    const code = auth.issuePairingCode(PAIRING_TTL_MS);
    auth.consumePairingCode(code);
    expect(auth.consumePairingCode(code)).toBeNull();
  });
});

describe("pending challenge limit", () => {
  it("refuses new challenges when 64 are pending, without evicting the older ones", () => {
    const { auth, clock } = makeAuth();
    const first = auth.issueChallenge(CNONCE) as { snonce: string };
    for (let i = 1; i < 64; i++) expect(typeof auth.issueChallenge(CNONCE)).toBe("object");
    expect(auth.issueChallenge(CNONCE)).toBe("busy");
    // 最初のチャレンジは押し出されておらず、まだ使える
    expect(typeof auth.redeemChallenge({ cnonce: CNONCE, snonce: first.snonce, proof: clientProof(SECRET, CNONCE, first.snonce) })).toBe("string");
    // 1 つ空いたら受け付ける。期限が切れれば全部空く
    expect(typeof auth.issueChallenge(CNONCE)).toBe("object");
    clock.t += CHALLENGE_TTL_MS + 1;
    expect(typeof auth.issueChallenge(CNONCE)).toBe("object");
  });
});

describe("session helpers for WebSocket lifetime", () => {
  it("sessionTokenOf returns the session token (not the secret) from Bearer or subprotocol", () => {
    const { auth } = makeAuth();
    const token = newSession(auth);
    expect(auth.sessionTokenOf({ authorization: `Bearer ${token}` })).toBe(token);
    expect(auth.sessionTokenOf({ protocols: [`ac.${token}`] })).toBe(token);
    expect(auth.sessionTokenOf({ authorization: `Bearer ${SECRET}` })).toBeNull();
    expect(auth.sessionTokenOf({ authorization: "Bearer nope" })).toBeNull();
  });

  it("isSessionValid follows expiry and revocation, and revocation notifies listeners", () => {
    const { auth, clock } = makeAuth();
    const revoked: string[] = [];
    auth.onSessionRevoked((t) => revoked.push(t));
    const a = newSession(auth);
    const b = newSession(auth);
    expect(auth.isSessionValid(a)).toBe(true);
    auth.revokeSession(a);
    expect(auth.isSessionValid(a)).toBe(false);
    expect(revoked).toEqual([a]);
    clock.t += SESSION_MAX_MS + 1;
    expect(auth.isSessionValid(b)).toBe(false);
  });
});

describe("mutual authentication (challenge / proof)", () => {
  it("returns the server proof HMAC(secret, server|cnonce|snonce) so the client can verify the server", () => {
    const { auth } = makeAuth();
    const c = auth.issueChallenge(CNONCE);
    expect(typeof c).toBe("object");
    const ch = c as { snonce: string; proof: string };
    expect(ch.snonce).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.proof).toBe(serverProof(SECRET, CNONCE, ch.snonce));
  });

  it("accepts the client proof once, then issues a pairing code that redeems once", () => {
    const { auth } = makeAuth();
    const c = auth.issueChallenge(CNONCE) as { snonce: string };
    const code = auth.redeemChallenge({ cnonce: CNONCE, snonce: c.snonce, proof: clientProof(SECRET, CNONCE, c.snonce) });
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.consumePairingCode(code as string)).not.toBeNull();
  });

  it("consumes the snonce even when the proof is wrong (no retries)", () => {
    const { auth } = makeAuth();
    const c = auth.issueChallenge(CNONCE) as { snonce: string };
    expect(auth.redeemChallenge({ cnonce: CNONCE, snonce: c.snonce, proof: "00".repeat(32) })).toBeNull();
    expect(auth.redeemChallenge({ cnonce: CNONCE, snonce: c.snonce, proof: clientProof(SECRET, CNONCE, c.snonce) })).toBeNull();
  });

  it("rejects the server proof used as the client proof, and a different cnonce", () => {
    const { auth } = makeAuth();
    const c = auth.issueChallenge(CNONCE) as { snonce: string; proof: string };
    expect(auth.redeemChallenge({ cnonce: CNONCE, snonce: c.snonce, proof: c.proof })).toBeNull();
    const d = auth.issueChallenge(CNONCE) as { snonce: string };
    expect(auth.redeemChallenge({ cnonce: "cd".repeat(16), snonce: d.snonce, proof: clientProof(SECRET, "cd".repeat(16), d.snonce) })).toBeNull();
  });

  it("expires the snonce after 30 seconds", () => {
    const { auth, clock } = makeAuth();
    expect(CHALLENGE_TTL_MS).toBe(30_000);
    const c = auth.issueChallenge(CNONCE) as { snonce: string };
    clock.t += CHALLENGE_TTL_MS + 1;
    expect(auth.redeemChallenge({ cnonce: CNONCE, snonce: c.snonce, proof: clientProof(SECRET, CNONCE, c.snonce) })).toBeNull();
  });

  it("rejects malformed cnonce / snonce / proof input", () => {
    const { auth } = makeAuth();
    for (const bad of ["", "xyz", "g".repeat(32), "a".repeat(8), "a".repeat(500)]) expect(auth.issueChallenge(bad)).toBe("invalid");
    expect(auth.redeemChallenge({ cnonce: CNONCE, snonce: "nope", proof: "x" })).toBeNull();
  });

  it("a wrong secret yields a different server proof", () => {
    expect(serverProof("a", CNONCE, "b".repeat(64))).not.toBe(serverProof("c", CNONCE, "b".repeat(64)));
  });

  it("keeps the proof formats domain-separated (server| vs client|)", () => {
    expect(serverProof(SECRET, CNONCE, "ef".repeat(32))).not.toBe(clientProof(SECRET, CNONCE, "ef".repeat(32)));
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
