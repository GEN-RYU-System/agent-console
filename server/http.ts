import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { CHALLENGE_TTL_MS, PAIRING_TTL_MS, SESSION_MAX_MS, type Auth } from "./auth.ts";
import type { ActivityStore } from "./activity.ts";
import type { HookCheck } from "./activity-hooks.ts";
import { handleActivity } from "./activity-routes.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { MemoryCollector } from "./memory.ts";
import { DiffCommentsUnreadableError, type DiffCommentStore } from "./diff-comments.ts";
import { DiffGitError } from "./diff.ts";
import { handleDiff } from "./diff-routes.ts";
import { handlePr } from "./pr-routes.ts";
import type { PickerAccess } from "./picker-extension.ts";
import { handlePickIngest, handlePicks } from "./picks-routes.ts";
import type { PickStore } from "./picks.ts";
import { listResumeTargets, resolveResumeTarget } from "./resume-targets.ts";
import type { QuickPromptStore } from "./quick-prompts.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError, validateName, type SessionManager } from "./sessions.ts";
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
  quickPrompts: QuickPromptStore;
  diffComments: DiffCommentStore;
  picks: PickStore;
  picker: PickerAccess;
  /** セッションの様子の記録（dataDir/activity）の写し */
  activity: ActivityStore;
  /** 記録の仕組み（hooks）が Claude の設定に入っているかの点検。設定ファイルを読むだけ（呼ぶたびに行う） */
  checkHooks: () => HookCheck;
  memory: MemoryCollector;
  staticDir: string;
  meta: { saSource: string; claudeVersion: string; version: string; commit: string };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

/** 本文が上限を超えた。受け取り口では 403、それ以外では 400。 */
export class BodyTooLargeError extends SessionInputError {}

export async function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new BodyTooLargeError("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SessionInputError("invalid JSON");
  }
}

export class BadRequestError extends Error {}

