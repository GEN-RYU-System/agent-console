import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ZSH_FILE = path.join(process.cwd(), "ops", "shell", "ccdiscord.zsh");
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;
const UUID = "11111111-2222-4333-8444-555555555555";
const FAKE_TOKEN = "gho_FAKE_TOKEN_value_123";

let tmp: string;
let bin: string;
let home: string;
let mark: string;
let report: string;
let caseTmp: string;
let ghDir: string;
let settings: string;

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
  for (const d of [report, caseTmp, ghDir]) mkdirSync(d, { recursive: true });
  writeFileSync(settings, "{}");
  write(path.join(home, ".claude", "prompts", "salesanchor-designer.md"), "DESIGNER PROMPT\n", 0o644);
  write(path.join(home, ".claude", "prompts", "salesanchor-ops-incident-agent.md"), "OPS PROMPT\n", 0o644);
  // 差し替えの claude: --version には FAKE_CLAUDE_VERSION を出し、それ以外は受けた引数と環境を印のファイルに書く
  write(
    path.join(bin, "claude"),
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "\${FAKE_CLAUDE_VERSION:-2.1.310 (Claude Code)}"; exit 0; fi
{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; } > "${mark}"
{ printf 'GIT_CONFIG_COUNT=%s\\n' "$GIT_CONFIG_COUNT"; printf 'KEY_2=%s\\n' "$GIT_CONFIG_KEY_2"; printf 'VALUE_2=%s\\n' "$GIT_CONFIG_VALUE_2"; printf 'DISABLE_GIT=%s\\n' "$CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS"; printf 'TMPDIR=%s\\n' "$CLAUDE_CODE_TMPDIR"; printf 'GH_CONFIG_DIR=%s\\n' "$GH_CONFIG_DIR"; printf 'HAS_TOKEN=%s\\n' "\${GH_TOKEN:+yes}"; } > "${mark}.env"
exit 0
`,
  );
  write(path.join(bin, "gh"), `#!/bin/bash\nif [ "$1 $2" = "auth token" ]; then printf '%s\\n' "\${FAKE_GH_TOKEN-${FAKE_TOKEN}}"; exit 0; fi\nexit 1\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(over: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    AC_CLAUDE_BIN: path.join(bin, "claude"),
    AC_SANDBOX_EXEC: "/bin/sh",
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
    ];
    for (const [name, over] of cases) {
      const r = run(over);
      expect(r.status, name).toBe(2);
      expect(existsSync(mark), name).toBe(false);
      expect(r.stderr + r.stdout, name).not.toContain(FAKE_TOKEN);
    }
    rmSync(path.join(home, ".claude", "prompts", "salesanchor-ops-incident-agent.md"));
    expect(run().status).toBe(2);
    expect(existsSync(mark)).toBe(false);
  });
});
