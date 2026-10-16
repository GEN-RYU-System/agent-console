import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DENY_MESSAGE, judge } from "../../hooks/server-kill-guard.mjs";

const SCRIPT = path.join(process.cwd(), "hooks", "server-kill-guard.mjs");
const input = (command: string, agentId?: string): Record<string, unknown> => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...(agentId !== undefined ? { agent_id: agentId, agent_type: "general-purpose" } : {}) });

/** K1: 拒否する 16 形（設計 server-kill-guard §2） */
const DENIED = [
  'pkill -f "dist-server/server/index.js"',
  "pkill -f dist-server",
  'pkill -f "server/index.js"',
  "pkill node",
  "pkill -f node",
  "killall node",
  "killall -9 node",
  "pkill -f agent-console",
  "kill $(pgrep -f dist-server/server/index.js)",
  'pgrep -f "server/index.js" | xargs kill',
  "kill $(lsof -ti tcp:4319)",
  "lsof -ti :4319 | xargs kill -9",
  "launchctl kill SIGTERM gui/501/local.agent-console.server",
  "launchctl stop local.agent-console.server",
  "launchctl bootout gui/501/local.agent-console.server",
  'cd x && pkill -f "dist-server/server/index.js" 2>/dev/null; sleep 1',
];

/** K2: 通す 9 形 */
const ALLOWED = [
  "lsof -ti tcp:4329 | xargs kill",
  "kill $(lsof -ti tcp:4330)",
  "pkill -f playwright",
  "tmux -L agent-console kill-session -t =ac-x",
  "launchctl kickstart -k gui/501/local.agent-console.server",
  "launchctl print gui/501/local.agent-console.server",
  'grep -n "pkill" docs/handoff/server-kill-guard/design.md',
  "git log --oneline",
  "bash scripts/ac-update.sh v0.41.0",
];

describe("K1 server-kill-guard denies the forms that stop the production server", () => {
  it.each(DENIED)("denies: %s", (command) => {
    expect(judge(input(command))).toEqual({ code: 2, stderr: `${DENY_MESSAGE}\n` });
  });
});

describe("K2 server-kill-guard passes the forms that do not", () => {
  it.each(ALLOWED)("passes: %s", (command) => {
    expect(judge(input(command))).toEqual({ code: 0, stderr: "" });
  });
});

describe("K3 agent_id does not matter", () => {
  it("same result with and without agent_id", () => {
    for (const c of DENIED) expect(judge(input(c, "ab45"))).toEqual(judge(input(c)));
    for (const c of ALLOWED) expect(judge(input(c, "ab45"))).toEqual(judge(input(c)));
    expect(judge(input(DENIED[0] as string, "ab45")).code).toBe(2);
  });
});

describe("K4 unreadable input passes (fail-open)", () => {
  it("odd inputs pass without output", () => {
    for (const x of [undefined, null, {}, { tool_input: {} }, { tool_input: { command: 5 } }]) expect(judge(x)).toEqual({ code: 0, stderr: "" });
  });

  it("the real script exits 0 with no output for non-JSON and empty stdin", () => {
    for (const stdin of ["not json", ""]) {
      const r = spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
  });
});

describe("K7 deny message", () => {
  it("is one line, at most 80 characters, and shows how to stop a test server by port", () => {
    expect(DENY_MESSAGE.length).toBeLessThanOrEqual(80);
    expect(DENY_MESSAGE).not.toContain("\n");
    expect(DENY_MESSAGE).toContain("lsof -ti tcp:4329");
  });
});

describe("server-kill-guard process (the real script)", () => {
  const exec = (stdin: string) => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: "utf8" });

  it("denying exits 2 with a single stderr line and no stdout", () => {
    const r = exec(JSON.stringify(input('pkill -f "dist-server/server/index.js"')));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${DENY_MESSAGE}\n`);
  });

  it("passing exits 0 and is completely silent", () => {
    const r = exec(JSON.stringify(input("lsof -ti tcp:4329 | xargs kill")));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});
