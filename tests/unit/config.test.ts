import { describe, expect, it } from "vitest";
import os from "node:os";
import { parseConfig } from "../../server/config.ts";

const valid = {
  port: 4319,
  salesanchorRoot: "~/salesanchor",
  newWorktreeScript: "scripts/new-worktree.sh",
  ledgerLookupScript: "scripts/ledger-lookup.sh",
  ledgerDir: ".claude-pipeline/active-work.d",
  claudeBin: "claude",
  agentsPollMs: 3000,
  ledgerPollMs: 60000,
  ringBufferBytes: 1048576,
  roles: [{ id: "shell", labelKey: "role.shell", command: ["/bin/zsh", "-i"], needsWorktree: false }],
};

describe("parseConfig", () => {
  it("expands ~ in salesanchorRoot", () => {
    expect(parseConfig(valid).salesanchorRoot).toBe(`${os.homedir()}/salesanchor`);
  });

  it("throws naming the missing key", () => {
    const { port: _port, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrow(/port/);
  });

  it("rejects a role with an empty command", () => {
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], command: [] }] })).toThrow(/command/);
  });

  it("rejects duplicate role ids", () => {
    expect(() => parseConfig({ ...valid, roles: [valid.roles[0], valid.roles[0]] })).toThrow(/duplicate/);
  });

  it("rejects non-object input", () => {
    expect(() => parseConfig(null)).toThrow();
  });
});
