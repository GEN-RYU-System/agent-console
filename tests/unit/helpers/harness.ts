import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../../../server/auth.ts";
import type { Config } from "../../../server/config.ts";
import { MemoryCollector } from "../../../server/memory.ts";
import { QuickPromptStore } from "../../../server/quick-prompts.ts";
import { Hub } from "../../../server/hub.ts";
import { createRequestHandler } from "../../../server/http.ts";
import { SessionManager } from "../../../server/sessions.ts";
import { attachWebSockets } from "../../../server/ws.ts";

export const TOKEN = "t".repeat(40);
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
  server: Server;
  secretPath: string;
  clock: Clock;
  /** 期限切れセッションの WebSocket を閉じる処理を、時計を進めた後に手動で実行する。 */
  sweep: () => void;
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
}

/** 実 HTTP/WS/PTY（ダミー役割 sh）を 127.0.0.1 の空きポートで起動する。 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-it-")));
  const root = path.join(dir, "root");
  const staticDir = path.join(dir, "static");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "ledger"), { recursive: true });
  mkdirSync(staticDir);
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
    ],
  };
  const sessions = new SessionManager(config, { maxSessions: options.maxSessions });
  const hub = new Hub(config, sessions, options.sendNotification ?? null);
  const clock: Clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const auth = createAuth(TOKEN, port, { now: () => clock.t });
  const server = createServer(
    createRequestHandler({ config, auth, sessions, hub, quickPrompts: new QuickPromptStore(config.dataDir), memory: new MemoryCollector(0), staticDir, meta: { saSource: "sha", claudeVersion: "v", version: "9.9.9", commit: COMMIT } }),
  );
  const controls = attachWebSockets(server, { config, auth, sessions, hub });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    dir,
    sessions,
    hub,
    server,
    secretPath,
    clock,
    sweep: () => controls.sweep(),
    close: async () => {
      sessions.killAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
