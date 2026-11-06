import type { CalendarViewEvent } from "@sa/components/CalendarView";
import type { ScheduleItem, ScheduleSide } from "../../types";

export type ScheduleViewKind = "day" | "week" | "month";
export interface ViewRange { first: string; from: string; to: string; dayCount: number }

const TIME_ZONE = "Asia/Tokyo";
const DAY_MS = 86_400_000;
const DEFAULT_MINUTES = 30;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const parseDate = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fmtDate(parseDate(date) + days * DAY_MS);
}

export function firstOfMonth(date: string, months = 0): string {
  const d = new Date(parseDate(date));
  return fmtDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

export function jstToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const mondayOf = (date: string): string => {
  const wd = new Date(parseDate(date)).getUTCDay();
  return addDays(date, -((wd + 6) % 7));
};

export function viewRange(view: ScheduleViewKind, anchor: string): ViewRange {
  if (view === "day") return { first: anchor, from: anchor, to: addDays(anchor, 1), dayCount: 2 };
  if (view === "week") { const first = mondayOf(anchor); return { first, from: first, to: addDays(first, 6), dayCount: 7 }; }
  const first = firstOfMonth(anchor);
  const from = mondayOf(first);
  const last = addDays(firstOfMonth(anchor, 1), -1);
  const to = addDays(mondayOf(last), 6);
  return { first, from, to, dayCount: (parseDate(to) - parseDate(from)) / DAY_MS + 1 };
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

interface Span { item: ScheduleItem; start: number; end: number }

export function findOverlaps(items: readonly ScheduleItem[]): { pairs: Array<[ScheduleItem, ScheduleItem]>; ids: Set<string> } {
  const spans: Span[] = items
    .filter((i) => i.status === "open" && i.date !== undefined && i.start !== undefined)
    .map((i) => { const start = minutesOf(i.start as string); return { item: i, start, end: i.end !== undefined ? minutesOf(i.end) : start + DEFAULT_MINUTES }; });
  const pairs: Array<[ScheduleItem, ScheduleItem]> = [];
  const ids = new Set<string>();
  for (let a = 0; a < spans.length; a += 1) {
    for (let b = a + 1; b < spans.length; b += 1) {
      const x = spans[a]; const y = spans[b];
      if (x.item.date !== y.item.date) continue;
      if (x.start < y.end && y.start < x.end) { pairs.push([x.item, y.item]); ids.add(x.item.id); ids.add(y.item.id); }
    }
  }
  return { pairs, ids };
}

const TONES = { todo: "personal", waiting: "shipping", deadline: "billing" } as const;

export function toCalendarEvents(items: readonly ScheduleItem[], side: ScheduleSide, overlapIds: ReadonlySet<string>): CalendarViewEvent[] {
  const events: CalendarViewEvent[] = [];
  for (const i of items) {
    if (i.side !== side || i.date === undefined || i.start === undefined) continue;
    const endMin = i.end !== undefined ? minutesOf(i.end) : minutesOf(i.start) + DEFAULT_MINUTES;
    const endDate = endMin >= 24 * 60 ? addDays(i.date, 1) : i.date;
    const e = endMin % (24 * 60);
    events.push({
      id: i.id, title: i.title, start: `${i.date}T${i.start}:00`, end: `${endDate}T${pad2(Math.floor(e / 60))}:${pad2(e % 60)}:00`,
      tone: i.status === "done" ? "holiday" : TONES[i.kind], ...(overlapIds.has(i.id) ? { conflict: true } : {}),
    });
  }
  return events;
}
