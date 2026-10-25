import { describe, expect, it } from "vitest";
import { safeGitArgs } from "../../server/git-safe.ts";

describe("safeGitArgs", () => {
  it("puts the config overrides before -C and keeps the given args", () => {
    expect(safeGitArgs("/x", ["rev-parse", "HEAD"])).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", "/x", "rev-parse", "HEAD"]);
  });
});
