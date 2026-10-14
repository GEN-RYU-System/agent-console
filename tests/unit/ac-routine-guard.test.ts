import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DENY_MESSAGE, judge } from "../../hooks/ac-routine-guard.mjs";
import { GUARD_HOOK_FILE, HOOK_SPECS, buildHandler } from "../../server/activity-hooks.ts";

const GUARD = path.join(process.cwd(), "hooks", "ac-routine-guard.mjs");
const CMD = 'node "/Users/x/Library/Application Support/agent-console/bin/ac-routine.mjs" list';
const input = (command: string, agentId?: string): Record<string, unknown> => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...(agentId !== undefined ? { agent_id: agentId, agent_type: "general-purpose" } : {}) });

describe("S4 ac-routine-guard judge", () => {
  it("agent_id present and the executable form is in the command: exit 2 with a one-line reason", () => {
    const r = judge(input(CMD, "ab452e2dcf964c0a3"));
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(`${DENY_MESSAGE}\n`);
    expect(DENY_MESSAGE.length).toBeLessThanOrEqual(80);
    expect(r.stderr.trimEnd()).not.toContain("\n");
  });

  it("agent_id absent (the Opus main conversation): exit 0 and no output", () => {
    expect(judge(input(CMD))).toEqual({ code: 0, stderr: "" });
  });

  it("agent_id present but ac-routine is only mentioned (not the executable form): exit 0 and no output", () => {
    expect(judge(input("git show origin/main:hooks/ac-routine.mjs", "ab45"))).toEqual({ code: 0, stderr: "" });
    expect(judge(input("npx vitest run tests/unit/ac-routine.test.ts", "ab45"))).toEqual({ code: 0, stderr: "" });
  });

  it("odd inputs pass without output (fail-open)", () => {
    for (const x of [undefined, null, {}, { tool_input: {} }, { tool_input: { command: 5 }, agent_id: "a" }, { tool_input: { command: CMD }, agent_id: "" }]) expect(judge(x)).toEqual({ code: 0, stderr: "" });
  });
});

describe("S4 ac-routine-guard process (the real script)", () => {
  const exec = (stdin: string) => spawnSync(process.execPath, [GUARD], { input: stdin, encoding: "utf8" });

  it("passing is completely silent (nothing is added to the conversation context)", () => {
    for (const stdin of [JSON.stringify(input(CMD)), JSON.stringify(input("ls -la", "ab45")), JSON.stringify(input("git show origin/main:hooks/ac-routine.mjs", "ab45")), "not json", ""]) {
      const r = exec(stdin);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
  });

  it("denying exits 2 with a single stderr line of at most 80 characters and no stdout", () => {
    const r = exec(JSON.stringify(input(CMD, "ab45")));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr.trimEnd().length).toBeLessThanOrEqual(80);
  });
});

describe("S4 guard registration is narrowed so that unrelated Bash calls do not start it", () => {
  it("the guard spec is synchronous, has timeout 5 and an if that only matches the ac-routine executable", () => {
    const spec = HOOK_SPECS.find((s) => s.file === GUARD_HOOK_FILE);
    expect(spec).toEqual({ event: "PreToolUse", matcher: "Bash", file: "ac-routine-guard.mjs", async: false, timeout: 5, if: "Bash(*/bin/ac-routine.mjs*)" });
    const handler = buildHandler("/n/node", "/d/hooks/ac-routine-guard.mjs", spec);
    expect(handler).toEqual({ type: "command", command: "/n/node", args: ["/d/hooks/ac-routine-guard.mjs"], timeout: 5, if: "Bash(*/bin/ac-routine.mjs*)" });
    expect("async" in handler).toBe(false);
    // 記録用 hook の形は変わらない（async: true だけ）
    expect(buildHandler("/n/node", "/d/hooks/activity-hook.mjs")).toEqual({ type: "command", command: "/n/node", args: ["/d/hooks/activity-hook.mjs"], async: true });
  });
});
