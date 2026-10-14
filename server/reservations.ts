import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { createSerial, readJsonFile, writeJsonAtomic } from "./json-store.ts";
import { CONTROL, launchAndSend, READY_POLL_MS, READY_TIMEOUT_MS, validateLaunchTarget, validateLaunchText, type LaunchOutcome, type LaunchTiming } from "./launch.ts";
import { jstSlot } from "./routines.ts";
import { SessionConflictError, SessionInputError, type SessionManager } from "./sessions.ts";

export const RESERVATIONS_FILE = "reservations.json";
const VERSION = 1;
const TIME_ZONE = "Asia/Tokyo";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const LATE_THRESHOLD_MS = 60_000;
const RETRY_AFTER_SAVE_FAIL_MS = 60_000;
const JST_OFFSET_HOURS = 9;
const MAX_PENDING = 50;
const MAX_AGENT_PENDING = 10;
const MAX_ITEMS = 200;
const MAX_MEASURE_NOTE = 200;

export type ReservationStatus = "pending" | "dispatching" | "done" | "cancelled";
export type ReservationOutcome = LaunchOutcome | "interrupted";
export type ReservationCreator = "ui" | "agent";
export interface Reservation {
  id: string;
  name: string;
  roleId: string;
  cwd: string;
  branch?: string;
  /** 予定（epoch ms） */
  runAt: number;
  /** "YYYY-MM-DDTHH:mm+09:00"（表示・照合用。runAt と同じ時刻） */
  runAtJst: string;
  timeZone: typeof TIME_ZONE;
  promptText: string;
  createdBy: ReservationCreator;
  createdAt: number;
  updatedAt: number;
  status: ReservationStatus;
  startedAt?: number;
  lateMinutes?: number;
  finishedAt?: number;
  outcome?: ReservationOutcome;
  sessionName?: string;
  purpose?: "measure";
  measureNote?: string;
}

const STATUSES = new Set<string>(["pending", "dispatching", "done", "cancelled"]);
const OUTCOMES = new Set<string>(["sent", "not_ready", "full", "cwd_invalid", "failed", "interrupted"]);

const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("reservations.json: object required"); return x as Record<string, unknown>; };
const string = (x: unknown, what: string): string => { if (typeof x !== "string" || x.trim() === "") throw new Error(`reservations.json: ${what} required`); return x; };
const num = (x: unknown, what: string): number => { if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`reservations.json: ${what} required`); return x; };
const optNum = (x: unknown, what: string): number | undefined => (x === undefined ? undefined : num(x, what));

function parse(raw: unknown): Reservation {
  const r = object(raw);
  if (r.timeZone !== TIME_ZONE || typeof r.status !== "string" || !STATUSES.has(r.status) || (r.createdBy !== "ui" && r.createdBy !== "agent")) throw new Error("reservations.json: reservation invalid");
  if (r.outcome !== undefined && (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome))) throw new Error("reservations.json: outcome invalid");
  if (r.purpose !== undefined && r.purpose !== "measure") throw new Error("reservations.json: purpose invalid");
  const startedAt = optNum(r.startedAt, "startedAt");
  const lateMinutes = optNum(r.lateMinutes, "lateMinutes");
  const finishedAt = optNum(r.finishedAt, "finishedAt");
  return {
    id: string(r.id, "id"), name: string(r.name, "name"), roleId: string(r.roleId, "roleId"), cwd: string(r.cwd, "cwd"),
    ...(typeof r.branch === "string" ? { branch: r.branch } : {}),
    runAt: num(r.runAt, "runAt"), runAtJst: string(r.runAtJst, "runAtJst"), timeZone: TIME_ZONE, promptText: string(r.promptText, "promptText"),
    createdBy: r.createdBy, createdAt: num(r.createdAt, "createdAt"), updatedAt: num(r.updatedAt, "updatedAt"), status: r.status as ReservationStatus,
    ...(startedAt !== undefined ? { startedAt } : {}), ...(lateMinutes !== undefined ? { lateMinutes } : {}), ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(typeof r.outcome === "string" ? { outcome: r.outcome as ReservationOutcome } : {}),
    ...(typeof r.sessionName === "string" ? { sessionName: r.sessionName } : {}),
    ...(r.purpose === "measure" ? { purpose: "measure" as const } : {}),
    ...(typeof r.measureNote === "string" ? { measureNote: r.measureNote } : {}),
  };
}

