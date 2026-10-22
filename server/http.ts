import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { CHALLENGE_TTL_MS, PAIRING_TTL_MS, SESSION_MAX_MS, sameSecret, type Auth, type AuthMethod } from "./auth.ts";
import type { ActivityStore } from "./activity.ts";
import type { HookCheck } from "./activity-hooks.ts";
import { handleActivity } from "./activity-routes.ts";
import { handleBoard } from "./board-routes.ts";
import { handleUsage } from "./usage-routes.ts";
import { handleAccount } from "./account-routes.ts";
import { handleChat } from "./chat-routes.ts";
import { handleFiles } from "./files-routes.ts";
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
import { handleUploadFiles, handleUploads } from "./uploads-routes.ts";
import type { UploadStore } from "./uploads.ts";
import { listResumeTargets, resolveResumeTarget } from "./resume-targets.ts";
import type { QuickPromptStore } from "./quick-prompts.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError, isClaudeSessionId, validateName, type SessionManager } from "./sessions.ts";
import { WorktreeError } from "./worktree.ts";
import { RoutineApprovals } from "./routine-approvals.ts";
import { RoutineLimitError, validateReason, type RoutineService } from "./routines.ts";
import { ScheduleConflictError } from "./schedule-gate.ts";
import { RoutineAudit, type RoutineAuditAction, type RoutineAuditEntry } from "./routine-audit.ts";
import type { ReservationService } from "./reservations.ts";
import type { RelayManager } from "./relay.ts";
import type { ReserveAccess } from "./reserve-token.ts";

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
  uploads: UploadStore;
  picker: PickerAccess;
  /** セッションの様子の記録（dataDir/activity）の写し */
  activity: ActivityStore;
  /** 記録の仕組み（hooks）が Claude の設定に入っているかの点検。設定ファイルを読むだけ（呼ぶたびに行う） */
  checkHooks: () => HookCheck;
  memory: MemoryCollector;
  staticDir: string;
  meta: { saSource: string; claudeVersion: string; version: string; commit: string };
  routines: RoutineService;
  /** 予約（日時を指定して 1 回送る）。正本は dataDir/reservations.json */
  reservations: ReservationService;
  /** 引き継ぎ（今のセッションに引き継ぎ書を書かせ、次のセッションへ渡す）。進行はメモリだけ */
  relay: RelayManager;
  /** AI 用コマンドの合言葉（dataDir/reserve-token）。作れなかった・本番のポートでないときは token が null */
  reserve: ReserveAccess;
  /** ac-routine の一時承認の保管。無ければ deps ごとにメモリに 1 つ作る（試験では時刻を差し替えたものを渡す） */
  routineApprovals?: RoutineApprovals;
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

