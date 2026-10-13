import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonBody, readJsonBody, sendJson, type AppDeps } from "./http.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError } from "./sessions.ts";

const CHAT_PATH = /^\/api\/sessions\/([^/]+)\/chat$/;
const QUEUE_PATH = /^\/api\/sessions\/([^/]+)\/chat\/queue$/;
const QUEUE_ITEM_PATH = /^\/api\/sessions\/([^/]+)\/chat\/queue\/([^/]+)$/;
const SEND_CHECK_PATH = /^\/api\/sessions\/([^/]+)\/chat\/send-check$/;
/** チャットから送る 1 回の文章の上限（byte） */
export const CHAT_SEND_MAX_BYTES = 32 * 1024;
// 改行（LF）とタブ以外の制御文字は、端末に入れると操作として働いてしまう（ESC・CR・NUL など）
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 送る文章の検査（空でない・32KiB まで・改行とタブ以外の制御文字なし）。通れば文章をそのまま返す。違えば 400 */
export function validateChatText(value: unknown): string {
  if (typeof value !== "string") throw new SessionInputError("text must be a string");
  if (value.trim() === "") throw new SessionInputError("text must not be empty");
  if (Buffer.byteLength(value, "utf8") > CHAT_SEND_MAX_BYTES) throw new SessionInputError(`text must be at most ${CHAT_SEND_MAX_BYTES} bytes`);
  if (FORBIDDEN_CONTROL.test(value)) throw new SessionInputError("text must not contain control characters other than newline and tab");
  return value;
}

/** since は 0 以上の整数だけ（省略は 0）。違えば 400 */
function parseSince(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^\d{1,15}$/.test(raw)) throw new SessionInputError("since must be a non-negative integer");
  return Number(raw);
}

/**
 * チャット画面（認証の内側）。処理したら true。
 * - GET /api/sessions/:id/chat?since=<seq>&epoch=<id>: そのセッションの会話（記録から作る）。since より後だけ。
 *   epoch が今のサーバーのものと違うとき（アプリが作り直された）は since を使わず全件を返し、reset: true を付ける。
 * - POST /api/sessions/:id/chat/send-check {text}: 本文を検査し、要求の時点で claude agents を取り直して、手すきのときだけ本文と貼ってから待つ時間を返す。
 *   サーバーは端末へ書かない（画面が貼って Enter を送る）。
 * - POST /api/sessions/:id/chat/queue {text}: 送信の予約を足す（端末へはすぐ書かない。手が空いたら hub が 1 件ずつ書く）。
 * - DELETE /api/sessions/:id/chat/queue/:qid: 予約を取り消す（送信済みで受け取りを確認できていないものも消せる）。
 */
export async function handleChat(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const chat = CHAT_PATH.exec(url.pathname);
  if (chat && req.method === "GET") {
    const session = deps.sessions.get(chat[1]);
    if (!session) throw new SessionNotFoundError("session not found");
    const requestedSince = parseSince(url.searchParams.get("since"));
    if (session.claudeSessionId === undefined) {
      sendJson(res, 200, { status: "noSession", queued: deps.hub.chatQueueOf(session.id) });
      return true;
    }
    await deps.activity.refresh();
    const epochParam = url.searchParams.get("epoch");
    const reset = epochParam !== null && epochParam !== deps.activity.epoch;
    const page = deps.activity.chat(session.claudeSessionId, reset ? 0 : requestedSince);
    sendJson(res, 200, { status: "ok", epoch: deps.activity.epoch, reset, lastSeq: page.lastSeq, items: page.items, queued: deps.hub.chatQueueOf(session.id) });
    return true;
  }
  const check = SEND_CHECK_PATH.exec(url.pathname);
  if (check && req.method === "POST") {
    const id = check[1];
    if (!deps.sessions.get(id)) throw new SessionNotFoundError("session not found");
    const text = validateChatText(jsonBody(await readJsonBody(req)).text);
    const verdict = await deps.hub.checkInput(id);
    if (!verdict.ok) throw new SessionConflictError(verdict.reason ?? "cannot input now");
    sendJson(res, 200, { text, submitDelayMs: deps.config.pasteSubmitDelayMs });
    return true;
  }
  const queue = QUEUE_PATH.exec(url.pathname);
  if (queue && req.method === "POST") {
    if (!deps.sessions.get(queue[1])) throw new SessionNotFoundError("session not found");
    const text = validateChatText(jsonBody(await readJsonBody(req)).text);
    const item = deps.hub.enqueueChat(queue[1], text);
    sendJson(res, 201, { id: item.id });
    return true;
  }
  const queueItem = QUEUE_ITEM_PATH.exec(url.pathname);
  if (queueItem && req.method === "DELETE") {
    if (!deps.sessions.get(queueItem[1])) throw new SessionNotFoundError("session not found");
    deps.hub.cancelChat(queueItem[1], queueItem[2]);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
