import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectImage, UploadStore, UPLOADS_DIR } from "../../server/uploads.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff];
const png = (extra = 8): Buffer => Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(extra, 7)]);
const jpeg = (extra = 8): Buffer => Buffer.concat([Buffer.from(JPEG_HEAD), Buffer.alloc(extra, 7)]);
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
    const keepers = ["notes.txt", "0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f.png.bak", "UPPER-1A2B3C4D-6F0E-4F7D-9F34-0B9C5C6E5E6F.png"];
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

describe("UploadStore.saveFile (K1/K7/K8)", () => {
  it("writes uploads/files/<UUID>/<safe name> byte for byte (mode 600 file, 700 dirs) and returns the absolute path", async () => {
    const { store, uploads } = freshStore();
    const csv = Buffer.from("品名,数量\nりんご,3\n", "utf8");
    const r = await store.saveFile("売上 10月.csv", csv);
    const files = path.join(uploads, "files");
    expect(path.isAbsolute(r.path)).toBe(true);
    expect(path.dirname(path.dirname(r.path))).toBe(files);
    expect(path.basename(path.dirname(r.path))).toMatch(UUID_DIR);
    expect(path.basename(r.path)).toBe("売上_10月.csv");
    expect(readFileSync(r.path).equals(csv)).toBe(true);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(r.path)).mode & 0o777).toBe(0o700);
    expect(statSync(files).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(r.path)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("takes any content (no type check) and an empty file", async () => {
    const { store } = freshStore();
    const exe = await store.saveFile("run.sh", Buffer.from("#!/bin/sh\n"));
    expect(statSync(exe.path).mode & 0o777).toBe(0o600);
    const empty = await store.saveFile("empty.txt", Buffer.alloc(0));
    expect(statSync(empty.path).size).toBe(0);
  });

  it("takes exactly maxBytes but not one more, leaving nothing behind", async () => {
    const { store, uploads } = freshStore(100);
    await expect(store.saveFile("a.bin", Buffer.alloc(100))).resolves.toBeDefined();
    await expect(store.saveFile("b.bin", Buffer.alloc(101))).rejects.toThrow(/too large/);
    expect(readdirSync(path.join(uploads, "files"))).toHaveLength(1);
  });

  it("same name twice lands in different folders", async () => {
    const { store } = freshStore();
    const a = await store.saveFile("x.csv", Buffer.from("1"));
    const b = await store.saveFile("x.csv", Buffer.from("2"));
    expect(a.path).not.toBe(b.path);
  });

  it("a traversal name stays inside its own folder", async () => {
    const { store } = freshStore();
    const r = await store.saveFile("../../../evil.sh", Buffer.from("x"));
    expect(path.basename(r.path)).toBe("evil.sh");
  });
});

describe("UploadStore pruneFiles (K5)", () => {
  const folders = (uploads: string): string[] => readdirSync(path.join(uploads, "files"));

  it("keeps maxKeep (3) folders and removes the oldest on the 4th save", async () => {
    const { store, uploads } = freshStore(1024, 3);
    const saved: string[] = [];
    for (let i = 0; i < 3; i++) saved.push((await store.saveFile(`f${i}.txt`, Buffer.from("x"))).path);
    const now = Date.now() / 1000;
    for (const [i, p] of saved.entries()) utimesSync(path.dirname(p), now - 1000 + i * 100, now - 1000 + i * 100);
    const fourth = await store.saveFile("f3.txt", Buffer.from("x"));
    const left = folders(uploads).sort();
    expect(left).toEqual([path.basename(path.dirname(saved[1])), path.basename(path.dirname(saved[2])), path.basename(path.dirname(fourth.path))].sort());
  });

  it("leaves non-UUID names, symlink-free odd entries, and UUID folders with sub-folders alone", async () => {
    const { store, uploads } = freshStore(1024, 1);
    await store.saveFile("seed.txt", Buffer.from("x"));
    const files = path.join(uploads, "files");
    writeFileSync(path.join(files, "notes.txt"), "x");
    mkdirSync(path.join(files, "not-a-uuid"));
    const nested = path.join(files, "0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f");
    mkdirSync(path.join(nested, "sub"), { recursive: true });
    const upper = path.join(files, "1A2B3C4D-6F0E-4F7D-9F34-0B9C5C6E5E6F");
    mkdirSync(upper);
    for (const p of [path.join(files, "notes.txt"), path.join(files, "not-a-uuid"), nested, upper]) utimesSync(p, 1, 1);
    await store.saveFile("a.txt", Buffer.from("x"));
    await store.saveFile("b.txt", Buffer.from("x"));
    const names = readdirSync(files);
    for (const keep of ["notes.txt", "not-a-uuid", "0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f", "1A2B3C4D-6F0E-4F7D-9F34-0B9C5C6E5E6F"]) expect(names).toContain(keep);
    expect(names.filter((n) => UUID_DIR.test(n) && n !== "0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f")).toHaveLength(1);
  });

  it("counts files separately from images", async () => {
    const { store, uploads } = freshStore(1024, 2);
    for (let i = 0; i < 4; i++) await store.save(png());
    for (let i = 0; i < 2; i++) await store.saveFile(`f${i}.txt`, Buffer.from("x"));
    expect(readdirSync(uploads).filter((n) => UUID_FILE.test(n))).toHaveLength(2);
    expect(folders(uploads)).toHaveLength(2);
    await store.saveFile("f2.txt", Buffer.from("x"));
    expect(readdirSync(uploads).filter((n) => UUID_FILE.test(n))).toHaveLength(2);
    expect(folders(uploads)).toHaveLength(2);
  });
});
