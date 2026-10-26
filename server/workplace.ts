import { realpath } from "node:fs/promises";
import { checkGitLink } from "./git-safe.ts";
import type { Config } from "./config.ts";
import type { CommentScope, KnownPlace } from "./diff-comments.ts";
import { branchName, classifyCwd, listWorktreeEntries } from "./resume-targets.ts";
import { SessionConflictError, SessionNotFoundError, type SessionManager } from "./sessions.ts";

export interface Workplace extends CommentScope {
  sessionId: string;
}

/** 作業場所の照合に必要なもの（HTTP のルートも hub も同じ形で渡せる）。 */
export interface WorkplaceDeps {
  sessions: Pick<SessionManager, "get">;
  config: Pick<Config, "salesanchorRoot">;
}

/**
 * セッションの作業場所を、その時点の本店と git worktree list（正本）に照合する。
 * 本店でも worktree でもなければ 409 にして、git を実行しない。worktree 一覧を取れないときは（コメントを誤って捨てないよう）例外のまま 500 にする。
 * 変更の表示（diff-routes）と PR の状態（hub / pr-routes）が同じ照合を使う。
 */
export async function resolveWorkplace(deps: WorkplaceDeps, sessionId: string): Promise<Workplace> {
  const session = deps.sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError("session not found");
  const root = deps.config.salesanchorRoot;
  const entries = await listWorktreeEntries(root);
  const verdict = await classifyCwd(session.cwd, root, entries.map((e) => e.path));
  if (verdict.real === null || verdict.scope === null) throw new SessionConflictError(`working directory is ${verdict.block ?? "missing"}`);
  const linkReason = await checkGitLink(verdict.real, root);
  if (linkReason !== null) throw new SessionConflictError(`git link check failed: ${linkReason}`);
  const known: KnownPlace[] = [];
  for (const e of entries) {
    const real = await realpath(e.path).catch(() => null);
    if (real !== null) known.push({ dir: real, branch: branchName(e.branch) });
  }
  return { sessionId, dir: verdict.real, known };
}
