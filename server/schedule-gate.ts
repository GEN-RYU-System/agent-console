// 1時間の関門（設計 docs/handoff/discord-pdca/design.md §4-3）。予約と定期実行の作成・変更を1本の順番待ちで並べ、AI のものだけ開始の差が60分未満を拒む
import { createSerial } from "./json-store.ts";
import type { Reservation } from "./reservations.ts";
import type { Routine } from "./routines.ts";
import { SessionInputError } from "./sessions.ts";

/** 関門の拒否。http.ts の決まり（SessionInputError）で 400 になり、AI 用の受け口では監査に denied で残す */
export class ScheduleConflictError extends SessionInputError {}

const MINUTE_MS = 60_000;
const GAP_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WINDOW_MS = 366 * DAY_MS;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;
const WEEK_MINUTES = 7 * 1440;
const SEARCH_MS = DAY_MS;

export interface ScheduleSources {
  reservations: () => readonly Reservation[];
  reservationsReady: () => boolean;
  routines: () => readonly Routine[];
}

export interface RoutineCandidate { id?: string; name: string; weekdays: number[]; timeHHmm: string }

interface Point { ms: number; name: string; kind: "予約" | "定期実行" }
interface Hit { name: string; kind: "予約" | "定期実行"; otherMs: number; gap: number }

/** 日本時間（UTC+9 固定）の暦日の通し番号。曜日は (day + 4) % 7（1970-01-01 は木曜 = 4。0=日曜） */
const dayOf = (ms: number): number => Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;
const startOf = (day: number, minute: number): number => day * DAY_MS - JST_OFFSET_MS + minute * MINUTE_MS;
const minuteOfDay = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** YYYY-MM-DDTHH:mm+09:00 */
const stamp = (ms: number): string => `${new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16)}+09:00`;
const hhmm = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const nearer = (a: Hit | null, b: Hit): Hit => (a === null || b.gap < a.gap || (b.gap === a.gap && b.otherMs < a.otherMs) ? b : a);

export class ScheduleGate {
  private readonly serial = createSerial();
  private sources: ScheduleSources | null = null;

  /** 予約と定期実行の作成・変更を、この順番待ちで1つずつ動かす */
  run<T>(fn: () => Promise<T>): Promise<T> { return this.serial(fn); }

  /** 比べる相手を受け取る（配線で予約と定期実行の両方を作ったあとに1回呼ぶ） */
  attach(sources: ScheduleSources): void { this.sources = sources; }

  private ready(): ScheduleSources {
    if (this.sources === null) throw new Error("schedule gate: attach() was not called");
    if (!this.sources.reservationsReady()) throw new ScheduleConflictError("schedule conflict: 予約の一覧をまだ読めていないため確かめられません（起動直後なら数秒待って再試行。続くなら PO に報告）");
    return this.sources;
  }

  /** AI の予約の候補。ぶつかれば ScheduleConflictError */
  checkReservation(runAt: number, nowMs: number, name: string): void {
    void name;
    const s = this.ready();
    const points = this.pointsAround(s, runAt, nowMs, undefined);
    let best: Hit | null = null;
    for (const p of points) {
      const gap = Math.abs(p.ms - runAt);
      if (gap < GAP_MS) best = nearer(best, { name: p.name, kind: p.kind, otherMs: p.ms, gap });
    }
    if (best === null) return;
    const free = (x: number): boolean => points.every((p) => Math.abs(p.ms - x) >= GAP_MS);
    let prev = "なし";
    for (let x = runAt - MINUTE_MS; x >= runAt - SEARCH_MS && x >= nowMs + MINUTE_MS; x -= MINUTE_MS) if (free(x)) { prev = stamp(x); break; }
    let next = "なし";
    for (let x = runAt + MINUTE_MS; x <= runAt + SEARCH_MS && x <= nowMs + WINDOW_MS; x += MINUTE_MS) if (free(x)) { next = stamp(x); break; }
    throw this.conflict(best, prev, next);
  }

  /** AI の定期実行の候補（有効になるもの）。変更・切り替えは id で自分自身を外す */
  checkRoutine(candidate: RoutineCandidate, nowMs: number): void {
    const s = this.ready();
    const minute = minuteOfDay(candidate.timeHHmm);
    const best = this.routineHit(s, candidate, minute, nowMs);
    if (best === null) return;
    const busy = this.busyWeek(s, candidate.id, nowMs);
    const free = (m: number): boolean => candidate.weekdays.every((w) => busy[w * 1440 + m] === 0);
    let prev = "なし";
    for (let m = minute - 1; m >= 0; m--) if (free(m)) { prev = hhmm(m); break; }
    let next = "なし";
    for (let m = minute + 1; m < 1440; m++) if (free(m)) { next = hhmm(m); break; }
    throw this.conflict(best, prev, next);
  }

