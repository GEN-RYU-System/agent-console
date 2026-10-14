import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOOK_SPECS, checkHooks, installHooks, isOwnHandler, uninstallHooks } from "../../server/activity-hooks.ts";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const CLI = path.join(REPO, "scripts", "ac-hooks.mjs");
const EVENTS = ["PreToolUse", "PostToolUse", "SubagentStop", "TaskCreated", "TaskCompleted", "UserPromptSubmit", "Stop", "StopFailure", "SubagentStart"];
/** v0.10.0 までに install した 6 つ（Stop・StopFailure・SubagentStart はまだ無い） */
const OLD_EVENTS = EVENTS.slice(0, 6);
/** v0.11.0 までに install した 8 つ（SubagentStart はまだ無い） */
const V0_11_EVENTS = EVENTS.slice(0, 8);
/** 記録用 hook（activity-hook.mjs）の handler 数 */
const ACTIVITY_HANDLER_COUNT = EVENTS.length;
/** 自分の handler の総数（記録用 9 ＋ ac-routine-guard 1） */
const OWN_HANDLER_COUNT = EVENTS.length + 1;
const GUARD_MISSING = "PreToolUse(ac-routine-guard.mjs)";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-hooks-"));
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
  hookPath: string;
  nodePath: string;
}
/** 一時の HOME。dataDir は空白入り。hook の写しは先に置く（install 側が置く場合は place=false） */
function makeEnv(place = true): Env {
  const home = tmp();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const dataDir = path.join(home, "Library", "Application Support", "agent-console");
  const hookPath = path.join(dataDir, "hooks", "activity-hook.mjs");
  if (place) {
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, "// hook\n");
    writeFileSync(path.join(path.dirname(hookPath), "ac-routine-guard.mjs"), "// guard\n");
  }
  return { home, settings: path.join(home, ".claude", "settings.json"), dataDir, hookPath, nodePath: process.execPath };
}
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any
const backups = (e: Env): string[] => readdirSync(path.dirname(e.settings)).filter((n) => n.startsWith("settings.json.ac-backup-")).sort();
const ownHandler = (e: Env): object => ({ type: "command", command: e.nodePath, args: [e.hookPath], async: true });

const PO_SETTINGS = {
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "/Users/x/.claude/scripts/agent-stop-hook.sh" }] }],
    PreToolUse: [
      { hooks: [{ type: "command", command: "/Users/x/.claude/scripts/agent-start-hook.sh", async: true }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "/Users/x/.claude/scripts/guard.sh" }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "/Users/x/.claude/scripts/card-lint-hook.sh" }] }],
  },
  enabledPlugins: { a: true },
  autoMode: { x: 1 },
};

describe("K6: 設定の定義", () => {
  it("10 本の handler（9 つのイベント＋ ac-routine-guard）と matcher は設計のとおり（v0.11.0 で Stop と StopFailure、v0.12.0 で SubagentStart、v0.25.0 で guard を足した）", () => {
    expect(HOOK_SPECS).toEqual([
      { event: "PreToolUse", matcher: "Agent|SubagentHandback" },
      { event: "PostToolUse", matcher: "Agent" },
      { event: "SubagentStop" },
      { event: "TaskCreated" },
      { event: "TaskCompleted" },
      { event: "UserPromptSubmit" },
      { event: "Stop" },
      { event: "StopFailure" },
      { event: "SubagentStart" },
      { event: "PreToolUse", matcher: "Bash", file: "ac-routine-guard.mjs", async: false, timeout: 5, if: "Bash(*/bin/ac-routine.mjs*)" },
    ]);
  });

  it("自分の handler の見分け方: args[0] が /hooks/activity-hook.mjs で終わる command の handler だけ", () => {
    expect(isOwnHandler({ type: "command", command: "/n/node", args: ["/d/Application Support/agent-console/hooks/activity-hook.mjs"] })).toBe(true);
    expect(isOwnHandler({ type: "command", command: "/n/node", args: ["/d/hooks/other.mjs"] })).toBe(false);
    expect(isOwnHandler({ type: "command", command: "/d/hooks/activity-hook.mjs" })).toBe(false);
    expect(isOwnHandler({ type: "http", url: "x", args: ["/hooks/activity-hook.mjs"] })).toBe(false);
    expect(isOwnHandler({ type: "command", command: "/n/node", args: ["/d/Application Support/agent-console/hooks/ac-routine-guard.mjs"], timeout: 5 })).toBe(true);
    expect(isOwnHandler(null)).toBe(false);
    expect(isOwnHandler("x")).toBe(false);
  });
});

