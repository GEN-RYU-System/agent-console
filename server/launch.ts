import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { classifyCwd, listWorktreeEntries } from "./resume-targets.ts";
import { SessionInputError, type SessionManager } from "./sessions.ts";

/** 定期実行と予約が共通で使う「新しいセッションを開いて指示を 1 回送る」処理と、その入力検査。 */

export const MAX_NAME = 40;
export const MAX_PROMPT = 8192;
export const READY_POLL_MS = 3000;
export const READY_TIMEOUT_MS = 120000;
const MAX_SESSION_NAME_BASE = 28;
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type LaunchOutcome = "sent" | "not_ready" | "full" | "cwd_invalid" | "failed";
export interface LaunchTiming { pollMs: number; timeoutMs: number }
export interface LaunchDeps { config: Config; sessions: SessionManager; hub: Hub; timing: LaunchTiming }
export interface LaunchRequest {
  roleId: string;
  name: string;
  /** JST の分の key（YYYY-MM-DDTHH:mm+09:00）。セッション名の末尾の日時になる */
  slotKey: string;
  cwd: string;
  branch?: string;
  promptText: string;
  /** セッションが入力待ちになったあと、送る直前の確認。false なら送らない */
  stillWanted: () => boolean;
}

export interface LaunchTextInput { name?: unknown; promptText?: unknown }
export interface LaunchTargetInput { roleId?: unknown; cwd?: unknown; branch?: unknown }

/** 名前（1〜40 字）と指示（8192 字以下・制御文字不可）の検査。定期実行と予約で同じ規則。label は例外の文言の頭 */
export function validateLaunchText(input: LaunchTextInput, label: string): { name: string } {
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > MAX_NAME) throw new SessionInputError(`${label} name must be 1-40 characters`);
  if (typeof input.promptText !== "string" || input.promptText.trim() === "" || input.promptText.length > MAX_PROMPT || CONTROL.test(input.promptText)) throw new SessionInputError(`${label} prompt invalid`);
  return { name: input.name.trim() };
}

/** 役割・作業フォルダ・ブランチの検査（定期実行と予約で同じ規則）。cwd は実体のパスに直して返す */
export async function validateLaunchTarget(config: Config, input: LaunchTargetInput, label: string): Promise<{ cwd: string }> {
  const role = config.roles.find((r) => r.id === input.roleId);
  if (!role) throw new SessionInputError("unknown role");
  // 本店で動く役割（needsWorktree=false）は cwd を省ける。省いたときだけ本店（config.salesanchorRoot）を使う（本店の正本は config の1か所）
  const cwdIn = input.cwd === undefined && !role.needsWorktree ? config.salesanchorRoot : input.cwd;
  if (typeof cwdIn !== "string") throw new SessionInputError(`${label} cwd invalid`);
  const entries = await listWorktreeEntries(config.salesanchorRoot);
  const verdict = await classifyCwd(cwdIn, config.salesanchorRoot, entries.map((e) => e.path));
  if (verdict.real === null || verdict.block !== null) throw new SessionInputError(`${label} cwd invalid`);
  if (role.needsWorktree && typeof input.branch !== "string") throw new SessionInputError(`${label} branch required`);
  return { cwd: verdict.real };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 「MM/DD HH:mm」（JST）。jstSlot の key（YYYY-MM-DDTHH:mm+09:00）から作る */
const stamp = (key: string): string => `${key.slice(5, 10).replace("-", "/")} ${key.slice(11, 16)}`;
/** 先頭 28 文字（コードポイント単位。文字の途中で切らない）。セッション名の上限 40 は UTF-16 の長さなので、超えるときは文字単位で縮める */
export const sessionNameFor = (name: string, key: string): string => {
  const chars = Array.from(name).slice(0, MAX_SESSION_NAME_BASE);
  while (chars.join("").length > MAX_SESSION_NAME_BASE) chars.pop();
  return `${chars.join("")} ${stamp(key)}`;
};

function isGone(deps: LaunchDeps, sessionId: string): boolean {
  const s = deps.sessions.get(sessionId);
  return s === undefined || s.exited;
}

/** Claude が入力待ちになるまで待つ。終了したら・時間切れなら false */
async function waitReady(deps: LaunchDeps, sessionId: string, extra?: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + deps.timing.timeoutMs;
  while (Date.now() < deadline) {
    if (isGone(deps, sessionId)) return false;
    const verdict = await deps.hub.checkInput(sessionId);
    if (verdict.ok && verdict.hasClaude && (extra === undefined || (await extra()))) return true;
    await sleep(deps.timing.pollMs);
  }
  return false;
}

/** cwd 再検査→空き確認→新しいセッションを開く→入力待ちを待つ→送る直前の確認→指示を 1 回送る */
export async function launchAndSend(deps: LaunchDeps, req: LaunchRequest): Promise<{ outcome: LaunchOutcome; sessionName?: string; sessionId?: string }> {
  const role = deps.config.roles.find((x) => x.id === req.roleId);
  if (!role) return { outcome: "failed" };
  const entries = await listWorktreeEntries(deps.config.salesanchorRoot).catch((e) => { console.error("routines: worktree list failed:", e instanceof Error ? e.message : e); return []; });
  const verdict = await classifyCwd(req.cwd, deps.config.salesanchorRoot, entries.map((e) => e.path));
  if (verdict.real === null || verdict.block !== null) return { outcome: "cwd_invalid" };
  if (!deps.sessions.hasCapacity()) return { outcome: "full" };
  const name = sessionNameFor(req.name, req.slotKey);
  const session = deps.sessions.restore({ role, name, cwd: verdict.real, branch: req.branch ?? null });
  if (!(await waitReady(deps, session.id))) return { outcome: isGone(deps, session.id) ? "failed" : "not_ready", sessionName: name, sessionId: session.id };
  if (!req.stillWanted()) return { outcome: "not_ready", sessionName: name, sessionId: session.id };
  // Claude の自動名で上書きされないように、同じ名前を Claude 側にも付ける（hub.ts:552）。反映に約3秒かかるので、名前が一致して入力待ちに戻るまで待ってから送る
  if ((await deps.hub.requestRename(session.id, name)) === "claude") {
    const named = async (): Promise<boolean> => (await deps.hub.snapshot()).sessions.find((v) => v.id === session.id)?.name === name;
    if (!(await waitReady(deps, session.id, named))) console.error("launch: claude-side name not confirmed in time, sending anyway:", name);
    if (isGone(deps, session.id)) return { outcome: "failed", sessionName: name, sessionId: session.id };
  }
  return { outcome: (await deps.hub.submitText(session.id, req.promptText)) ? "sent" : "failed", sessionName: name, sessionId: session.id };
}
