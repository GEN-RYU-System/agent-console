import { describe, expect, it } from "vitest";
import { splitByCodePoints } from "./chunkInput";

describe("splitByCodePoints", () => {
  it("returns the whole string when it fits", () => {
    expect(splitByCodePoints("abc", 5)).toEqual(["abc"]);
    expect(splitByCodePoints("", 5)).toEqual([]);
  });

  it("splits ASCII at the limit", () => {
    expect(splitByCodePoints("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  it("never splits a surrogate pair", () => {
    const emoji = "\u{1F600}"; // 2 UTF-16 code units
    const chunks = splitByCodePoints(`a${emoji}b${emoji}`, 2);
    expect(chunks.join("")).toBe(`a${emoji}b${emoji}`);
    for (const c of chunks) expect(c).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("keeps a pair whole even when the limit is 1 unit", () => {
    const emoji = "\u{1F600}";
    expect(splitByCodePoints(emoji + emoji, 1)).toEqual([emoji, emoji]);
  });

  it("round-trips a large mixed string", () => {
    const big = "あ\u{1F600}x".repeat(20000);
    const chunks = splitByCodePoints(big, 16 * 1024);
    expect(chunks.join("")).toBe(big);
    expect(chunks.every((c) => c.length <= 16 * 1024)).toBe(true);
  });
});
