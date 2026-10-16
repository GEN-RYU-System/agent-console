import { describe, expect, it, vi } from "vitest";
import { cpuPercentBetween, diskUsage, MemoryCollector, sessionMemory, sumCpuTimes } from "../../server/memory.ts";
import { descendantPids, parsePsOutput, sumCpu } from "../../server/process-tree.ts";
import { DEFAULT_METRICS_POLL_MS, parseConfig } from "../../server/config.ts";
import { readFileSync } from "node:fs";

describe("pc-meter: ps の %cpu 列", () => {
  const ps = "  1     0  8448  0.0\n 10     1  2048  3.5\n 11    10  1024 10.25\n 12    11   512  0.0\n 20     1  4096 99.9\n 30 1 100\n";
  it("reads %cpu as a decimal and treats a missing column as 0", () => {
    const rows = parsePsOutput(ps);
    expect(rows.find((r) => r.pid === 11)).toEqual({ pid: 11, ppid: 10, rssKb: 1024, cpu: 10.25 });
    expect(rows.find((r) => r.pid === 30)).toEqual({ pid: 30, ppid: 1, rssKb: 100, cpu: 0 });
  });
  it("sums %cpu over the root and every descendant only", () => {
    const rows = parsePsOutput(ps);
    expect(sumCpu(descendantPids(10, rows), rows)).toBe(13.75);
  });
});

describe("pc-meter: Mac 全体の CPU（os.cpus の 2 時点の差）", () => {
  const cpu = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  it("sums busy (user+nice+sys+irq) and total over all cores", () => {
    expect(sumCpuTimes([{ times: { user: 10, nice: 1, sys: 2, idle: 80, irq: 3 } }, cpu(5, 95)])).toEqual({ busy: 21, total: 196 });
  });
  it("computes busy/total x 100 for the window, rounded to one decimal", () => {
    expect(cpuPercentBetween({ busy: 100, total: 1000 }, { busy: 160, total: 1200 })).toBe(30);
    expect(cpuPercentBetween({ busy: 0, total: 0 }, { busy: 1, total: 3 })).toBe(33.3);
  });
  it("returns null for an empty window and clamps to 0..100", () => {
    expect(cpuPercentBetween({ busy: 1, total: 10 }, { busy: 1, total: 10 })).toBeNull();
    expect(cpuPercentBetween({ busy: 0, total: 0 }, { busy: 50, total: 10 })).toBe(100);
    expect(cpuPercentBetween({ busy: 50, total: 0 }, { busy: 0, total: 10 })).toBe(0);
  });
});

describe("pc-meter: Disk（statfs）", () => {
  it("uses (blocks - bavail) / blocks and reports the total in GiB (r3 実測値)", () => {
    const r = diskUsage({ blocks: 239362496 / 4, bavail: 14995096 / 4, bsize: 4096 });
    expect(r?.usedPercent).toBe(93.7);
    expect(r?.totalGb).toBe(228.3);
  });
  it("returns null when blocks is not positive", () => {
    expect(diskUsage({ blocks: 0, bavail: 0, bsize: 4096 })).toBeNull();
  });
});

describe("pc-meter: セッションの CPU・RAM", () => {
  const rows = parsePsOutput(" 10 1 2048 40.0\n 11 10 2048 40.0\n 20 1 1024 8.0\n");
  const live = [
    { id: "a", name: "A", exited: false, term: { pid: 10 } },
    { id: "b", name: "B", exited: false, term: { pid: 20 } },
    { id: "c", name: "C", exited: true, term: { pid: 99 } },
  ];
  it("divides the subtree %cpu by the core count and rssMb by total memory", () => {
    const out = sessionMemory(live, rows, 8, 8);
    expect(out.map((s) => [s.id, s.cpuPercent, s.ramPercent])).toEqual([["a", 10, 50], ["b", 1, 12.5], ["c", 0, 0]]);
  });
  it("gives ramPercent null when total memory is unknown", () => {
    expect(sessionMemory(live, rows, null, 8).map((s) => s.ramPercent)).toEqual([null, null, null]);
  });
  it("clamps cpuPercent to 100", () => {
    expect(sessionMemory([live[0]], parsePsOutput(" 10 1 1 5000.0\n"), 8, 8)[0].cpuPercent).toBe(100);
  });
});

