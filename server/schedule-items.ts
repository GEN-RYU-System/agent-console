import { randomBytes } from "node:crypto";
import path from "node:path";
import { createSerial, readJsonFile, writeJsonAtomic } from "./json-store.ts";
import { jstSlot } from "./routines.ts";
import { SessionInputError, SessionNotFoundError } from "./sessions.ts";

export const SCHEDULE_FILE = "schedule.json";
const VERSION = 1;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const JST_OFFSET_HOURS = 9;
const MAX_OPEN = 300;
const MAX_ITEMS = 1000;
const MAX_TITLE = 200;
const MAX_WAITING_ON = 100;
const MAX_NOTE = 1000;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type ScheduleSide = "dev" | "secretary";
export type ScheduleKind = "todo" | "waiting" | "deadline";
export type ScheduleStatus = "open" | "done";
export type ScheduleCreator = "ui" | "agent";
export interface ScheduleItem {
  id: string;
  side: ScheduleSide;
  kind: ScheduleKind;
  title: string;
  date?: string;
  start?: string;
  end?: string;
  waitingOn?: string;
  note?: string;
  status: ScheduleStatus;
  createdBy: ScheduleCreator;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
}

const SIDES = new Set<string>(["dev", "secretary"]);
const KINDS = new Set<string>(["todo", "waiting", "deadline"]);

const object = (x: unknown, what = "schedule.json: object required"): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error(what); return x as Record<string, unknown>; };
const str = (x: unknown, what: string): string => { if (typeof x !== "string" || x === "") throw new Error(`schedule.json: ${what} required`); return x; };
const num = (x: unknown, what: string): number => { if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`schedule.json: ${what} required`); return x; };
const optStr = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function parse(raw: unknown): ScheduleItem {
  const r = object(raw);
  if (typeof r.side !== "string" || !SIDES.has(r.side) || typeof r.kind !== "string" || !KINDS.has(r.kind)) throw new Error("schedule.json: item invalid");
  if ((r.status !== "open" && r.status !== "done") || (r.createdBy !== "ui" && r.createdBy !== "agent")) throw new Error("schedule.json: item invalid");
  const date = optStr(r.date); const start = optStr(r.start); const end = optStr(r.end); const waitingOn = optStr(r.waitingOn); const note = optStr(r.note);
  const doneAt = r.doneAt === undefined ? undefined : num(r.doneAt, "doneAt");
  return {
    id: str(r.id, "id"), side: r.side as ScheduleSide, kind: r.kind as ScheduleKind, title: str(r.title, "title"),
    ...(date !== undefined ? { date } : {}), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}),
    ...(waitingOn !== undefined ? { waitingOn } : {}), ...(note !== undefined ? { note } : {}),
    status: r.status, createdBy: r.createdBy, createdAt: num(r.createdAt, "createdAt"), updatedAt: num(r.updatedAt, "updatedAt"),
    ...(doneAt !== undefined ? { doneAt } : {}),
  };
}

export class ScheduleItemStore {
  private readonly file: string;
  private readonly serial = createSerial();
  constructor(dataDir: string) { this.file = path.join(dataDir, SCHEDULE_FILE); }
  private async read(): Promise<ScheduleItem[]> {
    const p = await readJsonFile(this.file);
    if (p === undefined) return [];
    const o = object(p);
    if (o.version !== VERSION || !Array.isArray(o.items)) throw new Error("schedule.json: unsupported format");
    return o.items.map(parse);
  }
  list(): Promise<ScheduleItem[]> { return this.serial(() => this.read()); }
  /** 書く前に read して、壊れた内容・知らない版は上書きしない */
  save(items: readonly ScheduleItem[]): Promise<void> { return this.serial(async () => { await this.read(); await writeJsonAtomic(this.file, { version: VERSION, items }); }); }
  /** 読む→直す→書く を 1 つの順番待ちの中でやる（同時の更新で失われない） */
  mutate<T>(f: (items: ScheduleItem[]) => { items: ScheduleItem[]; result: T }): Promise<T> {
    return this.serial(async () => {
      const current = await this.read();
      const out = f(current);
      await writeJsonAtomic(this.file, { version: VERSION, items: out.items });
      return out.result;
    });
  }
}

/** 日付（YYYY-MM-DD）の検査。存在しない日付は SessionInputError */
export function checkScheduleDate(x: unknown): string {
  if (typeof x !== "string" || !DATE.test(x)) throw new SessionInputError("schedule date invalid");
  const [y, m, d] = x.split("-").map(Number);
  const key = jstSlot(new Date(Date.UTC(y, m - 1, d, 12 - JST_OFFSET_HOURS, 0))).key;
  if (!key.startsWith(`${x}T`)) throw new SessionInputError("schedule date invalid");
  return x;
}

function checkTime(x: unknown): string {
  if (typeof x !== "string" || !TIME.test(x)) throw new SessionInputError("schedule time invalid");
  return x;
}

function checkText(x: unknown, what: string, min: number, max: number): string {
  if (typeof x !== "string") throw new SessionInputError(`schedule ${what} invalid`);
  const s = x.trim();
  if (s.length < min || s.length > max) throw new SessionInputError(`schedule ${what} invalid`);
  if (what !== "note" && CONTROL_CHARS.test(s)) throw new SessionInputError(`schedule ${what} invalid`);
  return s;
}

