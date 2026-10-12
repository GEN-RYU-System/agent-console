import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { classifyCwd, listWorktreeEntries } from "./resume-targets.ts";
import { isClaudeSessionId, SessionInputError, type SessionManager } from "./sessions.ts";

export const ROUTINES_FILE = "routines.json";
const MODE = 0o600;
const DIR_MODE = 0o700;
const VERSION = 1;
const TIME_ZONE = "Asia/Tokyo";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_NAME = 40;
const MAX_PROMPT = 8192;
const MAX_EVENTS = 100;
const MAX_EVALUATED = 1000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type RoutineEvent = { at: number; slot: string; outcome: "sent" | "busy" | "waiting" | "unknown" | "stopped" | "missing" | "failed" };
export interface Routine { id: string; name: string; enabled: boolean; roleId: string; cwd: string; branch?: string; timeZone: typeof TIME_ZONE; weekdays: number[]; timeHHmm: string; promptText: string; claudeSessionId?: string; createdAt: number; updatedAt: number; events: RoutineEvent[]; }
export type RoutineInput = Pick<Routine, "name" | "enabled" | "roleId" | "cwd" | "weekdays" | "timeHHmm" | "promptText"> & { branch?: string };

const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("routines.json: object required"); return x as Record<string, unknown>; };
const string = (x: unknown, what: string): string => { if (typeof x !== "string" || x.trim() === "") throw new Error(`routines.json: ${what} required`); return x; };
function weekdays(x: unknown): number[] { if (!Array.isArray(x) || x.some((n) => !Number.isInteger(n) || n < 0 || n > 6) || new Set(x).size !== x.length) throw new Error("routines.json: weekdays invalid"); return [...x].sort(); }
function event(x: unknown): RoutineEvent { const r = object(x); const outcomes = new Set<RoutineEvent["outcome"]>(["sent", "busy", "waiting", "unknown", "stopped", "missing", "failed"]); if (typeof r.at !== "number" || typeof r.slot !== "string" || typeof r.outcome !== "string" || !outcomes.has(r.outcome as RoutineEvent["outcome"])) throw new Error("routines.json: event invalid"); return { at: r.at, slot: r.slot, outcome: r.outcome as RoutineEvent["outcome"] }; }
function parse(raw: unknown): Routine { const r = object(raw); const timeHHmm = string(r.timeHHmm, "timeHHmm"); if (!TIME.test(timeHHmm) || r.timeZone !== TIME_ZONE || typeof r.enabled !== "boolean" || typeof r.createdAt !== "number" || typeof r.updatedAt !== "number" || !Array.isArray(r.events)) throw new Error("routines.json: routine invalid"); return { id: string(r.id, "id"), name: string(r.name, "name"), enabled: r.enabled, roleId: string(r.roleId, "roleId"), cwd: string(r.cwd, "cwd"), ...(typeof r.branch === "string" ? { branch: r.branch } : {}), timeZone: TIME_ZONE, weekdays: weekdays(r.weekdays), timeHHmm, promptText: string(r.promptText, "promptText"), ...(isClaudeSessionId(r.claudeSessionId) ? { claudeSessionId: r.claudeSessionId } : {}), createdAt: r.createdAt, updatedAt: r.updatedAt, events: r.events.map(event) }; }

export class RoutineStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.file = path.join(dataDir, ROUTINES_FILE); }
  private serial<T>(f: () => Promise<T>): Promise<T> { const run = this.queue.then(f, f); this.queue = run.catch(() => undefined); return run; }
  private async read(): Promise<Routine[]> { try { const p = object(JSON.parse(await readFile(this.file, "utf8"))); if (p.version !== VERSION || !Array.isArray(p.items)) throw new Error("routines.json: unsupported format"); return p.items.map(parse); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return []; throw err; } }
  list(): Promise<Routine[]> { return this.serial(() => this.read()); }
  save(items: readonly Routine[]): Promise<void> { return this.serial(async () => { await this.read(); await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE }); const tmp = `${this.file}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify({ version: VERSION, items }, null, 2)}\n`, { mode: MODE }); await chmod(tmp, MODE); await rename(tmp, this.file); }); }
}

