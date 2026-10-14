import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { classifyHasSession, commonArgs, paneTarget, sessionTarget, type HasSessionResult } from "./tmux-protocol.ts";
import type { TerminalLogger, TmuxContext } from "./types.ts";

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
/** tmux 1 回の命令の待ち上限（ms）。固まっても起動を止めない */
const SYNC_TIMEOUT_MS = 5000;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** tmux の場所を探す。設定の tmuxPath → PATH → /opt/homebrew/bin・/usr/local/bin の順。見つからなければ null */
export function findTmux(configured: string | undefined, pathEnv: string | undefined = process.env.PATH): string | null {
  if (configured !== undefined) return isExecutable(configured) ? configured : null;
  const dirs = [...(pathEnv ?? "").split(path.delimiter).filter((d) => d.length > 0), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, "tmux");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `tmux -V` の出力（ログ用）。実行できなければ null */
export function tmuxVersion(tmux: string): string | null {
  const r = spawnSync(tmux, ["-V"], { encoding: "utf8", timeout: SYNC_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** `tmux -V` の出力（例: "tmux 3.7c"、"tmux next-3.8"）が major.minor 以上か。読めない時は null */
export function tmuxVersionAtLeast(versionOutput: string | null, major: number, minor: number): boolean | null {
  const m = versionOutput === null ? null : /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return null;
  const maj = Number(m[1]);
  const min = Number(m[2]);
  return maj > major || (maj === major && min >= minor);
}

export interface SyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runTmuxSync(ctx: TmuxContext, args: string[], env: Record<string, string>): SyncResult {
  const r = spawnSync(ctx.tmux, [...commonArgs(ctx), ...args], { encoding: "utf8", env, timeout: SYNC_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export type Probe = { state: "alive"; pid: number } | { state: "gone" } | { state: "unreachable" };

/** 既に動いている tmux セッションの pane の pid を、同期で取る（つなぎ直しの前段） */
export function probeSession(ctx: TmuxContext, name: string, env: Record<string, string>): Probe {
  const r = runTmuxSync(ctx, ["display", "-p", "-t", paneTarget(name), "#{pane_pid}"], env);
  const kind: HasSessionResult = classifyHasSession(r.status, r.stderr);
  if (kind === "alive") {
    const pid = Number(r.stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? { state: "alive", pid } : { state: "unreachable" };
  }
  return { state: kind };
}

export interface NewSessionInput {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  command: string[];
  /** -e で渡す環境変数 */
  env: Record<string, string>;
}

/** tmux のセッションを作り、pane の pid を返す。失敗したら Error */
export function newSession(ctx: TmuxContext, input: NewSessionInput, baseEnv: Record<string, string>): number {
  const args = ["new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", input.name, "-x", String(input.cols), "-y", String(input.rows), "-c", input.cwd];
  for (const [k, v] of Object.entries(input.env)) args.push("-e", `${k}=${v}`);
  args.push("--", ...input.command);
  const r = runTmuxSync(ctx, args, baseEnv);
  const pid = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`tmux new-session failed (rc=${String(r.status)}): ${r.stderr.trim().slice(0, 300)}`);
  }
  return pid;
}

/** tmux サーバーが生きていれば設定を読み直し、`ac-*` のセッション名を返す。サーバーが無ければ [] */
export function startupSweep(ctx: TmuxContext, env: Record<string, string>, logger: TerminalLogger): string[] {
  const list = runTmuxSync(ctx, ["list-sessions", "-F", "#{session_name}"], env);
  if (list.status !== 0) return [];
  const src = runTmuxSync(ctx, ["source-file", ctx.conf], env);
  if (src.status !== 0) logger.warn(`tmux source-file failed: ${src.stderr.trim().slice(0, 200)}`);
  return list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("ac-"));
}

export { sessionTarget };
