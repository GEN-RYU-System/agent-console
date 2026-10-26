import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  routineManagerRoles: ["shell"],
};

describe("parseConfig: salesanchorToolsRoot (ADR-1039 2b-2)", () => {
  it("defaults to ~/.salesanchor-tools, expands ~, and rejects an empty string or a number", () => {
    expect(parseConfig(valid).salesanchorToolsRoot).toBe(path.join(os.homedir(), ".salesanchor-tools"));
    expect(parseConfig({ ...valid, salesanchorToolsRoot: "~/x" }).salesanchorToolsRoot).toBe(path.join(os.homedir(), "x"));
    expect(() => parseConfig({ ...valid, salesanchorToolsRoot: "" })).toThrow(/salesanchorToolsRoot must be a non-empty string/);
    expect(() => parseConfig({ ...valid, salesanchorToolsRoot: 5 })).toThrow(/salesanchorToolsRoot must be a non-empty string/);
  });
});

describe("parseConfig: routineManagerRoles (ac-routine)", () => {
  const { routineManagerRoles: _r, ...rest } = valid;
  it("when not written: uses the default opus-designer only if it exists in roles; otherwise empty (everyone is refused) and startup is not blocked", () => {
    const withOpus = { ...rest, roles: [...valid.roles, { id: "opus-designer", labelKey: "role.opus", command: ["/bin/zsh", "-i"], needsWorktree: false }] };
    expect(parseConfig(withOpus).routineManagerRoles).toEqual(["opus-designer"]);
    expect(parseConfig(rest).routineManagerRoles).toEqual([]);
  });
  it("when written, an id that is not in roles is a startup error; so is a wrong shape", () => {
    expect(() => parseConfig({ ...valid, routineManagerRoles: ["nope"] })).toThrow(/routineManagerRoles has unknown role id nope/);
    expect(() => parseConfig({ ...valid, routineManagerRoles: "shell" })).toThrow(/routineManagerRoles/);
  });
});

describe("parseConfig: reserveRoles and role.reservable (v0.44.0)", () => {
  const { routineManagerRoles: _r, ...rest } = valid;
  it("when not written: uses the defaults that exist in roles (shell here); an empty result is allowed (everyone is refused)", () => {
    expect(parseConfig(rest).reserveRoles).toEqual(["shell"]);
    expect(parseConfig({ ...rest, roles: [{ id: "other", labelKey: "role.shell", command: ["/bin/zsh"], needsWorktree: false }] }).reserveRoles).toEqual([]);
  });
  it("when written, an id that is not in roles and a wrong shape are startup errors", () => {
    expect(parseConfig({ ...valid, reserveRoles: ["shell"] }).reserveRoles).toEqual(["shell"]);
    expect(() => parseConfig({ ...valid, reserveRoles: ["nope"] })).toThrow(/reserveRoles has unknown role id nope/);
    expect(() => parseConfig({ ...valid, reserveRoles: "shell" })).toThrow(/reserveRoles/);
  });
  it("reservable accepts a boolean only; false is kept, true or missing is not written", () => {
    const withRole = (extra: Record<string, unknown>) => ({ ...valid, roles: [{ ...valid.roles[0], ...extra }] });
    expect(parseConfig(withRole({ reservable: false })).roles[0].reservable).toBe(false);
    expect(parseConfig(withRole({ reservable: true })).roles[0].reservable).toBeUndefined();
    expect(parseConfig(withRole({})).roles[0].reservable).toBeUndefined();
    expect(() => parseConfig(withRole({ reservable: "no" }))).toThrow(/reservable must be boolean/);
  });
});

