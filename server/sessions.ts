import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn, type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { ACCOUNT_LOGIN_ROLE_ID, CHILD_ENV_BLOCKLIST, DEFAULT_MAX_SESSIONS, TERMINAL_ENV_FORBIDDEN, type Config, type RoleConfig } from "./config.ts";
import { descendantPids, readProcessTable } from "./process-tree.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { sessionName } from "./terminal-host/tmux-protocol.ts";
import { findTmux, newSession, probeSession, startupSweep, tmuxVersion, tmuxVersionAtLeast } from "./terminal-host/tmux-runner.ts";
import { TmuxControlTerminal } from "./terminal-host/tmux-terminal.ts";
import { consoleLogger, type TerminalHandle, type TerminalLogger, type TmuxContext } from "./terminal-host/types.ts";
import path from "node:path";
import { createWorktree, isValidBranch, WorktreeError } from "./worktree.ts";

const MAX_NAME_LENGTH = 40;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_DIMENSION = 500;
/** 閉じるとき、SIGHUP で終わらなければ SIGKILL へ切り替えるまでの時間 */
const DEFAULT_CLOSE_GRACE_MS = 5000;
const CLOSE_POLL_MS = 50;
const CLOSE_FINAL_WAIT_MS = 2000;
/** Claude の sessionId（UUID の形のものだけを保存・使用する） */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isClaudeSessionId = (value: unknown): value is string => typeof value === "string" && CLAUDE_SESSION_ID.test(value);

/** セッション id の形（UUID。tmux のセッション名 ac-<id> に使う） */
export const isSessionId = isClaudeSessionId;

/** 端末の置き場についての案内。画面が文言を持つ */
export interface TerminalNotice {
  reason: "tmuxMissing" | "cannotAttach";
  name?: string;
}

export class SessionInputError extends Error {}
export class SessionConflictError extends Error {}
export class SessionNotFoundError extends Error {}

export interface SessionManagerOptions {
  maxSessions?: number;
  /** 閉じるときに SIGKILL へ切り替えるまでの時間（ms） */
  closeGraceMs?: number;
  /** tmux の設定ファイル（既定 ops/tmux/agent-console.tmux.conf） */
  tmuxConf?: string;
  logger?: TerminalLogger;
  /** control client のつなぎ直しの間隔（ms）。試験用 */
  reattachIntervalMs?: number;
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
  term: TerminalHandle;
  ring: RingBuffer;
  clients: Set<WebSocket>;
  exited: boolean;
  /** 動いている Claude の sessionId（UUID の形のものだけ。復元に使う） */
  claudeSessionId?: string;
  /** 起動時に、動いていた tmux のセッションへつなぎ直した（新しく起動していない） */
  reattached?: boolean;
  /** 起動直後の Claude に /rename で合わせる名前（メモリだけ。合わせ終えた・10 分過ぎた・終了したら Hub が消す） */
  initialName?: string;
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

/**
 * pty の子プロセスへ渡す環境。サーバーの固定トークン（AGENT_CONSOLE_TOKEN）は端末内から見えないよう除く。
 * terminalEnv（config）は親の環境の上に重ね、LaunchAgent 起動で LANG が無くても端末のロケールを固定する。TERM・秘密系のキーは無視する。
 */
export function buildChildEnv(source: Record<string, string | undefined>, terminalEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && !CHILD_ENV_BLOCKLIST.has(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(terminalEnv)) {
    if (!TERMINAL_ENV_FORBIDDEN.has(k)) env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 権限が無い（EPERM）は存在する
    return (err as { code?: string }).code === "EPERM";
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* すでに終わっている */
  }
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, CLOSE_POLL_MS));
  }
  return true;
}

/** node-pty の IPty を TerminalHandle に包む（今までの方式） */
class DirectTerminal implements TerminalHandle {
  constructor(private readonly pty: IPty) {}
  get pid(): number {
    return this.pty.pid;
  }
  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.pty.onExit(listener);
  }
  write(data: string): void {
    this.pty.write(data);
  }
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }
  kill(): void {
    this.pty.kill();
  }
  release(): void {
    this.pty.kill();
  }
}

