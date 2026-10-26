import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 偽の置き場: 本店の .git の中身を写し、worktrees を除いたもの。config に filter "evil"（clean が印を作る）、
 * info/attributes に `*.txt filter=evil` を書く。git の繋がりを書き換えられた作業場所がこれを読むと印ができる（ADR-1039 便2b-2 の試験用）。
 * 枝の ref を写しに入れるため、worktree add の後で呼ぶこと。
 */
export function makeFakeCommon(mainGit: string, into: string, mark: string): string {
  const fake = path.join(into, "fake-common");
  cpSync(mainGit, fake, { recursive: true, filter: (src) => path.relative(mainGit, src).split(path.sep)[0] !== "worktrees" });
  writeFileSync(path.join(fake, "config"), `${readFileSync(path.join(fake, "config"), "utf8")}[filter "evil"]\n\tclean = touch ${mark}; cat\n`);
  mkdirSync(path.join(fake, "info"), { recursive: true });
  writeFileSync(path.join(fake, "info", "attributes"), "*.txt filter=evil\n");
  return fake;
}

/** 本番の差分の表示と同じ上書き・引数（対照の実行用） */
export const OVERRIDDEN_DIFF_ARGS: readonly string[] = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
  "diff", "--merge-base", "origin/main", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--numstat", "-z",
];
