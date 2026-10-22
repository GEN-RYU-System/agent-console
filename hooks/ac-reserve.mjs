// agent-console: 予約（日時を指定して新しいセッションに指示を 1 回送る）の AI 用命令。設計 docs/handoff/reservations/design.md §4-7。
// 使い方: node "<dataDir>/bin/ac-reserve.mjs" add < reservation.json ／ list ／ cancel <id>
// 予約の正本は dataDir/reservations.json で、書き手はサーバーだけ。この命令はファイルへ書かず、サーバーの HTTP（/api/agent/reservations）に頼む。
// 宛先のポートと合言葉は dataDir/reserve-token（{"port","token"}、サーバーが書く）だけから取る。node の標準の部品だけを使う。
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESERVE_TOKEN_FILE_NAME = "reserve-token";
const MAX_INPUT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN = /^[0-9a-f]{64}$/;
const RESERVATION_ID = /^[A-Za-z0-9-]{1,64}$/;
const USAGE = '使い方: node "<dataDir>/bin/ac-reserve.mjs" add < reservation.json ／ list ／ cancel <id>（入力の形と使ってよい目的は README の「予約」）';

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

/** サーバーへ 1 回頼む。応答の本文は JSON として読み、エラー文だけを取り出す */
async function call(access, method, pathname, bodyText) {
  const response = await fetch(`http://127.0.0.1:${access.port}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${access.token}`, ...(bodyText !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(bodyText !== undefined ? { body: bodyText } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/**
 * 命令の本体。終了コードと、標準出力・標準エラーに出す文を返す。ここでは何も出力しない。
 * dataDir は命令の置き場所の 1 つ上（ac-board と同じ判定）。
 */
export async function runCommand({ argv, stdinText = "", dataDir, callerSessionId }) {
  const [sub, ...rest] = argv;
  const wellFormed = (sub === "add" && rest.length === 0) || (sub === "list" && rest.length === 0) || (sub === "cancel" && rest.length === 1 && RESERVATION_ID.test(rest[0]));
  if (!wellFormed) return reject(USAGE);
  let payload;
  if (sub === "add") {
    if (Buffer.byteLength(stdinText, "utf8") > MAX_INPUT_BYTES) return reject(`入力が大きすぎます（${MAX_INPUT_BYTES} byte まで）`);
    try {
      payload = JSON.parse(stdinText);
    } catch (err) {
      return reject(`標準入力を JSON として読めません: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return reject("標準入力は JSON のオブジェクトにしてください");
    delete payload.callerSessionId; // 呼び出し元は環境変数だけから取る（標準入力の自己申告は使わない）
  }
  const access = readAccess(dataDir);
  if (!access.ok) return reject(access.reason);
  const caller = typeof callerSessionId === "string" && callerSessionId !== "" ? { callerSessionId } : {};
  let result;
  try {
    if (sub === "add") result = await call(access, "POST", "/api/agent/reservations", JSON.stringify({ ...payload, ...caller }));
    else if (sub === "list") result = await call(access, "GET", `/api/agent/reservations${caller.callerSessionId !== undefined ? `?callerSessionId=${encodeURIComponent(caller.callerSessionId)}` : ""}`);
    else result = await call(access, "POST", `/api/agent/reservations/${encodeURIComponent(rest[0])}/cancel`, JSON.stringify({ ...caller }));
  } catch {
    return reject("agent-console に接続できませんでした（起動しているか確認してください）");
  }
  if (result.status >= 200 && result.status < 300) return { code: 0, stdout: `${JSON.stringify(result.json, null, 2)}\n`, stderr: "" };
  const reason = result.json && typeof result.json.error === "string" ? result.json.error : `HTTP ${result.status}`;
  return reject(`受け付けられませんでした（${result.status}）: ${reason}`);
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
    result = reject("dataDir/bin に写された ac-reserve.mjs から実行してください（README の「予約」）");
  } else {
    let stdinText = "";
    if (process.argv[2] === "add") {
      try {
        stdinText = readFileSync(0, "utf8");
      } catch {
        stdinText = "";
      }
    }
    result = await runCommand({ argv: process.argv.slice(2), stdinText, dataDir: path.resolve(here, ".."), callerSessionId: process.env.CLAUDE_CODE_SESSION_ID });
  }
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