export function jstSlot(now: Date): { weekday: number; timeHHmm: string; key: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, timeHHmm: `${parts.hour}:${parts.minute}`, key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}+09:00` };
}

export class RoutineService {
  private routines: Routine[] = [];
  private readonly live = new Map<string, string>();
  private readonly evaluated = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly config: Config, private readonly sessions: SessionManager, private readonly hub: Hub, private readonly store: RoutineStore, private readonly now: () => Date = () => new Date()) {}
  async start(): Promise<void> { this.routines = await this.store.list(); await this.restore(); this.sessions.onChange(() => void this.captureClaudeIds()); this.timer = setInterval(() => void this.tick().catch((e) => console.error("routines: tick failed:", e)), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  list(): Routine[] { return this.routines; }
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
  async create(input: RoutineInput): Promise<Routine> { const x = await this.validate(input); const now = Date.now(); const routine: Routine = { id: randomUUID(), ...x, timeZone: TIME_ZONE, createdAt: now, updatedAt: now, events: [] }; const session = this.createSession(routine); try { await this.store.save([...this.routines, routine]); } catch (e) { await this.sessions.close(session.id).catch(() => undefined); throw e; } this.live.set(routine.id, session.id); this.routines = [...this.routines, routine]; return routine; }
  async update(id: string, input: RoutineInput): Promise<Routine> { const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); const x = await this.validate(input); const old = this.routines[at]; if (x.roleId !== old.roleId || x.cwd !== old.cwd || (x.branch ?? null) !== (old.branch ?? null)) throw new SessionInputError("routine role, cwd and branch cannot be changed"); const next: Routine = { ...old, ...x, timeZone: TIME_ZONE, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }
  async setEnabled(id: string, enabled: unknown): Promise<Routine> { if (typeof enabled !== "boolean") throw new SessionInputError("enabled required"); const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); const next = { ...this.routines[at], enabled, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }
  private createSession(r: Routine) { const role = this.config.roles.find((x) => x.id === r.roleId); if (!role) throw new SessionInputError("unknown role"); return this.sessions.restore({ role, name: r.name, cwd: r.cwd, branch: r.branch ?? null, claudeSessionId: r.claudeSessionId, routineId: r.id }); }
  private async restore(): Promise<void> { for (const r of this.routines) { try { const s = this.createSession(r); this.live.set(r.id, s.id); } catch (e) { console.error("routines: restore failed:", e instanceof Error ? e.message : e); } } }
  private async captureClaudeIds(): Promise<void> { let changed = false; const next = this.routines.map((r) => { const s = this.live.get(r.id); const sid = s ? this.sessions.get(s)?.claudeSessionId : undefined; if (sid !== undefined && sid !== r.claudeSessionId) { changed = true; return { ...r, claudeSessionId: sid, updatedAt: Date.now() }; } return r; }); if (changed) { this.routines = next; await this.persist(); } }
  async tick(): Promise<void> { const slot = jstSlot(this.now()); for (const r of this.routines) { const key = `${r.id}:${slot.key}`; if (!r.enabled || !r.weekdays.includes(slot.weekday) || r.timeHHmm !== slot.timeHHmm || this.evaluated.has(key)) continue; this.evaluated.add(key); if (this.evaluated.size > MAX_EVALUATED) this.evaluated.delete(this.evaluated.values().next().value as string); await this.dispatch(r, slot.key); } }
  private async dispatch(routine: Routine, slot: string): Promise<void> { let outcome: RoutineEvent["outcome"] = "failed"; try { const id = this.live.get(routine.id); const session = id ? this.sessions.get(id) : undefined; if (!session || !id) outcome = "missing"; else { const verdict = await this.hub.checkInput(id); if (verdict.ok && !verdict.hasClaude) outcome = "missing"; else if (verdict.ok) { this.sessions.write(session, `${routine.promptText}\r`); outcome = "sent"; } else if (verdict.reason?.includes("waiting")) outcome = "waiting"; else if (verdict.reason?.includes("busy")) outcome = "busy"; else if (verdict.reason?.includes("stopped")) outcome = "stopped"; else if (verdict.reason?.includes("unknown")) outcome = "unknown"; else if (verdict.reason?.includes("not found")) outcome = "missing"; else outcome = "failed"; } } catch { outcome = "failed"; }
    const event: RoutineEvent = { at: this.now().getTime(), slot, outcome }; this.routines = this.routines.map((r) => r.id === routine.id ? { ...r, events: [...r.events, event].slice(-MAX_EVENTS), updatedAt: Date.now() } : r); await this.persist();
  }
}
