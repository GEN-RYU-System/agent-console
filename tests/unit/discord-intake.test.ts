import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordApi, type ApiResult, type DiscordApi, type DiscordMessage } from "../../server/discord-api.ts";
import type { DiscordCredentials } from "../../server/discord-credentials.ts";
import type { ConfigResult, IntakeChannelConfig, IntakeConfig } from "../../server/discord-intake-config.ts";
import { BOT_CHECK_INTERVAL_MS, BUG_QUEUE_LIMIT, DiscordIntake, INTAKE_STATE_FILE, MAX_PAGES_PER_ROUND, POLL_INTERVAL_MS, matchesErrorReport } from "../../server/discord-intake.ts";

// 試験の id はすべて作り物（実在の id ではない）
const ID = (n: number): string => (100000000000000000n + BigInt(n)).toString();
const BIG = (n: number): string => (1000000000000000000n + BigInt(n)).toString();
const GUILD = ID(2);
const CH = ID(3);
const CH2 = ID(13);
const ER_CH = ID(5);
const AUTHOR = ID(4);
const OTHER_AUTHOR = ID(44);
const FORBID = ID(1);
const ME = ID(99);
const BODY_MARKER = "BODY-MARKER-should-never-appear";
const TOKEN_MARKER = "TOKEN-MARKER-should-never-appear";
const T0 = Date.UTC(2026, 9, 25, 3, 0, 0); // 日本時間 2026/10/25 12:00
const snowflakeAt = (ms: number): string => String((BigInt(ms) - 1420070400000n) << 22n);

const bugCh = (over: Partial<IntakeChannelConfig> = {}): IntakeChannelConfig => ({ kind: "bug", enabled: true, guildId: GUILD, channelId: CH, allowedAuthors: [{ id: AUTHOR, name: "x" }], allowedMessageTypes: [0, 19], ...over });
const erCh = (over: Partial<IntakeChannelConfig> = {}): IntakeChannelConfig => ({ kind: "error-report", enabled: true, guildId: GUILD, channelId: ER_CH, allowedAuthors: [], allowedMessageTypes: [], reportWebhookId: ID(6), ...over });

function msg(n: number, over: Record<string, unknown> = {}, channel = CH): DiscordMessage {
  return { id: ID(n), channel_id: channel, author: { id: AUTHOR }, content: "hello", timestamp: new Date(T0 + n * 1000).toISOString(), type: 0, ...over } as DiscordMessage;
}

type Hook<T> = ((...a: never[]) => Promise<ApiResult<T>>) | undefined;
interface World {
  msgs: Map<string, DiscordMessage[]>;
  guild: Record<string, string | null>;
  me: string;
  ignoreAfter: boolean;
  list?: Hook<DiscordMessage[]>;
  getChannel?: Hook<{ guild_id: string | null }>;
  getMe?: Hook<{ id: string }>;
}

const timersOf = () => {
  const t = { pending: [] as { f: () => void; ms: number; id: number }[], scheduled: 0, cleared: 0, n: 0 };
  return {
    state: t,
    setTimer: (f: () => void, ms: number): unknown => { const id = ++t.n; t.scheduled++; t.pending.push({ f, ms, id }); return id; },
    clearTimer: (h: unknown): void => { t.cleared++; const i = t.pending.findIndex((p) => p.id === h); if (i >= 0) t.pending.splice(i, 1); },
    fire: (): number | undefined => { const p = t.pending.shift(); p?.f(); return p?.ms; },
  };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (cond()) return; await sleep(2); }
  throw new Error(`timeout waiting for ${label}`);
}

