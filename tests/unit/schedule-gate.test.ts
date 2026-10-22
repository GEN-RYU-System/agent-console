import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Reservation } from "../../server/reservations.ts";
import type { Routine } from "../../server/routines.ts";
import { ScheduleConflictError, ScheduleGate } from "../../server/schedule-gate.ts";
import { SessionInputError } from "../../server/sessions.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T00:00:00.000Z"); // 2026-10-12 09:00 JST 月曜
const at = (jst: string): number => Date.parse(`${jst}:00+09:00`);

const resv = (name: string, runAt: number, status: Reservation["status"] = "pending"): Reservation => ({ id: `r-${name}`, name, roleId: "echo", cwd: "/x", runAt, runAtJst: "", timeZone: "Asia/Tokyo", promptText: "p", createdBy: "ui", createdAt: NOW, updatedAt: NOW, status } as Reservation);
const rout = (id: string, name: string, weekdays: number[], timeHHmm: string, enabled = true): Routine => ({ id, name, roleId: "echo", cwd: "/x", weekdays, timeHHmm, timeZone: "Asia/Tokyo", promptText: "p", enabled, createdAt: NOW, updatedAt: NOW, events: [] } as unknown as Routine);

const gateOf = (reservations: Reservation[], routines: Routine[], ready = true): ScheduleGate => {
  const g = new ScheduleGate();
  g.attach({ reservations: () => reservations, reservationsReady: () => ready, routines: () => routines });
  return g;
};

describe("ScheduleGate reservation candidates", () => {
  it("G1 less than 60 minutes from another reservation is refused, exactly 60 passes", () => {
    const g = gateOf([resv("other", at("2026-10-13T10:00"))], []);
    expect(() => g.checkReservation(at("2026-10-13T10:59"), NOW, "c")).toThrow(ScheduleConflictError);
    expect(() => g.checkReservation(at("2026-10-13T09:01"), NOW, "c")).toThrow(ScheduleConflictError);
    expect(() => g.checkReservation(at("2026-10-13T11:00"), NOW, "c")).not.toThrow();
    expect(() => g.checkReservation(at("2026-10-13T09:00"), NOW, "c")).not.toThrow();
  });

  it("G2 the refusal names the other one and gives the nearest free times before and after", () => {
    const g = gateOf([resv("other", at("2026-10-13T10:00"))], []);
    let message = "";
    try { g.checkReservation(at("2026-10-13T10:20"), NOW, "c"); } catch (e) { message = (e as Error).message; }
    expect(message).toBe("schedule conflict: 「other」（予約 2026-10-13T10:00+09:00）と開始が60分未満です。空いている近い時刻: 前 2026-10-13T09:00+09:00 ／ 後 2026-10-13T11:00+09:00");
  });

  it("G3 a conflict error is a SessionInputError (so the route answers 400)", () => {
    const g = gateOf([resv("other", at("2026-10-13T10:00"))], []);
    expect(() => g.checkReservation(at("2026-10-13T10:00"), NOW, "c")).toThrow(SessionInputError);
  });

  it("G4 cancelled and done reservations and disabled routines are not compared", () => {
    const g = gateOf([resv("c", at("2026-10-13T10:00"), "cancelled"), resv("d", at("2026-10-13T10:10"), "done")], [rout("x", "off", [2], "10:00", false)]);
    expect(() => g.checkReservation(at("2026-10-13T10:00"), NOW, "c")).not.toThrow();
  });

  it("G5 a routine on the same weekday conflicts with a reservation (2026-10-13 is Tuesday)", () => {
    const g = gateOf([], [rout("x", "daily", [2], "10:00")]);
    expect(() => g.checkReservation(at("2026-10-13T10:30"), NOW, "c")).toThrow("「daily」（定期実行 2026-10-13T10:00+09:00）");
    expect(() => g.checkReservation(at("2026-10-14T10:30"), NOW, "c")).not.toThrow();
  });

  it("G6 the neighbouring day counts: a routine at 23:30 on Monday and a reservation at 00:10 on Tuesday", () => {
    const g = gateOf([], [rout("x", "late", [1], "23:30")]);
    expect(() => g.checkReservation(at("2026-10-13T00:10"), NOW, "c")).toThrow(ScheduleConflictError);
  });
});

