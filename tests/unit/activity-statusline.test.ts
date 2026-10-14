import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addStatusLine, buildStatusLine, checkHooks, checkStatusLine, installHooks, installStatusLine, isOwnStatusLine, removeStatusLine, uninstallStatusLine } from "../../server/activity-hooks.ts";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const CLI = path.join(REPO, "scripts", "ac-hooks.mjs");
const HOOK_EVENTS = 9;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-statusline-hooks-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Env {
  home: string;
  settings: string;
  dataDir: string;
  script: string;
  nodePath: string;
}
/** 一時の HOME。dataDir は空白入り（macOS の Application Support の形） */
function makeEnv(): Env {
  const home = tmp();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const dataDir = path.join(home, "Library", "Application Support", "agent-console");
  return { home, settings: path.join(home, ".claude", "settings.json"), dataDir, script: path.join(dataDir, "bin", "ac-statusline.mjs"), nodePath: process.execPath };
}
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any
const backups = (e: Env): string[] => readdirSync(path.dirname(e.settings)).filter((n) => n.startsWith("settings.json.ac-backup-")).sort();
const FOREIGN = { type: "command", command: "~/.claude/statusline.sh", padding: 0 };
const PO_SETTINGS = { permissions: { allow: ["Bash(ls:*)"] }, model: "opus" };

describe("§10-5: statusLine の形と見分け", () => {
  it('command は `"<node>" "<命令>"`（2 つのパスを二重引用符で囲む。args は使わない）', () => {
    const sl = buildStatusLine("/usr/bin/node", "/data dir/bin/ac-statusline.mjs");
    expect(sl).toEqual({ type: "command", command: '"/usr/bin/node" "/data dir/bin/ac-statusline.mjs"' });
  });
  it.each(['a"b', "a$b", "a`b", "a\\b", "a\nb", "a\rb"])("パスに引用を崩す文字（%j）が入っていたら足さない", (bad) => {
    expect(() => buildStatusLine("/usr/bin/node", `/data/${bad}/bin/ac-statusline.mjs`)).toThrow(/引用を崩す文字/);
    expect(() => buildStatusLine(`/usr/${bad}/node`, "/data/bin/ac-statusline.mjs")).toThrow(/引用を崩す文字/);
  });
  it('自分の物かは、command に `"<命令のパス>"`（引用符つき）がそのまま入っているかで見分ける', () => {
    const own = buildStatusLine("/usr/bin/node", "/data/bin/ac-statusline.mjs");
    expect(isOwnStatusLine(own, "/data/bin/ac-statusline.mjs")).toBe(true);
    expect(isOwnStatusLine(own, "/other/bin/ac-statusline.mjs")).toBe(false);
    expect(isOwnStatusLine(FOREIGN, "/data/bin/ac-statusline.mjs")).toBe(false);
    expect(isOwnStatusLine({ type: "command", command: "/data/bin/ac-statusline.mjs" }, "/data/bin/ac-statusline.mjs")).toBe(false);
    expect(isOwnStatusLine(undefined, "/x")).toBe(false);
    expect(isOwnStatusLine("str", "/x")).toBe(false);
  });
});

describe("K9: addStatusLine / removeStatusLine（純粋な編集）", () => {
  const script = "/data/bin/ac-statusline.mjs";
  it("無ければ足す。ほかの鍵は変えない。同じなら変えない。node のパスが違えば直す", () => {
    const a = addStatusLine(PO_SETTINGS, "/usr/bin/node", script);
    expect(a.outcome).toBe("added");
    expect(a.settings).toEqual({ ...PO_SETTINGS, statusLine: buildStatusLine("/usr/bin/node", script) });
    expect(addStatusLine(a.settings, "/usr/bin/node", script).outcome).toBe("unchanged");
    const u = addStatusLine(a.settings, "/opt/node", script);
    expect(u.outcome).toBe("updated");
    expect(u.settings.statusLine).toEqual(buildStatusLine("/opt/node", script));
  });
  it("別の statusLine があれば上書きしない（foreign）", () => {
    const s = { ...PO_SETTINGS, statusLine: FOREIGN };
    const r = addStatusLine(s, "/usr/bin/node", script);
    expect(r).toEqual({ settings: s, outcome: "foreign" });
  });
  it("外すのは自分の物だけ。別の物は残る", () => {
    const own = addStatusLine(PO_SETTINGS, "/usr/bin/node", script).settings;
    expect(removeStatusLine(own, script)).toEqual({ settings: PO_SETTINGS, changed: true });
    const foreign = { ...PO_SETTINGS, statusLine: FOREIGN };
    expect(removeStatusLine(foreign, script)).toEqual({ settings: foreign, changed: false });
  });
});

