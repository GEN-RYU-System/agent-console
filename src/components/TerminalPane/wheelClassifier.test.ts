// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { WheelClassifier, wheelDeltas } from "./wheelClassifier";

/** マウスのホイール: 1 ノッチずつ、整数で、毎回同じ大きさ */
function wheelNotches(c: WheelClassifier, n: number): void {
  for (let i = 0; i < n; i++) c.accept(1000 + i * 50, 0, -1);
}
/** トラックパッド: 小数で、加速・減速しながら連続する */
function trackpad(c: WheelClassifier): void {
  [0.075, 0.1, 0.175, 0.325, 0.4, 0.275].forEach((dy, i) => c.accept(2000 + i * 16, 0, dy));
}

describe("WheelClassifier (the same idea as VS Code's MouseWheelClassifier)", () => {
  it("says false when nothing has been seen (so unknown means no smooth scroll)", () => {
    expect(new WheelClassifier().isPhysicalMouseWheel()).toBe(false);
  });

  it("K2: integer, same-size notches are a physical wheel", () => {
    const c = new WheelClassifier();
    wheelNotches(c, 5);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("K2: fractional, accelerating deltas are not a physical wheel (trackpad)", () => {
    const c = new WheelClassifier();
    trackpad(c);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("K2: movement on both axes at once is never a physical wheel", () => {
    const c = new WheelClassifier();
    wheelNotches(c, 5);
    for (let i = 0; i < 5; i++) c.accept(3000 + i, 1, 1);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("switches back and forth as the device changes, using only the last 5 events", () => {
    const c = new WheelClassifier();
    wheelNotches(c, 5);
    expect(c.isPhysicalMouseWheel()).toBe(true);
    trackpad(c);
    expect(c.isPhysicalMouseWheel()).toBe(false);
    wheelNotches(c, 5);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });
});

describe("wheelDeltas", () => {
  const ev = (init: WheelEventInit, legacy: Record<string, number> = {}): WheelEvent => {
    const e = new WheelEvent("wheel", init);
    for (const [k, v] of Object.entries(legacy)) Object.defineProperty(e, k, { value: v });
    return e;
  };
  it("uses wheelDelta / 120 when present (a notch is 1)", () => {
    expect(wheelDeltas(ev({ deltaY: 100 }, { wheelDeltaY: -120, wheelDeltaX: 0 }))).toEqual({ dx: 0, dy: -1 });
  });
  it("uses -delta (lines) or -delta / 40 (pixels) otherwise", () => {
    expect(wheelDeltas(ev({ deltaY: 3, deltaMode: 1 }))).toEqual({ dx: -0, dy: -3 });
    expect(wheelDeltas(ev({ deltaY: 80 }))).toEqual({ dx: -0, dy: -2 });
  });
});
