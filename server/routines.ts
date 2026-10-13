import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { classifyCwd, listWorktreeEntries } from "./resume-targets.ts";
import { SessionInputError, type SessionManager } from "./sessions.ts";

export const ROUTINES_FILE = "routines.json";
const MODE = 0o600;
const DIR_MODE = 0o700;
const VERSION = 2;
const READ_VERSIONS: readonly number[] = [1, 2];
const TIME_ZONE = "Asia/Tokyo";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_NAME = 40;
const MAX_PROMPT = 8192;
const MAX_EVENTS = 100;
const READY_POLL_MS = 3000;
const READY_TIMEOUT_MS = 120000;
const MAX_SESSION_NAME_BASE = 28;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type RoutineOutcome = "sent" | "not_ready" | "full" | "cwd_invalid" | "failed";
/** version 1 の履歴を表示するためだけに読み込みを許す古い結果 */
type LegacyOutcome = "busy" | "waiting" | "unknown" | "stopped" | "missing";
const OUTCOMES = new Set<string>(["sent", "not_ready", "full", "cwd_invalid", "failed", "busy", "waiting", "unknown", "stopped", "missing"]);
export type RoutineEvent = { at: number; slot: string; outcome: RoutineOutcome | LegacyOutcome; sessionName?: string };
export interface Routine { id: string; name: string; enabled: boolean; roleId: string; cwd: string; branch?: string; timeZone: typeof TIME_ZONE; weekdays: number[]; timeHHmm: string; promptText: string; lastSlot?: string; createdAt: number; updatedAt: number; events: RoutineEvent[]; }
export interface RoutineTiming { pollMs: number; timeoutMs: number }
export type RoutineInput = Pick<Routine, "name" | "enabled" | "roleId" | "cwd" | "weekdays" | "timeHHmm" | "promptText"> & { branch?: string };

const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("routines.json: object required"); return x as Record<string, unknown>; };
const string = (x: unknown, what: string): string => { if (typeof x !== "string" || x.trim() === "") throw new Error(`routines.json: ${what} required`); return x; };
function weekdays(x: unknown): number[] { if (!Array.isArray(x) || x.some((n) => !Number.isInteger(n) || n < 0 || n > 6) || new Set(x).size !== x.length) throw new Error("routines.json: weekdays invalid"); return [...x].sort(); }
function event(x: unknown): RoutineEvent { const r = object(x); if (typeof r.at !== "number" || typeof r.slot !== "string" || typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) throw new Error("routines.json: event invalid"); return { at: r.at, slot: r.slot, outcome: r.outcome as RoutineEvent["outcome"], ...(typeof r.sessionName === "string" ? { sessionName: r.sessionName } : {}) }; }
function parse(raw: unknown): Routine { const r = object(raw); const timeHHmm = string(r.timeHHmm, "timeHHmm"); if (!TIME.test(timeHHmm) || r.timeZone !== TIME_ZONE || typeof r.enabled !== "boolean" || typeof r.createdAt !== "number" || typeof r.updatedAt !== "number" || !Array.isArray(r.events)) throw new Error("routines.json: routine invalid"); return { id: string(r.id, "id"), name: string(r.name, "name"), enabled: r.enabled, roleId: string(r.roleId, "roleId"), cwd: string(r.cwd, "cwd"), ...(typeof r.branch === "string" ? { branch: r.branch } : {}), timeZone: TIME_ZONE, weekdays: weekdays(r.weekdays), timeHHmm, promptText: string(r.promptText, "promptText"), ...(typeof r.lastSlot === "string" ? { lastSlot: r.lastSlot } : {}), createdAt: r.createdAt, updatedAt: r.updatedAt, events: r.events.map(event) }; }

