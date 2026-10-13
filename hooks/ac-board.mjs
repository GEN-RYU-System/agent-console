// agent-console: 作戦ボード（テーマ・KGI・KPI・ロードマップ・タスク）の命令と、その検査・読み出し。設計 docs/handoff/board/design.md §3-2。
// 使い方: node "<dataDir>/bin/ac-board.mjs" write < board.json（標準入力の JSON で、そのセッションのボードを丸ごと書き換える）。
// 自分の会話の番号は、環境変数 CLAUDE_CODE_SESSION_ID から取る（引数では受け取らない）。書くのは dataDir/boards/<番号>.json の 1 か所だけ。
// 検査（validateBoard）・書き込み（writeBoard）・読み出し（readBoard）はこの 1 ファイルが持つ。サーバーはこのファイルを import し、
// 命令は dataDir/bin に写した同じファイルが動く。node の標準の部品だけを使う（サーバー秘密は使わない）。
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BOARD_VERSION = 1;
export const BOARDS_DIR_NAME = "boards";
/** 長さの上限（文字数はコードポイントで数える）と件数の上限 */
export const BOARD_LIMITS = Object.freeze({ themeChars: 200, kgiItems: 10, kgiChars: 500, kpiItems: 20, kpiChars: 200, roadmapItems: 50, roadmapChars: 200, taskItems: 100, taskChars: 200 });
/** 標準入力の上限（byte）。上限の合計（約 40KB 強）より十分大きく、暴走した入力だけを止める */
const MAX_INPUT_BYTES = 256 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const STATUSES = ["todo", "doing", "done"];
const KPI_FIELDS = ["name", "target", "current", "unit"];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 改行（LF）とタブ以外の制御文字
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const charCount = (s) => Array.from(s).length;
const fail = (reason) => ({ ok: false, reason });

/** 文字列 1 つの検査。問題があれば理由、なければ null */
function stringProblem(value, label, maxChars, allowEmpty = false) {
  if (typeof value !== "string") return `${label} は文字列にしてください`;
  if (CONTROL_CHARS.test(value)) return `${label} に制御文字（改行とタブ以外）が含まれています`;
  const length = charCount(value);
  if (length > maxChars) return `${label} は ${maxChars} 字までです（${length} 字）`;
  if (!allowEmpty && value.trim() === "") return `${label} が空です`;
  return null;
}

/** オブジェクトのキーが、決めたキーだけで過不足ないかの検査 */
function keyProblem(obj, label, keys, extraHint = "", optionalKeys = []) {
  for (const key of Object.keys(obj)) if (!keys.includes(key) && !optionalKeys.includes(key)) return `${label}${label === "" ? "" : "."}${key} は指定できません${extraHint}`;
  for (const key of keys) if (!(key in obj)) return `${label}${label === "" ? "" : "."}${key} がありません`;
  return null;
}

/** 配列 1 つの検査。各要素は item(要素, ラベル) が理由か null を返す */
function listProblem(value, label, maxItems, item) {
  if (!Array.isArray(value)) return `${label} は配列にしてください`;
  if (value.length > maxItems) return `${label} は ${maxItems} 件までです（${value.length} 件）`;
  for (let i = 0; i < value.length; i += 1) {
    const problem = item(value[i], `${label}[${i}]`);
    if (problem !== null) return problem;
  }
  return null;
}

function objectItemProblem(value, label, keys, fieldProblem) {
  if (!isObject(value)) return `${label} はオブジェクトにしてください`;
  const keyIssue = keyProblem(value, label, keys);
  if (keyIssue !== null) return keyIssue;
  for (const key of keys) {
    const problem = fieldProblem(key, value[key], `${label}.${key}`);
    if (problem !== null) return problem;
  }
  return null;
}

const TOP_KEYS = ["theme", "kgi", "kpis", "roadmap"];
/** 省ける鍵（省いたら 0 件。古い形のファイルも読めるように） */
const OPTIONAL_TOP_KEYS = ["tasks"];
const TOP_HINT = "（形は theme・kgi・kpis・roadmap・tasks だけです。version と updatedAt は命令が付けます）";

/**
 * ボードの入力の検査。形が合えば { ok: true, board }（新しいオブジェクト）、合わなければ { ok: false, reason }。
 * 形: { theme, kgi:[{text}], kpis:[{name,target,current,unit}], roadmap:[{title,status}], tasks?:[{title,status}] }（tasks は省ける。省いたら []）。status は todo・doing・done。
 * 文字列はコードポイントで数えた上限（BOARD_LIMITS）以内で、改行とタブ以外の制御文字を含まない。
 */
