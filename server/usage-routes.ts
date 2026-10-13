import type { IncomingMessage, ServerResponse } from "node:http";
import { readUsage } from "../hooks/ac-statusline.mjs";
import { sendJson, type AppDeps } from "./http.ts";

/**
 * GET /api/usage（認証の内側）。dataDir/usage.json を読んで返すだけ（書かない・ほかの処理もしない）。
 * 無ければ {status:"none"}、壊れていれば {status:"invalid"}、読めれば {status:"ok", observedAt, fiveHour?, sevenDay?}。
 * 正本の書き手は、Claude の statusLine が動かす命令（hooks/ac-statusline.mjs）だけ。処理したら true。
 */
export async function handleUsage(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/usage" || req.method !== "GET") return false;
  sendJson(res, 200, readUsage(deps.config.dataDir));
  return true;
}
