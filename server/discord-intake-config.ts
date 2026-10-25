import path from "node:path";
import { readJsonFile } from "./json-store.ts";

export type IntakeKind = "bug" | "error-report";

export interface IntakeChannelConfig {
  kind: IntakeKind;
  enabled: boolean;
  guildId: string;
  channelId: string;
  /** bug だけ必須（1件以上）。error-report は空でよい */
  allowedAuthors: { id: string; name: string }[];
  /** bug だけ必須（1件以上の 0 以上の整数） */
  allowedMessageTypes: number[];
  /** error-report だけ必須（ADR-1025 便4 で使う） */
  reportWebhookId?: string;
}

export interface IntakeConfig {
  testMode: boolean;
  forbiddenBotIds: string[];
  channels: IntakeChannelConfig[];
}

export const INTAKE_CONFIG_FILE = "discord-intake.config.json";

export type ConfigResult = { ok: true; config: IntakeConfig } | { ok: false; reason: "missing" } | { ok: false; reason: "invalid"; problem: string };

const ID = /^\d{1,20}$/;

class Invalid extends Error {}
const bad = (field: string): never => {
  throw new Invalid(field);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown, field: string): string => (typeof v === "string" && ID.test(v) ? v : bad(field));
function onlyKeys(o: Record<string, unknown>, allowed: string[], field: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(field);
}

function parseChannel(raw: unknown): IntakeChannelConfig {
  if (!isObject(raw)) return bad("channels");
  onlyKeys(raw, ["kind", "enabled", "guildId", "channelId", "allowedAuthors", "allowedMessageTypes", "reportWebhookId"], "channels");
  const kind = raw.kind;
  if (kind !== "bug" && kind !== "error-report") return bad("channels.kind");
  if (typeof raw.enabled !== "boolean") return bad("channels.enabled");
  const guildId = idOf(raw.guildId, "channels.guildId");
  const channelId = idOf(raw.channelId, "channels.channelId");
  const authorsRaw = raw.allowedAuthors ?? [];
  if (!Array.isArray(authorsRaw)) return bad("channels.allowedAuthors");
  const allowedAuthors = authorsRaw.map((a) => {
    if (!isObject(a)) return bad("channels.allowedAuthors");
    onlyKeys(a, ["id", "name"], "channels.allowedAuthors");
    if (typeof a.name !== "string") return bad("channels.allowedAuthors");
    return { id: idOf(a.id, "channels.allowedAuthors"), name: a.name };
  });
  const typesRaw = raw.allowedMessageTypes ?? [];
  if (!Array.isArray(typesRaw)) return bad("channels.allowedMessageTypes");
  const allowedMessageTypes = typesRaw.map((t) => (typeof t === "number" && Number.isInteger(t) && t >= 0 ? t : bad("channels.allowedMessageTypes")));
  if (kind === "bug") {
    if (allowedAuthors.length < 1) bad("channels.allowedAuthors");
    if (allowedMessageTypes.length < 1) bad("channels.allowedMessageTypes");
  }
  const out: IntakeChannelConfig = { kind, enabled: raw.enabled, guildId, channelId, allowedAuthors, allowedMessageTypes };
  if (kind === "error-report") out.reportWebhookId = idOf(raw.reportWebhookId, "channels.reportWebhookId");
  else if (raw.reportWebhookId !== undefined) bad("channels.reportWebhookId");
  return out;
}

function parseConfig(raw: unknown): IntakeConfig {
  if (!isObject(raw)) return bad("root");
  onlyKeys(raw, ["testMode", "forbiddenBotIds", "channels"], "root");
  if (typeof raw.testMode !== "boolean") return bad("testMode");
  if (!Array.isArray(raw.forbiddenBotIds) || raw.forbiddenBotIds.length < 1) return bad("forbiddenBotIds");
  const forbiddenBotIds = raw.forbiddenBotIds.map((v) => idOf(v, "forbiddenBotIds"));
  if (!Array.isArray(raw.channels)) return bad("channels");
  const channels = raw.channels.map(parseChannel);
  if (new Set(channels.map((c) => c.channelId)).size !== channels.length) bad("channels.channelId");
  if (new Set(channels.map((c) => c.kind)).size !== channels.length) bad("channels.kind");
  if (!raw.testMode && channels.some((c) => c.kind === "bug" && c.enabled)) bad("testMode");
  return { testMode: raw.testMode, forbiddenBotIds, channels };
}

/** dataDir/discord-intake.config.json を読む。壊れた JSON も invalid（problem には欄の名前だけで、値は入れない） */
export async function readIntakeConfig(dataDir: string): Promise<ConfigResult> {
  let raw: unknown;
  try {
    raw = await readJsonFile(path.join(dataDir, INTAKE_CONFIG_FILE));
  } catch {
    return { ok: false, reason: "invalid", problem: "json" };
  }
  if (raw === undefined) return { ok: false, reason: "missing" };
  try {
    return { ok: true, config: parseConfig(raw) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: "invalid", problem: e.message };
    throw e;
  }
}
