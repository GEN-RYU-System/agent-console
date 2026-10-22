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
  /** 今、チャットの文がすぐ端末に届く状態か（idle・作業中で待ちなし。確認待ち・状態不明は予約になる） */
  canChat: boolean;
  /** 名前の変更を予約中のとき、その名前（待機になったら自動で変わる） */
  pendingName?: string;
  /** そのセッションのブランチの PR の検査の要約（PR が無い・検査が無い・まだ取れていないときは項目ごと無い） */
  ci?: CiState;
  /** 動いている Claude の sessionId（UUID の形のものだけ。まだ分からないときは項目ごと無い） */
  claudeSessionId?: string;
}

export type CiState = "fail" | "pending" | "pass";

export interface RoleView {
  id: string;
  labelKey: string;
  needsWorktree: boolean;
  /** false なら予約で選べない。省くと選べる */
  reservable?: boolean;
}

/** 起動時に前回のセッションを開き直せなかった理由（文言は画面の i18n）。name は保存してあった名前 */
export interface RestoreNotice {
  reason: "missingCwd" | "unknownRole" | "startFailed" | "overLimit" | "unreadable";
  name?: string;
}

/** 端末の置き場（tmux）についての案内（文言は画面の i18n）。name はセッション名 */
export interface TerminalNotice {
  reason: "tmuxMissing" | "cannotAttach";
  name?: string;
}

export type RelayPhase = "handoff" | "launching" | "sending" | "done" | "failed";
export type RelayReason = "send_failed" | "handoff_timeout" | "gone" | "full" | "start_failed" | "not_ready";

/** 引き継ぎの進行（server の RelayView の写し） */
export interface RelayView {
  relayId: string;
  oldSessionId: string;
  oldName: string;
  newName: string;
  phase: RelayPhase;
  newSessionId?: string;
  reason?: RelayReason;
}

export interface ConsoleState {
  sessions: SessionView[];
  agentsAvailable: boolean;
  restoreNotices: RestoreNotice[];
  /** tmux が無い・つなげない時の案内。無ければ空（キー自体が無い） */
  terminalNotices?: TerminalNotice[];
  /** 引き継ぎの進行。無ければキー自体が無い */
  relays?: RelayView[];
  /** まだ Claude に送っていない部品の数（「部品」タブの件数） */
  picksUnsent: number;
  /** セッションの様子の記録の版（進んだら、右の欄の「このセッション」を取り直す） */
  activityRev: number;
  roles: RoleView[];
  saSource: string;
  claudeVersion: string;
  appVersion: string;
  commit: string;
  /** マウスのホイールでスクロールするときのなめらかさ（ms。config の値） */
  terminalSmoothScrollMs: number;
  /** 端末の文字の描き方（config の値）。"webgl" は GPU、"dom" は画面の部品 */
  terminalRenderer: "webgl" | "dom";
  /** 端末に貼る画像 1 枚の上限（byte。config の値） */
  uploadMaxBytes: number;
  /** 「アカウントを切り替える」を出すか（config の accountLoginCommand があるとき true） */
  accountSwitchEnabled: boolean;
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
  /** 上のバーに常に表示するか */
  pinned: boolean;
}

export interface RoutineEvent { at: number; slot: string; outcome: "sent" | "not_ready" | "full" | "cwd_invalid" | "failed" | "busy" | "waiting" | "unknown" | "stopped" | "missing" | "closed" | "kept"; sessionName?: string; sessionId?: string; summary?: string; }
export interface Routine { id: string; name: string; enabled: boolean; roleId: string; cwd: string; branch?: string; timeZone: "Asia/Tokyo"; weekdays: number[]; timeHHmm: string; promptText: string; closeWhenIdle?: boolean; lastSlot?: string; createdAt: number; updatedAt: number; events: RoutineEvent[]; }
export type RoutineInput = Pick<Routine, "name" | "enabled" | "roleId" | "weekdays" | "timeHHmm" | "promptText"> & { cwd?: string; branch?: string; closeWhenIdle?: boolean };

export type ReservationStatus = "pending" | "dispatching" | "done" | "cancelled";
export type ReservationOutcome = "sent" | "not_ready" | "full" | "cwd_invalid" | "failed" | "interrupted";
export interface Reservation {
  id: string; name: string; roleId: string; cwd: string; branch?: string;
  runAt: number; runAtJst: string; timeZone: "Asia/Tokyo"; promptText: string;
  createdBy: "ui" | "agent"; createdAt: number; updatedAt: number; status: ReservationStatus;
  startedAt?: number; lateMinutes?: number; finishedAt?: number; outcome?: ReservationOutcome; sessionName?: string;
  purpose?: "measure"; measureNote?: string;
}
export interface ReservationInput { name: string; roleId: string; cwd?: string; branch?: string; date: string; time: string; promptText: string; }

/** 再開先の1行（本店=Opus 設計役 / 本店の worktree=Sonnet 実装役）。会話の一覧は持たない。 */
export interface ResumeTarget {
  kind: "main" | "worktree";
  path: string;
  branch: string | null;
  /** 再開に使う役割の id（RoleView.id） */
  roleId: string;
}