function setup(opts: { channels?: IntakeChannelConfig[]; preState?: unknown; rawState?: string; credState?: DiscordCredentials["state"]; api?: DiscordApi; testMode?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-intake-"));
  const stateFile = path.join(dir, INTAKE_STATE_FILE);
  if (opts.preState !== undefined) writeFileSync(stateFile, JSON.stringify(opts.preState));
  if (opts.rawState !== undefined) writeFileSync(stateFile, opts.rawState);
  const clock = { t: T0 };
  const timers = timersOf();
  const world: World = { msgs: new Map(), guild: {}, me: ME, ignoreAfter: false };
  const channels = opts.channels ?? [bugCh(), erCh({ enabled: false })];
  for (const c of channels) { world.msgs.set(c.channelId, []); world.guild[c.channelId] = c.guildId; }
  const calls = { list: [] as { channelId: string; after: string | null }[], getChannel: 0, getMe: 0 };
  const api: DiscordApi = opts.api ?? {
    async listMessagesAfter(_t, channelId, after) {
      calls.list.push({ channelId, after });
      if (world.list) return (world.list as (c: string, a: string | null) => Promise<ApiResult<DiscordMessage[]>>)(channelId, after);
      const all = (world.msgs.get(channelId) ?? []).filter((m) => world.ignoreAfter || after === null || BigInt(m.id) > BigInt(after));
      const asc = [...all].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const page = after === null ? asc.slice(-100) : asc.slice(0, 100);
      return { ok: true, value: page.reverse() };
    },
    async getChannel(_t, channelId) {
      calls.getChannel++;
      if (world.getChannel) return (world.getChannel as () => Promise<ApiResult<{ guild_id: string | null }>>)();
      return { ok: true, value: { guild_id: world.guild[channelId] ?? null } };
    },
    async getCurrentUser() {
      calls.getMe++;
      if (world.getMe) return (world.getMe as () => Promise<ApiResult<{ id: string }>>)();
      return { ok: true, value: { id: world.me } };
    },
    async executeWebhook() { return { ok: true, value: null }; },
  };
  const notes: string[] = [];
  const notifier = { made: [] as (string | null)[], stops: 0 };
  const config: IntakeConfig = { testMode: opts.testMode ?? true, forbiddenBotIds: [FORBID], channels };
  const state = opts.credState ?? { bot: "ok", webhook: "ok" };
  const creds: DiscordCredentials = { botToken: state.bot === "ok" ? TOKEN_MARKER : null, webhookUrl: state.webhook === "ok" ? "https://discord.com/api/webhooks/100000000000000001/fake" : null, state };
  const readConfigResult: { v: ConfigResult } = { v: { ok: true, config } };
  const hooks = { readConfig: (): Promise<ConfigResult> => Promise.resolve(readConfigResult.v) };
  const make = (): DiscordIntake => new DiscordIntake({ dataDir: dir, securityBin: "/nonexistent", macos: null }, {
    now: () => clock.t,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    api,
    loadCredentials: async () => creds,
    readConfig: () => hooks.readConfig(),
    makeNotifier: (url) => { notifier.made.push(url); return { notify: (t) => { notes.push(t); }, stop: () => { notifier.stops++; } }; },
  });
  const intake = make();
  const nextRound = async (advanceMs = POLL_INTERVAL_MS): Promise<void> => {
    clock.t += advanceMs;
    const before = timers.state.scheduled;
    timers.fire();
    await until(() => timers.state.scheduled > before || intake.status().state !== "running", "next round");
  };
  const file = (): { channels: Record<string, { lastSeenId: string }>; queues: { bug: { messageId: string; length: number }[] }; dropCounts: Record<string, number> } => JSON.parse(readFileSync(stateFile, "utf8"));
  return { dir, stateFile, clock, timers, world, calls, api, notes, notifier, config, intake, make, nextRound, file, hooks, readConfigResult };
}

const seeded = (lastSeen: string, queue: unknown[] = []) => ({ version: 1, channels: { [CH]: { lastSeenId: lastSeen } }, queues: { bug: queue, "error-report": [] }, dropCounts: { channel: 0, webhook: 0, bot: 0, messageType: 0, notAllowedAuthor: 0, queueFull: 0 } });
const entry = (n: number) => ({ messageId: ID(n), channelId: CH, postedAt: "2026-10-25T00:00:00.000Z", authorId: AUTHOR, length: 5 });

afterEach(() => { vi.restoreAllMocks(); });

describe("I1 初めて読む", () => {
  it("3件あっても受けず、lastSeenId は一番大きい id", async () => {
    const h = setup();
    h.world.msgs.set(CH, [msg(5), msg(7), msg(6)]);
    await h.intake.start();
    expect(h.intake.status().queues.bug).toBe(0);
    expect(h.file().channels[CH]?.lastSeenId).toBe(ID(7));
    expect(h.calls.list[0]).toEqual({ channelId: CH, after: null });
  });
  it("0件なら lastSeenId は読んだ時刻の snowflake。次の周回で新しい1件は受け、古い id は受けない", async () => {
    const h = setup();
    await h.intake.start();
    const snow = snowflakeAt(T0);
    expect(h.file().channels[CH]?.lastSeenId).toBe(snow);
    h.world.ignoreAfter = true; // 古い id が返ってきても受けないことを確かめる
    h.world.msgs.set(CH, [msg(1), msg(2, { id: (BigInt(snow) + 1n).toString() })]);
    await h.nextRound();
    expect(h.file().queues.bug.map((q) => q.messageId)).toEqual([(BigInt(snow) + 1n).toString()]);
  });
});

describe("I2 並びと重複", () => {
  it("新しい順で返ったページを小さい順に受け、lastSeenId 以下（自身を含む）は受けない。id の比較は BigInt", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.ignoreAfter = true;
    h.world.msgs.set(CH, [msg(0), msg(1), msg(2, { id: BIG(0) }), msg(3, { id: BIG(5) })]);
    await h.intake.start();
    expect(h.file().queues.bug.map((q) => q.messageId)).toEqual([ID(1), BIG(0), BIG(5)]);
    expect(h.file().channels[CH]?.lastSeenId).toBe(BIG(5));
    await h.nextRound();
    expect(h.file().queues.bug).toHaveLength(3);
  });
});

