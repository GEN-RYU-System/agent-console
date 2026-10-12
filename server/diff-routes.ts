import type { IncomingMessage, ServerResponse } from "node:http";
import { formatReviewComments } from "./diff-comments-format.ts";
import { validateCommentInput } from "./diff-comments.ts";
import { listChanges, readFileDiff, type ChangedFile } from "./diff.ts";
import { SessionConflictError, SessionInputError } from "./sessions.ts";
import { jsonBody, readJsonBody, sendJson, type AppDeps } from "./http.ts";
import { resolveWorkplace } from "./workplace.ts";

const SESSION_PREFIX = /^\/api\/sessions\/([^/]+)\/(diff|diff\/file|diff-comments(?:\/[^/]+)?)$/;

/** 画面から来た path を、いま作った一覧の項目と完全一致で照合する（それ以外は 400）。 */
async function matchFile(deps: AppDeps, dir: string, requested: unknown): Promise<{ baseRef: string; file: ChangedFile }> {
  const list = await listChanges(dir, deps.config.diffBaseRef);
  if ("error" in list) throw new SessionInputError("base ref not found");
  const file = typeof requested === "string" && requested !== "" ? list.files.find((f) => f.path === requested) : undefined;
  if (!file) throw new SessionInputError("path is not in the list of changed files");
  return { baseRef: list.baseRef, file };
}

/** 変更の表示とレビューコメント（認証の内側）。処理したら true。 */
export async function handleDiff(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = SESSION_PREFIX.exec(url.pathname);
  if (!match) return false;
  const method = req.method ?? "GET";
  const [, id, tail] = match;
  const store = deps.diffComments;
  const { config } = deps;

  if (tail === "diff" || tail === "diff/file") {
    if (method !== "GET") return false;
    const wp = await resolveWorkplace(deps, id);
    if (tail === "diff") {
      sendJson(res, 200, await listChanges(wp.dir, config.diffBaseRef));
      return true;
    }
    const { baseRef, file } = await matchFile(deps, wp.dir, url.searchParams.get("path"));
    sendJson(res, 200, await readFileDiff(wp.dir, baseRef, file, config.diffMaxFileBytes));
    return true;
  }

  const sub = tail.slice("diff-comments".length + 1);
  if (sub === "") {
    if (method === "GET") {
      sendJson(res, 200, { items: await store.list(await resolveWorkplace(deps, id)) });
      return true;
    }
    if (method === "POST") {
      const wp = await resolveWorkplace(deps, id);
      const input = validateCommentInput(await readJsonBody(req));
      await matchFile(deps, wp.dir, input.path);
      sendJson(res, 201, await store.add(wp, input));
      return true;
    }
    return false;
  }
  if (sub === "send-check" && method === "POST") {
    const wp = await resolveWorkplace(deps, id);
    // 送る文章を先に作る（未送信が無い・長すぎるは 400）。そのあと、入力してよい状態かを取り直して決める
    const { text, ids } = formatReviewComments(await store.list(wp), config.diffSendMaxBytes);
    const verdict = await deps.hub.checkInput(id);
    if (!verdict.ok) throw new SessionConflictError(verdict.reason ?? "cannot input now");
    sendJson(res, 200, { text, ids, submitDelayMs: config.pasteSubmitDelayMs });
    return true;
  }
  if (sub === "mark-sent" && method === "POST") {
    const wp = await resolveWorkplace(deps, id);
    const { ids } = jsonBody(await readJsonBody(req));
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === "string")) throw new SessionInputError("ids must be an array of strings");
    await store.markSent(wp, ids);
    sendJson(res, 200, { marked: true });
    return true;
  }
  if (method === "PUT") {
    const wp = await resolveWorkplace(deps, id);
    const input = validateCommentInput(await readJsonBody(req));
    await matchFile(deps, wp.dir, input.path);
    sendJson(res, 200, await store.update(wp, sub, input));
    return true;
  }
  if (method === "DELETE") {
    await store.remove(await resolveWorkplace(deps, id), sub);
    sendJson(res, 200, { removed: true });
    return true;
  }
  return false;
}
