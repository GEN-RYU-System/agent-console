import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { agentForSession, chatVerdict, fetchAgents, inputVerdict, stateForSession, type AgentRow, type InputVerdict, type SessionState } from "./agents.ts";
import type { Config } from "./config.ts";
import { loadLedger, type LedgerSnapshot } from "./ledger.ts";
import { ciOfResponse, fetchPr, isSettled, resolveTarget, type CiState, type PrResponse, type PrTarget } from "./pr-status.ts";
import { BreakTracker, breakBody, osascriptSender, type NotificationSender } from "./notify.ts";
import type { SelfResumeEvent, TurnEndEvent } from "./activity.ts";
import { startPolling } from "./poll.ts";
import { readCaseClaudeSessionId, readCaseStateFile, readStepFileSha16, type CaseStateFile } from "./case-agents.ts";
import { readLstartSync } from "./case-proxy.ts";
import { CLAUDE_VERSION_PATTERN } from "./config.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { descendantPids, readProcessTable, type PsRow } from "./process-tree.ts";
import type { RelayView } from "./relay.ts";
import type { RestoreNotice } from "./restore.ts";
import { SessionConflictError, SessionNotFoundError, type Session, type SessionManager, type TerminalNotice } from "./sessions.ts";
import { resolveWorkplace } from "./workplace.ts";

export interface SessionView {
  id: string;
  name: string;
  roleId: string;
  branch: string | null;
  cwd: string;
  state: SessionState;
  createdAt: number;
  /** 区切り（busy→waiting/idle）で増え、行を選ぶと 0 に戻る */
  unread: number;
  /** Claude が動いている（名前の変更は /rename になる） */
  hasClaude: boolean;
  /** 今、人の指示（名前の変更・よく使う指示）を入れてよい状態か（要求時にサーバーが取り直して再判定する） */
  canInput: boolean;
  /** 今、チャットの文がすぐ端末に届く状態か（idle・作業中で待ちなし。確認待ち・状態不明は予約になる） */
  canChat: boolean;
  /** 名前の変更を予約中のとき、その名前（待機になったら自動で送る）。予約が無ければ項目ごと無い */
  pendingName?: string;
  /** そのセッションのブランチの PR の検査の要約（PR が無い・検査が 0 件・まだ取れていないときは項目ごと無い） */
  ci?: CiState;
  /** 動いている Claude の sessionId（UUID の形のものだけ。まだ分からないときは項目ごと無い）。右の欄の「このセッション」が記録を引く鍵 */
  claudeSessionId?: string;
}

/** 名前の変更の結果。queued は端末へ何も書かず予約した */
export type RenameMode = "claude" | "app" | "queued";

/** 端末への 2 回書き（貼り付け → 待つ → Enter）の印が取れないとき、submitText が待つ間隔と上限 */
export const WRITE_WAIT_POLL_MS = 200;
export const WRITE_WAIT_MAX_MS = 10000;
/** 起動直後の名前合わせ（initialName）を試みる期限。作成から数える */
export const INITIAL_NAME_MAX_MS = 10 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** チャットの送信の予約の上限（1 セッションあたり。送信済みで受け取り待ちのものも数える） */
export const CHAT_QUEUE_MAX = 10;
/** 結べない返事の終わりの記録を保留する長さ: max(30 秒, agents の取得 3 回分) */
const PENDING_TURN_END_MIN_MS = 30_000;
const PENDING_TURN_END_POLLS = 3;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/** 送信の予約 1 件。queued=まだ端末に書いていない、sent=端末に書いた（Claude が受け取るのを待っている） */
export interface ChatQueueItem {
  id: string;
  text: string;
  createdAt: number;
  state: "queued" | "sent";
  /** 端末に書いた時点の、そのセッションの会話の最後の seq。これより後の role=user の記録が届いたら、予約から外す。分からないときは項目ごと無い */
  sentAtSeq?: number;
}

/** 記録（ActivityStore）のうち、予約の判定に使う部分 */
export interface ChatSource {
  chat(sessionId: string, since?: number): { items: ReadonlyArray<{ seq: number; role: string }>; lastSeq: number };
}

export interface Snapshot {
  sessions: SessionView[];
  agentsAvailable: boolean;
  /** 起動時に前回のセッションを開き直せなかった理由（メモリだけ。画面の案内） */
  restoreNotices: RestoreNotice[];
  /** 端末の置き場についての案内（tmux が無い／端末につなげない）。無ければ省く */
  terminalNotices?: TerminalNotice[];
  /** 引き継ぎの進行（メモリだけ）。空のときは項目ごと無い */
  relays?: RelayView[];
  /** 同時に開ける窓の数の上限 */
  maxSessions: number;
  /** 今開いている窓の数 */
  openCount: number;
  /** 部品タブの件数: まだ Claude に送っていない部品の数 */
  picksUnsent: number;
  /** セッションの様子の記録の版。進んだら、画面は右の欄を取り直す */
  activityRev: number;
}

/** claude agents の定期取得と台帳の定期取得をまとめ、変化があれば購読者へ配信する。 */
/** case-say（件へ決まった一文を送る）の外の物への入り口。試験で差し替える */
export interface CaseSayPorts {
  readLstart(pid: number): string | null;
  readTable(): Promise<PsRow[]>;
  fetchAgents(claudeBin: string): Promise<AgentRow[] | null>;
  sleep(ms: number): Promise<void>;
}