export class ReservationStore {
  private readonly file: string;
  private readonly serial = createSerial();
  constructor(dataDir: string) { this.file = path.join(dataDir, RESERVATIONS_FILE); }
  private async read(): Promise<Reservation[]> {
    const p = await readJsonFile(this.file);
    if (p === undefined) return [];
    const o = object(p);
    if (o.version !== VERSION || !Array.isArray(o.items)) throw new Error("reservations.json: unsupported format");
    return o.items.map(parse);
  }
  list(): Promise<Reservation[]> { return this.serial(() => this.read()); }
  /** 書く前に read して、壊れた内容・知らない版は上書きしない */
  save(items: readonly Reservation[]): Promise<void> { return this.serial(async () => { await this.read(); await writeJsonAtomic(this.file, { version: VERSION, items }); }); }
}

/** 日付と時刻（日本時間）から runAt と runAtJst を作る。存在しない日付は SessionInputError */
function resolveRunAt(date: unknown, time: unknown): { runAt: number; runAtJst: string } {
  if (typeof date !== "string" || !DATE.test(date)) throw new SessionInputError("reservation date invalid");
  if (typeof time !== "string" || !TIME.test(time)) throw new SessionInputError("reservation time invalid");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const runAt = Date.UTC(y, m - 1, d, hh - JST_OFFSET_HOURS, mm);
  const key = jstSlot(new Date(runAt)).key;
  if (key !== `${date}T${time}+09:00`) throw new SessionInputError("reservation date invalid");
  return { runAt, runAtJst: key };
}

const doneAt = (r: Reservation): number => r.finishedAt ?? r.updatedAt;

/** 全体が 200 件を超えたら、終了済み（done・cancelled）を古い順に消す。pending と dispatching は消さない */
function prune(items: Reservation[]): Reservation[] {
  if (items.length <= MAX_ITEMS) return items;
  const removable = items.filter((r) => r.status === "done" || r.status === "cancelled").sort((a, b) => doneAt(a) - doneAt(b));
  const drop = new Set(removable.slice(0, items.length - MAX_ITEMS).map((r) => r.id));
  return items.filter((r) => !drop.has(r.id));
}

export class ReservationService {
  private items: Reservation[] = [];
  private readonly inflight = new Set<Promise<void>>();
  /** 送信の保存に失敗した予約を、しばらく選ばないための印（メモリだけ。ファイルには書かない） */
  private readonly notBefore = new Map<string, number>();
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** 最初の読み込み（list と interrupted 化）が終わったら成功する。create・cancel・listReady はこれを待つ */
  private readonly loaded: Promise<void>;
  private markLoaded: () => void = () => undefined;
  constructor(private readonly config: Config, private readonly sessions: SessionManager, private readonly hub: Hub, private readonly store: ReservationStore, private readonly now: () => Date = () => new Date(), private readonly timing: LaunchTiming = { pollMs: READY_POLL_MS, timeoutMs: READY_TIMEOUT_MS }, preloaded = false) {
    this.loaded = new Promise<void>((resolve) => { this.markLoaded = resolve; });
    if (preloaded) this.markLoaded(); // start を呼ばない試験用。既定は start で読み込む
  }

