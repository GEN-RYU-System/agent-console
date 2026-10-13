import type { UsageWindow } from "../../types";

/** 注意の度合い（設計 §10-1）。80% 以上で注意、95% 以上でほぼ上限、100% 以上で上限（棒は出さない） */
export const USAGE_WARN_PERCENT = 80;
export const USAGE_DANGER_PERCENT = 95;
export const USAGE_FULL_PERCENT = 100;
export const USAGE_REFRESH_MS = 60000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;

export type UsageLevel = "normal" | "warning" | "danger" | "full";

/** 画面に出す「N%」と同じく、四捨五入した値で境目を判定する */
export function usageLevel(usedPercentage: number): UsageLevel {
  const pct = Math.round(usedPercentage);
  if (pct >= USAGE_FULL_PERCENT) return "full";
  if (pct >= USAGE_DANGER_PERCENT) return "danger";
  if (pct >= USAGE_WARN_PERCENT) return "warning";
  return "normal";
}

/** 窓のリセット時刻を過ぎているか（過ぎた窓の値は古い） */
export const isWindowReset = (w: UsageWindow, nowMs: number): boolean => w.resetsAt * MS_PER_SECOND <= nowMs;

/** 書かれてから何分か（未来の時刻は 0 分） */
export const minutesSince = (observedAt: number, nowMs: number): number => Math.max(0, Math.floor((nowMs - observedAt) / MS_PER_MINUTE));

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 「M月D日 H:mm」の部品（ブラウザのローカル時刻） */
export function resetParts(resetsAt: number): { month: number; day: number; time: string } {
  const d = new Date(resetsAt * MS_PER_SECOND);
  return { month: d.getMonth() + 1, day: d.getDate(), time: `${d.getHours()}:${pad2(d.getMinutes())}` };
}
