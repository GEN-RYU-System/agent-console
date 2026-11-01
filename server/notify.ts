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

const STATE_LABEL: Record<"waiting" | "idle", string> = { waiting: "回答待ち", idle: "指示待ち" };

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

/** 未読用の観測の種類。status が "waiting" か waitingFor があれば "waiting"（待ち）、それ以外は status そのもの */
function obsKind(status: AgentStatus, waitingFor: string | undefined): AgentStatus {
  return status === "waiting" || (waitingFor !== undefined && waitingFor !== "") ? "waiting" : status;
}

/** 返事の終わりの記録（Stop / StopFailure）。ts は hook が書いた時刻 */
export interface TurnEnd {
  ts: number;
  stopHookActive: boolean;
  failed: boolean;
}

type OpenWait = "none" | "stop" | "obs";

/** 窓ごとの未読の状態（design.md §4-1）。メモリだけ */
interface WindowState {
  unread: number;
  lastClearAt: number;
  hookSeen: boolean;
  open: OpenWait;
  prevObs: AgentStatus | undefined;
  lastTurnEndTs: number;
}

const newWindow = (): WindowState => ({ unread: 0, lastClearAt: 0, hookSeen: false, open: "none", prevObs: undefined, lastTurnEndTs: 0 });

/**
 * セッションごとの前回の status と未読数をメモリに持つ（保存しない）。
 * 通知の判定（isBreak）と未読の数え方（R1〜R5）は別。初回観測・取得失敗・Claude が見つからない間は何も通知しない。
 */
export class BreakTracker {
  private readonly last = new Map<string, AgentStatus>();
  private readonly windows = new Map<string, WindowState>();

  private win(id: string): WindowState {
    let w = this.windows.get(id);
    if (w === undefined) {
      w = newWindow();
      this.windows.set(id, w);
    }
    return w;
  }

  /**
   * status は Claude が見つからないとき null。通知用に区切り（busy → waiting / idle）なら true を返す（waitingFor は通知に使わない）。
   * 同じ呼び出しで未読の R2〜R5 を当てる。
   */
  observe(sessionId: string, status: AgentStatus | null, waitingFor?: string): boolean {
    const w = this.win(sessionId);
    if (status === null) {
      this.last.delete(sessionId);
      w.prevObs = undefined;
      return false;
    }
    const prev = this.last.get(sessionId);
    this.last.set(sessionId, status);
    const kind = obsKind(status, waitingFor);
    // R2 待ちに入った観測
    if (kind === "waiting" && w.prevObs !== "waiting" && w.open === "none") {
      w.unread += 1;
      w.open = "obs";
    }
    // R3 返事の終わりの観測（返事の終わりの記録を受けたことのない窓の予備）
    if (w.prevObs === "busy" && kind === "idle" && !w.hookSeen && w.open === "none") {
      w.unread += 1;
      w.open = "obs";
    }
    // R4 仕事の観測
    if (kind === "busy") w.open = "none";
    // R5
    w.prevObs = kind;
    return isBreak(prev, status);
  }

  /**
   * R1 返事の終わりの記録（結べた窓に対して）。受けたら true（未読を足したかではなく、受けたか）。
   * ts の古さ（startedAt）と（会話番号, ts）の重なりは ActivityStore が見る。now は呼び出し側の時計（この判定では使わない）。
   */
  addTurnEnd(sessionId: string, e: TurnEnd, _now: number): boolean {
    const w = this.win(sessionId);
    const prevTurnEnd = w.lastTurnEndTs;
    w.lastTurnEndTs = Math.max(w.lastTurnEndTs, e.ts);
    if (e.stopHookActive && !(w.lastClearAt > prevTurnEnd)) return false;
    if (!(e.ts > w.lastClearAt)) return false;
    w.hookSeen = true;
    if (w.open === "none") w.unread += 1;
    w.open = "stop";
    return true;
  }

  unreadOf(sessionId: string): number {
    return this.windows.get(sessionId)?.unread ?? 0;
  }

  /** PO が送ったとき（design §4-2）。未読の数が変わったら true。 */
  clear(sessionId: string, now: number): boolean {
    const w = this.windows.get(sessionId);
    if (w === undefined) {
      this.win(sessionId).lastClearAt = now;
      return false;
    }
    const changed = w.unread !== 0;
    w.unread = 0;
    w.lastClearAt = now;
    w.open = "none";
    w.prevObs = undefined;
    return changed;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
    this.windows.delete(sessionId);
  }
}
