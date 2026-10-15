import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractUsage, formatLine, readUsage, runStatusline, sweepStaleTmp, writeSessionMetrics, writeUsage } from "../../hooks/ac-statusline.mjs";
import { installStatuslineCommand, statuslineCommandPathIn } from "../../server/activity-setup.ts";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const LIMITS = { five_hour: { used_percentage: 23, resets_at: 1791887400 }, seven_day: { used_percentage: 41, resets_at: 1792141200 } };
/** statusLine の 2 回目以降の入力（工程0(a) の実測の形） */
const input = (rate_limits?: unknown) => JSON.stringify({ session_id: "s", model: { id: "m" }, ...(rate_limits === undefined ? {} : { rate_limits }) });

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-statusline-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const usageFile = (dataDir: string) => path.join(dataDir, "usage.json");
const readRaw = (dataDir: string) => readFileSync(usageFile(dataDir), "utf8");

describe("K1: extractUsage（rate_limits だけを取り出す）", () => {
  it("five_hour と seven_day の used_percentage・resets_at だけを取り出す。ほかの鍵は持ち込まない", () => {
    expect(extractUsage(JSON.parse(input({ ...LIMITS, extra: 1 })))).toEqual({
      fiveHour: { usedPercentage: 23, resetsAt: 1791887400 },
      sevenDay: { usedPercentage: 41, resetsAt: 1792141200 },
    });
  });
  it("片方の窓だけでも通る（窓は個別に欠ける）", () => {
    expect(extractUsage({ rate_limits: { seven_day: LIMITS.seven_day } })).toEqual({ sevenDay: { usedPercentage: 41, resetsAt: 1792141200 } });
  });
});

describe("K3: 取り出せない入力は null（usage.json を書き換えない前提）", () => {
  it.each([
    ["rate_limits が無い（1 回目の呼び出し）", JSON.parse(input())],
    ["rate_limits が空", { rate_limits: {} }],
    ["配列", []],
    ["null", null],
    ["used_percentage が負", { rate_limits: { five_hour: { used_percentage: -1, resets_at: 1791887400 } } }],
    ["used_percentage が 100 超", { rate_limits: { five_hour: { used_percentage: 100.5, resets_at: 1791887400 } } }],
    ["used_percentage が数でない", { rate_limits: { five_hour: { used_percentage: "50", resets_at: 1791887400 } } }],
    ["used_percentage が NaN 相当（null）", { rate_limits: { five_hour: { used_percentage: null, resets_at: 1791887400 } } }],
    ["resets_at が 0", { rate_limits: { five_hour: { used_percentage: 5, resets_at: 0 } } }],
    ["resets_at が小数", { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1.5 } } }],
    ["片方の窓だけ範囲外", { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1791887400 }, seven_day: { used_percentage: 101, resets_at: 1792141200 } } }],
  ])("%s", (_name, value) => {
    expect(extractUsage(value)).toBeNull();
  });
});

describe("K2: formatLine（Claude の画面の下の行。数字と記号だけ）", () => {
  it("両方あれば「週 N% · 5時間 M%」", () => {
    expect(formatLine(extractUsage(JSON.parse(input(LIMITS))))).toBe("週 41% · 5時間 23%");
  });
  it("片方なら片方だけ。無ければ空", () => {
    expect(formatLine({ sevenDay: { usedPercentage: 41, resetsAt: 1 } })).toBe("週 41%");
    expect(formatLine({ fiveHour: { usedPercentage: 23, resetsAt: 1 } })).toBe("5時間 23%");
    expect(formatLine(null)).toBe("");
  });
  it("小数は四捨五入", () => {
    expect(formatLine({ sevenDay: { usedPercentage: 41.6, resetsAt: 1 } })).toBe("週 42%");
  });
});

