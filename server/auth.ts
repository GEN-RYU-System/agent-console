import { randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;
const MIN_FIXED_TOKEN_LENGTH = 32;
const FIXED_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ResolvedToken {
  token: string;
  /** 環境変数で固定されたトークンか（起動ログで警告する）。 */
  fixed: boolean;
}

/** 通常は起動ごとにランダム生成。e2e 用に AGENT_CONSOLE_TOKEN（32 文字以上・英数字と -_ のみ）で固定できる。値はエラーに出さない。 */
export function resolveToken(env: Record<string, string | undefined>): ResolvedToken {
  const fixed = env.AGENT_CONSOLE_TOKEN;
  if (fixed === undefined || fixed === "") return { token: randomBytes(TOKEN_BYTES).toString("hex"), fixed: false };
  if (fixed.length < MIN_FIXED_TOKEN_LENGTH || !FIXED_TOKEN_PATTERN.test(fixed)) {
    throw new Error(`AGENT_CONSOLE_TOKEN は ${MIN_FIXED_TOKEN_LENGTH} 文字以上で、英数字と - _ のみにしてください`);
  }
  return { token: fixed, fixed: true };
}

export interface Auth {
  isTokenValid(url: URL, authorization: string | undefined): boolean;
  isOriginAllowed(origin: string | undefined): boolean;
  isHostAllowed(host: string | undefined): boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createAuth(token: string, port: number): Auth {
  const ownOrigin = `http://127.0.0.1:${port}`;
  const ownHost = `127.0.0.1:${port}`;
  return {
    isTokenValid(url, authorization) {
      const fromQuery = url.searchParams.get("t");
      if (fromQuery !== null && safeEqual(fromQuery, token)) return true;
      if (authorization?.startsWith("Bearer ")) return safeEqual(authorization.slice("Bearer ".length), token);
      return false;
    },
    isOriginAllowed(origin) {
      return origin === ownOrigin;
    },
    // DNS リバインディング対策: Host が自分自身の待受先（Origin と同じ 127.0.0.1:<port>）以外なら拒否
    isHostAllowed(host) {
      return host === ownHost;
    },
  };
}
