// agent-console: 件のセッションへ「手順ファイルを読んで順に行ってください」という決まった一文を 1 回送る、AI 用の命令。
// 設計 salesanchor docs/handoff/conversation-consent/design.md §14-10-3 (b)。
// 使い方: node "<dataDir>/bin/ac-case-say.mjs" <件の id> <手順ファイル名>   （これ 1 つだけ）
// 送る文・宛先・送ってよいかの判定はすべてサーバー（/api/agent/case-say）が行う。この命令は件の id と手順ファイル名を頼むだけ。
// 宛先のポートと合言葉は dataDir/reserve-token（{"port","token"}、サーバーが書く）だけから取り、値は出さない。呼び出し元の番号は環境変数 CLAUDE_CODE_SESSION_ID だけから取る。
// node の標準の部品だけを使う（ac-reserve.mjs と同じ作り）。
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESERVE_TOKEN_FILE_NAME = "reserve-token";
const REQUEST_TIMEOUT_MS = 30000;
const TOKEN = /^[0-9a-f]{64}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STEP_FILE = /^[A-Za-z0-9._-]{1,64}\.md$/;
const USAGE = '使い方: node "<dataDir>/bin/ac-case-say.mjs" <件の id> <手順ファイル名>（README の「件へ一文を送る」）';

const reject = (message) => ({ code: 1, stdout: "", stderr: `${message}\n` });

/** dataDir/reserve-token を読む。無い・壊れていれば理由つきで失敗（合言葉の値は理由に入れない） */
function readAccess(dataDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(dataDir, RESERVE_TOKEN_FILE_NAME), "utf8"));
  } catch (err) {
    return { ok: false, reason: err && err.code === "ENOENT" ? "dataDir/reserve-token がありません（agent-console を本番のポートで起動してください）" : "dataDir/reserve-token を読めません" };
  }
  const valid = typeof parsed === "object" && parsed !== null && Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535 && typeof parsed.token === "string" && TOKEN.test(parsed.token);
  return valid ? { ok: true, port: parsed.port, token: parsed.token } : { ok: false, reason: "dataDir/reserve-token の形が正しくありません" };
}

/**
 * 命令の本体。終了コードと、標準出力・標準エラーに出す 1 行を返す。ここでは何も出力しない。
 * dataDir は命令の置き場所の 1 つ上（ac-reserve と同じ判定）。
 */
export async function runCommand({ argv, dataDir, callerSessionId }) {
  if (argv.length !== 2 || !CASE_ID.test(argv[0]) || !STEP_FILE.test(argv[1]) || argv[1].includes("..")) return reject(USAGE);
  const access = readAccess(dataDir);
  if (!access.ok) return reject(access.reason);
  const body = { caseId: argv[0], stepFile: argv[1], ...(typeof callerSessionId === "string" && callerSessionId !== "" ? { callerSessionId } : {}) };
  let response;
  let text;
  try {
    response = await fetch(`http://127.0.0.1:${access.port}/api/agent/case-say`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    return reject("agent-console に接続できませんでした（起動しているか確認してください）");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (response.status >= 200 && response.status < 300) return { code: 0, stdout: `送りました: ${argv[0]} ${argv[1]}\n`, stderr: "" };
  const reason = json && typeof json.reason === "string" ? json.reason : json && typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
  return reject(`断られました（${response.status}）: ${reason}`);
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
  let result;
  if (path.basename(here) !== "bin") {
    result = reject("dataDir/bin に写された ac-case-say.mjs から実行してください（README の「件へ一文を送る」）");
  } else {
    result = await runCommand({ argv: process.argv.slice(2), dataDir: path.resolve(here, ".."), callerSessionId: process.env.CLAUDE_CODE_SESSION_ID });
  }
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
