import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_PARALLEL = 8;
const LOOKUP_TIMEOUT_MS = 30000;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

export function parseBranchLine(content: string): string | null {
  const first = content.split("\n", 1)[0] ?? "";
  if (!first.startsWith("branch: ")) return null;
  const branch = first.slice("branch: ".length).trim();
  return branch === "" ? null : branch;
}

/** 台帳ファイル由来のブランチ名を窓口スクリプトへ渡してよいか（先頭 '-'・空白・'..' などを拒否）。 */
export function isSafeLedgerBranch(branch: string): boolean {
  return SAFE_BRANCH_PATTERN.test(branch) && !branch.split("/").includes("..");
}

export interface LedgerRow {
  branch: string;
  state: string;
  /** 3 列目（開始日時）の生の文字列 */
  startedAtText: string;
}

const STARTED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** `YYYY-MM-DD HH:MM`（この Mac のローカル時刻）をエポックミリ秒にする。読めない・暦として不正なら null。 */
export function parseStartedAt(text: string): number | null {
  const m = STARTED_AT_PATTERN.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  const valid =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
  return valid ? date.getTime() : null;
}

/** `| ブランチ名 | 担当 | 開始 | 状態 | …` の 4 列目を状態とする。 */
export function parseLedgerRow(line: string): LedgerRow | null {
  const cells = line.split("|").map((c) => c.trim());
  // 先頭の '|' の左は空文字になるので除く
  const cols = cells[0] === "" ? cells.slice(1) : cells;
  if (cols.length < 4) return null;
  return { branch: cols[0], state: cols[3], startedAtText: cols[2] };
}

export type LookupResult =
  | { kind: "found"; state: string; startedAt: number | null }
  | { kind: "unregistered" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface LedgerCard {
  branch: string;
  result: LookupResult;
}

export interface LedgerError {
  branch: string;
  message: string;
}

export const LEDGER_COLUMNS = ["IN_PROGRESS", "REVIEW", "DONE", "OTHER", "UNREGISTERED"] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
export type LedgerGroups = Record<LedgerColumn, LedgerCard[]>;

export interface LedgerSnapshot {
  groups: LedgerGroups;
  /** 台帳を読めなかった項目。「未登録」とは別に UI へ出す。 */
  errors: LedgerError[];
}

/** error は groups に入れない（未登録と混ぜない）。 */
export function groupByState(cards: LedgerCard[]): LedgerGroups {
  const groups: LedgerGroups = { IN_PROGRESS: [], REVIEW: [], DONE: [], OTHER: [], UNREGISTERED: [] };
  for (const card of cards) {
    const result = card.result;
    if (result.kind === "error") continue;
    if (result.kind !== "found") {
      groups.UNREGISTERED.push(card);
    } else if (result.state === "IN_PROGRESS" || result.state === "REVIEW" || result.state === "DONE") {
      groups[result.state].push(card);
    } else {
      groups.OTHER.push(card);
    }
  }
  return groups;
}

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  stderr?: string;
  message?: string;
}

/** ledger-lookup.sh の契約は exit 0/1/2 のみ。それ以外は「読めない」エラー。 */
export function classifyLookupFailure(err: ExecFailure): LookupResult {
  if (err.code === 1) return { kind: "unregistered" };
  if (err.code === 2) return { kind: "conflict" };
  if (typeof err.code === "number") return { kind: "error", message: `exit ${err.code}: ${(err.stderr ?? "").trim()}` };
  return { kind: "error", message: (err.message ?? "lookup failed").trim() };
}

export async function lookupBranch(root: string, script: string, branch: string): Promise<LookupResult> {
  try {
    const { stdout } = await execFileAsync("bash", [path.join(root, script), branch], { cwd: root, timeout: LOOKUP_TIMEOUT_MS });
    const row = parseLedgerRow(stdout.split("\n").find((l) => l.trim() !== "") ?? "");
    return row ? { kind: "found", state: row.state, startedAt: parseStartedAt(row.startedAtText) } : { kind: "error", message: "exit 0 but no ledger row in output" };
  } catch (err) {
    return classifyLookupFailure(err as ExecFailure);
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface BranchListing {
  branches: string[];
  errors: LedgerError[];
}

export async function listLedgerBranches(root: string, ledgerDir: string): Promise<BranchListing> {
  const dir = path.join(root, ledgerDir);
  const errors: LedgerError[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    // 台帳ディレクトリが無い = 登録ゼロ。それ以外（権限など）は読めないエラー
    if ((err as { code?: string }).code === "ENOENT") return { branches: [], errors };
    return { branches: [], errors: [{ branch: ledgerDir, message: (err as Error).message }] };
  }
  const branches: string[] = [];
  for (const name of names) {
    try {
      const branch = parseBranchLine(await readFile(path.join(dir, name), "utf8"));
      if (branch) branches.push(branch);
    } catch (err) {
      errors.push({ branch: name, message: (err as Error).message });
    }
  }
  return { branches, errors };
}

export async function loadLedger(root: string, ledgerDir: string, script: string): Promise<LedgerSnapshot> {
  const scriptPath = path.join(root, script);
  const scriptInfo = await stat(scriptPath).catch(() => null);
  if (!scriptInfo?.isFile()) {
    return {
      groups: groupByState([]),
      errors: [{ branch: script, message: `ledger lookup script not found: ${scriptPath}` }],
    };
  }
  const listing = await listLedgerBranches(root, ledgerDir);
  const errors = [...listing.errors];
  const safe: string[] = [];
  for (const branch of listing.branches) {
    if (isSafeLedgerBranch(branch)) safe.push(branch);
    else errors.push({ branch, message: "unsafe branch name in ledger file" });
  }
  const cards = await mapLimited(safe, MAX_PARALLEL, async (branch) => ({
    branch,
    result: await lookupBranch(root, script, branch),
  }));
  for (const card of cards) {
    if (card.result.kind === "error") errors.push({ branch: card.branch, message: card.result.message });
  }
  return { groups: groupByState(cards), errors };
}
