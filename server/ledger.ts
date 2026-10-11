import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_PARALLEL = 8;

export function parseBranchLine(content: string): string | null {
  const first = content.split("\n", 1)[0] ?? "";
  if (!first.startsWith("branch: ")) return null;
  const branch = first.slice("branch: ".length).trim();
  return branch === "" ? null : branch;
}

export interface LedgerRow {
  branch: string;
  state: string;
}

/** `| ブランチ名 | 担当 | 開始 | 状態 | …` の 4 列目を状態とする。 */
export function parseLedgerRow(line: string): LedgerRow | null {
  const cells = line.split("|").map((c) => c.trim());
  // 先頭の '|' の左は空文字になるので除く
  const cols = cells[0] === "" ? cells.slice(1) : cells;
  if (cols.length < 4) return null;
  return { branch: cols[0], state: cols[3] };
}

export type LookupResult = { kind: "found"; state: string } | { kind: "unregistered" } | { kind: "conflict" };

export interface LedgerCard {
  branch: string;
  result: LookupResult;
}

export const LEDGER_COLUMNS = ["IN_PROGRESS", "REVIEW", "DONE", "OTHER", "UNREGISTERED"] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
export type LedgerGroups = Record<LedgerColumn, LedgerCard[]>;

export function groupByState(cards: LedgerCard[]): LedgerGroups {
  const groups: LedgerGroups = { IN_PROGRESS: [], REVIEW: [], DONE: [], OTHER: [], UNREGISTERED: [] };
  for (const card of cards) {
    if (card.result.kind !== "found") {
      groups.UNREGISTERED.push(card);
    } else if (card.result.state === "IN_PROGRESS" || card.result.state === "REVIEW" || card.result.state === "DONE") {
      groups[card.result.state].push(card);
    } else {
      groups.OTHER.push(card);
    }
  }
  return groups;
}

export async function lookupBranch(root: string, script: string, branch: string): Promise<LookupResult> {
  try {
    const { stdout } = await execFileAsync("bash", [path.join(root, script), branch], { cwd: root, timeout: 30000 });
    const row = parseLedgerRow(stdout.split("\n").find((l) => l.trim() !== "") ?? "");
    return row ? { kind: "found", state: row.state } : { kind: "unregistered" };
  } catch (err) {
    const code = (err as { code?: number }).code;
    return code === 2 ? { kind: "conflict" } : { kind: "unregistered" };
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

export async function listLedgerBranches(root: string, ledgerDir: string): Promise<string[]> {
  const dir = path.join(root, ledgerDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const branches: string[] = [];
  for (const name of names) {
    const branch = parseBranchLine(await readFile(path.join(dir, name), "utf8"));
    if (branch) branches.push(branch);
  }
  return branches;
}

export async function loadLedger(root: string, ledgerDir: string, script: string): Promise<LedgerGroups> {
  const branches = await listLedgerBranches(root, ledgerDir);
  const cards = await mapLimited(branches, MAX_PARALLEL, async (branch) => ({
    branch,
    result: await lookupBranch(root, script, branch),
  }));
  return groupByState(cards);
}
