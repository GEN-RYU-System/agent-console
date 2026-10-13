import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchAccountShared } from "./account.ts";
import { sendJson, type AppDeps } from "./http.ts";

/**
 * GET /api/account（認証の内側）: 今の Claude ログインを Claude Code に聞いて返す（保存しない）。
 * POST /api/account/login（認証の内側）: config 固定の入り直し命令で端末を 1 つ開く。画面の文字列は受け取らない。
 * 処理したら true。
 */
export async function handleAccount(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/account" && req.method === "GET") {
    sendJson(res, 200, await fetchAccountShared(deps.config.claudeBin));
    return true;
  }
  if (url.pathname === "/api/account/login" && req.method === "POST") {
    if (deps.config.accountLoginCommand === undefined) {
      sendJson(res, 404, { error: "account switching is not configured" });
      return true;
    }
    const session = deps.sessions.createAccountLogin();
    sendJson(res, 201, { id: session.id });
    return true;
  }
  return false;
}
