import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../../server/hub.ts";
import { SessionConflictError, SessionInputError } from "../../server/sessions.ts";
import { RESERVATIONS_FILE, ReservationService, ReservationStore, type Reservation, type ReservationAuditSink } from "../../server/reservations.ts";
import { ScheduleGate } from "../../server/schedule-gate.ts";
import { RESERVE_TOKEN_FILE, setupReserveToken } from "../../server/reserve-token.ts";
import { RESERVE_TOKEN, startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

type Verdict = { ok: boolean; hasClaude: boolean; reason?: string };
const BASE_MS = Date.parse("2026-10-12T00:00:00.000Z"); // 09:00 JST 月曜
const TIMING = { pollMs: 5, timeoutMs: 80, namePollMs: 5, nameTimeoutMs: 20 };
const STAGGER = 3000;

const makeRoot = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-resv-root-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
};

const setup = async (opts: { verdicts?: Verdict[]; capacity?: boolean } = {}) => {
  const root = makeRoot();
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-resv-")));
  const cfg = { salesanchorRoot: root, roles: [{ id: "echo", needsWorktree: false, command: ["echo"] }], pasteSubmitDelayMs: 0, restoreStaggerMs: STAGGER };
  const clock = { t: BASE_MS };
  const created: { id: string; exited: boolean }[] = [];
  const sessions = {
    get: vi.fn((id: string) => created.find((s) => s.id === id)),
    write: vi.fn(),
    onChange: vi.fn(),
    isClosing: vi.fn(() => false),
    hasCapacity: vi.fn(() => opts.capacity ?? true),
    restore: vi.fn(() => { const s = { id: `s${created.length + 1}`, exited: false }; created.push(s); return s; }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const queue = [...(opts.verdicts ?? [{ ok: true, hasClaude: true }])];
  const checkInput = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]));
  const hub = { checkInput, sessions, config: cfg, submitText: (id: string, text: string) => Hub.prototype.submitText.call(hub, id, text), sendName: () => true, displayNames: () => new Map<string, string>(), writing: new Set<string>(), tryBeginWrite: (id: string) => Hub.prototype.tryBeginWrite.call(hub, id), endWrite: (id: string) => Hub.prototype.endWrite.call(hub, id) };
  const store = new ReservationStore(dir);
  const service = new ReservationService(cfg as never, sessions as never, hub as never, store, () => new Date(clock.t), TIMING, true);
  const input = (over: Record<string, unknown> = {}) => ({ name: "measure", roleId: "echo", cwd: root, date: "2026-10-12", time: "09:10", promptText: "hello", ...over });
  return { service, store, sessions, hub, clock, dir, root, input };
};
const MIN = 60_000;
const run = async (service: ReservationService) => { await service.tick(); await service.settled(); };
const AGENT = { purpose: "measure", measureNote: "効果を測る" };
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

