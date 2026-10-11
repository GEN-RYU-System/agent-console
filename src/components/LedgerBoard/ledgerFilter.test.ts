// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerCard, LedgerSnapshot } from "../../types";
import { applyLedgerFilter, DEFAULT_LEDGER_FILTER, loadLedgerFilter, saveLedgerFilter, type LedgerFilter } from "./ledgerFilter";

const NOW = new Date(2026, 9, 11, 12, 0).getTime();
const daysAgo = (d: number): number => NOW - d * 24 * 60 * 60 * 1000;
const found = (branch: string, state: string, startedAt: number | null): LedgerCard => ({ branch, result: { kind: "found", state, startedAt } });

const snapshot: LedgerSnapshot = {
  errors: [],
  groups: {
    IN_PROGRESS: [found("release/new-work", "IN_PROGRESS", daysAgo(1)), found("release/old-work", "IN_PROGRESS", daysAgo(60)), found("release/no-date", "IN_PROGRESS", null)],
    REVIEW: [found("release/in-review", "REVIEW", daysAgo(5))],
    DONE: [found("release/finished", "DONE", daysAgo(2))],
    OTHER: [found("release/wip-thing", "WIP", daysAgo(3)), found("release/abandoned", "ABANDONED", daysAgo(3))],
    UNREGISTERED: [{ branch: "release/ghost", result: { kind: "unregistered" } }],
  },
};

const names = (f: ReturnType<typeof applyLedgerFilter>): string[] => Object.values(f.groups).flat().map((c) => c.branch).sort();

afterEach(() => window.localStorage.clear());

describe("applyLedgerFilter", () => {
  it("default: active states within 30 days; hidden and unknown-date rows are counted separately", () => {
    const f = applyLedgerFilter(snapshot, DEFAULT_LEDGER_FILTER, NOW);
    expect(names(f)).toEqual(["release/in-review", "release/new-work", "release/wip-thing"]);
    expect(f).toMatchObject({ shown: 3, unknownDate: 1, hidden: 4, total: 8 });
  });

  it("always partitions every row into exactly one of shown / hidden / unknown-date", () => {
    for (const period of ["7", "30", "90", "all"] as const) {
      for (const state of ["active", "all", "DONE", "UNREGISTERED"] as const) {
        const f = applyLedgerFilter(snapshot, { period, state, query: "" }, NOW);
        expect(f.shown + f.hidden + f.unknownDate).toBe(8);
      }
    }
  });

  it("period 'all' shows rows without a readable date", () => {
    const f = applyLedgerFilter(snapshot, { period: "all", state: "all", query: "" }, NOW);
    expect(f).toMatchObject({ shown: 8, hidden: 0, unknownDate: 0 });
  });

  it("period narrows by start date (7 days)", () => {
    const f = applyLedgerFilter(snapshot, { period: "7", state: "all", query: "" }, NOW);
    expect(names(f)).toEqual(["release/abandoned", "release/finished", "release/in-review", "release/new-work", "release/wip-thing"]);
    expect(f.unknownDate).toBe(2);
  });

  it("filters by a single state and by a case-insensitive search on the branch name", () => {
    expect(names(applyLedgerFilter(snapshot, { period: "all", state: "DONE", query: "" }, NOW))).toEqual(["release/finished"]);
    expect(names(applyLedgerFilter(snapshot, { period: "all", state: "UNREGISTERED", query: "" }, NOW))).toEqual(["release/ghost"]);
    expect(names(applyLedgerFilter(snapshot, { period: "all", state: "all", query: "  WORK " }, NOW))).toEqual(["release/new-work", "release/old-work"]);
  });

  it("handles a missing snapshot", () => {
    expect(applyLedgerFilter(null, DEFAULT_LEDGER_FILTER, NOW)).toMatchObject({ shown: 0, hidden: 0, unknownDate: 0, total: 0 });
  });
});

describe("ledger filter storage", () => {
  it("round-trips through localStorage", () => {
    const filter: LedgerFilter = { period: "90", state: "REVIEW", query: "abc" };
    saveLedgerFilter(filter);
    expect(loadLedgerFilter()).toEqual(filter);
  });

  it("falls back to the default for missing, broken or unknown values", () => {
    expect(loadLedgerFilter()).toEqual(DEFAULT_LEDGER_FILTER);
    window.localStorage.setItem("ac.ledgerFilter", "{broken");
    expect(loadLedgerFilter()).toEqual(DEFAULT_LEDGER_FILTER);
    window.localStorage.setItem("ac.ledgerFilter", JSON.stringify({ period: "1", state: "active", query: "" }));
    expect(loadLedgerFilter()).toEqual(DEFAULT_LEDGER_FILTER);
  });

  it("still works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadLedgerFilter()).toEqual(DEFAULT_LEDGER_FILTER);
    expect(() => saveLedgerFilter(DEFAULT_LEDGER_FILTER)).not.toThrow();
    vi.restoreAllMocks();
  });
});
