import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncFrameCoalescer } from "./syncFrameCoalescer";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

describe("syncFrameCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () => {
    const out: string[] = [];
    const c = createSyncFrameCoalescer((d) => out.push(d));
    return { out, c };
  };

  it("① 印なしはそのまま 1 回", () => {
    const { out, c } = make();
    c.push("abc");
    expect(out).toEqual(["abc"]);
  });

  it("② 1 通で完結する絵は 1 回で全部", () => {
    const { out, c } = make();
    const s = "a" + BEGIN + "x" + END + "b";
    c.push(s);
    expect(out).toEqual([s]);
  });

  it("③ 2 通に分かれる絵は終わりまで貯める", () => {
    const { out, c } = make();
    c.push("a" + BEGIN + "x");
    c.push("y" + END + "b");
    expect(out).toEqual(["a", BEGIN + "xy" + END + "b"]);
  });

  it("④ 3 通に分かれても終わりの回で 1 回", () => {
    const { out, c } = make();
    c.push(BEGIN + "x");
    c.push("y");
    expect(out).toEqual([]);
    c.push("z" + END);
    expect(out).toEqual([BEGIN + "xyz" + END]);
  });

  it("⑤ 末尾が印の途中で切れても次と合わせて 1 回", () => {
    const { out, c } = make();
    c.push("a\x1b[?20");
    expect(out).toEqual(["a"]);
    c.push("26h" + "x" + END);
    expect(out).toEqual(["a", BEGIN + "x" + END]);
  });

  it("⑥ 99ms で 0 回・100ms で 1 回", () => {
    const { out, c } = make();
    c.push(BEGIN + "x");
    vi.advanceTimersByTime(99);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([BEGIN + "x"]);
  });

  it("⑦ reset で捨て、その後の字はそのまま渡る", () => {
    const { out, c } = make();
    c.push(BEGIN + "x");
    c.reset();
    vi.advanceTimersByTime(100);
    expect(out).toEqual([]);
    c.push("z");
    expect(out).toEqual(["z"]);
  });

  it("⑧ 閉じた絵のあとに開いた絵が続くときは閉じた分だけ渡す", () => {
    const { out, c } = make();
    c.push(BEGIN + "a" + END + BEGIN + "b");
    expect(out).toEqual([BEGIN + "a" + END]);
    c.push(END);
    expect(out).toEqual([BEGIN + "a" + END, BEGIN + "b" + END]);
  });
});
