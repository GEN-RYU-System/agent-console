import type { ChatItem, SessionState } from "../../types";

/** 画面に持つ会話の件数の上限（サーバーは 1 セッション 200 件。余裕を見て、続きを足し続けても増え過ぎないようにする） */
export const CHAT_CLIENT_KEEP = 400;
/** 一番下からこれ以内の距離（px）にいるなら「一番下を読んでいる」とみなす */
export const STICK_THRESHOLD_PX = 24;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** 新しいものが来たときに一番下まで動かすか。上を読んでいるとき（一番下から離れているとき）は動かさない */
export function shouldStickToBottom(m: ScrollMetrics, thresholdPx: number = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= thresholdPx;
}

/** 来た会話を足した新しい配列。reset なら来たものだけ。seq が同じものは二重にせず、ts の順（同じ ts は seq の順）に並べ、多過ぎれば古いものから落とす */
export function mergeChat(prev: readonly ChatItem[], incoming: readonly ChatItem[], reset: boolean): ChatItem[] {
  const bySeq = new Map<number, ChatItem>();
  for (const item of reset ? [] : prev) bySeq.set(item.seq, item);
  for (const item of incoming) bySeq.set(item.seq, item);
  const sorted = [...bySeq.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return sorted.slice(-CHAT_CLIENT_KEEP);
}

/** 送れない（予約も作れない）のは、停止中だけ。ほかの状態は予約になる */
export const isSendBlocked = (state: SessionState): boolean => state === "stopped";

const NOTICE_KEY: Partial<Record<SessionState, string>> = {
  working: "ac.chat.queue.notice.working",
  waiting: "ac.chat.waitingInTerminal",
  stopped: "ac.chat.blocked.stopped",
  unknown: "ac.chat.queue.notice.unknown",
};

/** 入力欄の上の案内の文言のキー。すぐ届く状態（canInput）なら null。サーバーの判定（canInput）をそのまま使い、画面では作り直さない */
export function queueNoticeKey(state: SessionState, canInput: boolean): string | null {
  if (canInput) return null;
  return NOTICE_KEY[state] ?? "ac.chat.queue.notice.other";
}

export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** Enter で送り、Shift+Enter は改行。日本語の変換中（isComposing、または keyCode 229）の Enter では送らない */
export function isSendKey(e: SendKeyEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}
