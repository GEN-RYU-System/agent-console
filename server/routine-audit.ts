// ac-routine（AI による定期実行の登録・変更）の監査記録。設計 docs/handoff/ac-routine/design.md §4-1-3。
// dataDir/routine-audit.jsonl に 1 件 1 行で追記するだけ（0600）。token・本文の中身（promptText など）は書かない。
import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

export const ROUTINE_AUDIT_FILE = "routine-audit.jsonl";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** add / update / enable / disable は書き込み。approvalIssued は一時承認の発行。closed / kept は定期実行セッションの自動クローズ（設計 ac-hardening §7）。reserveCreate は予約の作成、reserveCancel は予約の取消、reserveDispatch は予約が時刻になって開くこと */
export type RoutineAuditAction = "add" | "update" | "enable" | "disable" | "approvalIssued" | "closed" | "kept" | "reserveCreate" | "reserveCancel" | "reserveDispatch";

export interface RoutineAuditEntry {
  at: string;
  action: RoutineAuditAction;
  outcome: "ok" | "denied";
  /** 対象を解決できた行だけに入れる。その行では targetCreatedBy も必須 */
  routineId?: string;
  /** 予約の行だけ */
  reservationId?: string;
  /** 項目が無い（人が画面で作った）対象は "ui"。予約の行では予約の createdBy */
  targetCreatedBy?: "agent" | "ui";
  /** UUID の形でなければ null */
  callerSessionId: string | null;
  roleId?: string;
  /** reserveDispatch: 予約が開く役割。roleId は呼び出し元の役割 */
  targetRoleId?: string;
  reason?: string;
  error?: string;
  /** approvalIssued: 承認を出した側 */
  by?: "opus" | "ui";
  /** approvalIssued: 期限（ISO 8601） */
  expiresAt?: string;
  /** approvalIssued（opus）: 発行の時点で動いていた担当。どの担当が動いている最中に承認したかを週次で見る */
  runningAgents?: { key: string; subagentType: string; startedAt: number }[];
  /** 書き込みが一時承認で通ったときの、使った承認の出し手 */
  approvedBy?: "opus" | "ui";
  /** 書き込みが担当の動いている最中に拒否されたときの、動いていた担当の数 */
  runningCount?: number;
  /** 上限超過（RoutineLimitError）で拒否されたとき、取り出していた承認を戻せたか（承認を取り出していたときだけ） */
  approvalRestored?: boolean;
  /** closed / kept: 自動クローズの理由（kept は decision / no-reply / waiting） */
  closeReason?: string;
}

export class RoutineAudit {
  private readonly file: string;
  private chain: Promise<void> = Promise.resolve();
  constructor(dataDir: string) { this.file = path.join(dataDir, ROUTINE_AUDIT_FILE); }
  /** 追記のみ。同時の呼び出しは順に書く。書けなければ例外 */
  append(entry: RoutineAuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const run = this.chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
      await appendFile(this.file, line, { mode: FILE_MODE });
      await chmod(this.file, FILE_MODE);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
