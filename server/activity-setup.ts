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

/**
 * リポジトリの hooks/activity-hook.mjs（正本）を dataDir/hooks/ へ写す。入れ替えは一時ファイル→rename。
 * 書き込み中の Claude の hook が、半分だけ写ったファイルを読むことがない。
 */
export function installHookFile(sourceDir: string, dataDir: string): string {
  const dest = hookPathIn(dataDir);
  const dir = path.dirname(dest);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    copyFileSync(path.join(sourceDir, HOOK_FILE_NAME), tmp);
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return dest;
}
