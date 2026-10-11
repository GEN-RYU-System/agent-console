import { describe, expect, it } from "vitest";
import { parseBranchLine, parseLedgerRow, groupByState } from "../../server/ledger.ts";

describe("ledger parsing", () => {
  it("reads the branch from the first line", () => {
    expect(parseBranchLine("branch: release/x\n\n| a |")).toBe("release/x");
    expect(parseBranchLine("nothing")).toBeNull();
    expect(parseBranchLine("branch:    \n")).toBeNull();
  });

  it("takes the 4th column as the state", () => {
    const row = "| release/x | area | 2026-09-26 | IN_PROGRESS | | | note |";
    expect(parseLedgerRow(row)).toEqual({ branch: "release/x", state: "IN_PROGRESS" });
  });

  it("returns null for rows with fewer than 4 columns", () => {
    expect(parseLedgerRow("| a | b |")).toBeNull();
  });
});

describe("groupByState", () => {
  it("buckets known states and falls back to OTHER / UNREGISTERED", () => {
    const g = groupByState([
      { branch: "a", result: { kind: "found", state: "IN_PROGRESS" } },
      { branch: "b", result: { kind: "found", state: "REVIEW" } },
      { branch: "c", result: { kind: "found", state: "DONE" } },
      { branch: "d", result: { kind: "found", state: "ABANDONED" } },
      { branch: "e", result: { kind: "unregistered" } },
      { branch: "f", result: { kind: "conflict" } },
    ]);
    expect(g.IN_PROGRESS.map((c) => c.branch)).toEqual(["a"]);
    expect(g.REVIEW.length).toBe(1);
    expect(g.DONE.length).toBe(1);
    expect(g.OTHER.map((c) => c.branch)).toEqual(["d"]);
    expect(g.UNREGISTERED.map((c) => c.branch)).toEqual(["e", "f"]);
  });
});