describe("I3 1周回の上限", () => {
  it("5回で止まり知らせ1件、次の周回で続き。続けて上限でも知らせは増えず、追いついた後の上限で2件目", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    const stranger = (n: number): DiscordMessage => msg(n, { author: { id: OTHER_AUTHOR } });
    h.world.msgs.set(CH, Array.from({ length: 1200 }, (_, i) => stranger(i + 1)));
    await h.intake.start();
    expect(h.calls.list).toHaveLength(MAX_PAGES_PER_ROUND);
    expect(h.notes.filter((n) => n.includes("取りこぼしの可能性"))).toHaveLength(1);
    expect(h.calls.list[1]?.after).toBe(ID(100));
    await h.nextRound();
    expect(h.calls.list).toHaveLength(MAX_PAGES_PER_ROUND * 2);
    expect(h.calls.list[MAX_PAGES_PER_ROUND]?.after).toBe(ID(500));
    expect(h.notes.filter((n) => n.includes("取りこぼしの可能性"))).toHaveLength(1);
    await h.nextRound(); // 残り200件＋空 → 追いつく
    expect(h.file().channels[CH]?.lastSeenId).toBe(ID(1200));
    expect(h.file().dropCounts.notAllowedAuthor).toBe(1200);
    expect(h.notes.filter((n) => n.includes("取りこぼしの可能性"))).toHaveLength(1);
    h.world.msgs.set(CH, [...(h.world.msgs.get(CH) ?? []), ...Array.from({ length: 600 }, (_, i) => stranger(1201 + i))]);
    await h.nextRound();
    expect(h.notes.filter((n) => n.includes("取りこぼしの可能性"))).toHaveLength(2);
  });
});

describe("I4 ふるい", () => {
  it("理由ごとに1ずつ。0 と 19 は受ける。Webhook の bot 投稿は webhook に数える", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.msgs.set(CH, [
      msg(1, { channel_id: ID(77) }),
      msg(2, { webhook_id: ID(8), author: { id: ID(8), bot: true } }),
      msg(3, { author: { id: ID(9), bot: true } }),
      msg(4, { type: 6 }),
      msg(5, { author: { id: OTHER_AUTHOR } }),
      msg(6, { type: 0 }),
      msg(7, { type: 19 }),
    ]);
    await h.intake.start();
    const f = h.file();
    expect(f.dropCounts).toEqual({ channel: 1, webhook: 1, bot: 1, messageType: 1, notAllowedAuthor: 1, queueFull: 0 });
    expect(f.queues.bug.map((q) => q.messageId)).toEqual([ID(6), ID(7)]);
  });
});

