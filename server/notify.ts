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
  /** AI が自分で続きを始める予定があるか。true=ある、false=ない、null / 省略=欄が無かった（付ける側） */
  pendingSelfResume?: boolean | null;
}

type OpenWait = "none" | "stop" | "obs";
type Cause = "none" | "stop" | "failure" | "wait" | "obs" | "stale";

/** 予定があって付けなかった窓に、予備で印を付けるまでの時間（design §4-2 S5） */
const STALE_MS = 30 * 60 * 1000;

/** 窓ごとの未読の状態（design.md §4-1）。メモリだけ */
interface WindowState {
  /** 0 か 1 */
  unread: number;
  cause: Cause;
  markTs: number;
  lastClearAt: number;
  lastResumeAt: number;
  hookSeen: boolean;
  open: OpenWait;
  prevObs: AgentStatus | undefined;
  lastTurnEndTs: number;
  /** 予定があって付けなかった最後の Stop の ts と、それを受けた時刻 */
  deferred: { ts: number; at: number } | undefined;
}

const newWindow = (): WindowState => ({
  unread: 0,
  cause: "none",
  markTs: 0,
  lastClearAt: 0,
  lastResumeAt: 0,
  hookSeen: false,
  open: "none",
  prevObs: undefined,
  lastTurnEndTs: 0,
  deferred: undefined,
});

/** 印を付ける（design §4-2 の書き方）。failure が付いているときは理由も時刻も変えない。force は失敗の印を付けるとき */
function mark(w: WindowState, cause: Cause, value: number, force = false): void {
  if (w.unread === 1) {
    if (w.cause === "failure" && !force) return;
    w.markTs = Math.max(w.markTs, value);
    w.cause = cause;
    return;
  }
  w.unread = 1;
  w.cause = cause;
  w.markTs = value;
}

function unmark(w: WindowState): void {
  w.unread = 0;
  w.cause = "none";
}

/**
 * セッションごとの前回の status と未読の印をメモリに持つ（保存しない）。
 * 通知の判定（isBreak）と未読の決まり（design.md §4）は別。初回観測・取得失敗・Claude が見つからない間は何も通知しない。
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
   * 同じ呼び出しで未読の S3・S4 を当てる。now は印の markTs に使う（省略は Date.now()）。
   */
  observe(sessionId: string, status: AgentStatus | null, waitingFor?: string, now: number = Date.now()): boolean {
    const w = this.win(sessionId);
    if (status === null) {
      this.last.delete(sessionId);
      w.prevObs = undefined;
      return false;
    }
    const prev = this.last.get(sessionId);
    this.last.set(sessionId, status);
    const kind = obsKind(status, waitingFor);
    // S3 待ちに入った観測
    if (kind === "waiting" && w.prevObs !== "waiting" && w.open === "none") {
      mark(w, "wait", now);
      w.open = "obs";
    }
    // S4 返事の終わりの観測（返事の終わりの記録を受けたことのない窓の予備）
    if (w.prevObs === "busy" && kind === "idle" && !w.hookSeen && w.open === "none") {
      mark(w, "obs", now);
      w.open = "obs";
    }
    // 仕事の観測
    if (kind === "busy") w.open = "none";
    w.prevObs = kind;
    return isBreak(prev, status);
  }

  /**
   * 返事の終わりの記録（結べた窓に対して。S1・S2）。受けたら true（印を付けたかではなく、受けたか）。
   * ts の古さ（startedAt）と（会話番号, ts）の重なりは ActivityStore が見る。now は呼び出し側の時計。
   */
  addTurnEnd(sessionId: string, e: TurnEnd, now: number): boolean {
    const w = this.win(sessionId);
    const prevTurnEnd = w.lastTurnEndTs;
    w.lastTurnEndTs = Math.max(w.lastTurnEndTs, e.ts);
    if (e.failed) {
      // S2 失敗: いつも付ける
      if (!(e.ts > w.lastClearAt)) return false;
      mark(w, "failure", e.ts, true);
      w.deferred = undefined;
      w.hookSeen = true;
      w.open = "stop";
      return true;
    }
    // S1 返事の終わり
    if (!(e.ts > w.lastClearAt)) return false;
    if (!(e.ts > w.lastResumeAt)) return false;
    if (e.stopHookActive && !(w.lastClearAt > prevTurnEnd || w.lastResumeAt > prevTurnEnd || w.deferred !== undefined)) return false;
    w.hookSeen = true;
    if (e.pendingSelfResume !== true) {
      mark(w, "stop", e.ts);
      w.deferred = undefined;
      w.open = "stop";
    } else {
      w.deferred = { ts: e.ts, at: now };
      if (w.unread === 1 && w.cause !== "failure" && e.ts > w.markTs) unmark(w);
      w.open = "none";
      w.prevObs = undefined;
    }
    return true;
  }

  /** C2 AI が自分で再開した記録（結べた窓に対して）。受けたら true */
  addSelfResume(sessionId: string, ts: number): boolean {
    const w = this.win(sessionId);
    if (!(ts > w.lastTurnEndTs && ts > w.lastClearAt)) return false;
    w.lastResumeAt = Math.max(w.lastResumeAt, ts);
    w.deferred = undefined;
    if (w.unread === 1 && w.cause !== "failure" && ts > w.markTs) unmark(w);
    w.open = "none";
    w.prevObs = undefined;
    return true;
  }

  /** S5 付け漏れの予備: 予定があって付けなかった Stop から 30 分たった窓に付ける。印が変わったら true */
  sweepStale(now: number): boolean {
    let changed = false;
    for (const w of this.windows.values()) {
      if (w.deferred === undefined || now - w.deferred.at < STALE_MS) continue;
      const before = w.unread;
      mark(w, "stale", now);
      w.deferred = undefined;
      if (w.unread !== before) changed = true;
    }
    return changed;
  }

  unreadOf(sessionId: string): number {
    return this.windows.get(sessionId)?.unread ?? 0;
  }

  /** PO が送ったとき（design §4-3 C1）。未読の印が変わったら true。 */
  clear(sessionId: string, now: number): boolean {
    const w = this.windows.get(sessionId);
    if (w === undefined) {
      this.win(sessionId).lastClearAt = now;
      return false;
    }
    const changed = w.unread !== 0;
    unmark(w);
    w.lastClearAt = now;
    w.open = "none";
    w.prevObs = undefined;
    w.deferred = undefined;
    return changed;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
    this.windows.delete(sessionId);
  }
}
