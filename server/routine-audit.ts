// ac-routine（AI による定期実行の登録・変更）の監査記録。設計 docs/handoff/ac-routine/design.md §4-1-3。
// dataDir/routine-audit.jsonl に 1 件 1 行で追記するだけ（0600）。token・本文の中身（promptText など）は書かない。
import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

export const ROUTINE_AUDIT_FILE = "routine-audit.jsonl";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type RoutineAuditAction = "add" | "update" | "enable" | "disable";

export interface RoutineAuditEntry {
  at: string;
  action: RoutineAuditAction;
  outcome: "ok" | "denied";
  /** 対象を解決できた行だけに入れる。その行では targetCreatedBy も必須 */
  routineId?: string;
  /** 項目が無い（人が画面で作った）対象は "ui" */
  targetCreatedBy?: "agent" | "ui";
  /** UUID の形でなければ null */
  callerSessionId: string | null;
  roleId?: string;
  reason?: string;
  error?: string;
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
