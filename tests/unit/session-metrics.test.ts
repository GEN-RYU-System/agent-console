import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMetrics, readSessionMetrics, runMetrics, SESSION_METRICS_FILE_NAME, SESSION_METRICS_FRESH_MS, writeSessionMetrics } from "../../hooks/ac-statusline.mjs";
import { installStatuslineCommand } from "../../server/activity-setup.ts";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);
const SID = "11111111-2222-3333-4444-555555555555";
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-metrics-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const stdin = (session_id?: unknown) => JSON.stringify({ model: { id: "m" }, ...(session_id === undefined ? {} : { session_id }) });
const seeded = (sessions: Record<string, { cpuPercent: number; ramPercent: number | null }>, at = NOW) => {
  const dir = tmp();
  writeSessionMetrics(dir, sessions, at);
  return dir;
};

describe("K5(a): --metrics の出力（session_id が一致し 30 秒以内なら出す）", () => {
  it("一致し新しいなら「 · CPU a% · RAM b%」（整数に丸める）", () => {
    const dir = seeded({ [SID]: { cpuPercent: 3.4, ramPercent: 4.6 } });
    expect(runMetrics({ stdinText: stdin(SID), dataDir: dir, now: NOW + 1000 })).toEqual({ code: 0, stdout: " · CPU 3% · RAM 5%" });
  });
  it("ちょうど 30 秒は出す。30 秒を超えたら空", () => {
    const dir = seeded({ [SID]: { cpuPercent: 3, ramPercent: 4 } });
    expect(runMetrics({ stdinText: stdin(SID), dataDir: dir, now: NOW + SESSION_METRICS_FRESH_MS }).stdout).toBe(" · CPU 3% · RAM 4%");
    expect(runMetrics({ stdinText: stdin(SID), dataDir: dir, now: NOW + SESSION_METRICS_FRESH_MS + 1 }).stdout).toBe("");
  });
  it("updatedAt が未来なら空", () => {
    const dir = seeded({ [SID]: { cpuPercent: 3, ramPercent: 4 } }, NOW + 5000);
    expect(runMetrics({ stdinText: stdin(SID), dataDir: dir, now: NOW }).stdout).toBe("");
  });
  it("session_id が違う・無い・文字列でないなら空", () => {
    const dir = seeded({ [SID]: { cpuPercent: 3, ramPercent: 4 } });
    for (const s of ["other", "", undefined, 5, null, "__proto__", "constructor"]) {
      expect(runMetrics({ stdinText: stdin(s), dataDir: dir, now: NOW }).stdout, String(s)).toBe("");
    }
  });
  it("ファイルが無い・壊れている・形が違うなら空（例外を投げない）", () => {
    const empty = tmp();
    expect(runMetrics({ stdinText: stdin(SID), dataDir: empty, now: NOW })).toEqual({ code: 0, stdout: "" });
    for (const body of ["{not json", "[]", "null", JSON.stringify({ version: 2, updatedAt: NOW, sessions: { [SID]: { cpuPercent: 1, ramPercent: 1 } } }), JSON.stringify({ version: 1, updatedAt: NOW, sessions: { [SID]: { cpuPercent: 101, ramPercent: 1 } } }), JSON.stringify({ version: 1, updatedAt: NOW, sessions: { [SID]: { cpuPercent: 1, ramPercent: "x" } } }), JSON.stringify({ version: 1, updatedAt: "now", sessions: {} })]) {
      const dir = tmp();
      writeFileSync(path.join(dir, SESSION_METRICS_FILE_NAME), body);
      expect(runMetrics({ stdinText: stdin(SID), dataDir: dir, now: NOW }), body).toEqual({ code: 0, stdout: "" });
    }
  });
  it("壊れた標準入力・大きすぎる入力は空", () => {
    const dir = seeded({ [SID]: { cpuPercent: 3, ramPercent: 4 } });
    for (const t of ["{not json", "", "[]", `${" ".repeat(1024 * 1024 + 1)}{}`]) expect(runMetrics({ stdinText: t, dataDir: dir, now: NOW }).stdout).toBe("");
  });
  it("ramPercent が null なら CPU だけ", () => {
    expect(formatMetrics({ cpuPercent: 2, ramPercent: null })).toBe(" · CPU 2%");
    expect(formatMetrics(null)).toBe("");
  });
});

describe("writeSessionMetrics（サーバーが書く）", () => {
  it("version・updatedAt・sessions を 600 で書く。範囲外・空 id の項目は載せない", () => {
    const dir = tmp();
    const file = writeSessionMetrics(dir, { [SID]: { cpuPercent: 1.5, ramPercent: null }, bad: { cpuPercent: 120, ramPercent: 1 }, bad2: { cpuPercent: 1, ramPercent: -1 }, "": { cpuPercent: 1, ramPercent: 1 } }, NOW);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, updatedAt: NOW, sessions: { [SID]: { cpuPercent: 1.5, ramPercent: null } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSessionMetrics(dir, SID, NOW)).toEqual({ cpuPercent: 1.5, ramPercent: null });
  });
  it("セッションが 0 件でも書く（updatedAt を新しく保つ）", () => {
    const dir = tmp();
    writeSessionMetrics(dir, {}, NOW);
    expect(JSON.parse(readFileSync(path.join(dir, SESSION_METRICS_FILE_NAME), "utf8")).sessions).toEqual({});
  });
});

describe("K5(a): 本物の命令（dataDir/bin に写したもの）の --metrics", () => {
  it("一致するときだけ出力し、リポジトリの hooks/ から直接動かしたときは何も出さない。usage.json は書かない", () => {
    const dataDir = tmp();
    const command = installStatuslineCommand(path.join(REPO, "hooks"), dataDir);
    writeSessionMetrics(dataDir, { [SID]: { cpuPercent: 7, ramPercent: 9 } }, Date.now());
    const hit = spawnSync(process.execPath, [command, "--metrics"], { input: stdin(SID), encoding: "utf8" });
    expect([hit.status, hit.stdout]).toEqual([0, " · CPU 7% · RAM 9%"]);
    const miss = spawnSync(process.execPath, [command, "--metrics"], { input: stdin("other"), encoding: "utf8" });
    expect([miss.status, miss.stdout]).toEqual([0, ""]);
    const direct = spawnSync(process.execPath, [path.join(REPO, "hooks", "ac-statusline.mjs"), "--metrics"], { input: stdin(SID), encoding: "utf8" });
    expect([direct.status, direct.stdout]).toEqual([0, ""]);
    expect(() => statSync(path.join(dataDir, "usage.json"))).toThrow();
  });
});
