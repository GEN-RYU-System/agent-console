import { describe, expect, it } from "vitest";
import { jstToday, toCalendarEvents, viewRange } from "../../src/components/Schedule/scheduleView";
import type { ScheduleItem } from "../../src/types";

const item = (over: Partial<ScheduleItem>): ScheduleItem => ({ id: "a", side: "secretary", kind: "todo", title: "t", date: "2026-11-04", status: "open", createdBy: "ui", createdAt: 1, updatedAt: 1, ...over });

describe("jstToday", () => {
  it("rolls over at 15:00Z", () => {
    expect(jstToday(new Date("2026-11-04T15:00:00Z"))).toBe("2026-11-05");
    expect(jstToday(new Date("2026-11-04T14:59:00Z"))).toBe("2026-11-04");
  });
});

describe("viewRange", () => {
  it("day: the day and the next", () => {
    expect(viewRange("day", "2026-11-04")).toEqual({ first: "2026-11-04", from: "2026-11-04", to: "2026-11-05", dayCount: 2 });
  });
  it("week: Monday to Sunday", () => {
    expect(viewRange("week", "2026-11-04")).toEqual({ first: "2026-11-02", from: "2026-11-02", to: "2026-11-08", dayCount: 7 });
    expect(viewRange("week", "2026-11-08").first).toBe("2026-11-02");
  });
  it("month: 42 days from Monday 10/26 to Sunday 12/6", () => {
    expect(viewRange("month", "2026-11-04")).toEqual({ first: "2026-11-01", from: "2026-10-26", to: "2026-12-06", dayCount: 42 });
  });
});

describe("toCalendarEvents", () => {
  it("skips items without a time", () => {
    expect(toCalendarEvents([item({}), item({ id: "b", start: "10:00" }), item({ id: "c", date: undefined, start: "10:00" })], "secretary", new Set())).toHaveLength(1);
  });
  it("uses +30 minutes when end is missing and no timezone suffix", () => {
    const [e] = toCalendarEvents([item({ start: "10:00" })], "secretary", new Set());
    expect(e.start).toBe("2026-11-04T10:00:00");
    expect(e.end).toBe("2026-11-04T10:30:00");
  });
  it("maps kinds to tones and done to holiday", () => {
    const evs = toCalendarEvents([item({ id: "1", start: "08:00" }), item({ id: "2", kind: "waiting", start: "09:00" }), item({ id: "3", kind: "deadline", start: "10:00" }), item({ id: "4", status: "done", start: "11:00" })], "secretary", new Set());
    expect(evs.map((e) => e.tone)).toEqual(["personal", "shipping", "billing", "holiday"]);
  });
  it("marks conflicts and filters by side", () => {
    const evs = toCalendarEvents([item({ id: "1", start: "08:00" }), item({ id: "2", side: "dev", start: "08:00" })], "secretary", new Set(["1"]));
    expect(evs).toHaveLength(1);
    expect(evs[0].conflict).toBe(true);
  });
});
