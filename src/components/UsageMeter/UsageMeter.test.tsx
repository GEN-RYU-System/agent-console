// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { UsageResponse } from "../../types";
import { UsageMeter } from "./UsageMeter";
import { USAGE_REFRESH_MS } from "./usageLogic";

const fetchUsage = vi.fn();
vi.mock("../../api", () => ({ fetchUsage: () => fetchUsage() }));

const NOW = new Date(2026, 9, 13, 18, 0, 0).getTime();
const FUTURE = NOW / 1000 + 3 * 3600;
const PAST = NOW / 1000 - 60;
const okOf = (week: number | null, five: number | null, extra: Partial<{ weekResets: number; fiveResets: number; observedAt: number }> = {}): UsageResponse => ({
  status: "ok",
  observedAt: extra.observedAt ?? NOW - 5 * 60_000,
  ...(week === null ? {} : { sevenDay: { usedPercentage: week, resetsAt: extra.weekResets ?? FUTURE } }),
  ...(five === null ? {} : { fiveHour: { usedPercentage: five, resetsAt: extra.fiveResets ?? FUTURE } }),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchUsage.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function show(usage: UsageResponse): Promise<void> {
  fetchUsage.mockResolvedValue(usage);
  render(<UsageMeter />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const has = (id: string): boolean => screen.queryByTestId(id) !== null;

describe("K7: UsageMeter", () => {
  it("値が無いときは案内の文を出す。none も invalid も取得失敗もバーは出さない", async () => {
    await show({ status: "none" });
    expect(screen.getByTestId("usage-meter-message").textContent).toBe("まだ値がありません（Claude が返事をすると出ます）");
    expect(has("usage-meter-bar-week")).toBe(false);
    cleanup();
    await show({ status: "invalid" });
    expect(screen.getByTestId("usage-meter-message").textContent).toBe("利用量の値を読めません");
    cleanup();
    fetchUsage.mockRejectedValue(new Error("x"));
    render(<UsageMeter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("usage-meter-message").textContent).toBe("利用量を取得できません");
  });

  it("週・5時間の 2 本のバーと N%、リセットの日時、N分前に書かれた値を出す。80% 未満は Badge なし", async () => {
    await show(okOf(41, 23));
    expect(has("usage-meter-bar-week")).toBe(true);
    expect(has("usage-meter-bar-fiveHour")).toBe(true);
    expect(screen.getByTestId("usage-meter-pct-week").textContent).toBe("41%");
    expect(screen.getByTestId("usage-meter-pct-fiveHour").textContent).toBe("23%");
    expect(screen.getByTestId("usage-meter-week").textContent).toContain("リセット 10月13日 21:00");
    expect(screen.getByTestId("usage-meter-age").textContent).toBe("5分前に書かれた値");
    expect(has("usage-meter-badge-week")).toBe(false);
    expect(has("usage-meter-badge-fiveHour")).toBe(false);
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });

  it.each([
    [79, null, null],
    [80, "warning", "上限に近い"],
    [94, "warning", "上限に近い"],
    [95, "danger", "ほぼ上限"],
    [99, "danger", "ほぼ上限"],
  ])("%s%%: Badge は %s（%s）。棒は出る", async (pct, level, label) => {
    await show(okOf(pct, null));
    expect(has("usage-meter-bar-week")).toBe(true);
    if (level === null) {
      expect(has("usage-meter-badge-week")).toBe(false);
      return;
    }
    const badge = screen.getByTestId("usage-meter-badge-week");
    expect(badge.getAttribute("data-level")).toBe(level);
    expect(badge.textContent).toBe(label);
  });

  it("100% のとき、棒（usage-meter-bar-<窓>）は出さず、danger の Badge「上限」と 100% を出す（完了の見た目を避ける）", async () => {
    await show(okOf(100, 50));
    expect(has("usage-meter-bar-week")).toBe(false);
    expect(has("usage-meter-bar-fiveHour")).toBe(true);
    const badge = screen.getByTestId("usage-meter-badge-week");
    expect(badge.getAttribute("data-level")).toBe("full");
    expect(badge.textContent).toBe("上限");
    expect(screen.getByTestId("usage-meter-pct-week").textContent).toBe("100%");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("片方の窓だけのときは、その窓だけを出す", async () => {
    await show(okOf(null, 30));
    expect(has("usage-meter-week")).toBe(false);
    expect(has("usage-meter-fiveHour")).toBe(true);
  });

  it("resets_at を過ぎた窓は「リセット済み・次の返事を待っています」。その窓の棒と Badge は出さない。もう一方は通常どおり", async () => {
    await show(okOf(97, 40, { weekResets: PAST }));
    expect(screen.getByTestId("usage-meter-reset-done-week").textContent).toBe("リセット済み・次の返事を待っています");
    expect(has("usage-meter-bar-week")).toBe(false);
    expect(has("usage-meter-badge-week")).toBe(false);
    expect(has("usage-meter-bar-fiveHour")).toBe(true);
  });

  it("書かれた直後は「たった今書かれた値」", async () => {
    await show(okOf(10, 10, { observedAt: NOW - 20_000 }));
    expect(screen.getByTestId("usage-meter-age").textContent).toBe("たった今書かれた値");
  });

  it("K8: 60 秒ごとに取り直す。リセット時刻を過ぎたら次の取り直しで表示が変わる", async () => {
    fetchUsage.mockResolvedValue(okOf(41, 23, { weekResets: NOW / 1000 + 30 }));
    render(<UsageMeter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(has("usage-meter-bar-week")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS);
    });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(has("usage-meter-reset-done-week")).toBe(true);
  });

  it("画面を閉じたら取り直しを止める", async () => {
    fetchUsage.mockResolvedValue({ status: "none" });
    const { unmount } = render(<UsageMeter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS * 3);
    });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });
});
