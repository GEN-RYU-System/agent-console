// agent-console: 定期実行（曜日・時刻で新しいセッションに指示を送る）の AI 用命令。Opus 限定。設計 docs/handoff/ac-routine/design.md §4。
// 使い方: node "<dataDir>/bin/ac-routine.mjs" list ／ add < routine.json ／ update <id> < routine.json ／ enable <id> < reason.json ／ disable <id> < reason.json ／ approve --reason <理由>
// approve: 担当（サブエージェント）が動いている間は書き込みが 403 になる。その次の書き込み 1 回だけを通す一時承認（10 分・1 回限り）を出す。設計 docs/handoff/ac-hardening/design.md §3-3a。
// 定期実行の正本は dataDir/routines.json で、書き手はサーバーだけ。この命令はファイルへ書かず、サーバーの HTTP（/api/agent/routines）に頼む。
// 宛先のポートと合言葉は dataDir/reserve-token（{"port","token"}、サーバーが書く）だけから取る。node の標準の部品だけを使う。
// 呼び出し元の会話は環境変数 CLAUDE_CODE_SESSION_ID を callerSessionId として送り、サーバーが役割を照合する（Opus 以外は 403）。
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESERVE_TOKEN_FILE_NAME = "reserve-token";
const MAX_INPUT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN = /^[0-9a-f]{64}$/;
const ROUTINE_ID = /^[A-Za-z0-9-]{1,64}$/;
const STDIN_SUBS = new Set(["add", "update", "enable", "disable"]);
const USAGE = '使い方: node "<dataDir>/bin/ac-routine.mjs" list ／ add < routine.json ／ update <id> < routine.json ／ enable <id> < reason.json ／ disable <id> < reason.json ／ approve --reason <理由>（reason は必須。入力の形は README の「定期実行（AI）」）';

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
 * dataDir は命令の置き場所の 1 つ上（ac-board と同じ判定）。callerSessionId は CLAUDE_CODE_SESSION_ID（無ければ送らず、サーバーが 403 にする）。
 */
export async function runCommand({ argv, stdinText = "", dataDir, callerSessionId }) {
  const [sub, ...rest] = argv;
  const needsId = sub === "update" || sub === "enable" || sub === "disable";
  const wellFormed = (sub === "approve" && rest.length >= 2 && rest[0] === "--reason" && rest.slice(1).join(" ").trim() !== "") || (sub === "add" && rest.length === 0) || (sub === "list" && rest.length === 0) || (needsId && rest.length === 1 && ROUTINE_ID.test(rest[0]));
  if (!wellFormed) return reject(USAGE);
  let payload;
  if (STDIN_SUBS.has(sub)) {
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
    if (sub === "list") result = await call(access, "GET", `/api/agent/routines${caller.callerSessionId !== undefined ? `?callerSessionId=${encodeURIComponent(caller.callerSessionId)}` : ""}`);
    else if (sub === "approve") result = await call(access, "POST", "/api/agent/routines/approval", JSON.stringify({ reason: rest.slice(1).join(" "), ...caller }));
    else if (sub === "add") result = await call(access, "POST", "/api/agent/routines", JSON.stringify({ ...payload, ...caller }));
    else if (sub === "update") result = await call(access, "PUT", `/api/agent/routines/${encodeURIComponent(rest[0])}`, JSON.stringify({ ...payload, ...caller }));
    else result = await call(access, "POST", `/api/agent/routines/${encodeURIComponent(rest[0])}/enabled`, JSON.stringify({ reason: payload.reason, enabled: sub === "enable", ...caller }));
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
    result = reject("dataDir/bin に写された ac-routine.mjs から実行してください（README の「定期実行（AI）」）");
  } else {
    let stdinText = "";
    if (STDIN_SUBS.has(process.argv[2])) {
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