describe("K9: installStatusLine / uninstallStatusLine / checkStatusLine（ファイル）", () => {
  it("足す前に控えを取る。2 回目は変更なし（控えも増えない）。外すと元の設定に戻る", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    expect(installStatusLine({ settingsPath: e.settings, nodePath: e.nodePath, scriptPath: e.script }).outcome).toBe("added");
    expect(backups(e)).toHaveLength(1);
    expect(readJson(backups(e).length ? path.join(path.dirname(e.settings), backups(e)[0]) : e.settings)).toEqual(PO_SETTINGS);
    expect(installStatusLine({ settingsPath: e.settings, nodePath: e.nodePath, scriptPath: e.script }).outcome).toBe("unchanged");
    expect(backups(e)).toHaveLength(1);
    expect(uninstallStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ changed: true });
    expect(readJson(e.settings)).toEqual(PO_SETTINGS);
  });
  it("別の statusLine があれば、何も書かない（控えも作らない）。uninstall も別の物は外さない", () => {
    const e = makeEnv();
    const original = JSON.stringify({ ...PO_SETTINGS, statusLine: FOREIGN }, null, 2) + "\n";
    writeFileSync(e.settings, original);
    expect(installStatusLine({ settingsPath: e.settings, nodePath: e.nodePath, scriptPath: e.script }).outcome).toBe("foreign");
    expect(readFileSync(e.settings, "utf8")).toBe(original);
    expect(backups(e)).toHaveLength(0);
    expect(uninstallStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ changed: false });
    expect(readFileSync(e.settings, "utf8")).toBe(original);
  });
  it("checkStatusLine: 無い／別の物／命令のファイルが無い／そろっている", () => {
    const e = makeEnv();
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: false, reason: "noSettings" });
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS));
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: false, reason: "missing" });
    writeFileSync(e.settings, JSON.stringify({ statusLine: FOREIGN }));
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: false, reason: "foreign" });
    writeFileSync(e.settings, "{broken");
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: false, reason: "unreadable" });
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS));
    installStatusLine({ settingsPath: e.settings, nodePath: e.nodePath, scriptPath: e.script });
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: false, reason: "scriptFileMissing" });
    mkdirSync(path.dirname(e.script), { recursive: true });
    writeFileSync(e.script, "// x\n");
    expect(checkStatusLine({ settingsPath: e.settings, scriptPath: e.script })).toEqual({ ok: true });
  });
  it("checkHooks（サーバーの 1 時間ごとの点検）は statusLine を見ない: hooks が入った設定に別物の statusLine があっても ok のまま", () => {
    const e = makeEnv();
    const hookPath = path.join(e.dataDir, "hooks", "activity-hook.mjs");
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, "// x\n");
    writeFileSync(path.join(path.dirname(hookPath), "ac-routine-guard.mjs"), "// g\n");
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS));
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath });
    expect(checkHooks({ settingsPath: e.settings, hookPath })).toMatchObject({ ok: true });
    writeFileSync(e.settings, JSON.stringify({ ...readJson(e.settings), statusLine: FOREIGN }));
    expect(checkHooks({ settingsPath: e.settings, hookPath })).toMatchObject({ ok: true });
  });
});

