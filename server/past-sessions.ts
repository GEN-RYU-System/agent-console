import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentRow, AgentStatus } from "./agents.ts";
import type { ResumeScope, RoleConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;

/** sessionId は UUID 形式のみ受け付ける（環境変数経由でも検証してから使う）。 */
export const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * 再開できない理由。
 * running: その sessionId が今動いている（このアプリの中でも別のターミナルでも。二重に同じセッションへ書かない）
 * outside: cwd が本店でも本店のワークツリーでもない
 * missing: cwd が存在しない
 * noRole: cwd の種類（本店 / ワークツリー）に再開できる役割が設定に無い
 * 本店そのもの（main）は不可ではなく、resumeScope が "main" の役割（Opus 設計役）で再開する。
 */
export type ResumeBlock = "running" | "outside" | "missing" | "noRole";

export interface PastSession {
  sessionId: string;
  name: string;
  cwd: string;
  startedAt: number | null;
  status: AgentStatus;
  /** null のとき再開できる */
  blocked: ResumeBlock | null;
  /** 再開に使う役割の id。再開できない行は null */
  resumeRoleId: string | null;
}

/**
 * `claude agents --all --json` の行を一覧にする。sessionId・cwd が無い行は捨て、新しい順に並べる。
 * runningIds は現在動いている一覧（`claude agents --json`）の sessionId、livePids はこのアプリのセッションの子孫 pid。
 * cwd による判定（main / outside / missing）は classifyCwd で後から付ける。
 */
export function toPastSessions(rows: AgentRow[], livePids: ReadonlySet<number>, runningIds: ReadonlySet<string> = new Set()): PastSession[] {
  const out: PastSession[] = [];
  for (const r of rows) {
    if (r.sessionId === undefined || !SESSION_ID_PATTERN.test(r.sessionId) || r.cwd === undefined) continue;
    out.push({
      sessionId: r.sessionId,
      name: r.name ?? r.sessionId.slice(0, 8),
      cwd: r.cwd,
      startedAt: r.startedAt ?? null,
      status: r.status,
      blocked: livePids.has(r.pid) || runningIds.has(r.sessionId) ? "running" : null,
      resumeRoleId: null,
    });
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** `git worktree list --porcelain` の worktree パス一覧（本店を含む）。 */
export async function listWorktreePaths(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: GIT_TIMEOUT_MS });
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

async function realOrNull(p: string): Promise<string | null> {
  return realpath(p).catch(() => null);
}

export interface CwdVerdict {
  block: Extract<ResumeBlock, "outside" | "missing"> | null;
  /** 再開できるときの作業場所の種類（本店そのもの / 本店のワークツリー） */
  scope: ResumeScope | null;
  /** 実在するときの実パス */
  real: string | null;
}

/** 再開先の作業場所: 実在し、本店そのものではなく、本店の worktree のどれかであること。 */
export async function classifyCwd(
  cwd: string,
  root: string,
  worktrees: readonly string[],
): Promise<CwdVerdict> {
  const real = await realOrNull(cwd);
  if (real === null || !(await stat(real)).isDirectory()) return { block: "missing", scope: null, real: null };
  if (real === (await realOrNull(root))) return { block: null, scope: "main", real };
  for (const wt of worktrees) {
    if ((await realOrNull(wt)) === real) return { block: null, scope: "worktree", real };
  }
  return { block: "outside", scope: null, real };
}

/** 作業場所の種類に対応する再開役割（設定の resumeScope が正本）。無ければ undefined。 */
export function roleForScope(roles: readonly RoleConfig[], scope: ResumeScope): RoleConfig | undefined {
  return roles.find((r) => r.resumeScope === scope && r.resumeCommand !== undefined);
}

/** 一覧の各行に、cwd による再開不可の理由と再開する役割 id を付ける（running が先に付いていればそれを優先）。 */
export async function withResumability(
  items: PastSession[],
  root: string,
  roles: readonly RoleConfig[],
  listWorktrees: (root: string) => Promise<string[]> = listWorktreePaths,
): Promise<PastSession[]> {
  const worktrees = await listWorktrees(root).catch(() => []);
  const out: PastSession[] = [];
  for (const item of items) {
    if (item.blocked !== null) {
      out.push(item);
      continue;
    }
    const verdict = await classifyCwd(item.cwd, root, worktrees);
    if (verdict.scope === null) {
      out.push({ ...item, blocked: verdict.block });
      continue;
    }
    const role = roleForScope(roles, verdict.scope);
    out.push(role ? { ...item, blocked: null, resumeRoleId: role.id } : { ...item, blocked: "noRole" });
  }
  return out;
}
