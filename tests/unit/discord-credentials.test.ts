import { describe, expect, it } from "vitest";
import { isValidBotToken, isValidWebhookUrl, loadDiscordCredentials } from "../../server/discord-credentials.ts";

const TOKEN = "fake.Token_value-0123456789";
const URL_OK = "https://discord.com/api/webhooks/100000000000000001/fake_token-abc";

describe("isValidBotToken", () => {
  it("accepts the loose shape", () => {
    expect(isValidBotToken(TOKEN)).toBe(true);
    expect(isValidBotToken("a".repeat(200))).toBe(true);
  });
  it.each([["empty", ""], ["201 chars", "a".repeat(201)], ["space", "ab cd"], ["colon", "ab:cd"], ["newline", "ab\ncd"]])("rejects %s", (_l, v) => {
    expect(isValidBotToken(v)).toBe(false);
  });
});

describe("isValidWebhookUrl", () => {
  it("accepts only the discord.com shape", () => {
    expect(isValidWebhookUrl(URL_OK)).toBe(true);
  });
  it.each([
    ["discordapp.com", "https://discordapp.com/api/webhooks/100000000000000001/abc"],
    ["http", "http://discord.com/api/webhooks/100000000000000001/abc"],
    ["extra path", "https://discord.com/api/webhooks/100000000000000001/abc/extra"],
    ["empty token", "https://discord.com/api/webhooks/100000000000000001/"],
    ["other host", "https://evil.example/api/webhooks/100000000000000001/abc"],
    ["userinfo", "https://discord.com@evil.example/api/webhooks/100000000000000001/abc"],
    ["query", `${URL_OK}?x=1`],
  ])("rejects %s", (_l, v) => {
    expect(isValidWebhookUrl(v)).toBe(false);
  });
});

describe("loadDiscordCredentials", () => {
  it("returns ok values", async () => {
    const r = await loadDiscordCredentials("/x", async (_b, a) => (a === "discord-bot" ? TOKEN : URL_OK));
    expect(r).toEqual({ botToken: TOKEN, webhookUrl: URL_OK, state: { bot: "ok", webhook: "ok" } });
  });
  it("unreadable when the read throws; values are null", async () => {
    const r = await loadDiscordCredentials("/x", async (_b, a) => { if (a === "discord-bot") throw new Error("boom"); return URL_OK; });
    expect(r.botToken).toBeNull();
    expect(r.state).toEqual({ bot: "unreadable", webhook: "ok" });
  });
  it("invalid when the shape is wrong; values are null", async () => {
    const r = await loadDiscordCredentials("/x", async (_b, a) => (a === "discord-bot" ? "bad token" : "https://discordapp.com/api/webhooks/1/a"));
    expect(r).toEqual({ botToken: null, webhookUrl: null, state: { bot: "invalid", webhook: "invalid" } });
  });
});
