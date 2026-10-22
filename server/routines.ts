import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { createSerial, readJsonFile, writeJsonAtomic } from "./json-store.ts";
import { CONTROL, launchAndSend, NAME_POLL_MS, NAME_TIMEOUT_MS, READY_POLL_MS, READY_TIMEOUT_MS, validateLaunchTarget, validateLaunchText, type LaunchOutcome, type LaunchTiming } from "./launch.ts";
import { SessionInputError, type SessionManager } from "./sessions.ts";
import type { RoutineCloser } from "./routine-closer.ts";
import { PassThroughGate, type ScheduleGate } from "./schedule-gate.ts";

export const ROUTINES_FILE = "routines.json";
const VERSION = 2;
const READ_VERSIONS: readonly number[] = [1, 2];
const TIME_ZONE = "Asia/Tokyo";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_EVENTS = 100;
/** AI（ac-routine）が作った定期実行のうち、同時に有効にできる件数（AI が作った定期実行の分。予約の AI 分は v0.43.0 で20件にしたが、定期実行は10件のまま） */
export const AGENT_ENABLED_LIMIT = 10;
/** 理由（reason）の最大字数。予約の measureNote と同じ規則（reservations.ts は触らないので値だけ同じ定数を持つ） */
export const MAX_REASON = 200;
/** 再起動で見張りに戻すのは、送ってから24時間以内のものだけ */
export const RETRACK_MAX_AGE_MS = 24 * 60 * 60_000;

/** AI 分の有効が上限に達している。入力の不備ではなく上限の判断なので、監査に残す側が見分ける（http.ts は SessionInputError として 400 にする） */
export class RoutineLimitError extends SessionInputError {}

/** reason の検査（1〜200字・制御文字なし）。通ったらそのまま返す */
export function validateReason(x: unknown): string {
  if (typeof x !== "string" || x.trim().length < 1 || x.length > MAX_REASON || CONTROL.test(x)) throw new SessionInputError("routine reason invalid");
  return x;
}

export type RoutineOutcome = LaunchOutcome;
/** version 1 の履歴を表示するためだけに読み込みを許す古い結果 */
type LegacyOutcome = "busy" | "waiting" | "unknown" | "stopped" | "missing";
/** 自動クローズ（closeWhenIdle）が履歴に足す結果。closed = 閉じた、kept = 閉じずに残した */
type CloseOutcome = "closed" | "kept";
const OUTCOMES = new Set<string>(["sent", "not_ready", "full", "cwd_invalid", "failed", "busy", "waiting", "unknown", "stopped", "missing", "closed", "kept"]);
export type RoutineEvent = { at: number; slot: string; outcome: RoutineOutcome | LegacyOutcome | CloseOutcome; sessionName?: string; sessionId?: string; summary?: string };
export interface Routine { id: string; name: string; enabled: boolean; roleId: string; cwd: string; branch?: string; timeZone: typeof TIME_ZONE; weekdays: number[]; timeHHmm: string; promptText: string; closeWhenIdle?: boolean; lastSlot?: string; createdAt: number; updatedAt: number; events: RoutineEvent[]; createdBy?: "agent"; }
export type RoutineTiming = LaunchTiming;
/** cwd は省ける（本店で動く役割のとき、validateLaunchTarget が本店にする）。保存される Routine の cwd は必須のまま */
export type RoutineInput = Pick<Routine, "name" | "enabled" | "roleId" | "weekdays" | "timeHHmm" | "promptText"> & { cwd?: string; branch?: string; closeWhenIdle?: boolean };