const defaultCaseSayPorts = (): CaseSayPorts => ({
  readLstart: readLstartSync,
  readTable: readProcessTable,
  fetchAgents,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

/** case-say の結果。200 は送った、409 は断った（reason に理由）。claudeVersion は判定 4b に着いたときだけ（読めなければ空文字） */
export interface CaseSayResult {
  status: 200 | 409;
  reason?: string;
  claudeVersion?: string;
  textSha16?: string;
  stepSha16?: string;
}

/**
 * case-say の判定 7。件の本体の状態ファイルが、ちょうど 1 つ読めて、pid が同じで、status がちょうど `idle` で、名前に wait を含むキーが無いこと。
 * あわせて `claude agents --json` に子孫の pid の行があれば、その行も idle で waitingFor が無いこと（行が無ければ状態ファイルだけで決める）。
 * 画面のチャットの chatVerdict は使わない（件の本体は agents の行に出ないため、確認待ちでも通してしまう）
 */
export function caseSayVerdict(input: { state: CaseStateFile | undefined; pids: ReadonlySet<number>; rows: AgentRow[] | null }): { ok: true } | { ok: false; reason: string } {
  const { state } = input;
  if (state === undefined) return { ok: false, reason: "state_file_unreadable" };
  if (state.pid !== state.filePid) return { ok: false, reason: "state_file_pid_mismatch" };
  if (state.status !== "idle") return { ok: false, reason: "claude_not_idle" };
  if (state.waitKeys.length > 0) return { ok: false, reason: "claude_waiting" };
  if (input.rows === null) return { ok: false, reason: "agents_unavailable" };
  const row = agentForSession({ exited: false, pids: input.pids }, input.rows);
  if (row !== undefined && (row.status !== "idle" || row.waitingFor !== undefined)) return { ok: false, reason: "claude_not_idle" };
  return { ok: true };
}

/** case-say で送る文。サーバーが組み立てる 1 種類だけ */
export const caseSayText = (R: string, stepFile: string): string => `${R}/${stepFile} を読み、書いてある手順を順に行ってください。`;

const sha16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

interface CaseSayTarget {
  session: Session;
  mainPid: number;
  paneId: string;
  CH: string;
  R: string;
  claudeVersion: string;
}

export class Hub {
  private agents: AgentRow[] | null = null;
  private ledger: LedgerSnapshot | null = null;
  private ledgerInFlight: Promise<LedgerSnapshot> | null = null;
  private subscribers = new Set<WebSocket>();
  private lastPayload = "";
  private stoppers: Array<() => void> = [];
  private readonly tracker = new BreakTracker();
  /** claude agents の取得ごとに、各セッションの状態を渡す先（自動クローズの標本）。取得失敗のときは null */
  private readonly sampleListeners = new Set<(states: ReadonlyMap<string, SessionState> | null, at: number) => void>();
  /** 直近の snapshot の表示名（ps を走らせずに名前だけ欲しい呼び出し用） */
  private lastNames = new Map<string, string>();
  private readonly sendNotification: NotificationSender | null;
  /** 名前の変更の予約（セッション id → 名前）。メモリだけ。送るか捨てるまでの正本はここ */
  private readonly pendingRenames = new Map<string, string>();
  private restoreNotices: RestoreNotice[] = [];
  private relays: RelayView[] = [];
  /** 端末へ書いている最中のセッション id（書き込みの印）。2 回書きの間に別の書き込みが入って入力が連結されるのを防ぐ */
  readonly writing = new Set<string>();
  /** case-say の止めの印: 貼り付けを書いた後、Enter を送り切らずに終えた窓（件の id → その窓のセッション）。窓が終わる（別のセッションに替わる）・一覧から外すと効かなくなる。消す口は作らない */
  private readonly caseSayStopped = new Map<string, Session>();
  private readonly caseSayPorts: CaseSayPorts;
  private picksUnsent = 0;
  private activityRev = 0;
  /** 送信の予約（セッション id → 古い順）。メモリだけ。アプリを再起動すると消える。正本はここ */
  private chatQueue = new Map<string, ChatQueueItem[]>();
  /** 1 件送った後、Claude が受け取ったと観測するまで次を送らないための印。sentSeq は送った時点の会話の最後の seq（分からなければ null）。sentWhile は送った時点の状態（busy で送った分は、作業中の観測では外さない） */
  private readonly chatSentGuard = new Map<string, { sentSeq: number | null; sentWhile: "idle" | "busy" }>();
  /** 送信済みの予約を外すのに、すでに使った user の記録の seq（同じ記録で 2 件外さない） */
  private readonly chatConsumedSeq = new Map<string, number>();
  /** セッションごとの、flush の同時実行を防ぐ印 */
  private readonly chatFlushing = new Set<string>();
  private chatRev = 0;
  private chatSource: ChatSource | null = null;
  private readonly nameListeners = new Set<() => void>();
  /** PR と検査の写し（(repo, branch) ごと）。メモリだけ。正本は GitHub */
  private readonly prByKey = new Map<string, PrResponse>();
  /** セッションが今どの (repo, branch) を見ているか。GitHub のリポジトリでない・ブランチにいないときは null */
  private readonly prKeyOfSession = new Map<string, string | null>();
  private readonly prInFlight = new Map<string, Promise<PrResponse>>();
  private readonly ghTimeoutMs: number | undefined;
  /** 未読の時刻（lastClearAt と保留）に使う時計。試験で注入する */
  private readonly now: () => number;
  /** 窓に結べなかった返事の終わりの記録（まだその会話番号を持つ窓が無い）。agents の取得 3 回分（最短 30 秒）で捨てる */
  private pendingTurnEnds: Array<{
    kind: "turnEnd" | "selfResume";
    claudeSessionId: string;
    ts: number;
    failed: boolean;
    stopHookActive: boolean;
    pendingSelfResume: boolean | null;
    receivedAt: number;
  }> = [];

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    sendNotification?: NotificationSender | null,
    options: { ghTimeoutMs?: number; now?: () => number; caseSay?: Partial<CaseSayPorts> } = {},
  ) {
    this.caseSayPorts = { ...defaultCaseSayPorts(), ...options.caseSay };
    this.ghTimeoutMs = options.ghTimeoutMs;
    this.now = options.now ?? Date.now;
    this.sendNotification = sendNotification !== undefined ? sendNotification : config.notify.macos ? osascriptSender(config.notify.osascriptBin) : null;
    sessions.onChange(() => void this.publish().catch((err) => this.onPollError("publish", err)));
    // 一覧から外したセッションの前回の status・未読は持ち続けない
    sessions.onRemoved((id) => {
      this.tracker.forget(id);
      this.pendingRenames.delete(id);
      this.writing.delete(id);
      this.caseSayStopped.delete(id);
      this.prKeyOfSession.delete(id);
      this.dropChatState(id);
    });
  }

  start(): void {
    this.stoppers.push(
      startPolling(() => this.pollAgents(), this.config.agentsPollMs, (err) => this.onPollError("agents", err)),
      startPolling(
        async () => void (await this.refreshLedger()),
        this.config.ledgerPollMs,
        (err) => this.onPollError("ledger", err),
      ),
      startPolling(() => this.pollPrs(), this.config.prPollMs, (err) => this.onPollError("pr", err)),
    );
  }

  stop(): void {
    for (const stopper of this.stoppers) stopper();
    this.stoppers = [];
  }

  private onPollError(kind: string, err: unknown): void {
    console.error(`poll(${kind}) failed:`, err instanceof Error ? err.message : err);
    if (kind === "agents") {
      // 取得に失敗した間は状態を「不明」にする（古い値を出し続けない）
      this.agents = null;
      void this.publish().catch(() => undefined);
    }
  }

  /** claude agents を 1 回取得して区切りを判定し、配信する（定期実行の本体。テストからも呼べる）。 */
  async pollAgents(): Promise<void> {
    // 不正な出力・実行失敗は null（=状態「不明」）。前回値は保持しない。
    this.agents = await fetchAgents(this.config.claudeBin);
    await this.detectBreaks();
    await this.flushPendingRenames();
    await this.flushInitialNames();
    await this.publish();
    await this.flushChatQueues();
  }

  /** claude agents を取るたびに、アプリのセッション id ごとの状態（取得失敗なら null）を渡す。自動クローズの標本用 */
  onAgentsSampled(listener: (states: ReadonlyMap<string, SessionState> | null, at: number) => void): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  private emitSample(states: ReadonlyMap<string, SessionState> | null): void {
    const at = Date.now();
    for (const l of this.sampleListeners) { try { l(states, at); } catch (e) { console.error("hub: sample listener failed:", e instanceof Error ? e.message : e); } }
  }

  /** 既存のセッションの表示名（Claude 側の名前を優先）が変わったときに呼ばれる（復元リストの保存し直し用）。 */
  onDisplayNameChanged(listener: () => void): () => void {
    this.nameListeners.add(listener);
    return () => this.nameListeners.delete(listener);
  }

  /** 部品の未送信の件数を配信に載せる。今の件数を読んでから、変更のたびに追従する。 */
  watchPicks(store: { onChange: (listener: (unsent: number) => void) => unknown; unsentCount: () => Promise<number> }): void {
    store.onChange((unsent) => this.setPicksUnsent(unsent));
    void store.unsentCount().then((n) => this.setPicksUnsent(n), (err) => this.onPollError("picks", err));
  }

  private setPicksUnsent(unsent: number): void {
    if (unsent === this.picksUnsent) return;
    this.picksUnsent = unsent;
    void this.publish().catch((err) => this.onPollError("publish", err));
  }

  /** セッションの様子の記録の版を配信に載せる。記録が増えるたびに版が進み、画面が右の欄を取り直す。 */
  watchActivity(
    store: { onChange: (listener: (rev: number) => void) => unknown; onTurnEnd: (listener: (e: TurnEndEvent) => void) => unknown; onSelfResume: (listener: (e: SelfResumeEvent) => void) => unknown; rev: number } & ChatSource,
  ): void {
    this.chatSource = store;
    this.activityRev = store.rev;
    store.onTurnEnd((e) => this.onTurnEnd(e));
    store.onSelfResume((e) => this.onSelfResume(e));
    store.onChange((rev) => {
      this.activityRev = rev;
      this.reconcileChatQueues();
      void this.publish().catch((err) => this.onPollError("publish", err));
    });
  }

  /** 返事の終わりの記録を、その会話番号を持つ窓に当てる。窓がまだ無ければ保留する（配信は onChange に任せる） */
  private onTurnEnd(e: TurnEndEvent): void {
    if (!this.applyTurnEnd(e)) this.pendingTurnEnds.push({ ...e, kind: "turnEnd", receivedAt: this.now() });
  }

  /** AI が自分で再開した記録を窓に当てる。窓がまだ無ければ返事の終わりと同じ保留に入れる */
  private onSelfResume(e: SelfResumeEvent): void {
    if (!this.applySelfResume(e)) {
      this.pendingTurnEnds.push({ kind: "selfResume", claudeSessionId: e.claudeSessionId, ts: e.ts, failed: false, stopHookActive: false, pendingSelfResume: null, receivedAt: this.now() });
    }
  }

  private applySelfResume(e: SelfResumeEvent): boolean {
    const windows = this.sessions.list().filter((s) => s.claudeSessionId === e.claudeSessionId);
    for (const w of windows) this.tracker.addSelfResume(w.id, e.ts);
    return windows.length > 0;
  }

  /** 会話番号を持つ全部の窓に当てる（同じ番号の窓が 2 つあれば両方）。結べる窓が無ければ false */
  private applyTurnEnd(e: TurnEndEvent): boolean {
    const windows = this.sessions.list().filter((s) => s.claudeSessionId === e.claudeSessionId);
    for (const w of windows) this.tracker.addTurnEnd(w.id, { ts: e.ts, stopHookActive: e.stopHookActive, failed: e.failed, pendingSelfResume: e.pendingSelfResume }, this.now());
    return windows.length > 0;
  }

  /** 保留を見直す。結べるものを ts の順に結び、残りのうち待つ長さを超えたものを捨てる（捨てた件数をログに 1 行）。結んだ件数を返す */
  private reviewPendingTurnEnds(bind: boolean): number {
    const now = this.now();
    const keep: typeof this.pendingTurnEnds = [];
    let bound = 0;
    let dropped = 0;
    const waitMs = Math.max(PENDING_TURN_END_MIN_MS, PENDING_TURN_END_POLLS * this.config.agentsPollMs);
    for (const p of [...this.pendingTurnEnds].sort((a, b) => a.ts - b.ts)) {
      if (bind && (p.kind === "selfResume" ? this.applySelfResume(p) : this.applyTurnEnd(p))) bound += 1;
      else if (now - p.receivedAt > waitMs) dropped += 1;
      else keep.push(p);
    }
    this.pendingTurnEnds = keep;
    if (dropped > 0) console.error(`unread: dropped ${dropped} unbound turn-end record(s)`);
    return bound;
  }

  /** 起動時の復元の結果（開き直せなかった項目）を画面の案内として載せる。 */
  setRestoreNotices(notices: readonly RestoreNotice[]): void {
    this.restoreNotices = [...notices];
    void this.publish().catch((err) => this.onPollError("publish", err));
  }

  /** 引き継ぎの進行を配信に載せる。 */
  setRelays(relays: readonly RelayView[]): void {
    this.relays = [...relays];
    void this.publish().catch((err) => this.onPollError("publish", err));
  }

  /** 書き込みの印を取る。付いていれば false（取れなかった）。書く直前に同期で呼ぶこと（await を挟まない）。 */
  tryBeginWrite(sessionId: string): boolean {
    if (this.writing.has(sessionId)) return false;
    this.writing.add(sessionId);
    return true;
  }

  /** 書き込みの印を外す。 */
  endWrite(sessionId: string): void {
    this.writing.delete(sessionId);
  }

  /** 送信の予約か名前の変更の予約が残っているか（引き継ぎの 409 判定用） */
  hasPendingWork(sessionId: string): boolean {
    return (this.chatQueue.get(sessionId)?.length ?? 0) > 0 || this.pendingRenames.has(sessionId);
  }

  /** claude agents を走らせず、直近の取得結果で入力してよい状態かを見る。取得結果が無いときは ok でない。 */
  async peekInput(sessionId: string): Promise<InputVerdict> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "session not found", hasClaude: false };
    const table = await readProcessTable().catch(() => null);
    if (table === null) return { ok: false, reason: "process list unavailable", hasClaude: false };
    return inputVerdict({ exited: session.exited, pids: descendantPids(session.term.pid, table) }, this.agents);
  }

  /** 名前の変更の要求。待機中ならすぐ反映し、作業中・許可待ち・状態不明なら端末に書かず予約する。 */
  async requestRename(sessionId: string, name: string): Promise<RenameMode> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionConflictError("session not found");
    const verdict = await this.checkInput(sessionId);
    if (session.exited) throw new SessionConflictError(verdict.reason ?? "session is stopped");
    if (verdict.ok) {
      const mode = this.applyRename(sessionId, name, verdict.hasClaude);
      if (mode === "queued") await this.publish();
      return mode;
    }
    this.pendingRenames.set(sessionId, name);
    this.dropInitialName(sessionId);
    await this.publish();
    return "queued";
  }

  /** 後から来た名前の変更が、起動直後の名前合わせより優先する（予約が先に反映されても、初回の名前を重ねて書かない） */
  private dropInitialName(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) delete session.initialName;
  }

  /**
   * 判定が ok のときの反映。Claude 起動中は /rename を送り、いなければアプリの名前を変える。予約は消す。
   * 端末に書く道では、書く直前に同期で書き込みの印を取る（取れなければ書かず、予約に入れて "queued"）。
   */
  private applyRename(sessionId: string, name: string, hasClaude: boolean): RenameMode {
    if (hasClaude) {
      this.dropInitialName(sessionId);
      if (!this.tryBeginWrite(sessionId)) {
        this.pendingRenames.set(sessionId, name);
        return "queued";
      }
      try {
        this.pendingRenames.delete(sessionId);
        const session = this.sessions.get(sessionId);
        if (session) this.sessions.write(session, `/rename ${name}\r`);
      } finally {
        this.endWrite(sessionId);
      }
      return "claude";
    }
    this.pendingRenames.delete(sessionId);
    this.sessions.rename(sessionId, name);
    // Claude 起動前の改名: 初回の名前合わせは消さず、PO の新しい名前に差し替える（起動後に送る名前が PO の名前になる）
    const session = this.sessions.get(sessionId);
    if (session && session.initialName !== undefined) session.initialName = name;
    return "app";
  }

  /** 定期取得のたびに予約を見る。待機になっていたら、要求時と同じ取り直し判定を通ったときだけ 1 回送る。 */
  private async flushPendingRenames(): Promise<void> {
    if (this.pendingRenames.size === 0) return;
    const table = await readProcessTable().catch(() => []);
    for (const [id, name] of [...this.pendingRenames]) {
      try {
        const session = this.sessions.get(id);
        if (!session || session.exited) {
          this.pendingRenames.delete(id);
          continue;
        }
        if (this.writing.has(id)) continue;
        const polled = inputVerdict({ exited: false, pids: descendantPids(session.term.pid, table) }, this.agents);
        if (!polled.ok) continue;
        const verdict = await this.checkInput(id);
        // 取り直している間に予約が消えた・差し替わった場合は、その予約を尊重する
        if (verdict.ok && this.pendingRenames.get(id) === name) this.applyRename(id, name, verdict.hasClaude);
      } catch (err) {
        this.onPollError("rename", err);
      }
    }
  }

  /**
   * 起動直後の名前合わせ。initialName を持つセッションに、Claude が入力待ちになってから /rename を 1 回だけ送る。
   * 先に定期取得の値（this.agents）だけで見て、書く見込みがあるときだけ checkInput で取り直す。
   */
  private async flushInitialNames(): Promise<void> {
    const targets = this.sessions.list().filter((s) => s.initialName !== undefined);
    if (targets.length === 0) return;
    // ps が失敗したときは、子孫の判定が当てにならないので書かない（送信の予約と同じ扱い）
    const table = await readProcessTable().catch(() => null);
    if (table === null) return;
    for (const session of targets) {
      try {
        const initialName = session.initialName;
        if (initialName === undefined) continue;
        if (session.exited || this.pendingRenames.has(session.id) || Date.now() - session.createdAt > INITIAL_NAME_MAX_MS) {
          delete session.initialName;
          continue;
        }
        if (this.writing.has(session.id)) continue;
        const info = { exited: false, pids: descendantPids(session.term.pid, table) };
        const agent = agentForSession(info, this.agents);
        if (agent === undefined || !inputVerdict(info, this.agents).ok) continue;
        if (agent.name === initialName) {
          delete session.initialName;
          continue;
        }
        const verdict = await this.checkInput(session.id);
        // 取り直している間に、予約・終了・差し替えがあれば尊重する
        if (session.initialName !== initialName || session.exited || this.pendingRenames.has(session.id)) continue;
        if (!verdict.ok || !verdict.hasClaude) continue;
        if (!this.tryBeginWrite(session.id)) continue;
        try {
          this.sessions.write(session, `/rename ${initialName}\r`);
        } finally {
          this.endWrite(session.id);
        }
        delete session.initialName;
      } catch (err) {
        this.onPollError("initial-name", err);
      }
    }
  }

  /** 新しく開いたセッションへ /rename を 1 回書く（書き込みの印を取れなければ書かず false）。 */
  sendName(sessionId: string, name: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    if (!this.tryBeginWrite(sessionId)) return false;
    try {
      this.sessions.write(session, `/rename ${name}\r`);
    } finally {
      this.endWrite(sessionId);
    }
    return true;
  }

  /** case-say の判定 4・4b。すべてサーバーのメモリの記録で決める。同期（tmux を 1 回だけ同期で聞く） */
  private caseSayTarget(caseId: string): ({ ok: true } & CaseSayTarget) | { ok: false; reason: string; claudeVersion?: string } {
    const session = this.sessions.get(caseId);
    if (!session || session.exited) return { ok: false, reason: "no_session" };
    if (this.sessions.isClosing(caseId)) return { ok: false, reason: "closing" };
    const CH = this.sessions.caseHomeOf(caseId);
    const R = this.sessions.caseRootOf(caseId);
    if (CH === undefined || R === undefined) return { ok: false, reason: "not_case_session" };
    if (session.reattached === true) return { ok: false, reason: "reattached" };
    const main = this.sessions.caseMainProcesses().get(caseId);
    if (main === undefined) return { ok: false, reason: "no_main_record" };
    const lstart = this.caseSayPorts.readLstart(main.pid);
    if (lstart === null || lstart !== main.lstart) return { ok: false, reason: "main_changed" };
    const pane = this.sessions.casePaneInfo(caseId);
    if (pane === null) return { ok: false, reason: "pane_unreadable" };
    if (pane.panePid !== main.pid || pane.windows !== 1 || pane.panes !== 1) return { ok: false, reason: "pane_changed" };
    const state = session.term.writeState?.();
    if (state === undefined || !state.writable || state.pending !== 0) return { ok: false, reason: "terminal_not_ready" };
    // 4b: 件を開くときに解いた claude の実体の道の最後の名前が版の形で、config の並びにあること
    const real = this.sessions.caseClaudeRealOf(caseId);
    const last = real === undefined ? "" : path.basename(real);
    const claudeVersion = CLAUDE_VERSION_PATTERN.test(last) ? last : "";
    if (claudeVersion === "" || !this.config.caseSayClaudeVersions.includes(claudeVersion)) return { ok: false, reason: "claude_version_unverified", claudeVersion };
    return { ok: true, session, mainPid: main.pid, paneId: pane.paneId, CH, R, claudeVersion };
  }

  /** case-say の判定 7（状態ファイルと agents の取り直し） */
  private async caseSayState(t: CaseSayTarget): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [rows, table] = await Promise.all([this.caseSayPorts.fetchAgents(this.config.claudeBin), this.caseSayPorts.readTable().catch(() => null)]);
    if (table === null) return { ok: false, reason: "process_list_unavailable" };
    const pids = descendantPids(t.mainPid, table);
    return caseSayVerdict({ state: readCaseStateFile(t.CH, pids), pids, rows });
  }

  /**
   * 件のセッションへ決まった一文を 1 回送る（design §14-10-3 (a) の 4〜9）。1〜3（認証・本文・呼び出し元）は受け口が済ませている。
   * 外れたら端末へ何も書かずに 409。貼り付けを書いた後に Enter を送り切らずに終えたら、止めの印を付ける（次の呼び出しは 409）
   */
  async caseSay(input: { caseId: string; stepFile: string }): Promise<CaseSayResult> {
    const { caseId, stepFile } = input;
    const refuse = (reason: string, extra: Partial<CaseSayResult> = {}): CaseSayResult => ({ status: 409, reason, ...extra });
    // 4 / 4b
    const target = this.caseSayTarget(caseId);
    if (!target.ok) return refuse(target.reason, target.claudeVersion !== undefined ? { claudeVersion: target.claudeVersion } : {});
    const { session, claudeVersion } = target;
    const base = { claudeVersion };
    // 5 止めの印
    if (this.caseSayStopped.get(caseId) === session) return refuse("stopped_after_paste", base);
    // 6 手順ファイル
    const stepSha16 = readStepFileSha16(target.R, stepFile);
    if (stepSha16 === undefined) return refuse("step_file_unusable", base);
    const text = caseSayText(target.R, stepFile);
    const hashes = { ...base, textSha16: sha16(text), stepSha16 };
    // 7 件の状態
    const state = await this.caseSayState(target);
    if (!state.ok) return refuse(state.reason, hashes);
    // 8 書き込みの印
    if (!this.tryBeginWrite(caseId)) return refuse("write_in_progress", hashes);
    let pasted = false;
    let completed = false;
    try {
      const term = session.term;
      if (term.sendToPane === undefined || term.queryPanePid === undefined) return refuse("terminal_not_ready", hashes);
      // 9 (1) 括弧付きの文を、区画 %N への条件付きの送り方で貼る。ここから先、Enter を送り切らずに終えたら止めの印
      pasted = true;
      const paste = await term.sendToPane(target.paneId, target.mainPid, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
      if (!paste.written) return refuse("pane_changed_during_paste", hashes);
      // (2)
      await this.caseSayPorts.sleep(this.config.pasteSubmitDelayMs);
      // (3) 4・7 をもう一度（区画の番号が同じことを含む）
      const again = this.caseSayTarget(caseId);
      if (!again.ok || again.session !== session || again.paneId !== target.paneId) return refuse("state_changed_before_enter", hashes);
      const stateAgain = await this.caseSayState(again);
      if (!stateAgain.ok) return refuse("state_changed_before_enter", hashes);
      // (4) Enter（0d）
      const enter = await term.sendToPane(target.paneId, target.mainPid, "\r");
      if (!enter.written) return refuse("enter_not_sent", hashes);
      // (5) 送った後の区画の pid
      const pid = await term.queryPanePid(target.paneId);
      if (pid !== target.mainPid) return refuse("enter_not_confirmed", hashes);
      completed = true;
      return { status: 200, ...hashes };
    } finally {
      if (pasted && !completed) this.caseSayStopped.set(caseId, session);
      this.endWrite(caseId);
    }
  }

  /** そのセッションの送信の予約（古い順）。画面の写し用 */
  chatQueueOf(sessionId: string): ChatQueueItem[] {
    return [...(this.chatQueue.get(sessionId) ?? [])];
  }

  /**
   * 送信の予約を足す。端末へは何も書かない（書くのは flushChatQueue だけ）。停止中は 409、上限を超えたら 409。
   * 足したあと、書いてよい状態ならすぐ送るよう flush を 1 回起こす（応答は待たせない）。
   */
  enqueueChat(sessionId: string, text: string): ChatQueueItem {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError("session not found");
    if (session.exited) throw new SessionConflictError("session is stopped");
    const items = this.chatQueue.get(sessionId) ?? [];
    if (items.length >= CHAT_QUEUE_MAX) throw new SessionConflictError(`chat queue is full (max ${CHAT_QUEUE_MAX})`);
    const item: ChatQueueItem = { id: randomUUID(), text, createdAt: Date.now(), state: "queued" };
    this.chatQueue.set(sessionId, [...items, item]);
    // 予約に積めた時点で、PO が送ったものとして未読を消す（配信は bumpChat に任せる）
    this.tracker.clear(sessionId, this.now());
    this.bumpChat();
    void this.flushChatQueue(sessionId).catch((err) => this.onPollError("chat", err));
    return item;
  }

  /** 予約を取り消す。送信済み（Claude の受け取りを確認できていないもの）も消せる。端末には何も書かず、送信済みを消すときは見張りも消す。 */
  cancelChat(sessionId: string, queueId: string): void {
    const items = this.chatQueue.get(sessionId) ?? [];
    const target = items.find((i) => i.id === queueId);
    if (!target) throw new SessionNotFoundError("queue item not found");
    if (target.state === "sent") this.chatSentGuard.delete(sessionId);
    this.setChatItems(sessionId, items.filter((i) => i.id !== queueId));
    this.bumpChat();
  }

  private setChatItems(sessionId: string, items: ChatQueueItem[]): void {
    if (items.length === 0) this.chatQueue.delete(sessionId);
    else this.chatQueue.set(sessionId, items);
  }

  private dropChatState(sessionId: string): void {
    const had = this.chatQueue.has(sessionId);
    this.chatQueue.delete(sessionId);
    this.chatSentGuard.delete(sessionId);
    this.chatConsumedSeq.delete(sessionId);
    this.chatFlushing.delete(sessionId);
    if (had) this.bumpChat();
  }

  /** 画面が取り直すよう、配信の版を進める */
  private bumpChat(): void {
    this.chatRev += 1;
    void this.publish().catch((err) => this.onPollError("publish", err));
  }

  /** 記録が増えたとき。送信済みの予約は、送った後の seq で role=user の記録が届いたら外し、見張りも消す（本文の一致は見ない）。 */
  private reconcileChatQueues(): void {
    const source = this.chatSource;
    if (source === null) return;
    for (const [id, items] of [...this.chatQueue]) {
      const claudeId = this.sessions.get(id)?.claudeSessionId;
      if (claudeId === undefined) continue;
      let consumed = this.chatConsumedSeq.get(id) ?? 0;
      let next = items;
      for (const item of items) {
        if (item.state !== "sent" || item.sentAtSeq === undefined) continue;
        const hit = source.chat(claudeId, Math.max(item.sentAtSeq, consumed)).items.find((r) => r.role === "user");
        if (hit === undefined) break;
        consumed = hit.seq;
        next = next.filter((i) => i.id !== item.id);
      }
      if (next !== items) {
        this.chatConsumedSeq.set(id, consumed);
        this.setChatItems(id, next);
        this.bumpChat();
      }
    }
    for (const [id, guard] of [...this.chatSentGuard]) {
      const claudeId = this.sessions.get(id)?.claudeSessionId;
      if (claudeId === undefined || guard.sentSeq === null) continue;
      if (source.chat(claudeId, guard.sentSeq).items.some((r) => r.role === "user")) this.chatSentGuard.delete(id);
    }
  }

  /** 予約か見張りがあるセッションを 1 回ずつ flush する（定期取得のたびに呼ぶ） */
  async flushChatQueues(): Promise<void> {
    const ids = new Set([...this.chatQueue.keys(), ...this.chatSentGuard.keys()]);
    await Promise.all([...ids].map((id) => this.flushChatQueue(id).catch((err) => this.onPollError("chat", err))));
  }

  /**
   * 手が空いていれば、そのセッションの古い予約を 1 件だけ端末へ書く。
   * 条件: 予約がある／見張りが無い／定期取得の値で idle かつ待ちなし／書く直前の取り直しでも同じ。
   * Claude 起動中は括弧付きで貼ってから submitDelayMs 待って Enter。待った後に、取り消し・終了があれば Enter は送らない。
   */
  async flushChatQueue(sessionId: string): Promise<void> {
    if (this.chatFlushing.has(sessionId)) return;
    this.chatFlushing.add(sessionId);
    try {
      await this.flushChatQueueOnce(sessionId);
    } finally {
      this.chatFlushing.delete(sessionId);
    }
  }

  private async flushChatQueueOnce(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.exited) {
      this.dropChatState(sessionId);
      return;
    }
    // ps が失敗したときは、子孫の判定が当てにならないので送らない（このコードの側だけで扱う）
    const table = await readProcessTable().catch(() => null);
    if (table === null) return;
    const info = { exited: false, pids: descendantPids(session.term.pid, table) };
    // 送った後の見張り (a): 作業中か確認待ちを観測したら外す
    const status = agentForSession(info, this.agents)?.status;
    const guard = this.chatSentGuard.get(sessionId);
    if (status === "waiting" || (status === "busy" && guard?.sentWhile !== "busy")) this.chatSentGuard.delete(sessionId);
    // busy で送った分は、idle を観測したら外す（user の記録が来なくても次へ進める）
    if (status === "idle" && guard?.sentWhile === "busy") this.chatSentGuard.delete(sessionId);
    const next = (this.chatQueue.get(sessionId) ?? []).find((i) => i.state === "queued");
    if (next === undefined || this.chatSentGuard.has(sessionId)) return;
    if (!chatVerdict(info, this.agents).ok) return;
    const verdict = await this.checkChat(sessionId);
    if (!verdict.ok) return;
    // 取り直している間に、取り消し・差し替わり・見張りの再設定があれば尊重する
    const current = (this.chatQueue.get(sessionId) ?? []).find((i) => i.id === next.id);
    if (current === undefined || current.state !== "queued" || this.chatSentGuard.has(sessionId) || session.exited) return;
    const claudeId = session.claudeSessionId;
    const sentSeq = verdict.hasClaude && claudeId !== undefined && this.chatSource !== null ? this.chatSource.chat(claudeId, Number.MAX_SAFE_INTEGER).lastSeq : null;
    // 書き込みの印を取れなければ、予約も見張りも触らずに戻る（次の定期取得で再び試す）
    if (!this.tryBeginWrite(sessionId)) return;
    try {
      // await の前に同期で sent にする（同時の実行・取り消しとの競合を避ける）
      this.setChatItems(sessionId, (this.chatQueue.get(sessionId) ?? []).map((i) => (i.id === next.id ? { ...i, state: "sent", ...(sentSeq !== null ? { sentAtSeq: sentSeq } : {}) } : i)));
      if (verdict.hasClaude) this.chatSentGuard.set(sessionId, { sentSeq, sentWhile: verdict.mode === "busy" ? "busy" : "idle" });
      this.bumpChat();
      this.sessions.write(session, verdict.hasClaude ? `${BRACKETED_PASTE_START}${next.text}${BRACKETED_PASTE_END}` : next.text);
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.pasteSubmitDelayMs));
      const stillThere = (this.chatQueue.get(sessionId) ?? []).some((i) => i.id === next.id);
      if (!stillThere || session.exited || this.sessions.get(sessionId) !== session || this.sessions.isClosing(sessionId)) return;
      this.sessions.write(session, "\r");
      // 素のシェルには「受け取りの記録」が来ないので、Enter を送ったら予約から外す
      if (!verdict.hasClaude) {
        this.setChatItems(sessionId, (this.chatQueue.get(sessionId) ?? []).filter((i) => i.id !== next.id));
        this.bumpChat();
      }
    } finally {
      this.endWrite(sessionId);
    }
  }

  /**
   * 定期実行が開いたセッションへ指示を送る。括弧付き貼り付けで本文 → pasteSubmitDelayMs 待つ → Enter。
   * 待つ間にセッションが終わった・閉じ始めたときは Enter を送らず false。
   */
  async submitText(sessionId: string, text: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    // 書き込みの印が取れるまで待つ（200ms ごと・最大 10 秒）。取れなければ書かず false
    const deadline = Date.now() + WRITE_WAIT_MAX_MS;
    while (!this.tryBeginWrite(sessionId)) {
      if (Date.now() >= deadline) return false;
      await sleep(WRITE_WAIT_POLL_MS);
      if (session.exited || this.sessions.get(sessionId) !== session || this.sessions.isClosing(sessionId)) return false;
    }
    try {
      this.sessions.write(session, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.pasteSubmitDelayMs));
      if (session.exited || this.sessions.get(sessionId) !== session || this.sessions.isClosing(sessionId)) return false;
      this.sessions.write(session, "\r");
      return true;
    } finally {
      this.endWrite(sessionId);
    }
  }

  /** 前回の status と比べ、区切りがあれば未読を増やして macOS 通知を出す。取得失敗の間は何も判定しない。 */
  private async detectBreaks(): Promise<void> {
    await this.attachCaseSessionIds();
    this.tracker.sweepStale(this.now());
    if (this.agents === null) { this.reviewPendingTurnEnds(false); this.emitSample(null); return; }
    const table = await readProcessTable().catch(() => []);
    const states = new Map<string, SessionState>();
    for (const s of this.sessions.list()) {
      const agent = agentForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents);
      states.set(s.id, stateForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents));
      // Claude の sessionId を知ったら控える（再起動のあとに同じ会話を開き直すため。UUID の形でなければ無視される）
      if (agent?.sessionId !== undefined) {
        // 件の番号は件の処理（attachCaseSessionIds）だけが付ける。件には付けず、同じ番号を持つ件があれば毎回外す
        if (this.sessions.caseHomeOf(s.id) === undefined) this.sessions.setClaudeSessionId(s.id, agent.sessionId);
        for (const other of this.sessions.list()) if (other.id !== s.id && other.claudeSessionId === agent.sessionId) this.sessions.clearCaseClaudeSessionId(other.id);
      }
      const isBreak = this.tracker.observe(s.id, agent?.status ?? null, agent?.waitingFor, this.now());
      if (isBreak && agent && (agent.status === "waiting" || agent.status === "idle")) {
        this.sendNotification?.(breakBody(agent.name ?? s.name, agent.status));
      }
    }
    this.reviewPendingTurnEnds(true);
    this.emitSample(states);
  }

  /**
   * 件のセッションに会話の番号を付ける（case-home の sessions/<pid>.json を部屋の外で読む）。
   * 件が無い回・直前の claude agents --json が失敗した回は何もしない。例外は外へ出さない（出すと全部のセッションの状態が不明になる）。
   */
  private async attachCaseSessionIds(): Promise<void> {
    try {
      const cases = this.sessions.list().filter((s) => !s.exited && this.sessions.caseHomeOf(s.id) !== undefined);
      if (cases.length === 0 || this.agents === null) return;
      const table = await readProcessTable().catch(() => null);
      if (table === null) return;
      const agentIds = new Set(this.agents.flatMap((a) => (a.sessionId !== undefined ? [a.sessionId] : [])));
      for (const s of cases) {
        const ch = this.sessions.caseHomeOf(s.id);
        if (ch === undefined) continue;
        const taken = new Set(agentIds);
        for (const o of this.sessions.list()) if (o.id !== s.id && o.claudeSessionId !== undefined) taken.add(o.claudeSessionId);
        if (s.claudeSessionId !== undefined && taken.has(s.claudeSessionId)) this.sessions.clearCaseClaudeSessionId(s.id);
        const found = readCaseClaudeSessionId(ch, descendantPids(s.term.pid, table));
        if (found !== undefined && !taken.has(found)) this.sessions.setClaudeSessionId(s.id, found);
      }
    } catch (err) {
      console.error("case session id: failed", err instanceof Error ? err.message : String(err));
    }
  }

  /** 行を選んだとき。変化があれば購読者へ配信する。 */
  markRead(sessionId: string): Promise<void> {
    return this.clearUnread(sessionId);
  }

  /** PO がその窓へ送ったとき（端末の Enter・チャット欄）。未読を消し、数が変わったら配信する。 */
  clearUnread(sessionId: string): Promise<void> {
    return this.tracker.clear(sessionId, this.now()) ? this.publish() : Promise.resolve();
  }

  /**
   * 端末へ入れてよいかを、要求を受けた時点で `claude agents --json` を取り直して判定する（定期取得の値は使わない）。
   */
  async checkInput(sessionId: string): Promise<InputVerdict> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "session not found", hasClaude: false };
    const [rows, table] = await Promise.all([fetchAgents(this.config.claudeBin), readProcessTable().catch(() => [])]);
    return inputVerdict({ exited: session.exited, pids: descendantPids(session.term.pid, table) }, rows);
  }

  /** チャットの払い出し用。checkInput と同じ取り直しだが、作業中（待ちなし）も可（chatVerdict） */
  async checkChat(sessionId: string): Promise<ReturnType<typeof chatVerdict>> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "session not found", hasClaude: false };
    const [rows, table] = await Promise.all([fetchAgents(this.config.claudeBin), readProcessTable().catch(() => [])]);
    return chatVerdict({ exited: session.exited, pids: descendantPids(session.term.pid, table) }, rows);
  }

  /** 一覧と同じ表示名（Claude の name 優先）。直近の snapshot の値で、ps は走らせない。まだ無いセッションは含まない。 */
  displayNames(): ReadonlyMap<string, string> {
    return this.lastNames;
  }

  /** 同時に複数回呼ばれても実行は 1 本にまとめる。 */
  refreshLedger(): Promise<LedgerSnapshot> {
    if (this.ledgerInFlight) return this.ledgerInFlight;
    const run = loadLedger(this.config.salesanchorRoot, this.config.ledgerDir, this.config.ledgerLookupScript)
      .then((snap) => (this.ledger = snap))
      .finally(() => (this.ledgerInFlight = null));
    this.ledgerInFlight = run;
    return run;
  }

  getLedger(): LedgerSnapshot | null {
    return this.ledger;
  }

  /** 作業場所を照合して (repo, branch) を決める。外れたら 409（git も gh も実行しない）、無いセッションは 404。 */
  private async locatePr(sessionId: string): Promise<{ dir: string; key: string | null; target?: PrTarget; immediate?: PrResponse }> {
    const wp = await resolveWorkplace({ sessions: this.sessions, config: this.config }, sessionId);
    const found = await resolveTarget(wp.dir);
    if (found.kind === "immediate") {
      this.prKeyOfSession.set(sessionId, null);
      return { dir: wp.dir, key: null, immediate: found.response };
    }
    const key = `${found.target.repo}#${found.target.branch}`;
    this.prKeyOfSession.set(sessionId, key);
    return { dir: wp.dir, key, target: found.target };
  }

  /** メモリの写しを返すだけ（gh は呼ばない）。写しが無ければ loading。 */
  async getPr(sessionId: string): Promise<PrResponse> {
    const at = await this.locatePr(sessionId);
    if (at.immediate) return at.immediate;
    return this.prByKey.get(at.key as string) ?? { status: "loading" };
  }

  /** そのセッションの分だけ、すぐに取り直す。前回から prRefreshMinMs 以内なら取り直さず、今の結果を返す。 */
  async refreshPr(sessionId: string): Promise<PrResponse> {
    const at = await this.locatePr(sessionId);
    if (at.immediate) return at.immediate;
    const key = at.key as string;
    const previous = this.prByKey.get(key);
    if (!this.prInFlight.has(key) && previous?.fetchedAt !== undefined && Date.now() - previous.fetchedAt < this.config.prRefreshMinMs) return previous;
    const result = await this.fetchPrOnce(key, at.target as PrTarget, at.dir);
    await this.publish().catch((err) => this.onPollError("publish", err));
    return result;
  }

  /** 同じ (repo, branch) の取得が同時に走るときは 1 本にまとめる（refreshLedger と同じ作法）。 */
  private fetchPrOnce(key: string, target: PrTarget, dir: string): Promise<PrResponse> {
    const running = this.prInFlight.get(key);
    if (running) return running;
    const run = fetchPr(target, { ghBin: this.config.ghBin, cwd: dir, timeoutMs: this.ghTimeoutMs })
      .then((result) => {
        this.prByKey.set(key, result);
        return result;
      })
      .finally(() => this.prInFlight.delete(key));
    this.prInFlight.set(key, run);
    return run;
  }

  /**
   * PR と検査の定期の取り直し（テストからも呼べる）。動いているセッションの作業場所を照合し、(repo, branch) ごとに 1 回だけ gh を呼ぶ。
   * マージ済みかクローズで実行中の検査が無いものは取り直さない。利用の上限に当たったら、その回の残りはやめる。
   */
  async pollPrs(): Promise<void> {
    const groups = new Map<string, { target: PrTarget; dir: string }>();
    for (const s of this.sessions.list()) {
      if (s.exited) continue;
      try {
        const at = await this.locatePr(s.id);
        if (at.target && at.key !== null && !groups.has(at.key)) groups.set(at.key, { target: at.target, dir: at.dir });
      } catch (err) {
        // 作業場所が対象外（409）やセッションの消失は、この回は見ないだけ（前回の紐づけと写しは残す）
        if (!(err instanceof SessionConflictError) && !(err instanceof SessionNotFoundError)) this.onPollError("pr", err);
      }
    }
    for (const [key, group] of groups) {
      const previous = this.prByKey.get(key);
      if (previous && isSettled(previous)) continue;
      const result = await this.fetchPrOnce(key, group.target, group.dir);
      if (result.status === "rateLimited") break;
    }
    // 写しの掃除は、どのセッション（終了したものも含む）にも紐づかない key だけ
    const referenced = new Set<string>();
    for (const s of this.sessions.list()) {
      const key = this.prKeyOfSession.get(s.id);
      if (key) referenced.add(key);
    }
    for (const key of [...this.prByKey.keys()]) if (!referenced.has(key)) this.prByKey.delete(key);
    await this.publish();
  }

  private ciOfSession(sessionId: string): CiState | undefined {
    const key = this.prKeyOfSession.get(sessionId);
    const cached = key === undefined || key === null ? undefined : this.prByKey.get(key);
    return ciOfResponse(cached);
  }

  async snapshot(): Promise<Snapshot> {
    const table = await readProcessTable().catch(() => []);
    const views = this.sessions.list().map((s): SessionView => {
      const info = { exited: s.exited, pids: descendantPids(s.term.pid, table) };
      const agent = agentForSession(info, this.agents);
      const ci = this.ciOfSession(s.id);
      return {
        id: s.id,
        // Claude 起動中は Claude 側の名前が正本。無ければアプリが付けた名前
        name: agent?.name !== undefined && agent.name !== "" ? agent.name : s.name,
        roleId: s.roleId,
        branch: s.branch,
        cwd: s.cwd,
        createdAt: s.createdAt,
        state: stateForSession(info, this.agents),
        unread: this.tracker.unreadOf(s.id),
        hasClaude: agent !== undefined,
        canInput: inputVerdict(info, this.agents).ok,
        canChat: chatVerdict(info, this.agents).ok,
        ...(this.pendingRenames.has(s.id) ? { pendingName: this.pendingRenames.get(s.id) } : {}),
        ...(ci !== undefined ? { ci } : {}),
        ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),
      };
    });
    const previous = this.lastNames;
    this.lastNames = new Map(views.map((v) => [v.id, v.name]));
    if (views.some((v) => previous.has(v.id) && previous.get(v.id) !== v.name)) for (const l of this.nameListeners) l();
    return { sessions: views, agentsAvailable: this.agents !== null, restoreNotices: this.restoreNotices, ...terminalNoticesField(this.sessions.terminalNotices()), maxSessions: this.sessions.maxSessionCount(), openCount: this.sessions.openCount(), picksUnsent: this.picksUnsent, activityRev: this.activityRev + this.chatRev, ...(this.relays.length > 0 ? { relays: this.relays } : {}) };
  }

  subscribe(ws: WebSocket): void {
    this.subscribers.add(ws);
    // 過大フレームなどのエラー: ws がこの接続だけを 1009 等で閉じる。ここで受けてプロセスを落とさない
    ws.on("error", () => undefined);
    ws.on("close", () => this.subscribers.delete(ws));
    void this.snapshot().then((snap) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snap));
    });
  }

  private async publish(): Promise<void> {
    const snap = await this.snapshot();
    const payload = JSON.stringify(snap);
    if (payload === this.lastPayload) return;
    this.lastPayload = payload;
    for (const ws of this.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

const terminalNoticesField = (notices: TerminalNotice[]): { terminalNotices?: TerminalNotice[] } => (notices.length > 0 ? { terminalNotices: notices } : {});