describe("K1/K6: writeUsage・readUsage", () => {
  it("{version, observedAt, fiveHour?, sevenDay?} を 600 で書く。一時ファイルは残らない", () => {
    const dir = tmp();
    const usage = extractUsage(JSON.parse(input(LIMITS)));
    writeUsage(dir, usage!, NOW);
    expect(JSON.parse(readRaw(dir))).toEqual({ version: 1, observedAt: NOW, ...usage });
    expect(statSync(usageFile(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["usage.json"]);
  });
  it("readUsage: 無ければ none、書いた物は ok", () => {
    const dir = tmp();
    expect(readUsage(dir)).toEqual({ status: "none" });
    const usage = extractUsage(JSON.parse(input(LIMITS)))!;
    writeUsage(dir, usage, NOW);
    expect(readUsage(dir)).toEqual({ status: "ok", observedAt: NOW, ...usage });
  });
  it.each([
    ["JSON でない", "{broken"],
    ["version が違う", JSON.stringify({ version: 2, observedAt: NOW, fiveHour: { usedPercentage: 1, resetsAt: 1 } })],
    ["observedAt が無い", JSON.stringify({ version: 1, fiveHour: { usedPercentage: 1, resetsAt: 1 } })],
    ["窓が 1 つも無い", JSON.stringify({ version: 1, observedAt: NOW })],
    ["窓の値が範囲外", JSON.stringify({ version: 1, observedAt: NOW, fiveHour: { usedPercentage: 500, resetsAt: 1 } })],
  ])("readUsage: %s は invalid。ファイルは書き換えない", (_n, body) => {
    const dir = tmp();
    writeFileSync(usageFile(dir), body);
    expect(readUsage(dir)).toEqual({ status: "invalid" });
    expect(readRaw(dir)).toBe(body);
  });
});

describe("K3: runStatusline（壊れた入力で Claude の画面を止めない）", () => {
  const BEFORE = JSON.stringify({ version: 1, observedAt: NOW - 1000, sevenDay: { usedPercentage: 10, resetsAt: 1792141200 } });
  function seeded(): string {
    const dir = tmp();
    writeFileSync(usageFile(dir), BEFORE);
    return dir;
  }
  it.each([
    ["rate_limits が無い入力（1 回目）", input()],
    ["壊れた JSON", "{not json"],
    ["空の入力", ""],
    ["値が範囲外", input({ five_hour: { used_percentage: 120, resets_at: 1791887400 } })],
    ["大きすぎる入力", `${" ".repeat(1024 * 1024 + 1)}{}`],
  ])("%s: 空の行・終了コード 0・usage.json は変わらない", (_n, stdinText) => {
    const dir = seeded();
    expect(runStatusline({ stdinText, dataDir: dir, now: NOW })).toEqual({ code: 0, stdout: "\n" });
    expect(readRaw(dir)).toBe(BEFORE);
  });
  it("書けない場所でも例外を投げず、画面の行は出す", () => {
    const dir = tmp();
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    expect(runStatusline({ stdinText: input(LIMITS), dataDir: path.join(blocker, "sub"), now: NOW })).toEqual({ code: 0, stdout: "週 41% · 5時間 23%\n" });
  });
  it("正しい入力は書いて、行を返す", () => {
    const dir = tmp();
    expect(runStatusline({ stdinText: input(LIMITS), dataDir: dir, now: NOW })).toEqual({ code: 0, stdout: "週 41% · 5時間 23%\n" });
    expect(readUsage(dir)).toMatchObject({ status: "ok", observedAt: NOW });
  });
});

describe("K4: 外へ通信しない・200ms 以内（命令の関数。node の起動は含めない）", () => {
  it("読み取り・検査・書き込みが 200ms 以内", () => {
    const dir = tmp();
    const t0 = performance.now();
    runStatusline({ stdinText: input(LIMITS), dataDir: dir, now: NOW });
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("ソースが通信の部品を import していない", () => {
    const src = readFileSync(path.join(REPO, "hooks", "ac-statusline.mjs"), "utf8");
    expect(src).not.toMatch(/node:(http|https|net|dgram|tls|dns|child_process)|fetch\(|XMLHttpRequest|WebSocket/);
  });
});

describe("K10/K5: 本物の命令（dataDir/bin に写したもの）", () => {
  function placed(): { dataDir: string; command: string } {
    const dataDir = path.join(tmp(), "Application Support", "agent-console");
    const command = installStatuslineCommand(path.join(REPO, "hooks"), dataDir);
    return { dataDir, command };
  }
  it("写した先は dataDir/bin/ac-statusline.mjs・600・正本と同じ中身", () => {
    const { dataDir, command } = placed();
    expect(command).toBe(statuslineCommandPathIn(dataDir));
    expect(statSync(command).mode & 0o777).toBe(0o600);
    expect(readFileSync(command, "utf8")).toBe(readFileSync(path.join(REPO, "hooks", "ac-statusline.mjs"), "utf8"));
  });
  it("標準入力から usage.json を書き、標準出力に 1 行。標準エラーは空・終了コード 0", () => {
    const { dataDir, command } = placed();
    const r = spawnSync(process.execPath, [command], { input: input(LIMITS), encoding: "utf8" });
    expect(r).toMatchObject({ status: 0, stdout: "週 41% · 5時間 23%\n", stderr: "" });
    expect(readUsage(dataDir)).toMatchObject({ status: "ok", sevenDay: { usedPercentage: 41 }, fiveHour: { usedPercentage: 23 } });
  });
  it("rate_limits の無い入力では、書かず・空の行・終了コード 0", () => {
    const { dataDir, command } = placed();
    const r = spawnSync(process.execPath, [command], { input: input(), encoding: "utf8" });
    expect(r).toMatchObject({ status: 0, stdout: "\n", stderr: "" });
    expect(existsSync(usageFile(dataDir))).toBe(false);
  });
  it("リポジトリの hooks/ から直接動かしても、どこにも書かない", () => {
    const r = spawnSync(process.execPath, [path.join(REPO, "hooks", "ac-statusline.mjs")], { input: input(LIMITS), encoding: "utf8" });
    expect(r).toMatchObject({ status: 0, stdout: "\n" });
    expect(existsSync(path.join(REPO, "usage.json"))).toBe(false);
  });
  it("K5: 同時に何本が書いても、ファイルは壊れず、一時ファイルも残らない", async () => {
    const { dataDir, command } = placed();
    const runs = Array.from({ length: 12 }, (_, i) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [command], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("close", resolve);
        child.stdin.end(input({ five_hour: { used_percentage: i, resets_at: 1791887400 + i } }));
      }),
    );
    expect(await Promise.all(runs)).toEqual(Array(12).fill(0));
    const result = readUsage(dataDir);
    expect(result.status).toBe("ok");
    expect(readdirSync(dataDir).sort()).toEqual(["bin", "usage.json"]);
  });
});

describe("tmp-sweep: 書き込み成功時に古い一時ファイルを片付ける", () => {
  const STALE = "usage.json.123.abc.tmp";
  /** mtime を secondsAgo 秒前にしたファイルを作る */
  function make(dataDir: string, name: string, secondsAgo: number): string {
    const f = path.join(dataDir, name);
    writeFileSync(f, "{}");
    const t = (Date.now() - secondsAgo * 1000) / 1000;
    utimesSync(f, t, t);
    return f;
  }
  const usage = { fiveHour: { usedPercentage: 1, resetsAt: 1791887400 } };

  it("K1: 120 秒前の usage.json.123.abc.tmp は writeUsage の成功後に消える", () => {
    const dataDir = tmp();
    const f = make(dataDir, STALE, 120);
    writeUsage(dataDir, usage);
    expect(existsSync(f)).toBe(false);
    expect(readUsage(dataDir).status).toBe("ok");
  });
  it("K2: mtime が今の一時ファイルは消えない", () => {
    const dataDir = tmp();
    const f = make(dataDir, STALE, 0);
    writeUsage(dataDir, usage);
    expect(existsSync(f)).toBe(true);
  });
  it("K3: 名前が合わない物は古くても消えない", () => {
    const dataDir = tmp();
    const keep = ["usage.json.bak", "usage.json.abc.tmp", "routines.json.1.a.tmp", "session-metrics.json.1.a.tmp"];
    for (const n of keep) make(dataDir, n, 120);
    writeUsage(dataDir, usage);
    for (const n of keep) expect(existsSync(path.join(dataDir, n)), n).toBe(true);
  });
  it("K4: 名前が合う古いシンボリックリンク・ディレクトリは消えない", () => {
    const dataDir = tmp();
    const target = make(dataDir, "target.txt", 120);
    const link = path.join(dataDir, "usage.json.1.a.tmp");
    symlinkSync(target, link);
    const dir = path.join(dataDir, "usage.json.2.b.tmp");
    mkdirSync(dir);
    const t = (Date.now() - 120000) / 1000;
    utimesSync(dir, t, t);
    writeUsage(dataDir, usage);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(dataDir)).toEqual(expect.arrayContaining(["usage.json.1.a.tmp", "usage.json.2.b.tmp"]));
    expect(statSync(dir).isDirectory()).toBe(true);
  });
  it("K5: writeSessionMetrics の成功後も session-metrics.json の古い一時ファイルが消える", () => {
    const dataDir = tmp();
    const stale = make(dataDir, "session-metrics.json.9.xyz.tmp", 120);
    const other = make(dataDir, STALE, 120);
    writeSessionMetrics(dataDir, { s1: { cpuPercent: 1, ramPercent: 2 } });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
  it("K6: dataDir が無くても throw せず 0 を返す。writeUsage は 200ms 以内", () => {
    expect(sweepStaleTmp(path.join(tmp(), "none"), "usage.json")).toBe(0);
    const dataDir = tmp();
    for (let i = 0; i < 20; i++) make(dataDir, `routines-${i}.json`, 0);
    const t0 = performance.now();
    writeUsage(dataDir, usage);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
