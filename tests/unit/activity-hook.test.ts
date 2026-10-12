import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LINE_BYTES, activityFileName, appendRecord, buildRecord } from "../../hooks/activity-hook.mjs";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const HOOK_SOURCE = path.join(REPO, "hooks", "activity-hook.mjs");
const APPEND_MANY = path.join(REPO, "tests", "fixtures", "append-many.mjs");
const SID = "11111111-2222-4333-8444-555555555555";
const NOW = Date.UTC(2026, 9, 12, 14, 0, 0);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-hook-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 本番と同じ並び（dataDir/hooks/activity-hook.mjs）に写して、本物の node で動かす。dataDir は空白入り */
function installHook(): { dataDir: string; hook: string } {
  const dataDir = path.join(tmp(), "Application Support", "agent-console");
  mkdirSync(path.join(dataDir, "hooks"), { recursive: true });
  const hook = path.join(dataDir, "hooks", "activity-hook.mjs");
  copyFileSync(HOOK_SOURCE, hook);
  return { dataDir, hook };
}

function runHook(hook: string, stdin: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");

describe("K5 / §3-2: buildRecord は決めた項目と長さだけを残す", () => {
  it("PreToolUse(Agent): tool_use_id・description(200字)・subagent_type・model だけ。prompt の本文は残さない", () => {
    const rec = buildRecord(
      {
        session_id: SID,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_1",
        transcript_path: "/secret/transcript.jsonl",
        cwd: "/secret/cwd",
        tool_input: { description: "あ".repeat(300), prompt: "長い指示文 ".repeat(100), subagent_type: "general-purpose", model: "sonnet", run_in_background: true },
      },
      NOW,
    );
    expect(rec).toEqual({
      ts: NOW,
      event: "PreToolUse",
      session_id: SID,
      tool: "Agent",
      tool_use_id: "toolu_1",
      description: "あ".repeat(200),
      subagent_type: "general-purpose",
      model: "sonnet",
    });
  });

  it("PreToolUse(SubagentHandback): agent_id と message の先頭 120 字", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_id: "adb7", tool_input: { message: "報告".repeat(100) } }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "PreToolUse", session_id: SID, agent_id: "adb7", tool: "SubagentHandback", message: "報告".repeat(60) });
  });

  it("PostToolUse(Agent): status・agentId・resolvedModel。totalDurationMs は来たときだけ", () => {
    const base = { session_id: SID, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { prompt: "x" } };
    const async_ = buildRecord({ ...base, tool_response: { status: "async_launched", agentId: "adb7", resolvedModel: "claude-sonnet-5-5", content: "本文は残さない", prompt: "x" } }, NOW);
    expect(async_).toEqual({ ts: NOW, event: "PostToolUse", session_id: SID, tool: "Agent", tool_use_id: "toolu_1", status: "async_launched", agentId: "adb7", resolvedModel: "claude-sonnet-5-5" });
    const done = buildRecord({ ...base, tool_response: { status: "completed", agentId: "adb8", resolvedModel: "claude-opus", totalDurationMs: 4200 } }, NOW);
    expect(done).toMatchObject({ status: "completed", agentId: "adb8", totalDurationMs: 4200 });
  });

  it("SubagentStop: agent_id・agent_type・last_assistant_message の先頭 120 字（空なら項目ごと無い）", () => {
    const withMsg = buildRecord({ session_id: SID, hook_event_name: "SubagentStop", agent_id: "adb7", agent_type: "general-purpose", last_assistant_message: "終わり ".repeat(80) }, NOW);
    expect(withMsg?.last_assistant_message).toHaveLength(120);
    expect(withMsg).toMatchObject({ event: "SubagentStop", agent_id: "adb7", agent_type: "general-purpose" });
    const without = buildRecord({ session_id: SID, hook_event_name: "SubagentStop", agent_id: "adb7", agent_type: "" }, NOW);
    expect(without).not.toHaveProperty("last_assistant_message");
  });

  it("TaskCreated / TaskCompleted: task_id と task_subject(200字)。task_description は残さない", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "TaskCreated", task_id: "1", task_subject: "題".repeat(250), task_description: "説明は残さない" }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "題".repeat(200) });
    expect(buildRecord({ session_id: SID, hook_event_name: "TaskCompleted", task_id: "1", task_subject: "題" }, NOW)).toMatchObject({ event: "TaskCompleted", task_id: "1" });
  });

  it("UserPromptSubmit: prompt の先頭 80 字。改行は空白 1 つにまとめる。工程0で分かった <agent-message の印は source=agent", () => {
    const human = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: `最初の行\n\n次の行 ${"あ".repeat(200)}` }, NOW);
    expect(human?.prompt).toBe(`最初の行 次の行 ${"あ".repeat(80 - "最初の行 次の行 ".length)}`);
    expect(human).not.toHaveProperty("source");
    const agent = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: '<agent-message from="adb7">\n[Subagent hand-back] ...' }, NOW);
    expect(agent).toMatchObject({ source: "agent" });
    expect(String(agent?.prompt).length).toBeLessThanOrEqual(80);
  });

  it("agent_id は共通項目として付く（担当の中で起きたとき）。制御文字は空白にする", () => {
    const rec = buildRecord({ session_id: SID, agent_id: "child", hook_event_name: "TaskCreated", task_id: "9", task_subject: "a\u0000b\u001bc" }, NOW);
    expect(rec).toMatchObject({ agent_id: "child", task_subject: "a b c" });
  });

  it("session_id が UUID の形でないもの・対象外のイベント・対象外のツールは null", () => {
    expect(buildRecord({ session_id: "x", hook_event_name: "TaskCreated", task_id: "1", task_subject: "s" }, NOW)).toBeNull();
    expect(buildRecord({ hook_event_name: "TaskCreated", task_id: "1" }, NOW)).toBeNull();
    expect(buildRecord({ session_id: SID, hook_event_name: "Stop" }, NOW)).toBeNull();
    expect(buildRecord({ session_id: SID, hook_event_name: "Notification" }, NOW)).toBeNull();
    expect(buildRecord({ session_id: SID, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, NOW)).toBeNull();
    expect(buildRecord(null, NOW)).toBeNull();
    expect(buildRecord("text", NOW)).toBeNull();
  });
});

