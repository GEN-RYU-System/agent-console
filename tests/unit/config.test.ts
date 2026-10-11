import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("accepts resumeScope with resumeCommand, and the shipped config pairs main with Opus and worktree with Sonnet", () => {
    const role = { ...valid.roles[0], resumeCommand: ["/bin/zsh", "-ic", "x"], resumeScope: "main" };
    expect(parseConfig({ ...valid, roles: [role] }).roles[0].resumeScope).toBe("main");
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect(shipped.roles.filter((r) => r.resumeScope !== undefined).map((r) => [r.id, r.resumeScope])).toEqual([
      ["opus-designer", "main"],
      ["sonnet-impl", "worktree"],
    ]);
    expect(shipped.roles.find((r) => r.id === "opus-designer")?.resumeCommand?.join(" ")).toContain('ccopusgo --resume "$AC_RESUME_ID"');
  });

  it("rejects a bad resumeScope, a resumeScope without resumeCommand, and two roles with the same scope", () => {
    const role = { ...valid.roles[0], resumeCommand: ["/bin/zsh", "-ic", "x"] };
    expect(() => parseConfig({ ...valid, roles: [{ ...role, resumeScope: "other" }] })).toThrow(/resumeScope/);
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], resumeScope: "main" }] })).toThrow(/resumeScope/);
    expect(() => parseConfig({ ...valid, roles: [{ ...role, resumeScope: "main" }, { ...role, id: "b", resumeScope: "main" }] })).toThrow(/duplicate resumeScope/);
  });

  it("rejects non-object input", () => {
    expect(() => parseConfig(null)).toThrow();
  });
});
