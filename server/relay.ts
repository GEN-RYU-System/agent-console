import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ACCOUNT_LOGIN_ROLE_ID, DEFAULT_RELAY_HANDOFF_TIMEOUT_MS, type Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { MAX_NAME, waitName, waitReady, type LaunchDeps, type LaunchTiming } from "./launch.ts";
import { SessionConflictError, SessionInputError, SessionNotFoundError, validateName, type Session, type SessionManager } from "./sessions.ts";

/** 引き継ぎ（今のセッションに引き継ぎ書を書かせ、名前の数字を 1 つ増やした新しいセッションに続きを渡す）。進行はメモリだけ。 */

export type RelayPhase = "handoff" | "launching" | "sending" | "done" | "failed";
export type RelayReason = "send_failed" | "handoff_timeout" | "gone" | "full" | "start_failed" | "not_ready";

export interface RelayView {
  relayId: string;
  oldSessionId: string;
  oldName: string;
  newName: string;
  phase: RelayPhase;
  newSessionId?: string;
  reason?: RelayReason;
}

export interface RelayTiming {
  /** 引き継ぎ書ができたかを見る間隔 */
  pollMs: number;
  /** 作業中を一度も見られなくても、送ってからこの時間が過ぎれば完了と見なす */
  quietMs: number;
  /** 新しいセッションが入力待ちになるのを見る間隔と上限 */
  readyPollMs: number;
  readyTimeoutMs: number;
  /** /rename が一覧に出るのを見る間隔と上限 */
  namePollMs: number;
  nameTimeoutMs: number;
  /** 引き継ぎ書を待つ上限 */
  handoffTimeoutMs: number;
  /** done・failed の記録を残す時間 */
  doneKeepMs: number;
}

export const defaultRelayTiming = (config: Pick<Config, "relayHandoffTimeoutMs">): RelayTiming => ({
  pollMs: 3000,
  quietMs: 60000,
  readyPollMs: 3000,
  readyTimeoutMs: 120000,
  namePollMs: 3000,
  nameTimeoutMs: 15000,
  handoffTimeoutMs: config.relayHandoffTimeoutMs ?? DEFAULT_RELAY_HANDOFF_TIMEOUT_MS,
  doneKeepMs: 600000,
});