export class SessionManager {
  /** 並び順の正本（Map の入れた順）。move() だけが新しい Map に差し替える。 */
  private sessions = new Map<string, Session>();
  private changeListeners = new Set<() => void>();
  private removedListeners = new Set<(id: string) => void>();
  private readonly maxSessions: number;
  private readonly closeGraceMs: number;
  private shuttingDown = false;
  private readonly closing = new Map<string, Promise<void>>();
  /** worktree 作成中など、まだ sessions に入っていない作成途中の数（上限判定に含める）。 */
  private pending = 0;
  /** tmux で端末を持つときの呼び出し情報。null なら direct（tmux が無い場合も含む） */
  private readonly tmuxCtx: TmuxContext | null;
  private readonly logger: TerminalLogger;
  private readonly reattachIntervalMs: number | undefined;
  private tmuxMissing = false;
  private readonly cannotAttach = new Map<string, string>();
  /** 起動時に tmux 側で見つけた ac-* のセッション名 */
  private sweptNames: string[] = [];

  constructor(
    private readonly config: Config,
    options: SessionManagerOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.logger = options.logger ?? consoleLogger;
    this.reattachIntervalMs = options.reattachIntervalMs;
    this.tmuxCtx = config.terminalHost === "tmux" ? this.setupTmux(options.tmuxConf) : null;
  }

  /** tmux の場所と設定ファイルを確かめる。使えなければ direct で動き、画面に一度だけ知らせる */
  private setupTmux(confOption: string | undefined): TmuxContext | null {
    const found = findTmux(this.config.tmuxPath);
    const conf = confOption ?? path.join(process.cwd(), "ops", "tmux", "agent-console.tmux.conf");
    if (found === null || !existsSync(conf)) {
      this.tmuxMissing = true;
      this.logger.warn(found === null ? "terminal: tmux not found, using direct (node-pty)" : `terminal: tmux conf not found (${conf}), using direct (node-pty)`);
      return null;
    }
    const version = tmuxVersion(found);
    if (tmuxVersionAtLeast(version, 3, 8) === false) {
      // pane_private_modes は 3.8 で追加。未満だと先入れでモード（貼り付けモード等）が戻らない
      this.logger.warn(`tmux ${(version ?? "").replace(/^tmux\s+/, "")} は 3.8 未満のため、つなぎ直しで端末のモード（貼り付けモード等）が戻らない`);
    }
    this.logger.info(`terminal: host=tmux ${version ?? "(version unknown)"} path=${found} socket=${this.config.tmuxSocket ?? "agent-console"}`);
    const ctx: TmuxContext = { tmux: found, socket: this.config.tmuxSocket ?? "agent-console", conf };
    this.sweptNames = startupSweep(ctx, this.childEnv(), this.logger);
    return ctx;
  }

  private childEnv(): Record<string, string> {
    return buildChildEnv(process.env, this.config.terminalEnv);
  }

  /** 画面に出す端末の案内 */
  terminalNotices(): TerminalNotice[] {
    return [
      ...(this.tmuxMissing ? [{ reason: "tmuxMissing" as const }] : []),
      ...[...this.cannotAttach.values()].map((name) => ({ reason: "cannotAttach" as const, name })),
    ];
  }

