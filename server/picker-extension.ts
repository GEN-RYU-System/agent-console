import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Chrome 拡張の合言葉（dataDir/picker-token）と、PO が Chrome に読み込む拡張のフォルダ（dataDir/chrome-extension）。 */

export const PICKER_TOKEN_FILE = "picker-token";
export const EXTENSION_DIR_NAME = "chrome-extension";
/** 作り直しの途中で使う 2 つの名前。消すのは、この 3 つの名前（dataDir 直下）の完全一致だけ。 */
const NEW_SUFFIX = ".new";
const OLD_SUFFIX = ".old";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_BYTES = 32;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ID_BYTES = 16;
const SOURCE_FILES = ["background.js", "picker.js", "picker.css", "picker-tokens.css"] as const;
const SOURCE_DIRS = ["_locales"] as const;

export interface PickerAccess {
  /** `chrome-extension://<固定 id>`。受け取り口の Origin 検査の相手。拡張の鍵を読めなければ null */
  extensionOrigin: string | null;
  /** 合言葉。本番のポートでないとき・作れなかったときは null（受け取り口は常に 403） */
  token: string | null;
  /** PO が Chrome に読み込むフォルダの場所（画面に出す） */
  extensionDir: string;
}

/** manifest の key（公開鍵の base64）から Chrome の拡張 id（a-p の 32 文字）を求める。 */
export function extensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, "base64");
  if (der.length === 0) throw new Error("manifest key is empty or not base64");
  const head = createHash("sha256").update(der).digest().subarray(0, ID_BYTES);
  return [...head].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

/** 拡張のフォルダと合言葉を作るのは本番のポートで起動したときだけ（AGENT_CONSOLE_PORT が設定されていれば作らない）。 */
export const isPickerSetupEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === "";

async function readToken(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, "utf8")).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/** 合言葉の正本。無ければ（または壊れていれば）32 bytes の乱数を作って保存する。 */
export async function ensurePickerToken(dataDir: string): Promise<string> {
  const file = path.join(dataDir, PICKER_TOKEN_FILE);
  const existing = await readToken(file);
  if (existing !== null) return existing;
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: FILE_MODE });
  await chmod(tmp, FILE_MODE);
  await rename(tmp, file);
  return token;
}

export interface RebuildOptions {
  sourceDir: string;
  dataDir: string;
  port: number;
  token: string;
}

/** dataDir 直下の、決まった 3 つの名前だけを消す（rm のパスは、この関数が名前から組み立てた完全一致のものだけ）。 */
async function removeKnown(dataDir: string, name: typeof EXTENSION_DIR_NAME | `${typeof EXTENSION_DIR_NAME}${typeof NEW_SUFFIX}` | `${typeof EXTENSION_DIR_NAME}${typeof OLD_SUFFIX}`): Promise<void> {
  await rm(path.join(dataDir, name), { recursive: true, force: true });
}

async function writeExtensionFiles(opts: RebuildOptions, dest: string): Promise<void> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error("port must be an integer between 1 and 65535");
  if (!TOKEN_PATTERN.test(opts.token)) throw new Error("token must be 64 hex digits");
  for (const file of SOURCE_FILES) {
    try {
      await stat(path.join(opts.sourceDir, file));
    } catch {
      throw new Error(`extension source is missing ${file}${file === "picker-tokens.css" ? "（npm run build で作ります）" : ""}`);
    }
  }
  await mkdir(dest, { recursive: true, mode: DIR_MODE });
  for (const file of SOURCE_FILES) await cp(path.join(opts.sourceDir, file), path.join(dest, file));
  for (const dir of SOURCE_DIRS) await cp(path.join(opts.sourceDir, dir), path.join(dest, dir), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(opts.sourceDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const withHost = { ...manifest, host_permissions: [`http://127.0.0.1:${opts.port}/*`] };
  await writeFile(path.join(dest, "manifest.json"), `${JSON.stringify(withHost, null, 2)}\n`);
  // 合言葉の写し。正本は dataDir/picker-token で、起動のたびにここから作り直す
  const configPath = path.join(dest, "config.js");
  await writeFile(configPath, `self.AC_PICKER = ${JSON.stringify({ port: opts.port, token: opts.token })};\n`, { mode: FILE_MODE });
  await chmod(configPath, FILE_MODE);
}

/**
 * dataDir/chrome-extension を作り直す（版を上げても場所が変わらないように、同じ場所へ）。
 * 0. 前回の途中で残った .new / .old を消す  1. .new に作る  2. 今のものを .old へ rename  3. .new を本番の名前へ rename  4. .old を消す
 * 作るのに失敗したら、今のフォルダには触れない。
 */
export async function rebuildExtensionFolder(opts: RebuildOptions): Promise<string> {
  const { dataDir } = opts;
  const current = path.join(dataDir, EXTENSION_DIR_NAME);
  const fresh = `${current}${NEW_SUFFIX}`;
  const old = `${current}${OLD_SUFFIX}`;
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  await removeKnown(dataDir, `${EXTENSION_DIR_NAME}${NEW_SUFFIX}`);
  await removeKnown(dataDir, `${EXTENSION_DIR_NAME}${OLD_SUFFIX}`);
  try {
    await writeExtensionFiles(opts, fresh);
  } catch (err) {
    await removeKnown(dataDir, `${EXTENSION_DIR_NAME}${NEW_SUFFIX}`);
    throw err;
  }
  const hadCurrent = await stat(current).then(() => true, () => false);
  if (hadCurrent) await rename(current, old);
  await rename(fresh, current);
  await removeKnown(dataDir, `${EXTENSION_DIR_NAME}${OLD_SUFFIX}`);
  return current;
}

export interface SetupOptions {
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
  port: number;
  sourceDir: string;
}

/** サーバーの起動時に呼ぶ。作れなくてもサーバーは止めない（受け取り口が閉じるだけ）。 */
export async function setupPicker(opts: SetupOptions): Promise<PickerAccess> {
  const extensionDir = path.join(opts.dataDir, EXTENSION_DIR_NAME);
  let extensionOrigin: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(opts.sourceDir, "manifest.json"), "utf8")) as { key?: string };
    extensionOrigin = `chrome-extension://${extensionIdFromKey(manifest.key ?? "")}`;
  } catch (err) {
    console.error("picker: cannot read the extension manifest:", err instanceof Error ? err.message : err);
    return { extensionOrigin: null, token: null, extensionDir };
  }
  if (!isPickerSetupEnabled(opts.env)) return { extensionOrigin, token: null, extensionDir };
  try {
    const token = await ensurePickerToken(opts.dataDir);
    await rebuildExtensionFolder({ sourceDir: opts.sourceDir, dataDir: opts.dataDir, port: opts.port, token });
    return { extensionOrigin, token, extensionDir };
  } catch (err) {
    console.error("picker: cannot build the extension folder:", err instanceof Error ? err.message : err);
    return { extensionOrigin, token: null, extensionDir };
  }
}
