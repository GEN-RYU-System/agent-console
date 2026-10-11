import type { WebSocket } from "ws";
import { fetchAgents, stateForSession, type AgentRow, type SessionState } from "./agents.ts";
import type { Config } from "./config.ts";
import { loadLedger, type LedgerGroups } from "./ledger.ts";
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
  private ledger: LedgerGroups | null = null;
  private subscribers = new Set<WebSocket>();
  private lastPayload = "";
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
  ) {
    sessions.onChange(() => void this.publish());
  }

  start(): void {
    void this.pollAgents();
    void this.refreshLedger();
    this.timers.push(setInterval(() => void this.pollAgents(), this.config.agentsPollMs));
    this.timers.push(setInterval(() => void this.refreshLedger(), this.config.ledgerPollMs));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async pollAgents(): Promise<void> {
    const rows = await fetchAgents(this.config.claudeBin);
    // 不正な出力のときは前回値を保持し、状態は「不明」にする
    this.agents = rows;
    await this.publish();
  }

  async refreshLedger(): Promise<LedgerGroups> {
    this.ledger = await loadLedger(this.config.salesanchorRoot, this.config.ledgerDir, this.config.ledgerLookupScript);
    return this.ledger;
  }

  getLedger(): LedgerGroups | null {
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
