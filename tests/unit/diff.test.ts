import { describe, expect, it } from "vitest";
import { parseNumstatZ, parseUnifiedDiff } from "../../server/diff.ts";

describe("parseNumstatZ (K1, K13)", () => {
  it("reads added/removed/path triples separated by NUL, including names with spaces", () => {
    const out = "3\t1\tsrc/a.ts\0" + "0\t12\twith space.txt\0";
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a.ts", added: 3, removed: 1, binary: false, untracked: false },
      { path: "with space.txt", added: 0, removed: 12, binary: false, untracked: false },
    ]);
  });

  it("treats '-' counts as binary", () => {
    expect(parseNumstatZ("-\t-\timg.png\0")).toEqual([{ path: "img.png", added: 0, removed: 0, binary: true, untracked: false }]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseNumstatZ("")).toEqual([]);
  });
});

describe("parseUnifiedDiff (K2)", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "index 111..222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -3,4 +3,4 @@ function x",
    " ctx1",
    "-old line",
    "+new line",
    " ctx2",
    "@@ -20 +20,2 @@",
    " keep",
    "+added",
    "\\ No newline at end of file",
  ].join("\n");

  it("numbers lines on both sides and classifies hunk / ctx / del / add", () => {
    expect(parseUnifiedDiff(diff)).toEqual([
      { kind: "hunk", text: "@@ -3,4 +3,4 @@ function x" },
      { kind: "ctx", oldLine: 3, newLine: 3, text: "ctx1" },
      { kind: "del", oldLine: 4, text: "old line" },
      { kind: "add", newLine: 4, text: "new line" },
      { kind: "ctx", oldLine: 5, newLine: 5, text: "ctx2" },
      { kind: "hunk", text: "@@ -20 +20,2 @@" },
      { kind: "ctx", oldLine: 20, newLine: 20, text: "keep" },
      { kind: "add", newLine: 21, text: "added" },
    ]);
  });

  it("does not misread a body line that starts with '--- ' or '+++ ' inside a hunk", () => {
    const tricky = ["@@ -1,2 +1,2 @@", "--- not a header", "+++ not a header either"].join("\n");
    expect(parseUnifiedDiff(`diff --git a/x b/x\n--- a/x\n+++ b/x\n${tricky}`)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "del", oldLine: 1, text: "-- not a header" },
      { kind: "add", newLine: 1, text: "++ not a header either" },
    ]);
  });
});
