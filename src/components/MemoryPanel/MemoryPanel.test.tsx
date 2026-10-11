// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { MemorySnapshot } from "../../types";
import { MemoryPanel, MEMORY_REFRESH_MS, percentOf } from "./MemoryPanel";

const fetchMemory = vi.fn();
vi.mock("../../api", () => ({ fetchMemory: () => fetchMemory() }));

const snapshot: MemorySnapshot = {
  sessions: [{ id: "s1", name: "api-work", rssMb: 819.2 }],
  serverRssMb: 80,
  system: { totalMb: 8192, freePercent: 53, usedPercent: 47 },
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMemory.mockReset();
  fetchMemory.mockResolvedValue(snapshot);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = (): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

describe("percentOf", () => {
  it("is the share of physical memory, or null without a total", () => {
    expect(percentOf(819.2, 8192)).toBe(10);
    expect(percentOf(1, null)).toBeNull();
    expect(percentOf(1, 0)).toBeNull();
  });
});

describe("MemoryPanel", () => {
  it("shows Mac-wide, server and per-session values in MB and %", async () => {
    render(<MemoryPanel open />);
    await flush();
    expect(screen.getByTestId("memory-system-detail").textContent).toContain("8192 MB");
    expect(screen.getByTestId("memory-system-detail").textContent).toContain("空き率 53 %");
    expect(screen.getByTestId("memory-server").textContent).toContain("80 MB（1 %）");
    const row = screen.getByTestId("memory-session-s1");
    expect(row.textContent).toContain("819.2 MB（10 %）");
  });

  it("refreshes every 10 seconds only while open", async () => {
    const { rerender } = render(<MemoryPanel open />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMemory).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFRESH_MS);
    });
    expect(fetchMemory).toHaveBeenCalledTimes(2);
    rerender(<MemoryPanel open={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFRESH_MS * 3);
    });
    expect(fetchMemory).toHaveBeenCalledTimes(2);
  });

  it("shows an error callout when the first fetch fails", async () => {
    fetchMemory.mockRejectedValue(new Error("down"));
    render(<MemoryPanel open />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("メモリを取得できません");
  });
});
