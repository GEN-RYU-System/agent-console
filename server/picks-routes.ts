import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, jsonBody, readJsonBody, sendJson, type AppDeps } from "./http.ts";
import { formatPickRequest } from "./picks-format.ts";
import { PICK_ID_PATTERN, type PickRecord } from "./picks.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError } from "./sessions.ts";

/** 拡張からの受け取り口だけは、画像を含むため本文を 2MiB まで受ける（ほかの口は 64KiB）。 */
export const PICK_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const PICK_TOKEN_HEADER = "x-ac-picker-token";
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;
const PICK_PATH = /^\/api\/picks\/([^/]+)(\/image)?$/;
const SEND_CHECK_PATH = /^\/api\/sessions\/([^/]+)\/picks\/send-check$/;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const sameSecret = (given: unknown, expected: string): boolean => typeof given === "string" && timingSafeEqual(digest(given), digest(expected));

function pickId(raw: string): string {
  if (!PICK_ID_PATTERN.test(raw)) throw new SessionInputError("invalid pick id");
  return raw;
}

function idList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max || !raw.every((v) => typeof v === "string")) {
    throw new SessionInputError(`ids must be an array of 1 to ${max} pick ids`);
  }
  return [...new Set((raw as string[]).map(pickId))];
}

/**
 * 認証の前に分ける、拡張からの受け取り口（POST /api/picks の完全一致だけ）。
 * Host は呼び出し前に検査済み。ここでは Origin が固定 id の拡張と完全一致し、合言葉が合い、JSON であるものだけを通す。
 * 合わないものは 403（本文が 2MiB を超えるものも 403）。通ったあとの中身の不備は 400。
 */
export async function handlePickIngest(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { picker, picks } = deps;
  const forbidden = (): void => sendJson(res, 403, { error: "forbidden" });
  if (picker.token === null || picker.extensionOrigin === null || req.headers.origin !== picker.extensionOrigin) return forbidden();
  if (!sameSecret(req.headers[PICK_TOKEN_HEADER], picker.token)) return forbidden();
  if (!JSON_CONTENT_TYPE.test(req.headers["content-type"] ?? "")) return forbidden();
  let body: unknown;
  try {
    body = await readJsonBody(req, PICK_BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return forbidden();
    throw err;
  }
  const record = await picks.add(body);
  sendJson(res, 201, { id: record.id });
}

async function pickRecords(deps: AppDeps, ids: readonly string[]): Promise<PickRecord[]> {
  const all = await deps.picks.list();
  return ids.map((id) => {
    const found = all.find((p) => p.id === id);
    if (!found) throw new SessionNotFoundError("pick not found");
    return found;
  });
}

/** 画面向けの部品の API（認証の内側）。処理したら true。 */
export async function handlePicks(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const { picks, config } = deps;
  if (method === "GET" && url.pathname === "/api/picks") {
    sendJson(res, 200, { items: await picks.list(), extensionDir: deps.picker.extensionDir });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/picks/mark-sent") {
    await picks.markSent(idList(jsonBody(await readJsonBody(req)).ids, config.pickMaxKeep));
    sendJson(res, 200, { marked: true });
    return true;
  }
  const send = SEND_CHECK_PATH.exec(url.pathname);
  if (send && method === "POST") {
    if (!deps.sessions.get(send[1])) throw new SessionNotFoundError("session not found");
    const ids = idList(jsonBody(await readJsonBody(req)).ids, config.pickMaxKeep);
    // 送る文章を先に作る（長すぎる・見つからないは 400/404）。そのあと、入力してよい状態かを取り直して決める
    const { text } = formatPickRequest(await pickRecords(deps, ids), { dataDir: config.dataDir, maxBytes: config.pickSendMaxBytes, htmlChars: config.pickHtmlInPromptChars });
    const verdict = await deps.hub.checkInput(send[1]);
    if (!verdict.ok) throw new SessionConflictError(verdict.reason ?? "cannot input now");
    sendJson(res, 200, { text, ids, submitDelayMs: config.pasteSubmitDelayMs });
    return true;
  }
  const match = PICK_PATH.exec(url.pathname);
  if (!match) return false;
  const id = pickId(match[1]);
  if (match[2] !== undefined) {
    if (method !== "GET") return false;
    const image = await picks.readImage(id);
    if (image === null) throw new SessionNotFoundError("image not found");
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Content-Length": image.length });
    res.end(image);
    return true;
  }
  if (method === "PUT") {
    sendJson(res, 200, await picks.setNote(id, jsonBody(await readJsonBody(req)).note));
    return true;
  }
  if (method === "DELETE") {
    await picks.remove(id);
    sendJson(res, 200, { removed: true });
    return true;
  }
  return false;
}
