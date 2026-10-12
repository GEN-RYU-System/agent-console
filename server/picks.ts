import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionInputError, SessionNotFoundError } from "./sessions.ts";

/** 拡張から受け取った部品（ブラウザで選んだ画面の一部）の保存と検査。正本は dataDir/picks/ の JSON と PNG。 */

export const PICKS_DIR = "picks";
export const PICK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const FORMAT_VERSION = 1;
const MAX_IMAGE_ERROR_CHARS = 200;
const MAX_COORDINATE = 1_000_000;

export const PICK_LIMITS = {
  url: 2048,
  title: 300,
  selector: 1000,
  tag: 40,
  attr: 200,
  style: 300,
  text: 500,
  html: 4000,
  note: 2000,
  imageBytes: 1536 * 1024,
} as const;

export const PICK_ATTR_KEYS = ["id", "class", "role", "aria-label", "data-testid", "href", "type", "name", "alt", "placeholder"] as const;
export const PICK_STYLE_KEYS = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border",
  "border-radius",
  "padding",
  "margin",
  "display",
  "gap",
  "width",
  "height",
] as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// 改行・タブ以外の制御文字（ESC・CR・C1 を含む）は端末に送らないので、受け取るときに取り除く
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export interface PickRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 検査を通した内容（id・時刻・ひとことは保存のときに付ける）。 */
export interface PickInput {
  url: string;
  title: string;
  selector: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  html: string;
  style: Record<string, string>;
  rect: PickRect;
  dpr: number;
  vw: number;
  imageError: string;
}

export interface PickRecord extends PickInput {
  id: string;
  createdAt: number;
  hasImage: boolean;
  /** PO のひとこと（アプリの画面で書く）。空のこともある */
  note: string;
  sentAt?: number;
}

const clean = (s: string): string => s.replace(CONTROL_CHARS, "");

function text(raw: unknown, field: string, max: number, required = false): string {
  if (raw === undefined && !required) return "";
  if (typeof raw !== "string") throw new SessionInputError(`${field} must be a string`);
  const value = clean(raw);
  if (value.length > max) throw new SessionInputError(`${field} is too long (max ${max})`);
  return value;
}

function stringMap(raw: unknown, field: string, allowed: readonly string[], max: number): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SessionInputError(`${field} must be an object`);
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "") continue;
    out[key] = text(v, `${field}.${key}`, max);
  }
  return out;
}

function number(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) > MAX_COORDINATE) throw new SessionInputError(`${field} must be a finite number`);
  return raw;
}

function rectOf(raw: unknown): PickRect {
  if (typeof raw !== "object" || raw === null) throw new SessionInputError("rect must be an object");
  const r = raw as Record<string, unknown>;
  return { x: number(r.x, "rect.x"), y: number(r.y, "rect.y"), w: number(r.w, "rect.w"), h: number(r.h, "rect.h") };
}

