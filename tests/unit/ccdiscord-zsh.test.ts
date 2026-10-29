import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ZSH_FILE = path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh");
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;
const UUID = "11111111-2222-4333-8444-555555555555";
const FAKE_TOKEN = "gho_FAKE_TOKEN_value_123";
const FAKE_LOGIN = "sk-FAKE-LOGIN-value-456";
const PROXY = "http://127.0.0.1:18124";

let tmp: string;
let bin: string;
let home: string;
let mark: string;
let report: string;
let caseTmp: string;
let ghDir: string;
let settings: string;
let room: string;
let caseHome: string;

function write(file: string, body: string, mode = 0o755): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, mode);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-ccd-")));
  bin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  mark = path.join(tmp, "claude-mark");
  report = path.join(tmp, "report");
  caseTmp = path.join(tmp, "casetmp");
  ghDir = path.join(tmp, "gh");
  settings = path.join(tmp, "settings.json");
  room = path.join(tmp, "room.sb");
  caseHome = path.join(tmp, "case-home");
  for (const d of [report, caseTmp, ghDir, caseHome]) mkdirSync(d, { recursive: true });
  writeFileSync(settings, "{}");
  writeFileSync(room, "(version 1)\n");
  write(path.join(home, ".claude", "prompts", "salesanchor-designer.md"), "DESIGNER PROMPT\n", 0o644);
  write(path.join(home, ".claude", "prompts", "salesanchor-ops-incident-agent.md"), "OPS PROMPT\n", 0o644);
  // 差し替えの claude: --version には FAKE_CLAUDE_VERSION を出し、それ以外は受けた引数と環境を印のファイルに書く
  write(
    path.join(bin, "claude"),
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "\${FAKE_CLAUDE_VERSION:-2.1.310 (Claude Code)}"; exit 0; fi
{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; } > "${mark}"
{ printf 'GIT_CONFIG_COUNT=%s\\n' "$GIT_CONFIG_COUNT"; printf 'KEY_2=%s\\n' "$GIT_CONFIG_KEY_2"; printf 'VALUE_2=%s\\n' "$GIT_CONFIG_VALUE_2"; printf 'DISABLE_GIT=%s\\n' "$CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS"; printf 'TMPDIR=%s\\n' "$CLAUDE_CODE_TMPDIR"; printf 'GH_CONFIG_DIR=%s\\n' "$GH_CONFIG_DIR"; printf 'HAS_TOKEN=%s\\n' "\${GH_TOKEN:+yes}"; } > "${mark}.env"
env | sort > "${mark}.full"
exit 0
`,
  );
  // 差し替えの sandbox-exec: 受けた引数を印のファイルに書き、-f <room> -D TTY=… の4つを除いて、あとの命令（偽の claude）を動かす
  write(path.join(bin, "sandbox-exec"), `#!/bin/bash\n{ for a in "$@"; do printf 'SBX:%s\\n' "$a"; done; } > "${mark}.sbx"\nshift 4\nexec "$@"\n`);
  // 差し替えの tty と security（本物の端末・Keychain を使わない）
  write(path.join(bin, "tty"), `#!/bin/bash\nprintf '%s\\n' "\${FAKE_TTY-/dev/ttys001}"\n`);
  write(path.join(bin, "security"), `#!/bin/bash\ncase "$*" in *"find-generic-password -s agent-console-case-claude -a case -w"*) printf '%s\\n' "\${FAKE_LOGIN-${FAKE_LOGIN}}"; exit 0;; esac\nexit 44\n`);
  write(path.join(bin, "gh"), `#!/bin/bash\nif [ "$1 $2" = "auth token" ]; then printf '%s\\n' "\${FAKE_GH_TOKEN-${FAKE_TOKEN}}"; exit 0; fi\nexit 1\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(over: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    AC_CLAUDE_BIN: path.join(bin, "claude"),
    AC_SANDBOX_EXEC: path.join(bin, "sandbox-exec"),
    AC_CASE_ROOM: room,
    AC_CASE_HOME: caseHome,
    AC_CASE_PROXY: PROXY,
    AC_CASE_SETTINGS: settings,
    AC_CASE_GH_DIR: ghDir,
    AC_CASE_REPORT: report,
    AC_CASE_TMP: caseTmp,
    ...over,
  };
  for (const k of Object.keys(env)) if (env[k] === "<unset>") delete env[k];
  const r = spawnSync("zsh", ["-c", `source "${ZSH_FILE}" && ccdiscordcase`], { env, encoding: "utf8", timeout: 30000 });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}
const args = (): string[] => readFileSync(mark, "utf8").split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
const envMark = (): string => readFileSync(`${mark}.env`, "utf8");
const sbxArgs = (): string[] => readFileSync(`${mark}.sbx`, "utf8").split("\n").filter((l) => l.startsWith("SBX:")).map((l) => l.slice(4));
/** 起動した claude が受け取った環境（名前 → 値） */
const fullEnv = (): Record<string, string> => Object.fromEntries(readFileSync(`${mark}.full`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

// CI では zsh が無ければ飛ばさず落とす（ci.yml が Linux に入れる）。手元で zsh が無いときだけ飛ばす
describe.skipIf(!hasZsh && process.env.CI === undefined)("ccdiscordcase", () => {
  it("starts claude with the restricted flags and without chrome / setting-sources; the token is not in the arguments", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const a = args();
    expect(a).toContain("--restricted");
    const at = (flag: string): string => a[a.indexOf(flag) + 1];
    expect(at("--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep,Agent,TodoWrite");
    expect(at("--add-dir")).toBe(report);
    expect(at("--permission-mode")).toBe("dontAsk");
    expect(at("--settings")).toBe(settings);
    expect(a).toContain("--strict-mcp-config");
    const i = a.indexOf("--disallowedTools");
    expect(a.slice(i + 1, i + 4)).toEqual(["mcp__*", "WebFetch", "WebSearch"]);
    expect(a).not.toContain("--chrome");
    expect(a).not.toContain("--setting-sources");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a.join("\n")).not.toContain(FAKE_TOKEN);
    // 指示書2つが「\n\n」でつながれて渡る（引数は1つ。印のファイルは行ごとに書くので、先頭の行と、2つ目の行があることを見る）
    expect(at("--append-system-prompt")).toBe("DESIGNER PROMPT");
    expect(readFileSync(mark, "utf8")).toContain("ARG:DESIGNER PROMPT\n\nOPS PROMPT\n");
  });

  it("passes the git config overrides, the git-instructions switch, the tmp dir and the gh config dir through the environment", () => {
    run();
    const e = envMark();
    expect(e).toContain("GIT_CONFIG_COUNT=3");
    expect(e).toContain("KEY_2=core.fsmonitor");
    expect(e).toContain("VALUE_2=false");
    expect(e).toContain("DISABLE_GIT=1");
    expect(e).toContain(`TMPDIR=${caseTmp}`);
    expect(e).toContain(`GH_CONFIG_DIR=${ghDir}`);
    expect(e).toContain("HAS_TOKEN=yes");
  });

  it("adds --resume only for a UUID in AC_RESUME_ID", () => {
    run({ AC_RESUME_ID: UUID });
    const a = args();
    expect(a[a.indexOf("--resume") + 1]).toBe(UUID);
    rmSync(mark);
    run({ AC_RESUME_ID: "not-a-uuid; rm -rf /" });
    expect(args()).not.toContain("--resume");
  });

  it("compares the claude version as numbers: 2.1.294 stops, 2.1.295 and 2.10.0 start, unreadable stops", () => {
    expect(run({ FAKE_CLAUDE_VERSION: "2.1.294 (Claude Code)" }).status).toBe(2);
    expect(existsSync(mark)).toBe(false);
    expect(run({ FAKE_CLAUDE_VERSION: "2.1.295 (Claude Code)" }).status).toBe(0);
    rmSync(mark);
    expect(run({ FAKE_CLAUDE_VERSION: "2.10.0 (Claude Code)" }).status).toBe(0);
    rmSync(mark);
    expect(run({ FAKE_CLAUDE_VERSION: "no version here" }).status).toBe(2);
    expect(existsSync(mark)).toBe(false);
  });

  it("stops with 2 and never starts claude when a condition is missing", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["settings empty", { AC_CASE_SETTINGS: "" }],
      ["report empty", { AC_CASE_REPORT: "" }],
      ["tmp empty", { AC_CASE_TMP: "" }],
      ["sandbox-exec missing", { AC_SANDBOX_EXEC: path.join(tmp, "no-such-sandbox-exec") }],
      ["gh returns nothing", { FAKE_GH_TOKEN: "" }],
      ["room unset", { AC_CASE_ROOM: "<unset>" }],
      ["room unreadable", { AC_CASE_ROOM: path.join(tmp, "no-such-room.sb") }],
      ["case-home empty", { AC_CASE_HOME: "" }],
      ["case-home not a directory", { AC_CASE_HOME: room }],
      ["claude bin unset", { AC_CLAUDE_BIN: "<unset>" }],
      ["claude bin not executable", { AC_CLAUDE_BIN: room }],
      ["proxy empty", { AC_CASE_PROXY: "" }],
      ["tty is not a tty", { FAKE_TTY: "not a tty" }],
      ["tty is a pts name", { FAKE_TTY: "/dev/pts/0" }],
      ["tty has a suffix", { FAKE_TTY: "/dev/ttys001x" }],
      ["login token is empty", { FAKE_LOGIN: "" }],
    ];
    for (const [name, over] of cases) {
      const r = run(over);
      expect(r.status, name).toBe(2);
      expect(existsSync(mark), name).toBe(false);
      expect(r.stderr + r.stdout, name).not.toContain(FAKE_TOKEN);
      expect(r.stderr + r.stdout, name).not.toContain(FAKE_LOGIN);
    }
    rmSync(path.join(home, ".claude", "prompts", "salesanchor-ops-incident-agent.md"));
    expect(run().status).toBe(2);
    expect(existsSync(mark)).toBe(false);
  });

  it("starts claude with exec through sandbox-exec -f <room> -D TTY=<tty> <AC_CLAUDE_BIN>, checking the version with AC_CLAUDE_BIN", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const a = sbxArgs();
    expect(a.slice(0, 5)).toEqual(["-f", room, "-D", "TTY=/dev/ttys001", path.join(bin, "claude")]);
    expect(a).toContain("--restricted");
    // 版の確かめも AC_CLAUDE_BIN で行う（PATH の claude は使わない）
    write(path.join(tmp, "path-claude-dir", "claude"), "#!/bin/bash\necho 1.0.0\n");
    expect(run({ PATH: `${path.join(tmp, "path-claude-dir")}:${bin}:${process.env.PATH ?? ""}` }).status).toBe(0);
  });

  it("removes inherited CLAUDE_*, ANTHROPIC_*, CLAUDECODE, TMUX and SSH_AUTH_SOCK, then adds only its own values", () => {
    const r = run({
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited-token-must-go",
      ANTHROPIC_API_KEY: "fake-key-inherited",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      CLAUDE_CONFIG_DIR: "/x",
      CLAUDE_FOO: "1",
      TMUX: "/tmp/tmux-1/default,1,0",
      TMUX_PANE: "%0",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    expect(r.status, r.stderr).toBe(0);
    const e = fullEnv();
    const prefixed = Object.keys(e).filter((k) => /^(CLAUDE|ANTHROPIC)/.test(k)).sort();
    expect(prefixed).toEqual(["CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR"]);
    expect(e.CLAUDE_CONFIG_DIR).toBe(caseHome);
    expect(e.CLAUDE_CODE_TMPDIR).toBe(caseTmp);
    expect(e.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS).toBe("1");
    expect(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_LOGIN);
    expect(e.TMUX).toBeUndefined();
    expect(e.TMUX_PANE).toBeUndefined();
    expect(e.SSH_AUTH_SOCK).toBeUndefined();
    expect(e.TMPDIR).toBe(caseTmp);
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) expect(e[k], k).toBe(PROXY);
    expect(e.NO_PROXY).toBe("127.0.0.1,localhost");
    // AC_CASE_* と AC_CLAUDE_BIN は消さない
    expect(e.AC_CASE_ROOM).toBe(room);
    expect(e.AC_CLAUDE_BIN).toBe(path.join(bin, "claude"));
  });

  it("never puts the login token or the gh token in the arguments or the output", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(sbxArgs().join("\n")).not.toContain(FAKE_LOGIN);
    expect(sbxArgs().join("\n")).not.toContain(FAKE_TOKEN);
    expect(r.stdout + r.stderr).not.toContain(FAKE_LOGIN);
  });
});
