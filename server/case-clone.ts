// 件のセッション用の「本店から切り離した丸ごとの写し」を、囲いの外で作って確かめる。設計 §4-5「件ごとの写し」。
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { checkMainLink } from "./git-safe.ts";

const execFileAsync = promisify(execFile);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FETCH_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 30_000;
/** server/diff.ts の LIST_MAX_BUFFER と同じ（origin/main の全ファイルの一覧は約 800KB で、既定の 1 MiB に近い） */
const LIST_MAX_BUFFER = 8 * 1024 * 1024;
const CASE_BRANCH_PREFIX = "release/discord-case-";

/** 写しの .git/config に入ってよい鍵（小文字）。ここに無い鍵（include・filter・fsmonitor など）があれば写しを使わない */
export const CASE_CLONE_CONFIG_KEYS: readonly string[] = [
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.hookspath",
  "remote.origin.url",
  "remote.origin.fetch",
  "user.name",
  "user.email",
];
const CASE_CLONE_BRANCH_KEY = /^branch\..+\.(remote|merge)$/;

export class CaseCloneError extends Error {}

async function git(args: readonly string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    timeout: opts.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** 件の写しの置き場所 H/worktrees/discord-cases/<id>（id が UUID の形でなければ例外） */
export function caseCloneDir(H: string, id: string): string {
  if (!UUID.test(id)) throw new CaseCloneError("case id must be a UUID");
  return path.join(H, "worktrees", "discord-cases", id);
}

export const caseBranchOf = (id: string): string => `${CASE_BRANCH_PREFIX}${id.slice(0, 8)}`;

const pad = (n: number): string => String(n).padStart(2, "0");

function ledgerStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function isRealDirectory(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null);
  return st !== null && st.isDirectory() && !st.isSymbolicLink();
}

