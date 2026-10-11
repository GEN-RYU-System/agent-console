import { describe, expect, it, vi } from "vitest";
import { MemoryCollector, parseFreePercent, parseMemsize, sessionMemory } from "../../server/memory.ts";
import { descendantPids, parsePsOutput, sumRssKb } from "../../server/process-tree.ts";

describe("parsePsOutput with rss", () => {
  const ps = "  1     0  8448\n 10     1  2048\n 11    10  1024\n 12    11  512\n 20     1  4096\nbad line\n 30 1\n";
  it("reads rss in KB and treats a missing column as 0", () => {
    const rows = parsePsOutput(ps);
    expect(rows.find((r) => r.pid === 10)).toEqual({ pid: 10, ppid: 1, rssKb: 2048 });
    expect(rows.find((r) => r.pid === 30)).toEqual({ pid: 30, ppid: 1, rssKb: 0 });
    expect(rows).toHaveLength(6);
  });
  it("sums the RSS of the root and every descendant", () => {
    const rows = parsePsOutput(ps);
    expect(sumRssKb(descendantPids(10, rows), rows)).toBe(2048 + 1024 + 512);
  });
});

describe("sessionMemory", () => {
  it("sums each session's whole process subtree in MB and gives 0 for exited sessions", () => {
    const rows = parsePsOutput(" 10 1 2048\n 11 10 1024\n 20 1 4096\n");
    const out = sessionMemory(
      [
        { id: "a", name: "A", exited: false, term: { pid: 10 } },
        { id: "b", name: "B", exited: false, term: { pid: 20 } },
        { id: "c", name: "C", exited: true, term: { pid: 99 } },
      ],
      rows,
    );
    expect(out).toEqual([
      { id: "a", name: "A", rssMb: 3 },
      { id: "b", name: "B", rssMb: 4 },
      { id: "c", name: "C", rssMb: 0 },
    ]);
  });
});

describe("system memory parsers", () => {
  it("reads hw.memsize bytes as MB", () => {
    expect(parseMemsize("8589934592\n")).toBe(8192);
    expect(parseMemsize("hw.memsize: 1")).toBeNull();
  });
  it("reads the free percentage from the last line of memory_pressure", () => {
    const text = "The system has 8589934592 (524288 pages with a page size of 16384).\nPages free: 3547\n\nSystem-wide memory free percentage: 53%\n";
    expect(parseFreePercent(text)).toBe(53);
    expect(parseFreePercent("nothing")).toBeNull();
    expect(parseFreePercent("System-wide memory free percentage: 999%")).toBeNull();
  });
});

describe("MemoryCollector", () => {
  const raw = { table: parsePsOutput(" 10 1 2048\n"), system: { totalMb: 8192, freePercent: 50, usedPercent: 50 } };
  const sessions = [{ id: "a", name: "A", exited: false, term: { pid: 10 } }];

  it("runs the OS commands once for concurrent requests", async () => {
    const readRaw = vi.fn(async () => raw);
    const c = new MemoryCollector(5000, () => 0, readRaw);
    await Promise.all([c.collect(sessions), c.collect(sessions), c.collect(sessions)]);
    expect(readRaw).toHaveBeenCalledTimes(1);
  });

  it("serves from the cache for 5 seconds and re-reads after that", async () => {
    let t = 0;
    const readRaw = vi.fn(async () => raw);
    const c = new MemoryCollector(5000, () => t, readRaw);
    await c.collect(sessions);
    t = 4999;
    await c.collect(sessions);
    expect(readRaw).toHaveBeenCalledTimes(1);
    t = 5000;
    await c.collect(sessions);
    expect(readRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the names it is given for each request even when the OS data is cached", async () => {
    const c = new MemoryCollector(5000, () => 0, async () => raw);
    expect((await c.collect(sessions)).sessions[0].name).toBe("A");
    expect((await c.collect([{ ...sessions[0], name: "claude-name" }])).sessions[0].name).toBe("claude-name");
  });

  it("does not cache a failure", async () => {
    const readRaw = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(raw);
    const c = new MemoryCollector(5000, () => 0, readRaw);
    await expect(c.collect(sessions)).rejects.toThrow("boom");
    await expect(c.collect(sessions)).resolves.toBeDefined();
  });
});