describe("parseConfig", () => {
  it("expands ~ in salesanchorRoot", () => {
    expect(parseConfig(valid).salesanchorRoot).toBe(`${os.homedir()}/salesanchor`);
  });

  it("throws naming the missing key", () => {
    const { port: _port, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrow(/port/);
  });

  it("accountLoginCommand は省略でき、あれば空でない文字列配列だけ受け付ける", () => {
    expect(parseConfig(valid).accountLoginCommand).toBeUndefined();
    expect(parseConfig({ ...valid, accountLoginCommand: ["/bin/zsh", "-ic", "x"] }).accountLoginCommand).toEqual(["/bin/zsh", "-ic", "x"]);
    expect(() => parseConfig({ ...valid, accountLoginCommand: [] })).toThrow(/accountLoginCommand/);
    expect(() => parseConfig({ ...valid, accountLoginCommand: "x" })).toThrow(/accountLoginCommand/);
  });

  it('予約済みの役割 id "account-login" は roles で使えない', () => {
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], id: "account-login" }] })).toThrow(/roles\[0\].id "account-login" is reserved/);
  });

  it("rejects a role with an empty command", () => {
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], command: [] }] })).toThrow(/command/);
  });

  it("rejects duplicate role ids", () => {
    expect(() => parseConfig({ ...valid, roles: [valid.roles[0], valid.roles[0]] })).toThrow(/duplicate/);
  });

  it("accepts resumeScope with resumeCommand, and the shipped config pairs main with Opus only", () => {
    const role = { ...valid.roles[0], resumeCommand: ["/bin/zsh", "-ic", "x"], resumeScope: "main" };
    expect(parseConfig({ ...valid, roles: [role] }).roles[0].resumeScope).toBe("main");
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect(shipped.roles.filter((r) => r.resumeScope !== undefined).map((r) => [r.id, r.resumeScope])).toEqual([
      ["opus-designer", "main"],
    ]);
    // K2/K3: 起動する命令は config 固定。id なしの --resume で Claude 公式の選択リストを開く（AC_RESUME_ID は使わない）
    expect(shipped.roles.find((r) => r.id === "opus-designer")?.resumeCommand).toEqual(["/bin/zsh", "-ic", "ccopusgo --resume"]);
  });

  it("accepts restoreCommand, and rejects an empty or non-string one", () => {
    const role = { ...valid.roles[0], restoreCommand: ["/bin/zsh", "-ic", "x"] };
    expect(parseConfig({ ...valid, roles: [role] }).roles[0].restoreCommand).toEqual(["/bin/zsh", "-ic", "x"]);
    expect(parseConfig(valid).roles[0].restoreCommand).toBeUndefined();
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], restoreCommand: [] }] })).toThrow(/restoreCommand/);
    expect(() => parseConfig({ ...valid, roles: [{ ...valid.roles[0], restoreCommand: [1] }] })).toThrow(/restoreCommand/);
  });

  it("restoreStaggerMs defaults to 3000, accepts 0, and rejects negatives and non-numbers", () => {
    expect(parseConfig(valid).restoreStaggerMs).toBe(3000);
    expect(parseConfig({ ...valid, restoreStaggerMs: 0 }).restoreStaggerMs).toBe(0);
    expect(parseConfig({ ...valid, restoreStaggerMs: 1500 }).restoreStaggerMs).toBe(1500);
    expect(() => parseConfig({ ...valid, restoreStaggerMs: -1 })).toThrow(/restoreStaggerMs/);
    expect(() => parseConfig({ ...valid, restoreStaggerMs: "3000" })).toThrow(/restoreStaggerMs/);
  });

  it("the shipped config passes the id as AC_RESUME_ID (quoted, never concatenated) for Opus, none for the shell, with a 3000 ms interval", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect(shipped.restoreStaggerMs).toBe(3000);
    expect(shipped.roles.find((r) => r.id === "opus-designer")?.restoreCommand).toEqual(["/bin/zsh", "-ic", 'ccopusgo --resume "$AC_RESUME_ID"']);
    expect(shipped.roles.find((r) => r.id === "sonnet-impl")).toBeUndefined();
    expect(shipped.roles.find((r) => r.id === "shell")?.restoreCommand).toBeUndefined();
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

  it("K2: terminalEnv defaults to empty and accepts valid variables", () => {
    expect(parseConfig(valid).terminalEnv).toEqual({});
    expect(parseConfig({ ...valid, terminalEnv: { LANG: "en_US.UTF-8", LC_ALL: "ja_JP.UTF-8" } }).terminalEnv).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "ja_JP.UTF-8" });
  });

  it("K2: the shipped config sets LANG to ja_JP.UTF-8", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect(shipped.terminalEnv).toEqual({ LANG: "ja_JP.UTF-8" });
  });

  it("K2: rejects empty, newline, non-string values and invalid keys in terminalEnv", () => {
    expect(() => parseConfig({ ...valid, terminalEnv: { LANG: "" } })).toThrow(/terminalEnv\.LANG/);
    expect(() => parseConfig({ ...valid, terminalEnv: { LANG: "ja_JP.UTF-8\n" } })).toThrow(/terminalEnv\.LANG/);
    expect(() => parseConfig({ ...valid, terminalEnv: { LANG: 1 } })).toThrow(/terminalEnv\.LANG/);
    expect(() => parseConfig({ ...valid, terminalEnv: { lang: "x" } })).toThrow(/terminalEnv key/);
    expect(() => parseConfig({ ...valid, terminalEnv: { "A=B": "x" } })).toThrow(/terminalEnv key/);
    expect(() => parseConfig({ ...valid, terminalEnv: ["LANG"] })).toThrow(/terminalEnv/);
    expect(() => parseConfig({ ...valid, terminalEnv: "LANG" })).toThrow(/terminalEnv/);
  });

  it("K2: rejects TERM and blocklisted keys in terminalEnv", () => {
    for (const key of ["TERM", "AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"]) {
      expect(() => parseConfig({ ...valid, terminalEnv: { [key]: "x" } })).toThrow(/cannot be set/);
    }
  });
});

