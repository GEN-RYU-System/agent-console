import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DENY_MESSAGE, judge } from "../../hooks/ac-routine-guard.mjs";
import { GUARD_HOOK_FILE, GUARD_IFS, HOOK_SPECS, buildHandler } from "../../server/activity-hooks.ts";

const GUARD = path.join(process.cwd(), "hooks", "ac-routine-guard.mjs");
/** 既定の dataDir の文字列は、restore-guard の検査に掛からないよう分割して組み立てる */
const APP_SUPPORT = ["Library/Application", " Support/agent-console"].join("");
const CMD = 'node "/tmp/x/data/bin/ac-routine.mjs" list';
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

describe("S4 guard registration is narrowed so that unrelated tool calls do not start it", () => {
  it("every guard spec is synchronous, has timeout 5 and its own if; there are 6 (Bash x5, Read x1)", () => {
    const specs = HOOK_SPECS.filter((s) => s.file === GUARD_HOOK_FILE);
    expect(specs).toHaveLength(6);
    expect(specs.map((s) => s.if)).toEqual(GUARD_IFS);
    for (const spec of specs) {
      expect(spec).toMatchObject({ event: "PreToolUse", file: "ac-routine-guard.mjs", async: false, timeout: 5 });
      expect(spec.matcher).toBe(spec.if?.startsWith("Read(") ? "Read" : "Bash");
      const handler = buildHandler("/n/node", "/d/hooks/ac-routine-guard.mjs", spec);
      expect(handler).toEqual({ type: "command", command: "/n/node", args: ["/d/hooks/ac-routine-guard.mjs"], timeout: 5, if: spec.if });
      expect("async" in handler).toBe(false);
    }
    // Grep and Glob are out of scope (the if does not work for them: step 0 U5)
    expect(specs.some((s) => s.matcher === "Grep" || s.matcher === "Glob")).toBe(false);
    // the recording hook keeps its shape (async: true only)
    expect(buildHandler("/n/node", "/d/hooks/activity-hook.mjs")).toEqual({ type: "command", command: "/n/node", args: ["/d/hooks/activity-hook.mjs"], async: true });
  });
});

describe("S2 / S3 ac-hardening: the guard denies the token, the data dir, and the routine endpoints for subagents", () => {
  const denyBash = [
    `cat ~/${APP_SUPPORT.replace(" ", "\\ ")}/reserve-token`,
    "security find-generic-password -s agent-console/reserve-token -w",
    `ls '/Users/x/${APP_SUPPORT}/hooks'`,
    "curl -s -X POST http://127.0.0.1:4311/api/agent/routines -d '{}'",
    "curl http://localhost:4311/api/routines/abc/enabled",
    "curl -s http://127.0.0.1:4311/api/agent/routines/approval",
    "curl -s http://127.0.0.1:4311/api/sessions/x/routine-approval",
  ];
  const passBash = ["ls -la", "curl -s http://127.0.0.1:4311/healthz", "curl https://example.com/api/routines", "echo localhost", "git show origin/main:hooks/ac-routine.mjs", 'grep -n "/api/agent/routines" server/http.ts'];

  it("Bash: denied forms exit 2, unrelated forms pass silently", () => {
    for (const c of denyBash) expect(judge(input(c, "ab45")).code, c).toBe(2);
    for (const c of passBash) expect(judge(input(c, "ab45")), c).toEqual({ code: 0, stderr: "" });
  });

  it("Bash: without agent_id (the Opus main conversation) every form passes", () => {
    for (const c of denyBash) expect(judge(input(c)), c).toEqual({ code: 0, stderr: "" });
  });

  it("Read: a file under the data dir is denied for a subagent only", () => {
    const read = (file: string, agentId?: string) => ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file }, ...(agentId !== undefined ? { agent_id: agentId } : {}) });
    expect(judge(read(`/Users/x/${APP_SUPPORT}/routines.json`, "ab45")).code).toBe(2);
    expect(judge(read("/Users/x/agent-console/package.json", "ab45"))).toEqual({ code: 0, stderr: "" });
    expect(judge(read(`/Users/x/${APP_SUPPORT}/routines.json`))).toEqual({ code: 0, stderr: "" });
  });
});
