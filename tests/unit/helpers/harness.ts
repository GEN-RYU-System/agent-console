import { RelayManager, defaultRelayTiming, type RelayTiming } from "../../../server/relay.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAuth, type Auth } from "../../../server/auth.ts";
import { DEFAULT_DIFF_MAX_FILE_BYTES, DEFAULT_GH_BIN, DEFAULT_PR_POLL_MS, DEFAULT_PR_REFRESH_MIN_MS, DEFAULT_PICK_HTML_IN_PROMPT_CHARS, DEFAULT_PICK_MAX_KEEP, DEFAULT_PICK_SEND_MAX_BYTES, DEFAULT_DIFF_SEND_MAX_BYTES, DEFAULT_TERMINAL_SMOOTH_SCROLL_MS, DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_KEEP, DEFAULT_PASTE_SUBMIT_DELAY_MS, DEFAULT_ACTIVITY_KEEP_DAYS, type Config } from "../../../server/config.ts";
import { ActivityStore } from "../../../server/activity.ts";
import { checkHooks } from "../../../server/activity-hooks.ts";
import { hookPathIn } from "../../../server/activity-setup.ts";
import { MemoryCollector } from "../../../server/memory.ts";
import { PickStore } from "../../../server/picks.ts";
import { UploadStore } from "../../../server/uploads.ts";
import type { PickerAccess } from "../../../server/picker-extension.ts";
import { QuickPromptStore } from "../../../server/quick-prompts.ts";
import { DiffCommentStore } from "../../../server/diff-comments.ts";
import { Hub } from "../../../server/hub.ts";
import { createRequestHandler } from "../../../server/http.ts";
import { OpenSessionStore } from "../../../server/session-store.ts";
import { OpenSessionRecorder } from "../../../server/restore.ts";
import { RoutineApprovals } from "../../../server/routine-approvals.ts";
import { RoutineService, RoutineStore } from "../../../server/routines.ts";
import { ReservationService, ReservationStore } from "../../../server/reservations.ts";
import type { ReserveAccess } from "../../../server/reserve-token.ts";
import type { RoleConfig } from "../../../server/config.ts";
import { SessionManager } from "../../../server/sessions.ts";
import { attachWebSockets } from "../../../server/ws.ts";

export const TOKEN = "t".repeat(40);
export const PICKER_ORIGIN = "chrome-extension://cifnedlggndeehoejlfapbhepekgikao";
export const PICKER_TOKEN = "ab".repeat(32);
export const RESERVE_TOKEN = "cd".repeat(32);
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export interface Clock {
  t: number;
  advance(ms: number): void;
}

