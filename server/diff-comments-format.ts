import { SessionInputError } from "./sessions.ts";
import type { DiffCommentItem } from "./diff-comments.ts";

const LINE_TEXT_CUT = 200;
const HEADER = "差分へのレビューコメントです。各コメントの行を確認して対応してください。";
// 括弧付き貼り付けを途中で閉じる ESC などを入れないため、本文以外の欄は制御文字を空白にする
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/g;

const clean = (s: string): string => s.replace(ANY_CONTROL, " ");

function block(c: DiffCommentItem): string {
  const lines = [`File: ${clean(c.path)}`];
  if (c.side === "file") {
    lines.push("Scope: ファイル全体");
  } else {
    lines.push(`Line: ${c.line ?? ""}（${c.side === "new" ? "新しい側" : "古い側"}）`);
    if (c.lineText !== undefined && c.lineText !== "") lines.push(`該当行: ${clean(c.lineText).slice(0, LINE_TEXT_CUT)}`);
  }
  lines.push(`Comment: ${c.body}`);
  return lines.join("\n");
}

/** 未送信のコメントを 1 つの文章にする。含めたコメントの id も返す（貼り付けが成功したあとの mark-sent に使う）。 */
export function formatReviewComments(items: readonly DiffCommentItem[], maxBytes: number): { text: string; ids: string[] } {
  const unsent = items.filter((c) => c.sentAt === undefined);
  if (unsent.length === 0) throw new SessionInputError("no unsent comments");
  const text = [HEADER, ...unsent.map(block)].join("\n\n");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new SessionInputError("comments are too long to send");
  return { text, ids: unsent.map((c) => c.id) };
}