describe("K6: install", () => {
  it("今の設定のキーと、ほかの hook をすべて残して、自分の handler を 9 つのイベント＋ guard に足す（exec の形・空白入りのパス）", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    const r = installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath, now: () => Date.UTC(2026, 9, 12, 14, 0, 0, 123) });
    expect(r.changed).toBe(true);
    const after = readJson(e.settings);
    // ほかのキーは一字一句同じ
    expect(after.permissions).toEqual(PO_SETTINGS.permissions);
    expect(after.enabledPlugins).toEqual(PO_SETTINGS.enabledPlugins);
    expect(after.autoMode).toEqual(PO_SETTINGS.autoMode);
    // PO の Stop の group は先頭にそのまま残り、自分の group が末尾に足される。StopFailure は自分だけ
    expect(after.hooks.Stop).toEqual([...PO_SETTINGS.hooks.Stop, { hooks: [ownHandler(e)] }]);
    expect(after.hooks.StopFailure).toEqual([{ hooks: [ownHandler(e)] }]);
    // 既存の group は先頭にそのまま残り、自分の group が末尾に足される
    expect(after.hooks.PreToolUse.slice(0, 2)).toEqual(PO_SETTINGS.hooks.PreToolUse);
    expect(after.hooks.PreToolUse[2]).toEqual({ matcher: "Agent|SubagentHandback", hooks: [ownHandler(e)] });
    expect(after.hooks.PreToolUse[3]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: e.nodePath, args: [path.join(path.dirname(e.hookPath), "ac-routine-guard.mjs")], timeout: 5, if: "Bash(*/bin/ac-routine.mjs*)" }] });
    expect(after.hooks.PostToolUse).toEqual([{ matcher: "Agent", hooks: [ownHandler(e)] }]);
    expect(after.hooks.UserPromptSubmit).toEqual([...PO_SETTINGS.hooks.UserPromptSubmit, { hooks: [ownHandler(e)] }]);
    for (const ev of EVENTS) expect(JSON.stringify(after.hooks[ev])).toContain("activity-hook.mjs");
    // 空白を含む dataDir でも args の 1 要素のまま（引用符なし）
    expect(after.hooks.TaskCreated[0].hooks[0].args).toEqual([e.hookPath]);
    expect(e.hookPath).toContain("Application Support");
  });

  it("足す前に控え（settings.json.ac-backup-<日時>）を取る。控えは元の中身と同じ", () => {
    const e = makeEnv();
    const original = JSON.stringify(PO_SETTINGS, null, 2) + "\n";
    writeFileSync(e.settings, original);
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath, now: () => Date.UTC(2026, 9, 12, 14, 0, 0, 123) });
    expect(backups(e)).toEqual(["settings.json.ac-backup-20261012T140000123Z"]);
    expect(readFileSync(path.join(path.dirname(e.settings), backups(e)[0]), "utf8")).toBe(original);
    expect(statSync(e.settings).mode & 0o777).toBe(statSync(path.join(path.dirname(e.settings), backups(e)[0])).mode & 0o777);
  });

  it("2 回実行しても増えない。2 回目は何も書かず、控えも増やさない", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    const once = readFileSync(e.settings, "utf8");
    const r2 = installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(r2.changed).toBe(false);
    expect(readFileSync(e.settings, "utf8")).toBe(once);
    expect(backups(e)).toHaveLength(1);
    const count = (JSON.stringify(readJson(e.settings)).match(/activity-hook\.mjs/g) ?? []).length;
    expect(count).toBe(ACTIVITY_HANDLER_COUNT);
    expect((JSON.stringify(readJson(e.settings)).match(/ac-routine-guard\.mjs/g) ?? []).length).toBe(1);
  });

  it("v0.11.0 までの 8 つだけが入っている設定に install し直すと、SubagentStart の 1 つだけが足される（既存の 8 つは変わらない）", () => {
    const e = makeEnv();
    const old8 = { hooks: Object.fromEntries(V0_11_EVENTS.map((ev) => [ev, [HOOK_SPECS.find((s) => s.event === ev)?.matcher ? { matcher: HOOK_SPECS.find((s) => s.event === ev)?.matcher, hooks: [ownHandler(e)] } : { hooks: [ownHandler(e)] }]])) };
    writeFileSync(e.settings, JSON.stringify(old8, null, 2) + "\n");
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "missingHandler", missingEvents: ["SubagentStart", GUARD_MISSING] });
    const before = readJson(e.settings);
    const r = installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(r.changed).toBe(true);
    const after = readJson(e.settings);
    for (const ev of V0_11_EVENTS) expect(after.hooks[ev].slice(0, before.hooks[ev].length)).toEqual(before.hooks[ev]); // 既存の group は変わらない（PreToolUse は末尾に guard の group が足される）
    expect(after.hooks.SubagentStart).toEqual([{ hooks: [ownHandler(e)] }]);
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toEqual({ ok: true });
  });

  it("v0.10.0 までの 6 つだけが入っている設定に install し直すと、Stop・StopFailure・SubagentStart の 3 つだけが足される（既存の 6 つは変わらない）", () => {
    const e = makeEnv();
    const oldOnly = { hooks: Object.fromEntries(OLD_EVENTS.map((ev) => [ev, [HOOK_SPECS.find((s) => s.event === ev)?.matcher ? { matcher: HOOK_SPECS.find((s) => s.event === ev)?.matcher, hooks: [ownHandler(e)] } : { hooks: [ownHandler(e)] }]])) };
    writeFileSync(e.settings, JSON.stringify({ ...oldOnly, hooks: { ...oldOnly.hooks, Stop: PO_SETTINGS.hooks.Stop } }, null, 2) + "\n");
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "missingHandler", missingEvents: ["Stop", "StopFailure", "SubagentStart", GUARD_MISSING] });
    const before = readJson(e.settings);
    const r = installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(r.changed).toBe(true);
    const after = readJson(e.settings);
    for (const ev of OLD_EVENTS) expect(after.hooks[ev].slice(0, before.hooks[ev].length)).toEqual(before.hooks[ev]); // 既存の group は変わらない（PreToolUse は末尾に guard の group が足される）
    expect(after.hooks.Stop).toEqual([...PO_SETTINGS.hooks.Stop, { hooks: [ownHandler(e)] }]);
    expect(after.hooks.StopFailure).toEqual([{ hooks: [ownHandler(e)] }]);
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toEqual({ ok: true });
  });

  it("node のパスが変わっていたら（版の更新）、自分の handler をその場で直す。増やさない", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    installHooks({ settingsPath: e.settings, nodePath: "/old/node/v1/bin/node", hookPath: e.hookPath });
    const r = installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(r.changed).toBe(true);
    const after = readJson(e.settings);
    expect(after.hooks.SubagentStop).toEqual([{ hooks: [ownHandler(e)] }]);
    expect((JSON.stringify(after).match(/activity-hook\.mjs/g) ?? []).length).toBe(ACTIVITY_HANDLER_COUNT);
  });

  it("設定が壊れた JSON・hooks の形が想定外のときは、何も書かずに失敗する（控えも作らない）", () => {
    const e = makeEnv();
    writeFileSync(e.settings, "{broken");
    expect(() => installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath })).toThrow(/JSON/);
    expect(readFileSync(e.settings, "utf8")).toBe("{broken");
    writeFileSync(e.settings, JSON.stringify({ hooks: { PreToolUse: "oops" } }));
    expect(() => installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath })).toThrow(/PreToolUse/);
    writeFileSync(e.settings, JSON.stringify({ hooks: [] }));
    expect(() => installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath })).toThrow(/hooks/);
    expect(backups(e)).toEqual([]);
  });

  it("settings.json がまだ無いときは hooks だけの設定を作る。インデントは元のものに合わせる。シンボリックリンクは先の実体に書く", () => {
    const e = makeEnv();
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(Object.keys(readJson(e.settings))).toEqual(["hooks"]);
    expect(backups(e)).toEqual([]);

    const e2 = makeEnv();
    const real = path.join(e2.home, "dotfiles-settings.json");
    writeFileSync(real, '{\n    "model": "x"\n}\n');
    symlinkSync(real, e2.settings);
    installHooks({ settingsPath: e2.settings, nodePath: e2.nodePath, hookPath: e2.hookPath });
    expect(readFileSync(real, "utf8")).toMatch(/^\{\n {4}"model": "x",\n {4}"hooks": \{/);
    expect(statSync(e2.settings).isFile()).toBe(true);
    expect(readJson(real).hooks.TaskCreated).toBeDefined();
  });

  it("控えは新しい 6 つだけを残す（1 回の install で hooks の段と statusLine の段の 2 つできるため）。消すのは settings.json.ac-backup-<日時> の形のファイルだけ", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS) + "\n");
    const dir = path.dirname(e.settings);
    const names = ["20260101T000000000Z", "20260102T000000000Z", "20260103T000000000Z", "20260104T000000000Z", "20260105T000000000Z", "20260106T000000000Z"].map((s) => `settings.json.ac-backup-${s}`);
    for (const n of names) writeFileSync(path.join(dir, n), "{}");
    writeFileSync(path.join(dir, "settings.json.ac-backup-manual"), "{}");
    writeFileSync(path.join(dir, "settings.local.json"), "{}");
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath, now: () => Date.UTC(2026, 9, 12, 14, 0, 0, 0) });
    expect(backups(e)).toEqual([names[1], names[2], names[3], names[4], names[5], "settings.json.ac-backup-20261012T140000000Z", "settings.json.ac-backup-manual"].sort());
    expect(existsSync(path.join(dir, "settings.local.json"))).toBe(true);
  });
});