describe("parseConfig: diff settings (K8, K12, K14)", () => {
  it("fills the defaults: origin/main, 1MiB, 16KiB, 2000ms", () => {
    const c = parseConfig(valid);
    expect([c.diffBaseRef, c.diffMaxFileBytes, c.diffSendMaxBytes, c.pasteSubmitDelayMs]).toEqual(["origin/main", 1024 * 1024, 16 * 1024, 2000]);
  });

  it("accepts explicit values", () => {
    const c = parseConfig({ ...valid, diffBaseRef: "refs/remotes/origin/develop", diffMaxFileBytes: 5000, diffSendMaxBytes: 6000, pasteSubmitDelayMs: 1500 });
    expect([c.diffBaseRef, c.diffMaxFileBytes, c.diffSendMaxBytes, c.pasteSubmitDelayMs]).toEqual(["refs/remotes/origin/develop", 5000, 6000, 1500]);
  });

  it("refuses to start with a diffBaseRef that could be read as an option or contains odd characters", () => {
    for (const bad of ["--output=/tmp/x", "-p", "", "origin main", "a;b", "$(x)", "a\nb", 5]) {
      expect(() => parseConfig({ ...valid, diffBaseRef: bad }), String(bad)).toThrow(/diffBaseRef/);
    }
  });

  it("refuses non-positive numbers", () => {
    for (const key of ["diffMaxFileBytes", "diffSendMaxBytes"]) {
      expect(() => parseConfig({ ...valid, [key]: 0 })).toThrow(new RegExp(key));
      expect(() => parseConfig({ ...valid, [key]: "1" })).toThrow(new RegExp(key));
    }
    expect(() => parseConfig({ ...valid, pasteSubmitDelayMs: -1 })).toThrow(/pasteSubmitDelayMs/);
  });

  it("the shipped config carries the same four values", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect([shipped.diffBaseRef, shipped.diffMaxFileBytes, shipped.diffSendMaxBytes, shipped.pasteSubmitDelayMs]).toEqual(["origin/main", 1048576, 16384, 2000]);
  });

  it("ghBin / prPollMs / prRefreshMinMs can be omitted (defaults gh / 120000 / 10000) and can be set", () => {
    const d = parseConfig(valid);
    expect([d.ghBin, d.prPollMs, d.prRefreshMinMs]).toEqual(["gh", 120000, 10000]);
    const c = parseConfig({ ...valid, ghBin: "/opt/homebrew/bin/gh", prPollMs: 30000, prRefreshMinMs: 5000 });
    expect([c.ghBin, c.prPollMs, c.prRefreshMinMs]).toEqual(["/opt/homebrew/bin/gh", 30000, 5000]);
  });

  it("refuses an empty or non-string ghBin and non-positive prPollMs / prRefreshMinMs", () => {
    for (const bad of ["", 5, null]) expect(() => parseConfig({ ...valid, ghBin: bad }), String(bad)).toThrow(/ghBin/);
    for (const key of ["prPollMs", "prRefreshMinMs"]) {
      for (const bad of [0, -1, "1", null]) expect(() => parseConfig({ ...valid, [key]: bad }), `${key}=${String(bad)}`).toThrow(new RegExp(key));
    }
  });

  it("the shipped config carries the three PR values", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect([shipped.ghBin, shipped.prPollMs, shipped.prRefreshMinMs]).toEqual(["gh", 120000, 10000]);
  });
});

