// agent-console: セッションの様子の記録（Claude Code の hook）。設計 docs/handoff/v0.8.0-activity/design.md §3-2、チャット docs/handoff/chat/design.md §3-1、作戦ボード docs/handoff/board/design.md §2。
// 標準入力の JSON から決めた項目だけを、dataDir/activity/events-YYYYMMDD.jsonl に 1 行で追記する。
// どんな失敗でも終了コード 0 で終わり、何も出力しない（Claude を止めない）。node の標準の部品だけを使う。
// この本体は、サーバーが起動のたびに dataDir/hooks/activity-hook.mjs へ写す。dataDir は、この写しの 2 つ上のフォルダ。
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 1 行の上限（byte、改行を含む JSON 全体）。1 回の write に収めるための上限。macOS と Linux は、実用上、1 回の write を分割しない（並列の試験で固定する） */
export const MAX_LINE_BYTES = 64 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const DESCRIPTION_CHARS = 200;
const SUBJECT_CHARS = 200;
const REPORT_CHARS = 120;
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

// 全文用: 改行（LF）とタブ以外の制御文字だけを除く（CR・ESC・NUL・DEL など）
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** 全文用の整形。文字列でなければ空。改行とタブは残す（右の欄の短い項目は clip() を使う） */
function fullText(value) {
  return typeof value === "string" ? value.replace(TEXT_CONTROL_CHARS, "") : "";
}

/**
 * 1 つのコードポイントが、JSON 文字列の中で占める byte 数（UTF-8）。JSON.stringify の結果と同じ数になる:
 * 引用符・バックスラッシュ・改行・タブは 2、そのほかの制御文字は \u00XX で 6、孤立したサロゲートは \udXXX で 6、
 * それ以外は UTF-8 の長さ（1〜4）。1 文字ごとに文字列を作らないので、長い本文でも速い。
 */
function jsonBytesOf(codePoint) {
  if (codePoint === 0x22 || codePoint === 0x5c || codePoint === 0x0a || codePoint === 0x09) return 2;
  if (codePoint < 0x20) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return codePoint < 0x10000 ? 3 : 4;
}

/** 1 行（JSON ＋ 改行）の byte 数 */
const lineBytes = (record) => Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");

/**
 * base に本文 key を足した記録を返す。1 行が MAX_LINE_BYTES に収まればそのまま。
 * 収まらないときは、先に「本文に使える byte 数」を決め（上限 − 本文以外の長さ）、コードポイントの区切りで後ろから切って
 * truncated: true を付ける。本文の長さは JSON にしたあとの長さ（改行や引用符は 2 byte に増える）で数えるので、繰り返し測り直さない。
 */
function withFullText(base, key, text) {
  const whole = { ...base, [key]: text };
  if (lineBytes(whole) <= MAX_LINE_BYTES) return whole;
  const frame = { ...base, [key]: "", truncated: true };
  let budget = MAX_LINE_BYTES - lineBytes(frame);
  let keptUnits = 0;
  for (const ch of text) {
    const cost = jsonBytesOf(ch.codePointAt(0));
    if (cost > budget) break;
    budget -= cost;
    keptUnits += ch.length;
  }
  return { ...frame, [key]: text.slice(0, keptUnits) };
}

/** 項目が空でなければ足した新しいオブジェクトを返す */
function withText(base, key, value, max) {
  const text = clip(value, max);
  return text === "" ? base : { ...base, [key]: text };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** ファイルを書く 4 つのツール（file-viewer 設計 §3-1） */
export const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const PATH_MAX_CHARS = 4096;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL = /[\u0000-\u001f\u007f]/;

/** 記録してよい path か。絶対パスで、4096 文字以下、制御文字なし、normalize しても変わらず、末尾が / でない（server/activity.ts にも同じ判定がある） */
export function isRecordablePath(p) {
  return typeof p === "string" && p.startsWith("/") && p.length <= PATH_MAX_CHARS && !PATH_CONTROL.test(p) && path.posix.normalize(p) === p && !p.endsWith("/");
}

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
  if (input.hook_event_name === "PostToolUse" && FILE_TOOLS.includes(tool)) {
    // path は clip を通さず生のまま（完全一致で照合するため）。content・old_string などは読まない
    const raw = typeof toolInput.file_path === "string" ? toolInput.file_path : toolInput.notebook_path;
    return isRecordablePath(raw) ? { ...common, tool, path: raw } : null;
  }
  return null;
}

/**
 * hook の入力から、書く 1 件を作る。対象外のイベント・ツール、session_id が UUID の形でないものは null。
 * 書くのは決めた項目だけ（transcript のパスなどは残さない）。入力（prompt）と返事（last_assistant_message）は全文（1 行 64KiB まで）。
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
    case "PermissionDenied": {
      // auto mode が Agent の呼び出しを拒否した（v0.36.0）。tool_use_id だけ残す（reason・tool_input は書かない）
      if (input.tool_name !== "Agent") return null;
      const rec = withText({ ...common, tool: "Agent" }, "tool_use_id", input.tool_use_id, ID_CHARS);
      return rec.tool_use_id === undefined ? null : rec;
    }
    case "SubagentStart":
      // 担当を呼んだとき、そして再開したとき（SendMessage など）にも来る（工程0 (a)）。agent_id と agent_type だけ残す
      return withText(common, "agent_type", input.agent_type, NAME_CHARS);
    case "TaskCreated":
    case "TaskCompleted": {
      let rec = withText(common, "task_id", input.task_id, ID_CHARS);
      rec = withText(rec, "task_subject", input.task_subject, SUBJECT_CHARS);
      return rec;
    }
    case "UserPromptSubmit": {
      // 担当の報告の戻りは、人の入力ではない。工程0（docs/handoff/v0.8.0-activity/step0.md）で見分けられた印だけを付ける
      // 本文は全文（貼り付けの包み <pasted_content …> も生のまま。外すのは表示のとき）
      const raw = typeof input.prompt === "string" ? input.prompt : "";
      const base = AGENT_MESSAGE_PREFIX.test(raw) ? { ...common, source: "agent" } : common;
      const text = fullText(raw);
      return text === "" ? base : withFullText(base, "prompt", text);
    }
    case "Stop": {
      // 1 回の返事の最後の本文（途中の文章は含まれない。工程0 (a)）。1 回の入力に Stop が何回か来ることがある
      const base = typeof input.stop_hook_active === "boolean" ? { ...common, stop_hook_active: input.stop_hook_active } : common;
      const text = fullText(input.last_assistant_message);
      return text === "" ? base : withFullText(base, "last_assistant_message", text);
    }
    case "StopFailure":
      // API エラーで回が終わった。last_assistant_message はエラー文で、返事ではないので残さない。種類だけ残す
      return withText(common, "error", input.error, NAME_CHARS);
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