async function serveStatic(staticDir: string, pathname: string, res: ServerResponse, csp: string, status = 200): Promise<void> {
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
  stream.on("open", () => {
    const type = MIME[path.extname(target)] ?? "application/octet-stream";
    // HTML 応答にだけ CSP を付ける（画面のスクリプトの読込先・接続先を自分のオリジンに限る）
    res.writeHead(status, { "Content-Type": type, ...(type.startsWith("text/html") ? { "Content-Security-Policy": csp } : {}) });
  });
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
      commit: meta.commit,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    // セッショントークンを失効させる（サーバー秘密の Bearer では行えない）
    const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!deps.auth.revokeSession(presented)) {
      sendJson(res, 400, { error: "no session to log out" });
      return;
    }
    sendJson(res, 200, { loggedOut: true });
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
  if (await handleDiff(deps, req, res, url)) return;
  if (await handlePr(deps, req, res, url)) return;
  if (await handlePicks(deps, req, res, url)) return;
  if (await handleActivity(deps, req, res, url)) return;
  if (await handleDailyUse(deps, req, res, url)) return;
  const removeMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && removeMatch) {
    sessions.remove(removeMatch[1]);
    sendJson(res, 200, { removed: true });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

/** 再開した端末のセッション名（アプリ側の表示名）。本店は固定、worktree はブランチ名（40 字以内）。 */
function resumeSessionName(kind: string, branch: string | null, real: string): string {
  return kind === "main" ? "resume: main" : `resume: ${branch ?? path.basename(real)}`.slice(0, 40);
}

/** 段階2: 区切りの既読・名前・よく使う指示・再開先・メモリ。すべて認証の内側。処理したら true。 */
async function handleDailyUse(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { sessions, hub, config, quickPrompts } = deps;
  const method = req.method ?? "GET";
  if (method === "GET" && url.pathname === "/api/memory") {
    // 名前は一覧と同じ表示名（Claude の name 優先）にそろえる
    const names = hub.displayNames();
    sendJson(res, 200, await deps.memory.collect(sessions.list().map((s) => ({ id: s.id, name: names.get(s.id) ?? s.name, exited: s.exited, term: s.term }))));
    return true;
  }
  if (method === "GET" && url.pathname === "/api/quick-prompts") {
    sendJson(res, 200, { items: await quickPrompts.list() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/quick-prompts") {
    const body = jsonBody(await readJsonBody(req));
    sendJson(res, 201, await quickPrompts.create({ label: body.label, text: body.text }));
    return true;
  }
  const promptMatch = /^\/api\/quick-prompts\/([^/]+)$/.exec(url.pathname);
  const moveMatch = /^\/api\/quick-prompts\/([^/]+)\/move$/.exec(url.pathname);
  if (moveMatch && method === "POST") {
    await quickPrompts.move(moveMatch[1], jsonBody(await readJsonBody(req)).direction);
    sendJson(res, 200, { moved: true });
    return true;
  }
  if (promptMatch && method === "PUT") {
    const body = jsonBody(await readJsonBody(req));
    sendJson(res, 200, await quickPrompts.update(promptMatch[1], { label: body.label, text: body.text }));
    return true;
  }
  if (promptMatch && method === "DELETE") {
    await quickPrompts.remove(promptMatch[1]);
    sendJson(res, 200, { removed: true });
    return true;
  }
  if (method === "GET" && url.pathname === "/api/resume-targets") {
    sendJson(res, 200, { items: await listResumeTargets(config.salesanchorRoot, config.roles) });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/sessions/resume") {
    const body = jsonBody(await readJsonBody(req));
    // 作業場所は本店と git worktree list（正本）に照合し、通った実パスだけを使う。会話の選択は端末内の Claude 公式の選択リストで人が行う
    const { role, real, kind, branch } = await resolveResumeTarget(body.kind, body.path, config.salesanchorRoot, config.roles);
    const session = sessions.resume({ roleId: role.id, name: resumeSessionName(kind, branch, real), cwd: real });
    sendJson(res, 201, { id: session.id });
    return true;
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(read|rename|send-check|close)$/.exec(url.pathname);
  if (method !== "POST" || !sessionMatch) return false;
  const [, id, action] = sessionMatch;
  const session = sessions.get(id);
  if (!session) throw new SessionNotFoundError("session not found");
  if (action === "close") {
    // 止まっているものは一覧から外し、動いているものは端末（と子孫）を終わらせてから外す。確認は画面で行う
    await sessions.close(id);
    sendJson(res, 200, { closed: true });
    return true;
  }
  if (action === "read") {
    await hub.markRead(id);
    sendJson(res, 200, { read: true });
    return true;
  }
  // 端末へ入れる操作は、要求を受けた時点で claude agents を取り直して判定する（定期取得の値は使わない）
  if (action === "rename") {
    const name = validateName(jsonBody(await readJsonBody(req)).name);
    sendJson(res, 200, { mode: await hub.requestRename(id, name) });
    return true;
  }
  // send-check: サーバーは端末へ書かない。入れてよい状態なら本文を返し、画面が xterm の paste() で入れてから Enter を送る
  const prompt = await quickPrompts.get(str(jsonBody(await readJsonBody(req)).promptId));
  const verdict = await hub.checkInput(id);
  if (!verdict.ok) throw new SessionConflictError(verdict.reason ?? "cannot input now");
  sendJson(res, 200, { text: prompt.text });
  return true;
}

const PICK_INGEST_PATH = "/api/picks";
const PAIRING_PATHS: ReadonlySet<string> = new Set(["/api/pair/challenge", "/api/pair", "/api/pair/redeem"]);
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export function jsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestError("JSON object required");
  return body as Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 認証前に呼ばれるペアリング用のエンドポイント（相互認証）。
 * - POST /api/pair/challenge {cnonce}            → {snonce, proof}（launcher がサーバーの証明を検証する）
 * - POST /api/pair {cnonce, snonce, proof}       → {code, expiresInSec}（クライアントの証明を検証）
 * - POST /api/pair/redeem {code}                 → {token, expiresInSec}（画面がコードを引換える。Origin 必須）
 * 長期秘密そのものは受け取らない・返さない。
 */
async function handlePairing(deps: AppDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const { auth } = deps;
  if (req.method !== "POST") return false;
  if (!PAIRING_PATHS.has(pathname)) return false;
  // 他サイトのページからの連打（no-cors の text/plain など）を拒否する。launcher（curl）は Origin を付けず JSON で送る
  if (req.headers.origin !== undefined && !auth.isOriginAllowed(req.headers.origin)) {
    sendJson(res, 403, { error: "forbidden origin" });
    return true;
  }
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "content-type must be application/json" });
    return true;
  }
  if (pathname === "/api/pair/challenge") {
    const challenge = auth.issueChallenge(str(jsonBody(await readJsonBody(req)).cnonce));
    if (challenge === "invalid") throw new BadRequestError("invalid cnonce");
    if (challenge === "busy") {
      res.setHeader("Retry-After", String(CHALLENGE_TTL_MS / 1000));
      sendJson(res, 429, { error: "too many pending challenges" });
      return true;
    }
    sendJson(res, 200, challenge);
    return true;
  }
  if (pathname === "/api/pair") {
    const body = jsonBody(await readJsonBody(req));
    const code = auth.redeemChallenge({ cnonce: str(body.cnonce), snonce: str(body.snonce), proof: str(body.proof) });
    if (code === null) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(res, 200, { code, expiresInSec: PAIRING_TTL_MS / 1000 });
    return true;
  }
  if (pathname === "/api/pair/redeem") {
    if (!auth.isOriginAllowed(req.headers.origin)) {
      sendJson(res, 403, { error: "forbidden origin" });
      return true;
    }
    const token = auth.consumePairingCode(str(jsonBody(await readJsonBody(req)).code));
    if (token === null) {
      res.setHeader("Cache-Control", NO_STORE["Cache-Control"]);
      sendJson(res, 401, { error: "invalid or expired code" });
      return true;
    }
    sendJson(res, 200, { token, expiresInSec: SESSION_MAX_MS / 1000 });
    return true;
  }
  return false;
}

/**
 * HTML 応答の CSP。スクリプトは自分のオリジンのみ・接続先は自分の HTTP と WebSocket のみ・iframe 埋込み不可。
 * style-src に 'unsafe-inline' が要る理由: xterm の DOM レンダラは実行時に <style> 要素を作り（テーマ・寸法）、
 * React/SA 金型もインラインの style 属性を使う。img-src に data: が要る理由: SA の Select が矢印を data: の SVG（CSS の背景）で描く。
 * どちらも無しだと CSP 違反が出ることを e2e で実測した（impl-notes）。
 */
export function contentSecurityPolicy(port: number): string {
  return `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
}

export function createRequestHandler(deps: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // すべての応答に付ける
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!deps.auth.isHostAllowed(req.headers.host)) {
        sendJson(res, 421, { error: "misdirected request" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.config.port}`);
      if (url.pathname === "/healthz") {
        // 本文の version / commit が、更新・切戻し・自己診断の成功判定に使われる
        sendJson(res, 200, { ok: true, version: deps.meta.version, commit: deps.meta.commit });
        return;
      }
      if (url.pathname.startsWith("/api/pair") && (await handlePairing(deps, req, res, url.pathname))) return;
      // 拡張からの部品の受け取り口。認証の前に通すのはこの完全一致の 1 本だけ（Origin と合言葉で守る）
      if (req.method === "POST" && url.pathname === PICK_INGEST_PATH) {
        await handlePickIngest(deps, req, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const method = deps.auth.authenticate({ authorization: req.headers.authorization });
        if (method === null) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        // セッション認証の状態変更は Origin 必須（自分以外・欠落は 403）。サーバー秘密の Bearer（CLI）は対象外。
        if (method === "session" && req.method !== "GET" && req.method !== "HEAD" && !deps.auth.isOriginAllowed(req.headers.origin)) {
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
      await serveStatic(deps.staticDir, url.pathname, res, contentSecurityPolicy(deps.config.port));
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
      if (err instanceof DiffCommentsUnreadableError) {
        console.error("diff comments unreadable:", err.message);
        sendJson(res, 500, { error: "comments unreadable" });
        return;
      }
      if (err instanceof DiffGitError) {
        console.error("diff failed:", err.message);
        sendJson(res, 500, { error: "diff failed" });
        return;
      }
      console.error("request failed:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  };
}
