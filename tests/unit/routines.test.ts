import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hub } from "../../server/hub.ts";
import { ROUTINES_FILE, RoutineService, RoutineStore, jstSlot, type Routine } from "../../server/routines.ts";

const routine = (overrides: Partial<Routine> = {}): Routine => ({ id: "r1", name: "daily", enabled: true, roleId: "echo", cwd: "/tmp", timeZone: "Asia/Tokyo", weekdays: [1], timeHHmm: "09:00", promptText: "hello", createdAt: 1, updatedAt: 1, events: [], ...overrides });

describe("routine persistence and clock", () => {
  it("uses an Asia/Tokyo calendar slot regardless of host timezone", () => {
    expect(jstSlot(new Date("2026-10-11T15:00:00.000Z"))).toMatchObject({ weekday: 1, timeHHmm: "00:00", key: "2026-10-12T00:00+09:00" });
  });

  it("serializes routines and refuses to overwrite malformed content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-")); const store = new RoutineStore(dir);
    await store.save([routine()]);
    expect((await store.list())[0].name).toBe("daily");
    const file = path.join(dir, ROUTINES_FILE); await writeFile(file, "not json");
    await expect(store.save([routine({ name: "replacement" })])).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("S7: reads a routines.json that has createdBy (and unknown keys) without error; unknown keys are not written back; an unknown createdBy value is dropped", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-")); const store = new RoutineStore(dir);
    const file = path.join(dir, ROUTINES_FILE);
    await writeFile(file, JSON.stringify({ version: 1, items: [{ ...routine({ id: "a1", createdBy: "agent" }), zzz: "x" }, { ...routine({ id: "u1" }), createdBy: "human" }] }));
    const items = await store.list();
    expect(items.map((r) => [r.id, r.createdBy])).toEqual([["a1", "agent"], ["u1", undefined]]);
    await store.save(items);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("zzz");
    expect(JSON.parse(raw).items[0].createdBy).toBe("agent");
    expect(JSON.parse(raw).items[1]).not.toHaveProperty("createdBy");
  });
});

type Verdict = { ok: boolean; hasClaude: boolean; reason?: string };
const NOW = () => new Date("2026-10-12T00:00:10.000Z"); // 09:00 JST Monday
const TIMING = { pollMs: 5, timeoutMs: 80, namePollMs: 5, nameTimeoutMs: 20 };
const cfg = { salesanchorRoot: os.tmpdir(), roles: [{ id: "echo", needsWorktree: false, command: ["echo"] }], pasteSubmitDelayMs: 0 };

/** hub.submitText は本物（Hub.prototype）を、偽の sessions/config で動かす */
const makeHub = (sessions: unknown, verdicts: Verdict[] | (() => Verdict)) => {
  const queue = Array.isArray(verdicts) ? [...verdicts] : null;
  const checkInput = vi.fn(async () => (queue ? (queue.length > 1 ? queue.shift() : queue[0]) : (verdicts as () => Verdict)()));
  const hub = { checkInput, sessions, config: cfg, submitText: (id: string, text: string) => Hub.prototype.submitText.call(hub, id, text), sendName: () => true, displayNames: () => new Map<string, string>(), writing: new Set<string>(), tryBeginWrite: (id: string) => Hub.prototype.tryBeginWrite.call(hub, id), endWrite: (id: string) => Hub.prototype.endWrite.call(hub, id) };
  return hub;
};

const setup = async (opts: { verdicts?: Verdict[] | (() => Verdict); routines?: Partial<Routine>[]; capacity?: boolean; saveFails?: boolean } = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-"));
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
  const hub = makeHub(sessions, opts.verdicts ?? [{ ok: true, hasClaude: true }]);
  const store = new RoutineStore(dir);
  if (opts.saveFails) vi.spyOn(store, "save").mockRejectedValue(new Error("disk"));
  const service = new RoutineService(cfg as never, sessions as never, hub as never, store, NOW, TIMING);
  (service as unknown as { routines: Routine[] }).routines = (opts.routines ?? [{}]).map((o, i) => routine({ id: `r${i + 1}`, cwd: os.tmpdir(), ...o }));
  return { service, sessions, hub, dir, store, created };
};
const run = async (service: RoutineService) => { await service.tick(); await service.settled(); };
const outcomes = (service: RoutineService, i = 0) => service.list()[i].events.map((e) => e.outcome);

describe("routine launch target cwd default (v0.24.0)", () => {
  it("R7 create without cwd saves the real path of salesanchorRoot for a main-checkout role", async () => {
    const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "ac-routine-root-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-"));
    const service = new RoutineService({ roles: [{ id: "echo", needsWorktree: false }], salesanchorRoot: root } as never, {} as never, {} as never, new RoutineStore(dir));
    const created = await service.create({ name: "n", enabled: true, roleId: "echo", weekdays: [1], timeHHmm: "09:00", promptText: "hi" });
    expect(created.cwd).toBe(root);
  });
});

