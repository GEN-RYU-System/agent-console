import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readIntakeConfig } from "../../server/discord-intake-config.ts";
import { makeAcEnv, type AcEnv } from "./helpers/ac-env.ts";

const SCRIPT = path.join(process.cwd(), "scripts", "ac-discord-intake-config.sh");
const MARKER = ".agent-console-home";
const CONFIG = "discord-intake.config.json";
const NO_TTY = "端末が無いため取り消しました";

const envs: AcEnv[] = [];
afterEach(() => { for (const e of envs.splice(0)) e.cleanup(); });

// 作り物の id（数字の並びは組み立てる。実在の id ではない）
const fid = (n: number): string => `1${String(n).padStart(17, "0")}`;
const GUILD = fid(1);
const CHANNEL = fid(2);
const AUTHOR = fid(3);
const BOT = fid(5);
const NAME = "tester";
const GOOD = [GUILD, CHANNEL, AUTHOR, NAME, BOT];

async function fresh(withMarker = true): Promise<AcEnv> {
  const e = await makeAcEnv();
  envs.push(e);
  if (withMarker) {
    mkdirSync(e.home, { recursive: true });
    writeFileSync(path.join(e.home, MARKER), "");
  }
  return e;
}
function inputFile(e: AcEnv, lines: string[]): string {
  const f = path.join(e.base, "config-input");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
function runScript(e: AcEnv, lines: string[], env: Record<string, string> = e.env) {
  return spawnSync("bash", [SCRIPT], { env: { ...env, AC_CONFIG_INPUT: inputFile(e, lines) }, encoding: "utf8", timeout: 60000 });
}
const cfgPath = (e: AcEnv): string => path.join(e.home, CONFIG);
const leftovers = (e: AcEnv): string[] => readdirSync(e.home).filter((n) => n.includes(".tmp."));

describe("ac-discord-intake-config.sh", () => {
  it("1. 正しい5行で書き、readIntakeConfig で読める", async () => {
    const e = await fresh();
    const r = runScript(e, GOOD);
    expect(r.status, r.stderr).toBe(0);
    const res = await readIntakeConfig(e.home);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.testMode).toBe(true);
      const bug = res.config.channels.find((c) => c.kind === "bug");
      expect(bug?.enabled).toBe(true);
      expect(bug?.allowedMessageTypes).toEqual([0, 19]);
      expect(res.config.forbiddenBotIds).toEqual([BOT]);
    }
  });
  it("2. ファイルの mode は 0600", async () => {
    const e = await fresh();
    expect(runScript(e, GOOD).status).toBe(0);
    expect(statSync(cfgPath(e)).mode & 0o777).toBe(0o600);
  });
  it.each([
    ["サーバー", 0],
    ["チャンネル", 1],
    ["投稿者", 2],
    ["ボット", 4],
  ])("3. %s の id の形違いは書かずに 0 以外で終わり、出力に値が出ない", async (_n, idx) => {
    const e = await fresh();
    const bad = [...GOOD];
    bad[idx] = "12ab";
    const r = runScript(e, bad);
    expect(r.status).not.toBe(0);
    expect(existsSync(cfgPath(e))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain("12ab");
    for (const v of [GUILD, CHANNEL, AUTHOR, BOT, NAME]) expect(r.stdout + r.stderr).not.toContain(v);
  });
  it("4. チャンネルとボットの id が同じなら止まる", async () => {
    const e = await fresh();
    const r = runScript(e, [GUILD, CHANNEL, AUTHOR, NAME, CHANNEL]);
    expect(r.status).not.toBe(0);
    expect(existsSync(cfgPath(e))).toBe(false);
  });
  it("5. 既にあるとき yes 以外で止まり元が残る。yes で元が Trash に移る", async () => {
    const e = await fresh();
    writeFileSync(cfgPath(e), "OLD");
    const no = runScript(e, ["no", ...GOOD]);
    expect(no.status).not.toBe(0);
    expect(readFileSync(cfgPath(e), "utf8")).toBe("OLD");
    expect(e.trashed()).toEqual([]);
    const yes = runScript(e, ["yes", ...GOOD]);
    expect(yes.status, yes.stderr).toBe(0);
    expect(e.trashed().length).toBe(1);
    expect(readFileSync(path.join(e.trashDir, e.trashed()[0]), "utf8")).toBe("OLD");
    expect((await readIntakeConfig(e.home)).ok).toBe(true);
    expect(leftovers(e)).toEqual([]);
  });
  it("6. AC_STUB_LOG が無いとき AC_CONFIG_INPUT は読まず、端末が無ければ取り消す", async () => {
    const e = await fresh(false);
    const { AC_STUB_LOG: _drop, ...rest } = e.env;
    void _drop;
    const defHome = path.join(e.env.HOME, "Library", "Application Support", "agent-console");
    mkdirSync(defHome, { recursive: true });
    writeFileSync(path.join(defHome, MARKER), "");
    const out = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn("bash", [SCRIPT], {
        env: { ...rest, AC_CONFIG_INPUT: inputFile(e, GOOD) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (d) => { text += String(d); });
      child.stderr.on("data", (d) => { text += String(d); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 30000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, text }); });
      child.on("error", reject);
    });
    expect(out.code).not.toBe(0);
    expect(out.text).toContain(NO_TTY);
    expect(existsSync(path.join(defHome, CONFIG))).toBe(false);
  });
  it("7. 印 .agent-console-home が無いとき何も書かず 0 以外で終わる", async () => {
    const e = await fresh(false);
    mkdirSync(e.home, { recursive: true });
    const r = runScript(e, GOOD);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("入っていません");
    expect(existsSync(cfgPath(e))).toBe(false);
  });
  it("8. AC_NODE を消した環境でも書ける", async () => {
    const e = await fresh();
    const { AC_NODE: _drop, ...rest } = e.env;
    void _drop;
    const r = runScript(e, GOOD, rest);
    expect(r.status, r.stderr).toBe(0);
    expect((await readIntakeConfig(e.home)).ok).toBe(true);
  });
  it("9. 確かめに通らない値で上書きを試すと元が残り Trash に何も移らず tmp も残らない", async () => {
    const e = await fresh();
    writeFileSync(cfgPath(e), "OLD");
    const r = runScript(e, ["yes", GUILD, CHANNEL, AUTHOR, NAME, CHANNEL]);
    expect(r.status).not.toBe(0);
    expect(readFileSync(cfgPath(e), "utf8")).toBe("OLD");
    expect(e.trashed()).toEqual([]);
    expect(leftovers(e)).toEqual([]);
  });
  it("9b. node の確かめで落ちる値（呼び名に引用符）でも元が残り tmp も残らない", async () => {
    const e = await fresh();
    writeFileSync(cfgPath(e), "OLD");
    const r = runScript(e, ["yes", GUILD, CHANNEL, AUTHOR, 'a"b', BOT]);
    expect(r.status).not.toBe(0);
    expect(readFileSync(cfgPath(e), "utf8")).toBe("OLD");
    expect(e.trashed()).toEqual([]);
    expect(leftovers(e)).toEqual([]);
  });
  it("10. 書けたあと tmp が残らない", async () => {
    const e = await fresh();
    expect(runScript(e, GOOD).status).toBe(0);
    expect(leftovers(e)).toEqual([]);
  });
});
