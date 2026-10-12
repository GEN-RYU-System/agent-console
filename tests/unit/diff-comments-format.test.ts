import { describe, expect, it } from "vitest";
import { formatReviewComments } from "../../server/diff-comments-format.ts";
import type { DiffCommentItem } from "../../server/diff-comments.ts";

const item = (over: Partial<DiffCommentItem>): DiffCommentItem => ({ id: "i1", path: "server/http.ts", side: "new", line: 204, lineText: "const m = 1;", body: "close も入れてください", createdAt: 1, ...over });

describe("formatReviewComments (K5)", () => {
  it("builds the File / Line / 該当行 / Comment blocks and returns the ids it contains", () => {
    const { text, ids } = formatReviewComments([item({}), item({ id: "i2", path: "README.md", side: "file", line: undefined, lineText: undefined, body: "追記" })], 16 * 1024);
    expect(ids).toEqual(["i1", "i2"]);
    expect(text).toBe(
      [
        "差分へのレビューコメントです。各コメントの行を確認して対応してください。",
        "",
        "File: server/http.ts",
        "Line: 204（新しい側）",
        "該当行: const m = 1;",
        "Comment: close も入れてください",
        "",
        "File: README.md",
        "Scope: ファイル全体",
        "Comment: 追記",
      ].join("\n"),
    );
  });

  it("labels the old side and skips already-sent comments", () => {
    const { text, ids } = formatReviewComments([item({ side: "old", line: 7 }), item({ id: "sent", sentAt: 5 })], 16 * 1024);
    expect(ids).toEqual(["i1"]);
    expect(text).toContain("Line: 7（古い側）");
    expect(text).not.toContain("sent");
  });

  it("cuts the line text at 200 characters", () => {
    const { text } = formatReviewComments([item({ lineText: "x".repeat(500) })], 16 * 1024);
    expect(text).toContain(`該当行: ${"x".repeat(200)}\n`);
    expect(text).not.toContain("x".repeat(201));
  });

  it("replaces control characters in the path and the line text so the pasted text cannot close the bracketed paste early", () => {
    const { text } = formatReviewComments([item({ path: "a\u001b[201~b.ts", lineText: "x\u001b[201~y\u0007" })], 16 * 1024);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)).toBe(false);
  });

  it("refuses to build a text above the byte limit", () => {
    expect(() => formatReviewComments([item({ body: "あ".repeat(400) })], 500)).toThrow(/too long/);
  });

  it("throws when there is nothing unsent", () => {
    expect(() => formatReviewComments([item({ sentAt: 1 })], 16 * 1024)).toThrow(/no unsent/);
  });
});
