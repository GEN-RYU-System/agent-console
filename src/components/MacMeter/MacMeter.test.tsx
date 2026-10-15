// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { MemorySnapshot } from "../../types";
import { MEMORY_REFRESH_MS } from "../MemoryPanel/MemoryPanel";
import { MacMeter, meterValues } from "./MacMeter";

const fetchMemory = vi.fn();
vi.mock("../../api", () => ({ fetchMemory: () => fetchMemory() }));

const snap = (system: Partial<NonNullable<MemorySnapshot["system"]>> | null): MemorySnapshot => ({
  sessions: [],
  serverRssMb: 1,
  system: system === null ? null : { totalMb: 8192, freePercent: 50, usedPercent: 50, ...system },
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchMemory.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function show(s: MemorySnapshot): Promise<void> {
  fetchMemory.mockResolvedValue(s);
  render(<MacMeter />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const text = (id: string): string | null => screen.queryByTestId(id)?.textContent ?? null;

describe("MacMeter", () => {
  it("meterValues maps cpu, ram(usedPercent) and disk; nothing yet gives nulls", () => {
    expect(meterValues(snap({ cpuPercent: 12.4, usedPercent: 60, diskUsedPercent: 93.7 }))).toEqual({ cpu: 12.4, ram: 60, disk: 93.7 });
    expect(meterValues(null)).toEqual({ cpu: null, ram: null, disk: null });
    expect(meterValues(snap(null))).toEqual({ cpu: null, ram: null, disk: null });
  });

  it("shows three bars with rounded percentages", async () => {
    await show(snap({ cpuPercent: 12.4, usedPercent: 60, diskUsedPercent: 93.7 }));
    expect([text("mac-meter-pct-cpu"), text("mac-meter-pct-ram"), text("mac-meter-pct-disk")]).toEqual(["12%", "60%", "94%"]);
    for (const id of ["cpu", "ram", "disk"]) expect(screen.queryByTestId(`mac-meter-bar-${id}`)).not.toBeNull();
  });

  it("shows 計測中 for a value that is not measured yet (cpu at the first sample)", async () => {
    await show(snap({ cpuPercent: null, diskUsedPercent: null }));
    expect(text("mac-meter-measuring-cpu")).toBe("計測中");
    expect(text("mac-meter-measuring-disk")).toBe("計測中");
    expect(screen.queryByTestId("mac-meter-bar-cpu")).toBeNull();
    expect(text("mac-meter-pct-ram")).toBe("50%");
  });

  it("at 100% or more shows a danger badge instead of a bar", async () => {
    await show(snap({ cpuPercent: 100, usedPercent: 99, diskUsedPercent: 20 }));
    expect(screen.queryByTestId("mac-meter-bar-cpu")).toBeNull();
    expect(screen.getByTestId("mac-meter-badge-cpu").getAttribute("data-level")).toBe("full");
    expect(screen.queryByTestId("mac-meter-badge-ram")).toBeNull();
  });

  it("shows the error text when the fetch fails and recovers on the next fetch", async () => {
    fetchMemory.mockRejectedValue(new Error("x"));
    render(<MacMeter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text("mac-meter-message")).toBe("Mac の使用率を取得できません");
    fetchMemory.mockResolvedValue(snap({ cpuPercent: 5, diskUsedPercent: 50 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFRESH_MS);
    });
    expect(screen.queryByTestId("mac-meter-message")).toBeNull();
    expect(text("mac-meter-pct-cpu")).toBe("5%");
  });

  it("fetches again every MEMORY_REFRESH_MS and stops after unmount", async () => {
    fetchMemory.mockResolvedValue(snap({ cpuPercent: 1 }));
    const { unmount } = render(<MacMeter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFRESH_MS);
    });
    expect(fetchMemory).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFRESH_MS * 3);
    });
    expect(fetchMemory).toHaveBeenCalledTimes(2);
  });
});
