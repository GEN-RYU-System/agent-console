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
  /** そのセッションのブランチの PR の検査の要約（PR が無い・検査が無い・まだ取れていないときは項目ごと無い） */
  ci?: CiState;
}

export type CiState = "fail" | "pending" | "pass";

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

/** 基準から変わったファイルの 1 行。untracked は git にまだ追加されていないファイル。 */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  untracked: boolean;
}

export type DiffList = { baseRef: string; files: ChangedFile[] } | { error: "noBase"; baseRef: string };

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export type FileDiff = { lines: DiffLine[] } | { tooLarge: true } | { binary: true } | { untracked: true };

export type CommentSide = "new" | "old" | "file";

export interface DiffComment {
  id: string;
  path: string;
  side: CommentSide;
  line?: number;
  lineText?: string;
  body: string;
  createdAt: number;
  sentAt?: number;
}

/** コメントの追加・編集で送る内容（id・時刻はサーバーが付ける）。 */
export type DiffCommentInput = Pick<DiffComment, "path" | "side" | "body"> & Partial<Pick<DiffComment, "line" | "lineText">>;

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
export type CheckCounts = Record<CheckBucket, number>;
export interface CheckItem {
  name: string;
  bucket: "fail" | "cancel" | "pending";
  /** https://github.com/ で始まるものだけ（それ以外は空） */
  link: string;
  workflow: string;
}
export interface PrInfo {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  /** https://github.com/ で始まるものだけ（それ以外は空） */
  url: string;
  mergeStateStatus: string;
}
export type PrMessageStatus = "loading" | "noPr" | "notGitHub" | "detached" | "ghMissing" | "authRequired" | "timeout" | "rateLimited" | "ghFailed";
export type PrResponse =
  | { status: "ok"; pr: PrInfo; checks: { counts: CheckCounts; items: CheckItem[] }; fetchedAt: number }
  | { status: PrMessageStatus; fetchedAt?: number };
