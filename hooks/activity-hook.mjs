// agent-console: セッションの様子の記録（Claude Code の hook）。設計 docs/handoff/v0.8.0-activity/design.md §3-2。
// 標準入力の JSON から決めた項目だけを、dataDir/activity/events-YYYYMMDD.jsonl に 1 行で追記する。
// どんな失敗でも終了コード 0 で終わり、何も出力しない（Claude を止めない）。node の標準の部品だけを使う。
// この本体は、サーバーが起動のたびに dataDir/hooks/activity-hook.mjs へ写す。dataDir は、この写しの 2 つ上のフォルダ。
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 1 行の上限（byte）。1 回の write に収めるための、実用上の上限 */
export const MAX_LINE_BYTES = 4096;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const DESCRIPTION_CHARS = 200;
const SUBJECT_CHARS = 200;
const REPORT_CHARS = 120;
const PROMPT_CHARS = 80;
const ID_CHARS = 100;
const NAME_CHARS = 100;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_MESSAGE_PREFIX = /^\s*<agent-message\b/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 文字列の先頭 max 字（コードポイント単位）。制御文字と連続する空白は空白 1 つにまとめる。文字列でなければ空 */
function clip(value, max) {
  if (typeof value !== "string") return "";
  const flat = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, max).join("");
}

/** 項目が空でなければ足した新しいオブジェクトを返す */
function withText(base, key, value, max) {
  const text = clip(value, max);
  return text === "" ? base : { ...base, [key]: text };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function toolRecord(common, input) {
  const tool = input.tool_name;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (input.hook_event_name === "PreToolUse" && tool === "Agent") {
    let rec = { ...common, tool: "Agent" };
    rec = withText(rec, "tool_use_id", input.tool_use_id, ID_CHARS);
    rec = withText(rec, "description", toolInput.description, DESCRIPTION_CHARS);
    rec = withText(rec, "subagent_type", toolInput.subagent_type, NAME_CHARS);
    return withText(rec, "model", toolInput.model, NAME_CHARS);
  }
  if (input.hook_event_name === "PreToolUse" && tool === "SubagentHandback") {
    return withText({ ...common, tool: "SubagentHandback" }, "message", toolInput.message, REPORT_CHARS);
  }
  if (input.hook_event_name === "PostToolUse" && tool === "Agent") {
    const response = isObject(input.tool_response) ? input.tool_response : {};
    let rec = { ...common, tool: "Agent" };
    rec = withText(rec, "tool_use_id", input.tool_use_id, ID_CHARS);
    rec = withText(rec, "status", response.status, NAME_CHARS);
    rec = withText(rec, "agentId", response.agentId, ID_CHARS);
    rec = withText(rec, "resolvedModel", response.resolvedModel, NAME_CHARS);
    return typeof response.totalDurationMs === "number" && Number.isFinite(response.totalDurationMs) ? { ...rec, totalDurationMs: response.totalDurationMs } : rec;
  }
  return null;
}

/**
 * hook の入力から、書く 1 件を作る。対象外のイベント・ツール、session_id が UUID の形でないものは null。
 * 書くのは設計 §3-2 の項目と長さだけ（会話の本文・transcript のパスなどは残さない）。
 */
export function buildRecord(input, now = Date.now()) {
  if (!isObject(input)) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const event = input.hook_event_name;
  let common = { ts: now, event, session_id: sessionId };
  common = withText(common, "agent_id", input.agent_id, ID_CHARS);
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
      return toolRecord(common, input);
    case "SubagentStop": {
      let rec = withText(common, "agent_type", input.agent_type, NAME_CHARS);
      rec = withText(rec, "last_assistant_message", input.last_assistant_message, REPORT_CHARS);
      return rec;
    }
    case "TaskCreated":
    case "TaskCompleted": {
      let rec = withText(common, "task_id", input.task_id, ID_CHARS);
      rec = withText(rec, "task_subject", input.task_subject, SUBJECT_CHARS);
      return rec;
    }
    case "UserPromptSubmit": {
      // 担当の報告の戻りは、人の入力ではない。工程0（docs/handoff/v0.8.0-activity/step0.md）で見分けられた印だけを付ける
      const raw = typeof input.prompt === "string" ? input.prompt : "";
      const rec = withText(common, "prompt", raw, PROMPT_CHARS);
      return AGENT_MESSAGE_PREFIX.test(raw) ? { ...rec, source: "agent" } : rec;
    }
    default:
      return null;
  }
}

/** ファイル名は UTC の日付 */
export function activityFileName(ts) {
  return `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
}

/**
 * 1 行を 1 つの Buffer にして、1 回の writeSync で追記する（O_APPEND の 1 回の write なので、並列でも行が混ざらない）。
 * 書けた長さが足りなければ、続きは書かずに終える。書けたら true。ここでは例外を外へ出さない。
 */
export function appendRecord(activityDir, record, io = {}) {
  const write = io.writeSync ?? writeSync;
  let fd = null;
  try {
    const buf = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (buf.length > MAX_LINE_BYTES) return false;
    mkdirSync(activityDir, { recursive: true, mode: DIR_MODE });
    try {
      chmodSync(activityDir, DIR_MODE);
    } catch {
      // 他人のフォルダなどで直せなくても、書き込み自体は試す
    }
    fd = openSync(path.join(activityDir, activityFileName(record.ts)), "a", FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
    } catch {
      // 権限を直せなくても続ける
    }
    return write(fd, buf) === buf.length;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 閉じ損ねても何もしない
      }
    }
  }
}

/** 標準入力の文字列から記録を 1 行書く。dataDir/activity に書く */
export function run(stdinText, dataDir, now = Date.now()) {
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return false;
  }
  const record = buildRecord(input, now);
  return record === null ? false : appendRecord(path.join(dataDir, "activity"), record);
}

function isMain() {
  try {
    // 一時フォルダなどがシンボリックリンク越し（macOS の /var → /private/var）でも同じ実体と判定する
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    let text = "";
    try {
      text = readFileSync(0, "utf8");
    } catch {
      text = "";
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    run(text, path.resolve(here, ".."));
  } catch {
    // どんな失敗でも Claude を止めない
  }
  process.exitCode = 0;
}