describe("K6: uninstall", () => {
  it("自分の handler だけを外し、空になった自分の group を消す。ほかの handler・group は残す", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    const r = uninstallHooks({ settingsPath: e.settings });
    expect(r.removed).toBe(OWN_HANDLER_COUNT);
    expect(readJson(e.settings)).toEqual(PO_SETTINGS);
  });

  it("同じ group に別の handler があれば、その group は残し、自分の handler だけ外す", () => {
    const e = makeEnv();
    const shared = { hooks: { TaskCreated: [{ hooks: [{ type: "command", command: "/x/other.sh" }, ownHandler(e)] }] } };
    writeFileSync(e.settings, JSON.stringify(shared));
    uninstallHooks({ settingsPath: e.settings });
    expect(readJson(e.settings)).toEqual({ hooks: { TaskCreated: [{ hooks: [{ type: "command", command: "/x/other.sh" }] }] } });
  });

  it("自分の handler が無ければ何も書かない（控えも作らない）。外した結果 hooks が空のイベントのキーは消す", () => {
    const e = makeEnv();
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS));
    const r = uninstallHooks({ settingsPath: e.settings });
    expect(r).toMatchObject({ removed: 0, changed: false });
    expect(backups(e)).toEqual([]);
    writeFileSync(e.settings, JSON.stringify({ hooks: { TaskCreated: [{ hooks: [ownHandler(e)] }] } }));
    uninstallHooks({ settingsPath: e.settings });
    expect(readJson(e.settings)).toEqual({ hooks: {} });
  });

  it("settings.json が無いときは、何もせず成功する", () => {
    const e = makeEnv();
    expect(uninstallHooks({ settingsPath: e.settings })).toMatchObject({ removed: 0, changed: false });
    expect(existsSync(e.settings)).toBe(false);
  });
});

