import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { SessionInputError, type SessionManager } from "./sessions.ts";
import { WorktreeError } from "./worktree.ts";

const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface AppDeps {
  config: Config;
  auth: Auth;
  sessions: SessionManager;
  hub: Hub;
  staticDir: string;
  meta: { saSource: string; claudeVersion: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new SessionInputError("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SessionInputError("invalid JSON");
  }
}

async function serveStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const root = path.resolve(staticDir);
  let target = path.resolve(root, "." + decodeURIComponent(pathname));
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    target = path.join(target, "index.html");
    info = await stat(target).catch(() => null);
  }
  if (!info) {
    // SPA フォールバック（拡張子の無いパスのみ）
    if (path.extname(pathname) === "") {
      target = path.join(root, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info) {
      res.writeHead(404).end("not found");
      return;
    }
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}

async function handleApi(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { sessions, hub, config, meta } = deps;
  if (req.method === "GET" && url.pathname === "/api/state") {
    const snap = await hub.snapshot();
    sendJson(res, 200, {
      ...snap,
      roles: config.roles.map((r) => ({ id: r.id, labelKey: r.labelKey, needsWorktree: r.needsWorktree })),
      saSource: meta.saSource,
      claudeVersion: meta.claudeVersion,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/ledger") {
    sendJson(res, 200, hub.getLedger() ?? (await hub.refreshLedger()));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/ledger/refresh") {
    sendJson(res, 200, await hub.refreshLedger());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const session = await sessions.create({ name: body?.name, roleId: body?.roleId, branch: body?.branch });
    sendJson(res, 201, { id: session.id });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

export function createRequestHandler(deps: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.config.port}`);
      if (url.pathname.startsWith("/api/")) {
        if (!deps.auth.isTokenValid(url, req.headers.authorization)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        await handleApi(deps, req, res, url);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      await serveStatic(deps.staticDir, url.pathname, res);
    } catch (err) {
      if (err instanceof SessionInputError || err instanceof WorktreeError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      console.error("request failed:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  };
}
