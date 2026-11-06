import { randomBytes } from "node:crypto";
import path from "node:path";
import { createSerial, readJsonFile, writeJsonAtomic } from "./json-store.ts";
import { jstSlot } from "./routines.ts";
import { SessionInputError, SessionNotFoundError } from "./sessions.ts";

export const SCHEDULE_FILE = "schedule.json";
const VERSION = 1;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const JST_OFFSET_HOURS = 9;
const MAX_OPEN = 300;
const MAX_ITEMS = 1000;
const MAX_TITLE = 200;
const MAX_WAITING_ON = 100;
const MAX_NOTE = 1000;
const MAX_RANGE_DAYS = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ScheduleSide = "dev" | "secretary";
export type ScheduleKind = "todo" | "waiting" | "deadline";
export type ScheduleStatus = "open" | "done";
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
  createdBy: "ui" | "agent";
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
}

const SIDES = new Set<string>(["dev", "secretary"]);
const KINDS = new Set<string>(["todo", "waiting", "deadline"]);

const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("schedule.json: object required"); return x as Record<string, unknown>; };
const num = (x: unknown, what: string): number => { if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`schedule.json: ${what} required`); return x; };
const optString = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function parse(raw: unknown): ScheduleItem {
  const r = object(raw);
  if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.side !== "string" || !SIDES.has(r.side) || typeof r.kind !== "string" || !KINDS.has(r.kind)
    || (r.status !== "open" && r.status !== "done") || (r.createdBy !== "ui" && r.createdBy !== "agent")) throw new Error("schedule.json: item invalid");
  const date = optString(r.date); const start = optString(r.start); const end = optString(r.end); const waitingOn = optString(r.waitingOn); const note = optString(r.note);
  return {
    id: r.id, side: r.side as ScheduleSide, kind: r.kind as ScheduleKind, title: r.title,
    ...(date !== undefined ? { date } : {}), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}),
    ...(waitingOn !== undefined ? { waitingOn } : {}), ...(note !== undefined ? { note } : {}),
    status: r.status, createdBy: r.createdBy, createdAt: num(r.createdAt, "createdAt"), updatedAt: num(r.updatedAt, "updatedAt"),
    ...(r.doneAt !== undefined ? { doneAt: num(r.doneAt, "doneAt") } : {}),
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
  /** 読む→変える→書くを1つずつ順に行う。fn が例外なら何も書かない */
  mutate<T>(fn: (items: ScheduleItem[]) => { items: ScheduleItem[]; result: T }): Promise<T> {
    return this.serial(async () => {
      const { items, result } = fn(await this.read());
      await writeJsonAtomic(this.file, { version: VERSION, items });
      return result;
    });
  }
}

/** "YYYY-MM-DD" が実在する日付か（日本時間で書き戻して元と同じか）。違えば SessionInputError */
export function assertScheduleDate(date: unknown, what = "schedule date"): string {
  if (typeof date !== "string" || !DATE.test(date)) throw new SessionInputError(`${what} invalid`);
  const [y, m, d] = date.split("-").map(Number);
  const back = jstSlot(new Date(Date.UTC(y, m - 1, d, -JST_OFFSET_HOURS, 0))).key.slice(0, 10);
  if (back !== date) throw new SessionInputError(`${what} invalid`);
  return date;
}

function assertTime(time: unknown, what: string): string {
  if (typeof time !== "string" || !TIME.test(time)) throw new SessionInputError(`${what} invalid`);
  return time;
}

/** 読む範囲の検査（from <= to、42日まで）。違えば SessionInputError */
export function assertScheduleRange(from: unknown, to: unknown): { from: string; to: string } {
  const f = assertScheduleDate(from, "schedule from");
  const t = assertScheduleDate(to, "schedule to");
  const days = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) throw new SessionInputError("schedule range invalid");
  return { from: f, to: t };
}

function text(x: unknown, what: string, max: number, min = 0): string {
  if (typeof x !== "string") throw new SessionInputError(`${what} invalid`);
  const v = x.trim();
  if (v.length < min || v.length > max || CONTROL_CHARS.test(v)) throw new SessionInputError(`${what} invalid`);
  return v;
}

const isBlank = (x: unknown): boolean => x === undefined || x === null || x === "";

