import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { descendantPids, readProcessTable, sumCpu, sumRssKb, type PsRow } from "./process-tree.ts";

const execFileAsync = promisify(execFile);

const KB_PER_MB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const PERCENT_MAX = 100;
const BYTES_PER_GB = 1024 * 1024 * 1024;
/** Mac のデータボリューム（利用者のファイルが入る側）。statfs の対象 */
const DISK_PATH = "/System/Volumes/Data";

export interface SessionMemory {
  id: string;
  name: string;
  rssMb: number;
  /** 子孫の %cpu 合計 ÷ コア数（Mac 全体を 100 とした割合。小数 1 桁） */
  cpuPercent: number;
  /** rssMb ÷ totalMb × 100（小数 1 桁）。totalMb が分からなければ null */
  ramPercent: number | null;
}

interface RawSystem {
  totalMb: number;
  /** `memory_pressure` 末尾の「System-wide memory free percentage」。 */
  freePercent: number;
  usedPercent: number;
}

export interface SystemMemory extends RawSystem {
  /** Mac 全体の CPU 使用率。定期計測の 2 時点の差。初回は null */
  cpuPercent: number | null;
  /** (blocks − bavail) / blocks × 100（statfs）。失敗時 null */
  diskUsedPercent: number | null;
  diskTotalGb: number | null;
}

export interface MemorySnapshot {
  sessions: SessionMemory[];
  /** このアプリのサーバープロセス自身 */
  serverRssMb: number;
  system: SystemMemory | null;
}

const toMb = (kb: number): number => Math.round((kb / KB_PER_MB) * 10) / 10;
const round1 = (v: number): number => Math.round(v * 10) / 10;
const clampPercent = (v: number): number => Math.min(PERCENT_MAX, Math.max(0, v));

/** os.cpus() の times 合計（ミリ秒累計）。busy = user+nice+sys+irq、total = busy+idle */
export interface CpuTimes {
  busy: number;
  total: number;
}

export function sumCpuTimes(cpus: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const c of cpus) {
    const b = c.times.user + c.times.nice + c.times.sys + c.times.irq;
    busy += b;
    total += b + c.times.idle;
  }
  return { busy, total };
}

/** 2 時点の差から Mac 全体の CPU 使用率（0〜100、小数 1 桁）。窓が空（total が増えていない）なら null。 */
export function cpuPercentBetween(prev: CpuTimes, cur: CpuTimes): number | null {
  const total = cur.total - prev.total;
  if (!(total > 0)) return null;
  return round1(clampPercent(((cur.busy - prev.busy) / total) * PERCENT_MAX));
}

/** statfs の結果から Disk の使用率と総容量。blocks が 0 以下なら null。 */
export function diskUsage(s: { blocks: number; bavail: number; bsize: number }): { usedPercent: number; totalGb: number } | null {
  if (!(s.blocks > 0)) return null;
  return { usedPercent: round1(clampPercent(((s.blocks - s.bavail) / s.blocks) * PERCENT_MAX)), totalGb: round1((s.blocks * s.bsize) / BYTES_PER_GB) };
}

async function readDisk(): Promise<{ usedPercent: number; totalGb: number } | null> {
  try {
    return diskUsage(await statfs(DISK_PATH));
  } catch {
    return null;
  }
}

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
export interface SessionForMemory {
  id: string;
  /** 一覧と同じ表示名（Claude の name 優先） */
  name: string;
  exited: boolean;
  term: { pid: number };
}

export function sessionMemory(sessions: ReadonlyArray<SessionForMemory>, table: PsRow[], totalMb: number | null = null, cores: number = os.availableParallelism()): SessionMemory[] {
  return sessions.map((s) => {
    const pids = s.exited ? new Set<number>() : descendantPids(s.term.pid, table);
    const rssMb = s.exited ? 0 : toMb(sumRssKb(pids, table));
    return {
      id: s.id,
      name: s.name,
      rssMb,
      cpuPercent: s.exited || !(cores > 0) ? 0 : round1(clampPercent(sumCpu(pids, table) / cores)),
      ramPercent: totalMb !== null && totalMb > 0 ? round1(clampPercent((rssMb / totalMb) * PERCENT_MAX)) : null,
    };
  });
}

async function readSystemMemory(): Promise<RawSystem | null> {
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

const CACHE_TTL_MS = 5000;

interface RawMemory {
  table: PsRow[];
  system: RawSystem | null;
  /** 省略時は null（測れていない） */
  disk?: { usedPercent: number; totalGb: number } | null;
}

/**
 * OS の実行結果（ps・sysctl・memory_pressure）を短時間キャッシュし、同時の要求は 1 回の実行にまとめる
 * （複数タブ・連打でコマンドが増えない）。セッション一覧は要求ごとに最新を使う。
 */
export class MemoryCollector {
  private cached: { at: number; raw: RawMemory } | null = null;
  private inFlight: Promise<RawMemory> | null = null;

  constructor(
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly readRaw: () => Promise<RawMemory> = async () => ({
      table: await readProcessTable().catch(() => []),
      system: await readSystemMemory(),
      disk: await readDisk(),
    }),
    private readonly readCpuTimes: () => CpuTimes = () => sumCpuTimes(os.cpus()),
  ) {}

  /** 直近の定期計測の Mac 全体 CPU（%）。定期計測が 2 回走るまでは null */
  private cpuPercent: number | null = null;
  private prevCpu: CpuTimes | null = null;

  private raw(force = false): Promise<RawMemory> {
    if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return Promise.resolve(this.cached.raw);
    if (this.inFlight) return this.inFlight;
    const run = this.readRaw()
      .then((raw) => {
        this.cached = { at: this.now(), raw };
        return raw;
      })
      .finally(() => (this.inFlight = null));
    this.inFlight = run;
    return run;
  }

  /**
   * 定期計測（metricsPollMs ごと）。OS の値を必ず読み直し、Mac 全体の CPU を前回との差で更新する。
   * CPU の差分を取るのはここだけ（/api/memory の読み出しは直近の値を使い、窓が極端に短くなって値が跳ねるのを防ぐ）。
   */
  async measure(sessions: ReadonlyArray<SessionForMemory>): Promise<MemorySnapshot> {
    const cur = this.readCpuTimes();
    if (this.prevCpu !== null) this.cpuPercent = cpuPercentBetween(this.prevCpu, cur) ?? this.cpuPercent;
    this.prevCpu = cur;
    await this.raw(true);
    return this.collect(sessions);
  }

  async collect(sessions: ReadonlyArray<SessionForMemory>): Promise<MemorySnapshot> {
    let raw = await this.raw();
    // キャッシュ後に作られたセッションは ps の表に居ない。0 MB と表示しないよう、そのときだけ読み直す
    if (sessions.some((s) => !s.exited && !raw.table.some((r) => r.pid === s.term.pid))) raw = await this.raw(true);
    return {
      sessions: sessionMemory(sessions, raw.table, raw.system?.totalMb ?? null),
      serverRssMb: toMb(process.memoryUsage().rss / KB_PER_MB),
      system: raw.system === null ? null : { ...raw.system, cpuPercent: this.cpuPercent, diskUsedPercent: raw.disk?.usedPercent ?? null, diskTotalGb: raw.disk?.totalGb ?? null },
    };
  }
}
