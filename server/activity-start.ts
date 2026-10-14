import path from "node:path";
import { ActivityStore } from "./activity.ts";
import { checkHooks, type HookCheck } from "./activity-hooks.ts";
import { hookPathIn, installBoardCommand, installHookFile, installReserveCommand, installStatuslineCommand, isActivitySetupEnabled } from "./activity-setup.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { startPolling } from "./poll.ts";

/** 新しい記録を取り込む間隔（ms）。画面への合図（WebSocket）はこの周期で出る */
export const ACTIVITY_POLL_MS = 2000;
/** 古い記録の掃除と、記録の仕組みの点検（ログ）の間隔 */
export const ACTIVITY_HOUSEKEEPING_MS = 60 * 60 * 1000;

export interface ActivityRuntime {
  store: ActivityStore;
  /** 設定ファイルを読むだけ（API を呼ぶたびに使う） */
  check: () => HookCheck;
  stop: () => void;
}

export interface StartOptions {
  config: Config;
  hub: Hub;
  env: Readonly<Record<string, string | undefined>>;
  /** リポジトリの hooks/（hook の本体の正本） */
  hooksSourceDir: string;
}

/**
 * セッションの様子の記録を使えるようにする。
 * 本番のポートで起動したときだけ（AGENT_CONSOLE_PORT を上書きした自己診断・試験では行わない）:
 *   hook の本体を dataDir/hooks/ へ、作戦ボードの命令・利用量の命令を dataDir/bin/ へ写す／起動のときと 1 時間ごとに、activityKeepDays より古い記録を消し、記録の仕組みを点検して外れていればログに出す。
 * 写せなくてもサーバーは止めない。
 */
export function startActivity(opts: StartOptions): ActivityRuntime {
  const { config, hub } = opts;
  const store = new ActivityStore(config.dataDir, { keepDays: config.activityKeepDays });
  hub.watchActivity(store);
  const check = (): HookCheck => checkHooks({ settingsPath: config.claudeSettingsPath, hookPath: hookPathIn(config.dataDir) });
  const stoppers = [startPolling(async () => void (await store.refresh()), ACTIVITY_POLL_MS, (err) => console.error("poll(activity) failed:", err instanceof Error ? err.message : err))];

  if (isActivitySetupEnabled(opts.env)) {
    try {
      installHookFile(opts.hooksSourceDir, config.dataDir);
    } catch (err) {
      console.error("activity: cannot place the hook file:", err instanceof Error ? err.message : err);
    }
    try {
      installBoardCommand(opts.hooksSourceDir, config.dataDir);
    } catch (err) {
      console.error("activity: cannot place the board command:", err instanceof Error ? err.message : err);
    }
    try {
      installReserveCommand(opts.hooksSourceDir, config.dataDir);
    } catch (err) {
      console.error("activity: cannot place the reserve command:", err instanceof Error ? err.message : err);
    }
    try {
      installStatuslineCommand(opts.hooksSourceDir, config.dataDir);
    } catch (err) {
      console.error("activity: cannot place the statusline command:", err instanceof Error ? err.message : err);
    }
    stoppers.push(
      startPolling(
        async () => {
          const removed = await store.pruneOldFiles();
          if (removed.length > 0) console.log(`activity: removed ${removed.length} old event file(s)`);
          const result = check();
          if (!result.ok) console.warn(`activity: 記録の仕組みが外れています（${result.reason ?? "unknown"}）。README の手順で node ${path.join("scripts", "ac-hooks.mjs")} install を実行してください`);
        },
        ACTIVITY_HOUSEKEEPING_MS,
        (err) => console.error("housekeeping(activity) failed:", err instanceof Error ? err.message : err),
      ),
    );
  }
  return { store, check, stop: () => stoppers.forEach((stop) => stop()) };
}
