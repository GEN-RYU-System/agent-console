// セッションが書いたファイルを開く口（file-viewer 設計 §3-4）。読むだけ。書く・消す口は作らない。
// 読める範囲は、そのセッションの記録（hook）にある path との文字列の完全一致だけ（D2）。
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DEFAULT_FILE_VIEW_MAX_BYTES } from "./config.ts";
import { sendJson, type AppDeps } from "./http.ts";
import { SessionNotFoundError } from "./sessions.ts";

const FILES_PATH = /^\/api\/sessions\/([^/]+)\/files$/;
const CONTENT_PATH = /^\/api\/sessions\/([^/]+)\/files\/content$/;
const MARKDOWN_EXT = new Set([".md", ".markdown"]);
const BOM = "﻿";

export type FileContent =
  | { status: "noSession" }
  | { status: "missing" }
  | { status: "notRegular" }
  | { status: "unreadable" }
  | { status: "tooLarge"; size: number }
  | { status: "binary"; size: number }
  | { status: "ok"; text: string; size: number; mtimeMs: number; kind: "markdown" | "text" };

const errCode = (err: unknown): string => (typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "");

/** 一覧と照合済みの path を読む。最後の段の symlink は O_NOFOLLOW で拒み、FIFO は O_NONBLOCK で開いて fstat で落とす。最大「上限 + 1」byte だけ読む */
export async function readListedFile(file: string, maxBytes: number = DEFAULT_FILE_VIEW_MAX_BYTES): Promise<Exclude<FileContent, { status: "noSession" }>> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return { status: "missing" };
    if (code === "ELOOP" || code === "EISDIR") return { status: "notRegular" };
    return { status: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "notRegular" };
    // 最大「上限 + 1」byte だけ読む。fstat の後に伸びた場合も、読めた長さで上限を判定する
    const target = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < target.length) {
      const { bytesRead } = await handle.read(target, total, target.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { status: "tooLarge", size: Math.max(info.size, total) };
    const bytes = target.subarray(0, total);
    if (bytes.includes(0)) return { status: "binary", size: total };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { status: "binary", size: total };
    }
    if (text.startsWith(BOM)) text = text.slice(BOM.length);
    const kind = MARKDOWN_EXT.has(path.extname(file).toLowerCase()) ? "markdown" : "text";
    return { status: "ok", text, size: total, mtimeMs: info.mtimeMs, kind };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * セッションが書いたファイル（認証の内側）。処理したら true。
 * - GET /api/sessions/:id/files: そのセッションの記録にある書いたファイルの一覧（新しい順）。
 * - GET /api/sessions/:id/files/content?path=<絶対パス>: 一覧と完全一致した path だけ中身を返す。無ければ 404 notListed。
 */
export async function handleFiles(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "GET") return false;
  const list = FILES_PATH.exec(url.pathname);
  const content = list ? null : CONTENT_PATH.exec(url.pathname);
  if (!list && !content) return false;
  const session = deps.sessions.get((list ?? content)![1]);
  if (!session) throw new SessionNotFoundError("session not found");
  await deps.activity.refresh();
  if (session.claudeSessionId === undefined) {
    sendJson(res, 200, { status: "noSession" });
    return true;
  }
  const files = deps.activity.files(session.claudeSessionId);
  if (list) {
    sendJson(res, 200, { status: "ok", files: files.map((f) => ({ path: f.path, name: path.basename(f.path), dir: path.dirname(f.path), tool: f.tool, lastAt: f.lastAt, byAgent: f.byAgent })) });
    return true;
  }
  const requested = url.searchParams.get("path");
  if (requested === null || !files.some((f) => f.path === requested)) {
    sendJson(res, 404, { status: "notListed" });
    return true;
  }
  sendJson(res, 200, await readListedFile(requested));
  return true;
}
