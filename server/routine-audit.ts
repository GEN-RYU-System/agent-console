// ac-routine（AI による定期実行の登録・変更）の監査記録。設計 docs/handoff/ac-routine/design.md §4-1-3。
// dataDir/routine-audit.jsonl に 1 件 1 行で追記するだけ（0600）。token・本文の中身（promptText など）は書かない（例外: `caseClaudeVersionProbe` の `paneSamples`。設計 conversation-consent §14-14-6 の 8・9）。
import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

export const ROUTINE_AUDIT_FILE = "routine-audit.jsonl";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** add / update / enable / disable は書き込み。approvalIssued は一時承認の発行。closed / kept は定期実行セッションの自動クローズ（設計 ac-hardening §7）。reserveCreate は予約の作成、reserveCancel は予約の取消、reserveDispatch は予約が時刻になって開くこと。caseProxy は件の受付（case-proxy）の通した・断った1回、caseRoomMacosAccepted は macOS の版の記録（scripts/ac-case-macos.mjs accept）。caseSay は件のセッションへ決まった一文を送ったこと、caseSayRefused は断ったこと（理由は reason）。caseClaudeVersionProbe は件の claude の版の自動の確かめ 1 回、caseClaudeVersionNotice は版ずれの知らせ（設計 conversation-consent §14-14） */
export type RoutineAuditAction = "add" | "update" | "enable" | "disable" | "approvalIssued" | "closed" | "kept" | "reserveCreate" | "reserveCancel" | "reserveDispatch" | "caseProxy" | "caseRoomMacosAccepted" | "caseSay" | "caseSayRefused" | "caseClaudeVersionProbe" | "caseClaudeVersionNotice";

export interface RoutineAuditEntry {
  at: string;
  action: RoutineAuditAction;
  outcome: "ok" | "denied" | "aborted";
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
  /** caseProxy: 本体と一致した件のセッション id（一致したときだけ） */
  caseSessionId?: string;
  /** caseProxy: 受けた CONNECT の host（小文字・末尾の点を落とした形） */
  host?: string;
  /** caseProxy: 送り元が件の本体だったか */
  main?: boolean;
  /** caseSay / caseSayRefused: 宛先の件のセッション id（isSessionId の形のときだけ） */
  caseId?: string;
  /** caseSay / caseSayRefused: 手順ファイル名（決まった形のときだけ） */
  stepFile?: string;
  /** caseSay / caseSayRefused: 送る文の sha256 の先頭 16 桁（文を組み立てた後だけ） */
  textSha16?: string;
  /** caseSay / caseSayRefused: 手順ファイルの中身の sha256 の先頭 16 桁（読めた後だけ） */
  stepSha16?: string;
  /** caseSay / caseSayRefused: 件の claude の版。判定 4b より前で断った行には欄が無い。4b 以後は読めた版、版の形でなければ空文字 */
  claudeVersion?: string;
  /** caseRoomMacosAccepted: 記録した macOS の版（sw_vers -productVersion） */
  productVersion?: string;
  /** caseClaudeVersionProbe: 始めた時刻・終わった時刻（ISO 8601） */
  startedAt?: string;
  endedAt?: string;
  /** caseClaudeVersionProbe / caseClaudeVersionNotice: 実体の sha256 の先頭 16 桁 */
  sha16?: string;
  /** caseClaudeVersionProbe: ×の番号（E1〜E4・P0〜P5・R1） */
  failedCheck?: string;
  /** caseClaudeVersionProbe: 発火の理由（t1 件を開いた・t2 サーバー起動） */
  trigger?: "t1" | "t2";
  /** caseClaudeVersionProbe: probe の件の id */
  probeCaseId?: string;
  /** caseClaudeVersionProbe: P2・P3・P5 で数えた数 */
  counts?: Record<string, number>;
  /** caseClaudeVersionProbe: P0〜P3 の各 idle 復帰の時点の probe の件の画面の写し（制御文字を除き各 4KiB まで・最大 4 枚。MAC の対象外） */
  paneSamples?: string[];
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