describe("I5 順番待ちの満杯", () => {
  it("21件目は queueFull。1周回で知らせ1件にまとめる（件数3）。0件の周回は知らせない", async () => {
    const h = setup({ preState: seeded(ID(0), Array.from({ length: BUG_QUEUE_LIMIT }, (_, i) => entry(i + 1000))) });
    h.world.msgs.set(CH, [msg(1), msg(2), msg(3)]);
    await h.intake.start();
    expect(h.file().dropCounts.queueFull).toBe(3);
    expect(h.file().queues.bug).toHaveLength(BUG_QUEUE_LIMIT);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("投稿3件");
    expect(h.notes[0]).toContain("2026/10/25 12:00");
    await h.nextRound();
    expect(h.notes).toHaveLength(1);
  });
  it("1件だけでも同じ形で知らせる", async () => {
    const h = setup({ preState: seeded(ID(0), Array.from({ length: BUG_QUEUE_LIMIT }, (_, i) => entry(i + 1000))) });
    h.world.msgs.set(CH, [msg(1)]);
    await h.intake.start();
    expect(h.file().dropCounts.queueFull).toBe(1);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("投稿1件");
  });
});

describe("I6 再起動", () => {
  it("作り直しても同じ投稿を2回受けない", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.msgs.set(CH, [msg(1), msg(2)]);
    await h.intake.start();
    h.intake.stop();
    h.world.ignoreAfter = true;
    const again = h.make();
    await again.start();
    expect(h.file().queues.bug.map((q) => q.messageId)).toEqual([ID(1), ID(2)]);
    expect(again.status().queues.bug).toBe(2);
  });
});

describe("I7 状態ファイルが壊れている", () => {
  it("読みに行かず、書き換えず、stateUnreadable、知らせ1件。知らせの部品が先に作られている", async () => {
    const h = setup({ rawState: "{ broken" });
    await h.intake.start();
    expect(h.calls.list).toHaveLength(0);
    expect(readFileSync(h.stateFile, "utf8")).toBe("{ broken");
    expect(h.intake.status().state).toBe("stopped");
    expect(h.intake.status().reason).toBe("stateUnreadable");
    expect(h.notifier.made).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
  });
  it("形の違う状態（version が 1 でない）も同じ扱い。Webhook が無ければ部品へ null を渡す", async () => {
    const h = setup({ rawState: JSON.stringify({ ...seeded(ID(0)), version: 2 }), credState: { bot: "ok", webhook: "unreadable" } });
    await h.intake.start();
    expect(h.intake.status().reason).toBe("stateUnreadable");
    expect(h.notifier.made).toEqual([null]);
    expect(h.notes).toHaveLength(1);
  });
});

describe("I8 書けない", () => {
  it("stateWriteFailed で止まり、lastSeenId が進まない", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.msgs.set(CH, [msg(1)]);
    chmodSync(h.dir, 0o500);
    try {
      await h.intake.start();
    } finally {
      chmodSync(h.dir, 0o700);
    }
    expect(h.intake.status().state).toBe("stopped");
    expect(h.intake.status().reason).toBe("stateWriteFailed");
    expect(h.file().channels[CH]?.lastSeenId).toBe(ID(0));
    expect(h.file().queues.bug).toHaveLength(0);
    expect(h.notes).toHaveLength(1);
    expect(h.timers.state.pending).toHaveLength(0);
  });
});

