import type { CalendarViewEvent } from "@sa/components/CalendarView";
import type { ScheduleItem, ScheduleSide } from "../../types";

export type ScheduleViewMode = "day" | "week" | "month";
export interface ViewRange { first: string; from: string; to: string; dayCount: 2 | 7 }

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MINUTES = 30;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const utcOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 日本時間の今日 "YYYY-MM-DD" */
export function jstToday(now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(date: string, n: number): string { return fmt(utcOf(date) + n * DAY_MS); }

/** 月曜を 0 とした曜日 */
const mondayIndex = (date: string): number => (new Date(utcOf(date)).getUTCDay() + 6) % 7;

export function addMonths(date: string, n: number): string {
  const d = new Date(utcOf(date));
  return fmt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** 日: anchor と翌日の2列。週: anchor を含む月曜〜日曜。月: 月曜始まりの升目（最大 42 日） */
export function viewRange(view: ScheduleViewMode, anchor: string): ViewRange {
  if (view === "day") return { first: anchor, from: anchor, to: addDays(anchor, 1), dayCount: 2 };
  if (view === "week") {
    const first = addDays(anchor, -mondayIndex(anchor));
    return { first, from: first, to: addDays(first, 6), dayCount: 7 };
  }
  const first = `${anchor.slice(0, 7)}-01`;
  const from = addDays(first, -mondayIndex(first));
  const last = addDays(addMonths(first, 1), -1);
  return { first, from, to: addDays(last, 6 - mondayIndex(last)), dayCount: 7 };
}

/** 前へ（-1）・次へ（+1）。日は1日、週は7日、月は1か月 */
export function shiftAnchor(view: ScheduleViewMode, anchor: string, dir: -1 | 1): string {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return addMonths(anchor, dir);
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const endMinutes = (i: ScheduleItem): number => (i.end !== undefined ? toMinutes(i.end) : toMinutes(i.start as string) + DEFAULT_MINUTES);

export interface OverlapResult { pairs: [ScheduleItem, ScheduleItem][]; ids: Set<string> }

/** 同じ日・start のある open の項目で、[start, end) が少しでも重なる組。end 無しは 30 分。開発と秘書を合わせて数える */
export function findOverlaps(items: readonly ScheduleItem[]): OverlapResult {
  const rows = items.filter((i) => i.status === "open" && i.date !== undefined && i.start !== undefined);
  const pairs: [ScheduleItem, ScheduleItem][] = [];
  const ids = new Set<string>();
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const x = rows[a]; const y = rows[b];
      if (x.date !== y.date) continue;
      if (toMinutes(x.start as string) < endMinutes(y) && toMinutes(y.start as string) < endMinutes(x)) {
        pairs.push([x, y]);
        ids.add(x.id);
        ids.add(y.id);
      }
    }
  }
  return { pairs, ids };
}

const TONES = { todo: "personal", waiting: "shipping", deadline: "billing" } as const;

/** 選んでいる側の、date と start のある項目だけ。時差は付けない（画面の時刻としてそのまま置く） */
export function toCalendarEvents(items: readonly ScheduleItem[], side: ScheduleSide, overlapIds: ReadonlySet<string>): CalendarViewEvent[] {
  return items
    .filter((i) => i.side === side && i.date !== undefined && i.start !== undefined)
    .map((i) => {
      const date = i.date as string;
      const end = endMinutes(i);
      const endDate = end >= 24 * 60 ? addDays(date, 1) : date;
      const m = end % (24 * 60);
      return {
        id: i.id,
        title: i.title,
        start: `${date}T${i.start}:00`,
        end: `${endDate}T${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00`,
        tone: i.status === "done" ? "holiday" : TONES[i.kind],
        ...(overlapIds.has(i.id) ? { conflict: true } : {}),
      };
    });
}