describe("K4 / §3-2: 書き込み", () => {
  it("ファイル名は UTC の日付（events-YYYYMMDD.jsonl）", () => {
    expect(activityFileName(Date.UTC(2026, 9, 12, 23, 59, 59))).toBe("events-20261012.jsonl");
    expect(activityFileName(Date.UTC(2026, 9, 13, 0, 0, 0))).toBe("events-20261013.jsonl");
  });

  it("appendRecord は 1 行を 1 回の writeSync で書く。書けた長さが足りなければ、続きを書かずに終える", () => {
    const dir = tmp();
    const writes: number[] = [];
    const ok = appendRecord(dir, { ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "s" }, {
      writeSync: (_fd: number, buf: Buffer) => {
        writes.push(buf.length);
        return buf.length - 3; // 途中までしか書けなかった
      },
    });
    expect(ok).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it(`1 行が ${MAX_LINE_BYTES} バイトを超えるものは書かない`, () => {
    const dir = tmp();
    const ok = appendRecord(dir, { ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "あ".repeat(5000) });
    expect(ok).toBe(false);
    expect(existsSync(path.join(dir, activityFileName(NOW)))).toBe(false);
  });

  it("ファイルは 600・フォルダは 700 で作る", () => {
    const dir = path.join(tmp(), "activity");
    expect(appendRecord(dir, { ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "s" })).toBe(true);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(path.join(dir, activityFileName(NOW))).mode & 0o777).toString(8)).toBe("600");
  });

  it("20 のプロセスが並列に 200 行ずつ（3KB 超の長い行）書いても、読めない行が 0 件で、行数が合う", async () => {
    const dir = path.join(tmp(), "activity");
    const PROCS = 20;
    const PER = 200;
    await Promise.all(
      Array.from({ length: PROCS }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [APPEND_MANY, HOOK_SOURCE, dir, String(i), String(PER)], { stdio: "ignore" });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} exit ${code}`))));
        }),
      ),
    );
    const files = readdirSync(dir);
    expect(files).toEqual([activityFileName(NOW)]);
    const all = lines(path.join(dir, files[0]));
    expect(all).toHaveLength(PROCS * PER);
    const parsed = all.map((l) => JSON.parse(l) as { task_id: string; task_subject: string });
    expect(new Set(parsed.map((r) => r.task_id)).size).toBe(PROCS * PER);
    expect(Math.max(...all.map((l) => Buffer.byteLength(l)))).toBeGreaterThan(3000);
  });
});

describe("K5: スクリプト本体（本物の node）", () => {
  it("正しい入力: 終了コード 0・標準出力と標準エラーは空・events ファイルに 1 行（空白入りの dataDir）", () => {
    const { dataDir, hook } = installHook();
    const r = runHook(hook, JSON.stringify({ session_id: SID, hook_event_name: "TaskCreated", task_id: "1", task_subject: "調べる" }));
    expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
    const dir = path.join(dataDir, "activity");
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^events-\d{8}\.jsonl$/);
    const [line] = lines(path.join(dir, file));
    expect(JSON.parse(line)).toMatchObject({ event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "調べる" });
    expect(typeof JSON.parse(line).ts).toBe("number");
  });

  it.each([
    ["壊れた JSON", "{not json"],
    ["空の入力", ""],
    ["配列", "[]"],
    ["session_id が UUID でない", JSON.stringify({ session_id: "nope", hook_event_name: "TaskCreated" })],
  ])("%s: 終了コード 0・何も出さない・何も書かない", (_name, stdin) => {
    const { dataDir, hook } = installHook();
    const r = runHook(hook, stdin);
    expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(existsSync(path.join(dataDir, "activity", "events-20261012.jsonl"))).toBe(false);
    expect(existsSync(path.join(dataDir, "activity")) ? readdirSync(path.join(dataDir, "activity")) : []).toEqual([]);
  });

  it("書き込み先が作れない（activity が通常のファイル）ときも、終了コード 0・何も出さない", () => {
    const { dataDir, hook } = installHook();
    writeFileSync(path.join(dataDir, "activity"), "ファイルです");
    const r = runHook(hook, JSON.stringify({ session_id: SID, hook_event_name: "TaskCreated", task_id: "1", task_subject: "s" }));
    expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(readFileSync(path.join(dataDir, "activity"), "utf8")).toBe("ファイルです");
  });

  it("node の標準の部品だけを使う（node: 以外の import が無い）", () => {
    const src = readFileSync(HOOK_SOURCE, "utf8");
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});
