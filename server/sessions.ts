import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { WebSocket } from "ws";
import type { Config, RoleConfig } from "./config.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { createWorktree, isValidBranch, WorktreeError } from "./worktree.ts";

const DEFAULT_MAX_SESSIONS = 16;
const MAX_NAME_LENGTH = 40;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_DIMENSION = 500;

export class SessionInputError extends Error {}
export class SessionConflictError extends Error {}
export class SessionNotFoundError extends Error {}

export interface SessionManagerOptions {
  maxSessions?: number;
}

export interface CreateSessionInput {
  name: unknown;
  roleId: unknown;
  branch?: unknown;
}

export interface Session {
  id: string;
  name: string;
  roleId: string;
  branch: string | null;
  cwd: string;
  createdAt: number;
  term: IPty;
  ring: RingBuffer;
  clients: Set<WebSocket>;
  exited: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateName(name: unknown): string {
  if (typeof name !== "string") throw new SessionInputError("name is required");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) throw new SessionInputError("name must be 1-40 characters");
  if (CONTROL_CHARS.test(trimmed)) throw new SessionInputError("name must not contain control characters");
  return trimmed;
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_DIMENSION, Math.floor(value)));
}

/** pty の子プロセスへ渡す環境。サーバーの固定トークン（AGENT_CONSOLE_TOKEN）は端末内から見えないよう除く。 */
export function buildChildEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && k !== "AGENT_CONSOLE_TOKEN") env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private changeListeners = new Set<() => void>();
  private readonly maxSessions: number;
  /** worktree 作成中など、まだ sessions に入っていない作成途中の数（上限判定に含める）。 */
  private pending = 0;

  constructor(
    private readonly config: Config,
    options: SessionManagerOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.changeListeners) l();
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private findRole(roleId: unknown): RoleConfig {
    const role = this.config.roles.find((r) => r.id === roleId);
    if (!role) throw new SessionInputError("unknown role");
    return role;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const name = validateName(input.name);
    const role = this.findRole(input.roleId);
    let branch: string | null = null;
    if (role.needsWorktree) {
      if (typeof input.branch !== "string" || !isValidBranch(input.branch)) {
        throw new SessionInputError("branch must match release/<lowercase-alnum-hyphen>");
      }
      branch = input.branch;
    }
    // 枠を先に確保してから worktree を作る（同時作成で上限を超えない）
    if (this.sessions.size + this.pending >= this.maxSessions) throw new SessionInputError("too many sessions");
    this.pending += 1;
    try {
      const cwd = branch
        ? await createWorktree(this.config.salesanchorRoot, this.config.newWorktreeScript, branch)
        : this.config.salesanchorRoot;
      return this.spawnSession(name, role, branch, cwd);
    } finally {
      this.pending -= 1;
    }
  }

  private spawnSession(name: string, role: RoleConfig, branch: string | null, cwd: string): Session {
    const term = spawn(role.command[0], role.command.slice(1), {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: buildChildEnv(process.env),
    });
    const session: Session = {
      id: randomUUID(),
      name,
      roleId: role.id,
      branch,
      cwd,
      createdAt: Date.now(),
      term,
      ring: new RingBuffer(this.config.ringBufferBytes),
      clients: new Set(),
      exited: false,
    };
    term.onData((data) => {
      session.ring.push(data);
      for (const ws of session.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });
    term.onExit(() => {
      session.exited = true;
      this.notify();
    });
    this.sessions.set(session.id, session);
    this.notify();
    return session;
  }

  /** 終了済みのセッションを一覧から外す（実行中は拒否）。 */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError("session not found");
    if (!session.exited) throw new SessionConflictError("session is still running");
    for (const ws of session.clients) ws.close();
    this.sessions.delete(id);
    this.notify();
  }

  write(session: Session, data: string): void {
    if (!session.exited) session.term.write(data);
  }

  resize(session: Session, cols: unknown, rows: unknown): void {
    if (session.exited) return;
    session.term.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
  }

  /** サーバー停止時に全 pty を終了する。 */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.exited) s.term.kill();
    }
  }
}

export { WorktreeError };
