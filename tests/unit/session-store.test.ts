import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_SESSIONS_FILE, OpenSessionStore } from "../../server/session-store.ts";

const ID = "11111111-1111-4111-8111-111111111111";

function setup(): { dir: string; file: string; store: OpenSessionStore } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-store-"));
  return { dir, file: path.join(dir, OPEN_SESSIONS_FILE), store: new OpenSessionStore(dir) };
}

describe("OpenSessionStore", () => {
  it("returns an empty list when the file does not exist", async () => {
    expect(await setup().store.load()).toEqual([]);
  });

  it("round-trips items with permission 600 and leaves no temporary file", async () => {
    const { dir, file, store } = setup();
    const items = [{ roleId: "r", name: "n", cwd: "/a", branch: "release/x", claudeSessionId: ID }, { roleId: "s", name: "m", cwd: "/b" }];
    await store.save(items);
    expect(await store.load()).toEqual(items);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([OPEN_SESSIONS_FILE]);
  });

  it("does not save a sessionId that is not a UUID", async () => {
    const { file, store } = setup();
    await store.save([{ roleId: "r", name: "n", cwd: "/a", claudeSessionId: "x; echo injected" }]);
    expect(readFileSync(file, "utf8")).not.toContain("claudeSessionId");
    expect(readFileSync(file, "utf8")).not.toContain("injected");
  });

  it("throws on a corrupt file, a wrong version and a malformed item, and does not overwrite them", async () => {
    for (const content of ["{oops", JSON.stringify({ version: 2, items: [] }), JSON.stringify({ version: 1, items: [{ roleId: "r" }] }), "[]"]) {
      const { file, store } = setup();
      writeFileSync(file, content);
      await expect(store.load()).rejects.toThrow();
      await expect(store.save([{ roleId: "r", name: "n", cwd: "/a" }])).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("keeps the order of concurrent saves (the last call wins)", async () => {
    const { store } = setup();
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save([{ roleId: "r", name: `n${n}`, cwd: "/a" }])));
    expect((await store.load()).map((i) => i.name)).toEqual(["n5"]);
  });
});