describe("I9 ボットの照合", () => {
  it("最初の読みの前に1回、59分後は呼ばず、60分後に1回", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    await h.intake.start();
    expect(h.calls.getMe).toBe(1);
    await h.nextRound(BOT_CHECK_INTERVAL_MS - 60_000);
    expect(h.calls.getMe).toBe(1);
    await h.nextRound(60_000);
    expect(h.calls.getMe).toBe(2);
  });
  it("forbiddenBotIds の id なら止まり、知らせ1件、メッセージを読まない", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.me = FORBID;
    await h.intake.start();
    expect(h.intake.status().reason).toBe("forbiddenBot");
    expect(h.calls.list).toHaveLength(0);
    expect(h.notes).toHaveLength(1);
  });
  it("照合が failed ならその周回は読まない（次の周回でやり直す）", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.getMe = async () => ({ ok: false, kind: "failed", reason: "network" });
    await h.intake.start();
    expect(h.calls.list).toHaveLength(0);
    h.world.getMe = undefined;
    await h.nextRound();
    expect(h.calls.list).toHaveLength(1);
  });
});

describe("I10 guildId の確かめ", () => {
  const two = [bugCh(), bugCh({ channelId: CH2 })];
  it("違うチャンネルだけ止まり知らせ1件、ほかは読む", async () => {
    const h = setup({ channels: two, preState: { ...seeded(ID(0)), channels: { [CH]: { lastSeenId: ID(0) }, [CH2]: { lastSeenId: ID(0) } } } });
    h.world.guild[CH] = ID(55);
    await h.intake.start();
    const st = h.intake.status().channels;
    expect(st[0]?.status).toBe("guildMismatch");
    expect(st[1]?.status).toBe("reading");
    expect(h.calls.list.every((c) => c.channelId === CH2)).toBe(true);
    expect(h.calls.list.length).toBeGreaterThan(0);
    expect(h.notes).toHaveLength(1);
  });
  it("getChannel が failed なら読まず waitingGuildCheck、次の周回でやり直し、同じなら読む。確認済みのあとの失敗でも読み続ける", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.getChannel = async () => ({ ok: false, kind: "failed", reason: "timeout" });
    await h.intake.start();
    expect(h.calls.list).toHaveLength(0);
    expect(h.intake.status().channels[0]?.status).toBe("waitingGuildCheck");
    h.world.getChannel = undefined;
    await h.nextRound();
    expect(h.calls.getChannel).toBe(2);
    expect(h.calls.list).toHaveLength(1);
    expect(h.intake.status().channels[0]?.status).toBe("reading");
    h.world.getChannel = async () => ({ ok: false, kind: "failed", reason: "network" });
    const before = h.calls.list.length;
    await h.nextRound(BOT_CHECK_INTERVAL_MS);
    expect(h.calls.list.length).toBe(before + 1);
    expect(h.intake.status().channels[0]?.status).toBe("reading");
  });
  it("guild_id が無いチャンネルは guildMismatch で止まり知らせ1件", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.guild[CH] = null;
    await h.intake.start();
    expect(h.intake.status().channels[0]?.status).toBe("guildMismatch");
    expect(h.calls.list).toHaveLength(0);
    expect(h.notes).toHaveLength(1);
  });
});

describe("I11 429", () => {
  it("pausedUntil まで通信0回、過ぎたら読む", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    await h.intake.start();
    h.world.list = async () => ({ ok: false, kind: "rateLimited", retryAfterMs: 90_000 });
    await h.nextRound();
    const st = h.intake.status();
    expect(st.pausedUntil).toBe(new Date(h.clock.t + 90_000).toISOString());
    const counts = { l: h.calls.list.length, g: h.calls.getChannel, m: h.calls.getMe };
    await h.nextRound(); // +30秒
    await h.nextRound(); // +60秒
    expect({ l: h.calls.list.length, g: h.calls.getChannel, m: h.calls.getMe }).toEqual(counts);
    h.world.list = undefined;
    await h.nextRound(); // +90秒を過ぎる
    expect(h.calls.list.length).toBe(counts.l + 1);
    expect(h.intake.status().pausedUntil).toBeNull();
  });
});

