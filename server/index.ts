import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createAuth, DEV_PAIRING_TTL_MS } from "./auth.ts";
import { fetchClaudeVersion } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { Hub } from "./hub.ts";
import { createRequestHandler } from "./http.ts";
import { MemoryCollector } from "./memory.ts";
import { QuickPromptStore } from "./quick-prompts.ts";
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
  const auth = createAuth(token, config.port);
  const sessions = new SessionManager(config);
  const hub = new Hub(config, sessions);
  const meta = { saSource: await readSaSource(), claudeVersion: await fetchClaudeVersion(config.claudeBin), version: readVersion(), commit: await readCommit() };

  const server = createServer(createRequestHandler({ config, auth, sessions, hub, quickPrompts: new QuickPromptStore(config.dataDir), memory: new MemoryCollector(), staticDir: path.join(process.cwd(), "dist"), meta }));
  const controls = attachWebSockets(server, { config, auth, sessions, hub });
  // 期限切れ（12 時間）になったセッションの WebSocket を閉じる
  setInterval(() => controls.sweep(), SESSION_SWEEP_MS).unref();

  server.listen(config.port, LISTEN_HOST, () => {
    hub.start();
    if (mode === "fixed") console.warn("agent-console: 警告: AGENT_CONSOLE_TOKEN で固定したトークンを使用中です（テスト用途のみ）");
    if (mode === "keychain") {
      // 本番（起動アプリ経由）。秘密・セッション・コードはログに出さない
      console.log(`agent-console: ${LISTEN_HOST}:${config.port} で待受中（キーチェーン認証）`);
    } else {
      // 開発時のみ: 1 回限り・5 分で失効するペアリング URL を出す（長期秘密は出さない）
      const code = auth.issuePairingCode(DEV_PAIRING_TTL_MS);
      console.log(`agent-console: http://${LISTEN_HOST}:${config.port}/pair?code=${code}`);
    }
  });

  const shutdown = (): void => {
    hub.stop();
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
