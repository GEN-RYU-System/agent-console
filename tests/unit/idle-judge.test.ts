import { describe, expect, it } from "vitest";
import { DECISION_MARK, nextIdleMs, replyVerdict } from "../../server/idle-judge.ts";

describe("nextIdleMs (routine-closer の式のまま)", () => {
  it("adds the gap only when the previous sample was idle and had a time", () => {
    expect(nextIdleMs({ prevAt: 1000, prevIdle: true, idleMs: 500 }, true, 4000)).toBe(3500);
  });
  it("is 0 when the current sample is not idle", () => {
    expect(nextIdleMs({ prevAt: 1000, prevIdle: true, idleMs: 500 }, false, 4000)).toBe(0);
  });
  it("is 0 when the previous sample was not idle", () => {
    expect(nextIdleMs({ prevAt: 1000, prevIdle: false, idleMs: 500 }, true, 4000)).toBe(0);
  });
  it("is 0 on the first sample (no previous time)", () => {
    expect(nextIdleMs({ prevAt: null, prevIdle: true, idleMs: 0 }, true, 4000)).toBe(0);
  });
});

describe("replyVerdict", () => {
  it("no reply", () => { expect(replyVerdict(null)).toBe("no-reply"); });
  it("NEEDS_DECISION: or BLOCKED: anywhere is a decision", () => {
    expect(replyVerdict("調べました。\nNEEDS_DECISION: どちらにしますか")).toBe("decision");
    expect(replyVerdict("BLOCKED: 権限がありません")).toBe("decision");
  });
  it("anything else may be closed, including an empty reply", () => {
    expect(replyVerdict("完了しました")).toBe("close");
    expect(replyVerdict("")).toBe("close");
  });
  it("the mark is the same expression as before", () => {
    expect(DECISION_MARK.source).toBe("NEEDS_DECISION:|BLOCKED:");
  });
});
