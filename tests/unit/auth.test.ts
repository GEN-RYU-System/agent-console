import { describe, expect, it } from "vitest";
import { createAuth } from "../../server/auth.ts";

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

  it("allows only 127.0.0.1:<port> and localhost:<port> as Host", () => {
    expect(auth.isHostAllowed("127.0.0.1:4319")).toBe(true);
    expect(auth.isHostAllowed("localhost:4319")).toBe(true);
    expect(auth.isHostAllowed("LOCALHOST:4319")).toBe(true);
    expect(auth.isHostAllowed("evil.example:4319")).toBe(false);
    expect(auth.isHostAllowed("127.0.0.1:9999")).toBe(false);
    expect(auth.isHostAllowed("127.0.0.1")).toBe(false);
    expect(auth.isHostAllowed(undefined)).toBe(false);
  });
});