const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("routines.json: object required"); return x as Record<string, unknown>; };
const string = (x: unknown, what: string): string => { if (typeof x !== "string" || x.trim() === "") throw new Error(`routines.json: ${what} required`); return x; };
function weekdays(x: unknown): number[] { if (!Array.isArray(x) || x.some((n) => !Number.isInteger(n) || n < 0 || n > 6) || new Set(x).size !== x.length) throw new Error("routines.json: weekdays invalid"); return [...x].sort(); }
function event(x: unknown): RoutineEvent { const r = object(x); if (typeof r.at !== "number" || typeof r.slot !== "string" || typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) throw new Error("routines.json: event invalid"); return { at: r.at, slot: r.slot, outcome: r.outcome as RoutineEvent["outcome"], ...(typeof r.sessionName === "string" ? { sessionName: r.sessionName } : {}), ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}), ...(typeof r.summary === "string" ? { summary: r.summary } : {}) }; }
function parse(raw: unknown): Routine { const r = object(raw); const timeHHmm = string(r.timeHHmm, "timeHHmm"); if (!TIME.test(timeHHmm) || r.timeZone !== TIME_ZONE || typeof r.enabled !== "boolean" || typeof r.createdAt !== "number" || typeof r.updatedAt !== "number" || !Array.isArray(r.events)) throw new Error("routines.json: routine invalid"); return { id: string(r.id, "id"), name: string(r.name, "name"), enabled: r.enabled, roleId: string(r.roleId, "roleId"), cwd: string(r.cwd, "cwd"), ...(typeof r.branch === "string" ? { branch: r.branch } : {}), timeZone: TIME_ZONE, weekdays: weekdays(r.weekdays), timeHHmm, promptText: string(r.promptText, "promptText"), ...(r.closeWhenIdle === true ? { closeWhenIdle: true } : {}), ...(typeof r.lastSlot === "string" ? { lastSlot: r.lastSlot } : {}), createdAt: r.createdAt, updatedAt: r.updatedAt, events: r.events.map(event), ...(r.createdBy === "agent" ? { createdBy: "agent" as const } : {}) }; }

export class RoutineStore {
  private readonly file: string;
  private readonly serial = createSerial();
  constructor(dataDir: string) { this.file = path.join(dataDir, ROUTINES_FILE); }
  private async read(): Promise<Routine[]> { const p = await readJsonFile(this.file); if (p === undefined) return []; const o = object(p); if (typeof o.version !== "number" || !READ_VERSIONS.includes(o.version) || !Array.isArray(o.items)) throw new Error("routines.json: unsupported format"); return o.items.map(parse); }
  list(): Promise<Routine[]> { return this.serial(() => this.read()); }
  save(items: readonly Routine[]): Promise<void> { return this.serial(async () => { await this.read(); await writeJsonAtomic(this.file, { version: VERSION, items }); }); }
}

