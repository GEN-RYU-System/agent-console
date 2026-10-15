// ac-routine の一時承認（設計 docs/handoff/ac-hardening/design.md §3-3 と §3-3a）。メモリだけに持つ（サーバーを再起動すると消える）。
// claudeSessionId ごとに 1 件。後から出した承認が前の承認を上書きする。使うと消える（1 回限り）。時刻は注入できる（試験用）。

export type ApprovalBy = "opus" | "ui";

/** 期限。Opus はその場で使うので短く、PO は離席しうるので長くする（設計 §3-3a） */
export const APPROVAL_TTL_MS: Record<ApprovalBy, number> = { opus: 10 * 60 * 1000, ui: 30 * 60 * 1000 };

export interface Approval {
  by: ApprovalBy;
  expiresAt: number;
}

export class RoutineApprovals {
  private readonly items = new Map<string, Approval>();
  /** 最後に出した承認（consume では消さない）。restore が「後から新しい承認が出ていないか」を同一性で確かめる */
  private readonly lastIssued = new Map<string, Approval>();
  constructor(private readonly now: () => number = Date.now) {}

  /** 承認を出す。同じ claudeSessionId の前の承認は上書きされる */
  issue(claudeSessionId: string, by: ApprovalBy): Approval {
    const approval: Approval = { by, expiresAt: this.now() + APPROVAL_TTL_MS[by] };
    this.items.set(claudeSessionId, approval);
    this.lastIssued.set(claudeSessionId, approval);
    return approval;
  }

  /** 期限内の承認を見るだけ（消さない）。画面の「承認中」表示用 */
  peek(claudeSessionId: string): Approval | null {
    const approval = this.items.get(claudeSessionId);
    if (approval === undefined) return null;
    if (approval.expiresAt <= this.now()) {
      this.items.delete(claudeSessionId);
      return null;
    }
    return approval;
  }

  /** 使う。期限内なら承認を返して消す。無い・期限切れなら null */
  consume(claudeSessionId: string): Approval | null {
    const approval = this.peek(claudeSessionId);
    if (approval !== null) this.items.delete(claudeSessionId);
    return approval;
  }

  /**
   * 使った承認を、書き込みが失敗したときに戻す。次をすべて満たすときだけ同じ参照を戻す:
   * 最後に出した承認と同一（後から新しい承認が出ていれば戻さない）・今の Map に承認が無い・期限内（延長しない）。戻せたかを返す
   */
  restore(claudeSessionId: string, approval: Approval): boolean {
    if (this.lastIssued.get(claudeSessionId) !== approval) return false;
    if (this.items.has(claudeSessionId)) return false;
    if (approval.expiresAt <= this.now()) return false;
    this.items.set(claudeSessionId, approval);
    return true;
  }
}