  private conflict(hit: Hit, prev: string, next: string): ScheduleConflictError {
    return new ScheduleConflictError(`schedule conflict: 「${hit.name}」（${hit.kind} ${stamp(hit.otherMs)}）と開始が60分未満です。空いている近い時刻: 前 ${prev} ／ 後 ${next}`);
  }

  /** 予約の候補の前後 25 時間にある相手の開始（pending の予約全部と、有効な定期実行の窓の中の開始） */
  private pointsAround(s: ScheduleSources, center: number, nowMs: number, exceptRoutineId: string | undefined): Point[] {
    const lo = center - SEARCH_MS - GAP_MS;
    const hi = center + SEARCH_MS + GAP_MS;
    const out: Point[] = [];
    for (const r of s.reservations()) if (r.status === "pending") out.push({ ms: r.runAt, name: r.name, kind: "予約" });
    for (const rt of s.routines()) {
      if (!rt.enabled || rt.id === exceptRoutineId) continue;
      const minute = minuteOfDay(rt.timeHHmm);
      for (let d = dayOf(lo); d <= dayOf(hi); d++) {
        if (!rt.weekdays.includes(weekdayOf(d))) continue;
        const at = startOf(d, minute);
        if (at >= nowMs && at <= nowMs + WINDOW_MS && at >= lo && at <= hi) out.push({ ms: at, name: rt.name, kind: "定期実行" });
      }
    }
    return out;
  }

  /** 定期実行の候補に一番近いぶつかり。候補と相手の開始は、どちらも窓 [now, now+366日] の中のものだけ */
  private routineHit(s: ScheduleSources, c: RoutineCandidate, minute: number, nowMs: number): Hit | null {
    let best: Hit | null = null;
    const inWindow = (at: number): boolean => at >= nowMs && at <= nowMs + WINDOW_MS;
    // 予約との比べ: 予約の前後の日のうち、候補の曜日に当たる日の開始
    for (const r of s.reservations()) {
      if (r.status !== "pending") continue;
      for (let d = dayOf(r.runAt) - 1; d <= dayOf(r.runAt) + 1; d++) {
        if (!c.weekdays.includes(weekdayOf(d))) continue;
        const at = startOf(d, minute);
        const gap = Math.abs(at - r.runAt);
        if (inWindow(at) && gap < GAP_MS) best = nearer(best, { name: r.name, kind: "予約", otherMs: r.runAt, gap });
      }
    }
    // 定期実行どうし: 曜日と時刻の差で見る。候補の日 d に対し相手は d-1・d・d+1 の日の開始（366日の窓には、どの曜日の組も何度も入る）
    const firstDay = dayOf(nowMs);
    for (const o of s.routines()) {
      if (!o.enabled || o.id === c.id) continue;
      const om = minuteOfDay(o.timeHHmm);
      for (let d = firstDay; d <= firstDay + 14; d++) {
        if (!c.weekdays.includes(weekdayOf(d))) continue;
        const cs = startOf(d, minute);
        if (!inWindow(cs)) continue;
        for (let k = -1; k <= 1; k++) {
          if (!o.weekdays.includes(weekdayOf(d + k))) continue;
          const os = startOf(d + k, om);
          const gap = Math.abs(os - cs);
          if (inWindow(os) && gap < GAP_MS) best = nearer(best, { name: o.name, kind: "定期実行", otherMs: os, gap });
        }
      }
    }
    return best;
  }

  /** 1週間（曜日 × 分）のうち、候補の開始が相手から60分未満になる枠を印にしたもの。近い時刻の探索用（候補1つにつき1回だけ作る） */
  private busyWeek(s: ScheduleSources, exceptRoutineId: string | undefined, nowMs: number): Uint8Array {
    const busy = new Uint8Array(WEEK_MINUTES);
    const mark = (index: number): void => { for (let j = -59; j <= 59; j++) busy[(((index + j) % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES] = 1; };
    for (const o of s.routines()) {
      if (!o.enabled || o.id === exceptRoutineId) continue;
      const om = minuteOfDay(o.timeHHmm);
      for (const w of o.weekdays) mark(w * 1440 + om);
    }
    for (const r of s.reservations()) {
      if (r.status !== "pending") continue;
      for (let d = dayOf(r.runAt) - 1; d <= dayOf(r.runAt) + 1; d++) {
        for (let m = 0; m < 1440; m++) {
          const at = startOf(d, m);
          if (Math.abs(at - r.runAt) < GAP_MS && at >= nowMs && at <= nowMs + WINDOW_MS) busy[weekdayOf(d) * 1440 + m] = 1;
        }
      }
    }
    return busy;
  }
}

/** 並べるだけで比べない関門（gate を渡されない試験・単体の組み立て用） */
export class PassThroughGate extends ScheduleGate {
  override checkReservation(): void { /* 比べない */ }
  override checkRoutine(): void { /* 比べない */ }
}
