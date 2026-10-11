import { execFile } from "node:child_process";
import type { AgentStatus } from "./agents.ts";

const NOTIFY_TITLE = "Agent Console";
const NOTIFY_TIMEOUT_MS = 10000;
const MAX_BODY_CHARS = 120;

/** 「区切り」はアプリの定義: Claude の状態が busy から waiting / idle に変わった時点（Claude 公式の「ターン完了」ではない）。 */
export function isBreak(prev: AgentStatus | undefined, next: AgentStatus): boolean {
  return prev === "busy" && (next === "waiting" || next === "idle");
}

/** AppleScript の文字列リテラルに入れられるようにする。制御文字は空白に、`\` と `"` はエスケープする。 */
export function escapeAppleScript(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildNotificationScript(body: string): string {
  const clipped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
  return `display notification "${escapeAppleScript(clipped)}" with title "${escapeAppleScript(NOTIFY_TITLE)}"`;
}

const STATE_LABEL: Record<"waiting" | "idle", string> = { waiting: "待ち", idle: "待機" };

export function breakBody(name: string, status: "waiting" | "idle"): string {
  return `${name}: ${STATE_LABEL[status]}`;
}

export type NotificationSender = (body: string) => void;

/** osascript を execFile で呼ぶ送信関数（シェルを通さない）。失敗は握りつぶさずログに出す。 */
export function osascriptSender(osascriptBin: string): NotificationSender {
  return (body) => {
    execFile(osascriptBin, ["-e", buildNotificationScript(body)], { timeout: NOTIFY_TIMEOUT_MS }, (err) => {
      if (err) console.error("notify(osascript) failed:", err.message);
    });
  };
}

/**
 * セッションごとの前回の status と未読数をメモリに持つ（保存しない）。
 * 初回観測・取得失敗・Claude が見つからない間は何も通知しない。
 */
export class BreakTracker {
  private readonly last = new Map<string, AgentStatus>();
  private readonly unread = new Map<string, number>();

  /** status は Claude が見つからないとき null。区切りなら true を返し、未読を 1 増やす。 */
  observe(sessionId: string, status: AgentStatus | null): boolean {
    if (status === null) {
      this.last.delete(sessionId);
      return false;
    }
    const prev = this.last.get(sessionId);
    this.last.set(sessionId, status);
    if (!isBreak(prev, status)) return false;
    this.unread.set(sessionId, (this.unread.get(sessionId) ?? 0) + 1);
    return true;
  }

  unreadOf(sessionId: string): number {
    return this.unread.get(sessionId) ?? 0;
  }

  /** 既読にする。変化があれば true。 */
  markRead(sessionId: string): boolean {
    return this.unread.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
    this.unread.delete(sessionId);
  }
}