describe("reservation create and dispatch", () => {
  it("R1 creating a reservation does not open a session", async () => {
    const { service, sessions, input } = await setup();
    const r = await service.create(input(), "ui");
    expect(r).toMatchObject({ status: "pending", createdBy: "ui", runAtJst: "2026-10-12T09:10+09:00" });
    expect(sessions.restore).not.toHaveBeenCalled();
    expect(service.list()).toHaveLength(1);
  });

  it("R2 sends once at the first tick after runAt using bracketed paste then CR", async () => {
    const { service, sessions, clock, input } = await setup();
    await service.create(input({ promptText: "go" }), "ui");
    clock.t = BASE_MS + 9 * MIN;
    await run(service);
    expect(sessions.restore).not.toHaveBeenCalled();
    clock.t = BASE_MS + 10 * MIN;
    await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
    expect(sessions.write.mock.calls.map((c) => c[1])).toEqual(["\u001b[200~go\u001b[201~", "\r"]);
    expect(service.list()[0]).toMatchObject({ status: "done", outcome: "sent" });
    expect(service.list()[0].lateMinutes).toBeUndefined();
    clock.t += 10 * MIN;
    await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
  });

  it("R3 sends after the restore is ready with lateMinutes, and only past 60 seconds", async () => {
    const late = async (lateMs: number) => {
      const { service, sessions, clock, input } = await setup();
      await service.create(input(), "ui");
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      clock.t = BASE_MS + 10 * MIN + lateMs;
      const started = service.start(ready);
      await new Promise((r) => setTimeout(r, 20));
      expect(sessions.restore).not.toHaveBeenCalled();
      release();
      await started;
      await run(service);
      service.stop();
      expect(sessions.restore).toHaveBeenCalledTimes(1);
      return service.list()[0].lateMinutes;
    };
    expect(await late(10 * MIN)).toBe(10);
    expect(await late(30_000)).toBeUndefined();
    expect(await late(90_000)).toBe(1);
    expect(await late(120_000)).toBe(2);
  });

  it("R-name prefixes the session name with [予約] and keeps it within 40 units", async () => {
    const { service, sessions, clock, input } = await setup();
    await service.create(input({ name: "measure" }), "ui");
    clock.t = BASE_MS + 30 * MIN;
    await run(service);
    expect((sessions.restore.mock.calls[0] as unknown as [{ name: string }])[0].name).toBe("[予約] measure 10/12 09:10");
    expect(service.list().find((r) => r.name === "measure")?.sessionName).toBe("[予約] measure 10/12 09:10");
    const long = await setup();
    await long.service.create(long.input({ name: "あ".repeat(40) }), "ui");
    long.clock.t = BASE_MS + 30 * MIN;
    await run(long.service);
    const n = (long.sessions.restore.mock.calls[0] as unknown as [{ name: string }])[0].name;
    expect(n).toBe(`[予約] ${"あ".repeat(23)} 10/12 09:10`);
    expect(n.length).toBeLessThanOrEqual(40);
  });

  it("R3b with three overdue reservations sends oldest first, one per 3 seconds or more", async () => {
    const { service, sessions, clock, input } = await setup();
    await service.create(input({ name: "c", time: "09:12" }), "ui");
    await service.create(input({ name: "a", time: "09:10" }), "ui");
    await service.create(input({ name: "b", time: "09:11" }), "ui");
    clock.t = BASE_MS + 30 * MIN;
    await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
    clock.t += 1000; await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
    clock.t += 2000; await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(2);
    clock.t += STAGGER; await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(3);
    const names = sessions.restore.mock.calls.map((c) => (c as unknown as [{ name: string }])[0].name);
    expect(names.map((n) => n.split(" ")[1])).toEqual(["a", "b", "c"]);
  });

  it("R4 does not send when the dispatching save fails, and retries only after 60 seconds", async () => {
    const { service, store, sessions, clock, input } = await setup();
    const err = quiet();
    await service.create(input(), "ui");
    clock.t = BASE_MS + 10 * MIN;
    const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk"));
    await run(service);
    expect(sessions.restore).not.toHaveBeenCalled();
    expect(service.list()[0].status).toBe("pending");
    save.mockRestore();
    clock.t += 30_000; await run(service);
    expect(sessions.restore).not.toHaveBeenCalled();
    clock.t += 31_000; await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("R4 does not start the clock when the interrupted save fails", async () => {
    const { service, store, sessions, clock, input, dir } = await setup();
    const err = quiet();
    await service.create(input(), "ui");
    const raw = JSON.parse(readFileSync(path.join(dir, RESERVATIONS_FILE), "utf8")) as { version: number; items: Reservation[] };
    raw.items[0].status = "dispatching";
    writeFileSync(path.join(dir, RESERVATIONS_FILE), JSON.stringify(raw));
    const second = new ReservationService((service as unknown as { config: never }).config, sessions as never, (service as unknown as { hub: never }).hub, store, () => new Date(clock.t), TIMING);
    vi.spyOn(store, "save").mockRejectedValue(new Error("disk"));
    const timers = vi.spyOn(globalThis, "setInterval");
    await second.start();
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
    second.stop();
    err.mockRestore();
  });

  it("R4b a reservation created while the initial load is running is kept, and listReady waits for the load", async () => {
    const { service, store, sessions, clock, input } = await setup();
    const existing = await service.create(input({ name: "existing" }), "ui");
    const fresh = new ReservationService((service as unknown as { config: never }).config, sessions as never, (service as unknown as { hub: never }).hub, store, () => new Date(clock.t), TIMING);
    const realList = store.list.bind(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "list").mockImplementation(async () => { const before = await realList(); await gate; return before; });
    const started = fresh.start();
    const created = fresh.create(input(), "ui");
    const listed = fresh.listReady();
    await new Promise((r) => setTimeout(r, 20));
    expect(fresh.list()).toHaveLength(0);
    release();
    const r = await created;
    await started;
    fresh.stop();
    expect((await listed).map((x) => x.id)).toEqual([existing.id]);
    expect(fresh.list().map((x) => x.id).sort()).toEqual([existing.id, r.id].sort());
    const saved = await realList();
    expect(saved.map((x) => x.id).sort()).toEqual([existing.id, r.id].sort());
  });

  it("R5 does not send when cancelled or changed right before sending", async () => {
    const { service, sessions, clock, input } = await setup({ verdicts: [{ ok: false, hasClaude: false }, { ok: true, hasClaude: true }] });
    const r = await service.create(input(), "ui");
    clock.t = BASE_MS + 10 * MIN;
    await service.tick();
    expect(service.list()[0].status).toBe("dispatching");
    (service as unknown as { items: Reservation[] }).items = service.list().map((x) => ({ ...x, status: "cancelled" as const }));
    await service.settled();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(service.list().find((x) => x.id === r.id)?.status).toBe("cancelled");
  });

  it("R6 marks reservations left in dispatching as interrupted at start, without sending", async () => {
    const { service, store, sessions, clock, input, dir } = await setup();
    await service.create(input(), "ui");
    const raw = JSON.parse(readFileSync(path.join(dir, RESERVATIONS_FILE), "utf8")) as { version: number; items: Reservation[] };
    raw.items[0].status = "dispatching";
    writeFileSync(path.join(dir, RESERVATIONS_FILE), JSON.stringify(raw));
    const restarted = new ReservationService((service as unknown as { config: never }).config, sessions as never, (service as unknown as { hub: never }).hub, store, () => new Date(clock.t + 20 * MIN), TIMING);
    await restarted.start();
    await run(restarted);
    restarted.stop();
    expect(sessions.restore).not.toHaveBeenCalled();
    expect(restarted.list()[0]).toMatchObject({ status: "done", outcome: "interrupted" });
    expect((await store.list())[0]).toMatchObject({ status: "done", outcome: "interrupted" });
  });
});

describe("reservation input rules", () => {
  it("R7 rejects bad times, text, role and cwd, and the 51st pending", async () => {
    const { service, input } = await setup();
    await expect(service.create(input({ date: "2026-10-11" }), "ui")).rejects.toThrow("out of range");
    await expect(service.create(input({ time: "09:00" }), "ui")).rejects.toThrow("out of range");
    await expect(service.create(input({ time: "09:00:30" }), "ui")).rejects.toThrow("time");
    await expect(service.create(input({ date: "2027-10-14" }), "ui")).rejects.toThrow("out of range");
    await expect(service.create(input({ date: "2026-02-30" }), "ui")).rejects.toThrow("date");
    await expect(service.create(input({ promptText: "a\u001b[31m" }), "ui")).rejects.toThrow("prompt");
    await expect(service.create(input({ roleId: "nope" }), "ui")).rejects.toThrow("role");
    await expect(service.create(input({ cwd: "/nonexistent-dir-xyz" }), "ui")).rejects.toThrow("cwd");
    for (let i = 0; i < 50; i++) await service.create(input({ date: "2026-10-13" }), "ui");
    await expect(service.create(input({ date: "2026-10-13" }), "ui")).rejects.toThrow("too many");
    expect(service.list()).toHaveLength(50);
  }, 60000);

  it("R8 cancel: non-pending is 409, unknown id is 400", async () => {
    const { service, input } = await setup();
    const r = await service.create(input(), "ui");
    await expect(service.cancel("missing")).rejects.toBeInstanceOf(SessionInputError);
    expect((await service.cancel(r.id)).status).toBe("cancelled");
    await expect(service.cancel(r.id)).rejects.toBeInstanceOf(SessionConflictError);
  });

  it("R9 prunes oldest finished beyond 200 and never pending", async () => {
    const { service, store, input } = await setup();
    const base = await service.create(input(), "ui");
    const items: Reservation[] = Array.from({ length: 205 }, (_, i) => ({ ...base, id: `d${i}`, status: "done" as const, outcome: "sent" as const, finishedAt: 1000 + i, updatedAt: 1000 + i }));
    (service as unknown as { items: Reservation[] }).items = [base, ...items];
    await service.create(input({ name: "new" }), "ui");
    const list = service.list();
    expect(list).toHaveLength(200);
    expect(list.filter((r) => r.status === "pending")).toHaveLength(2);
    expect(list.some((r) => r.id === "d0")).toBe(false);
    expect(list.some((r) => r.id === "d204")).toBe(true);
    expect((await store.list())).toHaveLength(200);
  });

  it("R10 does not overwrite a broken file and refuses versions other than 1", async () => {
    const { service, store, input, dir } = await setup();
    const file = path.join(dir, RESERVATIONS_FILE);
    writeFileSync(file, "not json");
    await expect(service.create(input(), "ui")).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("not json");
    writeFileSync(file, JSON.stringify({ version: 2, items: [] }));
    await expect(store.list()).rejects.toThrow("unsupported");
    await expect(store.save([])).rejects.toThrow("unsupported");
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ version: 2, items: [] }));
  });
});

