// 囲いの外で作業場所に向けて動かす git はこの上書きを通す（作業場所の設定で命令が動かない）。ADR-1039・設計 §4-5。
// 囲いの外で git を動かす前に、git の繋がり・本店の繋がりを確かめる。設計 §4-5。
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export function safeGitArgs(dir: string, args: readonly string[]): string[] {
  return [...SAFE_GIT_CONFIG, "-C", dir, ...args];
}

async function lstatOrNull(p: string) {
  return lstat(p).catch(() => null);
}

async function absent(p: string): Promise<boolean> {
  return lstat(p).then(() => false, (e: NodeJS.ErrnoException) => e.code === "ENOENT");
}

async function realOrNull(p: string): Promise<string | null> {
  return realpath(p).catch(() => null);
}

/** 本店の .git が本物のディレクトリで、commondir・config.worktree が無いこと。問題なければ null、落ちたら理由。 */
export async function checkMainLink(mainRoot: string): Promise<string | null> {
  try {
    const st = await lstatOrNull(path.join(mainRoot, ".git"));
    if (st === null || !st.isDirectory() || st.isSymbolicLink()) return "main .git is not a real directory";
    if (!(await absent(path.join(mainRoot, ".git", "commondir")))) return "main commondir present";
    if (!(await absent(path.join(mainRoot, ".git", "config.worktree")))) return "main config.worktree present";
    return null;
  } catch {
    return "main link check error";
  }
}

async function readLinkTarget(file: string, base: string): Promise<string | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body === "" || body.includes("\n")) return null;
  return realOrNull(path.resolve(base, body));
}

/** 作業場所（本店そのもの、または本店の worktree）の git の繋がりが正しいこと。問題なければ null、落ちたら理由。 */
export async function checkGitLink(dir: string, mainRoot: string): Promise<string | null> {
  try {
    const mainReason = await checkMainLink(mainRoot);
    if (mainReason !== null) return mainReason;
    const C = await realOrNull(path.join(mainRoot, ".git"));
    if (C === null) return "main .git unresolvable";
    const realDir = await realOrNull(dir);
    if (realDir === null) return "dir unresolvable";
    const dotgit = path.join(dir, ".git");
    const st = await lstatOrNull(dotgit);
    if (st === null) return ".git missing";
    if (realDir === (await realOrNull(mainRoot))) {
      if (st.isSymbolicLink() || !st.isDirectory()) return "main .git is not a real directory";
      return (await realOrNull(dotgit)) === C ? null : ".git does not match main";
    }
    if (st.isSymbolicLink() || !st.isFile()) return ".git is not a regular file";
    const text = await readFile(dotgit, "utf8");
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (body.includes("\n") || !body.startsWith("gitdir: ")) return ".git content is not a single gitdir line";
    const G = await realOrNull(path.resolve(dir, body.slice("gitdir: ".length)));
    if (G === null) return "gitdir unresolvable";
    if (path.dirname(G) !== path.join(C, "worktrees")) return "gitdir outside main worktrees";
    if ((await readLinkTarget(path.join(G, "commondir"), G)) !== C) return "commondir does not match main";
    if ((await readLinkTarget(path.join(G, "gitdir"), G)) !== (await realOrNull(dotgit))) return "gitdir back-link mismatch";
    if (!(await absent(path.join(G, "config")))) return "worktree config present";
    if (!(await absent(path.join(G, "config.worktree")))) return "worktree config.worktree present";
    return null;
  } catch {
    return "git link check error";
  }
}
