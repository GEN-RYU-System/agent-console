import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { classifyCwd, listWorktreeEntries, type ListWorktrees } from "./resume-targets.ts";
import { normalizeItem, type OpenSessionItem, type OpenSessionStore } from "./session-store.ts";
import type { SessionManager } from "./sessions.ts";
import type { WorktreeEntry } from "./worktree.ts";

const MAX_NAME_LENGTH = 40;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 開き直せなかった理由。文言は画面側（i18n）が持つ。name は保存してあったセッション名（unreadable には無い）。 */
export type RestoreNoticeReason = "missingCwd" | "unknownRole" | "startFailed" | "overLimit" | "unreadable";
export interface RestoreNotice {
  reason: RestoreNoticeReason;
  name?: string;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 保存する名前: Claude 側の名前は制御文字を除き 40 字までにそろえる（空になればアプリ側の名前）。 */
function storableName(preferred: string | undefined, fallback: string): string {
  const cleaned = (preferred ?? "").replace(CONTROL_CHARS, "").trim().slice(0, MAX_NAME_LENGTH).trim();
  return cleaned === "" ? fallback : cleaned;
}

/**
 * 復元リストを「今開いている（止まっていない）セッション」の写しとして保つ。
 * 正本は SessionManager。作成・閉じる・自然終了・名前の変更・sessionId を知ったとき、のたびに作り直して保存する。
 * サーバー停止中（beginShutdown 後）と、起動時の復元中（hold）は書き換えない。
 */
export class OpenSessionRecorder {
  private started = false;
  private held = false;

  constructor(
    private readonly sessions: SessionManager,
    private readonly hub: Hub,
    private readonly store: OpenSessionStore,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sessions.onChange(() => void this.sync());
    // Claude 側の名前の変更も写しに反映する
    this.hub.onDisplayNameChanged(() => void this.sync());
  }

  /** 復元の途中の写しで、まだ開いていない項目をリストから消さないよう、書込を止める。 */
  hold(): void {
    this.held = true;
  }

  async release(): Promise<void> {
    this.held = false;
    await this.sync();
  }

  private canWrite(): boolean {
    return this.started && !this.held && !this.sessions.isShuttingDown();
  }

  /** 失敗しても呼び出し元を止めない（壊れたファイルは上書きせず、ログに出す）。 */
  async sync(): Promise<void> {
    if (!this.canWrite()) return;
    try {
      const snap = await this.hub.snapshot();
      // 待っている間に停止が始まった・復元が始まった場合は書かない
      if (!this.canWrite()) return;
      const names = new Map(snap.sessions.map((v) => [v.id, v.name]));
      const items: OpenSessionItem[] = this.sessions
        .list()
        .filter((s) => !s.exited)
        .map((s) =>
          normalizeItem({
            roleId: s.roleId,
            name: storableName(names.get(s.id), s.name),
            cwd: s.cwd,
            ...(s.branch !== null ? { branch: s.branch } : {}),
            ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),
          }),
        );
      await this.store.save(items);
    } catch (err) {
      console.error("open-sessions: save failed:", err instanceof Error ? err.message : err);
    }
  }
}

export interface RestoreDeps {
  config: Config;
  sessions: SessionManager;
  hub: Hub;
  store: OpenSessionStore;
  recorder: OpenSessionRecorder;
  listWorktrees?: ListWorktrees;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 起動時の復元。リストの各項目を、作業場所（本店かその時点の worktree）を確かめたうえで、restoreStaggerMs の間隔で 1 件ずつ開き直す。
 * 開き直せなかった項目は外し、理由を hub に載せる（画面の案内）。読めないリストは上書きせず、案内だけ出す。
 */
export async function restoreOnStartup(deps: RestoreDeps): Promise<RestoreNotice[]> {
  const { config, sessions, hub, store, recorder } = deps;
  const sleep = deps.sleep ?? sleepMs;
  const listWorktrees = deps.listWorktrees ?? listWorktreeEntries;
  recorder.hold();
  const notices: RestoreNotice[] = [];
  try {
    let items: OpenSessionItem[];
    try {
      items = await store.load();
    } catch (err) {
      console.error("open-sessions: cannot read the restore list:", err instanceof Error ? err.message : err);
      notices.push({ reason: "unreadable" });
      return notices;
    }
    const entries = await listWorktrees(config.salesanchorRoot).catch(() => [] as WorktreeEntry[]);
    const worktrees = entries.map((e) => e.path);
    let launched = 0;
    for (const item of items) {
      const role = config.roles.find((r) => r.id === item.roleId);
      if (!role) {
        notices.push({ reason: "unknownRole", name: item.name });
        continue;
      }
      const verdict = await classifyCwd(item.cwd, config.salesanchorRoot, worktrees);
      if (verdict.real === null || verdict.block !== null) {
        notices.push({ reason: "missingCwd", name: item.name });
        continue;
      }
      if (!sessions.hasCapacity()) {
        notices.push({ reason: "overLimit", name: item.name });
        continue;
      }
      if (launched > 0) await sleep(config.restoreStaggerMs);
      try {
        sessions.restore({ role, name: item.name, cwd: verdict.real, branch: item.branch ?? null, claudeSessionId: item.claudeSessionId });
        launched += 1;
      } catch (err) {
        console.error("open-sessions: restore failed:", err instanceof Error ? err.message : err);
        notices.push({ reason: "startFailed", name: item.name });
      }
    }
    return notices;
  } finally {
    hub.setRestoreNotices(notices);
    await recorder.release();
  }
}

/**
 * 復元と記録が有効なのは「AGENT_CONSOLE_RESTORE が "off" でなく（完全一致のときだけ無効）、かつ AGENT_CONSOLE_PORT が未設定（空文字も未設定扱い）」のときだけ。
 * ポートを上書きして起動したサーバー（自己診断・試験・検証用）は、本番と同じ dataDir を読んでも復元も記録もしない。本番の LaunchAgent は AGENT_CONSOLE_PORT を使わない。
 */
export const isRestoreEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.AGENT_CONSOLE_RESTORE !== "off" && (env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === "");

/**
 * 起動時の復元と記録をまとめて始める（index.ts から呼ぶ）。無効のときは復元リストを読み書きしない（null を返す）。
 */
export async function startOpenSessionRestore(env: Readonly<Record<string, string | undefined>>, deps: RestoreDeps): Promise<RestoreNotice[] | null> {
  if (!isRestoreEnabled(env)) return null;
  deps.recorder.start();
  return restoreOnStartup(deps);
}
