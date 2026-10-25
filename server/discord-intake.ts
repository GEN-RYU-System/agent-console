import path from "node:path";
import { createDiscordApi, type ApiResult, type DiscordApi, type DiscordMessage } from "./discord-api.ts";
import { loadDiscordCredentials, type CredentialState, type DiscordCredentials } from "./discord-credentials.ts";
import { DiscordNotifier } from "./discord-notifier.ts";
import { readIntakeConfig, type ConfigResult, type IntakeChannelConfig, type IntakeConfig, type IntakeKind } from "./discord-intake-config.ts";
import { createSerial, readJsonFile, writeJsonAtomic } from "./json-store.ts";
import type { NotificationSender } from "./notify.ts";

/** Discord の受付チャンネルを読む受け口の本体（設計 discord-pdca §4-1・§4-6）。この便ではセッションを開かない */
export const INTAKE_STATE_FILE = "discord-intake.json";
export const POLL_INTERVAL_MS = 30_000;
export const MAX_PAGES_PER_ROUND = 5;
export const BUG_QUEUE_LIMIT = 20;
export const BOT_CHECK_INTERVAL_MS = 3_600_000;

const PAGE_SIZE = 100;
const DISCORD_EPOCH_MS = 1420070400000n;
const DROP_KEYS = ["channel", "webhook", "bot", "messageType", "notAllowedAuthor", "queueFull"] as const;
type DropKey = (typeof DROP_KEYS)[number];

export interface QueueEntry { messageId: string; channelId: string; postedAt: string; authorId: string; length: number }
interface IntakeState {
  version: 1;
  channels: Record<string, { lastSeenId: string }>;
  queues: { bug: QueueEntry[]; "error-report": QueueEntry[] };
  dropCounts: Record<DropKey, number>;
}

export type ChannelStatus = "reading" | "waitingGuildCheck" | "waitingFirstRead" | "notReady" | "disabled" | "guildMismatch" | "forbidden" | "notFound" | "intakeStopped";

export interface DiscordIntakeStatus {
  state: "disabled" | "running" | "stopped";
  reason: null | "notStarted" | "noConfig" | "configInvalid" | "credentials" | "forbiddenBot" | "tokenRejected" | "stateUnreadable" | "stateWriteFailed";
  problem: string | null;
  testMode: boolean | null;
  credentials: { bot: CredentialState; webhook: CredentialState } | null;
  channels: { kind: IntakeKind; enabled: boolean; status: ChannelStatus; lastReadAt: string | null }[];
  queues: { bug: number; "error-report": number };
  dropCounts: Record<DropKey, number>;
  lastBotCheckAt: string | null;
  pausedUntil: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

const zeroDrops = (): Record<DropKey, number> => ({ channel: 0, webhook: 0, bot: 0, messageType: 0, notAllowedAuthor: 0, queueFull: 0 });

/** start() 前・discordIntake を渡していない入口が返す形（形を2か所で作らない） */
export function disabledIntakeStatus(): DiscordIntakeStatus {
  return {
    state: "disabled", reason: "notStarted", problem: null, testMode: null, credentials: null, channels: [],
    queues: { bug: 0, "error-report": 0 }, dropCounts: zeroDrops(), lastBotCheckAt: null, pausedUntil: null, lastError: null, consecutiveFailures: 0,
  };
}

/** 誤り報告の判定（ADR-1025 便4 のため。この便ではどこからも呼ばない）。「ER- と6桁」なので前に英数字が付くもの・7桁以上には当てない */
export function matchesErrorReport(msg: { webhook_id?: string; content: string }, reportWebhookId: string): boolean {
  return msg.webhook_id === reportWebhookId && /(?<![A-Za-z0-9])ER-\d{6}(?!\d)/.test(msg.content);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function parseQueue(v: unknown): QueueEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: QueueEntry[] = [];
  for (const e of v) {
    if (!isObj(e) || typeof e.messageId !== "string" || typeof e.channelId !== "string" || typeof e.postedAt !== "string" || typeof e.authorId !== "string" || typeof e.length !== "number") return null;
    out.push({ messageId: e.messageId, channelId: e.channelId, postedAt: e.postedAt, authorId: e.authorId, length: e.length });
  }
  return out;
}
function parseState(raw: unknown): IntakeState | null {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.channels) || !isObj(raw.queues) || !isObj(raw.dropCounts)) return null;
  const channels: IntakeState["channels"] = {};
  for (const [id, c] of Object.entries(raw.channels)) {
    if (!isObj(c) || typeof c.lastSeenId !== "string" || !/^\d{1,20}$/.test(c.lastSeenId)) return null;
    channels[id] = { lastSeenId: c.lastSeenId };
  }
  const bug = parseQueue(raw.queues.bug);
  const er = parseQueue(raw.queues["error-report"]);
  if (bug === null || er === null) return null;
  const dropCounts = zeroDrops();
  for (const k of DROP_KEYS) {
    const n = raw.dropCounts[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    dropCounts[k] = n;
  }
  return { version: 1, channels, queues: { bug, "error-report": er }, dropCounts };
}
const freshState = (): IntakeState => ({ version: 1, channels: {}, queues: { bug: [], "error-report": [] }, dropCounts: zeroDrops() });
const cloneState = (s: IntakeState): IntakeState => ({
  version: 1,
  channels: Object.fromEntries(Object.entries(s.channels).map(([k, v]) => [k, { ...v }])),
  queues: { bug: s.queues.bug.map((e) => ({ ...e })), "error-report": s.queues["error-report"].map((e) => ({ ...e })) },
  dropCounts: { ...s.dropCounts },
});

