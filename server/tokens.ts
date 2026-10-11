import { readFile } from "node:fs/promises";
import path from "node:path";

/** sa-sync が書いた展開元コミット SHA。無ければ空文字。 */
export async function readSaSource(cwd: string = process.cwd()): Promise<string> {
  try {
    return (await readFile(path.join(cwd, ".sa-cache", "SOURCE"), "utf8")).trim();
  } catch {
    return "";
  }
}
