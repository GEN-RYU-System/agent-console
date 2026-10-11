import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientProof, serverProof } from "../../server/pair-proof.ts";

const SCRIPT = path.join(process.cwd(), "ops", "launcher", "pair-proof.mjs");
const SECRET = "5ec0de".repeat(10) + "abcd";
const CNONCE = "ab".repeat(16);
const SNONCE = "cd".repeat(32);

function run(args: string[], stdin: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: "utf8" });
}

describe("ops/launcher/pair-proof.mjs matches the server implementation", () => {
  it("prints the client proof when the server proof is valid (secret via stdin)", () => {
    const r = run(["exchange", CNONCE, SNONCE, serverProof(SECRET, CNONCE, SNONCE)], SECRET);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(clientProof(SECRET, CNONCE, SNONCE));
  });

  it("exits non-zero and prints no proof when the server proof is wrong (impostor)", () => {
    const r = run(["exchange", CNONCE, SNONCE, serverProof("wrong-secret", CNONCE, SNONCE)], SECRET);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("rejects malformed arguments and never echoes the secret", () => {
    for (const args of [["exchange"], ["exchange", "zz", SNONCE, "aa"], ["bogus", CNONCE, SNONCE, "aa"]]) {
      const r = run(args, SECRET);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    }
  });

  it("fails on an empty secret", () => {
    expect(run(["exchange", CNONCE, SNONCE, serverProof("", CNONCE, SNONCE)], "").status).not.toBe(0);
  });

  it("takes no secret from argv (the script ignores extra arguments)", () => {
    const r = run(["exchange", CNONCE, SNONCE, serverProof(SECRET, CNONCE, SNONCE), SECRET], "");
    expect(r.status).not.toBe(0);
  });
});
