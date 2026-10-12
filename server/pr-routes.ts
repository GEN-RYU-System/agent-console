import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, type AppDeps } from "./http.ts";

const PR_PATH = /^\/api\/sessions\/([^/]+)\/pr(\/refresh)?$/;

/**
 * PR と検査の状態（認証の内側・読むだけ）。処理したら true。
 * - GET  /api/sessions/:id/pr          メモリの写しを返す（gh は呼ばない。まだ無ければ loading）
 * - POST /api/sessions/:id/pr/refresh  そのセッションの分をすぐ取り直す（前回から prRefreshMinMs 以内なら今の結果）
 * 作業場所が本店でも worktree でもなければ 409、無いセッションは 404（どちらも git・gh を実行しない）。
 */
export async function handlePr(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = PR_PATH.exec(url.pathname);
  if (!match) return false;
  const [, id, refresh] = match;
  const method = req.method ?? "GET";
  if (refresh === undefined && method === "GET") {
    sendJson(res, 200, await deps.hub.getPr(id));
    return true;
  }
  if (refresh !== undefined && method === "POST") {
    sendJson(res, 200, await deps.hub.refreshPr(id));
    return true;
  }
  return false;
}
