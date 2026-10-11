import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PROMPT_BYTES, QUICK_PROMPTS_FILE, QuickPromptStore } from "../../server/quick-prompts.ts";

const newDir = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), "ac-qp-")), "data");

describe("QuickPromptStore", () => {
  it("starts empty when the file does not exist", async () => {
    expect(await new QuickPromptStore(newDir()).list()).toEqual([]);
  });

  it("creates, updates and deletes in one file with mode 600 and no temp files left", async () => {
    const dir = newDir();
    const store = new QuickPromptStore(dir);
    const a = await store.create({ label: "テスト", text: "npm test を実行して" });
    await store.create({ label: "b", text: "line1\nline2" });
    await store.update(a.id, { label: "テスト2", text: "npm run lint" });
    expect((await store.list()).map((p) => p.label)).toEqual(["テスト2", "b"]);
    await store.remove(a.id);
    expect((await store.list()).map((p) => p.label)).toEqual(["b"]);
    expect(readdirSync(dir)).toEqual([QUICK_PROMPTS_FILE]);
    expect(statSync(path.join(dir, QUICK_PROMPTS_FILE)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path.join(dir, QUICK_PROMPTS_FILE), "utf8")) as { version: number; items: unknown[] };
    expect(saved.version).toBe(1);
    expect(saved.items).toHaveLength(1);
  });

  it("survives a restart (a new store reads the same file)", async () => {
    const dir = newDir();
    await new QuickPromptStore(dir).create({ label: "x", text: "y" });
    expect((await new QuickPromptStore(dir).list()).map((p) => p.label)).toEqual(["x"]);
  });

  it("rejects bad input", async () => {
    const store = new QuickPromptStore(newDir());
    await expect(store.create({ label: "", text: "y" })).rejects.toThrow(/label/);
    await expect(store.create({ label: "x".repeat(41), text: "y" })).rejects.toThrow(/label/);
    await expect(store.create({ label: "x", text: "  " })).rejects.toThrow(/text/);
    await expect(store.create({ label: "x", text: "a\u001b[31mb" })).rejects.toThrow(/control/);
    await expect(store.create({ label: "x", text: "a".repeat(MAX_PROMPT_BYTES + 1) })).rejects.toThrow(/8KB/);
    await expect(store.create({ label: "x", text: "あ".repeat(Math.floor(MAX_PROMPT_BYTES / 3) + 1) })).rejects.toThrow(/8KB/);
    await expect(store.create({ label: "x", text: "a".repeat(MAX_PROMPT_BYTES) })).resolves.toBeDefined();
  });

  it("reports not found for unknown ids and never overwrites a broken file", async () => {
    const dir = newDir();
    const store = new QuickPromptStore(dir);
    await expect(store.get("nope")).rejects.toThrow(/not found/);
    await expect(store.remove("nope")).rejects.toThrow(/not found/);
    await store.create({ label: "x", text: "y" });
    writeFileSync(path.join(dir, QUICK_PROMPTS_FILE), "{broken");
    await expect(store.create({ label: "z", text: "z" })).rejects.toThrow();
    expect(readFileSync(path.join(dir, QUICK_PROMPTS_FILE), "utf8")).toBe("{broken");
  });

  it("does not lose items when updates are issued at the same time", async () => {
    const store = new QuickPromptStore(newDir());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create({ label: `l${i}`, text: `t${i}` })));
    expect(await store.list()).toHaveLength(10);
  });
  it("K1 moves an item up and down and saves the order in the file (K5: mode 600, no temp files)", async () => {
    const dir = newDir();
    const store = new QuickPromptStore(dir);
    const a = await store.create({ label: "a", text: "1" });
    const b = await store.create({ label: "b", text: "2" });
    const c = await store.create({ label: "c", text: "3" });
    await store.move(c.id, "up");
    expect((await store.list()).map((p) => p.label)).toEqual(["a", "c", "b"]);
    await store.move(a.id, "down");
    expect((await store.list()).map((p) => p.label)).toEqual(["c", "a", "b"]);
    const saved = JSON.parse(readFileSync(path.join(dir, QUICK_PROMPTS_FILE), "utf8")) as { items: Array<{ id: string }> };
    expect(saved.items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(readdirSync(dir)).toEqual([QUICK_PROMPTS_FILE]);
    expect(statSync(path.join(dir, QUICK_PROMPTS_FILE)).mode & 0o777).toBe(0o600);
  });

  it("K2 rejects moving the first item up or the last item down and leaves the file unchanged", async () => {
    const dir = newDir();
    const store = new QuickPromptStore(dir);
    const a = await store.create({ label: "a", text: "1" });
    const b = await store.create({ label: "b", text: "2" });
    const before = readFileSync(path.join(dir, QUICK_PROMPTS_FILE), "utf8");
    await expect(store.move(a.id, "up")).rejects.toThrow(/cannot move/);
    await expect(store.move(b.id, "down")).rejects.toThrow(/cannot move/);
    expect(readFileSync(path.join(dir, QUICK_PROMPTS_FILE), "utf8")).toBe(before);
  });

  it("K3 reports not found for an unknown id and rejects a bad direction", async () => {
    const store = new QuickPromptStore(newDir());
    const a = await store.create({ label: "a", text: "1" });
    await store.create({ label: "b", text: "2" });
    await expect(store.move("nope", "up")).rejects.toThrow(/not found/);
    await expect(store.move(a.id, "left" as never)).rejects.toThrow(/direction/);
  });

  it("K5 keeps every item when moves and creates run at the same time", async () => {
    const store = new QuickPromptStore(newDir());
    const a = await store.create({ label: "a", text: "1" });
    await store.create({ label: "b", text: "2" });
    await Promise.all([store.move(a.id, "down"), store.create({ label: "c", text: "3" }), store.create({ label: "d", text: "4" })]);
    expect((await store.list()).map((p) => p.label).sort()).toEqual(["a", "b", "c", "d"]);
  });
});
