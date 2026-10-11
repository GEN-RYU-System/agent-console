import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentRow, AgentStatus } from "./agents.ts";
import { SessionInputError } from "./sessions.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;

/** sessionId は UUID 形式のみ受け付ける（環境変数経由でも検証してから使う）。 */
export const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export interface PastSession {
  sessionId: string;
  name: string;
  cwd: string;
  startedAt: number | null;
  status: AgentStatus;
  /** このアプリのセッションの中で動いている（再開できない） */
  live: boolean;
}

/** `claude agents --all --json` の行を一覧にする。sessionId・cwd が無い行は捨て、新しい順に並べる。 */
export function toPastSessions(rows: AgentRow[], livePids: ReadonlySet<number>): PastSession[] {
  const out: PastSession[] = [];
  for (const r of rows) {
    if (r.sessionId === undefined || !SESSION_ID_PATTERN.test(r.sessionId) || r.cwd === undefined) continue;
    out.push({
      sessionId: r.sessionId,
      name: r.name ?? r.sessionId.slice(0, 8),
      cwd: r.cwd,
      startedAt: r.startedAt ?? null,
      status: r.status,
      live: livePids.has(r.pid),
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

/** 再開先の作業場所: 実在するディレクトリで、本店またはその worktree のどれかであること。 */
export async function assertResumableCwd(
  cwd: string,
  root: string,
  listWorktrees: (root: string) => Promise<string[]> = listWorktreePaths,
): Promise<string> {
  const real = await realOrNull(cwd);
  if (real === null || !(await stat(real)).isDirectory()) throw new SessionInputError("working directory does not exist");
  const allowed = new Set<string>();
  const rootReal = await realOrNull(root);
  if (rootReal !== null) allowed.add(rootReal);
  for (const wt of await listWorktrees(root).catch(() => [])) {
    const r = await realOrNull(wt);
    if (r !== null) allowed.add(r);
  }
  if (!allowed.has(real)) throw new SessionInputError("working directory is not the main checkout or one of its worktrees");
  return real;
}
