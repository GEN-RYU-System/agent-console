import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTAKE_CONFIG_FILE, readIntakeConfig } from "../../server/discord-intake-config.ts";

const bug = (over: Record<string, unknown> = {}) => ({
  kind: "bug", enabled: true, guildId: "100000000000000002", channelId: "100000000000000003",
  allowedAuthors: [{ id: "100000000000000004", name: "x" }], allowedMessageTypes: [0, 19], ...over,
});
const er = (over: Record<string, unknown> = {}) => ({
  kind: "error-report", enabled: false, guildId: "100000000000000002", channelId: "100000000000000005", reportWebhookId: "100000000000000006", ...over,
});
const base = (over: Record<string, unknown> = {}) => ({ testMode: true, forbiddenBotIds: ["100000000000000001"], channels: [bug(), er()], ...over });

function dirWith(content?: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-intake-cfg-"));
  if (content !== undefined) writeFileSync(path.join(d, INTAKE_CONFIG_FILE), content);
  return d;
}
const read = (v: unknown) => readIntakeConfig(dirWith(JSON.stringify(v)));

describe("readIntakeConfig", () => {
  it("missing when there is no file", async () => {
    expect(await readIntakeConfig(dirWith())).toEqual({ ok: false, reason: "missing" });
  });
  it("ok for a valid shape", async () => {
    const r = await read(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.channels).toHaveLength(2);
      expect(r.config.channels[1]?.reportWebhookId).toBe("100000000000000006");
    }
  });
  it("ok for testMode false when bug is disabled", async () => {
    expect((await read(base({ testMode: false, channels: [bug({ enabled: false })] }))).ok).toBe(true);
  });
  it.each([
    ["broken JSON", undefined],
    ["unknown field (root)", base({ extra: 1 })],
    ["unknown field (channel)", base({ channels: [bug({ extra: 1 })] })],
    ["bad id shape", base({ channels: [bug({ channelId: "abc" })] })],
    ["id too long", base({ forbiddenBotIds: ["1".repeat(21)] })],
    ["empty forbiddenBotIds", base({ forbiddenBotIds: [] })],
    ["duplicate channelId", base({ channels: [bug(), er({ channelId: "100000000000000003" })] })],
    ["duplicate kind", base({ channels: [bug(), bug({ channelId: "100000000000000009" })] })],
    ["testMode false and bug enabled", base({ testMode: false })],
    ["bug without authors", base({ channels: [bug({ allowedAuthors: [] })] })],
    ["bug without message types", base({ channels: [bug({ allowedMessageTypes: [] })] })],
    ["negative message type", base({ channels: [bug({ allowedMessageTypes: [-1] })] })],
    ["error-report without reportWebhookId", base({ channels: [er({ reportWebhookId: undefined })] })],
    ["wrong type", base({ testMode: "yes" })],
  ])("invalid: %s (problem has no values)", async (label, v) => {
    const r = label === "broken JSON" ? await readIntakeConfig(dirWith("{ not json")) : await read(v);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "invalid") {
      expect(r.problem).toMatch(/^[A-Za-z.]+$/);
      expect(r.problem).not.toMatch(/\d{5}/);
    } else {
      throw new Error("expected invalid");
    }
  });
});
