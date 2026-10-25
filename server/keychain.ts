import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidSecret } from "./auth.ts";

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = "agent-console";
export const KEYCHAIN_ACCOUNT = "server";
const KEYCHAIN_TIMEOUT_MS = 10_000;

/** キーチェーンからサーバー秘密を読む。失敗は例外（起動中止）。出力・秘密はエラー文面に含めない。 */
export async function readKeychainSecret(securityBin: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(securityBin, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], {
      timeout: KEYCHAIN_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new Error("keychain: サーバー秘密を読めませんでした（scripts/ac-install.sh で導入してください）");
  }
  const secret = stdout.trim();
  if (!isValidSecret(secret)) throw new Error("keychain: 保存されている秘密の形式が不正です（32 文字以上・英数字と - _ のみ）");
  return secret;
}

/** 受け口が読む Keychain の項目（設計 discord-pdca §4-6。service は KEYCHAIN_SERVICE で同じ） */
export type DiscordKeychainAccount = "discord-bot" | "discord-report-webhook";

/** 項目を読む。読めなければ例外（文に値も出力も入れない）。形の検査は呼び出し側（discord-credentials.ts） */
export async function readKeychainItem(securityBin: string, account: DiscordKeychainAccount): Promise<string> {
  try {
    const { stdout } = await execFileAsync(securityBin, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
      timeout: KEYCHAIN_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error(`keychain: ${account} を読めませんでした（scripts/ac-discord-secret.sh で登録してください）`);
  }
}