describe("parseConfig: picker settings (§4)", () => {
  it("K8: fills the defaults when the three keys are omitted: 50 kept, 16KiB, 1500 chars", () => {
    const c = parseConfig(valid);
    expect([c.pickMaxKeep, c.pickSendMaxBytes, c.pickHtmlInPromptChars]).toEqual([50, 16 * 1024, 1500]);
  });

  it("accepts explicit values", () => {
    const c = parseConfig({ ...valid, pickMaxKeep: 3, pickSendMaxBytes: 4000, pickHtmlInPromptChars: 200 });
    expect([c.pickMaxKeep, c.pickSendMaxBytes, c.pickHtmlInPromptChars]).toEqual([3, 4000, 200]);
  });

  it("refuses non-positive or non-number values naming the key", () => {
    for (const key of ["pickMaxKeep", "pickSendMaxBytes", "pickHtmlInPromptChars"]) {
      expect(() => parseConfig({ ...valid, [key]: 0 })).toThrow(new RegExp(key));
      expect(() => parseConfig({ ...valid, [key]: "5" })).toThrow(new RegExp(key));
    }
  });

  it("the shipped config carries the same three values", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect([shipped.pickMaxKeep, shipped.pickSendMaxBytes, shipped.pickHtmlInPromptChars]).toEqual([50, 16384, 1500]);
  });
});

describe("parseConfig: activity settings (v0.8.0)", () => {
  it("K4: activityKeepDays の既定は 7。明示した値も通る。0 以下・数でない値は項目名つきで断る", () => {
    expect(parseConfig(valid).activityKeepDays).toBe(7);
    expect(parseConfig({ ...valid, activityKeepDays: 3 }).activityKeepDays).toBe(3);
    expect(() => parseConfig({ ...valid, activityKeepDays: 0 })).toThrow(/activityKeepDays/);
    expect(() => parseConfig({ ...valid, activityKeepDays: "7" })).toThrow(/activityKeepDays/);
  });

  it("K8: claudeSettingsPath の既定は ~/.claude/settings.json（~ は展開）。明示した場所も通る。空文字は断る", () => {
    expect(parseConfig(valid).claudeSettingsPath).toBe(`${os.homedir()}/.claude/settings.json`);
    expect(parseConfig({ ...valid, claudeSettingsPath: "/tmp/x/settings.json" }).claudeSettingsPath).toBe("/tmp/x/settings.json");
    expect(() => parseConfig({ ...valid, claudeSettingsPath: "" })).toThrow(/claudeSettingsPath/);
  });

  it("出荷時の config は activityKeepDays を 7 にしている", () => {
    expect(parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8"))).activityKeepDays).toBe(7);
  });
});

describe("parseConfig: terminalRenderer (v0.39.0)", () => {
  it("defaults to webgl when omitted", () => {
    expect(parseConfig(valid).terminalRenderer).toBe("webgl");
  });

  it("accepts dom and webgl", () => {
    expect(parseConfig({ ...valid, terminalRenderer: "dom" }).terminalRenderer).toBe("dom");
    expect(parseConfig({ ...valid, terminalRenderer: "webgl" }).terminalRenderer).toBe("webgl");
  });

  it("refuses any other value naming the key", () => {
    for (const bad of ["canvas", "", null, 1]) expect(() => parseConfig({ ...valid, terminalRenderer: bad }), String(bad)).toThrow(/terminalRenderer/);
  });
});

describe("parseConfig: terminal and upload settings (v0.7.0)", () => {
  it("K2/K5: fills the defaults when the three keys are omitted: 125ms, 5MiB, 100 kept", () => {
    const c = parseConfig(valid);
    expect([c.terminalSmoothScrollMs, c.uploadMaxBytes, c.uploadMaxKeep]).toEqual([125, 5 * 1024 * 1024, 100]);
  });

  it("accepts explicit values, and 0 for the smooth scroll (turns it off)", () => {
    const c = parseConfig({ ...valid, terminalSmoothScrollMs: 0, uploadMaxBytes: 1000, uploadMaxKeep: 3 });
    expect([c.terminalSmoothScrollMs, c.uploadMaxBytes, c.uploadMaxKeep]).toEqual([0, 1000, 3]);
  });

  it("refuses bad values naming the key", () => {
    for (const bad of [-1, "125", null, Number.NaN]) expect(() => parseConfig({ ...valid, terminalSmoothScrollMs: bad }), String(bad)).toThrow(/terminalSmoothScrollMs/);
    for (const key of ["uploadMaxBytes", "uploadMaxKeep"]) {
      for (const bad of [0, -1, "5", null]) expect(() => parseConfig({ ...valid, [key]: bad }), `${key}=${String(bad)}`).toThrow(new RegExp(key));
    }
  });

  it("the shipped config carries the same three values", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    expect([shipped.terminalSmoothScrollMs, shipped.uploadMaxBytes, shipped.uploadMaxKeep]).toEqual([125, 5242880, 100]);
  });

  it("the shipped config says terminalRenderer webgl explicitly", () => {
    expect(JSON.parse(readFileSync("agent-console.config.json", "utf8")).terminalRenderer).toBe("webgl");
  });
});

