// 記録用 hook の本体の置き場所と、サーバー起動時の後始末。設計 §3-1。
// scripts/ac-hooks.mjs（install）もこのファイルを node の型除去で直接読むため、型の注釈だけで書く。
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export const HOOK_FILE_NAME = "activity-hook.mjs";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** dataDir/hooks/activity-hook.mjs（設定に書く hook のパス） */
export const hookPathIn = (dataDir: string): string => path.join(dataDir, "hooks", HOOK_FILE_NAME);

/** 本番のポートで起動したときだけ、写す・古いファイルを消す（AGENT_CONSOLE_PORT を上書きした自己診断・試験の起動では行わない） */
export const isActivitySetupEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === "";

export const BOARD_COMMAND_FILE_NAME = "ac-board.mjs";

/** dataDir/bin/ac-board.mjs（Claude の Bash が打つ、作戦ボードの命令） */
export const boardCommandPathIn = (dataDir: string): string => path.join(dataDir, "bin", BOARD_COMMAND_FILE_NAME);

/** sourceDir/<name>（正本）を dest へ写す。入れ替えは一時ファイル→rename。書き込み中の読み手が、半分だけ写ったファイルを読むことがない */
function copyAtomically(sourceDir: string, name: string, dest: string): string {
  mkdirSync(path.dirname(dest), { recursive: true, mode: DIR_MODE });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    copyFileSync(path.join(sourceDir, name), tmp);
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** リポジトリの hooks/activity-hook.mjs（正本）を dataDir/hooks/ へ写す */
export function installHookFile(sourceDir: string, dataDir: string): string {
  return copyAtomically(sourceDir, HOOK_FILE_NAME, hookPathIn(dataDir));
}

/** リポジトリの hooks/ac-board.mjs（正本）を dataDir/bin/ へ写す（hook を写す関数と同じ作法） */
export function installBoardCommand(sourceDir: string, dataDir: string): string {
  return copyAtomically(sourceDir, BOARD_COMMAND_FILE_NAME, boardCommandPathIn(dataDir));
}
