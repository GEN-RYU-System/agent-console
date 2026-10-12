import type { DiffComment, DiffLine } from "../../types";

/** 行を押したときに付くコメントの側。追加行と文脈行は新しい側、削除行は古い側。 */
export function sideOfLine(line: DiffLine): "new" | "old" | null {
  if (line.kind === "add" || line.kind === "ctx") return "new";
  if (line.kind === "del") return "old";
  return null;
}

export function lineNumberOf(line: DiffLine, side: "new" | "old"): number | undefined {
  return side === "new" ? line.newLine : line.oldLine;
}

/** コメントがこの行に付いているか（文脈行は新旧どちらの番号でも当たる）。 */
export function commentMatchesLine(comment: DiffComment, line: DiffLine): boolean {
  if (comment.side === "new") return (line.kind === "add" || line.kind === "ctx") && line.newLine === comment.line;
  if (comment.side === "old") return (line.kind === "del" || line.kind === "ctx") && line.oldLine === comment.line;
  return false;
}

/** 保存したときの行の中身と、いま開いている行の中身が違うとき true（「ずれた可能性」）。保存時の中身が無ければ判定しない。 */
export function isStale(comment: DiffComment, line: DiffLine): boolean {
  return comment.lineText !== undefined && comment.lineText !== line.text;
}

/** 表示中の行のどれにも当たらない（行が変わって見えなくなった）行コメント。 */
export function orphanComments(comments: readonly DiffComment[], lines: readonly DiffLine[]): DiffComment[] {
  return comments.filter((c) => c.side !== "file" && !lines.some((l) => commentMatchesLine(c, l)));
}
