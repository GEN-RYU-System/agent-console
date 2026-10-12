// 作戦ボードの読み出し。設計 docs/handoff/board/design.md §3-3。
// 正本は dataDir/boards/<Claude の会話の番号>.json（命令 hooks/ac-board.mjs が書く）。ここは読むだけで、ファイルは書き換えない。
// 検査・読み出しの関数は hooks/ac-board.mjs の 1 か所（命令と同じ検査で読む）。ビルドは dist-server/hooks/ へ写す（package.json の build）。
import { readBoard, type ReadResult } from "../hooks/ac-board.mjs";

export type BoardResult = ReadResult;

/** そのセッションのボード。claudeSessionId がまだ無いセッションは、ボードもまだ無い */
export function boardFor(dataDir: string, claudeSessionId: string | undefined): BoardResult {
  return claudeSessionId === undefined ? { status: "none" } : readBoard(dataDir, claudeSessionId);
}