async function handleApi(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL, authKind: AuthMethod): Promise<void> {
  const { sessions, hub, config, meta } = deps;
  if (await handleRoutineApproval(deps, req, res, url, authKind)) return;
  if (req.method === "GET" && url.pathname === "/api/state") {
    const snap = await hub.snapshot();
    sendJson(res, 200, {
      ...snap,
      roles: config.roles.map((r) => ({ id: r.id, labelKey: r.labelKey, needsWorktree: r.needsWorktree, reservable: r.reservable !== false })),
      saSource: meta.saSource,
      claudeVersion: meta.claudeVersion,
      appVersion: meta.version,
      commit: meta.commit,
      terminalSmoothScrollMs: config.terminalSmoothScrollMs,
      terminalRenderer: config.terminalRenderer,
      uploadMaxBytes: config.uploadMaxBytes,
      accountSwitchEnabled: config.accountLoginCommand !== undefined,
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
  if (req.method === "GET" && url.pathname === "/api/routines") { sendJson(res, 200, { items: deps.routines.list() }); return; }
  if (req.method === "POST" && url.pathname === "/api/routines") { sendJson(res, 201, await deps.routines.create(jsonBody(await readJsonBody(req)) as never)); return; }
  const routineMatch = /^\/api\/routines\/([^/]+)$/.exec(url.pathname);
  const routineEnabledMatch = /^\/api\/routines\/([^/]+)\/enabled$/.exec(url.pathname);
  if (routineMatch && req.method === "PUT") { sendJson(res, 200, await deps.routines.update(routineMatch[1], jsonBody(await readJsonBody(req)) as never)); return; }
  if (routineEnabledMatch && req.method === "POST") { sendJson(res, 200, await deps.routines.setEnabled(routineEnabledMatch[1], jsonBody(await readJsonBody(req)).enabled)); return; }
  if (req.method === "GET" && url.pathname === "/api/reservations") { sendJson(res, 200, { items: await deps.reservations.listReady() }); return; }
  if (req.method === "POST" && url.pathname === "/api/reservations") { sendJson(res, 201, await deps.reservations.create(uiReservationInput(jsonBody(await readJsonBody(req))), "ui", { callerSessionId: null })); return; }
  const reservationCancel = /^\/api\/reservations\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === "POST" && reservationCancel) { sendJson(res, 200, await deps.reservations.cancel(reservationCancel[1], { callerSessionId: null })); return; }
  if (await handleDiff(deps, req, res, url)) return;
  if (await handlePr(deps, req, res, url)) return;
  if (await handlePicks(deps, req, res, url)) return;
  if (await handleActivity(deps, req, res, url)) return;
  if (await handleBoard(deps, req, res, url)) return;
  if (await handleUsage(deps, req, res, url)) return;
  if (await handleAccount(deps, req, res, url)) return;
  if (await handleChat(deps, req, res, url)) return;
  if (await handleFiles(deps, req, res, url)) return;
  if (await handleUploads(deps, req, res, url)) return;
  if (await handleUploadFiles(deps, req, res, url)) return;
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
    sendJson(res, 200, await quickPrompts.update(promptMatch[1], { label: body.label, text: body.text, pinned: body.pinned }));
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
  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(read|rename|send-check|close|move|relay)$/.exec(url.pathname);
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
  if (action === "relay") {
    sendJson(res, 202, await deps.relay.start(id));
    return true;
  }
  if (action === "move") {
    // 並び順の正本は SessionManager の Map。復元リスト（open-sessions.json）は記録係が変更の合図で書き直す
    sessions.move(id, jsonBody(await readJsonBody(req)).toIndex);
    sendJson(res, 200, { moved: true });
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
  // send-check: サーバーは端末へ書かない。入れてよい状態なら本文を返し、画面が xterm の paste() で入れるだけ。Enter は人が端末で押す
  const prompt = await quickPrompts.get(str(jsonBody(await readJsonBody(req)).promptId));
  // 作業中（busy）でも可。確認待ち・状態不明・停止は不可（chatVerdict）
  const verdict = await hub.checkChat(id);
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

/** 画面からの予約には purpose・measureNote を持たせない（測定目的の制限は AI 用の経路だけ） */
function uiReservationInput(body: Record<string, unknown>): Record<string, unknown> {
  const { purpose: _purpose, measureNote: _measureNote, ...rest } = body;
  return rest;
}

const safeDecode = (raw: string): string => { try { return decodeURIComponent(raw); } catch { throw new BadRequestError("malformed id"); } };

export const UI_APPROVAL_PATH = /^\/api\/sessions\/([^/]+)\/routine-approval$/;

/**
 * 画面からの ac-routine の一時承認（設計 ac-hardening §3-3）。POST で発行（30 分・1 回）、GET で今の承認（残り時間の表示用）。
 * 認証の種類が "session"（画面のトークンと Origin）のときだけ受ける。"bearer"（サーバーの秘密）は 403。結び先は claudeSessionId（未確定なら 400）。
 */
async function handleRoutineApproval(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL, authKind: AuthMethod): Promise<boolean> {
  const m = UI_APPROVAL_PATH.exec(url.pathname);
  if (!m) return false;
  const method = req.method ?? "";
  if (method !== "POST" && method !== "GET") return false;
  if (authKind !== "session") { sendJson(res, 403, { error: "forbidden" }); return true; }
  const session = deps.sessions.get(safeDecode(m[1]));
  if (!session) throw new SessionNotFoundError("session not found");
  const claudeSessionId = session.claudeSessionId;
  if (method === "GET") {
    const current = claudeSessionId === undefined ? null : approvalsOf(deps).peek(claudeSessionId);
    sendJson(res, 200, { approval: current === null ? null : { by: current.by, expiresAt: new Date(current.expiresAt).toISOString() } });
    return true;
  }
  if (claudeSessionId === undefined) throw new BadRequestError("Claude セッションが未確定です。数秒後に再試行してください");
  const approval = approvalsOf(deps).issue(claudeSessionId, "ui");
  await writeAudit(deps, { action: "approvalIssued", outcome: "ok", callerSessionId: claudeSessionId, roleId: session.roleId, by: "ui", expiresAt: new Date(approval.expiresAt).toISOString() });
  sendJson(res, 200, { approved: true, expiresAt: new Date(approval.expiresAt).toISOString() });
  return true;
}

const FORBIDDEN_RESERVE_MESSAGE = "ac-reserve is limited to reserve role sessions (起動直後は数秒〜数十秒待って再試行)";
const AGENT_RESERVATION_PATH = /^\/api\/agent\/reservations(?:\/([^/]+)\/cancel)?$/;

/**
 * AI 用の予約の受け取り口（/api/agent/reservations の GET・POST と /:id/cancel の POST だけ）。認証の前に分ける。
 * Host は検査済み。順序: Origin ヘッダーがあれば 403 → 合言葉が無ければ 401 → Bearer を定数時間比較（不一致 401）→ 本文 → 処理。
 */
async function handleAgentReservations(deps: AppDeps, req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  if (req.headers.origin !== undefined) { sendJson(res, 403, { error: "forbidden" }); return; }
  const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (deps.reserve.token === null || !sameSecret(presented, deps.reserve.token)) { sendJson(res, 401, { error: "unauthorized" }); return; }
  const id = match[1];
  const method = req.method ?? "";
  const isList = method === "GET" && id === undefined;
  const isAdd = method === "POST" && id === undefined;
  const isCancel = method === "POST" && id !== undefined;
  if (!isList && !isAdd && !isCancel) { sendJson(res, 404, { error: "not found" }); return; }
  const body = isAdd || isCancel ? jsonBody(await readJsonBody(req)) : {};
  const rawCaller = isList ? new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("callerSessionId") : body.callerSessionId;
  const callerSessionId = isClaudeSessionId(rawCaller) ? rawCaller : null;
  const caller = checkReserveCaller(deps, callerSessionId);
  if (!caller.ok) {
    const action: RoutineAuditAction | null = isAdd ? "reserveCreate" : isCancel ? "reserveCancel" : null;
    if (action !== null) await writeAudit(deps, { action, outcome: "denied", callerSessionId, ...(caller.roleId !== undefined ? { roleId: caller.roleId } : {}), error: "forbidden: caller is not a reserve role session" });
    sendJson(res, 403, { error: FORBIDDEN_RESERVE_MESSAGE });
    return;
  }
  const who = { callerSessionId, ...(caller.roleId !== undefined ? { roleId: caller.roleId } : {}) };
  if (isList) { sendJson(res, 200, { items: await deps.reservations.listReady() }); return; }
  if (isAdd) { const { callerSessionId: _caller, ...input } = body; sendJson(res, 201, await deps.reservations.create(input, "agent", who)); return; }
  sendJson(res, 200, await deps.reservations.cancel(safeDecode(id as string), who));
}

const AGENT_ROUTINE_PATH = /^\/api\/agent\/routines(?:\/([^/]+)(\/enabled)?)?$/;
const FORBIDDEN_ROUTINE_MESSAGE = "ac-routine is limited to manager role sessions (起動直後は数秒〜数十秒待って再試行)";
/** 担当が動いている間の書き込みの拒否（設計 ac-hardening S3）。承認の出し方を案内する */
export const SUBAGENT_RUNNING_MESSAGE = "担当が動いている間は ac-routine の書き込みは使えません。終わってから再試行するか、ac-routine approve --reason <理由> で承認してください（定期実行の中では NEEDS_DECISION: で終える）。PO は画面でも承認できます";
const routineAudits = new Map<string, RoutineAudit>();
const routineApprovalStores = new WeakMap<AppDeps, RoutineApprovals>();

/** 一時承認の保管（deps に無ければ deps ごとに 1 つ作る）。メモリだけ */
function approvalsOf(deps: AppDeps): RoutineApprovals {
  if (deps.routineApprovals !== undefined) return deps.routineApprovals;
  let store = routineApprovalStores.get(deps);
  if (store === undefined) { store = new RoutineApprovals(); routineApprovalStores.set(deps, store); }
  return store;
}

function auditOf(deps: AppDeps): RoutineAudit {
  let audit = routineAudits.get(deps.config.dataDir);
  if (audit === undefined) { audit = new RoutineAudit(deps.config.dataDir); routineAudits.set(deps.config.dataDir, audit); }
  return audit;
}

/** 監査へ 1 行。書けなくても処理は止めない */
async function writeAudit(deps: AppDeps, entry: Omit<RoutineAuditEntry, "at">): Promise<void> {
  try { await auditOf(deps).append({ at: new Date().toISOString(), ...entry }); } catch (e) { console.error("routine-audit: write failed:", e instanceof Error ? e.message : e); }
}

/** 呼び出し元の照合。正本は SessionManager のメモリ。生きていて claudeSessionId が一致する全セッションの役割が、すべて許可リストにあるときだけ通す */
function checkCaller(deps: AppDeps, callerSessionId: string | null, allowedRoles: readonly string[]): { ok: boolean; roleId?: string } {
  if (callerSessionId === null) return { ok: false };
  const matches = deps.sessions.list().filter((s) => !s.exited && s.claudeSessionId === callerSessionId);
  if (matches.length === 0) return { ok: false };
  const allowed = new Set(allowedRoles);
  return { ok: matches.every((s) => allowed.has(s.roleId)), roleId: matches[0].roleId };
}
const checkRoutineCaller = (deps: AppDeps, callerSessionId: string | null): { ok: boolean; roleId?: string } => checkCaller(deps, callerSessionId, deps.config.routineManagerRoles);
const checkReserveCaller = (deps: AppDeps, callerSessionId: string | null): { ok: boolean; roleId?: string } => checkCaller(deps, callerSessionId, deps.config.reserveRoles);

/**
 * AI 用の定期実行の受け口（/api/agent/routines の GET・POST、/:id の PUT、/:id/enabled の POST だけ）。認証の前に分ける。
 * 順序は予約と同じ（Origin があれば 403 → 合言葉 → 本文）。そのあと呼び出し元の役割を照合し（403）、reason を検査し（400）、処理する。
 * 監査に残すのは、成功・403・上限の 400 だけ（入力の不備の 400 は残さない）。
 */
async function handleAgentRoutines(deps: AppDeps, req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  if (req.headers.origin !== undefined) { sendJson(res, 403, { error: "forbidden" }); return; }
  const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (deps.reserve.token === null || !sameSecret(presented, deps.reserve.token)) { sendJson(res, 401, { error: "unauthorized" }); return; }
  const id = match[1] === undefined ? undefined : safeDecode(match[1]);
  const enabledPath = match[2] !== undefined;
  const method = req.method ?? "";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let action: RoutineAuditAction | null = null;
  // Opus の承認（設計 §3-3a）。:id より先に分岐し、"approval" を routine の id として扱わない。POST 以外・/enabled 付きは 404
  const isApproval = id === "approval";
  if (isApproval) action = method === "POST" && !enabledPath ? "approvalIssued" : null;
  else if (method === "POST" && id === undefined) action = "add";
  else if (method === "PUT" && id !== undefined && !enabledPath) action = "update";
  else if (method === "POST" && id !== undefined && enabledPath) action = "enable";
  const isList = method === "GET" && id === undefined;
  if (!isList && action === null) { sendJson(res, 404, { error: "not found" }); return; }

  const body = isList ? {} : jsonBody(await readJsonBody(req));
  if (action === "enable" && body.enabled === false) action = "disable";
  const rawCaller = isList ? url.searchParams.get("callerSessionId") : body.callerSessionId;
  const callerSessionId = isClaudeSessionId(rawCaller) ? rawCaller : null;
  const caller = checkRoutineCaller(deps, callerSessionId);
  const record = (entry: Omit<RoutineAuditEntry, "at" | "callerSessionId" | "roleId">): Promise<void> => writeAudit(deps, { callerSessionId, ...(caller.roleId !== undefined ? { roleId: caller.roleId } : {}), ...entry });
  const reasonText = typeof body.reason === "string" && body.reason.length <= 200 ? body.reason.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : undefined;
  if (!caller.ok) {
    if (action !== null) await record({ action, outcome: "denied", ...(reasonText !== undefined ? { reason: reasonText } : {}), error: "forbidden: caller is not a routine manager session" });
    sendJson(res, 403, { error: FORBIDDEN_ROUTINE_MESSAGE });
    return;
  }
  if (isList) { sendJson(res, 200, { items: deps.routines.list() }); return; }

  if (isApproval) {
    // 役割の照合は済み。reason は 1〜200 字（400）。承認は claudeSessionId に 1 件（後から出した方が上書き）、10 分・1 回限り
    const approvalReason = validateReason(body.reason);
    const claudeSessionId = callerSessionId as string;
    await deps.activity.refresh();
    const approval = approvalsOf(deps).issue(claudeSessionId, "opus");
    const running = deps.activity.view(claudeSessionId).running.map((a) => ({ key: a.key, subagentType: a.subagentType, startedAt: a.startedAt }));
    await record({ action: "approvalIssued", outcome: "ok", reason: approvalReason, by: "opus", expiresAt: new Date(approval.expiresAt).toISOString(), runningAgents: running });
    sendJson(res, 200, { approved: true, expiresAt: new Date(approval.expiresAt).toISOString() });
    return;
  }

  if (enabledPath && typeof body.enabled !== "boolean") throw new SessionInputError("enabled required");
  const reason = validateReason(body.reason);
  const { reason: _reason, callerSessionId: _caller, ...input } = body;
  const act = action as RoutineAuditAction;
  const target = id === undefined ? undefined : deps.routines.list().find((r) => r.id === id);
  const targetCreatedBy: "agent" | "ui" | undefined = target === undefined ? undefined : target.createdBy === "agent" ? "agent" : "ui";
  const withTarget = (routineId: string | undefined, by: "agent" | "ui" | undefined): Partial<RoutineAuditEntry> => (routineId !== undefined && by !== undefined ? { routineId, targetCreatedBy: by } : {});
  // 第1層（設計 ac-hardening §3-1）: 担当が動いている間の書き込みは 403。承認があればそれを 1 回分使って通す。承認はこの書き込みで（担当がいなくても）消える
  await deps.activity.refresh();
  const runningCount = deps.activity.runningCount(callerSessionId as string);
  const used = approvalsOf(deps).consume(callerSessionId as string);
  if (runningCount > 0 && used === null) {
    await record({ action: act, outcome: "denied", reason, runningCount, error: "forbidden: subagent running", ...withTarget(id, targetCreatedBy) });
    sendJson(res, 403, { error: SUBAGENT_RUNNING_MESSAGE });
    return;
  }
  const approvedBy: Partial<RoutineAuditEntry> = runningCount > 0 && used !== null ? { approvedBy: used.by } : {};
  let written = false;
  try {
    if (act === "add") {
      const created = await deps.routines.create(input as never, "agent");
      written = true;
      await record({ action: act, outcome: "ok", reason, ...approvedBy, ...withTarget(created.id, "agent") });
      sendJson(res, 201, created);
      return;
    }
    const result = act === "update" ? await deps.routines.update(id as string, input as never, true) : await deps.routines.setEnabled(id as string, act === "enable", true);
    written = true;
    await record({ action: act, outcome: "ok", reason, ...approvedBy, ...withTarget(result.id, targetCreatedBy) });
    sendJson(res, 200, result);
  } catch (err) {
    // 書き込みが失敗したら、取り出していた承認を戻す（期限は延長しない。戻せたかは上限超過の監査行に残す）
    const restored = !written && used !== null ? approvalsOf(deps).restore(callerSessionId as string, used) : undefined;
    if (err instanceof RoutineLimitError || err instanceof ScheduleConflictError) await record({ action: act, outcome: "denied", reason, error: err.message, ...(used !== null && restored !== undefined ? { approvalRestored: restored } : {}), ...withTarget(id, targetCreatedBy) });
    throw err;
  }
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
      const agentReservation = AGENT_RESERVATION_PATH.exec(url.pathname);
      if (agentReservation) {
        await handleAgentReservations(deps, req, res, agentReservation);
        return;
      }
      const agentRoutine = AGENT_ROUTINE_PATH.exec(url.pathname);
      if (agentRoutine) {
        await handleAgentRoutines(deps, req, res, agentRoutine);
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
        await handleApi(deps, req, res, url, method);
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