describe("I12 401 / 403 / 500", () => {
  it("401 で止まり知らせ1件", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.list = async () => ({ ok: false, kind: "unauthorized" });
    await h.intake.start();
    expect(h.intake.status().reason).toBe("tokenRejected");
    expect(h.notes).toHaveLength(1);
    expect(h.timers.state.pending).toHaveLength(0);
  });
  it("403 でそのチャンネルだけ止まる", async () => {
    const h = setup({ channels: [bugCh(), bugCh({ channelId: CH2 })], preState: { ...seeded(ID(0)), channels: { [CH]: { lastSeenId: ID(0) }, [CH2]: { lastSeenId: ID(0) } } } });
    h.world.list = async (c: string) => (c === CH ? { ok: false, kind: "forbidden", status: 403 } : { ok: true, value: [] });
    await h.intake.start();
    const st = h.intake.status();
    expect(st.state).toBe("running");
    expect(st.channels.map((c) => c.status)).toEqual(["forbidden", "reading"]);
    expect(st.lastError).toBe("forbidden:403");
    expect(h.notes).toHaveLength(1);
  });
  it("500 は次の周回でやり直し、知らせない。読めたら続けての失敗は0に戻る", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.list = async () => ({ ok: false, kind: "failed", reason: "http", status: 500 });
    await h.intake.start();
    expect(h.intake.status().consecutiveFailures).toBe(1);
    await h.nextRound();
    expect(h.intake.status().consecutiveFailures).toBe(2);
    expect(h.notes).toHaveLength(0);
    h.world.list = undefined;
    await h.nextRound();
    expect(h.intake.status().consecutiveFailures).toBe(0);
  });
});

describe("I13 周回は重ならない", () => {
  it("通信が終わらない間は次の周回が始まらない（タイマーも張られない）", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    let release: (r: ApiResult<DiscordMessage[]>) => void = () => undefined;
    h.world.list = () => new Promise((r) => { release = r; });
    const p = h.intake.start();
    await until(() => h.calls.list.length === 1, "first list");
    h.clock.t += 5 * POLL_INTERVAL_MS;
    await sleep(20);
    expect(h.timers.state.pending).toHaveLength(0);
    expect(h.calls.list).toHaveLength(1);
    release({ ok: true, value: [] });
    await p;
    expect(h.timers.state.pending).toHaveLength(1);
    expect(h.timers.state.pending[0]?.ms).toBe(POLL_INTERVAL_MS);
  });
});

describe("I14 状態の対応表とエラーの値", () => {
  it("設定が無い → disabled / noConfig、通信0回", async () => {
    const h = setup();
    h.readConfigResult.v = { ok: false, reason: "missing" };
    await h.intake.start();
    const s = h.intake.status();
    expect([s.state, s.reason]).toEqual(["disabled", "noConfig"]);
    expect(h.calls).toEqual({ list: [], getChannel: 0, getMe: 0 });
  });
  it("設定の形が違う → stopped / configInvalid（problem は欄の名前だけ）", async () => {
    const h = setup();
    h.readConfigResult.v = { ok: false, reason: "invalid", problem: "testMode" };
    await h.intake.start();
    const s = h.intake.status();
    expect([s.state, s.reason, s.problem]).toEqual(["stopped", "configInvalid", "testMode"]);
    expect(h.calls).toEqual({ list: [], getChannel: 0, getMe: 0 });
  });
  it("ボットの秘密が読めない → stopped / credentials、通信0回", async () => {
    const h = setup({ credState: { bot: "unreadable", webhook: "ok" } });
    await h.intake.start();
    const s = h.intake.status();
    expect([s.state, s.reason]).toEqual(["stopped", "credentials"]);
    expect(s.credentials).toEqual({ bot: "unreadable", webhook: "ok" });
    expect(h.calls).toEqual({ list: [], getChannel: 0, getMe: 0 });
  });
  it("start 前は disabled / notStarted", () => {
    const s = setup().intake.status();
    expect([s.state, s.reason]).toEqual(["disabled", "notStarted"]);
  });
  it("500 のあと lastError は failed:500", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    h.world.list = async () => ({ ok: false, kind: "failed", reason: "http", status: 500 });
    await h.intake.start();
    expect(h.intake.status().lastError).toBe("failed:500");
  });
  it("通信の失敗は lastError が network で、例外の文は入らない", async () => {
    const api = createDiscordApi(async () => { throw new Error(`ECONNRESET ${TOKEN_MARKER}`); });
    const h = setup({ preState: seeded(ID(0)), api });
    await h.intake.start();
    const s = h.intake.status();
    expect(s.lastError).toBe("network");
    expect(JSON.stringify(s)).not.toContain("ECONNRESET");
    expect(JSON.stringify(s)).not.toContain(TOKEN_MARKER);
  });
});