async function writeLedger(W: string, branch: string, id: string): Promise<void> {
  const pipeline = path.join(W, ".claude-pipeline");
  const ledgerFile = path.join(pipeline, "active-work.md");
  const ledgerDir = path.join(pipeline, "active-work.d");
  const fileStat = await lstat(ledgerFile).catch(() => null);
  if (fileStat === null || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new CaseCloneError("ledger file is not a regular file");
  if (!(await isRealDirectory(ledgerDir))) throw new CaseCloneError("ledger directory is not a real directory");
  const realW = await realpath(W);
  if ((await realpath(ledgerDir)) !== path.join(realW, ".claude-pipeline", "active-work.d")) throw new CaseCloneError("ledger directory resolves outside the clone");
  if ((await realpath(ledgerFile)) !== path.join(realW, ".claude-pipeline", "active-work.md")) throw new CaseCloneError("ledger file resolves outside the clone");
  const safe = branch.replaceAll("/", "-");
  const body = [
    `branch: ${branch}`,
    "",
    "| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |",
    "|-----------|--------------|---------|------|-----|------|------|",
    `| ${branch} | Discord の件 ${id.slice(0, 8)} | ${ledgerStamp(new Date())} | IN_PROGRESS | | | |`,
    "",
  ].join("\n");
  await writeFile(path.join(ledgerDir, `${safe}.md`), body, { flag: "wx", mode: 0o644 });
}

/**
 * 本店 M から、件の写し W（H/worktrees/discord-cases/<id>）を作る。W を返す。
 * 途中で失敗したら、W が caseCloneDir と同じ道のときだけ W を消してから投げ直す。Sales Anchor の new-worktree.sh は呼ばない。
 */
export async function createCaseClone(p: { M: string; H: string; id: string }): Promise<string> {
  const { M, H, id } = p;
  const W = caseCloneDir(H, id);
  const branch = caseBranchOf(id);
  const mainReason = await checkMainLink(M);
  if (mainReason !== null) throw new CaseCloneError(`main link check failed: ${mainReason}`);
  await git(["-C", M, "fetch", "origin", "main"], { timeout: FETCH_TIMEOUT_MS });
  const sha = (await git(["-C", M, "rev-parse", "--verify", "origin/main^{commit}"])).trim();
  // 写しの中の origin/main は本店の手元の main（古い）。本店の origin/main の sha を使う
  await mkdir(path.join(H, "worktrees", "discord-cases"), { recursive: true, mode: 0o700 });
  if (await lstat(W).then(() => true, () => false)) throw new CaseCloneError("case clone already exists");
  try {
    await git(["clone", "--no-hardlinks", "--local", "--no-checkout", "--", M, W], { timeout: CLONE_TIMEOUT_MS });
    // `remote get-url` は insteadOf を展開するので使わない
    const url = (await git(["-C", M, "config", "--get", "remote.origin.url"])).trim();
    if (!url.startsWith("https://github.com/") || url.includes("@")) throw new CaseCloneError("origin url is not a plain github https url");
    await git(["-C", W, "remote", "set-url", "origin", url]);
    await git(["-C", W, "switch", "-c", branch, sha]);
    // W/.git/config は囲いの中から書けないので、上流を先に書く
    await git(["-C", W, "config", `branch.${branch}.remote`, "origin"]);
    await git(["-C", W, "config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    await git(["-C", W, "config", "core.hooksPath", "frontend/.husky"]);
    const name = (await git(["-C", M, "config", "--local", "user.name"]).catch(() => "")).trim();
    const email = (await git(["-C", M, "config", "--local", "user.email"]).catch(() => "")).trim();
    if (name === "" || email === "") throw new CaseCloneError("main user.name/user.email is not set");
    await git(["-C", W, "config", "user.name", name]);
    await git(["-C", W, "config", "user.email", email]);
    await writeLedger(W, branch, id);
    return W;
  } catch (err) {
    if (W === caseCloneDir(H, id)) await rm(W, { recursive: true, force: true });
    throw err;
  }
}

/** 写しが作ったままの形か。落ちた理由か null。囲いの中のセッションが W/.git を書き換えていないことを確かめる */
export async function checkCaseClone(W: string, M: string): Promise<string | null> {
  try {
    const dotgit = path.join(W, ".git");
    if (!(await isRealDirectory(dotgit))) return "clone .git is not a real directory";
    for (const rel of ["commondir", path.join("objects", "info", "alternates")]) {
      if (await lstat(path.join(dotgit, rel)).then(() => true, () => false)) return `clone .git/${rel} present`;
    }
    const gitDir = (await git(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", W, "rev-parse", "--absolute-git-dir"])).trim();
    if (gitDir !== (await realpath(dotgit))) return "clone git dir mismatch";
    // ④⑤⑥に -c を付けない（-c の値は config --get の結果に混ざる）。--local で読む
    const hooksPath = (await git(["-C", W, "config", "--local", "--get", "core.hooksPath"]).catch(() => "")).trim();
    if (hooksPath !== "frontend/.husky") return "clone core.hooksPath differs";
    const url = (await git(["-C", W, "config", "--local", "--get", "remote.origin.url"]).catch(() => "")).trim();
    const mainUrl = (await git(["-C", M, "config", "--local", "--get", "remote.origin.url"]).catch(() => "")).trim();
    if (url === "" || url !== mainUrl) return "clone origin url differs";
    const keys = (await git(["-C", W, "config", "--file", dotgit + "/config", "--list", "--name-only"])).split("\n").filter((k) => k !== "");
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (!CASE_CLONE_CONFIG_KEYS.includes(lower) && !CASE_CLONE_BRANCH_KEY.test(lower)) return `clone config key not allowed: ${lower}`;
    }
    const staged = await git(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", W, "ls-files", "--stage"], { maxBuffer: LIST_MAX_BUFFER });
    if (staged.split("\n").some((line) => line.startsWith("160000"))) return "clone has a gitlink";
    if (await lstat(path.join(W, ".gitmodules")).then(() => true, (e: NodeJS.ErrnoException) => e.code !== "ENOENT")) return "clone has .gitmodules";
    return null;
  } catch {
    return "clone check error";
  }
}

