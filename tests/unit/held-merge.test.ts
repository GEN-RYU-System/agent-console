import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHeldFiles, mergeItems } from "../../server/held-merge.ts";

const CS_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const item = (id: string | undefined, cs: string | undefined, name: string) => ({ ...(id ? { id } : {}), roleId: "dev", name, cwd: "/tmp", ...(cs ? { claudeSessionId: cs } : {}) });
const dir = (): string => mkdtempSync(path.join(os.tmpdir(), "ac-held-"));
const put = (d: string, f: string, items: unknown[], version = 1) => writeFileSync(path.join(d, f), JSON.stringify({ version, items }));
const get = (d: string, f: string) => JSON.parse(readFileSync(path.join(d, f), "utf8")) as { items: Array<Record<string, string>> };
const quiet = { log: () => undefined, error: () => undefined };

describe("restoreHeldFiles (K14: the new server puts the held lists back before it reconnects)", () => {
  it("held only: becomes the live file, the held file is gone, mode 600", async () => {
    const d = dir();
    put(d, "open-sessions.tmux-held.json", [item("11111111-1111-4111-8111-111111111111", CS_X, "a")]);
    expect(await restoreHeldFiles(d, quiet)).toBe(1);
    expect(get(d, "open-sessions.json").items.map((i) => i.name)).toEqual(["a"]);
    expect(existsSync(path.join(d, "open-sessions.tmux-held.json"))).toBe(false);
    expect(statSync(path.join(d, "open-sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("held and current with the same claudeSessionId: the held item wins, the current duplicate is dropped; items without ids stay", async () => {
    const d = dir();
    put(d, "open-sessions.tmux-held.json", [item("11111111-1111-4111-8111-111111111111", CS_X, "held")]);
    put(d, "open-sessions.json", [item("22222222-2222-4222-8222-222222222222", CS_X, "dup"), item(undefined, undefined, "plain")]);
    await restoreHeldFiles(d, quiet);
    expect(get(d, "open-sessions.json").items.map((i) => i.name)).toEqual(["held", "plain"]);
  });

  it("routines: matched by id, held wins, new ones stay", async () => {
    const d = dir();
    const r = (id: string, name: string) => ({ id, name });
    put(d, "routines.tmux-held.json", [r("r1", "held")], 2);
    put(d, "routines.json", [r("r1", "cur"), r("r2", "new")], 2);
    await restoreHeldFiles(d, quiet);
    expect(get(d, "routines.json").items.map((i) => i.name)).toEqual(["held", "new"]);
  });

  it("no held file: nothing happens. A broken held file is left in place and reported", async () => {
    const d = dir();
    put(d, "open-sessions.json", [item(undefined, undefined, "x")]);
    expect(await restoreHeldFiles(d, quiet)).toBe(0);
    writeFileSync(path.join(d, "routines.tmux-held.json"), "{broken");
    const errors: string[] = [];
    expect(await restoreHeldFiles(d, { log: () => undefined, error: (m) => errors.push(m) })).toBe(0);
    expect(existsSync(path.join(d, "routines.tmux-held.json"))).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("the shell side (scripts/lib/merge-held.mjs) merges with the same rule", () => {
    const d = dir();
    const held = [item("11111111-1111-4111-8111-111111111111", CS_X, "held")];
    const cur = [item("22222222-2222-4222-8222-222222222222", CS_X, "dup"), item(undefined, undefined, "plain")];
    put(d, "h.json", held);
    put(d, "c.json", cur);
    const r = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/lib/merge-held.mjs"), "open-sessions", path.join(d, "c.json"), path.join(d, "h.json")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(get(d, "h.json").items).toEqual(mergeItems("open-sessions", held, cur));
  });
});
