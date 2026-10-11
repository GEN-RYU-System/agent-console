import { describe, expect, it } from "vitest";
import { createAuth, resolveToken } from "../../server/auth.ts";

const auth = createAuth("secret-token", 4319);

describe("auth", () => {
  it("accepts the token in the query string", () => {
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/api/x?t=secret-token"), undefined)).toBe(true);
  });

  it("accepts the token as a Bearer header", () => {
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/api/x"), "Bearer secret-token")).toBe(true);
  });

  it("rejects a wrong or missing token", () => {
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/api/x?t=nope"), undefined)).toBe(false);
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/api/x"), undefined)).toBe(false);
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/api/x"), "Bearer nope")).toBe(false);
  });

  it("rejects tokens of a different length without throwing", () => {
    expect(auth.isTokenValid(new URL("http://127.0.0.1:4319/?t=s"), undefined)).toBe(false);
  });

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
