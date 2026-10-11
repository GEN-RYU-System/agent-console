import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { PAIRING_TTL_MS, type Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError, type SessionManager } from "./sessions.ts";
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
  meta: { saSource: string; claudeVersion: string; version: string };
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

class BadRequestError extends Error {}

async function serveStatic(staticDir: string, pathname: string, res: ServerResponse, status = 200): Promise<void> {
  const root = path.resolve(staticDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BadRequestError("malformed URL");
  }
  let target = path.resolve(root, "." + decoded);
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
  const stream = createReadStream(target);
  stream.on("error", (err) => {
    console.error("static read failed:", err.message);
    if (res.headersSent) res.destroy();
    else res.writeHead(500).end();
  });
  stream.on("open", () => res.writeHead(status, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" }));
  stream.pipe(res);
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
      appVersion: meta.version,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pair") {
    // コードの発行はサーバー秘密（Bearer）を持つ呼び出しだけ。Cookie では発行できない。
    if (deps.auth.authenticate({ authorization: req.headers.authorization }) !== "bearer") {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { code: deps.auth.issuePairingCode(PAIRING_TTL_MS), expiresInSec: PAIRING_TTL_MS / 1000 });
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
  const removeMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && removeMatch) {
    sessions.remove(removeMatch[1]);
    sendJson(res, 200, { removed: true });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function handlePair(deps: AppDeps, url: URL, res: ServerResponse): Promise<void> {
  const code = url.searchParams.get("code") ?? "";
  const sessionId = deps.auth.consumePairingCode(code);
  if (sessionId === null) {
    // 画面側（SPA の /pair）が Callout で案内する
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    await serveStatic(deps.staticDir, "/", res, 401);
    return;
  }
  res
    .writeHead(303, {
      Location: "/",
      "Set-Cookie": deps.auth.sessionCookie(sessionId),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end();
}

export function createRequestHandler(deps: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!deps.auth.isHostAllowed(req.headers.host)) {
        sendJson(res, 421, { error: "misdirected request" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.config.port}`);
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("ok");
        return;
      }
      if (url.pathname === "/pair" && req.method === "GET") {
        await handlePair(deps, url, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const method = deps.auth.authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie });
        if (method === null) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        // Cookie 認証の状態変更は Origin 必須（自分以外・欠落は 403）。Bearer は Cookie を使わないため対象外。
        if (method === "cookie" && req.method !== "GET" && req.method !== "HEAD" && !deps.auth.isOriginAllowed(req.headers.origin)) {
          sendJson(res, 403, { error: "forbidden origin" });
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
      if (err instanceof SessionInputError || err instanceof WorktreeError || err instanceof BadRequestError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (err instanceof SessionNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      if (err instanceof SessionConflictError) {
        sendJson(res, 409, { error: err.message });
        return;
      }
      console.error("request failed:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  };
}