export class RoutineStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.file = path.join(dataDir, ROUTINES_FILE); }
  private serial<T>(f: () => Promise<T>): Promise<T> { const run = this.queue.then(f, f); this.queue = run.catch(() => undefined); return run; }
  private async read(): Promise<Routine[]> { try { const p = object(JSON.parse(await readFile(this.file, "utf8"))); if (typeof p.version !== "number" || !READ_VERSIONS.includes(p.version) || !Array.isArray(p.items)) throw new Error("routines.json: unsupported format"); return p.items.map(parse); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return []; throw err; } }
  list(): Promise<Routine[]> { return this.serial(() => this.read()); }
  save(items: readonly Routine[]): Promise<void> { return this.serial(async () => { await this.read(); await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE }); const tmp = `${this.file}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify({ version: VERSION, items }, null, 2)}\n`, { mode: MODE }); await chmod(tmp, MODE); await rename(tmp, this.file); }); }
}

export function jstSlot(now: Date): { weekday: number; timeHHmm: string; key: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, timeHHmm: `${parts.hour}:${parts.minute}`, key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}+09:00` };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 「MM/DD HH:mm」（JST）。jstSlot の key（YYYY-MM-DDTHH:mm+09:00）から作る */
const stamp = (key: string): string => `${key.slice(5, 10).replace("-", "/")} ${key.slice(11, 16)}`;
/** 先頭 28 文字（コードポイント単位。文字の途中で切らない）。セッション名の上限 40 は UTF-16 の長さなので、超えるときは文字単位で縮める */
const sessionNameFor = (name: string, key: string): string => {
  const chars = Array.from(name).slice(0, MAX_SESSION_NAME_BASE);
  while (chars.join("").length > MAX_SESSION_NAME_BASE) chars.pop();
  return `${chars.join("")} ${stamp(key)}`;
};

export class RoutineService {
  private routines: Routine[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly config: Config, private readonly sessions: SessionManager, private readonly hub: Hub, private readonly store: RoutineStore, private readonly now: () => Date = () => new Date(), private readonly timing: RoutineTiming = { pollMs: READY_POLL_MS, timeoutMs: READY_TIMEOUT_MS }) {}
  async start(): Promise<void> { this.routines = await this.store.list(); this.timer = setInterval(() => void this.tick().catch((e) => console.error("routines: tick failed:", e)), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  list(): Routine[] { return this.routines; }
  /** 動いている実行がすべて終わるまで待つ（試験用） */
  async settled(): Promise<void> { while (this.inflight.size > 0) await Promise.all([...this.inflight]); }
  private async persist(): Promise<void> { await this.store.save(this.routines); }
  private async validate(input: RoutineInput): Promise<RoutineInput> {
    if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > MAX_NAME) throw new SessionInputError("routine name must be 1-40 characters");
    if (typeof input.promptText !== "string" || input.promptText.trim() === "" || input.promptText.length > MAX_PROMPT || CONTROL.test(input.promptText)) throw new SessionInputError("routine prompt invalid");
    if (!TIME.test(input.timeHHmm)) throw new SessionInputError("routine time invalid"); weekdays(input.weekdays);
    const role = this.config.roles.find((r) => r.id === input.roleId); if (!role) throw new SessionInputError("unknown role");
    const entries = await listWorktreeEntries(this.config.salesanchorRoot); const verdict = await classifyCwd(input.cwd, this.config.salesanchorRoot, entries.map((e) => e.path));
    if (verdict.real === null || verdict.block !== null) throw new SessionInputError("routine cwd invalid");
    if (role.needsWorktree && typeof input.branch !== "string") throw new SessionInputError("routine branch required");
    return { ...input, name: input.name.trim(), cwd: verdict.real, weekdays: [...input.weekdays].sort() };
  }
  async create(input: RoutineInput): Promise<Routine> { const x = await this.validate(input); const now = Date.now(); const routine: Routine = { id: randomUUID(), ...x, timeZone: TIME_ZONE, createdAt: now, updatedAt: now, events: [] }; await this.store.save([...this.routines, routine]); this.routines = [...this.routines, routine]; return routine; }
  async update(id: string, input: RoutineInput): Promise<Routine> { const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); const x = await this.validate(input); const old = this.routines[at]; if (x.roleId !== old.roleId || x.cwd !== old.cwd || (x.branch ?? null) !== (old.branch ?? null)) throw new SessionInputError("routine role, cwd and branch cannot be changed"); const next: Routine = { ...old, ...x, timeZone: TIME_ZONE, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }
  async setEnabled(id: string, enabled: unknown): Promise<Routine> { if (typeof enabled !== "boolean") throw new SessionInputError("enabled required"); const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); const next = { ...this.routines[at], enabled, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }

  /** 時刻が合った routine を選び、lastSlot を（同期で）入れて保存してから、セッションを開く実行を始める。実行は待たない。 */
  async tick(): Promise<void> {
    const slot = jstSlot(this.now());
    const due = this.routines.filter((r) => r.enabled && r.weekdays.includes(slot.weekday) && r.timeHHmm === slot.timeHHmm && r.lastSlot !== slot.key);
    if (due.length === 0) return;
    const ids = new Set(due.map((r) => r.id));
    this.routines = this.routines.map((r) => ids.has(r.id) ? { ...r, lastSlot: slot.key } : r);
    try { await this.persist(); } catch (e) { console.error("routines: lastSlot save failed, skipping this slot:", e instanceof Error ? e.message : e); return; }
    for (const r of due) {
      const run = this.dispatch(r, slot.key).finally(() => this.inflight.delete(run));
      this.inflight.add(run);
    }
  }

  private async dispatch(routine: Routine, slot: string): Promise<void> {
    let outcome: RoutineOutcome = "failed"; let sessionName: string | undefined;
    try { ({ outcome, sessionName } = await this.open(routine, slot)); } catch (e) { console.error("routines: dispatch failed:", e instanceof Error ? e.message : e); }
    const event: RoutineEvent = { at: this.now().getTime(), slot, outcome, ...(sessionName !== undefined ? { sessionName } : {}) };
    this.routines = this.routines.map((r) => r.id === routine.id ? { ...r, events: [...r.events, event].slice(-MAX_EVENTS), updatedAt: Date.now() } : r);
    try { await this.persist(); } catch (e) { console.error("routines: event save failed:", e instanceof Error ? e.message : e); }
  }

  private async open(routine: Routine, slot: string): Promise<{ outcome: RoutineOutcome; sessionName?: string }> {
    const role = this.config.roles.find((x) => x.id === routine.roleId);
    if (!role) return { outcome: "failed" };
    const entries = await listWorktreeEntries(this.config.salesanchorRoot).catch((e) => { console.error("routines: worktree list failed:", e instanceof Error ? e.message : e); return []; });
    const verdict = await classifyCwd(routine.cwd, this.config.salesanchorRoot, entries.map((e) => e.path));
    if (verdict.real === null || verdict.block !== null) return { outcome: "cwd_invalid" };
    if (!this.sessions.hasCapacity()) return { outcome: "full" };
    const name = sessionNameFor(routine.name, slot);
    const session = this.sessions.restore({ role, name, cwd: verdict.real, branch: routine.branch ?? null });
    if (!(await this.waitReady(session.id))) return { outcome: this.isGone(session.id) ? "failed" : "not_ready", sessionName: name };
    if (this.routines.find((r) => r.id === routine.id)?.enabled !== true) return { outcome: "not_ready", sessionName: name };
    return { outcome: (await this.hub.submitText(session.id, routine.promptText)) ? "sent" : "failed", sessionName: name };
  }

  private isGone(sessionId: string): boolean { const s = this.sessions.get(sessionId); return s === undefined || s.exited; }

  /** Claude が入力待ちになるまで待つ。終了したら・時間切れなら false */
  private async waitReady(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + this.timing.timeoutMs;
    while (Date.now() < deadline) {
      if (this.isGone(sessionId)) return false;
      const verdict = await this.hub.checkInput(sessionId);
      if (verdict.ok && verdict.hasClaude) return true;
      await sleep(this.timing.pollMs);
    }
    return false;
  }
}
