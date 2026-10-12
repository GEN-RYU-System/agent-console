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

describe("BreakTracker", () => {
  it("does not report the first observation, then reports busy -> idle once and counts unread", () => {
    const t = new BreakTracker();
    expect(t.observe("s1", "idle")).toBe(false);
    expect(t.observe("s1", "busy")).toBe(false);
    expect(t.observe("s1", "idle")).toBe(true);
    expect(t.observe("s1", "idle")).toBe(false);
    expect(t.unreadOf("s1")).toBe(1);
    expect(t.observe("s1", "busy")).toBe(false);
    expect(t.observe("s1", "waiting")).toBe(true);
    expect(t.unreadOf("s1")).toBe(2);
  });
  it("markRead clears the count and reports whether something changed", () => {
    const t = new BreakTracker();
    t.observe("s1", "busy");
    t.observe("s1", "idle");
    expect(t.markRead("s1")).toBe(true);
    expect(t.unreadOf("s1")).toBe(0);
    expect(t.markRead("s1")).toBe(false);
  });
  it("forgets the previous status while Claude is not found, so the next observation counts as first", () => {
    const t = new BreakTracker();
    t.observe("s1", "busy");
    expect(t.observe("s1", null)).toBe(false);
    expect(t.observe("s1", "idle")).toBe(false);
    expect(t.unreadOf("s1")).toBe(0);
  });
  it("tracks sessions independently", () => {
    const t = new BreakTracker();
    t.observe("a", "busy");
    t.observe("b", "busy");
    t.observe("a", "idle");
    expect(t.unreadOf("a")).toBe(1);
    expect(t.unreadOf("b")).toBe(0);
  });
});