function urlOf(raw: unknown): string {
  const value = text(raw, "url", PICK_LIMITS.url, true);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SessionInputError("url must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SessionInputError("url must be a valid http or https URL");
  return value;
}

/** 画像は任意。PNG の頭で始まり 1.5MiB まで。合わなければ捨てて、理由を imageError に入れる。 */
function imageOf(raw: Record<string, unknown>): { image: Buffer | null; imageError: string } {
  const given = typeof raw.imageError === "string" ? clean(raw.imageError).slice(0, MAX_IMAGE_ERROR_CHARS) : "";
  if (typeof raw.imageBase64 !== "string" || raw.imageBase64 === "") return { image: null, imageError: given };
  const bytes = Buffer.from(raw.imageBase64, "base64");
  if (bytes.length > PICK_LIMITS.imageBytes) return { image: null, imageError: "image is too large" };
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { image: null, imageError: "image is not a PNG" };
  return { image: bytes, imageError: "" };
}

/** 拡張が送ってきた本文を検査する。不正は SessionInputError（400）。 */
export function validatePickPayload(raw: unknown): { input: PickInput; image: Buffer | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SessionInputError("JSON object required");
  const o = raw as Record<string, unknown>;
  const { image, imageError } = imageOf(o);
  const input: PickInput = {
    url: urlOf(o.url),
    title: text(o.title, "title", PICK_LIMITS.title),
    selector: text(o.selector, "selector", PICK_LIMITS.selector),
    tag: text(o.tag, "tag", PICK_LIMITS.tag),
    attrs: stringMap(o.attrs, "attrs", PICK_ATTR_KEYS, PICK_LIMITS.attr),
    text: text(o.text, "text", PICK_LIMITS.text),
    html: text(o.html, "html", PICK_LIMITS.html),
    style: stringMap(o.style, "style", PICK_STYLE_KEYS, PICK_LIMITS.style),
    rect: rectOf(o.rect),
    dpr: number(o.dpr, "dpr"),
    vw: number(o.vw, "vw"),
    imageError,
  };
  return { input, image };
}

export function validateNote(raw: unknown): string {
  if (typeof raw !== "string") throw new SessionInputError("note must be a string");
  if (raw.length > PICK_LIMITS.note) throw new SessionInputError(`note is too long (max ${PICK_LIMITS.note})`);
  if (NOTE_CONTROL.test(raw)) throw new SessionInputError("note must not contain control characters");
  return raw;
}

function assertId(id: string): void {
  if (!PICK_ID_PATTERN.test(id)) throw new SessionInputError("invalid pick id");
}

export type PickListener = (unsent: number) => void;

export class PickStore {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<PickListener>();

  constructor(
    dataDir: string,
    private readonly maxKeep: number,
  ) {
    this.dir = path.join(dataDir, PICKS_DIR);
  }

  /** 変更のたびに、未送信の件数を伝える（画面の件数を hub 経由で配信するため）。 */
  onChange(listener: PickListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private jsonPath(id: string): string {
    assertId(id);
    return path.join(this.dir, `${id}.json`);
  }

  imagePath(id: string): string {
    assertId(id);
    return path.join(this.dir, `${id}.png`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE);
  }

  private async writeAtomic(file: string, data: string | Buffer): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE);
    await rename(tmp, file);
  }

  private async readAll(): Promise<PickRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const records: PickRecord[] = [];
    for (const name of names) {
      const m = /^(.+)\.json$/.exec(name);
      if (!m || !PICK_ID_PATTERN.test(m[1])) continue;
      try {
        const parsed = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as { version?: number; pick?: PickRecord };
        if (parsed.version !== FORMAT_VERSION || !parsed.pick || parsed.pick.id !== m[1]) throw new Error("unsupported format");
        records.push(parsed.pick);
      } catch (err) {
        console.error(`picks: skipping unreadable ${name}:`, err instanceof Error ? err.message : err);
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  private async saveRecord(record: PickRecord): Promise<void> {
    await this.writeAtomic(this.jsonPath(record.id), `${JSON.stringify({ version: FORMAT_VERSION, pick: record }, null, 2)}\n`);
  }

  private async notify(): Promise<void> {
    if (this.listeners.size === 0) return;
    const unsent = (await this.readAll()).filter((p) => p.sentAt === undefined).length;
    for (const l of this.listeners) l(unsent);
  }

  /** 多すぎる分を古い順に消す。消すのは、その UUID の JSON と PNG の 2 つだけ。 */
  private async prune(): Promise<void> {
    const all = await this.readAll();
    for (const old of all.slice(this.maxKeep)) await this.removeFiles(old.id);
  }

  private async removeFiles(id: string): Promise<void> {
    for (const file of [this.jsonPath(id), this.imagePath(id)]) {
      try {
        await unlink(file);
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
    }
  }

  /** 拡張から届いた本文を検査して保存する。 */
  async add(raw: unknown): Promise<PickRecord> {
    const { input, image } = validatePickPayload(raw);
    return this.serial(async () => {
      await this.ensureDir();
      const id = randomUUID();
      const record: PickRecord = { id, createdAt: Date.now(), ...input, hasImage: image !== null, note: "" };
      // JSON が目次なので最後に書く。JSON が書けなかったら、先に書いた画像を片付ける
      if (image) await this.writeAtomic(this.imagePath(id), image);
      try {
        await this.saveRecord(record);
      } catch (err) {
        await this.removeFiles(id).catch(() => undefined);
        throw err;
      }
      await this.prune();
      await this.notify();
      return record;
    });
  }

  list(): Promise<PickRecord[]> {
    return this.serial(() => this.readAll());
  }

  async unsentCount(): Promise<number> {
    return (await this.list()).filter((p) => p.sentAt === undefined).length;
  }

  async get(id: string): Promise<PickRecord> {
    assertId(id);
    const found = (await this.list()).find((p) => p.id === id);
    if (!found) throw new SessionNotFoundError("pick not found");
    return found;
  }

  /** ひとことを書き換える。書き換えたら未送信に戻す。 */
  async setNote(id: string, rawNote: unknown): Promise<PickRecord> {
    assertId(id);
    const note = validateNote(rawNote);
    return await this.serial(async () => {
      const current = (await this.readAll()).find((p) => p.id === id);
      if (!current) throw new SessionNotFoundError("pick not found");
      const { sentAt: _sentAt, ...rest } = current;
      const next: PickRecord = { ...rest, note };
      await this.saveRecord(next);
      await this.notify();
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    assertId(id);
    return this.serial(async () => {
      await this.removeFiles(id);
      await this.notify();
    });
  }

  /** ids のうち、ここにあるものを送信済みにする（無い id は黙って飛ばす）。 */
  async markSent(ids: readonly string[]): Promise<void> {
    for (const id of ids) assertId(id);
    return this.serial(async () => {
      const now = Date.now();
      for (const p of await this.readAll()) {
        if (ids.includes(p.id)) await this.saveRecord({ ...p, sentAt: now });
      }
      await this.notify();
    });
  }

  async readImage(id: string): Promise<Buffer | null> {
    const file = this.imagePath(id);
    try {
      return await readFile(file);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }
}
