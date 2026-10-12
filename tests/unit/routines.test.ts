import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("evaluates a matching slot once and does not retry a failed fresh guard", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-"));
    const session = { id: "s1", exited: false };
    const sessions = { get: vi.fn(() => session), write: vi.fn(), onChange: vi.fn(), restore: vi.fn(), };
    const hub = { checkInput: vi.fn().mockResolvedValue({ ok: false, reason: "claude is busy", hasClaude: true }) };
    const now = () => new Date("2026-10-12T00:00:10.000Z"); // 09:00 JST Monday
    const service = new RoutineService({} as never, sessions as never, hub as never, new RoutineStore(dir), now);
    (service as unknown as { routines: Routine[] }).routines = [routine({ weekdays: [1], timeHHmm: "09:00" })];
    (service as unknown as { live: Map<string, string> }).live.set("r1", "s1");
    await service.tick(); await service.tick();
    expect(hub.checkInput).toHaveBeenCalledTimes(1);
    expect(sessions.write).not.toHaveBeenCalled();
    expect((service.list()[0].events)).toEqual([expect.objectContaining({ outcome: "busy" })]);
  });

  it("writes prompt plus one CR only after a fresh idle guard", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ac-routine-")); const session = { id: "s1", exited: false };
    const sessions = { get: vi.fn(() => session), write: vi.fn(), onChange: vi.fn(), restore: vi.fn() };
    const hub = { checkInput: vi.fn().mockResolvedValue({ ok: true, hasClaude: true }) };
    const service = new RoutineService({} as never, sessions as never, hub as never, new RoutineStore(dir), () => new Date("2026-10-12T00:00:10.000Z"));
    (service as unknown as { routines: Routine[] }).routines = [routine({ weekdays: [1], timeHHmm: "09:00", promptText: "go" })]; (service as unknown as { live: Map<string, string> }).live.set("r1", "s1");
    await service.tick();
    expect(hub.checkInput).toHaveBeenCalledWith("s1"); expect(sessions.write).toHaveBeenCalledWith(session, "go\r");
  });
});

describe("routine dispatch boundaries", () => {
  const setup = (verdict: object, routineOverrides: Partial<Routine> = {}, session: object | null = { id: "s1", exited: false }) => {
    const sessions = { get: vi.fn(() => session ?? undefined),write: vi.fn(), onChange: vi.fn(), restore: vi.fn() };
    const hub = { checkInput: vi.fn().mockResolvedValue(verdict) };
    return mkdtemp(path.join(os.tmpdir(), "ac-routine-")).then((dir) => {
      const service = new RoutineService({} as never, sessions as never, hub as never, new RoutineStore(dir), () => new Date("2026-10-12T00:00:10.000Z"));
      (service as unknown as { routines: Routine[] }).routines = [routine(routineOverrides)];
      (service as unknown as { live: Map<string, string> }).live.set("r1", "s1");
      return { service, sessions, hub, dir };
    });
  };

  it("does not write into a terminal where Claude is not running", async () => {
    const { service, sessions } = await setup({ ok: true, hasClaude: false });
    await service.tick();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(service.list()[0].events).toEqual([expect.objectContaining({ outcome: "missing" })]);
  });

  it.each([
    ["claude is waiting for input", "waiting"],
    ["claude state is unknown", "unknown"],
    ["session is stopped", "stopped"],
    ["session not found", "missing"],
  ])("records %s as %s without writing", async (reason, outcome) => {
    const { service, sessions } = await setup({ ok: false, reason, hasClaude: false });
    await service.tick();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(service.list()[0].events.map((e) => e.outcome)).toEqual([outcome]);
  });

  it("records missing when no dedicated session is live", async () => {
    const { service, hub } = await setup({ ok: true, hasClaude: true }, {}, null);
    await service.tick();
    expect(hub.checkInput).not.toHaveBeenCalled();
    expect(service.list()[0].events.map((e) => e.outcome)).toEqual(["missing"]);
  });

  it("records failed when the guard throws and does not retry", async () => {
    const { service, hub, sessions } = await setup({});
    hub.checkInput.mockRejectedValue(new Error("boom"));
    await service.tick(); await service.tick();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(service.list()[0].events.map((e) => e.outcome)).toEqual(["failed"]);
  });

  it("skips disabled routines and non-matching weekday or time, and does not catch up", async () => {
    const { service, hub } = await setup({ ok: true, hasClaude: true }, { enabled: false });
    await service.tick();
    (service as unknown as { routines: Routine[] }).routines = [routine({ weekdays: [2] }), routine({ id: "r2", timeHHmm: "08:59" })];
    await service.tick();
    expect(hub.checkInput).not.toHaveBeenCalled();
  });

  it("persists the single event to routines.json", async () => {
    const { service, dir } = await setup({ ok: true, hasClaude: true });
    await service.tick();
    const saved = JSON.parse(await readFile(path.join(dir, ROUTINES_FILE), "utf8"));
    expect(saved.items[0].events).toEqual([expect.objectContaining({ outcome: "sent", slot: "2026-10-12T09:00+09:00" })]);
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

  it("does not leave routine sessions in open-sessions.json (routineId is passed on restore)", async () => {
    const { service, sessions } = await make();
    (service as unknown as { routines: Routine[] }).routines = [routine()];
    await (service as unknown as { restore: () => Promise<void> }).restore();
    expect(sessions.restore).toHaveBeenCalledWith(expect.objectContaining({ routineId: "r1", cwd: "/tmp", branch: null }));
  });

  it("caps stored events", async () => {
    const { service } = await make();
    const old = Array.from({ length: 150 }, (_, i) => ({ at: i, slot: `s${i}`, outcome: "busy" as const }));
    (service as unknown as { routines: Routine[] }).routines = [routine({ events: old })];
    (service as unknown as { live: Map<string, string> }).live.set("r1", "s1");
    (service as unknown as { now: () => Date }).now = () => new Date("2026-10-12T00:00:10.000Z");
    await service.tick();
    expect(service.list()[0].events).toHaveLength(100);
  });

  it("rejects unknown routine on enable and non-boolean enabled", async () => {
    const { service } = await make();
    await expect(service.setEnabled("nope", true)).rejects.toThrow("not found");
    (service as unknown as { routines: Routine[] }).routines = [routine()];
    await expect(service.setEnabled("r1", "yes")).rejects.toThrow("enabled");
  });
});
