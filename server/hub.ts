import type { WebSocket } from "ws";
import { agentForSession, fetchAgents, inputVerdict, stateForSession, type AgentRow, type InputVerdict, type SessionState } from "./agents.ts";
import type { Config } from "./config.ts";
import { loadLedger, type LedgerSnapshot } from "./ledger.ts";
import { ciOf as ciFromCounts, fetchPr, isSettled, resolveTarget, type CiState, type PrResponse, type PrTarget } from "./pr-status.ts";
import { BreakTracker, breakBody, osascriptSender, type NotificationSender } from "./notify.ts";
import { startPolling } from "./poll.ts";
import { descendantPids, readProcessTable } from "./process-tree.ts";
import type { RestoreNotice } from "./restore.ts";
import { SessionConflictError, SessionNotFoundError, type SessionManager } from "./sessions.ts";
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
  /** 名前の変更を予約中のとき、その名前（待機になったら自動で送る）。予約が無ければ項目ごと無い */
  pendingName?: string;
  /** そのセッションのブランチの PR の検査の要約（PR が無い・検査が 0 件・まだ取れていないときは項目ごと無い） */
  ci?: CiState;
}

/** 名前の変更の結果。queued は端末へ何も書かず予約した */
export type RenameMode = "claude" | "app" | "queued";

export interface Snapshot {
  sessions: SessionView[];
  agentsAvailable: boolean;
  /** 起動時に前回のセッションを開き直せなかった理由（メモリだけ。画面の案内） */
  restoreNotices: RestoreNotice[];
  /** 部品タブの件数: まだ Claude に送っていない部品の数 */
  picksUnsent: number;
}

/** claude agents の定期取得と台帳の定期取得をまとめ、変化があれば購読者へ配信する。 */
export class Hub {
  private agents: AgentRow[] | null = null;
  private ledger: LedgerSnapshot | null = null;
  private ledgerInFlight: Promise<LedgerSnapshot> | null = null;
  private subscribers = new Set<WebSocket>();
  private lastPayload = "";
  private stoppers: Array<() => void> = [];
  private readonly tracker = new BreakTracker();
  /** 直近の snapshot の表示名（ps を走らせずに名前だけ欲しい呼び出し用） */
  private lastNames = new Map<string, string>();
  private readonly sendNotification: NotificationSender | null;
  /** 名前の変更の予約（セッション id → 名前）。メモリだけ。送るか捨てるまでの正本はここ */
  private readonly pendingRenames = new Map<string, string>();
  private restoreNotices: RestoreNotice[] = [];
  private picksUnsent = 0;
  private readonly nameListeners = new Set<() => void>();
  /** PR と検査の写し（(repo, branch) ごと）。メモリだけ。正本は GitHub */
  private readonly prByKey = new Map<string, PrResponse>();
  /** セッションが今どの (repo, branch) を見ているか。GitHub のリポジトリでない・ブランチにいないときは null */
  private readonly prKeyOfSession = new Map<string, string | null>();
  private readonly prInFlight = new Map<string, Promise<PrResponse>>();
  private readonly ghTimeoutMs: number | undefined;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    sendNotification?: NotificationSender | null,
    options: { ghTimeoutMs?: number } = {},
  ) {
    this.ghTimeoutMs = options.ghTimeoutMs;
    this.sendNotification = sendNotification !== undefined ? sendNotification : config.notify.macos ? osascriptSender(config.notify.osascriptBin) : null;
    sessions.onChange(() => void this.publish().catch((err) => this.onPollError("publish", err)));
    // 一覧から外したセッションの前回の status・未読は持ち続けない
    sessions.onRemoved((id) => {
      this.tracker.forget(id);
      this.pendingRenames.delete(id);
      this.prKeyOfSession.delete(id);
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
    await this.publish();
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

  /** 起動時の復元の結果（開き直せなかった項目）を画面の案内として載せる。 */
  setRestoreNotices(notices: readonly RestoreNotice[]): void {
    this.restoreNotices = [...notices];
    void this.publish().catch((err) => this.onPollError("publish", err));
  }

  /** 名前の変更の要求。待機中ならすぐ反映し、作業中・許可待ち・状態不明なら端末に書かず予約する。 */
  async requestRename(sessionId: string, name: string): Promise<RenameMode> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionConflictError("session not found");
    const verdict = await this.checkInput(sessionId);
    if (session.exited) throw new SessionConflictError(verdict.reason ?? "session is stopped");
    if (verdict.ok) return this.applyRename(sessionId, name, verdict.hasClaude);
    this.pendingRenames.set(sessionId, name);
    await this.publish();
    return "queued";
  }

  /** 判定が ok のときの反映。Claude 起動中は /rename を送り、いなければアプリの名前を変える。予約は消す。 */
  private applyRename(sessionId: string, name: string, hasClaude: boolean): "claude" | "app" {
    this.pendingRenames.delete(sessionId);
    if (hasClaude) {
      const session = this.sessions.get(sessionId);
      if (session) this.sessions.write(session, `/rename ${name}\r`);
      return "claude";
    }
    this.sessions.rename(sessionId, name);
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

  /** 前回の status と比べ、区切りがあれば未読を増やして macOS 通知を出す。取得失敗の間は何も判定しない。 */
  private async detectBreaks(): Promise<void> {
    if (this.agents === null) return;
    const table = await readProcessTable().catch(() => []);
    for (const s of this.sessions.list()) {
      const agent = agentForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents);
      // Claude の sessionId を知ったら控える（再起動のあとに同じ会話を開き直すため。UUID の形でなければ無視される）
      if (agent?.sessionId !== undefined) this.sessions.setClaudeSessionId(s.id, agent.sessionId);
      const isBreak = this.tracker.observe(s.id, agent?.status ?? null);
      if (isBreak && agent && (agent.status === "waiting" || agent.status === "idle")) {
        this.sendNotification?.(breakBody(agent.name ?? s.name, agent.status));
      }
    }
  }

  /** 行を選んだとき。変化があれば購読者へ配信する。 */
  markRead(sessionId: string): Promise<void> {
    return this.tracker.markRead(sessionId) ? this.publish() : Promise.resolve();
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
    return cached?.status === "ok" ? (ciFromCounts(cached.checks.counts) ?? undefined) : undefined;
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
        ...(this.pendingRenames.has(s.id) ? { pendingName: this.pendingRenames.get(s.id) } : {}),
        ...(ci !== undefined ? { ci } : {}),
      };
    });
    const previous = this.lastNames;
    this.lastNames = new Map(views.map((v) => [v.id, v.name]));
    if (views.some((v) => previous.has(v.id) && previous.get(v.id) !== v.name)) for (const l of this.nameListeners) l();
    return { sessions: views, agentsAvailable: this.agents !== null, restoreNotices: this.restoreNotices, picksUnsent: this.picksUnsent };
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
