// agent-console: 作戦ボードが無いまま作業を進めているセッションを、応答終了（Stop）で 1 回だけ止め、書き方を渡す hook（同期）。設計 docs/handoff/board-guard/design.md §3-1。
// dataDir/hooks/board-guard.mjs に写されて動く。dataDir は自分の置き場所の 1 つ上。
// どこで失敗しても、終了コード 0・標準出力なしで終わる（止めない側に倒す）。失敗は dataDir/board-guard/errors.log に日時つき 1 行。
// ボードの読み出し（readBoard）と上限（BOARD_LIMITS）は dataDir/bin/ac-board.mjs を動的に import して使う（判定の正本を 1 か所に保つ）。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 数える tool_use の件数。ここに達したら transcript を読み止める */
export const TOOL_USE_THRESHOLD = 3;
export const GUARD_DIR_NAME = "board-guard";
export const ERROR_LOG_NAME = "errors.log";
const OPEN_SESSIONS_FILE = "open-sessions.json";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK_BYTES = 1024 * 1024;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 失敗を dataDir/board-guard/errors.log に日時つき 1 行で残す。書けなければ黙る */
export function logError(dataDir, err) {
  try {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
    const dir = path.join(dataDir, GUARD_DIR_NAME);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(dir, ERROR_LOG_NAME), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // errors.log も書けなければ黙って終わる
  }
}

/** open-sessions.json の items[].claudeSessionId に sessionId があるか。読めない・形が違うときは例外 */
export function isOpenSession(dataDir, sessionId) {
  const parsed = JSON.parse(readFileSync(path.join(dataDir, OPEN_SESSIONS_FILE), "utf8"));
  if (!isObject(parsed) || !Array.isArray(parsed.items)) throw new Error("open-sessions.json の形が想定と違います");
  return parsed.items.some((item) => isObject(item) && item.claudeSessionId === sessionId);
}

/** transcript の 1 行から assistant の tool_use の件数を数える。読めない行は 0 */
function toolUsesInLine(line) {
  if (line === "" || !line.includes("tool_use")) return 0;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return 0;
  }
  if (!isObject(entry) || entry.type !== "assistant" || !isObject(entry.message) || !Array.isArray(entry.message.content)) return 0;
  return entry.message.content.filter((c) => isObject(c) && c.type === "tool_use").length;
}

/** transcript（JSON Lines）を先頭から読み、tool_use が limit 件に達したら読み止める。達したら true。最後まで読んで足りなければ false。ファイルが読めなければ例外 */
export function reachesToolUses(transcriptPath, limit = TOOL_USE_THRESHOLD) {
  const fd = openSync(transcriptPath, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let rest = "";
    let count = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      // マルチバイト文字が塊の境目で割れても壊れないよう StringDecoder で読み、行の単位で切る
      const text = rest + decoder.write(buf.subarray(0, n));
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        count += toolUsesInLine(line);
        if (count >= limit) return true;
      }
    }
    count += toolUsesInLine(rest);
    return count >= limit;
  } finally {
    closeSync(fd);
  }
}

/** 止めるときの文面（日本語・固定の骨組み）。上限は BOARD_LIMITS から組む（数値を書き写さない） */
export function buildReason({ dataDir, limits, invalid }) {
  const command = `node "${path.join(dataDir, "bin", "ac-board.mjs")}" write`;
  const shape = '{"theme":"…","kgi":[{"text":"…"}],"kpis":[{"name":"…","target":"…","current":"…","unit":"…"}],"roadmap":[{"title":"…","status":"todo|doing|done"}],"tasks":[{"title":"…","status":"todo|doing|done"}]}';
  return [
    invalid ? "作戦ボードの形が壊れています（このセッションのボードを読めませんでした）。" : "このセッションの作戦ボードがまだありません。",
    "次のコマンドに JSON を標準入力で渡して、ボードを書いてください（画面の右側に出ます）。書き直すときも、ボード全体を丸ごと渡します。",
    command,
    `JSON の形: ${shape}`,
    `上限（文字数はコードポイント）: theme ${limits.themeChars} 字／kgi ${limits.kgiItems} 件・各 ${limits.kgiChars} 字／kpis ${limits.kpiItems} 件・各項目 ${limits.kpiChars} 字／roadmap ${limits.roadmapItems} 件・各 ${limits.roadmapChars} 字／tasks ${limits.taskItems} 件・各 ${limits.taskChars} 字。tasks は省けます。status は todo・doing・done のどれかです。`,
    "単発の質問だけのセッションなら、theme だけを書き、kgi・kpis・roadmap は空の配列 [] にしてください。",
    "この案内は 1 回だけです。書いたあとは、そのまま元の作業を続けてください。",
  ].join("\n");
}

/**
 * 判定の本体。入力（Stop の JSON を読んだ値）と dataDir から、止めるときだけ { decision: "block", reason } を返し、止めないなら null。
 * 止めるときは、先に印（dataDir/board-guard/<番号>）を作る（2 回目は必ず止めない）。失敗は例外（呼び出し側が errors.log に書いて止めない側に倒す）。
 */
export async function decide(input, dataDir) {
  if (!isObject(input)) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (input.stop_hook_active === true) return null;
  if (!isOpenSession(dataDir, sessionId)) return null;
  const guardDir = path.join(dataDir, GUARD_DIR_NAME);
  const mark = path.join(guardDir, sessionId);
  if (existsSync(mark)) return null;
  const ac = await import(pathToFileURL(path.join(dataDir, "bin", "ac-board.mjs")).href);
  const board = ac.readBoard(dataDir, sessionId);
  if (board.status === "ok") return null;
  if (typeof input.transcript_path !== "string" || input.transcript_path === "") throw new Error("transcript_path がありません");
  if (!reachesToolUses(input.transcript_path)) return null;
  mkdirSync(guardDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(mark, "", { flag: "wx", mode: 0o600 });
  } catch (err) {
    // 同時に走った別の実行が先に作ったときは、止めない
    if (err !== null && typeof err === "object" && err.code === "EEXIST") return null;
    throw err;
  }
  return { decision: "block", reason: buildReason({ dataDir, limits: ac.BOARD_LIMITS, invalid: board.status === "invalid" }) };
}

function isMain() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 置き場所が hooks/ でなければ何もしない（dataDir を決められない）
  if (path.basename(here) === "hooks") {
    const dataDir = path.resolve(here, "..");
    try {
      const input = JSON.parse(readFileSync(0, "utf8"));
      const result = await decide(input, dataDir);
      if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
      logError(dataDir, err);
    }
  }
  process.exitCode = 0;
}
