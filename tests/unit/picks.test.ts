import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PICK_LIMITS, PICK_STYLE_KEYS, PickStore, validatePickPayload } from "../../server/picks.ts";

const newDir = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), "ac-picks-")), "data");

/** 8 バイトの PNG 署名 + 中身（形だけ）。 */
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (extra = 16): Buffer => Buffer.concat([PNG_HEAD, Buffer.alloc(extra, 7)]);

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://example.com/page?q=1",
    title: "題名",
    selector: "#root > div > p",
    tag: "p",
    attrs: { id: "x", class: "a b" },
    text: "本文",
    html: '<p id="x">本文</p>',
    style: { "font-size": "14px", color: "rgb(0, 0, 0)" },
    rect: { x: 1, y: 2, w: 30, h: 4 },
    dpr: 2,
    vw: 1200,
    ...over,
  };
}

describe("validatePickPayload (K2, K8)", () => {
  it("accepts a full payload and keeps only the known attributes and the 14 style keys", () => {
    const { input, image } = validatePickPayload(payload({ attrs: { id: "x", "onclick": "evil()" }, style: { color: "red", "x-unknown": "1" } }));
    expect(input.attrs).toEqual({ id: "x" });
    expect(input.style).toEqual({ color: "red" });
    expect(image).toBeNull();
    expect(PICK_STYLE_KEYS).toHaveLength(14);
  });

  it("refuses a url that is not http or https", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://extensions", "data:text/html,x", "not a url", ""]) {
      expect(() => validatePickPayload(payload({ url: bad })), bad).toThrow(/url/);
    }
  });

  it("refuses values over the length limits", () => {
    expect(() => validatePickPayload(payload({ text: "あ".repeat(PICK_LIMITS.text + 1) }))).toThrow(/text/);
    expect(() => validatePickPayload(payload({ html: "x".repeat(PICK_LIMITS.html + 1) }))).toThrow(/html/);
    expect(() => validatePickPayload(payload({ attrs: { id: "x".repeat(PICK_LIMITS.attr + 1) } }))).toThrow(/attrs/);
    expect(() => validatePickPayload(payload({ title: "x".repeat(PICK_LIMITS.title + 1) }))).toThrow(/title/);
    expect(() => validatePickPayload(payload({ selector: "x".repeat(PICK_LIMITS.selector + 1) }))).toThrow(/selector/);
    expect(validatePickPayload(payload({ text: "あ".repeat(PICK_LIMITS.text), html: "x".repeat(PICK_LIMITS.html) })).input.text).toHaveLength(PICK_LIMITS.text);
  });

  it("strips control characters other than newline and tab (ESC, CR, C1)", () => {
    const { input } = validatePickPayload(payload({ text: "a\u001b[31mb\r\nc\td\u009be\u0000f", title: "t\u001bx" }));
    expect(input.text).toBe("a[31mb\nc\tdef");
    expect(input.title).toBe("tx");
  });

  it("refuses a body that is not an object, and a rect with non-numbers", () => {
    expect(() => validatePickPayload(null)).toThrow();
    expect(() => validatePickPayload([])).toThrow();
    expect(() => validatePickPayload(payload({ rect: { x: "1", y: 2, w: 3, h: 4 } }))).toThrow(/rect/);
    expect(() => validatePickPayload(payload({ dpr: Number.NaN }))).toThrow(/dpr/);
  });

  it("keeps a PNG up to 1.5MiB and drops anything else with imageError", () => {
    const ok = validatePickPayload(payload({ imageBase64: png().toString("base64") }));
    expect(ok.image?.length).toBe(24);
    expect(ok.input.imageError).toBe("");

    const notPng = validatePickPayload(payload({ imageBase64: Buffer.from("GIF89a....").toString("base64") }));
    expect(notPng.image).toBeNull();
    expect(notPng.input.imageError).toMatch(/png/i);

    const big = validatePickPayload(payload({ imageBase64: png(PICK_LIMITS.imageBytes).toString("base64") }));
    expect(big.image).toBeNull();
    expect(big.input.imageError).toMatch(/large/i);
    expect(validatePickPayload(payload({ imageBase64: png(PICK_LIMITS.imageBytes - 8).toString("base64") })).image).not.toBeNull();
  });

  it("keeps the reason the extension gives when it sent no image", () => {
    const r = validatePickPayload(payload({ imageError: "captureVisibleTab failed" }));
    expect(r.image).toBeNull();
    expect(r.input.imageError).toBe("captureVisibleTab failed");
  });
});

