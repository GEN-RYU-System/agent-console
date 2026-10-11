import { resolveToken } from "./auth.ts";
import { readKeychainSecret } from "./keychain.ts";

export type SecretMode = "keychain" | "fixed" | "random";

export interface ResolvedSecret {
  token: string;
  mode: SecretMode;
}

const DEFAULT_SECURITY_BIN = "/usr/bin/security";

/**
 * サーバー秘密の決定。
 * - AGENT_CONSOLE_AUTH=keychain: キーチェーンから読む（読めなければ例外=起動中止）。固定トークンとの併用は不可。
 * - 未設定: AGENT_CONSOLE_TOKEN（e2e 用の固定）または起動ごとの乱数（開発時）。
 */
export async function resolveSecret(env: Record<string, string | undefined>): Promise<ResolvedSecret> {
  const auth = env.AGENT_CONSOLE_AUTH;
  if (auth === undefined || auth === "") {
    const { token, fixed } = resolveToken(env);
    return { token, mode: fixed ? "fixed" : "random" };
  }
  if (auth !== "keychain") throw new Error("AGENT_CONSOLE_AUTH は keychain のみ指定できます");
  if (env.AGENT_CONSOLE_TOKEN !== undefined && env.AGENT_CONSOLE_TOKEN !== "") {
    throw new Error("AGENT_CONSOLE_AUTH=keychain と AGENT_CONSOLE_TOKEN は同時に指定できません");
  }
  const securityBin = env.AC_SECURITY && env.AC_SECURITY !== "" ? env.AC_SECURITY : DEFAULT_SECURITY_BIN;
  return { token: await readKeychainSecret(securityBin), mode: "keychain" };
}
