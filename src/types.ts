export type SessionState = "working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown";

export interface SessionView {
  id: string;
  name: string;
  roleId: string;
  branch: string | null;
  cwd: string;
  state: SessionState;
  createdAt: number;
  unread: number;
  hasClaude: boolean;
  /** 今、名前の変更・よく使う指示を入れてよい状態か（Claude 起動中は idle のときだけ） */
  canInput: boolean;
  /** 名前の変更を予約中のとき、その名前（待機になったら自動で変わる） */
  pendingName?: string;
}

export interface RoleView {
  id: string;
  labelKey: string;
  needsWorktree: boolean;
}

/** 起動時に前回のセッションを開き直せなかった理由（文言は画面の i18n）。name は保存してあった名前 */
export interface RestoreNotice {
  reason: "missingCwd" | "unknownRole" | "startFailed" | "overLimit" | "unreadable";
  name?: string;
}

export interface ConsoleState {
  sessions: SessionView[];
  agentsAvailable: boolean;
  restoreNotices: RestoreNotice[];
  roles: RoleView[];
  saSource: string;
  claudeVersion: string;
  appVersion: string;
  commit: string;
}

export type LookupResult = { kind: "found"; state: string; startedAt: number | null } | { kind: "unregistered" } | { kind: "conflict" };

export interface LedgerError {
  branch: string;
  message: string;
}

export interface LedgerSnapshot {
  groups: LedgerGroups;
  errors: LedgerError[];
}

export interface LedgerCard {
  branch: string;
  result: LookupResult;
}

export const LEDGER_COLUMNS = ["IN_PROGRESS", "REVIEW", "DONE", "OTHER", "UNREGISTERED"] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
export type LedgerGroups = Record<LedgerColumn, LedgerCard[]>;

export interface QuickPrompt {
  id: string;
  label: string;
  text: string;
}

/** 再開先の1行（本店=Opus 設計役 / 本店の worktree=Sonnet 実装役）。会話の一覧は持たない。 */
export interface ResumeTarget {
  kind: "main" | "worktree";
  path: string;
  branch: string | null;
  /** 再開に使う役割の id（RoleView.id） */
  roleId: string;
}

export interface MemorySnapshot {
  sessions: Array<{ id: string; name: string; rssMb: number }>;
  serverRssMb: number;
  system: { totalMb: number; freePercent: number; usedPercent: number } | null;
}