describe("K6 / K8: check", () => {
  it("handler が 10 本そろい、node と hook のファイルがあれば ok", () => {
    const e = makeEnv();
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toEqual({ ok: true });
  });

  it("settings.json が無い・読めない・handler が無い・一部のイベントが欠けている・node が無い・hook のファイルが無い、を見分ける", () => {
    const e = makeEnv();
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "noSettings" });
    writeFileSync(e.settings, "{broken");
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "unreadable" });
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS));
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "missingHandler", missingEvents: [...EVENTS, GUARD_MISSING] });

    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    const partial = readJson(e.settings);
    delete partial.hooks.TaskCompleted;
    writeFileSync(e.settings, JSON.stringify(partial));
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "missingHandler", missingEvents: ["TaskCompleted"] });

    installHooks({ settingsPath: e.settings, nodePath: "/gone/node", hookPath: e.hookPath });
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "nodeMissing" });

    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: e.hookPath });
    rmSync(e.hookPath);
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "hookFileMissing" });
  });

  it("別の dataDir の hook を指す handler だけがあるときは、この dataDir の分は無いものとして扱う", () => {
    const e = makeEnv();
    installHooks({ settingsPath: e.settings, nodePath: e.nodePath, hookPath: path.join(e.home, "other", "hooks", "activity-hook.mjs") });
    expect(checkHooks({ settingsPath: e.settings, hookPath: e.hookPath })).toMatchObject({ ok: false, reason: "missingHandler" });
  });
});

