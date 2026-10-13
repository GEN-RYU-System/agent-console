import { describe, expect, it } from "vitest";
import { isWindowReset, minutesSince, resetParts, usageLevel } from "./usageLogic";

describe("usageLevel（K7: 80・95・100 の境目）", () => {
  it.each([
    [0, "normal"],
    [79, "normal"],
    [79.4, "normal"],
    [80, "warning"],
    [94, "warning"],
    [94.4, "warning"],
    [95, "danger"],
    [99, "danger"],
    [99.4, "danger"],
    [99.5, "full"],
    [100, "full"],
  ])("%s%% は %s", (pct, level) => {
    expect(usageLevel(pct)).toBe(level);
  });
});

describe("isWindowReset", () => {
  it("resetsAt（秒）を過ぎたら true、ちょうども true、前は false", () => {
    const w = { usedPercentage: 50, resetsAt: 1000 };
    expect(isWindowReset(w, 999_999)).toBe(false);
    expect(isWindowReset(w, 1_000_000)).toBe(true);
    expect(isWindowReset(w, 1_000_001)).toBe(true);
  });
});

describe("minutesSince", () => {
  it("切り捨て。未来は 0", () => {
    expect(minutesSince(0, 59_999)).toBe(0);
    expect(minutesSince(0, 60_000)).toBe(1);
    expect(minutesSince(0, 125_000)).toBe(2);
    expect(minutesSince(10_000, 0)).toBe(0);
  });
});

describe("resetParts", () => {
  it("ローカル時刻の M月D日 H:mm（分は 2 桁）", () => {
    const d = new Date(2026, 9, 16, 9, 5, 0);
    expect(resetParts(d.getTime() / 1000)).toEqual({ month: 10, day: 16, time: "9:05" });
  });
});