interface Reply { status: number; json: Record<string, unknown> }
const send = (port: number, method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json: Record<string, unknown> = {}; try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 本文なし */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

describe("agent reservation HTTP route", () => {
  let h: Harness; let nullH: Harness;
  const agent = (method: string, url: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${RESERVE_TOKEN}` }) => send(h.port, method, url, headers, body);
  const ui = (method: string, url: string, body?: unknown) => send(h.port, method, url, { Authorization: `Bearer ${TOKEN}` }, body);
  const date = new Date(Date.now() + 3 * 24 * 60 * MIN).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  // v0.44.0: AI の受け口は呼び出し元（予約を作れる役割の会話）が要る。入力に callerSessionId を足すだけ
  const CALLER = "66666666-6666-4666-8666-666666666666";
  const body = (over: Record<string, unknown> = {}) => ({ name: "m", roleId: "echo", cwd: h.config.salesanchorRoot, date, time: "10:00", promptText: "hi", callerSessionId: CALLER, ...AGENT, ...over });
  // 1時間の関門: n 番目の予約は 10:00 から n 時間ずつ後ろへ（24 時を越えたら日付も進める）
  const slot = (n: number): { date: string; time: string } => { const iso = new Date(Date.parse(`${date}T10:00:00+09:00`) + n * 60 * MIN + 9 * 60 * MIN).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; };
  beforeAll(async () => {
    h = await startHarness(); nullH = await startHarness({ reserve: { token: null } });
    const caller = await h.sessions.create({ name: "reserver", roleId: "echo" });
    h.sessions.setClaudeSessionId(caller.id, CALLER);
  });
  afterAll(async () => { await h.close(); await nullH.close(); });

  it("R11 accepts add/list/cancel with the right token and rejects others", async () => {
    const added = await agent("POST", "/api/agent/reservations", body());
    expect(added.status).toBe(201);
    const id = added.json.id as string;
    expect(added.json).toMatchObject({ createdBy: "agent", purpose: "measure", measureNote: "効果を測る" });
    const listed = await agent("GET", `/api/agent/reservations?callerSessionId=${CALLER}`);
    expect(listed.status).toBe(200);
    expect((listed.json.items as { id: string }[]).some((r) => r.id === id)).toBe(true);
    expect((await agent("POST", `/api/agent/reservations/${id}/cancel`, { callerSessionId: CALLER })).status).toBe(200);
    expect((await agent("GET", "/api/agent/reservations", undefined, {})).status).toBe(401);
    expect((await agent("GET", "/api/agent/reservations", undefined, { Authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await send(nullH.port, "GET", "/api/agent/reservations", { Authorization: `Bearer ${RESERVE_TOKEN}` })).status).toBe(401);
    expect((await send(nullH.port, "GET", "/api/agent/reservations", { Authorization: "Bearer null" })).status).toBe(401);
    expect((await agent("GET", "/api/agent/reservations", undefined, { Authorization: `Bearer ${RESERVE_TOKEN}`, Origin: "http://evil.example" })).status).toBe(403);
    expect((await agent("GET", "/api/routines")).status).toBe(401);
    expect((await agent("GET", "/api/reservations")).status).toBe(401);
  });

  it("R11c the agent route needs purpose and measureNote, caps pending at 20, and the UI route needs neither", async () => {
    expect((await agent("POST", "/api/agent/reservations", body({ purpose: undefined }))).status).toBe(400);
    expect((await agent("POST", "/api/agent/reservations", body({ purpose: "other" }))).status).toBe(400);
    expect((await agent("POST", "/api/agent/reservations", body({ measureNote: undefined }))).status).toBe(400);
    expect((await agent("POST", "/api/agent/reservations", body({ measureNote: "" }))).status).toBe(400);
    expect((await agent("POST", "/api/agent/reservations", body({ measureNote: "x".repeat(201) }))).status).toBe(400);
    // 入力だけ直す（v0.44.0 の1時間の関門）: 20 件が互いに60分以上離れるよう開始を1時間ずつずらす
    let n = 0;
    expect((await agent("POST", "/api/agent/reservations", body({ measureNote: "x".repeat(200), ...slot(n++) }))).status).toBe(201);
    const pendingAgent = () => h.reservations.list().filter((r) => r.createdBy === "agent" && r.status === "pending").length;
    while (pendingAgent() < 20) expect((await agent("POST", "/api/agent/reservations", body(slot(n++)))).status).toBe(201);
    expect((await agent("POST", "/api/agent/reservations", body(slot(n++)))).status).toBe(400);
    const plain = await ui("POST", "/api/reservations", body({ purpose: undefined, measureNote: undefined }));
    expect(plain.status).toBe(201);
    expect(plain.json.purpose).toBeUndefined();
    const ignored = await ui("POST", "/api/reservations", body());
    expect(ignored.status).toBe(201);
    expect(ignored.json.purpose).toBeUndefined();
    expect(ignored.json.measureNote).toBeUndefined();
  }, 30_000);
});

describe("reserve-token file", () => {
  it("R12b is 0600 with {port, token}; a second start keeps the token and updates the port", async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "ac-rtok-")), "data");
    mkdirSync(dir, { recursive: true });
    const a = await setupReserveToken({ env: {}, dataDir: dir, port: 4001 });
    const file = path.join(dir, RESERVE_TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(file, "utf8")) as { port: number; token: string };
    expect(first).toEqual({ port: 4001, token: a.token });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    const b = await setupReserveToken({ env: {}, dataDir: dir, port: 4002 });
    expect(b.token).toBe(a.token);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 4002, token: a.token });
    expect((await setupReserveToken({ env: { AGENT_CONSOLE_PORT: "5000" }, dataDir: dir, port: 4003 })).token).toBeNull();
  });
});

describe("launch target cwd default (v0.24.0)", () => {
  it("R2 a main-checkout role without cwd is saved with the real path of salesanchorRoot", async () => {
    const { service, root, input } = await setup();
    const r = await service.create(input({ cwd: undefined }), "ui");
    expect(r.cwd).toBe(realpathSync(root));
    expect(r.branch).toBeUndefined();
  });

  it("R5 a worktree role without cwd is rejected as cwd invalid, and an explicit cwd still works", async () => {
    const h2 = await startHarness();
    try {
      const date2 = new Date(Date.now() + 3 * 24 * 60 * MIN).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      const post = (over: Record<string, unknown>) => send(h2.port, "POST", "/api/reservations", { Authorization: `Bearer ${TOKEN}` }, { name: "m", roleId: "wt", date: date2, time: "10:00", promptText: "hi", ...over });
      const missing = await post({ branch: "b" });
      expect(missing.status).toBe(400);
      expect(String(missing.json.error)).toContain("cwd invalid");
      expect((await post({ cwd: h2.config.salesanchorRoot, branch: "b" })).status).toBe(201);
    } finally { await h2.close(); }
  });

  it("R13 the agent route accepts a main-checkout role without cwd and saves the real path of salesanchorRoot", async () => {
    const h2 = await startHarness();
    try {
      const date2 = new Date(Date.now() + 3 * 24 * 60 * MIN).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      // 入力だけ直す（v0.44.0）: 呼び出し元の会話を登録して callerSessionId を足す
      const caller = await h2.sessions.create({ name: "reserver", roleId: "echo" });
      h2.sessions.setClaudeSessionId(caller.id, "77777777-7777-4777-8777-777777777777");
      const r = await send(h2.port, "POST", "/api/agent/reservations", { Authorization: `Bearer ${RESERVE_TOKEN}` }, { name: "m", roleId: "echo", date: date2, time: "10:00", promptText: "hi", callerSessionId: "77777777-7777-4777-8777-777777777777", ...AGENT });
      expect(r.status).toBe(201);
      expect(r.json.cwd).toBe(realpathSync(h2.config.salesanchorRoot));
    } finally { await h2.close(); }
  });
});

// v0.44.0: 1時間の関門・予約の監査記録・予約できない役割（設計 discord-pdca §4-3 / §4-4）
type AuditEntry = Parameters<ReservationAuditSink>[0];
const setupGated = async (audit?: ReservationAuditSink) => {
  const base = await setup();
  const entries: AuditEntry[] = [];
  const sink: ReservationAuditSink = audit ?? (async (e) => { entries.push(e); });
  const gate = new ScheduleGate();
  const cfg = { ...(base.hub.config as object), roles: [{ id: "echo", needsWorktree: false, command: ["echo"] }, { id: "noresv", needsWorktree: false, command: ["echo"], reservable: false }] };
  const hub = { ...base.hub, config: cfg } as typeof base.hub;
  const service = new ReservationService(cfg as never, base.sessions as never, hub as never, base.store, () => new Date(base.clock.t), TIMING, true, { gate, audit: sink });
  gate.attach({ reservations: () => service.list(), reservationsReady: () => service.isLoaded(), routines: () => [] });
  return { ...base, service, entries, gate };
};

describe("reservation gate, audit and reservable role (v0.44.0)", () => {
  it("R14 isLoaded is false until start finishes, then true", async () => {
    const base = await setup();
    const service = new ReservationService(base.hub.config as never, base.sessions as never, base.hub as never, base.store, () => new Date(base.clock.t), TIMING, false);
    expect(service.isLoaded()).toBe(false);
    await service.start();
    expect(service.isLoaded()).toBe(true);
    service.stop();
    const preloaded = new ReservationService(base.hub.config as never, base.sessions as never, base.hub as never, base.store, () => new Date(base.clock.t), TIMING, true);
    expect(preloaded.isLoaded()).toBe(true);
  });

  it("R15 an AI reservation within 60 minutes of another is refused with a denied audit row; the screen is not gated; 60 minutes passes", async () => {
    const { service, entries, input } = await setupGated();
    await service.create(input({ date: "2026-10-13", time: "10:00" }), "ui", { callerSessionId: null });
    await expect(service.create(input({ date: "2026-10-13", time: "10:30", ...AGENT }), "agent", { callerSessionId: "cid", roleId: "echo" })).rejects.toThrow("schedule conflict");
    expect(entries.at(-1)).toMatchObject({ action: "reserveCreate", outcome: "denied", targetCreatedBy: "agent", callerSessionId: "cid", roleId: "echo" });
    expect(String(entries.at(-1)?.error)).toContain("schedule conflict");
    expect(service.list()).toHaveLength(1);
    await service.create(input({ date: "2026-10-13", time: "10:30" }), "ui", { callerSessionId: null }); // 画面は見ない
    // 11:00 は画面で作った 10:30 から30分差なので、AI は断られる
    await expect(service.create(input({ date: "2026-10-13", time: "11:00", ...AGENT }), "agent", { callerSessionId: "cid", roleId: "echo" })).rejects.toThrow("schedule conflict");
    // 11:30 は 10:30 からちょうど60分、10:00 からは90分なので通る
    const ok = await service.create(input({ date: "2026-10-13", time: "11:30", ...AGENT }), "agent", { callerSessionId: "cid", roleId: "echo" });
    expect(ok.status).toBe("pending");
  });

  it("R16 two AI reservations created at once at the same time: only one passes", async () => {
    const { service, input } = await setupGated();
    const a = service.create(input({ name: "a", date: "2026-10-13", time: "10:00", ...AGENT }), "agent", { callerSessionId: null });
    const b = service.create(input({ name: "b", date: "2026-10-13", time: "10:10", ...AGENT }), "agent", { callerSessionId: null });
    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(service.list()).toHaveLength(1);
  });

  it("R17 a role with reservable:false is refused for both the screen and the AI (400), judged by the role the reservation opens", async () => {
    const { service, entries, input } = await setupGated();
    await expect(service.create(input({ roleId: "noresv" }), "ui", { callerSessionId: null })).rejects.toThrow("reservation role is not reservable");
    await expect(service.create(input({ roleId: "noresv", date: "2026-10-13", ...AGENT }), "agent", { callerSessionId: "cid", roleId: "echo" })).rejects.toThrow(SessionInputError);
    expect(entries.map((e) => e.outcome)).toEqual(["denied", "denied"]);
    expect(service.list()).toHaveLength(0);
    // 呼び出し元の役割が noresv でも、開く役割が echo なら通る
    const ok = await service.create(input({ date: "2026-10-13", ...AGENT }), "agent", { callerSessionId: "cid", roleId: "noresv" });
    expect(ok.roleId).toBe("echo");
  });

  it("R18 create, cancel and dispatch each leave one audit row (reserveCreate, reserveCancel, reserveDispatch)", async () => {
    const { service, entries, clock, input } = await setupGated();
    const a = await service.create(input({ name: "a", date: "2026-10-13", time: "10:00" }), "ui", { callerSessionId: null });
    const b = await service.create(input({ name: "b", date: "2026-10-12", time: "09:10" }), "ui", { callerSessionId: null });
    await service.cancel(a.id, { callerSessionId: "cid", roleId: "echo" });
    clock.t = BASE_MS + 10 * MIN;
    await run(service);
    expect(entries).toMatchObject([
      { action: "reserveCreate", outcome: "ok", reservationId: a.id, targetCreatedBy: "ui", callerSessionId: null },
      { action: "reserveCreate", outcome: "ok", reservationId: b.id, targetCreatedBy: "ui", callerSessionId: null },
      { action: "reserveCancel", outcome: "ok", reservationId: a.id, targetCreatedBy: "ui", callerSessionId: "cid", roleId: "echo" },
      { action: "reserveDispatch", outcome: "ok", reservationId: b.id, targetCreatedBy: "ui", callerSessionId: null, targetRoleId: "echo" },
    ]);
    for (const e of entries) expect(JSON.stringify(e)).not.toContain("hello"); // 本文は残さない
  });

  it("R19 when the audit row cannot be written, create does not save, cancel keeps pending, dispatch does not send", async () => {
    const failing = async (): Promise<void> => { throw new Error("audit disk"); };
    const { service, sessions, clock, input } = await setupGated(failing);
    const err = quiet();
    await expect(service.create(input(), "ui", { callerSessionId: null })).rejects.toThrow("audit disk");
    expect(service.list()).toHaveLength(0);
    // 予約を直接置いて、取消と送信を見る
    const seed: Reservation = { id: "seed", name: "seed", roleId: "echo", cwd: "/x", runAt: BASE_MS + 10 * MIN, runAtJst: "2026-10-12T09:10+09:00", timeZone: "Asia/Tokyo", promptText: "p", createdBy: "ui", createdAt: BASE_MS, updatedAt: BASE_MS, status: "pending" };
    (service as unknown as { items: Reservation[] }).items = [seed];
    await expect(service.cancel("seed", { callerSessionId: null })).rejects.toThrow("audit disk");
    expect(service.list()[0].status).toBe("pending");
    clock.t = BASE_MS + 10 * MIN;
    await run(service);
    expect(service.list()[0].status).toBe("pending");
    expect(sessions.restore).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("R19b a save failure after the ok audit row leaves a denied row 'save failed' and gives the state back", async () => {
    const { service, store, entries, input } = await setupGated();
    const err = quiet();
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk"));
    await expect(service.create(input(), "ui", { callerSessionId: null })).rejects.toThrow("disk");
    expect(service.list()).toHaveLength(0);
    expect(entries.map((e) => `${e.action}:${e.outcome}`)).toEqual(["reserveCreate:ok", "reserveCreate:denied"]);
    expect(entries.at(-1)?.error).toBe("save failed");
    err.mockRestore();
  });

  it("R19c a cancel that arrives while the cancel audit row is being written wins over the dispatch: it is sent at most once and never both cancelled and sent", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rows: string[] = [];
    const audit: ReservationAuditSink = async (e) => { rows.push(`${e.action}:${e.outcome}`); if (e.action === "reserveCancel") await held; };
    const { service, sessions, clock } = await setupGated(audit);
    const seed: Reservation = { id: "seed", name: "seed", roleId: "echo", cwd: "/x", runAt: BASE_MS + 10 * MIN, runAtJst: "2026-10-12T09:10+09:00", timeZone: "Asia/Tokyo", promptText: "p", createdBy: "ui", createdAt: BASE_MS, updatedAt: BASE_MS, status: "pending" };
    (service as unknown as { items: Reservation[] }).items = [seed];
    const cancelling = service.cancel("seed", { callerSessionId: null });
    await new Promise((r) => setTimeout(r, 10));
    clock.t = BASE_MS + 10 * MIN;
    await service.tick(); // 取消の監査を待っている間に時刻が来ても、状態は先に cancelled になっているので送らない
    release();
    await cancelling;
    await service.settled();
    expect(service.list()[0].status).toBe("cancelled");
    expect(sessions.restore).not.toHaveBeenCalled();
    expect(rows).toEqual(["reserveCancel:ok"]);
  });
});