describe("parseConfig: maxSessions (window-limit 便1)", () => {
  it("K1: defaults to 16 when omitted, and takes a positive integer", () => {
    expect(parseConfig(valid).maxSessions).toBe(16);
    expect(parseConfig({ ...valid, maxSessions: 6 }).maxSessions).toBe(6);
  });
  it("K1: refuses 2.5, 0, -1 and a string", () => {
    for (const bad of [2.5, 0, -1, "6"]) {
      expect(() => parseConfig({ ...valid, maxSessions: bad })).toThrow("config: maxSessions must be a positive integer");
    }
  });
  it("K10: the shipped config has no sonnet-impl role and maxSessions 16", () => {
    const raw = JSON.parse(readFileSync("agent-console.config.json", "utf8")) as { roles: { id: string }[]; maxSessions?: number };
    expect(raw.roles.map((r) => r.id)).not.toContain("sonnet-impl");
    expect(raw.maxSessions).toBe(16);
  });
});

describe("parseConfig: caseSandbox (discord-pdca 便2b-3a)", () => {
  const caseRole = { id: "discord-case", labelKey: "role.discordCase", command: ["/bin/zsh", "-c", "x"], needsWorktree: false, reservable: false, caseSandbox: true };
  it("accepts a valid case role", () => {
    const c = parseConfig({ ...valid, roles: [...valid.roles, caseRole] });
    expect(c.roles.find((r) => r.id === "discord-case")?.caseSandbox).toBe(true);
    expect(c.roles[0].caseSandbox).toBeUndefined();
  });
  it("refuses needsWorktree:true, a missing reservable:false, a resumeCommand and a non-boolean caseSandbox", () => {
    for (const bad of [
      { ...caseRole, needsWorktree: true },
      { ...caseRole, reservable: undefined },
      { ...caseRole, resumeCommand: ["/bin/zsh", "-ic", "x"] },
      { ...caseRole, caseSandbox: "yes" },
    ]) {
      expect(() => parseConfig({ ...valid, roles: [...valid.roles, bad] })).toThrow(/caseSandbox/);
    }
  });
  it("refuses a case role in reserveRoles or routineManagerRoles", () => {
    expect(() => parseConfig({ ...valid, roles: [...valid.roles, caseRole], reserveRoles: ["discord-case"] })).toThrow(/caseSandbox/);
    expect(() => parseConfig({ ...valid, roles: [...valid.roles, caseRole], routineManagerRoles: ["discord-case"] })).toThrow(/caseSandbox/);
  });
  it("the shipped config has discord-case with caseSandbox, not reservable and no resumeCommand", () => {
    const shipped = parseConfig(JSON.parse(readFileSync("agent-console.config.json", "utf8")));
    const role = shipped.roles.find((r) => r.id === "discord-case");
    expect(role?.caseSandbox).toBe(true);
    expect(role?.reservable).toBe(false);
    expect(role?.needsWorktree).toBe(false);
    expect(role?.resumeCommand).toBeUndefined();
    expect(shipped.reserveRoles).not.toContain("discord-case");
    expect(shipped.routineManagerRoles).not.toContain("discord-case");
  });
});
