import { describe, expect, it } from "vitest";
import { findOverlaps } from "../../src/components/Schedule/scheduleView";
import type { ScheduleItem } from "../../src/types";

let n = 0;
const item = (over: Partial<ScheduleItem>): ScheduleItem => ({ id: `i${(n += 1)}`, side: "secretary", kind: "todo", title: `t${n}`, date: "2026-11-04", status: "open", createdBy: "ui", createdAt: 1, updatedAt: 1, ...over });

describe("findOverlaps", () => {
  it("13:00-14:15 and 14:00-15:00 overlap", () => {
    const a = item({ start: "13:00", end: "14:15" }); const b = item({ start: "14:00", end: "15:00" });
    const r = findOverlaps([a, b]);
    expect(r.pairs).toEqual([[a, b]]);
    expect([...r.ids].sort()).toEqual([a.id, b.id].sort());
  });
  it("touching ends do not overlap", () => {
    expect(findOverlaps([item({ start: "14:00", end: "15:00" }), item({ start: "15:00", end: "16:00" })]).ids.size).toBe(0);
  });
  it("an item without end counts as 30 minutes", () => {
    expect(findOverlaps([item({ start: "10:00" }), item({ start: "10:20" })]).ids.size).toBe(2);
    expect(findOverlaps([item({ start: "10:00" }), item({ start: "10:30" })]).ids.size).toBe(0);
  });
  it("ignores done items, other days and items without a time", () => {
    expect(findOverlaps([item({ start: "10:00", end: "11:00" }), item({ start: "10:00", end: "11:00", status: "done" })]).ids.size).toBe(0);
    expect(findOverlaps([item({ start: "10:00", end: "11:00" }), item({ start: "10:00", end: "11:00", date: "2026-11-05" })]).ids.size).toBe(0);
    expect(findOverlaps([item({ start: "10:00", end: "11:00" }), item({})]).ids.size).toBe(0);
  });
  it("counts across dev and secretary", () => {
    const r = findOverlaps([item({ side: "dev", start: "10:00", end: "11:00" }), item({ side: "secretary", start: "10:30", end: "11:30" })]);
    expect(r.ids.size).toBe(2);
  });
});
