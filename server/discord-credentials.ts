import { readKeychainItem } from "./keychain.ts";

/** Discord への通信の行き先はここだけ（コードの定数。設定・台本で変えられない） */
export const DISCORD_HOST = "discord.com";
export const DISCORD_API_BASE = "https://discord.com/api/v10";

// 秘密の形の決まりの正本（登録の台本は形を判定しない）
const WEBHOOK_URL = /^https:\/\/discord\.com\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,200}$/;
const BOT_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;

export function isValidBotToken(v: string): boolean {
  return BOT_TOKEN.test(v);
}

export function isValidWebhookUrl(v: string): boolean {
  return WEBHOOK_URL.test(v);
}

export type CredentialState = "ok" | "unreadable" | "invalid";

export interface DiscordCredentials {
  botToken: string | null;
  webhookUrl: string | null;
  state: { bot: CredentialState; webhook: CredentialState };
}

async function load(read: typeof readKeychainItem, securityBin: string, account: "discord-bot" | "discord-report-webhook", valid: (v: string) => boolean): Promise<{ value: string | null; state: CredentialState }> {
  let raw: string;
  try {
    raw = await read(securityBin, account);
  } catch {
    return { value: null, state: "unreadable" };
  }
  return valid(raw) ? { value: raw, state: "ok" } : { value: null, state: "invalid" };
}

/** 2つの秘密を読む。値は返り値の外（ログ・例外の文）に出さない */
export async function loadDiscordCredentials(securityBin: string, read: typeof readKeychainItem = readKeychainItem): Promise<DiscordCredentials> {
  const bot = await load(read, securityBin, "discord-bot", isValidBotToken);
  const webhook = await load(read, securityBin, "discord-report-webhook", isValidWebhookUrl);
  return { botToken: bot.value, webhookUrl: webhook.value, state: { bot: bot.state, webhook: webhook.state } };
}
