// 定期実行（closeWhenIdle）が開いたセッションの自動クローズ。設計 docs/handoff/ac-hardening/design.md §6。
// 標本は claude agents --json の定期取得（Hub.onAgentsSampled）。指示を送ったあとから数え、idle が連続して累計 10 分で閉じる。
// 返答に NEEDS_DECISION: か BLOCKED: があるもの、返答が無いものは閉じずに残す（kept）。token と promptText は書かない。
import type { SessionState } from "./agents.ts";
import type { RoutineAuditEntry } from "./routine-audit.ts";

/** idle が連続して累計これだけ続いたら閉じる */
export const CLOSE_IDLE_MS = 10 * 60_000;
/** waiting のままこれだけ続いたら、閉じずに残したと 1 回だけ記録する */
export const KEEP_WAITING_MS = 60 * 60_000;
/** 履歴に残す返答の先頭の字数 */
export const SUMMARY_CHARS = 500;
const DECISION_MARK = /NEEDS_DECISION:|BLOCKED:/;

export interface CloserTarget { routineId: string; createdBy?: "agent"; slot: string; sessionId: string; sessionName?: string; sentAt: number }
interface Tracked extends CloserTarget { prevAt: number | null; prevIdle: boolean; idleMs: number; waitingSince: number | null; keptWaiting: boolean }

export interface CloserDeps {
  /** アプリのセッション id から、Claude 側の sessionId と終了済みかを引く。無ければ undefined */
  session: (id: string) => { claudeSessionId?: string; exited: boolean } | undefined;
  /** その Claude セッションの最後の返答（assistant）の本文。1 件も無ければ null */
  lastReply: (claudeSessionId: string) => string | null;
  /** その Claude セッションで動いている担当の数 */
  runningCount: (claudeSessionId: string) => number;
  close: (id: string) => Promise<void>;
  /** 履歴（routines の events）へ */
  record: (routineId: string, event: { outcome: "closed" | "kept"; slot: string; sessionName?: string; sessionId: string; summary?: string }) => Promise<void>;
  audit: (entry: Omit<RoutineAuditEntry, "at">) => Promise<void>;
}

/**
 * 標本の間隔の上限。これを超えたら（Mac のスリープなど）その標本を取得失敗と同じ unknown として 0 から数え直す。
 * 1 周は agentsPollMs ＋ fetchAgents の timeout 15 秒などで、正常でも 20 秒前後になり得るので 60 秒を下限にする
 */
export const gapLimitMsFor = (agentsPollMs: number): number => Math.max(agentsPollMs * 5, 60_000);
export const DEFAULT_GAP_LIMIT_MS = gapLimitMsFor(3000);

export class RoutineCloser {
  private readonly tracked = new Map<string, Tracked>();
  constructor(private readonly deps: CloserDeps, private readonly idleMs = CLOSE_IDLE_MS, private readonly waitingMs = KEEP_WAITING_MS, private readonly gapLimitMs = DEFAULT_GAP_LIMIT_MS) {}

  track(target: CloserTarget): void {
    this.tracked.set(target.sessionId, { ...target, prevAt: null, prevIdle: false, idleMs: 0, waitingSince: null, keptWaiting: false });
  }
  size(): number { return this.tracked.size; }

  /** 標本 1 回分。states が null（取得失敗）なら全員 0 からやり直す */
  async sample(states: ReadonlyMap<string, SessionState> | null, at: number): Promise<void> {
    for (const t of [...this.tracked.values()]) {
      const info = this.deps.session(t.sessionId);
      if (info === undefined || info.exited) { this.tracked.delete(t.sessionId); continue; }
      // 前の標本から gapLimitMs を超えて空いたら、取得失敗と同じ unknown 扱い（スリープ明けにすぐ閉じない）
      const gapped = t.prevAt !== null && at - t.prevAt > this.gapLimitMs;
      const state = gapped ? "unknown" : (states?.get(t.sessionId) ?? "unknown");
      const running = info.claudeSessionId !== undefined ? this.deps.runningCount(info.claudeSessionId) : 0;
      const idle = state === "idle" && running === 0;
      t.idleMs = idle && t.prevIdle && t.prevAt !== null ? t.idleMs + (at - t.prevAt) : 0;
      t.prevIdle = idle;
      t.prevAt = at;
      if (state === "waiting") t.waitingSince ??= at; else t.waitingSince = null;
      if (state === "waiting" && !t.keptWaiting && t.waitingSince !== null && at - t.waitingSince >= this.waitingMs) {
        t.keptWaiting = true;
        await this.keep(t, "waiting");
        continue;
      }
      if (t.idleMs >= this.idleMs) await this.finish(t, info.claudeSessionId);
    }
  }

  private async keep(t: Tracked, reason: "decision" | "no-reply" | "waiting"): Promise<void> {
    this.tracked.delete(t.sessionId); // kept 後は見ない（設計 §3-4）
    await this.deps.record(t.routineId, { outcome: "kept", slot: t.slot, sessionId: t.sessionId, ...(t.sessionName !== undefined ? { sessionName: t.sessionName } : {}) });
    await this.deps.audit({ action: "kept", outcome: "ok", routineId: t.routineId, targetCreatedBy: t.createdBy ?? "ui", callerSessionId: null, closeReason: reason });
  }

  private async finish(t: Tracked, claudeSessionId: string | undefined): Promise<void> {
    const reply = claudeSessionId !== undefined ? this.deps.lastReply(claudeSessionId) : null;
    if (reply === null) { await this.keep(t, "no-reply"); return; }
    if (DECISION_MARK.test(reply)) { await this.keep(t, "decision"); return; }
    this.tracked.delete(t.sessionId);
    try { await this.deps.close(t.sessionId); } catch (e) { console.error("routine-closer: close failed:", e instanceof Error ? e.message : e); }
    const summary = Array.from(reply).slice(0, SUMMARY_CHARS).join("");
    await this.deps.record(t.routineId, { outcome: "closed", slot: t.slot, sessionId: t.sessionId, summary, ...(t.sessionName !== undefined ? { sessionName: t.sessionName } : {}) });
    await this.deps.audit({ action: "closed", outcome: "ok", routineId: t.routineId, targetCreatedBy: t.createdBy ?? "ui", callerSessionId: null, closeReason: "idle" });
  }
}