/** 日本時間 YYYY/MM/DD HH:mm */
export function formatJst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const snowflakeAt = (ms: number): string => String((BigInt(ms) - DISCORD_EPOCH_MS) << 22n);

function errorCode(res: Exclude<ApiResult<unknown>, { ok: true }>): string {
  switch (res.kind) {
    case "rateLimited": return "rateLimited";
    case "unauthorized": return "unauthorized";
    case "forbidden": return `forbidden:${res.status}`;
    case "notFound": return `notFound:${res.status}`;
    case "failed": return res.reason === "http" ? `failed:${res.status ?? 0}` : res.reason;
  }
}

interface ChannelRuntime {
  guildConfirmed: boolean;
  lastGuildCheck: number | null;
  halted: "guildMismatch" | "forbidden" | "notFound" | null;
  lastReadAt: number | null;
  behind: boolean;
}

export interface IntakeOverrides {
  now: () => number;
  setTimer: (f: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  api: DiscordApi;
  loadCredentials: () => Promise<DiscordCredentials>;
  readConfig: () => Promise<ConfigResult>;
  makeNotifier: (webhookUrl: string | null) => { notify(text: string): void; stop(): void };
}

export class DiscordIntake {
  private readonly now: () => number;
  private readonly setTimer: (f: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly api: DiscordApi;
  private readonly loadCredentials: () => Promise<DiscordCredentials>;
  private readonly readConfig: () => Promise<ConfigResult>;
  private readonly makeNotifier: (webhookUrl: string | null) => { notify(text: string): void; stop(): void };
  private readonly stateFile: string;
  private readonly serial = createSerial();

  private stopped = false;
  private timer: unknown = null;
  private notifier: { notify(text: string): void; stop(): void } | null = null;
  private config: IntakeConfig | null = null;
  private token: string | null = null;
  private creds: { bot: CredentialState; webhook: CredentialState } | null = null;
  private st: IntakeState = freshState();
  private runtime = new Map<string, ChannelRuntime>();

  private state: DiscordIntakeStatus["state"] = "disabled";
  private reason: DiscordIntakeStatus["reason"] = "notStarted";
  private problem: string | null = null;
  private lastBotCheck: number | null = null;
  private pausedUntil: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(opts: { dataDir: string; securityBin: string; macos: NotificationSender | null }, overrides: Partial<IntakeOverrides> = {}) {
    this.now = overrides.now ?? Date.now;
    this.setTimer = overrides.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearTimer = overrides.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.api = overrides.api ?? createDiscordApi();
    this.loadCredentials = overrides.loadCredentials ?? (() => loadDiscordCredentials(opts.securityBin));
    this.readConfig = overrides.readConfig ?? (() => readIntakeConfig(opts.dataDir));
    this.makeNotifier = overrides.makeNotifier ?? ((webhookUrl) => new DiscordNotifier({
      webhookUrl,
      send: async (url, content) => ({ ok: (await this.api.executeWebhook(url, content)).ok }),
      macos: opts.macos,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    }));
    this.stateFile = path.join(opts.dataDir, INTAKE_STATE_FILE);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    const cfg = await this.readConfig();
    if (this.stopped) return;
    if (!cfg.ok) {
      if (cfg.reason === "missing") { this.state = "disabled"; this.reason = "noConfig"; }
      else { this.state = "stopped"; this.reason = "configInvalid"; this.problem = cfg.problem; }
      return;
    }
    this.config = cfg.config;
    const c = await this.loadCredentials();
    if (this.stopped) return;
    this.creds = c.state;
    if (c.state.bot !== "ok" || c.botToken === null) { this.state = "stopped"; this.reason = "credentials"; return; }
    this.token = c.botToken;
    this.notifier = this.makeNotifier(c.state.webhook === "ok" ? c.webhookUrl : null);
    let loaded: IntakeState | null;
    try {
      const raw = await readJsonFile(this.stateFile);
      loaded = raw === undefined ? freshState() : parseState(raw);
    } catch {
      loaded = null;
    }
    if (this.stopped) return;
    if (loaded === null) { this.stopWith("stateUnreadable", this.msgState()); return; }
    this.st = loaded;
    for (const ch of cfg.config.channels) this.runtime.set(ch.channelId, { guildConfirmed: false, lastGuildCheck: null, halted: null, lastReadAt: null, behind: false });
    this.state = "running";
    this.reason = null;
    await this.round();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.notifier?.stop();
  }

  status(): DiscordIntakeStatus {
    const now = this.now();
    const cfg = this.config;
    return {
      state: this.state,
      reason: this.reason,
      problem: this.problem,
      testMode: cfg === null ? null : cfg.testMode,
      credentials: this.creds === null ? null : { ...this.creds },
      channels: cfg === null ? [] : cfg.channels.map((ch) => {
        const rt = this.runtime.get(ch.channelId);
        return { kind: ch.kind, enabled: ch.enabled, status: this.channelStatus(ch, rt), lastReadAt: rt?.lastReadAt != null ? new Date(rt.lastReadAt).toISOString() : null };
      }),
      queues: { bug: this.st.queues.bug.length, "error-report": this.st.queues["error-report"].length },
      dropCounts: { ...this.st.dropCounts },
      lastBotCheckAt: this.lastBotCheck === null ? null : new Date(this.lastBotCheck).toISOString(),
      pausedUntil: this.pausedUntil !== null && this.pausedUntil > now ? new Date(this.pausedUntil).toISOString() : null,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private channelStatus(ch: IntakeChannelConfig, rt: ChannelRuntime | undefined): ChannelStatus {
    if (ch.kind === "error-report") return "notReady";
    if (!ch.enabled) return "disabled";
    if (rt !== undefined && rt.halted !== null) return rt.halted;
    if (this.state !== "running") return "intakeStopped";
    if (rt === undefined || !rt.guildConfirmed) return "waitingGuildCheck";
    return this.st.channels[ch.channelId] === undefined ? "waitingFirstRead" : "reading";
  }

  // --- 知らせ（決まった文だけ。投稿の本文を入れない） ---
  private msgState(): string { return `【異常】${formatJst(this.now())} 受け口の作業の記録を読めない・書けないため、受け口を止めました。`; }
  private notify(text: string): void { if (!this.stopped) this.notifier?.notify(text); }
  private stopWith(reason: NonNullable<DiscordIntakeStatus["reason"]>, text: string): void {
    this.state = "stopped";
    this.reason = reason;
    this.notify(text);
  }

  private schedule(): void {
    if (this.stopped || this.state !== "running") return;
    this.timer = this.setTimer(() => { this.timer = null; void this.round(); }, POLL_INTERVAL_MS);
  }

  private async round(): Promise<void> {
    if (this.stopped) return;
    const dropped: DiscordMessage[] = [];
    try {
      await this.doRound(dropped);
    } catch {
      this.lastError = "internal";
      this.consecutiveFailures++;
      console.error("discord-intake: round failed");
    }
    if (this.stopped) return;
    if (dropped.length > 0) {
      const t = dropped.map((m) => Date.parse(m.timestamp)).filter((n) => Number.isFinite(n));
      const first = t.length > 0 ? formatJst(t[0] as number) : "";
      const last = t.length > 0 ? formatJst(t[t.length - 1] as number) : "";
      this.notify(`【異常】${formatJst(this.now())} 順番待ちが満杯（${BUG_QUEUE_LIMIT}件）のため、${first}〜${last}の投稿${dropped.length}件を受けませんでした。`);
    }
    this.schedule();
  }

  private pauseFrom(res: Extract<ApiResult<unknown>, { kind: "rateLimited" }>): void {
    this.lastError = "rateLimited";
    this.pausedUntil = res.retryAfterMs === null ? null : this.now() + res.retryAfterMs;
  }

  private fail(res: Exclude<ApiResult<unknown>, { ok: true }>): void {
    this.lastError = errorCode(res);
    this.consecutiveFailures++;
  }

  private async doRound(dropped: DiscordMessage[]): Promise<void> {
    const cfg = this.config as IntakeConfig;
    const token = this.token as string;
    if (this.pausedUntil !== null) {
      if (this.now() < this.pausedUntil) return;
      this.pausedUntil = null;
    }
    // 2. ボットの照合
    if (this.lastBotCheck === null || this.now() - this.lastBotCheck >= BOT_CHECK_INTERVAL_MS) {
      const me = await this.api.getCurrentUser(token);
      if (this.stopped) return;
      if (!me.ok) {
        if (me.kind === "rateLimited") this.pauseFrom(me);
        else if (me.kind === "unauthorized") this.stopWith("tokenRejected", `【異常】${formatJst(this.now())} ボットのトークンが Discord に拒まれました。受け口を止めました。`);
        else this.fail(me);
        return;
      }
      if (cfg.forbiddenBotIds.includes(me.value.id)) {
        this.stopWith("forbiddenBot", `【異常】${formatJst(this.now())} ボットが本番アプリと同じです。受け口を止めました。`);
        return;
      }
      this.lastBotCheck = this.now();
    }
    const active = cfg.channels.filter((ch) => ch.kind === "bug" && ch.enabled);
    // 3. guildId の確かめ
    for (const ch of active) {
      const rt = this.runtime.get(ch.channelId) as ChannelRuntime;
      if (rt.halted !== null) continue;
      if (rt.guildConfirmed && rt.lastGuildCheck !== null && this.now() - rt.lastGuildCheck < BOT_CHECK_INTERVAL_MS) continue;
      const res = await this.api.getChannel(token, ch.channelId);
      if (this.stopped) return;
      if (res.ok) {
        if (res.value.guild_id !== null && res.value.guild_id === ch.guildId) { rt.guildConfirmed = true; rt.lastGuildCheck = this.now(); }
        else { rt.halted = "guildMismatch"; this.notify(`【異常】${formatJst(this.now())} 受付チャンネルが設定のサーバーのものではありません。このチャンネルを止めました。`); }
      } else if (res.kind === "rateLimited") { this.pauseFrom(res); return; }
      else if (res.kind === "unauthorized") { this.stopWith("tokenRejected", `【異常】${formatJst(this.now())} ボットのトークンが Discord に拒まれました。受け口を止めました。`); return; }
      else if (res.kind === "forbidden" || res.kind === "notFound") this.haltChannel(rt, res);
      else this.fail(res);
    }
    // 4. 読む
    for (const ch of active) {
      const rt = this.runtime.get(ch.channelId) as ChannelRuntime;
      if (rt.halted !== null || !rt.guildConfirmed) continue;
      if (this.state !== "running" || this.stopped) return;
      if (!(await this.readChannel(token, ch, rt, dropped))) return;
    }
  }

  private haltChannel(rt: ChannelRuntime, res: Extract<ApiResult<unknown>, { kind: "forbidden" | "notFound" }>): void {
    rt.halted = res.kind;
    this.lastError = errorCode(res);
    this.notify(`【異常】${formatJst(this.now())} 受付チャンネルを読めません（${res.status}）。このチャンネルを止めました。`);
  }

  /** false を返したらこの周回を打ち切る */
  private async readChannel(token: string, ch: IntakeChannelConfig, rt: ChannelRuntime, dropped: DiscordMessage[]): Promise<boolean> {
    const first = this.st.channels[ch.channelId]?.lastSeenId;
    if (first === undefined) {
      const res = await this.api.listMessagesAfter(token, ch.channelId, null);
      if (this.stopped) return false;
      if (!res.ok) return this.readFailed(res, rt);
      let lastSeen = snowflakeAt(this.now());
      if (res.value.length > 0) lastSeen = res.value.reduce((m, x) => (BigInt(x.id) > m ? BigInt(x.id) : m), 0n).toString();
      const next = cloneState(this.st);
      next.channels[ch.channelId] = { lastSeenId: lastSeen };
      if (!(await this.commit(next))) return false;
      rt.lastReadAt = this.now();
      this.consecutiveFailures = 0;
      return true;
    }
    let cursor = BigInt(first);
    let lastPageFull = false;
    for (let page = 0; page < MAX_PAGES_PER_ROUND; page++) {
      const res = await this.api.listMessagesAfter(token, ch.channelId, cursor.toString());
      if (this.stopped) return false;
      if (!res.ok) return this.readFailed(res, rt);
      const msgs = res.value.filter((m) => BigInt(m.id) > cursor).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
      const next = cloneState(this.st);
      const full: DiscordMessage[] = [];
      for (const m of msgs) {
        const drop = this.sieve(m, ch, next);
        if (drop === "queueFull") full.push(m);
      }
      const maxId = msgs.length > 0 ? BigInt((msgs[msgs.length - 1] as DiscordMessage).id) : cursor;
      next.channels[ch.channelId] = { lastSeenId: maxId.toString() };
      if (!(await this.commit(next))) return false;
      dropped.push(...full);
      rt.lastReadAt = this.now();
      this.consecutiveFailures = 0;
      lastPageFull = res.value.length >= PAGE_SIZE;
      const advanced = maxId > cursor;
      cursor = maxId;
      if (!lastPageFull || !advanced) { lastPageFull = false; break; }
    }
    if (lastPageFull) {
      if (!rt.behind) {
        rt.behind = true;
        this.notify(`【取りこぼしの可能性】${formatJst(this.now())} 受付チャンネルで1回に読む上限（${MAX_PAGES_PER_ROUND * PAGE_SIZE}件）を超えました。次の周回で続きを読みます。`);
      }
    } else {
      rt.behind = false;
    }
    return true;
  }

  private readFailed(res: Exclude<ApiResult<unknown>, { ok: true }>, rt: ChannelRuntime): boolean {
    if (res.kind === "rateLimited") { this.pauseFrom(res); return false; }
    if (res.kind === "unauthorized") { this.stopWith("tokenRejected", `【異常】${formatJst(this.now())} ボットのトークンが Discord に拒まれました。受け口を止めました。`); return false; }
    if (res.kind === "forbidden" || res.kind === "notFound") { this.haltChannel(rt, res); return true; }
    this.fail(res);
    return true;
  }

  /** ふるい。最初に当たった理由1つだけを数える。通ったら順番待ちの末尾に足す（本文は入れない） */
  private sieve(m: DiscordMessage, ch: IntakeChannelConfig, s: IntakeState): DropKey | null {
    let drop: DropKey | null = null;
    if (m.channel_id !== ch.channelId) drop = "channel";
    else if (m.webhook_id !== undefined) drop = "webhook";
    else if (m.author.bot === true) drop = "bot";
    else if (!ch.allowedMessageTypes.includes(m.type)) drop = "messageType";
    else if (!ch.allowedAuthors.some((a) => a.id === m.author.id)) drop = "notAllowedAuthor";
    else if (s.queues.bug.length >= BUG_QUEUE_LIMIT) drop = "queueFull";
    if (drop !== null) { s.dropCounts[drop]++; return drop; }
    if (!s.queues.bug.some((e) => e.messageId === m.id)) s.queues.bug.push({ messageId: m.id, channelId: m.channel_id, postedAt: m.timestamp, authorId: m.author.id, length: m.content.length });
    return null;
  }

  /** 状態を1回で書く。書けたら採用。書けなければ受け口を止める（同じ投稿を2回受けないため進まない） */
  private async commit(next: IntakeState): Promise<boolean> {
    try {
      await this.serial(() => (this.stopped ? Promise.resolve() : writeJsonAtomic(this.stateFile, next)));
    } catch {
      if (!this.stopped) this.stopWith("stateWriteFailed", this.msgState());
      return false;
    }
    if (this.stopped) return false;
    this.st = next;
    return true;
  }
}
