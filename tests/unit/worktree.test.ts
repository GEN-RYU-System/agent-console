import { describe, expect, it } from "vitest";
import { isValidBranch, parseWorktreePorcelain, findWorktreePath } from "../../server/worktree.ts";

describe("isValidBranch", () => {
  it.each(["release/abc", "release/a1-b2-c3", "release/9x"])("accepts %s", (b) => {
    expect(isValidBranch(b)).toBe(true);
  });
  it.each([
    "main",
    "release/",
    "release/A",
    "release/-ab",
    "release/a",
    "release/a b",
    "release/a;rm",
    "release/a$(x)",
    "release/../x",
    "release/" + "a".repeat(62),
    "feat/abc",
  ])("rejects %s", (b) => {
    expect(isValidBranch(b)).toBe(false);
  });
});

const porcelain = [
  "worktree /repo",
  "HEAD aaaa",
  "branch refs/heads/main",
  "",
  "worktree /wt/release-abc",
  "HEAD bbbb",
  "branch refs/heads/release/abc",
  "",
  "worktree /wt/detached",
  "HEAD cccc",
  "detached",
  "",
].join("\n");

describe("parseWorktreePorcelain", () => {
  it("parses entries with and without branches", () => {
    const entries = parseWorktreePorcelain(porcelain);
    expect(entries).toEqual([
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/wt/release-abc", branch: "refs/heads/release/abc" },
      { path: "/wt/detached", branch: null },
    ]);
  });
  it("finds a path by short branch name", () => {
    expect(findWorktreePath(parseWorktreePorcelain(porcelain), "release/abc")).toBe("/wt/release-abc");
    expect(findWorktreePath(parseWorktreePorcelain(porcelain), "release/none")).toBeNull();
  });
});
