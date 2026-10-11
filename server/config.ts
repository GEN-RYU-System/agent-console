import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleConfig {
  id: string;
  labelKey: string;
  command: string[];
  needsWorktree: boolean;
  /** 再開用の起動コマンド（config 固定）。id なしの `--resume` で Claude 公式の会話選択リストが開く。画面の文字列はコマンドに入れない。 */
  resumeCommand?: string[];
  /** 再開できる作業場所: main=本店そのもの（Opus 設計役）/ worktree=本店のワークツリー（Sonnet 実装役）。resumeCommand と対で指定する。 */
  resumeScope?: ResumeScope;
}

export type ResumeScope = "main" | "worktree";
const RESUME_SCOPES: readonly string[] = ["main", "worktree"];

export interface NotifyConfig {
  /** 区切りの macOS 通知（既定 true） */
  macos: boolean;
  osascriptBin: string;
}

export const DEFAULT_OSASCRIPT_BIN = "/usr/bin/osascript";
export const DEFAULT_DATA_DIR = "~/Library/Application Support/agent-console";

export interface Config {
  port: number;
  salesanchorRoot: string;
  newWorktreeScript: string;
  ledgerLookupScript: string;
  ledgerDir: string;
  claudeBin: string;
  agentsPollMs: number;
  ledgerPollMs: number;
  ringBufferBytes: number;
  roles: RoleConfig[];
  /** よく使う指示などアプリが保存するデータの置き場 */
  dataDir: string;
  notify: NotifyConfig;
}

const STRING_KEYS = ["salesanchorRoot", "newWorktreeScript", "ledgerLookupScript", "ledgerDir", "claudeBin"] as const;
const NUMBER_KEYS = ["port", "agentsPollMs", "ledgerPollMs", "ringBufferBytes"] as const;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseRole(raw: unknown, index: number): RoleConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`config: roles[${index}] must be an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") throw new Error(`config: roles[${index}].id is required`);
  if (typeof r.labelKey !== "string" || r.labelKey === "") throw new Error(`config: roles[${index}].labelKey is required`);
  if (!Array.isArray(r.command) || r.command.length === 0 || !r.command.every((c) => typeof c === "string")) {
    throw new Error(`config: roles[${index}].command must be a non-empty string array`);
  }
  if (typeof r.needsWorktree !== "boolean") throw new Error(`config: roles[${index}].needsWorktree must be boolean`);
  const role: RoleConfig = { id: r.id, labelKey: r.labelKey, command: r.command as string[], needsWorktree: r.needsWorktree };
  if (r.resumeCommand === undefined) {
    if (r.resumeScope !== undefined) throw new Error(`config: roles[${index}].resumeScope requires resumeCommand`);
    return role;
  }
  if (!Array.isArray(r.resumeCommand) || r.resumeCommand.length === 0 || !r.resumeCommand.every((c) => typeof c === "string")) {
    throw new Error(`config: roles[${index}].resumeCommand must be a non-empty string array`);
  }
  if (r.resumeScope === undefined) return { ...role, resumeCommand: r.resumeCommand as string[] };
  if (typeof r.resumeScope !== "string" || !RESUME_SCOPES.includes(r.resumeScope)) {
    throw new Error(`config: roles[${index}].resumeScope must be "main" or "worktree"`);
  }
  return { ...role, resumeCommand: r.resumeCommand as string[], resumeScope: r.resumeScope as ResumeScope };
}

function parseNotify(raw: unknown): NotifyConfig {
  if (raw === undefined) return { macos: true, osascriptBin: DEFAULT_OSASCRIPT_BIN };
  if (typeof raw !== "object" || raw === null) throw new Error("config: notify must be an object");
  const n = raw as Record<string, unknown>;
  if (n.macos !== undefined && typeof n.macos !== "boolean") throw new Error("config: notify.macos must be boolean");
  if (n.osascriptBin !== undefined && (typeof n.osascriptBin !== "string" || n.osascriptBin === "")) {
    throw new Error("config: notify.osascriptBin must be a non-empty string");
  }
  return { macos: (n.macos as boolean | undefined) ?? true, osascriptBin: (n.osascriptBin as string | undefined) ?? DEFAULT_OSASCRIPT_BIN };
}

function parseDataDir(raw: unknown): string {
  if (raw === undefined) return expandHome(DEFAULT_DATA_DIR);
  if (typeof raw !== "string" || raw === "") throw new Error("config: dataDir must be a non-empty string");
  return expandHome(raw);
}

/** 設定の検証。必須キー欠落・型違いは起動中止（例外）にする。 */
export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) throw new Error("config: must be a JSON object");
  const o = raw as Record<string, unknown>;
  for (const key of STRING_KEYS) {
    if (typeof o[key] !== "string" || o[key] === "") throw new Error(`config: ${key} is required (string)`);
  }
  for (const key of NUMBER_KEYS) {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`config: ${key} is required (positive number)`);
  }
  if (!Array.isArray(o.roles) || o.roles.length === 0) throw new Error("config: roles is required (non-empty array)");
  const roles = o.roles.map(parseRole);
  const ids = new Set<string>();
  const scopes = new Set<string>();
  for (const role of roles) {
    if (ids.has(role.id)) throw new Error(`config: duplicate role id ${role.id}`);
    ids.add(role.id);
    if (role.resumeScope === undefined) continue;
    if (scopes.has(role.resumeScope)) throw new Error(`config: duplicate resumeScope ${role.resumeScope}`);
    scopes.add(role.resumeScope);
  }
  return {
    port: o.port as number,
    salesanchorRoot: expandHome(o.salesanchorRoot as string),
    newWorktreeScript: o.newWorktreeScript as string,
    ledgerLookupScript: o.ledgerLookupScript as string,
    ledgerDir: o.ledgerDir as string,
    claudeBin: o.claudeBin as string,
    agentsPollMs: o.agentsPollMs as number,
    ledgerPollMs: o.ledgerPollMs as number,
    ringBufferBytes: o.ringBufferBytes as number,
    roles,
    dataDir: parseDataDir(o.dataDir),
    notify: parseNotify(o.notify),
  };
}

export function defaultConfigPath(): string {
  return process.env.AGENT_CONSOLE_CONFIG ?? path.join(process.cwd(), "agent-console.config.json");
}

/** 自己診断（別ポートで起動確認）用に AGENT_CONSOLE_PORT でポートだけ上書きできる。 */
export function applyPortOverride(config: Config, raw: string | undefined): Config {
  if (raw === undefined || raw === "") return config;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_CONSOLE_PORT は 1〜65535 の整数にしてください");
  return { ...config, port };
}

export function loadConfig(file: string = defaultConfigPath()): Config {
  return applyPortOverride(parseConfig(JSON.parse(readFileSync(file, "utf8"))), process.env.AGENT_CONSOLE_PORT);
}
