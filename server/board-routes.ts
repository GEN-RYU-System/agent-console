import type { IncomingMessage, ServerResponse } from "node:http";
import { boardFor } from "./boards.ts";
import { sendJson, type AppDeps } from "./http.ts";
import { SessionNotFoundError } from "./sessions.ts";

const BOARD_PATH = /^\/api\/sessions\/([^/]+)\/board$/;

/**
 * GET /api/sessions/:id/board（認証の内側）。そのアプリのセッションの claudeSessionId のボードを返す。
 * 無ければ {status:"none"}、壊れていれば {status:"invalid"}（ファイルは書き換えない）、読めれば {status:"ok", board}。
 * 書き込みの口は作らない（正本の書き手は、そのセッションの Claude だけ）。処理したら true。
 */
export async function handleBoard(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = BOARD_PATH.exec(url.pathname);
  if (!match || req.method !== "GET") return false;
  const session = deps.sessions.get(match[1]);
  if (!session) throw new SessionNotFoundError("session not found");
  sendJson(res, 200, boardFor(deps.config.dataDir, session.claudeSessionId));
  return true;
}
