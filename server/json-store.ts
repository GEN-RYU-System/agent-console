import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 保存ファイル（routines.json・reservations.json）の書き方の正本。tmp に書いて rename、0600、dir 0700。 */
export const JSON_FILE_MODE = 0o600;
export const JSON_DIR_MODE = 0o700;

/** 渡した処理を 1 つずつ順に実行する（前の処理の成否に関わらず次を実行する） */
export function createSerial(): <T>(f: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };
}

/** ファイルを JSON として読む。無ければ undefined。壊れていれば例外（呼び出し側が上書きしないために使う） */
export async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

/** tmp＋rename で書く（書き込み中の読み手が半分だけのファイルを読むことがない） */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: JSON_DIR_MODE });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: JSON_FILE_MODE });
  await chmod(tmp, JSON_FILE_MODE);
  await rename(tmp, file);
}
