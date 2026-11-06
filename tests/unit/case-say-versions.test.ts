import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASE_SAY_VERSIONS_FILE, CASE_SAY_VERSIONS_KEY_FILE, CaseSayVersionStore, fingerprintFile, type VersionEntry } from "../../server/case-say-versions.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-versions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const recordFile = (): string => path.join(dir, CASE_SAY_VERSIONS_FILE);
const keyFile = (): string => path.join(dir, CASE_SAY_VERSIONS_KEY_FILE);

function writeBinary(name: string, body: string): { real: string; sha256: string; size: number } {
  const real = path.join(dir, name);
  writeFileSync(real, body, { mode: 0o755 });
  return { real, sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body) };
}

const entryOf = (b: { real: string; sha256: string; size: number }, over: Partial<Omit<VersionEntry, "mac">> = {}): Omit<VersionEntry, "mac"> => ({
  sha256: b.sha256, size: b.size, claudeVersion: "2.1.320", real: b.real, verifiedAt: "2026-11-06T00:00:00.000Z", probeCaseId: "c", checks: { E1: true, P0: true },
  usable: true, lastProbeAt: "2026-11-06T00:00:00.000Z", lastResult: "ok", failCount: 0, ...over,
});

describe("fingerprintFile", () => {
  it("returns sha256 and size by streaming; an unreadable file is null", async () => {
    const b = writeBinary("bin", "hello claude");
    expect(await fingerprintFile(b.real)).toEqual({ sha256: b.sha256, size: b.size });
    expect(await fingerprintFile(path.join(dir, "nope"))).toBeNull();
  });
});

describe("K53: CaseSayVersionStore", () => {
  it("makes the key with mode 0600 when missing, writes MAC-protected entries with mode 0600, and reads them back", async () => {
    const b = writeBinary("c1", "one");
    const store = new CaseSayVersionStore(dir);
    expect(await store.load()).toEqual({ discarded: false });
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(await store.upsert(entryOf(b))).toBe(true);
    expect(statSync(recordFile()).mode & 0o777).toBe(0o600);
    const again = new CaseSayVersionStore(dir);
    expect(await again.load()).toEqual({ discarded: false });
    expect(again.isUsable({ sha256: b.sha256, size: b.size })).toBe(true);
    expect(again.isUsable({ sha256: b.sha256, size: b.size + 1 })).toBe(false);
    expect(again.isUsable({ sha256: "f".repeat(64), size: b.size })).toBe(false);
    expect(again.isUsable(undefined)).toBe(false);
    expect(again.usableVersions()).toEqual(["2.1.320"]);
  });

  it("discards an entry whose MAC does not match (usable flipped by hand), does not overwrite the file, and refuses to write", async () => {
    const b = writeBinary("c1", "one");
    const store = new CaseSayVersionStore(dir);
    await store.load();
    await store.upsert(entryOf(b, { usable: false, lastResult: "P3" }));
    const doc = JSON.parse(readFileSync(recordFile(), "utf8")) as { entries: Array<{ usable: boolean }> };
    doc.entries[0].usable = true;
    writeFileSync(recordFile(), JSON.stringify(doc));
    const before = readFileSync(recordFile(), "utf8");
    const again = new CaseSayVersionStore(dir);
    expect(await again.load()).toEqual({ discarded: true });
    expect(again.isUsable({ sha256: b.sha256, size: b.size })).toBe(false);
    expect(await again.upsert(entryOf(b))).toBe(false);
    expect(readFileSync(recordFile(), "utf8")).toBe(before);
  });

  it("a changed key invalidates the entries (MAC mismatch)", async () => {
    const b = writeBinary("c1", "one");
    const store = new CaseSayVersionStore(dir);
    await store.load();
    await store.upsert(entryOf(b));
    writeFileSync(keyFile(), `${"ab".repeat(32)}\n`, { mode: 0o600 });
    const again = new CaseSayVersionStore(dir);
    expect(await again.load()).toEqual({ discarded: true });
    expect(again.usableVersions()).toEqual([]);
  });

  it("a broken JSON gives zero usable versions, is not overwritten, and writes are refused", async () => {
    writeFileSync(recordFile(), "{ not json", { mode: 0o600 });
    const store = new CaseSayVersionStore(dir);
    expect(await store.load()).toEqual({ discarded: true });
    expect(store.usableVersions()).toEqual([]);
    expect(await store.upsert(entryOf(writeBinary("c1", "one")))).toBe(false);
    expect(readFileSync(recordFile(), "utf8")).toBe("{ not json");
  });

  it("recheck makes an entry unusable (kept in the record) when the binary is missing or its content changed", async () => {
    const same = writeBinary("same", "same");
    const changed = writeBinary("changed", "before");
    const gone = writeBinary("gone", "gone");
    const store = new CaseSayVersionStore(dir);
    await store.load();
    for (const b of [same, changed, gone]) await store.upsert(entryOf(b));
    writeFileSync(changed.real, "after!");
    rmSync(gone.real);
    chmodSync(same.real, 0o755);
    const revoked = await store.recheck(() => "2026-11-07T00:00:00.000Z");
    expect(revoked.map((e) => e.sha256).sort()).toEqual([changed.sha256, gone.sha256].sort());
    expect(store.isUsable({ sha256: same.sha256, size: same.size })).toBe(true);
    expect(store.isUsable({ sha256: changed.sha256, size: changed.size })).toBe(false);
    expect(store.entries()).toHaveLength(3);
    expect(store.entryOf(gone.sha256)).toMatchObject({ usable: false, lastResult: "revoked" });
    // 起き直しても残る
    const again = new CaseSayVersionStore(dir);
    expect(await again.load()).toEqual({ discarded: false });
    expect(again.entries()).toHaveLength(3);
  });

  it("keeps runningVersionProbe in the record and clears it", async () => {
    const store = new CaseSayVersionStore(dir);
    await store.load();
    await store.setRunning({ caseId: "id1", startedAt: 5 });
    const again = new CaseSayVersionStore(dir);
    await again.load();
    expect(again.runningVersionProbe()).toEqual({ caseId: "id1", startedAt: 5 });
    await again.setRunning(undefined);
    const third = new CaseSayVersionStore(dir);
    await third.load();
    expect(third.runningVersionProbe()).toBeUndefined();
    mkdirSync(path.join(dir, "x"), { recursive: true });
  });
});