describe("I15 error-report は読まない", () => {
  it("enabled: true でも読まず notReady", async () => {
    const h = setup({ channels: [bugCh(), erCh({ enabled: true })], preState: seeded(ID(0)) });
    await h.intake.start();
    expect(h.calls.list.every((c) => c.channelId === CH)).toBe(true);
    expect(h.calls.getChannel).toBe(1);
    expect(h.intake.status().channels.map((c) => c.status)).toEqual(["reading", "notReady"]);
  });
});

describe("I16 本文とトークンを出さない", () => {
  it("状態ファイル・status()・知らせ・console のどこにも出ない", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => undefined));
    const h = setup({ preState: seeded(ID(0), Array.from({ length: BUG_QUEUE_LIMIT - 1 }, (_, i) => entry(i + 1000))) });
    h.world.msgs.set(CH, [msg(1, { content: BODY_MARKER }), msg(2, { content: BODY_MARKER }), msg(3, { content: BODY_MARKER, author: { id: OTHER_AUTHOR } })]);
    await h.intake.start();
    h.world.list = async () => ({ ok: false, kind: "failed", reason: "http", status: 500 });
    await h.nextRound();
    expect(h.file().queues.bug.find((q) => q.messageId === ID(1))?.length).toBe(BODY_MARKER.length);
    const everything = [readFileSync(h.stateFile, "utf8"), JSON.stringify(h.intake.status()), h.notes.join("\n"), ...spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)))].join("\n");
    expect(h.notes.length).toBeGreaterThan(0);
    expect(everything).not.toContain(BODY_MARKER);
    expect(everything).not.toContain(TOKEN_MARKER);
  });
});

describe("I17 matchesErrorReport", () => {
  const W = ID(6);
  it("webhook_id が同じで ER- と6桁を含むなら true", () => {
    expect(matchesErrorReport({ webhook_id: W, content: "誤り報告 ER-000123 項目: x" }, W)).toBe(true);
  });
  it.each([
    ["別の webhook", { webhook_id: ID(7), content: "ER-000123" }],
    ["webhook_id が無い", { content: "ER-000123" }],
    ["5桁", { webhook_id: W, content: "ER-12345" }],
    ["7桁", { webhook_id: W, content: "ER-1234567" }],
    ["前に英数字", { webhook_id: W, content: "XER-123456" }],
  ])("false: %s", (_l, m) => {
    expect(matchesErrorReport(m, W)).toBe(false);
  });
});

describe("I18 stop()", () => {
  it("通信の途中で stop → 状態ファイルへの書き込み0回・setTimer 0回・notifier.stop 1回", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    const before = readFileSync(h.stateFile, "utf8");
    let release: (r: ApiResult<DiscordMessage[]>) => void = () => undefined;
    h.world.list = () => new Promise((r) => { release = r; });
    const p = h.intake.start();
    await until(() => h.calls.list.length === 1, "list in flight");
    h.intake.stop();
    release({ ok: true, value: [msg(1)] });
    await p;
    await sleep(20);
    expect(readFileSync(h.stateFile, "utf8")).toBe(before);
    expect(h.timers.state.scheduled).toBe(0);
    expect(h.notifier.stops).toBe(1);
    expect(h.notes).toHaveLength(0);
  });
  it("start の途中（設定の読み込み中）で stop → 周回は始まらない", async () => {
    const h = setup({ preState: seeded(ID(0)) });
    let release: (r: ConfigResult) => void = () => undefined;
    h.hooks.readConfig = () => new Promise((r) => { release = r; });
    const p = h.intake.start();
    await sleep(5);
    h.intake.stop();
    release({ ok: true, config: h.config });
    await p;
    expect(h.calls.list).toHaveLength(0);
    expect(h.timers.state.scheduled).toBe(0);
    expect(h.notifier.made).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });
});