  /** 保存リストにも今の一覧にも無い ac-* の tmux セッションを、ログに出す（消さない） */
  reportOrphans(knownIds: ReadonlySet<string>): void {
    const keep = new Set<string>();
    for (const id of knownIds) if (isSessionId(id)) keep.add(sessionName(id));
    for (const s of this.sessions.values()) keep.add(sessionName(s.id));
    for (const name of this.sweptNames) {
      if (!keep.has(name)) this.logger.warn(`terminal: tmux session ${name} is not in the saved list (left as is). attach: tmux -L ${this.tmuxCtx?.socket ?? "agent-console"} attach -t =${name}`);
    }
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onRemoved(listener: (id: string) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
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
    if (this.occupiedCount() >= this.maxSessions) throw new SessionInputError("too many sessions");
    this.pending += 1;
    try {
      const cwd = branch
        ? await createWorktree(this.config.salesanchorRoot, this.config.salesanchorToolsRoot, this.config.newWorktreeScript, branch)
        : this.config.salesanchorRoot;
      const session = this.spawnSession(name, role, branch, cwd);
      session.initialName = name;
      return session;
    } finally {
      this.pending -= 1;
    }
  }

  /**
   * 再開用の端末を開く。起動コマンドは役割の resumeCommand（config 固定。id なしの `--resume` で Claude 公式の選択リストが開く）。
   * cwd の検証は呼び出し側（resume-targets.ts）で済ませる。画面の文字列はコマンドに入れない。
   */
  resume(input: { roleId: unknown; name: unknown; cwd: string }): Session {
    const role = this.findRole(input.roleId);
    if (!role.resumeCommand) throw new SessionInputError("role cannot resume sessions");
    if (this.occupiedCount() >= this.maxSessions) throw new SessionInputError("too many sessions");
    return this.spawnSession(validateName(input.name), role, null, input.cwd, role.resumeCommand);
  }

  /**
   * アカウント切り替えの端末を開く。命令は config の accountLoginCommand（固定）。画面の文字列は受け取らない。
   * 動いているものがあれば 409。再開の記録には入らない（restore.ts）。
   */
  createAccountLogin(): Session {
    const command = this.config.accountLoginCommand;
    if (command === undefined) throw new SessionInputError("account switching is not configured");
    if ([...this.sessions.values()].some((s) => s.roleId === ACCOUNT_LOGIN_ROLE_ID && !s.exited)) {
      throw new SessionConflictError("account login is already running");
    }
    if (!this.hasCapacity()) throw new SessionInputError("too many sessions");
    const role: RoleConfig = { id: ACCOUNT_LOGIN_ROLE_ID, labelKey: "role.accountLogin", command, needsWorktree: false };
    return this.spawnSession(ACCOUNT_LOGIN_ROLE_ID, role, null, this.config.salesanchorRoot);
  }

  /** 新しい端末を開く余裕があるか（作成途中の分を含む）。 */
  hasCapacity(): boolean {
    return this.occupiedCount() < this.maxSessions;
  }

  /** 場所をふさいでいる窓の数（作成途中の分を含む）。 */
  occupiedCount(): number {
    return this.sessions.size + this.pending;
  }

  /** 今開いている窓の数（作成途中を含まない）。 */
  openCount(): number {
    return this.sessions.size;
  }

  /** 同時に開ける窓の数の上限。 */
  maxSessionCount(): number {
    return this.maxSessions;
  }

  /**
   * 前回の続きとして端末を開く（起動時の復元用）。起動コマンドは呼び出し側が決めた config の命令のみ。
   * claudeSessionId（UUID の形のもの）があるときは、環境変数 AC_RESUME_ID で渡す（コマンドの文字列にはつなげない）。
   */
  restore(input: { role: RoleConfig; name: unknown; cwd: string; branch: string | null; claudeSessionId?: string; id?: string; manualInitialName?: boolean }): Session {
    if (!this.hasCapacity()) throw new SessionInputError("too many sessions");
    const sid = isClaudeSessionId(input.claudeSessionId) ? input.claudeSessionId : undefined;
    const useRestore = sid !== undefined && input.role.restoreCommand !== undefined;
    const command = useRestore ? (input.role.restoreCommand as string[]) : input.role.command;
    // 復元の起動でも、同じ会話の id を引き継ぐ（次の再起動でも続きを開ける）
    const name = validateName(input.name);
    const session = this.spawnSession(name, input.role, input.branch, input.cwd, command, useRestore ? { AC_RESUME_ID: sid } : {}, useRestore ? sid : undefined, isSessionId(input.id) ? input.id : undefined);
    // 新しい会話として起動した（会話の id で再開していない・動いていた tmux へのつなぎ直しでない）ときだけ、起動直後の名前合わせを予約する。呼び出し元が自分で名前を送るとき（manualInitialName）は予約しない
    if (input.manualInitialName !== true && !useRestore && session.reattached !== true) session.initialName = name;
    return session;
  }

  /** Claude の sessionId を知ったとき。UUID の形でない値は受け付けない。変わったときだけ通知する。 */
  setClaudeSessionId(id: string, claudeSessionId: unknown): void {
    const session = this.sessions.get(id);
    if (!session || session.exited || !isClaudeSessionId(claudeSessionId) || session.claudeSessionId === claudeSessionId) return;
    session.claudeSessionId = claudeSessionId;
    this.notify();
  }

  /**
   * 並び順を変える。toIndex は動かしたあとの位置（0 始まり。止まったセッションも数える）。
   * 新しい Map を作って差し替える（clear して入れ直さない）。同じ位置なら何もしない。
   */
  move(id: string, toIndex: unknown): void {
    const ids = [...this.sessions.keys()];
    if (typeof toIndex !== "number" || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ids.length) {
      throw new SessionInputError("toIndex must be an integer within the session count");
    }
    const from = ids.indexOf(id);
    if (from < 0) throw new SessionNotFoundError("session not found");
    if (from === toIndex) return;
    const order = ids.filter((x) => x !== id);
    order.splice(toIndex, 0, id);
    this.sessions = new Map(order.map((x) => [x, this.sessions.get(x) as Session] as const));
    this.notify();
  }

  /** サーバー停止の印。これ以降の終了では、復元リストを書き換えない。 */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** アプリ側の名前を変える（Claude が動いていないセッション用。Claude 起動中は /rename を使う）。 */
  rename(id: string, name: unknown): void {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError("session not found");
    session.name = validateName(name);
    this.notify();
  }

  private spawnSession(
    name: string,
    role: RoleConfig,
    branch: string | null,
    cwd: string,
    command: string[] = role.command,
    extraEnv: Record<string, string> = {},
    claudeSessionId?: string,
    knownId?: string,
  ): Session {
    const id = knownId !== undefined && !this.sessions.has(knownId) ? knownId : randomUUID();
    const { term, reattached } = this.openTerminal(id, role, cwd, command, extraEnv, knownId === id);
    const session: Session = {
      id,
      name,
      roleId: role.id,
      branch,
      cwd,
      createdAt: Date.now(),
      term,
      ring: new RingBuffer(this.config.ringBufferBytes),
      clients: new Set(),
      exited: false,
      ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
      ...(reattached ? { reattached: true } : {}),
    };
    term.onData((data) => {
      session.ring.push(data);
      for (const ws of session.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });
    term.onReplay?.((data) => {
      // つなぎ直しの先入れ: 古い内容を捨てて、いまの画面に置き換える
      session.ring = new RingBuffer(this.config.ringBufferBytes);
      session.ring.push(data);
      for (const ws of session.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });
    term.onStatus?.((status) => {
      const changed = status === "failed" ? !this.cannotAttach.has(id) : this.cannotAttach.has(id);
      if (status === "failed") this.cannotAttach.set(id, session.name);
      else this.cannotAttach.delete(id);
      if (changed) this.notify();
    });
    term.onExit(() => {
      session.exited = true;
      this.cannotAttach.delete(id);
      this.notify();
    });
    this.sessions.set(session.id, session);
    this.notify();
    return session;
  }

  /**
   * 端末を開く。tmux が使えて、アカウント切り替え以外なら tmux の中に作る（probe 付きなら、動いている物へつなぎ直す）。
   * それ以外は node-pty（今までの方式）。tmux の作成に失敗したら direct に落とす。
   */
  private openTerminal(id: string, role: RoleConfig, cwd: string, command: string[], extraEnv: Record<string, string>, probe: boolean): { term: TerminalHandle; reattached: boolean } {
    const ctx = this.tmuxCtx;
    if (ctx !== null && role.id !== ACCOUNT_LOGIN_ROLE_ID && isSessionId(id)) {
      const name = sessionName(id);
      const env = this.childEnv();
      const base = { ctx, name, env, logger: this.logger, ...(this.reattachIntervalMs !== undefined ? { reattachIntervalMs: this.reattachIntervalMs } : {}) };
      if (probe) {
        const found = probeSession(ctx, name, env);
        if (found.state === "alive") return { term: new TmuxControlTerminal({ ...base, pid: found.pid }), reattached: true };
        if (found.state === "unreachable") {
          // 新しく起動し直さない（同じ会話の claude が二重に動くため）。つなぎ直しを試し、駄目なら案内を出す
          this.logger.warn(`terminal: ${name} is unreachable, trying to attach`);
          return { term: new TmuxControlTerminal({ ...base, pid: 0 }), reattached: true };
        }
      }
      try {
        const paneEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(this.config.terminalEnv)) if (!TERMINAL_ENV_FORBIDDEN.has(k)) paneEnv[k] = v;
        const pid = newSession(ctx, { name, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, command, env: { ...paneEnv, ...extraEnv } }, env);
        return { term: new TmuxControlTerminal({ ...base, pid }), reattached: false };
      } catch (err) {
        this.logger.warn(`terminal: tmux session could not be created, using direct: ${err instanceof Error ? err.message : String(err)}`);
        // 黙って続けない: 更新で保たれない会話になるので、tmux が使えない時と同じ案内を出す
        if (!this.tmuxMissing) {
          this.tmuxMissing = true;
          this.notify();
        }
      }
    }
    const pty = spawn(command[0], command.slice(1), {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...this.childEnv(), ...extraEnv },
    });
    return { term: new DirectTerminal(pty), reattached: false };
  }

  /** 終了済みのセッションを一覧から外す（実行中は拒否）。 */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError("session not found");
    if (!session.exited) throw new SessionConflictError("session is still running");
    for (const ws of session.clients) ws.close();
    this.sessions.delete(id);
    this.cannotAttach.delete(id);
    for (const l of this.removedListeners) l(id);
    this.notify();
  }

