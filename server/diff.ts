import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15000;
const LIST_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/** 変更のあるファイルの 1 行。untracked は git にまだ追加されていないファイル（名前だけ）。 */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  untracked: boolean;
}

export type ChangeList = { baseRef: string; files: ChangedFile[] } | { error: "noBase"; baseRef: string };

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export type FileDiff = { lines: DiffLine[] } | { tooLarge: true } | { binary: true } | { untracked: true };

/** git が失敗した（基準が無い以外）。呼び出し側が 500 にし、理由はサーバーの記録に残す。 */
export class DiffGitError extends Error {}

/** 出力の大きさは byte で数えたいので、buffer で受けてから UTF-8 に直す。 */
const git = async (dir: string, args: string[], maxBuffer: number): Promise<{ stdout: string }> => {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: "buffer" });
  return { stdout: stdout.toString("utf8") };
};

/** `git diff --numstat -z --no-renames` の出力（追加 TAB 削除 TAB パス NUL）を読む。`-` はバイナリ。 */
export function parseNumstatZ(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new DiffGitError("unexpected numstat output");
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    const binary = added === "-" || removed === "-";
    files.push({ path: record.slice(second + 1), added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary, untracked: false });
  }
  return files;
}

/** 基準（既定 origin/main）と作業場所の変更ファイル一覧。コミット済み・未コミット・未追加を合わせる。基準が無ければ noBase。 */
export async function listChanges(dir: string, baseRef: string): Promise<ChangeList> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", baseRef], LIST_MAX_BUFFER);
  } catch (err) {
    // --quiet: 参照が無いときは何も出さず終了コード 1。それ以外の失敗（時間切れ・リポジトリでない等）は呼び出し側へ
    if ((err as { code?: unknown }).code === 1) return { error: "noBase", baseRef };
    throw new DiffGitError(`git rev-parse failed: ${(err as Error).message}`);
  }
  try {
    const [tracked, others] = await Promise.all([
      git(dir, ["diff", "--merge-base", baseRef, "--no-renames", "--numstat", "-z"], LIST_MAX_BUFFER),
      git(dir, ["ls-files", "--others", "--exclude-standard", "-z"], LIST_MAX_BUFFER),
    ]);
    const known = new Set<string>();
    const files = parseNumstatZ(tracked.stdout);
    for (const f of files) known.add(f.path);
    const untracked = others.stdout
      .split("\0")
      .filter((p) => p !== "" && !known.has(p))
      .map((p): ChangedFile => ({ path: p, added: 0, removed: 0, binary: false, untracked: true }));
    return { baseRef, files: [...files, ...untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  } catch (err) {
    if (err instanceof DiffGitError) throw err;
    throw new DiffGitError(`git diff failed: ${(err as Error).message}`);
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** unified diff を、行番号つきの行の配列にする。ファイルのヘッダー（--- / +++ など）は、最初の @@ の前だけ読み飛ばす。 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      inHunk = true;
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk || raw === "" || raw.startsWith("\\")) continue;
    const mark = raw[0];
    const body = raw.slice(1);
    if (mark === "+") lines.push({ kind: "add", newLine: newNo++, text: body });
    else if (mark === "-") lines.push({ kind: "del", oldLine: oldNo++, text: body });
    else lines.push({ kind: "ctx", oldLine: oldNo++, newLine: newNo++, text: body });
  }
  return lines;
}

/** 1 ファイルの変更。file は同じ時点の一覧に載っている項目（呼び出し側で照合済み）。 */
export async function readFileDiff(dir: string, baseRef: string, file: ChangedFile, maxBytes: number): Promise<FileDiff> {
  if (file.untracked) return { untracked: true };
  if (file.binary) return { binary: true };
  try {
    const { stdout } = await git(dir, ["diff", "--merge-base", baseRef, "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--", file.path], maxBytes);
    return { lines: parseUnifiedDiff(stdout) };
  } catch (err) {
    if ((err as { code?: unknown }).code === MAX_BUFFER_CODE) return { tooLarge: true };
    throw new DiffGitError(`git diff failed: ${(err as Error).message}`);
  }
}
