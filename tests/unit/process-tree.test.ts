import { describe, expect, it } from "vitest";
import { descendantPids, parsePsOutput } from "../../server/process-tree.ts";

describe("process-tree", () => {
  const ps = "  1     0\n 10     1\n 11    10\n 12    11\n 20     1\nbad line\n";
  it("parses pid/ppid pairs and ignores bad lines", () => {
    expect(parsePsOutput(ps).length).toBe(5);
  });
  it("collects the root and all descendants", () => {
    const set = descendantPids(10, parsePsOutput(ps));
    expect([...set].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
  it("returns only the root when it has no children", () => {
    expect([...descendantPids(20, parsePsOutput(ps))]).toEqual([20]);
  });
});

describe("process-tree: pid <= 0 (R1)", () => {
  const ps = "  1     0\n 10     1\n 11    10\n";
  it("returns an empty set for root 0 (launchd's children must not be treated as descendants)", () => {
    expect(descendantPids(0, parsePsOutput(ps)).size).toBe(0);
  });
  it("returns an empty set for a negative root", () => {
    expect(descendantPids(-1, parsePsOutput(ps)).size).toBe(0);
  });
});
