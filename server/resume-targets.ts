import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResumeScope, RoleConfig } from "./config.ts";
import { checkMainLink } from "./git-safe.ts";
import { SessionInputError } from "./sessions.ts";
import { parseWorktreePorcelain, type WorktreeEntry } from "./worktree.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;
const BRANCH_REF_PREFIX = "refs/heads/";

/** 再開先の1行。会話の一覧は持たない（選ぶのは Claude 公式の選択リスト）。作業場所の正本は本店と `git worktree list`。 */
export interface ResumeTarget {
  kind: ResumeScope;
  path: string;
  branch: string | null;
  roleId: string;
}

export type ListWorktrees = (root: string) => Promise<WorktreeEntry[]>;

/** `git worktree list --porcelain` の worktree 一覧（本店を含む）。 */
export const listWorktreeEntries: ListWorktrees = async (root) => {
  const linkReason = await checkMainLink(root);
  if (linkReason !== null) throw new Error(`main link check failed: ${linkReason}`);
  const { stdout } = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: GIT_TIMEOUT_MS });
  return parseWorktreePorcelain(stdout);
};

async function realOrNull(p: string): Promise<string | null> {
  return realpath(p).catch(() => null);
}

export interface CwdVerdict {
  block: "outside" | "missing" | null;
  /** 再開できるときの作業場所の種類（本店そのもの / 本店のワークツリー） */
  scope: ResumeScope | null;
  /** 実在するときの実パス */
  real: string | null;
}

/** 再開先の作業場所: 実在し、本店そのものか、本店の worktree のどれかであること。 */
export async function classifyCwd(cwd: string, root: string, worktrees: readonly string[]): Promise<CwdVerdict> {
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

export const branchName = (ref: string | null): string | null => (ref === null ? null : ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref);

/** 本店（Opus 役）と、本店を除く実在する worktree（Sonnet 役）。該当する役割が設定に無い種類は出さない。 */
export async function listResumeTargets(root: string, roles: readonly RoleConfig[], listWorktrees: ListWorktrees = listWorktreeEntries): Promise<ResumeTarget[]> {
  const mainReal = (await realOrNull(root)) ?? root;
  const entries = await listWorktrees(root).catch(() => [] as WorktreeEntry[]);
  const out: ResumeTarget[] = [];
  const mainRole = roleForScope(roles, "main");
  if (mainRole) {
    const mainEntry = entries.find((e) => e.path === mainReal);
    out.push({ kind: "main", path: mainReal, branch: branchName(mainEntry?.branch ?? null), roleId: mainRole.id });
  }
  const wtRole = roleForScope(roles, "worktree");
  if (!wtRole) return out;
  for (const e of entries) {
    const real = await realOrNull(e.path);
    if (real === null || real === mainReal) continue;
    out.push({ kind: "worktree", path: real, branch: branchName(e.branch), roleId: wtRole.id });
  }
  return out;
}

/**
 * 画面から受け取った {kind, path} を、サーバー側の正本（本店と、その時点の worktree 一覧）に照合する。
 * 通ったものだけ、実パスと役割を返す。画面の文字列はそのまま使わない。
 */
export async function resolveResumeTarget(
  kind: unknown,
  target: unknown,
  root: string,
  roles: readonly RoleConfig[],
  listWorktrees: ListWorktrees = listWorktreeEntries,
): Promise<{ role: RoleConfig; real: string; kind: ResumeScope; branch: string | null }> {
  if (kind !== "main" && kind !== "worktree") throw new SessionInputError("kind must be main or worktree");
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new SessionInputError("path must be an absolute path");
  const entries = await listWorktrees(root).catch(() => [] as WorktreeEntry[]);
  const verdict = await classifyCwd(target, root, entries.map((e) => e.path));
  if (verdict.real === null || verdict.scope === null) throw new SessionInputError(`cannot resume: working directory is ${verdict.block ?? "missing"}`);
  if (verdict.scope !== kind) throw new SessionInputError("cannot resume: kind does not match the working directory");
  const role = roleForScope(roles, kind);
  if (!role) throw new SessionInputError(`cannot resume: no role can resume ${kind} sessions`);
  let branch: string | null = null;
  for (const e of entries) {
    if ((await realOrNull(e.path)) === verdict.real) branch = branchName(e.branch);
  }
  return { role, real: verdict.real, kind, branch };
}
