import { describe, expect, it } from "vitest";
import { BreakTracker, breakBody, buildNotificationScript, escapeAppleScript, isBreak } from "../../server/notify.ts";

describe("isBreak", () => {
  it("is true only for busy -> waiting / idle", () => {
    expect(isBreak("busy", "idle")).toBe(true);
    expect(isBreak("busy", "waiting")).toBe(true);
  });
  it("is false for every other transition and for the first observation", () => {
    expect(isBreak(undefined, "idle")).toBe(false);
    expect(isBreak("idle", "busy")).toBe(false);
    expect(isBreak("waiting", "idle")).toBe(false);
    expect(isBreak("idle", "waiting")).toBe(false);
    expect(isBreak("busy", "busy")).toBe(false);
    expect(isBreak("busy", "unknown")).toBe(false);
    expect(isBreak("unknown", "idle")).toBe(false);
  });
});

describe("escapeAppleScript", () => {
  it("escapes quotes and backslashes and flattens control characters", () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c');
    expect(escapeAppleScript("x\ny\u001bz")).toBe("x y z");
  });
  it("keeps an injection attempt inside the string literal", () => {
    const script = buildNotificationScript('" & (do shell script "id") & "');
    expect(script).toBe('display notification "\\" & (do shell script \\"id\\") & \\"" with title "Agent Console"');
  });
  it("clips very long bodies", () => {
    expect(buildNotificationScript("x".repeat(500)).length).toBeLessThan(200);
  });
});

describe("breakBody", () => {
  it("contains only the session name and the state", () => {
    expect(breakBody("api-fix", "idle")).toBe("api-fix: 指示待ち");
    expect(breakBody("api-fix", "waiting")).toBe("api-fix: 回答待ち");
  });
});

describe("BreakTracker (notification side)", () => {
  it("does not report the first observation, then reports busy -> idle once", () => {
    const t = new BreakTracker();
    expect(t.observe("s1", "idle")).toBe(false);
    expect(t.observe("s1", "busy")).toBe(false);
    expect(t.observe("s1", "idle")).toBe(true);
    expect(t.observe("s1", "idle")).toBe(false);
    expect(t.observe("s1", "busy")).toBe(false);
    expect(t.observe("s1", "waiting")).toBe(true);
  });
  it("forgets the previous status while Claude is not found, so the next observation counts as first for notification", () => {
    const t = new BreakTracker();
    t.observe("s1", "busy");
    expect(t.observe("s1", null)).toBe(false);
    expect(t.observe("s1", "idle")).toBe(false);
  });
  it("tracks sessions independently", () => {
    const t = new BreakTracker();
    t.observe("a", "busy");
    t.observe("b", "busy");
    t.observe("a", "idle");
    expect(t.unreadOf("a")).toBe(1);
    expect(t.unreadOf("b")).toBe(0);
  });
  it("does not use waitingFor for the notification decision", () => {
    const t = new BreakTracker();
    t.observe("s1", "busy");
    expect(t.observe("s1", "busy", "choose")).toBe(false);
    t.observe("s2", "busy");
    expect(t.observe("s2", "idle", "choose")).toBe(true);
  });
});