describe("§10-3: コマンド（scripts/ac-hooks.mjs を一時の HOME で）", () => {
  function cli(e: Env, ...args: string[]): { status: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [CLI, ...args, "--data-dir", e.dataDir], { encoding: "utf8", env: { ...process.env, HOME: e.home, AGENT_CONSOLE_PORT: "" } });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it("statusLine が無い → hooks も statusLine も入り（終了 0）、命令が dataDir/bin に置かれる。check は ok。uninstall で両方外れる", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    const i = cli(e, "install");
    expect(i.status, i.err).toBe(0);
    expect(i.out).toContain("statusLine（利用量の写し取り）を");
    expect(existsSync(e.script)).toBe(true);
    const s = readJson(e.settings);
    expect(s.statusLine).toEqual({ type: "command", command: `"${e.nodePath}" "${e.script}"` });
    expect(Object.keys(s.hooks)).toHaveLength(HOOK_EVENTS);

    const c = cli(e, "check");
    expect(c.status, c.err).toBe(0);
    expect(JSON.parse(c.out)).toMatchObject({ ok: true });
    expect(c.err).toContain("statusLine: ok");

    const again = cli(e, "install");
    expect(again.status).toBe(0);
    expect(again.out).toContain("statusLine（利用量の写し取り）はすでに入っています");

    const u = cli(e, "uninstall");
    expect(u.status, u.err).toBe(0);
    // hooks の段が空にした hooks の鍵は、従来どおり {} が残る（statusLine と、それ以外の鍵は元のまま）
    expect(readJson(e.settings)).toEqual({ ...PO_SETTINGS, hooks: {} });
  });

  it("別の statusLine がある → hooks は入り、statusLine は変わらず、終了コード 0、見送りの行が出る。check は「無い（または別の物）」で終了コードは hooks の結果", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify({ ...PO_SETTINGS, statusLine: FOREIGN }, null, 2) + "\n");
    const i = cli(e, "install");
    expect(i.status, i.err).toBe(0);
    expect(i.out).toContain("statusLine: 別の設定があるので足していません");
    const s = readJson(e.settings);
    expect(s.statusLine).toEqual(FOREIGN);
    expect(Object.keys(s.hooks)).toHaveLength(HOOK_EVENTS);

    const c = cli(e, "check");
    expect(c.status).toBe(0);
    expect(c.err).toContain("statusLine: 無い（または別の物）");

    const u = cli(e, "uninstall");
    expect(u.status, u.err).toBe(0);
    expect(readJson(e.settings).statusLine).toEqual(FOREIGN);
    expect(readJson(e.settings).hooks).toEqual({});
  });

  it("2 回の書き込みでも、最初の控え（元の設定）が残る", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    expect(cli(e, "install").status).toBe(0);
    const originals = backups(e).map((n) => readJson(path.join(path.dirname(e.settings), n)));
    expect(originals).toContainEqual(PO_SETTINGS);
    expect(backups(e)).toHaveLength(2);
  });

  it("引用を崩す文字を含む dataDir では statusLine を足さず、理由を出して終了コード 1。hooks は入っている", () => {
    const e = makeEnv();
    const bad = { ...e, dataDir: path.join(e.home, 'we"ird', "agent-console") };
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    const i = cli(bad, "install");
    expect(i.status).toBe(1);
    expect(i.err).toContain("hooks は入りました・statusLine は入っていません");
    expect(i.err).toContain("引用を崩す文字");
    const s = readJson(e.settings);
    expect(s.statusLine).toBeUndefined();
    expect(Object.keys(s.hooks)).toHaveLength(HOOK_EVENTS);
  });

  it("dataDir/bin が通常のファイルで塞がれている → 命令を置けず、statusLine は入らず、終了コード 1。hooks は入っている", () => {
    const e = makeEnv();
    mkdirSync(e.dataDir, { recursive: true });
    writeFileSync(path.join(e.dataDir, "bin"), "not a directory\n");
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    const i = cli(e, "install");
    expect(i.status).toBe(1);
    expect(i.err).toContain("hooks は入りました・statusLine は入っていません");
    const s = readJson(e.settings);
    expect(s.statusLine).toBeUndefined();
    expect(Object.keys(s.hooks)).toHaveLength(HOOK_EVENTS);
  });

  it("空白を含む dataDir で、設定に書いた command が shell でそのまま動く（Claude が shell 経由で動かす形）", () => {
    const e = makeEnv();
    expect(e.dataDir).toContain("Application Support");
    expect(cli(e, "install").status).toBe(0);
    const { command } = readJson(e.settings).statusLine;
    const stdin = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23, resets_at: 1791887400 }, seven_day: { used_percentage: 41, resets_at: 1792141200 } } });
    const r = spawnSync("/bin/sh", ["-c", command], { input: stdin, encoding: "utf8" });
    expect(r).toMatchObject({ status: 0, stdout: "週 41% · 5時間 23%\n", stderr: "" });
    expect(readJson(path.join(e.dataDir, "usage.json"))).toMatchObject({ version: 1, sevenDay: { usedPercentage: 41 } });
  });
});