export function jstSlot(now: Date): { weekday: number; timeHHmm: string; key: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, timeHHmm: `${parts.hour}:${parts.minute}`, key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}+09:00` };
}

export class RoutineService {
  private routines: Routine[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly config: Config, private readonly sessions: SessionManager, private readonly hub: Hub, private readonly store: RoutineStore, private readonly now: () => Date = () => new Date(), private readonly timing: RoutineTiming = { pollMs: READY_POLL_MS, timeoutMs: READY_TIMEOUT_MS, namePollMs: NAME_POLL_MS, nameTimeoutMs: NAME_TIMEOUT_MS }, gate?: ScheduleGate) { this.gate = gate ?? new PassThroughGate(); }
  /** 予約と定期実行の作成・変更を並べる関門（設計 discord-pdca §4-3）。gate.run → exclusive → 本体の順 */
  private readonly gate: ScheduleGate;
  async start(): Promise<void> { this.routines = await this.store.list(); this.timer = setInterval(() => void this.tick().catch((e) => console.error("routines: tick failed:", e)), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  list(): Routine[] { return this.routines; }
  private closer: RoutineCloser | null = null;
  /** 自動クローズ（closeWhenIdle）の見張りをつなぐ。sent になった実行を渡す */
  setCloser(closer: RoutineCloser): void { this.closer = closer; }
  /** 再起動のあと、送信済みで閉じていないセッションを自動クローズの見張りに戻す。戻したものの名前（無ければ sessionId）を返す */
  retrack(now: number = this.now().getTime()): string[] {
    if (this.closer === null) return [];
    const names: string[] = [];
    for (const r of this.routines) {
      if (r.closeWhenIdle !== true) continue;
      const latest = new Map<string, RoutineEvent>();
      for (const e of r.events) if (e.sessionId !== undefined) latest.set(e.sessionId, e);
      for (const [sessionId, e] of latest) {
        if (e.outcome !== "sent" || now - e.at > RETRACK_MAX_AGE_MS) continue;
        this.closer.track({ routineId: r.id, ...(r.createdBy === "agent" ? { createdBy: "agent" as const } : {}), slot: e.slot, sessionId, ...(e.sessionName !== undefined ? { sessionName: e.sessionName } : {}), sentAt: e.at });
        names.push(e.sessionName ?? sessionId);
      }
    }
    return names;
  }
  /** 自動クローズの結果（closed / kept）を履歴に足す */
  async recordClose(routineId: string, event: { outcome: CloseOutcome; slot: string; sessionName?: string; sessionId: string; summary?: string }): Promise<void> {
    if (!this.routines.some((r) => r.id === routineId)) return;
    const e: RoutineEvent = { at: this.now().getTime(), ...event };
    this.routines = this.routines.map((r) => r.id === routineId ? { ...r, events: [...r.events, e].slice(-MAX_EVENTS), updatedAt: Date.now() } : r);
    try { await this.persist(); } catch (err) { console.error("routines: close event save failed:", err instanceof Error ? err.message : err); }
  }
  /** 動いている実行がすべて終わるまで待つ（試験用） */
  async settled(): Promise<void> { while (this.inflight.size > 0) await Promise.all([...this.inflight]); }
  private async persist(): Promise<void> { await this.store.save(this.routines); }
  private async validate(input: RoutineInput): Promise<RoutineInput & { cwd: string }> {
    const text = validateLaunchText(input, "routine");
    if (!TIME.test(input.timeHHmm)) throw new SessionInputError("routine time invalid"); weekdays(input.weekdays);
    const target = await validateLaunchTarget(this.config, input, "routine");
    const { createdBy: _createdBy, closeWhenIdle, ...known } = input as RoutineInput & { createdBy?: unknown };
    if (closeWhenIdle !== undefined && typeof closeWhenIdle !== "boolean") throw new SessionInputError("routine closeWhenIdle invalid");
    return { ...known, ...(closeWhenIdle === true ? { closeWhenIdle: true } : {}), name: text.name, cwd: target.cwd, weekdays: [...input.weekdays].sort() };
  }
  private agentLock: Promise<unknown> = Promise.resolve();
  /** AI の操作だけは1件ずつ順に行う（上限の検査と保存の間に別の AI の操作が入って11件になるのを防ぐ） */
  private exclusive<T>(agent: boolean, fn: () => Promise<T>): Promise<T> {
    if (!agent) return fn();
    const run = this.agentLock.then(fn, fn);
    this.agentLock = run.catch(() => undefined);
    return run;
  }
  private agentEnabledCount(exceptId?: string): number { return this.routines.filter((r) => r.enabled && r.createdBy === "agent" && r.id !== exceptId).length; }
  private assertAgentRoom(exceptId?: string): void { if (this.agentEnabledCount(exceptId) >= AGENT_ENABLED_LIMIT) throw new RoutineLimitError("too many enabled agent routines"); }
  /** createdBy は ac-routine（AI 用の受け口）からの作成だけが "agent" を渡す。画面用の入口（http.ts）は渡さない */
  create(input: RoutineInput, createdBy?: "agent"): Promise<Routine> { return this.gate.run(() => this.exclusive(createdBy === "agent", async () => { const x = await this.validate(input); if (createdBy === "agent") { this.assertAgentRoom(); if (x.enabled) this.gate.checkRoutine({ name: x.name, weekdays: x.weekdays, timeHHmm: x.timeHHmm }, Date.now()); } const now = Date.now(); const routine: Routine = { id: randomUUID(), ...x, timeZone: TIME_ZONE, createdAt: now, updatedAt: now, events: [], ...(createdBy === "agent" ? { createdBy } : {}) }; await this.store.save([...this.routines, routine]); this.routines = [...this.routines, routine]; return routine; })); }
  /** agent: AI 用の受け口からの呼び出し。AI 分の有効の上限を見る（画面からは見ない） */
  update(id: string, input: RoutineInput, agent = false): Promise<Routine> { return this.gate.run(() => this.exclusive(agent, () => this.updateNow(id, input, agent))); }
  private async updateNow(id: string, input: RoutineInput, agent: boolean): Promise<Routine> { const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); const x = await this.validate(input); const old = this.routines[at]; if (x.roleId !== old.roleId || x.cwd !== old.cwd || (x.branch ?? null) !== (old.branch ?? null)) throw new SessionInputError("routine role, cwd and branch cannot be changed"); if (agent && old.createdBy === "agent" && x.enabled) this.assertAgentRoom(id); if (agent && x.enabled) this.gate.checkRoutine({ id, name: x.name, weekdays: x.weekdays, timeHHmm: x.timeHHmm }, Date.now()); const { closeWhenIdle: _prevClose, ...oldRest } = old; const next: Routine = { ...oldRest, ...x, timeZone: TIME_ZONE, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }
  setEnabled(id: string, enabled: unknown, agent = false): Promise<Routine> { return this.gate.run(() => this.exclusive(agent, () => this.setEnabledNow(id, enabled, agent))); }
  private async setEnabledNow(id: string, enabled: unknown, agent: boolean): Promise<Routine> { if (typeof enabled !== "boolean") throw new SessionInputError("enabled required"); const at = this.routines.findIndex((r) => r.id === id); if (at < 0) throw new SessionInputError("routine not found"); if (agent && enabled && this.routines[at].createdBy === "agent") this.assertAgentRoom(id); if (agent && enabled) { const cur = this.routines[at]; this.gate.checkRoutine({ id, name: cur.name, weekdays: cur.weekdays, timeHHmm: cur.timeHHmm }, Date.now()); } const next = { ...this.routines[at], enabled, updatedAt: Date.now() }; this.routines = this.routines.map((r, i) => i === at ? next : r); await this.persist(); return next; }

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
    let outcome: RoutineOutcome = "failed"; let sessionName: string | undefined; let sessionId: string | undefined;
    try { ({ outcome, sessionName, sessionId } = await this.open(routine, slot)); } catch (e) { console.error("routines: dispatch failed:", e instanceof Error ? e.message : e); }
    const event: RoutineEvent = { at: this.now().getTime(), slot, outcome, ...(sessionName !== undefined ? { sessionName } : {}), ...(sessionId !== undefined ? { sessionId } : {}) };
    this.routines = this.routines.map((r) => r.id === routine.id ? { ...r, events: [...r.events, event].slice(-MAX_EVENTS), updatedAt: Date.now() } : r);
    try { await this.persist(); } catch (e) { console.error("routines: event save failed:", e instanceof Error ? e.message : e); }
    // 指示を送れた実行だけ、自動クローズの見張りに渡す（送ったあとから数える）
    if (outcome === "sent" && routine.closeWhenIdle === true && sessionId !== undefined && this.closer !== null) this.closer.track({ routineId: routine.id, ...(routine.createdBy === "agent" ? { createdBy: "agent" as const } : {}), slot, sessionId, ...(sessionName !== undefined ? { sessionName } : {}), sentAt: this.now().getTime() });
  }

  private open(routine: Routine, slot: string): Promise<{ outcome: RoutineOutcome; sessionName?: string; sessionId?: string }> {
    return launchAndSend({ config: this.config, sessions: this.sessions, hub: this.hub, timing: this.timing }, { roleId: routine.roleId, name: routine.name, slotKey: slot, cwd: routine.cwd, ...(routine.branch !== undefined ? { branch: routine.branch } : {}), promptText: routine.promptText, stillWanted: () => this.routines.find((r) => r.id === routine.id)?.enabled === true });
  }
}
