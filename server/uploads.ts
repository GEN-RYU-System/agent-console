import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionInputError } from "./sessions.ts";
import { safeUploadName } from "./uploadName.ts";

/** 端末に貼った画像（スクリーンショットなど）の保存。正本は dataDir/uploads/<UUID>.png|jpg。作法は picks.ts と同じ。 */

export const UPLOADS_DIR = "uploads";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** 消してよいのは、このアプリが作った名前（小文字の UUID + 拡張子）のファイルだけ */
const UPLOAD_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$/;

/** 画像以外のファイルの置き場（uploads/files/<UUID>/<名前>）。消してよいのは小文字 UUID 名のフォルダだけ */
export const UPLOAD_FILES_DIR = "files";
const UPLOAD_DIR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export type ImageKind = "png" | "jpg";

/** 先頭のバイトで形式を決める（名前や申告された型は見ない）。PNG は 8 バイト、JPEG は 3 バイト。 */
export function detectImage(data: Buffer): ImageKind | null {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (data.length >= JPEG_SIGNATURE.length && data.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return "jpg";
  return null;
}

/** 1 枚の上限を超えた。受け取り口では 413。 */
export class UploadTooLargeError extends SessionInputError {}

export class UploadStore {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly maxBytes: number,
    private readonly maxKeep: number,
  ) {
    this.dir = path.join(dataDir, UPLOADS_DIR);
  }

  /** 保存は 1 本ずつ順に行う（並行の書き込みと、消す処理との競合を避ける） */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 検査して保存し、絶対パスを返す。パスはここで作る（画面からは受け取らない）。 */
  async save(data: Buffer): Promise<{ path: string }> {
    if (data.length > this.maxBytes) throw new UploadTooLargeError("image too large");
    const kind = detectImage(data);
    if (kind === null) throw new SessionInputError("image must be PNG or JPEG");
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      await chmod(this.dir, DIR_MODE);
      const file = path.join(this.dir, `${randomUUID()}.${kind}`);
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, data, { mode: FILE_MODE });
      await chmod(tmp, FILE_MODE);
      await rename(tmp, file);
      await this.prune(path.basename(file));
      return { path: file };
    });
  }

  /** 画像以外のファイルを、種類を問わず保存する。dataDir/uploads/files/<UUID>/<直した名前>。パスはここで作る。 */
  async saveFile(name: string, data: Buffer): Promise<{ path: string }> {
    if (data.length > this.maxBytes) throw new UploadTooLargeError("file too large");
    return this.serial(async () => {
      const files = path.join(this.dir, UPLOAD_FILES_DIR);
      const id = randomUUID();
      const dir = path.join(files, id);
      await mkdir(files, { recursive: true, mode: DIR_MODE });
      await chmod(files, DIR_MODE);
      await mkdir(dir, { mode: DIR_MODE });
      await chmod(dir, DIR_MODE);
      const final = path.join(dir, safeUploadName(name));
      if (path.dirname(final) !== dir) throw new Error("unsafe upload path");
      const tmp = path.join(dir, `.${randomUUID()}.tmp`);
      await writeFile(tmp, data, { mode: FILE_MODE });
      await chmod(tmp, FILE_MODE);
      await rename(tmp, final);
      await this.pruneFiles(files, id);
      return { path: final };
    });
  }

  /** 残す数を超えた分を、フォルダの更新時刻が古い順に消す。消すのは UUID 名で中が普通のファイルだけのフォルダ。 */
  private async pruneFiles(files: string, justSaved: string): Promise<void> {
    const names = (await readdir(files)).filter((n) => UPLOAD_DIR_PATTERN.test(n));
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const st = await lstat(path.join(files, name));
          return st.isDirectory() ? { name, mtimeMs: st.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );
    const newestFirst = entries
      .filter((e): e is { name: string; mtimeMs: number } => e !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
    for (const old of newestFirst.slice(this.maxKeep)) {
      if (old.name === justSaved) continue;
      try {
        const dir = path.join(files, old.name);
        const inner = await readdir(dir);
        const stats = await Promise.all(inner.map((n) => lstat(path.join(dir, n))));
        if (!stats.every((st) => st.isFile())) continue;
        for (const n of inner) await unlink(path.join(dir, n));
        await rmdir(dir);
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
    }
  }

  /** 残す枚数を超えた分を、更新時刻（rename の後の mtime）が古い順に消す。消すのは UUID の名前のファイルだけ。 */
  private async prune(justSaved: string): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => UPLOAD_FILE_PATTERN.test(n));
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtimeMs: (await stat(path.join(this.dir, name))).mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const newestFirst = entries
      .filter((e): e is { name: string; mtimeMs: number } => e !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
    for (const old of newestFirst.slice(this.maxKeep)) {
      if (old.name === justSaved) continue;
      try {
        await unlink(path.join(this.dir, old.name));
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
    }
  }
}
