import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectImage, UploadStore, UPLOADS_DIR } from "../../server/uploads.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff];
const png = (extra = 8): Buffer => Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(extra, 7)]);
const jpeg = (extra = 8): Buffer => Buffer.concat([Buffer.from(JPEG_HEAD), Buffer.alloc(extra, 7)]);
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$/;

function freshStore(maxBytes = 1024, maxKeep = 100): { store: UploadStore; dir: string; uploads: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-upl-"));
  return { store: new UploadStore(dir, maxBytes, maxKeep), dir, uploads: path.join(dir, UPLOADS_DIR) };
}

describe("detectImage (K5: decided by the leading bytes, not by a name or a declared type)", () => {
  it("recognizes the 8-byte PNG signature and the 3-byte JPEG signature", () => {
    expect(detectImage(png())).toBe("png");
    expect(detectImage(jpeg())).toBe("jpg");
  });
  it("refuses a truncated signature, GIF, text and empty input", () => {
    expect(detectImage(Buffer.from(PNG_HEAD.slice(0, 7)))).toBeNull();
    expect(detectImage(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImage(Buffer.from("GIF89a"))).toBeNull();
    expect(detectImage(Buffer.from("hello"))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });
  it("refuses the 4-byte PNG prefix alone (the picker accepts 4 bytes; uploads need all 8)", () => {
    expect(detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("UploadStore.save (K5)", () => {
  it("writes dataDir/uploads/<UUID>.<ext> with mode 600 in a 700 directory and returns the absolute path", async () => {
    const { store, uploads } = freshStore();
    const a = await store.save(png());
    const b = await store.save(jpeg());
    expect(path.isAbsolute(a.path)).toBe(true);
    expect(path.dirname(a.path)).toBe(uploads);
    expect(path.basename(a.path)).toMatch(UUID_FILE);
    expect(a.path.endsWith(".png")).toBe(true);
    expect(b.path.endsWith(".jpg")).toBe(true);
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(statSync(uploads).mode & 0o777).toBe(0o700);
    expect(readFileSync(a.path).equals(png())).toBe(true);
    expect(readdirSync(uploads).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses non-images and oversize input without leaving a file", async () => {
    const { store, uploads } = freshStore(64);
    await expect(store.save(Buffer.from("not an image"))).rejects.toThrow(/PNG or JPEG/);
    await expect(store.save(png(64))).rejects.toThrow(/too large/);
    expect(() => readdirSync(uploads)).toThrow();
  });

  it("takes exactly maxBytes but not one more", async () => {
    const { store } = freshStore(100);
    await expect(store.save(png(100 - PNG_HEAD.length))).resolves.toBeDefined();
    await expect(store.save(png(100 - PNG_HEAD.length + 1))).rejects.toThrow(/too large/);
  });

  it("concurrent saves are written one by one and none is lost", async () => {
    const { store, uploads } = freshStore(1024, 100);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.save(png())));
    expect(new Set(results.map((r) => r.path)).size).toBe(8);
    expect(readdirSync(uploads)).toHaveLength(8);
  });
});

describe("UploadStore prune (K5: keep the newest uploadMaxKeep by mtime, delete UUID files only)", () => {
  it("deletes the oldest by mtime, not by name", async () => {
    const { store, uploads } = freshStore(1024, 3);
    const saved: string[] = [];
    for (let i = 0; i < 3; i++) saved.push((await store.save(png())).path);
    // 保存順と mtime を逆にする: 最後に保存したものを一番古くする
    const now = Date.now() / 1000;
    utimesSync(saved[2], now - 300, now - 300);
    utimesSync(saved[0], now - 100, now - 100);
    utimesSync(saved[1], now - 200, now - 200);
    const fourth = await store.save(jpeg());
    const left = readdirSync(uploads).map((n) => path.join(uploads, n)).sort();
    expect(left).toEqual([saved[0], saved[1], fourth.path].sort());
  });

  it("never deletes a file that is not <UUID>.png/.jpg, even when it is the oldest", async () => {
    const { store, uploads } = freshStore(1024, 1);
    await store.save(png());
    const keepers = ["notes.txt", "0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f.png.bak", "UPPER-0B9C5C6E-6F0E-4F7D-9F34-1A2B3C4D5E6F.png"];
    for (const name of keepers) {
      writeFileSync(path.join(uploads, name), "x");
      utimesSync(path.join(uploads, name), 1, 1);
    }
    await store.save(png());
    await store.save(png());
    const names = readdirSync(uploads);
    for (const name of keepers) expect(names).toContain(name);
    expect(names.filter((n) => UUID_FILE.test(n))).toHaveLength(1);
  });
});
