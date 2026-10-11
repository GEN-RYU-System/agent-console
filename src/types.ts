export type SessionState = "working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown";

export interface SessionView {
  id: string;
  name: string;
  roleId: string;
  branch: string | null;
  cwd: string;
  state: SessionState;
  createdAt: number;
}

export interface RoleView {
  id: string;
  labelKey: string;
  needsWorktree: boolean;
}

export interface ConsoleState {
  sessions: SessionView[];
  agentsAvailable: boolean;
  roles: RoleView[];
  saSource: string;
  claudeVersion: string;
}

export type LookupResult = { kind: "found"; state: string } | { kind: "unregistered" } | { kind: "conflict" };

export interface LedgerCard {
  branch: string;
  result: LookupResult;
}

export const LEDGER_COLUMNS = ["IN_PROGRESS", "REVIEW", "DONE", "OTHER", "UNREGISTERED"] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
export type LedgerGroups = Record<LedgerColumn, LedgerCard[]>;