// design.md §4-1 の表の 14 行（unread の数）。ts は 100 から。Enter は clear(id, now)
describe("BreakTracker unread (design §4-1 table)", () => {
  const stop = (t: BreakTracker, ts: number, over: { stopHookActive?: boolean; failed?: boolean } = {}): void => {
    t.addTurnEnd("w", { ts, stopHookActive: over.stopHookActive ?? false, failed: over.failed ?? false }, ts);
  };
  const enter = (t: BreakTracker, now: number): void => {
    t.clear("w", now);
  };
  const n = (t: BreakTracker): number => t.unreadOf("w");

  it("row1: a 3 second reply: Stop -> 1", () => {
    const t = new BreakTracker();
    stop(t, 100);
    expect(n(t)).toBe(1);
  });
  it("row2: busy -> Stop -> idle -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    stop(t, 100);
    t.observe("w", "idle");
    expect(n(t)).toBe(1);
  });
  it("row3: busy -> waiting -> Stop -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    t.observe("w", "waiting");
    expect(n(t)).toBe(1);
    stop(t, 100);
    expect(n(t)).toBe(1);
  });
  it("row4: Stop -> late busy -> idle -> 1", () => {
    const t = new BreakTracker();
    stop(t, 100);
    t.observe("w", "busy");
    t.observe("w", "idle");
    expect(n(t)).toBe(1);
  });
  it("row5: watcher continued reply: Stop(false) -> busy -> Stop(true) -> idle -> 1", () => {
    const t = new BreakTracker();
    stop(t, 100);
    t.observe("w", "busy");
    stop(t, 200, { stopHookActive: true });
    t.observe("w", "idle");
    expect(n(t)).toBe(1);
  });
  it("row6: idle -> waiting without seeing busy -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "idle");
    expect(n(t)).toBe(0);
    t.observe("w", "waiting");
    expect(n(t)).toBe(1);
  });
  it("row7: waiting -> Enter -> waiting: 1 -> 0 -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "waiting");
    expect(n(t)).toBe(1);
    enter(t, 100);
    expect(n(t)).toBe(0);
    t.observe("w", "waiting");
    expect(n(t)).toBe(1);
  });
  it("row8: busy -> waiting -> Enter -> busy -> Stop: 1 -> 0 -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    t.observe("w", "waiting");
    expect(n(t)).toBe(1);
    enter(t, 100);
    expect(n(t)).toBe(0);
    t.observe("w", "busy");
    stop(t, 200);
    expect(n(t)).toBe(1);
  });
  it("row9: StopFailure and Stop for the same reply -> 1", () => {
    const t = new BreakTracker();
    stop(t, 100, { failed: true });
    stop(t, 101);
    expect(n(t)).toBe(1);
  });
  it("row10: a Stop written before Enter, read after it -> 0", () => {
    const t = new BreakTracker();
    enter(t, 150);
    stop(t, 100);
    expect(n(t)).toBe(0);
  });
  it("row11: no hook: busy -> idle -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    t.observe("w", "idle");
    expect(n(t)).toBe(1);
  });
  it("row12: busy -> idle+waitingFor in a window that has seen a Stop -> 1", () => {
    const t = new BreakTracker();
    stop(t, 100);
    enter(t, 110);
    expect(n(t)).toBe(0);
    t.observe("w", "busy");
    t.observe("w", "idle", "choose one");
    expect(n(t)).toBe(1);
  });
  it("row13: busy -> busy+waitingFor -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    t.observe("w", "busy", "choose one");
    expect(n(t)).toBe(1);
  });
  it("row14: busy -> Stop(false) -> Enter -> Stop(true) -> idle: 1 -> 0 -> 1", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    stop(t, 100);
    expect(n(t)).toBe(1);
    enter(t, 150);
    expect(n(t)).toBe(0);
    stop(t, 200, { stopHookActive: true });
    t.observe("w", "idle");
    expect(n(t)).toBe(1);
  });

  it("K10: a first observation of waiting counts 1 and does not notify", () => {
    const t = new BreakTracker();
    expect(t.observe("w", "waiting")).toBe(false);
    expect(n(t)).toBe(1);
  });
  it("K10: busy -> waiting counts 1 and notifies", () => {
    const t = new BreakTracker();
    t.observe("w", "busy");
    expect(t.observe("w", "waiting")).toBe(true);
    expect(n(t)).toBe(1);
  });
  it("K11: Stop -> idle 1, Stop -> waiting 1", () => {
    const a = new BreakTracker();
    stop(a, 100);
    a.observe("w", "idle");
    expect(n(a)).toBe(1);
    const b = new BreakTracker();
    stop(b, 100);
    b.observe("w", "waiting");
    expect(n(b)).toBe(1);
  });
  it("K7: Stop(true) is not counted without an Enter after the previous Stop", () => {
    const t = new BreakTracker();
    stop(t, 100);
    enter(t, 110);
    stop(t, 120, { stopHookActive: true });
    expect(n(t)).toBe(1);
    const u = new BreakTracker();
    stop(u, 100);
    expect(n(u)).toBe(1);
    stop(u, 200, { stopHookActive: true });
    expect(n(u)).toBe(1);
    enter(u, 250);
    stop(u, 260, { stopHookActive: true });
    expect(n(u)).toBe(1);
  });
  it("K13: StopFailure alone counts 1", () => {
    const t = new BreakTracker();
    stop(t, 100, { failed: true });
    expect(n(t)).toBe(1);
  });
  it("K15: Stop ts=100 read after Enter at 150 -> 0; a Stop after Enter counts", () => {
    const t = new BreakTracker();
    enter(t, 150);
    stop(t, 100);
    expect(n(t)).toBe(0);
    stop(t, 151);
    expect(n(t)).toBe(1);
  });
  it("clear reports whether the count changed and resets the window state", () => {
    const t = new BreakTracker();
    expect(t.clear("w", 10)).toBe(false);
    t.observe("w", "waiting");
    expect(t.clear("w", 20)).toBe(true);
    expect(t.unreadOf("w")).toBe(0);
    expect(t.clear("w", 30)).toBe(false);
  });
  it("forget drops the whole window state", () => {
    const t = new BreakTracker();
    stop(t, 100);
    t.forget("w");
    expect(n(t)).toBe(0);
    stop(t, 100);
    expect(n(t)).toBe(1);
  });
});
