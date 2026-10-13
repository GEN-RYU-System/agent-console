import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUTH_STATUS_TIMEOUT_MS = 15000;

/** 画面へ返す形。loggedIn・email・subscriptionType 以外のキー（orgId など）は持たない。 */
export type AccountResponse =
  | { status: "ok"; loggedIn: true; email: string; subscriptionType: string }
  | { status: "ok"; loggedIn: false }
  | { status: "invalid" }
  | { status: "error" };

/** `claude auth status --json` の出力から必要な 3 つだけを取り出す。型が違えば invalid。 */
export function parseAccount(stdout: string): AccountResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { status: "invalid" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { status: "invalid" };
  const o = raw as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean") return { status: "invalid" };
  if (!o.loggedIn) return { status: "ok", loggedIn: false };
  if (typeof o.email !== "string" || o.email === "" || typeof o.subscriptionType !== "string") return { status: "invalid" };
  return { status: "ok", loggedIn: true, email: o.email, subscriptionType: o.subscriptionType };
}

/** 失敗した実行の stdout（未ログインは終了コード 1 でも JSON が出る）。空・文字列でなければ null。 */
function failedStdout(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const stdout = (err as { stdout?: unknown }).stdout;
  return typeof stdout === "string" && stdout.trim() !== "" ? stdout : null;
}

/** 毎回 Claude Code に聞く（保存しない）。中身（メール等）はログに出さない。 */
export async function fetchAccount(claudeBin: string): Promise<AccountResponse> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ["auth", "status", "--json"], { timeout: AUTH_STATUS_TIMEOUT_MS });
    return parseAccount(stdout);
  } catch (err) {
    const out = failedStdout(err);
    return out === null ? { status: "error" } : parseAccount(out);
  }
}

let inflight: Promise<AccountResponse> | null = null;

/** 同時に来た要求は 1 回の実行にまとめる。 */
export function fetchAccountShared(claudeBin: string): Promise<AccountResponse> {
  if (inflight === null) {
    inflight = fetchAccount(claudeBin).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
