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
}

export interface RoleView {
  id: string;
  labelKey: string;
  needsWorktree: boolean;
  canResume: boolean;
}

export interface ConsoleState {
  sessions: SessionView[];
  agentsAvailable: boolean;
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

export interface PastSession {
  sessionId: string;
  name: string;
  cwd: string;
  startedAt: number | null;
  status: "busy" | "waiting" | "idle" | "unknown";
  /** null のとき再開できる。running=今動いている / outside=本店でも本店のワークツリーでもない / missing=存在しない / noRole=その作業場所で再開できる役割が設定に無い */
  blocked: "running" | "outside" | "missing" | "noRole" | null;
  /** 再開に使う役割の id（RoleView.id）。再開できない行は null */
  resumeRoleId: string | null;
}

export interface MemorySnapshot {
  sessions: Array<{ id: string; name: string; rssMb: number }>;
  serverRssMb: number;
  system: { totalMb: number; freePercent: number; usedPercent: number } | null;
}
