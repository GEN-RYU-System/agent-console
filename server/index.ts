import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createAuth } from "./auth.ts";
import { fetchClaudeVersion } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { Hub } from "./hub.ts";
import { createRequestHandler } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { readSaSource } from "./tokens.ts";
import { attachWebSockets } from "./ws.ts";

const LISTEN_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;
const MIN_FIXED_TOKEN_LENGTH = 32;

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

/** 通常は起動ごとにランダム生成。e2e 用に AGENT_CONSOLE_TOKEN（32 文字以上）で固定できる。 */
function resolveToken(): string {
  const fixed = process.env.AGENT_CONSOLE_TOKEN;
  if (fixed === undefined || fixed === "") return randomBytes(TOKEN_BYTES).toString("hex");
  if (fixed.length < MIN_FIXED_TOKEN_LENGTH) throw new Error(`AGENT_CONSOLE_TOKEN は ${MIN_FIXED_TOKEN_LENGTH} 文字以上にしてください`);
  return fixed;
}

async function main(): Promise<void> {
  assertSpawnHelperExecutable();
  const config = loadConfig();
  const token = resolveToken();
  const auth = createAuth(token, config.port);
  const sessions = new SessionManager(config);
  const hub = new Hub(config, sessions);
  const meta = { saSource: await readSaSource(), claudeVersion: await fetchClaudeVersion(config.claudeBin) };

  const server = createServer(createRequestHandler({ config, auth, sessions, hub, staticDir: path.join(process.cwd(), "dist"), meta }));
  attachWebSockets(server, { config, auth, sessions, hub });

  server.listen(config.port, LISTEN_HOST, () => {
    hub.start();
    console.log(`agent-console: http://${LISTEN_HOST}:${config.port}/?t=${token}`);
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
