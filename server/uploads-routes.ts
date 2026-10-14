import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, jsonBody, readJsonBody, sendJson, type AppDeps } from "./http.ts";
import { UploadTooLargeError } from "./uploads.ts";
import { SessionInputError } from "./sessions.ts";

export const UPLOADS_PATH = "/api/uploads";
export const UPLOAD_FILES_PATH = "/api/uploads/files";
/** name は最大 1024 文字。JSON で 1 文字最大 6 byte（\\uXXXX）でも収まる余白 */
const NAME_MARGIN_BYTES = 8192;
const NAME_MAX_CHARS = 1024;
/** base64 は元の 4/3 倍。JSON の枠（{"data":""} など）の余白を足す */
const BODY_MARGIN_BYTES = 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 本文の上限: 画像の上限を base64 にした大きさ + 余白（この口だけ。ほかの口は 64KiB） */
export function uploadBodyLimit(maxBytes: number): number {
  return Math.ceil((maxBytes * 4) / 3) + BODY_MARGIN_BYTES;
}

function decodeBase64(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw === "" || raw.length % 4 !== 0 || !BASE64_PATTERN.test(raw)) {
    throw new SessionInputError("data must be a base64 string");
  }
  return Buffer.from(raw, "base64");
}

/** 空の "" は 0 byte として受ける。それ以外は decodeBase64 と同じ検査 */
function decodeFileBase64(raw: unknown): Buffer {
  if (raw === "") return Buffer.alloc(0);
  return decodeBase64(raw);
}

/** 端末に貼る画像の受け口（認証と Origin の検査の内側）。処理したら true。 */
export async function handleUploads(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== UPLOADS_PATH) return false;
  try {
    const body = jsonBody(await readJsonBody(req, uploadBodyLimit(deps.config.uploadMaxBytes)));
    const saved = await deps.uploads.save(decodeBase64(body.data));
    sendJson(res, 201, { path: saved.path });
  } catch (err) {
    if (err instanceof BodyTooLargeError || err instanceof UploadTooLargeError) {
      sendJson(res, 413, { error: "image too large" });
      return true;
    }
    throw err;
  }
  return true;
}

/** 端末に貼る画像以外のファイルの受け口（認証と Origin の検査の内側）。処理したら true。 */
export async function handleUploadFiles(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== UPLOAD_FILES_PATH) return false;
  try {
    const body = jsonBody(await readJsonBody(req, uploadBodyLimit(deps.config.uploadMaxBytes) + NAME_MARGIN_BYTES));
    const name = body.name;
    if (typeof name !== "string" || name.length < 1 || name.length > NAME_MAX_CHARS) {
      throw new SessionInputError("name must be a string of 1-1024 characters");
    }
    const saved = await deps.uploads.saveFile(name, decodeFileBase64(body.data));
    sendJson(res, 201, { path: saved.path });
  } catch (err) {
    if (err instanceof BodyTooLargeError || err instanceof UploadTooLargeError) {
      sendJson(res, 413, { error: "file too large" });
      return true;
    }
    throw err;
  }
  return true;
}