describe("routine dispatch opens a new session", () => {
  it("K2 opens one new session without resuming at the slot", async () => {
    const { service, sessions } = await setup();
    await run(service);
    expect(sessions.restore).toHaveBeenCalledTimes(1);
    const arg = (sessions.restore.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg.claudeSessionId).toBeUndefined();
    expect(arg.routineId).toBeUndefined();
    expect(arg.name).toBe("daily 10/12 09:00");
  });

  it("sends the name first, waits for the matching display name, then sends the prompt (v0.29.0)", async () => {
    const { service, sessions, hub } = await setup();
    const log: string[] = [];
    let polls = 0;
    (hub as Record<string, unknown>).sendName = vi.fn((_id: string, n: string) => { log.push(`rename:${n}`); return true; });
    (hub as Record<string, unknown>).displayNames = vi.fn(() => { log.push("names"); polls += 1; return new Map([["s1", polls >= 2 ? "daily 10/12 09:00" : "auto-name"]]); });
    sessions.write.mockImplementation((_s: unknown, d: string) => { log.push(`write:${d.length > 1 ? "paste" : "cr"}`); });
    await run(service);
    expect(log[0]).toBe("rename:daily 10/12 09:00");
    expect(log.filter((x) => x === "names")).toHaveLength(2);
    expect(log.indexOf("write:paste")).toBeGreaterThan(log.lastIndexOf("names"));
    expect(outcomes(service)).toEqual(["sent"]);
  });

  it("still sends when the display name never matches within the limit (v0.29.0)", async () => {
    const { service, sessions, hub } = await setup();
    const sendName = vi.fn(() => true);
    (hub as Record<string, unknown>).sendName = sendName;
    (hub as Record<string, unknown>).displayNames = vi.fn(() => new Map([["s1", "auto-name"]]));
    await run(service);
    expect(sendName).toHaveBeenCalledTimes(1);
    expect(sessions.write).toHaveBeenCalled();
    expect(outcomes(service)).toEqual(["sent"]);
  });

  it("cuts the session name on a character boundary and keeps it within 40 units", async () => {
    const { service, sessions } = await setup({ routines: [{ name: "😀".repeat(40) }] });
    await run(service);
    const name = (sessions.restore.mock.calls[0] as unknown as [{ name: string }])[0].name;
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("K3 sends once with bracketed paste, then CR, after the second ready check", async () => {
    const { service, sessions, hub } = await setup({ verdicts: [{ ok: false, hasClaude: false }, { ok: true, hasClaude: true }], routines: [{ promptText: "go" }] });
    await run(service);
    // 入力待ち（1回目は待ち・2回目で成立）→ /rename の後の入力待ちの確認（1回）
    expect(hub.checkInput).toHaveBeenCalledTimes(3);
    expect(sessions.write.mock.calls.map((c) => c[1])).toEqual(["\u001b[200~go\u001b[201~", "\r"]);
    expect(outcomes(service)).toEqual(["sent"]);
    expect(service.list()[0].events[0].sessionName).toBe("daily 10/12 09:00");
  });

  it("K4 does not send when the session never becomes ready, and keeps the session", async () => {
    const { service, sessions } = await setup({ verdicts: [{ ok: false, hasClaude: true, reason: "claude is busy" }] });
    await run(service);
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).not.toHaveBeenCalled();
    expect(outcomes(service)).toEqual(["not_ready"]);
  });

  it("records failed when the session exits while waiting", async () => {
    const { service, sessions, created } = await setup({ verdicts: () => { created[0].exited = true; return { ok: false, hasClaude: false, reason: "session is stopped" }; } });
    await run(service);
    expect(sessions.write).not.toHaveBeenCalled();
    expect(outcomes(service)).toEqual(["failed"]);
  });

  it("K5 does not run the same slot again after a restart", async () => {
    const { service, dir } = await setup();
    await run(service);
    const second = await setup();
    const reloaded = new RoutineService(cfg as never, second.sessions as never, second.hub as never, new RoutineStore(dir), NOW, TIMING);
    await reloaded.start(); reloaded.stop();
    await run(reloaded);
    expect(second.sessions.restore).not.toHaveBeenCalled();
  });

  it("K6 does not open a session when lastSlot cannot be saved, and does not retry the slot", async () => {
    const { service, sessions } = await setup({ saveFails: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await run(service); await run(service);
    err.mockRestore();
    expect(sessions.restore).not.toHaveBeenCalled();
  });

  it("K7 records full when there is no capacity and cwd_invalid when the cwd is gone", async () => {
    const full = await setup({ capacity: false });
    await run(full.service);
    expect(full.sessions.restore).not.toHaveBeenCalled();
    expect(outcomes(full.service)).toEqual(["full"]);
    const bad = await setup({ routines: [{ cwd: "/nonexistent-ac-dir" }] });
    await run(bad.service);
    expect(bad.sessions.restore).not.toHaveBeenCalled();
    expect(outcomes(bad.service)).toEqual(["cwd_invalid"]);
  });

  it("K10 a waiting routine does not block another routine in the same minute", async () => {
    const { service, sessions } = await setup({ verdicts: [{ ok: false, hasClaude: true }], routines: [{}, {}] });
    await service.tick();
    await vi.waitFor(() => expect(sessions.restore).toHaveBeenCalledTimes(2));
    await service.settled();
  });

  it("K11 does not send when the routine is disabled while waiting", async () => {
    const { service, sessions } = await setup({ verdicts: [{ ok: false, hasClaude: false }, { ok: true, hasClaude: true }] });
    await service.tick();
    await service.setEnabled("r1", false);
    await service.settled();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(outcomes(service)).toEqual(["not_ready"]);
  });

  it("skips disabled routines and non-matching weekday or time, and does not catch up", async () => {
    const { service, sessions } = await setup({ routines: [{ enabled: false }, { id: "r2", weekdays: [2] }, { id: "r3", timeHHmm: "08:59" }] });
    await run(service);
    expect(sessions.restore).not.toHaveBeenCalled();
  });

  it("persists lastSlot and the event with its session name to routines.json", async () => {
    const { service, dir } = await setup();
    await run(service);
    const saved = JSON.parse(await readFile(path.join(dir, ROUTINES_FILE), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.items[0].lastSlot).toBe("2026-10-12T09:00+09:00");
    expect(saved.items[0].events).toEqual([expect.objectContaining({ outcome: "sent", slot: "2026-10-12T09:00+09:00", sessionName: "daily 10/12 09:00" })]);
  });
});

describe("routines.json version 1", () => {
  it("K9 reads a v1 file (claudeSessionId, old outcomes) and rewrites it as v2", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-"));
    const v1 = { ...routine(), claudeSessionId: "11111111-1111-4111-8111-111111111111", events: [{ at: 1, slot: "s", outcome: "busy" }] };
    await writeFile(path.join(dir, ROUTINES_FILE), JSON.stringify({ version: 1, items: [v1] }));
    const store = new RoutineStore(dir);
    const items = await store.list();
    expect(items[0].events[0].outcome).toBe("busy");
    expect("claudeSessionId" in items[0]).toBe(false);
    await store.save(items);
    const saved = JSON.parse(await readFile(path.join(dir, ROUTINES_FILE), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.items[0].claudeSessionId).toBeUndefined();
  });
});

describe("routine registration", () => {
  const input = { name: "n", enabled: true, roleId: "echo", cwd: "/tmp", weekdays: [1], timeHHmm: "09:00", promptText: "go" };
  const make = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-"));
    const session = { id: "s1", exited: false };
    const sessions = { get: vi.fn(() => session), write: vi.fn(), onChange: vi.fn(), restore: vi.fn(() => session), close: vi.fn().mockResolvedValue(undefined) };
    const service = new RoutineService({ roles: [{ id: "echo", needsWorktree: false }], salesanchorRoot: "/nonexistent-root" } as never, sessions as never, {} as never, new RoutineStore(dir));
    return { service, sessions, dir };
  };

  it("rejects prompts with control characters and bad times before starting a session", async () => {
    const { service, sessions } = await make();
    await expect(service.create({ ...input, promptText: "a\u001b[31m" })).rejects.toThrow("prompt");
    await expect(service.create({ ...input, timeHHmm: "24:00" })).rejects.toThrow("time");
    expect(sessions.restore).not.toHaveBeenCalled();
  });

  it("K1 creating a routine does not open a session", async () => {
    const { service, sessions } = await make();
    (service as unknown as { validate: (i: unknown) => Promise<unknown> }).validate = async (i) => i;
    const created = await service.create(input);
    expect(service.list()).toEqual([expect.objectContaining({ id: created.id })]);
    expect(sessions.restore).not.toHaveBeenCalled();
  });

  it("caps stored events", async () => {
    const { service } = await make();
    const old = Array.from({ length: 150 }, (_, i) => ({ at: i, slot: `s${i}`, outcome: "busy" as const }));
    (service as unknown as { routines: Routine[] }).routines = [routine({ events: old })];
    (service as unknown as { now: () => Date }).now = () => new Date("2026-10-12T00:00:10.000Z");
    await service.tick(); await service.settled();
    expect(service.list()[0].events).toHaveLength(100);
  });

  it("rejects unknown routine on enable and non-boolean enabled", async () => {
    const { service } = await make();
    await expect(service.setEnabled("nope", true)).rejects.toThrow("not found");
    (service as unknown as { routines: Routine[] }).routines = [routine()];
    await expect(service.setEnabled("r1", "yes")).rejects.toThrow("enabled");
  });
});
