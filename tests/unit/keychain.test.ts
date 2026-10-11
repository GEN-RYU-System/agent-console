import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readKeychainSecret } from "../../server/keychain.ts";
import { resolveSecret, securityBinFor } from "../../server/secret.ts";

const SECRET = "ab".repeat(32);

function stub(body: string): { bin: string; argvLog: string } {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-kc-")));
  const bin = path.join(dir, "security");
  const argvLog = path.join(dir, "argv.log");
  writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argvLog}'\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, argvLog };
}

describe("readKeychainSecret", () => {
  it("runs find-generic-password for service agent-console / account server and returns the trimmed secret", async () => {
    const { bin, argvLog } = stub(`echo "${SECRET}"`);
    expect(await readKeychainSecret(bin)).toBe(SECRET);
    expect(readFileSync(argvLog, "utf8").trim()).toBe("find-generic-password -s agent-console -a server -w");
  });

  it("fails when the command fails, without echoing its output", async () => {
    const { bin } = stub(`echo "partial-${SECRET}" ; echo "denied" >&2; exit 44`);
    await expect(readKeychainSecret(bin)).rejects.toThrow(/keychain/i);
    await readKeychainSecret(bin).catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });

  it("fails when the secret is empty or malformed", async () => {
    await expect(readKeychainSecret(stub("echo").bin)).rejects.toThrow(/keychain/i);
    await expect(readKeychainSecret(stub('echo "short"').bin)).rejects.toThrow(/keychain/i);
    await expect(readKeychainSecret(stub('echo "bad chars here!!bad chars here!!bad chars here!!"').bin)).rejects.toThrow(/keychain/i);
  });

  it("fails when the binary does not exist", async () => {
    await expect(readKeychainSecret("/nonexistent/security")).rejects.toThrow(/keychain/i);
  });
});

describe("resolveSecret", () => {
  it("uses the keychain when AGENT_CONSOLE_AUTH=keychain", async () => {
    const { bin } = stub(`echo "${SECRET}"`);
    const r = await resolveSecret({ AGENT_CONSOLE_AUTH: "keychain", AC_SECURITY: bin, AC_STUB_LOG: "1" });
    expect(r).toEqual({ token: SECRET, mode: "keychain" });
  });

  it("refuses to start when keychain mode cannot read the secret", async () => {
    const { bin } = stub("exit 44");
    await expect(resolveSecret({ AGENT_CONSOLE_AUTH: "keychain", AC_SECURITY: bin, AC_STUB_LOG: "1" })).rejects.toThrow(/keychain/i);
  });

  it("refuses an ambiguous setup (keychain mode plus a fixed token)", async () => {
    const { bin } = stub(`echo "${SECRET}"`);
    await expect(
      resolveSecret({ AGENT_CONSOLE_AUTH: "keychain", AC_SECURITY: bin, AC_STUB_LOG: "1", AGENT_CONSOLE_TOKEN: "a".repeat(40) }),
    ).rejects.toThrow(/AGENT_CONSOLE/);
  });

  it("rejects unknown AGENT_CONSOLE_AUTH values", async () => {
    await expect(resolveSecret({ AGENT_CONSOLE_AUTH: "file" })).rejects.toThrow(/AGENT_CONSOLE_AUTH/);
  });

  it("falls back to the per-start random secret (dev) and the fixed e2e token", async () => {
    const dev = await resolveSecret({});
    expect(dev.mode).toBe("random");
    expect(dev.token).toMatch(/^[0-9a-f]{64}$/);
    const fixed = await resolveSecret({ AGENT_CONSOLE_TOKEN: "Fixed_token-0123456789012345678901234567" });
    expect(fixed.mode).toBe("fixed");
  });
});

describe("securityBinFor (no override in production)", () => {
  it("ignores AC_SECURITY unless the test marker AC_STUB_LOG is set", () => {
    expect(securityBinFor({ AC_SECURITY: "/tmp/evil" })).toBe("/usr/bin/security");
    expect(securityBinFor({ AC_SECURITY: "/tmp/evil", AC_STUB_LOG: "" })).toBe("/usr/bin/security");
    expect(securityBinFor({})).toBe("/usr/bin/security");
  });

  it("uses AC_SECURITY in test mode", () => {
    expect(securityBinFor({ AC_SECURITY: "/tmp/stub", AC_STUB_LOG: "/tmp/log" })).toBe("/tmp/stub");
  });
});
