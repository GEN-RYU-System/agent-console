import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentRow, AgentStatus } from "./agents.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;

/** sessionId は UUID 形式のみ受け付ける（環境変数経由でも検証してから使う）。 */
export const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * 再開できない理由。
 * running: その sessionId が今動いている（このアプリの中でも別のターミナルでも。二重に同じセッションへ書かない）
 * main: cwd が本店そのもの（Opus 設計役のセッションは本店で動く。Opus 設計役の再開は設計 §12 の PO 判断なので対象外）
 * outside: cwd が本店のワークツリーではない
 * missing: cwd が存在しない
 */
export type ResumeBlock = "running" | "main" | "outside" | "missing";

export interface PastSession {
  sessionId: string;
  name: string;
  cwd: string;
  startedAt: number | null;
  status: AgentStatus;
  /** null のとき再開できる */
  blocked: ResumeBlock | null;
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
  block: Exclude<ResumeBlock, "running"> | null;
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
  if (real === null || !(await stat(real)).isDirectory()) return { block: "missing", real: null };
  if (real === (await realOrNull(root))) return { block: "main", real };
  for (const wt of worktrees) {
    if ((await realOrNull(wt)) === real) return { block: null, real };
  }
  return { block: "outside", real };
}

/** 一覧の各行に、cwd による再開不可の理由を付ける（running が先に付いていればそれを優先）。 */
export async function withResumability(
  items: PastSession[],
  root: string,
  listWorktrees: (root: string) => Promise<string[]> = listWorktreePaths,
): Promise<PastSession[]> {
  const worktrees = await listWorktrees(root).catch(() => []);
  const out: PastSession[] = [];
  for (const item of items) {
    if (item.blocked !== null) {
      out.push(item);
      continue;
    }
    out.push({ ...item, blocked: (await classifyCwd(item.cwd, root, worktrees)).block });
  }
  return out;
}