describe("PickStore (K8)", () => {
  it("saves one JSON and one PNG per pick under picks/, mode 700 dir and 600 files, id is a UUID, no temp files left", async () => {
    const dir = newDir();
    const store = new PickStore(dir, 50);
    const rec = await store.add(payload({ imageBase64: png().toString("base64") }));
    expect(rec.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const picks = path.join(dir, "picks");
    expect(readdirSync(picks).sort()).toEqual([`${rec.id}.json`, `${rec.id}.png`]);
    expect(statSync(picks).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(picks, `${rec.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(picks, `${rec.id}.png`)).mode & 0o777).toBe(0o600);
    expect(store.imagePath(rec.id)).toBe(path.join(picks, `${rec.id}.png`));
    expect(rec.hasImage).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(picks, `${rec.id}.json`), "utf8")) as { version: number; pick: { url: string; note: string } };
    expect(saved.version).toBe(1);
    expect(saved.pick.url).toBe("https://example.com/page?q=1");
    expect(saved.pick.note).toBe("");
  });

  it("saves a pick without an image as JSON only", async () => {
    const dir = newDir();
    const rec = await new PickStore(dir, 50).add(payload());
    expect(readdirSync(path.join(dir, "picks"))).toEqual([`${rec.id}.json`]);
    expect(rec.hasImage).toBe(false);
  });

  it("lists newest first and keeps only maxKeep, removing the oldest ones' two files only", async () => {
    const dir = newDir();
    const store = new PickStore(dir, 3);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await store.add(payload({ title: `t${i}`, imageBase64: png().toString("base64") }))).id);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect((await store.list()).map((p) => p.title)).toEqual(["t4", "t3", "t2"]);
    expect(readdirSync(path.join(dir, "picks")).sort()).toEqual(ids.slice(2).flatMap((id) => [`${id}.json`, `${id}.png`]).sort());
  });

  it("does not touch files that are not a pick's UUID pair while pruning", async () => {
    const dir = newDir();
    const store = new PickStore(dir, 1);
    await store.add(payload());
    writeFileSync(path.join(dir, "picks", "keep-me.txt"), "x");
    await store.add(payload());
    await store.add(payload());
    expect(existsSync(path.join(dir, "picks", "keep-me.txt"))).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it("sets the note, marks as sent, and counts unsent", async () => {
    const store = new PickStore(newDir(), 50);
    const a = await store.add(payload());
    const b = await store.add(payload());
    expect(await store.unsentCount()).toBe(2);
    expect((await store.setNote(a.id, "ここを直して")).note).toBe("ここを直して");
    await store.markSent([a.id, "00000000-0000-4000-8000-000000000000"]);
    expect(await store.unsentCount()).toBe(1);
    const list = await store.list();
    expect(list.find((p) => p.id === a.id)?.sentAt).toBeTypeOf("number");
    expect(list.find((p) => p.id === b.id)?.sentAt).toBeUndefined();
  });

  it("editing the note puts a sent pick back to unsent", async () => {
    const store = new PickStore(newDir(), 50);
    const a = await store.add(payload());
    await store.markSent([a.id]);
    await store.setNote(a.id, "もう一度");
    expect(await store.unsentCount()).toBe(1);
  });

  it("rejects a note with control characters or over the limit, and an unknown id", async () => {
    const store = new PickStore(newDir(), 50);
    const a = await store.add(payload());
    await expect(store.setNote(a.id, "a\u001bb")).rejects.toThrow(/note/);
    await expect(store.setNote(a.id, "x".repeat(PICK_LIMITS.note + 1))).rejects.toThrow(/note/);
    await expect(store.setNote("00000000-0000-4000-8000-000000000000", "x")).rejects.toThrow(/not found/);
  });

  it("removes exactly the two files of that UUID, and refuses an id that is not a UUID", async () => {
    const dir = newDir();
    const store = new PickStore(dir, 50);
    const a = await store.add(payload({ imageBase64: png().toString("base64") }));
    const b = await store.add(payload());
    await store.remove(a.id);
    expect(readdirSync(path.join(dir, "picks"))).toEqual([`${b.id}.json`]);
    for (const bad of ["../x", "..", "a", `${b.id}/../${b.id}`, ""]) {
      await expect(store.remove(bad), bad).rejects.toThrow(/id/);
      expect(() => store.imagePath(bad), bad).toThrow(/id/);
    }
    expect(readdirSync(path.join(dir, "picks"))).toEqual([`${b.id}.json`]);
  });

  it("reads the image back, and returns null when there is none", async () => {
    const store = new PickStore(newDir(), 50);
    const a = await store.add(payload({ imageBase64: png().toString("base64") }));
    const b = await store.add(payload());
    expect((await store.readImage(a.id))?.subarray(0, 4)).toEqual(PNG_HEAD.subarray(0, 4));
    expect(await store.readImage(b.id)).toBeNull();
  });

  it("notifies listeners with the unsent count after each change", async () => {
    const store = new PickStore(newDir(), 50);
    const seen: number[] = [];
    store.onChange((n) => seen.push(n));
    const a = await store.add(payload());
    await store.add(payload());
    await store.markSent([a.id]);
    await store.remove(a.id);
    expect(seen).toEqual([1, 2, 1, 1]);
  });

  it("skips a damaged JSON file and keeps listing the rest", async () => {
    const dir = newDir();
    const store = new PickStore(dir, 50);
    const a = await store.add(payload());
    writeFileSync(path.join(dir, "picks", "11111111-1111-4111-8111-111111111111.json"), "{broken");
    expect((await store.list()).map((p) => p.id)).toEqual([a.id]);
  });
});