describe("ScheduleGate routine candidates", () => {
  it("G7 a routine within 60 minutes of another enabled routine is refused, 60 passes", () => {
    const g = gateOf([], [rout("a", "morning", [1, 3], "09:00")]);
    expect(() => g.checkRoutine({ name: "c", weekdays: [3], timeHHmm: "09:59" }, NOW)).toThrow(ScheduleConflictError);
    expect(() => g.checkRoutine({ name: "c", weekdays: [3], timeHHmm: "10:00" }, NOW)).not.toThrow();
    expect(() => g.checkRoutine({ name: "c", weekdays: [2], timeHHmm: "09:00" }, NOW)).not.toThrow();
  });

  it("G8 across midnight: Monday 23:30 and Tuesday 00:10 conflict", () => {
    const g = gateOf([], [rout("a", "late", [1], "23:30")]);
    expect(() => g.checkRoutine({ name: "c", weekdays: [2], timeHHmm: "00:10" }, NOW)).toThrow(ScheduleConflictError);
    expect(() => g.checkRoutine({ name: "c", weekdays: [2], timeHHmm: "00:30" }, NOW)).not.toThrow();
  });

  it("G9 Saturday night and Sunday morning wrap around the week", () => {
    const g = gateOf([], [rout("a", "sat", [6], "23:50")]);
    expect(() => g.checkRoutine({ name: "c", weekdays: [0], timeHHmm: "00:20" }, NOW)).toThrow(ScheduleConflictError);
  });

  it("G10 a routine does not conflict with itself (update / enable pass its own id)", () => {
    const g = gateOf([], [rout("a", "same", [1], "09:00")]);
    expect(() => g.checkRoutine({ id: "a", name: "same", weekdays: [1], timeHHmm: "09:10" }, NOW)).not.toThrow();
    expect(() => g.checkRoutine({ name: "same", weekdays: [1], timeHHmm: "09:10" }, NOW)).toThrow(ScheduleConflictError);
  });

  it("G11 a pending reservation conflicts with a routine whose weekday matches the reservation day", () => {
    const g = gateOf([resv("one", at("2026-10-14T12:00"))], []); // 水曜
    expect(() => g.checkRoutine({ name: "c", weekdays: [3], timeHHmm: "12:30" }, NOW)).toThrow("「one」（予約 2026-10-14T12:00+09:00）");
    expect(() => g.checkRoutine({ name: "c", weekdays: [4], timeHHmm: "12:30" }, NOW)).not.toThrow();
  });

  it("G12 the suggested times are free: the message times pass the same check", () => {
    const g = gateOf([resv("one", at("2026-10-14T12:00"))], [rout("a", "morning", [3], "11:30")]);
    let message = "";
    try { g.checkRoutine({ name: "c", weekdays: [3], timeHHmm: "12:10" }, NOW); } catch (e) { message = (e as Error).message; }
    const m = /前 (\d\d:\d\d) ／ 後 (\d\d:\d\d)/.exec(message);
    expect(m).not.toBeNull();
    for (const t of [m?.[1], m?.[2]]) expect(() => g.checkRoutine({ name: "c", weekdays: [3], timeHHmm: t as string }, NOW), String(t)).not.toThrow();
  });
});

describe("ScheduleGate before the reservation list is read", () => {
  it("G13 refuses with a message that asks to retry, for both kinds", () => {
    const g = gateOf([], [], false);
    expect(() => g.checkReservation(at("2026-10-13T10:00"), NOW, "c")).toThrow("予約の一覧をまだ読めていない");
    expect(() => g.checkRoutine({ name: "c", weekdays: [1], timeHHmm: "10:00" }, NOW)).toThrow("予約の一覧をまだ読めていない");
  });

  it("G14 a gate nobody attached fails loudly instead of letting everything through", () => {
    const g = new ScheduleGate();
    expect(() => g.checkReservation(at("2026-10-13T10:00"), NOW, "c")).toThrow("attach() was not called");
  });
});

describe("ScheduleGate speed", () => {
  it("G15 50 routines and 20 reservations: one refusal with the nearby-time search takes 50ms or less", () => {
    const routines: Routine[] = [];
    for (let i = 0; i < 50; i++) routines.push(rout(`r${i}`, `routine-${i}`, [i % 7, (i + 3) % 7], `${String((i * 7) % 24).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}`));
    const reservations: Reservation[] = [];
    for (let i = 0; i < 20; i++) reservations.push(resv(`resv-${i}`, NOW + (i + 1) * 5 * 60 * MIN + i * 7 * MIN));
    const g = gateOf(reservations, routines);
    try { g.checkRoutine({ name: "warm", weekdays: [0], timeHHmm: "03:03" }, NOW); } catch { /* 暖機 */ }
    const t0 = performance.now();
    let routineMsg = "";
    try { g.checkRoutine({ name: "c", weekdays: [0, 1, 2, 3, 4, 5, 6], timeHHmm: "00:00" }, NOW); } catch (e) { routineMsg = (e as Error).message; }
    const t1 = performance.now();
    let resvMsg = "";
    try { g.checkReservation(reservations[0].runAt + 10 * MIN, NOW, "c"); } catch (e) { resvMsg = (e as Error).message; }
    const t2 = performance.now();
    expect(routineMsg).toContain("schedule conflict");
    expect(resvMsg).toContain("schedule conflict");
    expect(t1 - t0).toBeLessThanOrEqual(50);
    expect(t2 - t1).toBeLessThanOrEqual(50);
  });
});

describe("ScheduleGate one line for reservations and routines", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it("G16 an AI reservation and an AI routine thrown at the same time at the same slot: only one passes", async () => {
    const day = new Date(Date.now() + 3 * 24 * 60 * MIN).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const weekday = new Date(`${day}T12:00:00+09:00`).getUTCDay();
    const reservation = h.reservations.create({ name: "g16r", roleId: "echo", cwd: h.config.salesanchorRoot, date: day, time: "10:00", promptText: "p", purpose: "measure", measureNote: "n" }, "agent", { callerSessionId: null });
    const routine = h.routines.create({ name: "g16t", roleId: "echo", cwd: h.config.salesanchorRoot, weekdays: [weekday], timeHHmm: "10:20", promptText: "p", enabled: true }, "agent");
    const results = await Promise.allSettled([reservation, routine]);
    const passed = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(passed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0].reason as Error).message)).toContain("schedule conflict");
  });
});