export function validateBoard(input) {
  if (!isObject(input)) return fail("入力は JSON のオブジェクトにしてください");
  const keyIssue = keyProblem(input, "", TOP_KEYS, TOP_HINT, OPTIONAL_TOP_KEYS);
  if (keyIssue !== null) return fail(keyIssue);
  const rawTasks = input.tasks ?? [];
  const statusItem = (limitChars) => (v, label) =>
    objectItemProblem(v, label, ["title", "status"], (key, field, fieldLabel) => {
      if (key === "title") return stringProblem(field, fieldLabel, limitChars);
      return STATUSES.includes(field) ? null : `${fieldLabel} は ${STATUSES.join("・")} のどれかにしてください`;
    });
  const problems = [
    stringProblem(input.theme, "theme", BOARD_LIMITS.themeChars),
    listProblem(input.kgi, "kgi", BOARD_LIMITS.kgiItems, (v, label) => objectItemProblem(v, label, ["text"], (_k, field, fieldLabel) => stringProblem(field, fieldLabel, BOARD_LIMITS.kgiChars))),
    listProblem(input.kpis, "kpis", BOARD_LIMITS.kpiItems, (v, label) =>
      objectItemProblem(v, label, KPI_FIELDS, (key, field, fieldLabel) => stringProblem(field, fieldLabel, BOARD_LIMITS.kpiChars, key !== "name")),
    ),
    listProblem(input.roadmap, "roadmap", BOARD_LIMITS.roadmapItems, statusItem(BOARD_LIMITS.roadmapChars)),
    listProblem(rawTasks, "tasks", BOARD_LIMITS.taskItems, statusItem(BOARD_LIMITS.taskChars)),
  ];
  const problem = problems.find((p) => p !== null);
  if (problem !== undefined) return fail(problem);
  return {
    ok: true,
    board: {
      theme: input.theme,
      kgi: input.kgi.map((k) => ({ text: k.text })),
      kpis: input.kpis.map((k) => ({ name: k.name, target: k.target, current: k.current, unit: k.unit })),
      roadmap: input.roadmap.map((r) => ({ title: r.title, status: r.status })),
      tasks: rawTasks.map((t) => ({ title: t.title, status: t.status })),
    },
  };
}

/** boardsDir の中のボードのパス。会話の番号が UUID の形でなければ null（パスを組み立てない。パスの走査を防ぐ） */
export function boardPathFor(boardsDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  return path.join(boardsDir, `${sessionId}.json`);
}

/**
 * dataDir/boards/<番号>.json に、ボードを丸ごと書く（一部だけの書き換えはしない）。検査に通らなければ書かない。
 * ディレクトリ 700・ファイル 600。一時ファイル→rename なので、読む側が半分だけ書かれたファイルを見ることはない。
 */
export function writeBoard(dataDir, sessionId, input, now = Date.now()) {
  const boardsDir = path.join(dataDir, BOARDS_DIR_NAME);
  const file = boardPathFor(boardsDir, sessionId);
  if (file === null) return fail("会話の番号が UUID の形ではありません");
  const checked = validateBoard(input);
  if (!checked.ok) return checked;
  const body = `${JSON.stringify({ version: BOARD_VERSION, ...checked.board, updatedAt: now }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  let fd = null;
  try {
    mkdirSync(boardsDir, { recursive: true, mode: DIR_MODE });
    try {
      chmodSync(boardsDir, DIR_MODE);
    } catch {
      // 他人のフォルダなどで直せなくても、書き込み自体は試す
    }
    fd = openSync(tmp, "wx", FILE_MODE);
    fchmodSync(fd, FILE_MODE);
    writeSync(fd, body);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 閉じ損ねても何もしない
      }
    }
    rmSync(tmp, { force: true });
    return fail(`書き込めませんでした: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * そのセッションのボードを読む。ファイルは書き換えない。
 * 無ければ { status: "none" }、読めない・形が違う・version が違うときは { status: "invalid" }、読めれば { status: "ok", board }。
 */
export function readBoard(dataDir, sessionId) {
  const file = boardPathFor(path.join(dataDir, BOARDS_DIR_NAME), sessionId);
  if (file === null) return { status: "none" };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return err !== null && typeof err === "object" && err.code === "ENOENT" ? { status: "none" } : { status: "invalid" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  if (!isObject(parsed) || parsed.version !== BOARD_VERSION || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return { status: "invalid" };
  const { version: _version, updatedAt, ...rest } = parsed;
  const checked = validateBoard(rest);
  return checked.ok ? { status: "ok", board: { version: BOARD_VERSION, ...checked.board, updatedAt } } : { status: "invalid" };
}

const USAGE = '使い方: node "<dataDir>/bin/ac-board.mjs" write < board.json（標準入力の JSON で、このセッションのボードを丸ごと書き換えます。形と上限は README の「作戦ボード」）';

/**
 * 命令の本体（副命令は write だけ）。終了コードと、標準出力・標準エラーに出す文を返す。ここでは何も出力しない。
 * 会話の番号は env.CLAUDE_CODE_SESSION_ID だけから取る。
 */
export function runCommand({ argv, env, stdinText, dataDir, now = Date.now() }) {
  const reject = (message) => ({ code: 1, stdout: "", stderr: `${message}\n` });
  if (argv.length !== 1 || argv[0] !== "write") return reject(USAGE);
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return reject("環境変数 CLAUDE_CODE_SESSION_ID が無いか、会話の番号の形ではありません。Claude の Bash から実行してください");
  if (Buffer.byteLength(stdinText, "utf8") > MAX_INPUT_BYTES) return reject(`入力が大きすぎます（${MAX_INPUT_BYTES} byte まで）`);
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch (err) {
    return reject(`標準入力を JSON として読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = writeBoard(dataDir, sessionId, input, now);
  return result.ok ? { code: 0, stdout: "ボードを書き込みました。画面には 5 秒以内に出ます\n", stderr: "" } : reject(`書き込みませんでした: ${result.reason}`);
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
  const here = path.dirname(fileURLToPath(import.meta.url));
  let result;
  if (path.basename(here) !== "bin") {
    result = { code: 1, stdout: "", stderr: "dataDir/bin に写された ac-board.mjs から実行してください（README の「作戦ボード」）\n" };
  } else {
    let stdinText = "";
    try {
      stdinText = readFileSync(0, "utf8");
    } catch {
      stdinText = "";
    }
    result = runCommand({ argv: process.argv.slice(2), env: process.env, stdinText, dataDir: path.resolve(here, "..") });
  }
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
