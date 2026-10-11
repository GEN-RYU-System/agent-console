import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PsRow {
  pid: number;
  ppid: number;
  /** resident set size（KB。`man ps`: 1024 byte 単位）。列が無い出力では 0 */
  rssKb: number;
}

/** `ps -axo pid=,ppid=,rss=`（rss は省略可）の出力を解析する。解釈できない行は捨てる。 */
export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: m[3] === undefined ? 0 : Number(m[3]) });
  }
  return rows;
}

/** 指定した pid 群の RSS 合計（KB）。 */
export function sumRssKb(pids: ReadonlySet<number>, rows: PsRow[]): number {
  let total = 0;
  for (const r of rows) if (pids.has(r.pid)) total += r.rssKb;
  return total;
}

/** root 自身を含む子孫 pid の集合。 */
export function descendantPids(root: number, rows: PsRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const result = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const child of children.get(cur) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

export async function readProcessTable(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 8 * 1024 * 1024 });
  return parsePsOutput(stdout);
}