  /** 閉じる処理の途中か（終了を待っている間も true） */
  isClosing(id: string): boolean {
    return this.closing.has(id);
  }

  write(session: Session, data: string): void {
    if (!session.exited) session.term.write(data);
  }

  resize(session: Session, cols: unknown, rows: unknown): void {
    if (session.exited) return;
    session.term.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
  }

  /**
   * セッションを閉じる。止まっているものは一覧から外す。動いているものは SIGHUP を送り、終了（端末と子孫）を待ってから外す。
   * 猶予（既定 5 秒）で終わらなければ、端末とその子孫に SIGKILL を送る。
   */
  close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new SessionNotFoundError("session not found"));
    if (session.exited) {
      this.remove(id);
      return Promise.resolve();
    }
    const pending = this.closing.get(id);
    if (pending) return pending;
    const run = this.closeRunning(session).finally(() => this.closing.delete(id));
    this.closing.set(id, run);
    return run;
  }

  private async closeRunning(session: Session): Promise<void> {
    // 終了後は子が親を失って辿れなくなるので、先に子孫を控える
    const family = new Set(descendantPids(session.term.pid, await readProcessTable().catch(() => [])));
    try {
      session.term.kill();
    } catch {
      /* すでに終わっている */
    }
    const gone = (): boolean => session.exited && [...family].every((pid) => pid === session.term.pid || !isAlive(pid));
    if (!(await waitUntil(gone, this.closeGraceMs))) {
      if (!(session.term.pid > 0)) {
        // pid が分からない端末は、何も殺さない（kill-session → has-session の結果だけで判断する）
        this.logger.warn(`terminal: ${session.name} (${session.id}) did not stop and its pid is unknown, nothing was killed`);
        throw new SessionConflictError("session did not stop");
      }
      for (const pid of descendantPids(session.term.pid, await readProcessTable().catch(() => []))) family.add(pid);
      for (const pid of family) killQuietly(pid);
      if (!(await waitUntil(gone, CLOSE_FINAL_WAIT_MS))) throw new SessionConflictError("session did not stop");
    }
    this.remove(session.id);
  }

  /** サーバー停止時に全 pty を終了する。 */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.exited) s.term.release();
    }
  }
}

export { WorktreeError };
