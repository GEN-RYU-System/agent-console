import type { WebSocket } from "ws";
import { agentForSession, fetchAgents, inputVerdict, stateForSession, type AgentRow, type InputVerdict, type SessionState } from "./agents.ts";
import type { Config } from "./config.ts";
import { loadLedger, type LedgerSnapshot } from "./ledger.ts";
import { BreakTracker, breakBody, osascriptSender, type NotificationSender } from "./notify.ts";
import { startPolling } from "./poll.ts";
import { descendantPids, readProcessTable } from "./process-tree.ts";
import type { SessionManager } from "./sessions.ts";

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
}

export interface Snapshot {
  sessions: SessionView[];
  agentsAvailable: boolean;
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
  private readonly sendNotification: NotificationSender | null;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    sendNotification?: NotificationSender | null,
  ) {
    this.sendNotification = sendNotification !== undefined ? sendNotification : config.notify.macos ? osascriptSender(config.notify.osascriptBin) : null;
    sessions.onChange(() => void this.publish().catch((err) => this.onPollError("publish", err)));
    // 一覧から外したセッションの前回の status・未読は持ち続けない
    sessions.onRemoved((id) => this.tracker.forget(id));
  }

  start(): void {
    this.stoppers.push(
      startPolling(() => this.pollAgents(), this.config.agentsPollMs, (err) => this.onPollError("agents", err)),
      startPolling(
        async () => void (await this.refreshLedger()),
        this.config.ledgerPollMs,
        (err) => this.onPollError("ledger", err),
      ),
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
    await this.publish();
  }

  /** 前回の status と比べ、区切りがあれば未読を増やして macOS 通知を出す。取得失敗の間は何も判定しない。 */
  private async detectBreaks(): Promise<void> {
    if (this.agents === null) return;
    const table = await readProcessTable().catch(() => []);
    for (const s of this.sessions.list()) {
      const agent = agentForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents);
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

  /** このアプリのセッションの子孫プロセスの pid（過去セッション一覧で「実行中」を判定する）。 */
  async livePids(): Promise<Set<number>> {
    const table = await readProcessTable().catch(() => []);
    const pids = new Set<number>();
    for (const s of this.sessions.list()) {
      if (!s.exited) for (const pid of descendantPids(s.term.pid, table)) pids.add(pid);
    }
    return pids;
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

  async snapshot(): Promise<Snapshot> {
    const table = await readProcessTable().catch(() => []);
    const views = this.sessions.list().map((s): SessionView => {
      const info = { exited: s.exited, pids: descendantPids(s.term.pid, table) };
      const agent = agentForSession(info, this.agents);
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
      };
    });
    return { sessions: views, agentsAvailable: this.agents !== null };
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
