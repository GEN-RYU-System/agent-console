import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleConfig {
  id: string;
  labelKey: string;
  command: string[];
  needsWorktree: boolean;
}

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
  return { id: r.id, labelKey: r.labelKey, command: r.command as string[], needsWorktree: r.needsWorktree };
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
  for (const role of roles) {
    if (ids.has(role.id)) throw new Error(`config: duplicate role id ${role.id}`);
    ids.add(role.id);
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