  /**
   * 読み込み → 送信中のまま残ったものを interrupted にする（再送しない）→ ready を待つ → 1 秒ごとの tick。
   * interrupted の保存に失敗したら tick を始めない。ready の成否は問わない。
   */
  async start(ready: Promise<unknown> = Promise.resolve()): Promise<void> {
    const loaded = await this.store.list();
    this.items = loaded;
    const at = this.now().getTime();
    if (this.items.some((r) => r.status === "dispatching")) {
      this.items = this.items.map((r) => r.status === "dispatching" ? { ...r, status: "done" as const, outcome: "interrupted" as const, finishedAt: at, updatedAt: at } : r);
      try { await this.persist(); } catch (e) { console.error("reservations: interrupted save failed, not starting the clock:", e instanceof Error ? e.message : e); this.markLoaded(); return; }
    }
    this.markLoaded();
    await ready.catch(() => undefined);
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error("reservations: tick failed:", e)), 1000);
    this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** runAt の昇順 */
  list(): Reservation[] { return [...this.items].sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt); }
  /** 動いている送信がすべて終わるまで待つ（試験用） */
  async settled(): Promise<void> { while (this.inflight.size > 0) await Promise.all([...this.inflight]); }
  private persist(): Promise<void> { return this.store.save(this.items); }

  /** 最初の読み込みが終わってから、runAt の昇順で返す（API 用） */
  async listReady(): Promise<Reservation[]> { await this.loaded; return this.list(); }

  async create(input: unknown, createdBy: ReservationCreator): Promise<Reservation> {
    await this.loaded;
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new SessionInputError("JSON object required");
    const body = input as Record<string, unknown>;
    const { runAt, runAtJst } = resolveRunAt(body.date, body.time);
    const nowMs = this.now().getTime();
    if (runAt < nowMs + MIN_LEAD_MS || runAt > nowMs + MAX_LEAD_MS) throw new SessionInputError("reservation time out of range");
    const text = validateLaunchText(body, "reservation");
    const target = await validateLaunchTarget(this.config, body, "reservation");
    let measure: Pick<Reservation, "purpose" | "measureNote"> = {};
    if (createdBy === "agent") {
      const note = body.measureNote;
      if (body.purpose !== "measure") throw new SessionInputError("reservation purpose must be measure");
      if (typeof note !== "string" || note.trim().length < 1 || note.length > MAX_MEASURE_NOTE || CONTROL.test(note)) throw new SessionInputError("reservation measureNote invalid");
      measure = { purpose: "measure", measureNote: note };
    }
    const pending = this.items.filter((r) => r.status === "pending");
    if (pending.length >= MAX_PENDING) throw new SessionInputError("too many pending reservations");
    if (createdBy === "agent" && pending.filter((r) => r.createdBy === "agent").length >= MAX_AGENT_PENDING) throw new SessionInputError("too many pending agent reservations");
    const reservation: Reservation = {
      id: randomUUID(), name: text.name, roleId: body.roleId as string, cwd: target.cwd,
      ...(typeof body.branch === "string" && body.branch !== "" ? { branch: body.branch } : {}),
      runAt, runAtJst, timeZone: TIME_ZONE, promptText: body.promptText as string, createdBy, createdAt: nowMs, updatedAt: nowMs, status: "pending", ...measure,
    };
    const before = this.items;
    this.items = prune([...this.items, reservation]);
    try { await this.persist(); } catch (e) { const dropped = before.filter((b) => !this.items.some((r) => r.id === b.id)); this.items = [...this.items.filter((r) => r.id !== reservation.id), ...dropped]; throw e; }
    return reservation;
  }

  /** pending だけ取り消せる。未知の id は 400、pending 以外は 409 */
  async cancel(id: string): Promise<Reservation> {
    await this.loaded;
    const current = this.items.find((r) => r.id === id);
    if (!current) throw new SessionInputError("reservation not found");
    if (current.status !== "pending") throw new SessionConflictError("reservation is not pending");
    const next: Reservation = { ...current, status: "cancelled", updatedAt: this.now().getTime() };
    this.items = this.items.map((r) => r.id === id ? next : r);
    try { await this.persist(); } catch (e) { this.items = this.items.map((r) => r.id === id ? current : r); throw e; }
    return next;
  }

  /** 時刻が来た予約を、runAt の古い順に 1 件だけ選んで送る。送る前に dispatching を保存する。送信は待たない。 */
  async tick(): Promise<void> {
    const at = this.now().getTime();
    if (at < this.lastStartedAt + this.config.restoreStaggerMs) return;
    const due = this.items.filter((r) => r.status === "pending" && r.runAt <= at && (this.notBefore.get(r.id) ?? 0) <= at).sort((a, b) => a.runAt - b.runAt);
    const picked = due[0];
    if (!picked) return;
    const late = at - picked.runAt > LATE_THRESHOLD_MS ? Math.floor((at - picked.runAt) / 60_000) : undefined;
    const started: Reservation = { ...picked, status: "dispatching", startedAt: at, ...(late !== undefined ? { lateMinutes: late } : {}), updatedAt: at };
    this.items = this.items.map((r) => r.id === picked.id ? started : r);
    this.lastStartedAt = at;
    try { await this.persist(); } catch (e) {
      this.items = this.items.map((r) => r.id === picked.id ? picked : r);
      this.notBefore.set(picked.id, at + RETRY_AFTER_SAVE_FAIL_MS);
      console.error("reservations: dispatching save failed, will retry later:", e instanceof Error ? e.message : e);
      return;
    }
    const run = this.dispatch(started).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  private async dispatch(reservation: Reservation): Promise<void> {
    let outcome: ReservationOutcome = "failed"; let sessionName: string | undefined;
    try {
      ({ outcome, sessionName } = await launchAndSend({ config: this.config, sessions: this.sessions, hub: this.hub, timing: this.timing }, {
        roleId: reservation.roleId, name: reservation.name, slotKey: reservation.runAtJst, cwd: reservation.cwd,
        ...(reservation.branch !== undefined ? { branch: reservation.branch } : {}), promptText: reservation.promptText,
        stillWanted: () => this.items.find((r) => r.id === reservation.id)?.status === "dispatching",
      }));
    } catch (e) { console.error("reservations: dispatch failed:", e instanceof Error ? e.message : e); }
    if (this.items.find((r) => r.id === reservation.id)?.status !== "dispatching") return;
    const at = this.now().getTime();
    this.items = prune(this.items.map((r) => r.id === reservation.id ? { ...r, status: "done" as const, outcome, finishedAt: at, updatedAt: at, ...(sessionName !== undefined ? { sessionName } : {}) } : r));
    try { await this.persist(); } catch (e) { console.error("reservations: result save failed:", e instanceof Error ? e.message : e); }
  }
}
