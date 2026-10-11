import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { descendantPids, readProcessTable, sumRssKb, type PsRow } from "./process-tree.ts";
import type { Session } from "./sessions.ts";

const execFileAsync = promisify(execFile);

const KB_PER_MB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const PERCENT_MAX = 100;

export interface SessionMemory {
  id: string;
  name: string;
  rssMb: number;
}

export interface SystemMemory {
  totalMb: number;
  /** `memory_pressure` 末尾の「System-wide memory free percentage」。 */
  freePercent: number;
  usedPercent: number;
}

export interface MemorySnapshot {
  sessions: SessionMemory[];
  /** このアプリのサーバープロセス自身 */
  serverRssMb: number;
  system: SystemMemory | null;
}

const toMb = (kb: number): number => Math.round((kb / KB_PER_MB) * 10) / 10;

/** `sysctl -n hw.memsize`（バイト数）を MB にする。解釈できなければ null。 */
export function parseMemsize(text: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]) / BYTES_PER_MB);
}

/** `memory_pressure` の最終行「System-wide memory free percentage: 53%」。無ければ null。 */
export function parseFreePercent(text: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d{1,3})%/.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  return value <= PERCENT_MAX ? value : null;
}

/** セッションごと（pty の pid の全子孫の RSS 合計）。 */
export function sessionMemory(sessions: ReadonlyArray<Pick<Session, "id" | "name" | "exited"> & { term: { pid: number } }>, table: PsRow[]): SessionMemory[] {
  return sessions.map((s) => ({
    id: s.id,
    name: s.name,
    rssMb: s.exited ? 0 : toMb(sumRssKb(descendantPids(s.term.pid, table), table)),
  }));
}

async function readSystemMemory(): Promise<SystemMemory | null> {
  try {
    const [memsize, pressure] = await Promise.all([
      execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: COMMAND_TIMEOUT_MS }),
      execFileAsync("memory_pressure", [], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * BYTES_PER_MB }),
    ]);
    const totalMb = parseMemsize(memsize.stdout);
    const freePercent = parseFreePercent(pressure.stdout);
    if (totalMb === null || freePercent === null) return null;
    return { totalMb, freePercent, usedPercent: PERCENT_MAX - freePercent };
  } catch {
    return null;
  }
}

export async function collectMemory(sessions: Session[]): Promise<MemorySnapshot> {
  const table = await readProcessTable().catch(() => []);
  return {
    sessions: sessionMemory(sessions, table),
    serverRssMb: toMb(process.memoryUsage().rss / KB_PER_MB),
    system: await readSystemMemory(),
  };
}
