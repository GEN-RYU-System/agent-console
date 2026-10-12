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

  it("K2 SubagentStart（担当の呼び出し・再開）: agent_id と agent_type だけ。ほかの項目（transcript のパスなど）は残さない", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "SubagentStart", agent_id: "ab4603515d5beee56", agent_type: "general-purpose", transcript_path: "/secret/t.jsonl", cwd: "/secret/cwd" }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "SubagentStart", session_id: SID, agent_id: "ab4603515d5beee56", agent_type: "general-purpose" });
    // agent_type が空・無いときは項目ごと無い（SubagentStop と同じ）
    expect(buildRecord({ session_id: SID, hook_event_name: "SubagentStart", agent_id: "adb7" }, NOW)).toEqual({ ts: NOW, event: "SubagentStart", session_id: SID, agent_id: "adb7" });
  });

  it("TaskCreated / TaskCompleted: task_id と task_subject(200字)。task_description は残さない", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "TaskCreated", task_id: "1", task_subject: "題".repeat(250), task_description: "説明は残さない" }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "題".repeat(200) });
    expect(buildRecord({ session_id: SID, hook_event_name: "TaskCompleted", task_id: "1", task_subject: "題" }, NOW)).toMatchObject({ event: "TaskCompleted", task_id: "1" });
  });

  it("K8 UserPromptSubmit: prompt は全文（改行・タブもそのまま）。工程0で分かった <agent-message の印は source=agent", () => {
    const body = `最初の行\n\n\t次の行 ${"あ".repeat(200)}`;
    const human = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: body }, NOW);
    expect(human?.prompt).toBe(body);
    expect(human).not.toHaveProperty("source");
    expect(human).not.toHaveProperty("truncated");
    const agent = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: '<agent-message from="adb7">\n[Subagent hand-back] ...' }, NOW);
    expect(agent).toMatchObject({ source: "agent" });
  });

  it("K8 UserPromptSubmit: 貼り付けの包み（<pasted_content>）は記録では生のまま残す", () => {
    const wrapped = '\n\n<pasted_content id="0995">\n行1\n行2\n行3\n行4\n</pasted_content id="0995">\n';
    expect(buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: wrapped }, NOW)?.prompt).toBe(wrapped);
  });

  it("K8 全文用の整形は、改行とタブ以外の制御文字だけを除く（CR・ESC・NUL を除き、LF とタブは残す）", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "a\r\nb\tc\u001bd\u0000e\u007ff" }, NOW);
    expect(rec?.prompt).toBe("a\nb\tcdef");
  });

  it("K8 Stop: last_assistant_message を全文で残す。stop_hook_active は真偽のときだけ残す。空なら本文の項目ごと無い", () => {
    const text = `返事の1行目\n\n- 箇条書き\n\`\`\`ts\nconst a = 1;\n\`\`\`\n${"あ".repeat(500)}`;
    const rec = buildRecord({ session_id: SID, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text, background_tasks: [], session_crons: [] }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "Stop", session_id: SID, stop_hook_active: false, last_assistant_message: text });
    expect(buildRecord({ session_id: SID, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "x" }, NOW)).toMatchObject({ stop_hook_active: true });
    const empty = buildRecord({ session_id: SID, hook_event_name: "Stop", last_assistant_message: "" }, NOW);
    expect(empty).toEqual({ ts: NOW, event: "Stop", session_id: SID });
  });

  it("K3/K8 StopFailure: エラーの種類（error）だけを残す。API のエラー文（last_assistant_message）は残さない", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "StopFailure", error: "rate_limit", error_details: "429", last_assistant_message: "API Error: Rate limit reached" }, NOW);
    expect(rec).toEqual({ ts: NOW, event: "StopFailure", session_id: SID, error: "rate_limit" });
    expect(buildRecord({ session_id: SID, hook_event_name: "StopFailure" }, NOW)).toEqual({ ts: NOW, event: "StopFailure", session_id: SID });
  });

  it("agent_id は共通項目として付く（担当の中で起きたとき）。制御文字は空白にする", () => {
    const rec = buildRecord({ session_id: SID, agent_id: "child", hook_event_name: "TaskCreated", task_id: "9", task_subject: "a\u0000b\u001bc" }, NOW);
    expect(rec).toMatchObject({ agent_id: "child", task_subject: "a b c" });
  });

  it("session_id が UUID の形でないもの・対象外のイベント・対象外のツールは null", () => {
    expect(buildRecord({ session_id: "x", hook_event_name: "TaskCreated", task_id: "1", task_subject: "s" }, NOW)).toBeNull();
    expect(buildRecord({ hook_event_name: "TaskCreated", task_id: "1" }, NOW)).toBeNull();
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

  it(`K8 1 行の上限は 64KiB（${MAX_LINE_BYTES} バイト）。それを超えるものは書かない`, () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
    const dir = tmp();
    const ok = appendRecord(dir, { ts: NOW, event: "TaskCreated", session_id: SID, task_id: "1", task_subject: "あ".repeat(30000) });
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

  it("K8 20 のプロセスが並列に 200 行ずつ、61KiB を超える行（64KiB で切った行）を書いても、読めない行が 0 件で、行が混ざらない", async () => {
    const dir = path.join(tmp(), "activity");
    const PROCS = 20;
    const PER = 200;
    await Promise.all(
      Array.from({ length: PROCS }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [APPEND_MANY, HOOK_SOURCE, dir, String(i), String(PER), "large"], { stdio: "ignore" });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} exit ${code}`))));
        }),
      ),
    );
    const files = readdirSync(dir);
    expect(files).toEqual([activityFileName(NOW)]);
    // 大きいファイルなので、1 行ずつ読む（全体を 1 つの文字列にしない）
    const buf = readFileSync(path.join(dir, files[0]));
    const seen = new Set<string>();
    let unreadable = 0;
    let maxBytes = 0;
    let minBytes = Number.POSITIVE_INFINITY;
    let start = 0;
    while (start < buf.length) {
      const end = buf.indexOf(0x0a, start);
      expect(end).toBeGreaterThan(start); // 最後の行にも改行がある
      const line = buf.subarray(start, end);
      start = end + 1;
      try {
        const rec = JSON.parse(line.toString("utf8")) as { event: string; truncated?: boolean; last_assistant_message: string };
        expect(rec.event).toBe("Stop");
        expect(rec.truncated).toBe(true);
        seen.add(rec.last_assistant_message.split("\n")[0]);
      } catch {
        unreadable += 1;
      }
      maxBytes = Math.max(maxBytes, line.length + 1);
      minBytes = Math.min(minBytes, line.length + 1);
    }
    expect(unreadable).toBe(0);
    expect(seen.size).toBe(PROCS * PER);
    expect(minBytes).toBeGreaterThan(60 * 1024);
    expect(maxBytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    // 全体の試験が混み合っているときは、数十秒かかることがある（256MB を 20 プロセスが書く）
  }, 180000);
});

const lineBytes = (rec: unknown): number => Buffer.byteLength(`${JSON.stringify(rec)}\n`);

describe("K8 / M-b: 1 行は JSON 全体で 64KiB まで。超えるときは文字の区切りを割らずに切り、truncated: true を付ける", () => {
  it("上限ちょうどまでの本文は切らない（truncated も付かない）", () => {
    const frame = lineBytes({ ts: NOW, event: "UserPromptSubmit", session_id: SID, prompt: "" });
    const rec = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "a".repeat(MAX_LINE_BYTES - frame) }, NOW);
    expect(lineBytes(rec)).toBe(MAX_LINE_BYTES);
    expect(rec).not.toHaveProperty("truncated");
  });

  it("1 バイト超えたら切る。切ったあとの行は上限以内で、truncated: true が付き、本文は先頭の一部", () => {
    const text = "a".repeat(MAX_LINE_BYTES * 2);
    const rec = buildRecord({ session_id: SID, hook_event_name: "Stop", last_assistant_message: text }, NOW);
    expect(rec?.truncated).toBe(true);
    expect(lineBytes(rec)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(lineBytes(rec)).toBeGreaterThan(MAX_LINE_BYTES - 16);
    expect(text.startsWith(String(rec?.last_assistant_message))).toBe(true);
  });

  it("日本語（1 文字 3 バイト）・絵文字（4 バイト、サロゲートペア）・改行や引用符（JSON で 2 バイトに増える）でも、上限以内で、文字の途中では切らない", () => {
    const unit = "あ😀\n\"\\x";
    const text = unit.repeat(30000);
    const rec = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: text }, NOW);
    expect(rec?.truncated).toBe(true);
    const line = `${JSON.stringify(rec)}\n`;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(line) as { prompt: string };
    // 先頭の一部であり、孤立したサロゲートが無い（絵文字が割れていない）
    expect(text.startsWith(parsed.prompt)).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(parsed.prompt)).toBe(false);
    // 切った位置は、もう 1 文字入る余地が無い位置（欠け過ぎていない）
    expect(MAX_LINE_BYTES - Buffer.byteLength(line)).toBeLessThan(8);
  });

  it("agent の入力（source）も、上限以内に収まる", () => {
    const rec = buildRecord({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: `<agent-message from="x">${"あ".repeat(40000)}` }, NOW);
    expect(rec).toMatchObject({ source: "agent", truncated: true });
    expect(lineBytes(rec)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  it("切った 1 行は、そのまま appendRecord で書け、読み直せる（1 回の writeSync）", () => {
    const dir = tmp();
    const rec = buildRecord({ session_id: SID, hook_event_name: "Stop", last_assistant_message: "あ".repeat(80000) }, NOW);
    expect(rec).not.toBeNull();
    const writes: number[] = [];
    const ok = appendRecord(dir, rec as NonNullable<typeof rec>, { writeSync: (_fd: number, buf: Buffer) => (writes.push(buf.length), buf.length) });
    expect(ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeLessThanOrEqual(MAX_LINE_BYTES);
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
