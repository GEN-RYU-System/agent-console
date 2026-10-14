import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { findTmux } from "../../../server/terminal-host/tmux-runner.ts";

export const TMUX = findTmux(undefined);
/** CI では tmux が無ければ失敗にする。手元では skip し、理由をログに出す */
export const REQUIRE_TMUX = process.env.CI === "true" || process.env.CI === "1";
export const CONF = path.join(process.cwd(), "ops", "tmux", "agent-console.tmux.conf");

const sockets = new Set<string>();

/** 専用ソケット名（本番の agent-console・既定ソケットとは重ならない） */
export function testSocket(): string {
  const name = `ac-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  sockets.add(name);
  return name;
}

export const socketFile = (socket: string): string => path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket);

/** 試験が作った tmux サーバーを止め、ソケットのファイルも消す */
export function cleanupSockets(): void {
  for (const sock of sockets) {
    if (TMUX !== null) spawnSync(TMUX, ["-u", "-L", sock, "kill-server"], { stdio: "ignore" });
    rmSync(socketFile(sock), { force: true });
  }
  sockets.clear();
}

/** 専用ソケットに対する tmux 命令（試験の確認用） */
export function tmuxRun(socket: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(TMUX as string, ["-u", "-L", socket, "-f", CONF, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function processStart(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(done: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > end) return false;
    await sleep(stepMs);
  }
  return true;
}