export interface MemorySnapshot {
  sessions: Array<{ id: string; name: string; rssMb: number; cpuPercent?: number; ramPercent?: number | null }>;
  serverRssMb: number;
  system: { totalMb: number; freePercent: number; usedPercent: number; cpuPercent?: number | null; diskUsedPercent?: number | null; diskTotalGb?: number | null } | null;
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

/** Chrome の拡張から届いた部品（ブラウザで選んだ画面の一部）。正本はサーバーの dataDir/picks/ */
export interface PickItem {
  id: string;
  createdAt: number;
  url: string;
  title: string;
  selector: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  html: string;
  style: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  dpr: number;
  vw: number;
  hasImage: boolean;
  /** 画像が無いときの理由（拡張・サーバーが付ける） */
  imageError: string;
  /** PO のひとこと */
  note: string;
  sentAt?: number;
}

/** 右の欄「作戦ボード」の、動いている担当 1 つ。説明は Claude が書いた文のまま。startedAt は動き始め（再開した担当は再開の時刻） */
export interface ActivityAgent {
  key: string;
  subagentType: string;
  model: string;
  resolvedModel: string;
  description: string;
  startedAt: number;
}
export interface ActivityTask {
  id: string;
  subject: string;
  done: boolean;
}
export interface ActivityInput {
  ts: number;
  text: string;
}
/** 記録の仕組み（hooks）の点検の結果。reason は ok でないときだけ */
export interface HookCheck {
  ok: boolean;
  reason?: "noSettings" | "unreadable" | "missingHandler" | "nodeMissing" | "hookFileMissing" | "matcherDiffers";
  missingEvents?: string[];
  matcherDiffersEvents?: string[];
}
export type ActivityResponse =
  | { status: "noSession" }
  | {
      status: "ok";
      /** サーバーが答えた時刻。「3分前」はこれとの差で出す */
      now: number;
      running: ActivityAgent[];
      tasks: ActivityTask[];
      inputs: ActivityInput[];
      lastEventAt: number | null;
      hooks: HookCheck;
    };

/** 作戦ボード（各セッションの Claude が命令で丸ごと書く計画）。形と上限は README の「作戦ボード」 */
export type BoardRoadmapStatus = "todo" | "doing" | "done";
export interface Board {
  version: 1;
  theme: string;
  kgi: Array<{ text: string }>;
  kpis: Array<{ name: string; target: string; current: string; unit: string }>;
  roadmap: Array<{ title: string; status: BoardRoadmapStatus }>;
  /** このセッションで進める仕事。古い形のファイルは [] で返る */
  tasks: Array<{ title: string; status: BoardRoadmapStatus }>;
  /** 最後に書き込んだ時刻（ms） */
  updatedAt: number;
}
/** none=まだ書き込まれていない、invalid=ファイルが壊れている */
export type BoardResponse = { status: "none" } | { status: "invalid" } | { status: "ok"; board: Board };

/** チャットの 1 件。user=しんごさんの入力、assistant=Claude の返事、error=API エラー（error に種類） */
export interface ChatItem {
  /** そのセッションの中の連番。続きだけ取るときの印（since） */
  seq: number;
  ts: number;
  role: "user" | "assistant" | "error";
  text: string;
  error?: string;
  /** 記録の時点で、長さの上限により後ろが切れている */
  truncated?: boolean;
}
/** チャットの送信の予約 1 件（サーバーのメモリの写し）。queued=まだ端末に書いていない、sent=書いた（Claude の受け取り待ち） */
export interface ChatQueueItem {
  id: string;
  text: string;
  createdAt: number;
  state: "queued" | "sent";
  sentAtSeq?: number;
}
export type ChatResponse =
  | { status: "noSession"; queued: ChatQueueItem[] }
  | {
      status: "ok";
      queued: ChatQueueItem[];
      /** アプリの起動ごとに変わる id。変わったら seq が振り直されている */
      epoch: string;
      reset: boolean;
      lastSeq: number;
      items: ChatItem[];
    };

/** Claude の利用量（statusLine の命令が dataDir/usage.json に書いた写し）。none=まだ無い、invalid=ファイルが壊れている */
export interface UsageWindow {
  /** 0〜100 */
  usedPercentage: number;
  /** リセットの時刻（Unix 秒） */
  resetsAt: number;
}
export type UsageResponse = { status: "none" } | { status: "invalid" } | { status: "ok"; observedAt: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow };

/** アカウント切り替えの端末の役割 id（server/config.ts の ACCOUNT_LOGIN_ROLE_ID と同じ値） */
export const ACCOUNT_LOGIN_ROLE_ID = "account-login";
/** GET /api/account の応答。キーは status・loggedIn・email・subscriptionType だけ */
export type AccountResponse =
  | { status: "ok"; loggedIn: true; email: string; subscriptionType: string }
  | { status: "ok"; loggedIn: false }
  | { status: "invalid" }
  | { status: "error" };

/** セッションが書いたファイル（file-viewer 設計 §3-4） */
export interface SessionFile {
  path: string;
  name: string;
  dir: string;
  tool: string;
  lastAt: number;
  byAgent: boolean;
}
export type FilesResponse = { status: "noSession" } | { status: "ok"; files: SessionFile[] };
export type FileContentResponse =
  | { status: "noSession" }
  | { status: "notListed" }
  | { status: "missing" }
  | { status: "notRegular" }
  | { status: "unreadable" }
  | { status: "tooLarge"; size: number }
  | { status: "binary"; size: number }
  | { status: "ok"; text: string; size: number; mtimeMs: number; kind: "markdown" | "text" };
