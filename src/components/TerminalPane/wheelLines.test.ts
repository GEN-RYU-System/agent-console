import { describe, expect, it } from "vitest";
import { LINES_PER_FRAME, LineEmitter, WheelLineAccumulator, type Direction } from "./wheelLines";

describe("WheelLineAccumulator (K1)", () => {
  it("deltaY=100・行高17 → 5行、端数を持ち越して次の100で6行", () => {
    const a = new WheelLineAccumulator();
    expect(a.add({ deltaY: 100, deltaMode: 0 }, 17, 24)).toBe(5);
    expect(a.add({ deltaY: 100, deltaMode: 0 }, 17, 24)).toBe(6);
  });

  it("deltaY=4 を25回 → 合計5行", () => {
    const a = new WheelLineAccumulator();
    let sum = 0;
    for (let i = 0; i < 25; i++) sum += a.add({ deltaY: 4, deltaMode: 0 }, 17, 24);
    expect(sum).toBe(5);
  });

  it("行モードはそのまま、ページモードは rows 行", () => {
    const a = new WheelLineAccumulator();
    expect(a.add({ deltaY: 3, deltaMode: 1 }, 17, 24)).toBe(3);
    expect(a.add({ deltaY: -1, deltaMode: 2 }, 17, 24)).toBe(-24);
  });

  it("向きが変わると端数を捨てる（5.5 → 5、-3.5 → -3）", () => {
    const a = new WheelLineAccumulator();
    expect(a.add({ deltaY: 17 * 5.5, deltaMode: 0 }, 17, 24)).toBe(5);
    expect(a.add({ deltaY: -17 * 3.5, deltaMode: 0 }, 17, 24)).toBe(-3);
  });

  it("上限 rows で切る", () => {
    const a = new WheelLineAccumulator();
    expect(a.add({ deltaY: 100000, deltaMode: 0 }, 17, 24)).toBe(24);
    expect(a.add({ deltaY: -100000, deltaMode: 0 }, 17, 24)).toBe(-24);
  });

  it("行高が 0 以下・deltaY が 0 なら 0行", () => {
    const a = new WheelLineAccumulator();
    expect(a.add({ deltaY: 100, deltaMode: 0 }, 0, 24)).toBe(0);
    expect(a.add({ deltaY: 0, deltaMode: 0 }, 17, 24)).toBe(0);
  });
});

/** 手で回す scheduler */
function manual() {
  const queue: Array<() => void> = [];
  let cancelled = 0;
  return {
    schedule: (cb: () => void) => void queue.push(cb),
    cancel: () => {
      cancelled += 1;
      queue.length = 0;
    },
    frame: () => {
      const cb = queue.shift();
      cb?.();
    },
    pendingFrames: () => queue.length,
    cancelled: () => cancelled,
  };
}

describe("LineEmitter (K2)", () => {
  it("K2a: フレームごとに最大2行、合計が push の合計と一致", () => {
    const m = manual();
    const e = new LineEmitter(m.schedule, m.cancel);
    const sent: Direction[] = [];
    e.push(5, (d) => sent.push(d), 24);
    const perFrame: number[] = [];
    while (m.pendingFrames() > 0) {
      const before = sent.length;
      m.frame();
      perFrame.push(sent.length - before);
    }
    expect(perFrame).toEqual([LINES_PER_FRAME, LINES_PER_FRAME, 1]);
    expect(sent).toEqual([1, 1, 1, 1, 1]);
  });

  it("K2a: 逆向きの push で前の残りを捨てる", () => {
    const m = manual();
    const e = new LineEmitter(m.schedule, m.cancel);
    const sent: Direction[] = [];
    e.push(5, (d) => sent.push(d), 24);
    m.frame();
    e.push(-3, (d) => sent.push(d), 24);
    while (m.pendingFrames() > 0) m.frame();
    expect(sent).toEqual([1, 1, -1, -1, -1]);
  });

  it("K2b: 上限（rows×2）を超えた push は上限まで送り、残りは捨てる", () => {
    const m = manual();
    const e = new LineEmitter(m.schedule, m.cancel);
    let n = 0;
    e.push(24, () => n++, 4);
    e.push(24, () => n++, 4);
    while (m.pendingFrames() > 0) m.frame();
    expect(n).toBe(8);
  });

  it("dispose 後は呼ばない", () => {
    const m = manual();
    const e = new LineEmitter(m.schedule, m.cancel);
    let n = 0;
    e.push(5, () => n++, 24);
    e.dispose();
    expect(m.cancelled()).toBe(1);
    m.frame();
    expect(n).toBe(0);
    expect(e.queued).toBe(0);
  });

  it("emitOne の中で clear されたら残りを送らない", () => {
    const m = manual();
    const e = new LineEmitter(m.schedule, m.cancel);
    let n = 0;
    e.push(5, () => {
      n++;
      e.clear();
    }, 24);
    m.frame();
    expect(n).toBe(1);
    expect(e.queued).toBe(0);
  });
});