/** 項目の中身（id・時刻の印以外）を検査して作る。patch の結果にも同じ検査を使う */
function validateBody(b: Record<string, unknown>): Pick<ScheduleItem, "side" | "kind" | "title" | "date" | "start" | "end" | "waitingOn" | "note"> {
  if (typeof b.side !== "string" || !SIDES.has(b.side)) throw new SessionInputError("schedule side invalid");
  if (typeof b.kind !== "string" || !KINDS.has(b.kind)) throw new SessionInputError("schedule kind invalid");
  const title = text(b.title, "schedule title", MAX_TITLE, 1);
  const date = isBlank(b.date) ? undefined : assertScheduleDate(b.date);
  const start = isBlank(b.start) ? undefined : assertTime(b.start, "schedule start");
  const end = isBlank(b.end) ? undefined : assertTime(b.end, "schedule end");
  if (end !== undefined && (start === undefined || end <= start)) throw new SessionInputError("schedule end invalid");
  const waitingOn = isBlank(b.waitingOn) ? undefined : text(b.waitingOn, "schedule waitingOn", MAX_WAITING_ON, 1);
  if (waitingOn !== undefined && b.kind !== "waiting") throw new SessionInputError("schedule waitingOn invalid");
  const note = isBlank(b.note) ? undefined : text(b.note, "schedule note", MAX_NOTE, 1);
  return {
    side: b.side as ScheduleSide, kind: b.kind as ScheduleKind, title,
    ...(date !== undefined ? { date } : {}), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}),
    ...(waitingOn !== undefined ? { waitingOn } : {}), ...(note !== undefined ? { note } : {}),
  };
}

const obj = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new SessionInputError("JSON object required"); return x as Record<string, unknown>; };

/** 全体が 1000 件を超えたら、終わったものを doneAt の古い順に消す。open は消さない */
function prune(items: ScheduleItem[]): ScheduleItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const removable = items.filter((i) => i.status === "done").sort((a, b) => (a.doneAt ?? a.updatedAt) - (b.doneAt ?? b.updatedAt));
  const drop = new Set(removable.slice(0, items.length - MAX_ITEMS).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}

const order = (a: ScheduleItem, b: ScheduleItem): number =>
  (a.date ?? "9999").localeCompare(b.date ?? "9999") || (a.start ?? "").localeCompare(b.start ?? "") || a.createdAt - b.createdAt;

export class ScheduleItemService {
  constructor(private readonly store: ScheduleItemStore, private readonly now: () => Date = () => new Date()) {}

  /** date が [from, to] のもの＋date の無いもの（終わったものも返す） */
  async list(from: string, to: string): Promise<ScheduleItem[]> {
    const r = assertScheduleRange(from, to);
    const items = await this.store.list();
    return items.filter((i) => i.date === undefined || (i.date >= r.from && i.date <= r.to)).sort(order);
  }

  create(input: unknown, createdBy: "ui" | "agent"): Promise<ScheduleItem> {
    const body = validateBody(obj(input));
    const at = this.now().getTime();
    const item: ScheduleItem = { id: `sch_${randomBytes(9).toString("base64url").slice(0, 12)}`, ...body, status: "open", createdBy, createdAt: at, updatedAt: at };
    return this.store.mutate((items) => {
      if (items.filter((i) => i.status === "open").length >= MAX_OPEN) throw new SessionInputError("schedule open limit");
      return { items: prune([...items, item]), result: item };
    });
  }

  update(id: string, patch: unknown): Promise<ScheduleItem> {
    const p = obj(patch);
    const fields = ["title", "date", "start", "end", "note", "waitingOn", "status"] as const;
    if (p.status !== undefined && p.status !== "open" && p.status !== "done") throw new SessionInputError("schedule status invalid");
    const at = this.now().getTime();
    return this.store.mutate((items) => {
      const cur = items.find((i) => i.id === id);
      if (!cur) throw new SessionNotFoundError("schedule item not found");
      const merged: Record<string, unknown> = { ...cur };
      for (const f of fields) if (f in p) merged[f] = p[f];
      const body = validateBody(merged);
      const status = (p.status as ScheduleStatus | undefined) ?? cur.status;
      const next: ScheduleItem = {
        id: cur.id, createdBy: cur.createdBy, createdAt: cur.createdAt, ...body, status, updatedAt: at,
        ...(status === "done" ? { doneAt: cur.status === "done" ? (cur.doneAt ?? at) : at } : {}),
      };
      return { items: items.map((i) => (i.id === id ? next : i)), result: next };
    });
  }

  remove(id: string): Promise<void> {
    return this.store.mutate((items) => {
      if (!items.some((i) => i.id === id)) throw new SessionNotFoundError("schedule item not found");
      return { items: items.filter((i) => i.id !== id), result: undefined };
    });
  }
}
