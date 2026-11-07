// idle の数え方と、最後の返事の読み方（定期実行の自動クローズと、Discord の件の見張りで共通。動きは routine-closer のもとの式のまま）。
/** 返事にこの印があれば、人の判断待ちとして閉じずに残す */
export const DECISION_MARK = /NEEDS_DECISION:|BLOCKED:/;

/** idle の続きの数え方。前の標本も idle で、前の標本の時刻があるときだけ、その間を足す。それ以外は 0 */
export function nextIdleMs(prev: { prevAt: number | null; prevIdle: boolean; idleMs: number }, idle: boolean, at: number): number {
  return idle && prev.prevIdle && prev.prevAt !== null ? prev.idleMs + (at - prev.prevAt) : 0;
}

/** 最後の返事の判定。返事が無い・判断待ちの印がある・それ以外（閉じてよい） */
export function replyVerdict(reply: string | null): "no-reply" | "decision" | "close" {
  if (reply === null) return "no-reply";
  if (DECISION_MARK.test(reply)) return "decision";
  return "close";
}