describe("K6: コマンド（scripts/ac-hooks.mjs を一時の HOME で）", () => {
  function cli(e: Env, ...args: string[]): { status: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [CLI, ...args, "--data-dir", e.dataDir], { encoding: "utf8", env: { ...process.env, HOME: e.home, AGENT_CONSOLE_PORT: "" } });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it("install を 2 回 → check ok → uninstall → check ng。hook の写しは install が置く。実ホームの設定には触れない", () => {
    const e = makeEnv(false);
    writeFileSync(e.settings, JSON.stringify(PO_SETTINGS, null, 2) + "\n");
    const realSettings = path.join(os.homedir(), ".claude", "settings.json");
    const realBefore = existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null;

    const i1 = cli(e, "install");
    expect(i1.status, i1.err).toBe(0);
    expect(existsSync(e.hookPath)).toBe(true);
    expect(readFileSync(e.hookPath, "utf8")).toBe(readFileSync(path.join(REPO, "hooks", "activity-hook.mjs"), "utf8"));
    expect(readFileSync(path.join(path.dirname(e.hookPath), "ac-routine-guard.mjs"), "utf8")).toBe(readFileSync(path.join(REPO, "hooks", "ac-routine-guard.mjs"), "utf8"));
    const i2 = cli(e, "install");
    expect(i2.status, i2.err).toBe(0);
    expect((JSON.stringify(readJson(e.settings)).match(/activity-hook\.mjs/g) ?? []).length).toBe(ACTIVITY_HANDLER_COUNT);
    expect(readJson(e.settings).hooks.TaskCreated[0].hooks[0]).toEqual({ type: "command", command: process.execPath, args: [e.hookPath], async: true });

    const c1 = cli(e, "check");
    expect(c1.status, c1.err).toBe(0);
    expect(JSON.parse(c1.out)).toMatchObject({ ok: true });

    const u = cli(e, "uninstall");
    expect(u.status, u.err).toBe(0);
    expect(readJson(e.settings)).toEqual(PO_SETTINGS);
    const c2 = cli(e, "check");
    expect(c2.status).toBe(1);
    expect(JSON.parse(c2.out)).toMatchObject({ ok: false, reason: "missingHandler" });

    const realAfter = existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null;
    expect(realAfter).toBe(realBefore);
  });

  it("壊れた settings.json では install が失敗（終了コード 1）し、中身は変わらない。使い方の間違いは終了コード 2", () => {
    const e = makeEnv(false);
    writeFileSync(e.settings, "{broken");
    const r = cli(e, "install");
    expect(r.status).toBe(1);
    expect(readFileSync(e.settings, "utf8")).toBe("{broken");
    expect(cli(e, "bogus").status).toBe(2);
  });
});
