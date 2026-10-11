import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentStatus = "busy" | "waiting" | "idle" | "unknown";
export interface AgentRow {
  pid: number;
  status: AgentStatus;
  name?: string;
  sessionId?: string;
  cwd?: string;
  /** エポックミリ秒（`claude agents --json` の startedAt） */
  startedAt?: number;
}

export type SessionState = "working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

const KNOWN_STATUS: ReadonlySet<string> = new Set(["busy", "waiting", "idle"]);

/** `claude agents --json` の出力を解析。不正なら null（呼び出し側は前回値を保持する）。未知キーは捨てる。 */
export function parseAgentsOutput(raw: string): AgentRow[] | null {
  const cleaned = raw.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: AgentRow[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pid !== "number") continue;
    const status: AgentStatus = typeof r.status === "string" && KNOWN_STATUS.has(r.status) ? (r.status as AgentStatus) : "unknown";
    rows.push({
      pid: r.pid,
      status,
      name: typeof r.name === "string" ? r.name : undefined,
      sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
      cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      startedAt: typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : undefined,
    });
  }
  return rows;
}

export interface SessionProcessInfo {
  exited: boolean;
  pids: ReadonlySet<number>;
}

/** そのセッションの子孫プロセスに対応する Claude の行（無ければ undefined）。 */
export function agentForSession(session: SessionProcessInfo, rows: AgentRow[] | null): AgentRow | undefined {
  if (session.exited || rows === null) return undefined;
  return rows.find((r) => session.pids.has(r.pid));
}

export function stateForSession(session: SessionProcessInfo, rows: AgentRow[] | null): SessionState {
  if (session.exited) return "stopped";
  if (rows === null) return "unknown";
  const hit = agentForSession(session, rows);
  if (!hit) return "no-claude";
  if (hit.status === "busy") return "working";
  if (hit.status === "waiting") return "waiting";
  if (hit.status === "idle") return "idle";
  return "unknown";
}

/** パイプの子プロセスとして実行する（pty 経由だと CRLF/エスケープが混ざる: recon §A）。 */
export async function fetchAgents(claudeBin: string, all = false): Promise<AgentRow[] | null> {
  try {
    const args = all ? ["agents", "--all", "--json"] : ["agents", "--json"];
    const { stdout } = await execFileAsync(claudeBin, args, { maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    return parseAgentsOutput(stdout);
  } catch {
    return null;
  }
}

export async function fetchClaudeVersion(claudeBin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ["--version"], { timeout: 15000 });
    return stdout.trim();
  } catch {
    return "";
  }
}