/** 引き継ぎ書の置き場。config にあればそれ。無ければ本番のポート（AGENT_CONSOLE_PORT が未設定か空）のときだけ既定。 */
export function resolveRelayDir(config: Pick<Config, "relayDir">, env: Readonly<Record<string, string | undefined>>): string | null {
  if (config.relayDir !== undefined) return config.relayDir;
  if (env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === "") return path.join(os.homedir(), "CC報告ファイル-keep", "relay");
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
/** 制御文字を除き、前後の空白を除く */
const sanitize = (s: string): string => s.replace(CONTROL_ALL, "").trim();
const STAMP_TAIL = /\d{2}\/\d{2} \d{2}:\d{2}$/;
const DIGITS_TAIL = /\d+$/;

/**
 * 新しい名前。今の表示名（無害化後に空なら appName）の末尾の数字を 1 つ増やす。
 * 末尾が「MM/DD HH:mm」なら " 2" を付ける。数字でなければ "2" を付ける。40 字を超えるときは数字より前を縮める。
 */
export function nextRelayName(display: string, appName: string): string {
  const base = sanitize(display) || sanitize(appName);
  let prefix: string;
  let suffix: string;
  const digits = DIGITS_TAIL.exec(base);
  if (STAMP_TAIL.test(base)) {
    prefix = base;
    suffix = " 2";
  } else if (digits) {
    prefix = base.slice(0, digits.index);
    suffix = (BigInt(digits[0]) + 1n).toString().padStart(digits[0].length, "0");
  } else {
    prefix = base;
    suffix = "2";
  }
  const chars = Array.from(prefix);
  while (chars.length > 0 && chars.join("").length + suffix.length > MAX_NAME) chars.pop();
  return validateName(chars.join("") + suffix);
}

/** JST の YYYYMMDD-HHmmss */
function jstStamp(now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ACTIVE: readonly RelayPhase[] = ["handoff", "launching", "sending"];

const handoffPrompt = (file: string): string =>
  `このセッションの作業を次のセッションに引き継ぎます。${file} に Markdown で引き継ぎ書を書いてください。書く項目: 目的と PO の言葉の原文／決まったこと／今の状態（作業場所・ブランチ・PR・動いている担当）／終わっていない作業と次の一手（順番つき）／注意点と守るルール／読むべきファイルのパス。書き終えたら、そのパスだけを返答してください。新しい作業は始めないでください。`;
const startPrompt = (oldName: string, file: string): string => `前のセッション「${oldName}」からの引き継ぎです。${file} を読み、書かれた次の一手から続きに着手してください。`;

export interface RelayDeps {
  config: Config;
  sessions: SessionManager;
  hub: Hub;
  relayDir: string | null;
}

export class RelayManager {
  private readonly views = new Map<string, RelayView>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timing: RelayTiming;

  constructor(private readonly deps: RelayDeps, private readonly now: () => Date = () => new Date(), timing?: RelayTiming) {
    this.timing = timing ?? defaultRelayTiming(deps.config);
  }

  list(): RelayView[] {
    return [...this.views.values()];
  }

  /** 動いている引き継ぎがすべて終わるまで待つ（試験用） */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** 後始末の時計を止める（試験用） */
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private busy(sessionId: string): boolean {
    return this.list().some((v) => ACTIVE.includes(v.phase) && (v.oldSessionId === sessionId || v.newSessionId === sessionId));
  }

  private publish(): void {
    this.deps.hub.setRelays(this.list());
  }

  private update(view: RelayView, patch: Partial<RelayView>): void {
    Object.assign(view, patch);
    this.publish();
  }

  private finish(view: RelayView): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.views.delete(view.relayId);
      this.publish();
    }, this.timing.doneKeepMs);
    timer.unref();
    this.timers.add(timer);
  }

  private fail(view: RelayView, reason: RelayReason): void {
    this.update(view, { phase: "failed", reason });
    this.finish(view);
  }

  /**
   * 引き継ぎを受け付ける。条件を満たさなければ 404・409（フォルダは作らない）。
   * 受け付けたら新しい名前を決めてフォルダを作り、進行は裏で続ける。
   */
  async start(sessionId: string): Promise<{ relayId: string }> {
    const { sessions, hub, config, relayDir } = this.deps;
    const session = sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError("session not found");
    if (relayDir === null) throw new SessionConflictError("relay not configured");
    if (session.exited) throw new SessionConflictError("session is stopped");
    if (session.roleId === ACCOUNT_LOGIN_ROLE_ID || !config.roles.some((r) => r.id === session.roleId)) throw new SessionConflictError("role cannot relay");
    if (hub.hasPendingWork(sessionId)) throw new SessionConflictError("pending work");
    if (this.busy(sessionId)) throw new SessionConflictError("relay in progress");
    if (!sessions.hasCapacity()) throw new SessionConflictError("too many sessions");
    const verdict = await hub.checkInput(sessionId);
    if (session.exited) throw new SessionConflictError("session is stopped");
    if (!verdict.ok || !verdict.hasClaude) throw new SessionConflictError("not idle");
    // 判定の取り直しの間に別の要求が通った場合に備え、await の後で見直す
    if (this.busy(sessionId)) throw new SessionConflictError("relay in progress");
    if (hub.hasPendingWork(sessionId)) throw new SessionConflictError("pending work");
    const oldName = sanitize(hub.displayNames().get(sessionId) ?? "") || sanitize(session.name);
    const newName = nextRelayName(oldName, session.name);
    const folder = path.join(relayDir, `${jstStamp(this.now())}-${session.id.slice(0, 8)}`);
    await mkdir(relayDir, { recursive: true, mode: 0o700 });
    await mkdir(folder, { mode: 0o700 });
    if (this.busy(sessionId)) throw new SessionConflictError("relay in progress");
    const view: RelayView = { relayId: randomUUID(), oldSessionId: sessionId, oldName, newName, phase: "handoff" };
    this.views.set(view.relayId, view);
    this.publish();
    const run = this.run(view, session, path.join(folder, "HANDOFF.md")).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return { relayId: view.relayId };
  }

  private launchDeps(): LaunchDeps {
    const t = this.timing;
    const timing: LaunchTiming = { pollMs: t.readyPollMs, timeoutMs: t.readyTimeoutMs, namePollMs: t.namePollMs, nameTimeoutMs: t.nameTimeoutMs };
    return { config: this.deps.config, sessions: this.deps.sessions, hub: this.deps.hub, timing };
  }

  private gone(sessionId: string): boolean {
    const s = this.deps.sessions.get(sessionId);
    return s === undefined || s.exited;
  }

  private async hasHandoff(file: string): Promise<boolean> {
    try {
      return (await stat(file)).size > 0;
    } catch {
      return false;
    }
  }

  private async run(view: RelayView, old: Session, file: string): Promise<void> {
    try {
      await this.runSteps(view, old, file);
    } catch (err) {
      console.error("relay: failed:", err instanceof Error ? err.message : err);
      if (ACTIVE.includes(view.phase)) this.fail(view, "start_failed");
    }
  }

  private async runSteps(view: RelayView, old: Session, file: string): Promise<void> {
    const { hub, sessions, config } = this.deps;
    const t = this.timing;
    // 1 引き継ぎ書を書かせる
    if (!(await hub.submitText(old.id, handoffPrompt(file)))) return this.fail(view, "send_failed");
    // 2 書き終わるのを待つ（引き継ぎ書がある・今 ok・作業中を一度見たか 60 秒過ぎた）
    const sentAt = Date.now();
    let sawNotOk = false;
    for (;;) {
      await sleep(t.pollMs);
      if (this.gone(old.id)) return this.fail(view, "gone");
      const elapsed = Date.now() - sentAt;
      if (elapsed > t.handoffTimeoutMs) return this.fail(view, "handoff_timeout");
      const peek = await hub.peekInput(old.id);
      if (!peek.ok) {
        sawNotOk = true;
        continue;
      }
      if (!sawNotOk && elapsed < t.quietMs) continue;
      if (!(await this.hasHandoff(file))) continue;
      const verdict = await hub.checkInput(old.id);
      if (verdict.ok && verdict.hasClaude) break;
      sawNotOk = true;
    }
    // 3 新しいセッションを開く
    this.update(view, { phase: "launching" });
    if (!sessions.hasCapacity()) return this.fail(view, "full");
    const role = config.roles.find((r) => r.id === old.roleId);
    if (!role) return this.fail(view, "start_failed");
    let created: Session;
    try {
      created = sessions.restore({ role, name: view.newName, cwd: old.cwd, branch: old.branch, manualInitialName: true });
    } catch (err) {
      return this.fail(view, err instanceof SessionInputError && err.message === "too many sessions" ? "full" : "start_failed");
    }
    this.update(view, { newSessionId: created.id });
    // 4 入力待ちを待つ
    const deps = this.launchDeps();
    if (!(await waitReady(deps, created.id))) return this.fail(view, "not_ready");
    // 5 名前を合わせて指示を送る
    this.update(view, { phase: "sending" });
    if (hub.sendName(created.id, view.newName)) await waitName(deps, created.id, view.newName);
    else console.warn("relay: could not send /rename (write in progress); sending the prompt anyway");
    if (!(await waitReady(deps, created.id))) return this.fail(view, "not_ready");
    if (!(await hub.submitText(created.id, startPrompt(view.oldName, file)))) return this.fail(view, "send_failed");
    // 6 完了。古いセッションは閉じない
    this.update(view, { phase: "done" });
    this.finish(view);
  }
}
