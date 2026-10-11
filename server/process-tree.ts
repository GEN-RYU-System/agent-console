import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PsRow {
  pid: number;
  ppid: number;
}

export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
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
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], { maxBuffer: 8 * 1024 * 1024 });
  return parsePsOutput(stdout);
}
