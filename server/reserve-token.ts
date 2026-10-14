import { randomBytes } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-store.ts";
import { isPickerSetupEnabled } from "./picker-extension.ts";

/** AI 用コマンド（ac-reserve.mjs）が予約の受け取り口へ入るための合言葉ファイル dataDir/reserve-token。書き手はサーバーだけ。 */
export const RESERVE_TOKEN_FILE = "reserve-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_BYTES = 32;

export interface ReserveAccess {
  /** 合言葉。本番のポートでないとき・作れなかったときは null（AI 用の受け取り口は常に 401） */
  token: string | null;
}

async function readExistingToken(file: string): Promise<string | null> {
  try {
    const parsed = await readJsonFile(file);
    if (typeof parsed !== "object" || parsed === null) return null;
    const token = (parsed as { token?: unknown }).token;
    return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** 起動のたびに port は今の値で書き直し、token は既存の正しい値があれば使い続ける。作れなくてもサーバーは止めない。 */
export async function setupReserveToken(opts: { env: Readonly<Record<string, string | undefined>>; dataDir: string; port: number }): Promise<ReserveAccess> {
  if (!isPickerSetupEnabled(opts.env)) return { token: null };
  try {
    const file = path.join(opts.dataDir, RESERVE_TOKEN_FILE);
    const token = (await readExistingToken(file)) ?? randomBytes(TOKEN_BYTES).toString("hex");
    await writeJsonAtomic(file, { port: opts.port, token });
    return { token };
  } catch (err) {
    console.error("reserve: cannot write the token file:", err instanceof Error ? err.message : err);
    return { token: null };
  }
}