describe("pc-meter: MemoryCollector の定期計測", () => {
  const raw = { table: parsePsOutput(" 10 1 2048 8.0\n"), system: { totalMb: 8192, freePercent: 50, usedPercent: 50 }, disk: { usedPercent: 93.7, totalGb: 228.3 } };
  const sessions = [{ id: "a", name: "A", exited: false, term: { pid: 10 } }];

  it("CPU is null at the first measure and the difference from the second; disk values come with the snapshot", async () => {
    const times = [{ busy: 0, total: 0 }, { busy: 25, total: 100 }, { busy: 75, total: 200 }];
    const readCpu = vi.fn(() => times.shift() as { busy: number; total: number });
    const c = new MemoryCollector(5000, () => 0, async () => raw, readCpu);
    const first = await c.measure(sessions);
    expect(first.system?.cpuPercent).toBeNull();
    expect(first.system?.diskUsedPercent).toBe(93.7);
    expect(first.system?.diskTotalGb).toBe(228.3);
    expect((await c.measure(sessions)).system?.cpuPercent).toBe(25);
    expect((await c.measure(sessions)).system?.cpuPercent).toBe(50);
  });

  it("collect (the /api/memory path) never takes a CPU difference: it returns the last measured value", async () => {
    const times = [{ busy: 0, total: 0 }, { busy: 25, total: 100 }];
    const readCpu = vi.fn(() => times.shift() as { busy: number; total: number });
    const c = new MemoryCollector(5000, () => 0, async () => raw, readCpu);
    await c.measure(sessions);
    await c.measure(sessions);
    expect(readCpu).toHaveBeenCalledTimes(2);
    expect((await c.collect(sessions)).system?.cpuPercent).toBe(25);
    expect((await c.collect(sessions)).system?.cpuPercent).toBe(25);
    expect(readCpu).toHaveBeenCalledTimes(2);
  });

  it("a read without disk reports null disk values; a null system stays null", async () => {
    const c = new MemoryCollector(5000, () => 0, async () => ({ table: raw.table, system: raw.system }));
    expect((await c.collect(sessions)).system?.diskUsedPercent).toBeNull();
    const d = new MemoryCollector(5000, () => 0, async () => ({ table: raw.table, system: null }));
    expect((await d.collect(sessions)).system).toBeNull();
  });

  it("measure always re-reads the OS data even inside the cache window", async () => {
    const readRaw = vi.fn(async () => raw);
    const c = new MemoryCollector(5000, () => 0, readRaw, () => ({ busy: 0, total: 1 }));
    await c.measure(sessions);
    await c.measure(sessions);
    expect(readRaw).toHaveBeenCalledTimes(2);
  });
});

describe("pc-meter: metricsPollMs", () => {
  it("defaults to 2000, can be set, and refuses non-positive values; the shipped config carries 2000", () => {
    const shipped = JSON.parse(readFileSync("agent-console.config.json", "utf8"));
    expect(DEFAULT_METRICS_POLL_MS).toBe(2000);
    expect(parseConfig(shipped).metricsPollMs).toBe(2000);
    expect(parseConfig({ ...shipped, metricsPollMs: 3000 }).metricsPollMs).toBe(3000);
    expect(parseConfig({ ...shipped, metricsPollMs: undefined }).metricsPollMs).toBe(2000);
    for (const bad of [0, -1, "1", null]) expect(() => parseConfig({ ...shipped, metricsPollMs: bad })).toThrow(/metricsPollMs/);
  });
});
