import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createAuth, DEV_PAIRING_TTL_MS, isAuthPersistEnabled } from "./auth.ts";
import { startActivity } from "./activity-start.ts";
import { fetchClaudeVersion } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { DiffCommentStore } from "./diff-comments.ts";
import { Hub } from "./hub.ts";
import { createRequestHandler } from "./http.ts";
import { MemoryCollector } from "./memory.ts";
import { setupPicker } from "./picker-extension.ts";
import { PickStore } from "./picks.ts";
import { UploadStore } from "./uploads.ts";
import { QuickPromptStore } from "./quick-prompts.ts";
import { restoreHeldFiles } from "./held-merge.ts";
import { OpenSessionRecorder, isRestoreEnabled, startOpenSessionRestore } from "./restore.ts";
import { OpenSessionStore } from "./session-store.ts";
import { RoutineApprovals } from "./routine-approvals.ts";
import { RoutineAudit } from "./routine-audit.ts";
import { CLOSE_IDLE_MS, KEEP_WAITING_MS, RoutineCloser, gapLimitMsFor } from "./routine-closer.ts";
import { RoutineService, RoutineStore } from "./routines.ts";
import { ReservationService, ReservationStore } from "./reservations.ts";
import { RelayManager, resolveRelayDir } from "./relay.ts";
import { setupReserveToken } from "./reserve-token.ts";
import { resolveSecret } from "./secret.ts";
import { SessionManager } from "./sessions.ts";
import { readSaSource } from "./tokens.ts";
import { attachWebSockets, SESSION_SWEEP_MS } from "./ws.ts";

const LISTEN_HOST = "127.0.0.1";
const execFileAsync = promisify(execFile);

function assertSpawnHelperExecutable(): void {
  const helper = path.join(process.cwd(), "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!existsSync(helper)) return;
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    console.error(`node-pty の spawn-helper に実行権がありません: ${helper}\n  npm run postinstall を実行してください。`);
    process.exit(1);
  }
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
}

async function readCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), timeout: 5000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  assertSpawnHelperExecutable();
  const config = loadConfig();
  const { token, mode } = await resolveSecret(process.env);
  const auth = createAuth(token, config.port, { sessionsFile: isAuthPersistEnabled(process.env) ? path.join(config.dataDir, "auth-sessions.json") : undefined });
  const sessions = new SessionManager(config);
  const hub = new Hub(config, sessions);
  const openSessions = new OpenSessionStore(config.dataDir);
  const recorder = new OpenSessionRecorder(sessions, hub, openSessions);
  const routines = new RoutineService(config, sessions, hub, new RoutineStore(config.dataDir));
  const reservations = new ReservationService(config, sessions, hub, new ReservationStore(config.dataDir));
  const relay = new RelayManager({ config, sessions, hub, relayDir: resolveRelayDir(config, process.env) });
  const meta = { saSource: await readSaSource(), claudeVersion: await fetchClaudeVersion(config.claudeBin), version: readVersion(), commit: await readCommit() };

  // 拡張の合言葉とフォルダの作り直しは、本番のポートで起動したときだけ（AGENT_CONSOLE_PORT があれば作らない）。作れなくてもサーバーは止めない
  const picker = await setupPicker({ env: process.env, dataDir: config.dataDir, port: config.port, sourceDir: path.join(process.cwd(), "extension") });
  const reserve = await setupReserveToken({ env: process.env, dataDir: config.dataDir, port: config.port });
  const picks = new PickStore(config.dataDir, config.pickMaxKeep);
  hub.watchPicks(picks);
  const activity = startActivity({ config, hub, env: process.env, hooksSourceDir: path.join(process.cwd(), "hooks") });
  const routineApprovals = new RoutineApprovals();
  const routineAudit = new RoutineAudit(config.dataDir);
  // closeWhenIdle の定期実行が開いたセッションを、idle が累計 10 分続いたら閉じる（標本は claude agents の定期取得）
  const closer = new RoutineCloser({
    session: (id) => { const s = sessions.get(id); return s === undefined ? undefined : { exited: s.exited, ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}) }; },
    lastReply: (cid) => { const last = activity.store.chat(cid).items.filter((c) => c.role === "assistant").at(-1); return last === undefined ? null : last.text; },
    runningCount: (cid) => activity.store.runningCount(cid),
    close: (id) => sessions.close(id),
    record: (routineId, event) => routines.recordClose(routineId, event),
    audit: (entry) => routineAudit.append({ at: new Date().toISOString(), ...entry }).catch((e) => console.error("routine-audit: write failed:", e instanceof Error ? e.message : e)),
  }, CLOSE_IDLE_MS, KEEP_WAITING_MS, gapLimitMsFor(config.agentsPollMs));
  routines.setCloser(closer);
  hub.onAgentsSampled((states, at) => { void activity.store.refresh().then(() => states, () => null).then((st) => closer.sample(st, at)).catch((e) => console.error("routine-closer: sample failed:", e instanceof Error ? e.message : e)); });
  const uploads = new UploadStore(config.dataDir, config.uploadMaxBytes, config.uploadMaxKeep);

  const server = createServer(createRequestHandler({ config, auth, sessions, hub, quickPrompts: new QuickPromptStore(config.dataDir), diffComments: new DiffCommentStore(config.dataDir), picks, uploads, picker, activity: activity.store, checkHooks: activity.check, memory: new MemoryCollector(), staticDir: path.join(process.cwd(), "dist"), meta, routines, reservations, relay, reserve, routineApprovals }));
  const controls = attachWebSockets(server, { config, auth, sessions, hub });
  // 期限切れ（12 時間）になったセッションの WebSocket を閉じる
  setInterval(() => controls.sweep(), SESSION_SWEEP_MS).unref();

  server.listen(config.port, LISTEN_HOST, () => {
    hub.start();
    // 切戻しで退避された保存リストと routine を、つなぎ直しと routine の読込より先に元へ戻す（復元が有効な本番のポートのみ）
    const heldRestored = isRestoreEnabled(process.env) ? restoreHeldFiles(config.dataDir) : Promise.resolve(0);
    void heldRestored.then(() => routines.start()).catch((err) => console.error("routines failed:", err));
    if (mode === "fixed") console.warn("agent-console: 警告: AGENT_CONSOLE_TOKEN で固定したトークンを使用中です（テスト用途のみ）");
    if (mode === "keychain") {
      // 本番（起動アプリ経由）。秘密・セッション・コードはログに出さない
      console.log(`agent-console: ${LISTEN_HOST}:${config.port} で待受中（キーチェーン認証）`);
    } else {
      // 開発時のみ: 1 回限り・5 分で失効するペアリング URL を出す（長期秘密は出さない）
      const code = auth.issuePairingCode(DEV_PAIRING_TTL_MS);
      console.log(`agent-console: http://${LISTEN_HOST}:${config.port}/pair?code=${code}`);
    }
    // 前回開いていたセッションを開き直す（失敗してもサーバーは止めない）
    const restored = heldRestored.then(() => startOpenSessionRestore(process.env, { config, sessions, hub, store: openSessions, recorder })).catch((err) => console.error("restore failed:", err));
    // 予約の時計は復元の完了を待ってから動かす（復元が先に席を取れるように）。復元の成否・無効に関わらず始まる
    void reservations.start(restored).catch((err) => console.error("reservations failed:", err));
  });

  const shutdown = (): void => {
    hub.stop();
    activity.stop();
    routines.stop();
    reservations.stop();
    // 停止で端末が終わっても、復元リストは書き換えない（再起動のあとに開き直すため）
    sessions.beginShutdown();
    sessions.killAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
