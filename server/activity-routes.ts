import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, type AppDeps } from "./http.ts";
import { SessionNotFoundError } from "./sessions.ts";

const ACTIVITY_PATH = /^\/api\/sessions\/([^/]+)\/activity$/;

/**
 * GET /api/sessions/:id/activity（認証の内側）。そのアプリのセッションの claudeSessionId の記録だけをまとめて返す（K7）。
 * claudeSessionId がまだ無いセッションは {status:"noSession"}。記録の仕組みが外れていないかの点検（K8）は、呼ぶたびに行う（設定ファイルを読むだけ）。
 * 処理したら true。
 */
export async function handleActivity(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = ACTIVITY_PATH.exec(url.pathname);
  if (!match || req.method !== "GET") return false;
  const session = deps.sessions.get(match[1]);
  if (!session) throw new SessionNotFoundError("session not found");
  if (session.claudeSessionId === undefined) {
    sendJson(res, 200, { status: "noSession" });
    return true;
  }
  await deps.activity.refresh();
  sendJson(res, 200, { status: "ok", now: Date.now(), ...deps.activity.view(session.claudeSessionId), hooks: deps.checkHooks() });
  return true;
}
