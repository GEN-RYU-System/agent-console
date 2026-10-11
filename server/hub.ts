import type { WebSocket } from "ws";
import { fetchAgents, stateForSession, type AgentRow, type SessionState } from "./agents.ts";
import type { Config } from "./config.ts";
import { loadLedger, type LedgerSnapshot } from "./ledger.ts";
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

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
  ) {
    sessions.onChange(() => void this.publish().catch((err) => this.onPollError("publish", err)));
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

  private async pollAgents(): Promise<void> {
    // 不正な出力・実行失敗は null（=状態「不明」）。前回値は保持しない。
    this.agents = await fetchAgents(this.config.claudeBin);
    await this.publish();
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
    const views = this.sessions.list().map((s): SessionView => ({
      id: s.id,
      name: s.name,
      roleId: s.roleId,
      branch: s.branch,
      cwd: s.cwd,
      createdAt: s.createdAt,
      state: stateForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents),
    }));
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
