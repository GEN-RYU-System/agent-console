import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DENY_MESSAGE, judge, splitParts, stripQuotedHeredocs } from "../../hooks/server-kill-guard.mjs";

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

/** Q-K3: 引用の中の例文は通す 6 形 */
const QUOTED_ALLOWED = [
  "cat > /tmp/x.md <<'EOF'\n例: `pkill -f \"dist-server/server/index.js\"` で止まる\nEOF\nnode b.mjs write <<'EOF'\n{\"a\":1}\nEOF",
  'cat <<"EOF"\n`pkill node`\nEOF',
  "cat <<-'EOF'\n\t`pkill node`\n\tEOF",
  'git commit -m "例; pkill node は危ない"',
  "echo 'kill $(lsof -ti tcp:4319)'",
  "printf '%s' 'x `pkill node` y'",
];

/** Q-K4: 引用の外・展開される場所は拒否のまま 5 形 */
const QUOTED_DENIED = [
  "cat <<EOF\n`pkill node`\nEOF",
  'echo "$(pkill -f dist-server)"',
  'echo "`killall node`"',
  "cat <<'EOF'\nbody\nEOF\npkill -f dist-server",
  "pkill node; cat <<'EOF'\nbody",
];

describe("Q-K3 quoted text is not a command", () => {
  it.each(QUOTED_ALLOWED)("passes: %s", (command) => {
    expect(judge(input(command))).toEqual({ code: 0, stderr: "" });
  });
});

describe("Q-K4 real stops are still denied", () => {
  it.each(QUOTED_DENIED)("denies: %s", (command) => {
    expect(judge(input(command))).toEqual({ code: 2, stderr: `${DENY_MESSAGE}\n` });
  });
});

describe("stripQuotedHeredocs", () => {
  it("removes the body and terminator, keeps the rest of the opening line", () => {
    expect(stripQuotedHeredocs("cat <<'EOF' > f\nbody\nEOF\nls")).toBe("cat <<'EOF' > f\nls");
  });
  it("removes to the end when there is no terminator", () => {
    expect(stripQuotedHeredocs("a; cat <<'EOF'\nbody\nmore")).toBe("a; cat <<'EOF'\n");
  });
  it("<<- compares the terminator after stripping leading tabs", () => {
    expect(stripQuotedHeredocs("cat <<-'EOF'\n\tbody\n\tEOF\nls")).toBe("cat <<-'EOF'\nls");
  });
  it("keeps unquoted heredocs and heredocs inside quotes", () => {
    expect(stripQuotedHeredocs("cat <<EOF\nbody\nEOF")).toBe("cat <<EOF\nbody\nEOF");
    expect(stripQuotedHeredocs("echo \"<<'EOF'\nx\"")).toBe("echo \"<<'EOF'\nx\"");
  });
});

describe("splitParts", () => {
  it("splits outside quotes and keeps the quotes in the parts", () => {
    expect(splitParts("a 'b;c' && d")).toEqual(["a 'b;c' ", " d"]);
  });
  it("inside double quotes only $( and backtick split", () => {
    expect(splitParts('echo "a; b $(c) d"')).toEqual(['echo "a; b ', 'c) d"']);
  });
  it("a backslash protects the next character", () => {
    expect(splitParts("a\\;b;c")).toEqual(["a\\;b", "c"]);
  });
});
