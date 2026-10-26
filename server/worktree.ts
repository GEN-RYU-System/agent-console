// 台本は道具の写しから動かす。設計 §4-5 (c)。
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { checkMainLink } from "./git-safe.ts";
import { listWorktreeEntries } from "./resume-targets.ts";

const execFileAsync = promisify(execFile);

const BRANCH_PATTERN = /^release\/[a-z0-9][a-z0-9-]{1,60}$/;

export function isValidBranch(branch: string): boolean {
  return BRANCH_PATTERN.test(branch);
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (wtPath !== null) entries.push({ path: wtPath, branch });
  }
  return entries;
}

export function findWorktreePath(entries: WorktreeEntry[], branch: string): string | null {
  return entries.find((e) => e.branch === `refs/heads/${branch}`)?.path ?? null;
}

export class WorktreeError extends Error {}

/** new-worktree.sh を道具の写し（scriptRoot）から引数配列で呼び、git の worktree 一覧から場所を確定する。ロジックは再実装しない。 */
export async function createWorktree(root: string, scriptRoot: string, script: string, branch: string): Promise<string> {
  if (!isValidBranch(branch)) throw new WorktreeError("invalid branch name");
  const linkReason = await checkMainLink(root);
  if (linkReason !== null) throw new WorktreeError(`main link check failed: ${linkReason}`);
  const scriptPath = path.join(scriptRoot, script);
  const st = await stat(scriptPath).catch(() => null);
  if (st === null || !st.isFile()) throw new WorktreeError(`new-worktree script missing: ${scriptPath}`);
  try {
    await execFileAsync("bash", [scriptPath, branch], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new WorktreeError(`new-worktree failed: ${(e.stderr || e.stdout || e.message).toString().trim()}`);
  }
  let entries: WorktreeEntry[];
  try {
    entries = await listWorktreeEntries(root);
  } catch (err) {
    throw new WorktreeError(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const found = findWorktreePath(entries, branch);
  if (!found) throw new WorktreeError(`worktree for ${branch} not found after creation`);
  return found;
}