const blank = (x: unknown): boolean => x === undefined || x === null || x === "";

export interface ScheduleItemInput { side?: unknown; kind?: unknown; title?: unknown; date?: unknown; start?: unknown; end?: unknown; waitingOn?: unknown; note?: unknown }
export interface ScheduleItemPatch { title?: unknown; date?: unknown; start?: unknown; end?: unknown; note?: unknown; waitingOn?: unknown; status?: unknown }

interface Fields { title: string; date?: string; start?: string; end?: string; waitingOn?: string; note?: string }

/** 日付・時刻・メモ等の検査。kind が waiting のときだけ waitingOn を持てる */
function normalize(kind: ScheduleKind, raw: ScheduleItemInput | ScheduleItemPatch): Fields {
  const title = checkText(raw.title, "title", 1, MAX_TITLE);
  const date = blank(raw.date) ? undefined : checkScheduleDate(raw.date);
  const start = blank(raw.start) ? undefined : checkTime(raw.start);
  const end = blank(raw.end) ? undefined : checkTime(raw.end);
  if (end !== undefined && (start === undefined || end <= start)) throw new SessionInputError("schedule end invalid");
  const waitingOn = blank(raw.waitingOn) || kind !== "waiting" ? undefined : checkText(raw.waitingOn, "waitingOn", 1, MAX_WAITING_ON);
  const note = blank(raw.note) ? undefined : checkText(raw.note, "note", 1, MAX_NOTE);
  return { title, ...(date !== undefined ? { date } : {}), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}), ...(waitingOn !== undefined ? { waitingOn } : {}), ...(note !== undefined ? { note } : {}) };
}

function newId(): string {
  const bytes = randomBytes(12);
  let out = "sch_";
  for (const b of bytes) out += ID_CHARS[b % ID_CHARS.length];
  return out;
}

/** 全体が 1000 件を超えたら、終わったもの（done）を doneAt の古い順に消す。open は消さない */
function prune(items: ScheduleItem[]): ScheduleItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const removable = items.filter((i) => i.status === "done").sort((a, b) => (a.doneAt ?? a.updatedAt) - (b.doneAt ?? b.updatedAt));
  const drop = new Set(removable.slice(0, items.length - MAX_ITEMS).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}

export class ScheduleItemService {
  constructor(private readonly store: ScheduleItemStore, private readonly now: () => number = () => Date.now()) {}

  /** date が [from, to] のもの＋date の無いもの（終わったものも返す） */
  async list(from: string, to: string): Promise<ScheduleItem[]> {
    return (await this.store.list()).filter((i) => i.date === undefined || (i.date >= from && i.date <= to));
  }

  async create(input: ScheduleItemInput, createdBy: ScheduleCreator): Promise<ScheduleItem> {
    if (typeof input.side !== "string" || !SIDES.has(input.side)) throw new SessionInputError("schedule side invalid");
    if (typeof input.kind !== "string" || !KINDS.has(input.kind)) throw new SessionInputError("schedule kind invalid");
    const side = input.side as ScheduleSide;
    const kind = input.kind as ScheduleKind;
    const fields = normalize(kind, input);
    const at = this.now();
    const item: ScheduleItem = { id: newId(), side, kind, ...fields, status: "open", createdBy, createdAt: at, updatedAt: at };
    return this.store.mutate((items) => {
      if (items.filter((i) => i.status === "open").length >= MAX_OPEN) throw new SessionInputError("schedule open limit");
      return { items: prune([...items, item]), result: item };
    });
  }

  async update(id: string, patch: ScheduleItemPatch): Promise<ScheduleItem> {
    if (patch.status !== undefined && patch.status !== "open" && patch.status !== "done") throw new SessionInputError("schedule status invalid");
    return this.store.mutate((items) => {
      const cur = items.find((i) => i.id === id);
      if (!cur) throw new SessionNotFoundError("schedule item not found");
      const merged = {
        title: patch.title !== undefined ? patch.title : cur.title,
        date: patch.date !== undefined ? patch.date : cur.date,
        start: patch.start !== undefined ? patch.start : cur.start,
        end: patch.end !== undefined ? patch.end : cur.end,
        note: patch.note !== undefined ? patch.note : cur.note,
        waitingOn: patch.waitingOn !== undefined ? patch.waitingOn : cur.waitingOn,
      };
      const fields = normalize(cur.kind, merged);
      const at = this.now();
      const status = (patch.status as ScheduleStatus | undefined) ?? cur.status;
      const { doneAt: _doneAt, date: _d, start: _s, end: _e, waitingOn: _w, note: _n, ...rest } = cur;
      const next: ScheduleItem = { ...rest, ...fields, status, updatedAt: at, ...(status === "done" ? { doneAt: cur.status === "done" && cur.doneAt !== undefined ? cur.doneAt : at } : {}) };
      if (cur.status === "done" && status === "open" && items.filter((i) => i.status === "open").length >= MAX_OPEN) throw new SessionInputError("schedule open limit");
      return { items: items.map((i) => (i.id === id ? next : i)), result: next };
    });
  }

  async remove(id: string): Promise<void> {
    return this.store.mutate((items) => {
      if (!items.some((i) => i.id === id)) throw new SessionNotFoundError("schedule item not found");
      return { items: items.filter((i) => i.id !== id), result: undefined };
    });
  }
}