export interface Harness {
  port: number;
  base: string;
  dir: string;
  sessions: SessionManager;
  hub: Hub;
  store: OpenSessionStore;
  recorder: OpenSessionRecorder;
  config: Config;
  server: Server;
  secretPath: string;
  clock: Clock;
  /** 期限切れセッションの WebSocket を閉じる処理を、時計を進めた後に手動で実行する。 */
  sweep: () => void;
  picks: PickStore;
  activity: ActivityStore;
  uploads: UploadStore;
  auth: Auth;
  reservations: ReservationService;
  relay: RelayManager;
  routines: RoutineService;
  /** ac-routine の一時承認の保管（時刻は clock） */
  routineApprovals: RoutineApprovals;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface HarnessOptions {
  /** 指定すると、そのポートで待ち受ける（launchctl kickstart による起動の再現用）。 */
  port?: number;
  /** 引き継ぎ書の置き場。未指定なら引き継ぎは使えない（409 relay not configured） */
  relayDir?: string;
  /** 引き継ぎの待ち時間（試験用） */
  relayTiming?: Partial<RelayTiming>;
  ledgerScript?: string;
  maxSessions?: number;
  /** claude 役のスタブ（`agents --json` の出力を返す）。既定は存在しないパス */
  claudeBin?: string;
  /** 区切りの通知の送信先（既定は送らない） */
  sendNotification?: (body: string) => void;
  /** 再開用の起動コマンド（指定すると role "resumable" が増える） */
  resumeCommand?: string[];
  /** 本店そのもの（Opus 設計役）を再開する起動コマンド（指定すると role "resumable-main" が増える） */
  mainResumeCommand?: string[];
  /** 端末の子へ重ねる環境（既定は LANG のみ） */
  terminalEnv?: Record<string, string>;
  /** 復元リストへの書き込みを有効にする（既定は無効。復元の試験だけ有効にする） */
  recorder?: boolean;
  /** 起動の間隔（ms）。既定 0 */
  restoreStaggerMs?: number;
  /** 閉じるときに SIGKILL へ切り替えるまでの時間（ms）。既定は本番値 */
  closeGraceMs?: number;
  /** アカウント切り替えの命令（指定すると config.accountLoginCommand が入る） */
  accountLoginCommand?: string[];
  /** 試験用に足す役割 */
  extraRoles?: RoleConfig[];
  /** 1 ファイルの変更の表示上限（byte）。既定は config の既定値 */
  diffMaxFileBytes?: number;
  /** 送る文章の上限（byte）。既定は config の既定値 */
  diffSendMaxBytes?: number;
  /** gh の置き場（既定 "gh"）。PR の試験は偽 gh を指す */
  ghBin?: string;
  /** 「更新」を受け付ける最小の間隔（ms）。既定は config の既定値 */
  prRefreshMinMs?: number;
  /** gh 1 回の時間切れ（ms）。既定は本番値 */
  ghTimeoutMs?: number;
  /** 部品を残す件数・送る文章の上限（byte）・依頼文に入れる HTML の字数。既定は config の既定値 */
  pickMaxKeep?: number;
  pickSendMaxBytes?: number;
  pickHtmlInPromptChars?: number;
  /** 画像の上限（byte）・残す枚数・なめらかなスクロールの時間（ms）。既定は config の既定値 */
  uploadMaxBytes?: number;
  uploadMaxKeep?: number;
  terminalSmoothScrollMs?: number;
  /** 貼ってから Enter を送るまでの待ち（ms）。既定は config の既定値 */
  pasteSubmitDelayMs?: number;
  /** 端末の置き場（既定 direct。tmux の試験だけ指定する）と専用ソケット名 */
  terminalHost?: "tmux" | "direct";
  tmuxSocket?: string;
  tmuxPath?: string;
  /** 既存の dataDir を使う（再起動の再現用。指定した場合は close で消さない前提で、同じ dir を引き継ぐ） */
  dir?: string;
  /** 拡張からの受け取り口の相手。既定は固定 id の拡張と試験用の合言葉。null にすると受け取り口は常に 403 */
  picker?: PickerAccess;
  /** AI 用の予約の合言葉。既定は試験用の合言葉。token を null にすると AI 用の口は常に 401 */
  reserve?: ReserveAccess;
  /** ac-routine を使ってよい役割 id（既定は "echo" だけ。試験の「管理職」役） */
  routineManagerRoles?: string[];
  /** ログインの記録を dataDir の auth-sessions.json に残す（既定は残さない＝AGENT_CONSOLE_PORT 指定時の本番と同じ。再起動の試験だけ true） */
  persistSessions?: boolean;
  /** サーバーの秘密（既定は TOKEN）。Bearer の試験は TOKEN のままで、変わった秘密の試験だけ指定する */
  secret?: string;
}

/** 実 HTTP/WS/PTY（ダミー役割 sh）を 127.0.0.1 の空きポートで起動する。 */
/** terminalHost "tmux" ではソケット名の指定を必須にする（既定で本番ソケット agent-console に落ちる経路を塞ぐ） */
function tmuxSocketFor(host: "tmux" | "direct", socket: string | undefined): { tmuxSocket?: string } {
  if (host === "tmux" && socket === undefined) throw new Error('startHarness: terminalHost "tmux" requires tmuxSocket (never default to the production socket)');
  return socket !== undefined ? { tmuxSocket: socket } : {};
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = options.dir ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-it-")));
  const root = path.join(dir, "root");
  const staticDir = path.join(dir, "static");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "ledger"), { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  mkdirSync(path.join(dir, "home", ".claude"), { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<html>index</html>");
  const secretPath = path.join(dir, "secret.txt");
  writeFileSync(secretPath, "TOP-SECRET");
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "scripts", "slow-worktree.sh"), "#!/bin/bash\nsleep 0.3\n");
  chmodSync(path.join(root, "scripts", "slow-worktree.sh"), 0o755);
  if (options.ledgerScript !== undefined) {
    writeFileSync(path.join(root, "scripts", "ledger.sh"), options.ledgerScript);
    chmodSync(path.join(root, "scripts", "ledger.sh"), 0o755);
  }
  const port = options.port ?? (await freePort());
  const config: Config = {
    port,
    salesanchorRoot: root,
    newWorktreeScript: "scripts/slow-worktree.sh",
    ledgerLookupScript: "scripts/ledger.sh",
    ledgerDir: "ledger",
    claudeBin: options.claudeBin ?? "/nonexistent/claude",
    agentsPollMs: 60000,
    ledgerPollMs: 60000,
    ringBufferBytes: 1024 * 1024,
    dataDir: path.join(dir, "data"),
    notify: { macos: false, osascriptBin: "/nonexistent/osascript" },
    terminalEnv: options.terminalEnv ?? { LANG: "ja_JP.UTF-8" },
    restoreStaggerMs: options.restoreStaggerMs ?? 0,
    ...(options.terminalHost !== undefined ? { terminalHost: options.terminalHost, ...tmuxSocketFor(options.terminalHost, options.tmuxSocket), ...(options.tmuxPath !== undefined ? { tmuxPath: options.tmuxPath } : {}) } : {}),
    diffBaseRef: "origin/main",
    diffMaxFileBytes: options.diffMaxFileBytes ?? DEFAULT_DIFF_MAX_FILE_BYTES,
    diffSendMaxBytes: options.diffSendMaxBytes ?? DEFAULT_DIFF_SEND_MAX_BYTES,
    pasteSubmitDelayMs: options.pasteSubmitDelayMs ?? DEFAULT_PASTE_SUBMIT_DELAY_MS,
    ghBin: options.ghBin ?? DEFAULT_GH_BIN,
    prPollMs: DEFAULT_PR_POLL_MS,
    metricsPollMs: 60000,
    prRefreshMinMs: options.prRefreshMinMs ?? DEFAULT_PR_REFRESH_MIN_MS,
    pickMaxKeep: options.pickMaxKeep ?? DEFAULT_PICK_MAX_KEEP,
    pickSendMaxBytes: options.pickSendMaxBytes ?? DEFAULT_PICK_SEND_MAX_BYTES,
    pickHtmlInPromptChars: options.pickHtmlInPromptChars ?? DEFAULT_PICK_HTML_IN_PROMPT_CHARS,
    activityKeepDays: DEFAULT_ACTIVITY_KEEP_DAYS,
    claudeSettingsPath: path.join(dir, "home", ".claude", "settings.json"),
    terminalSmoothScrollMs: options.terminalSmoothScrollMs ?? DEFAULT_TERMINAL_SMOOTH_SCROLL_MS,
    terminalRenderer: "dom",
    uploadMaxBytes: options.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    uploadMaxKeep: options.uploadMaxKeep ?? DEFAULT_UPLOAD_MAX_KEEP,
    routineManagerRoles: options.routineManagerRoles ?? ["echo"],
    ...(options.accountLoginCommand !== undefined ? { accountLoginCommand: options.accountLoginCommand } : {}),
    roles: [
      { id: "echo", labelKey: "role.shell", command: ["/bin/sh", "-c", "echo READY; cat"], needsWorktree: false },
      { id: "short", labelKey: "role.shell", command: ["/bin/sh", "-c", "echo bye"], needsWorktree: false },
      { id: "envcheck", labelKey: "role.shell", command: ["/bin/sh", "-c", "echo TOKEN_IS=[$AGENT_CONSOLE_TOKEN]; cat"], needsWorktree: false },
      { id: "langcheck", labelKey: "role.shell", command: ["/bin/sh", "-c", "printf 'LANG_IS=[%s]\\n' \"$LANG\"; cat"], needsWorktree: false },
      { id: "wt", labelKey: "role.sonnetImpl", command: ["/bin/sh", "-c", "cat"], needsWorktree: true },
      ...(options.resumeCommand
        ? [{ id: "resumable", labelKey: "role.sonnetImpl", command: ["/bin/sh", "-c", "cat"], needsWorktree: false, resumeCommand: options.resumeCommand, resumeScope: "worktree" as const }]
        : []),
      ...(options.mainResumeCommand
        ? [{ id: "resumable-main", labelKey: "role.opusDesigner", command: ["/bin/sh", "-c", "cat"], needsWorktree: false, resumeCommand: options.mainResumeCommand, resumeScope: "main" as const }]
        : []),
      ...(options.extraRoles ?? []),
    ],
  };
  const sessions = new SessionManager(config, { maxSessions: options.maxSessions, closeGraceMs: options.closeGraceMs });
  const hub = new Hub(config, sessions, options.sendNotification ?? null, { ghTimeoutMs: options.ghTimeoutMs });
  const store = new OpenSessionStore(config.dataDir);
  const recorder = new OpenSessionRecorder(sessions, hub, store);
  const routines = new RoutineService(config, sessions, hub, new RoutineStore(config.dataDir));
  const reservations = new ReservationService(config, sessions, hub, new ReservationStore(config.dataDir), undefined, undefined, true);
  const relay = new RelayManager({ config, sessions, hub, relayDir: options.relayDir ?? null }, undefined, { ...defaultRelayTiming(config), ...options.relayTiming });
  if (options.recorder === true) recorder.start();
  const clock: Clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const auth = createAuth(options.secret ?? TOKEN, port, { now: () => clock.t, sessionsFile: options.persistSessions === true ? path.join(config.dataDir, "auth-sessions.json") : undefined });
  const picks = new PickStore(config.dataDir, config.pickMaxKeep);
  hub.watchPicks(picks);
  const activity = new ActivityStore(config.dataDir, { keepDays: config.activityKeepDays });
  hub.watchActivity(activity);
  const uploads = new UploadStore(config.dataDir, config.uploadMaxBytes, config.uploadMaxKeep);
  const picker: PickerAccess = options.picker ?? { extensionOrigin: PICKER_ORIGIN, token: PICKER_TOKEN, extensionDir: path.join(config.dataDir, "chrome-extension") };
  const reserve: ReserveAccess = options.reserve ?? { token: RESERVE_TOKEN };
  const routineApprovals = new RoutineApprovals(() => clock.t);
  const server = createServer(
    createRequestHandler({ config, auth, sessions, hub, quickPrompts: new QuickPromptStore(config.dataDir), diffComments: new DiffCommentStore(config.dataDir), picks, uploads, picker, activity, checkHooks: () => checkHooks({ settingsPath: config.claudeSettingsPath, hookPath: hookPathIn(config.dataDir) }), memory: new MemoryCollector(0), staticDir, meta: { saSource: "sha", claudeVersion: "v", version: "9.9.9", commit: COMMIT }, routines, reservations, relay, reserve, routineApprovals }),
  );
  const controls = attachWebSockets(server, { config, auth, sessions, hub });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    dir,
    sessions,
    hub,
    store,
    recorder,
    config,
    server,
    secretPath,
    clock,
    sweep: () => controls.sweep(),
    picks,
    activity,
    uploads,
    auth,
    reservations,
    relay,
    routines,
    routineApprovals,
    close: async () => {
      sessions.killAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
