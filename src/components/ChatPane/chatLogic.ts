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

const BLOCKED_KEY: Partial<Record<SessionState, string>> = {
  working: "ac.chat.blocked.working",
  waiting: "ac.chat.waitingInTerminal",
  stopped: "ac.chat.blocked.stopped",
  unknown: "ac.chat.blocked.unknown",
};

/** 送れない理由の文言のキー。送れる状態（canInput）なら null。サーバーの判定（canInput）をそのまま使い、画面では作り直さない */
export function blockedReasonKey(state: SessionState, canInput: boolean): string | null {
  if (canInput) return null;
  return BLOCKED_KEY[state] ?? "ac.chat.blocked.other";
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
