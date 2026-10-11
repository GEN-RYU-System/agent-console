import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;
const MIN_FIXED_TOKEN_LENGTH = 32;
const FIXED_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSIONS = 64;
const MAX_PENDING_CODES = 64;

export const SESSION_COOKIE_NAME = "ac_session";
/** 起動アプリが発行するペアリングコードの有効期間。 */
export const PAIRING_TTL_MS = 30_000;
/** 開発時に起動ログへ出すペアリングコードの有効期間。 */
export const DEV_PAIRING_TTL_MS = 5 * 60_000;
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;

export interface ResolvedToken {
  token: string;
  /** 環境変数で固定されたトークンか（起動ログで警告する）。 */
  fixed: boolean;
}

/** 通常は起動ごとにランダム生成。e2e 用に AGENT_CONSOLE_TOKEN（32 文字以上・英数字と -_ のみ）で固定できる。値はエラーに出さない。 */
export function resolveToken(env: Record<string, string | undefined>): ResolvedToken {
  const fixed = env.AGENT_CONSOLE_TOKEN;
  if (fixed === undefined || fixed === "") return { token: randomBytes(TOKEN_BYTES).toString("hex"), fixed: false };
  if (!isValidSecret(fixed)) {
    throw new Error(`AGENT_CONSOLE_TOKEN は ${MIN_FIXED_TOKEN_LENGTH} 文字以上で、英数字と - _ のみにしてください`);
  }
  return { token: fixed, fixed: true };
}

/** サーバー秘密として使える形か（32 文字以上・英数字と - _ のみ）。 */
export function isValidSecret(value: string): boolean {
  return value.length >= MIN_FIXED_TOKEN_LENGTH && FIXED_TOKEN_PATTERN.test(value);
}

export type AuthMethod = "bearer" | "cookie";

export interface RequestCredentials {
  authorization?: string;
  cookie?: string;
}

export interface Auth {
  /** Bearer（サーバー秘密）または有効なセッション Cookie。どちらでもなければ null。 */
  authenticate(credentials: RequestCredentials): AuthMethod | null;
  isOriginAllowed(origin: string | undefined): boolean;
  isHostAllowed(host: string | undefined): boolean;
  issuePairingCode(ttlMs: number): string;
  /** コードを消費してセッション ID を返す。無効・失効・再使用は null。 */
  consumePairingCode(code: string): string | null;
  sessionCookie(sessionId: string): string;
}

export interface AuthOptions {
  now?: () => number;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqualDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createAuth(secret: string, port: number, options: AuthOptions = {}): Auth {
  const now = options.now ?? Date.now;
  const ownOrigin = `http://127.0.0.1:${port}`;
  const ownHost = `127.0.0.1:${port}`;
  const secretDigest = sha256(secret);
  // コードもセッション ID もハッシュで保持し、全件を定数時間で比較する（入力値の一致位置が漏れない）
  const codes = new Map<string, { digest: Buffer; expiresAt: number }>();
  const sessions = new Map<string, { digest: Buffer; expiresAt: number }>();

  const purge = (): void => {
    const t = now();
    for (const [key, v] of codes) if (v.expiresAt <= t) codes.delete(key);
    for (const [key, v] of sessions) if (v.expiresAt <= t) sessions.delete(key);
  };

  const findByDigest = (store: Map<string, { digest: Buffer; expiresAt: number }>, value: string): string | null => {
    const digest = sha256(value);
    let found: string | null = null;
    for (const [key, v] of store) {
      if (safeEqualDigest(v.digest, digest)) found = key;
    }
    return found;
  };

  return {
    authenticate({ authorization, cookie }) {
      if (authorization?.startsWith("Bearer ") && safeEqualDigest(sha256(authorization.slice("Bearer ".length)), secretDigest)) {
        return "bearer";
      }
      const sessionId = readCookie(cookie, SESSION_COOKIE_NAME);
      if (sessionId) {
        purge();
        if (findByDigest(sessions, sessionId) !== null) return "cookie";
      }
      return null;
    },
    isOriginAllowed(origin) {
      return origin === ownOrigin;
    },
    // DNS リバインディング対策: Host が自分自身の待受先（Origin と同じ 127.0.0.1:<port>）以外なら拒否
    isHostAllowed(host) {
      return host === ownHost;
    },
    issuePairingCode(ttlMs) {
      purge();
      if (codes.size >= MAX_PENDING_CODES) {
        // 古いものから捨てる（発行は認証済みの呼び出しだけだが、溜まり続けない）
        const oldest = codes.keys().next().value;
        if (oldest !== undefined) codes.delete(oldest);
      }
      const code = randomBytes(TOKEN_BYTES).toString("hex");
      codes.set(code, { digest: sha256(code), expiresAt: now() + ttlMs });
      return code;
    },
    consumePairingCode(code) {
      purge();
      const key = findByDigest(codes, code);
      if (key === null) return null;
      codes.delete(key);
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      const sessionId = randomBytes(TOKEN_BYTES).toString("hex");
      sessions.set(sessionId, { digest: sha256(sessionId), expiresAt: now() + SESSION_MAX_MS });
      return sessionId;
    },
    sessionCookie(sessionId) {
      return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`;
    },
  };
}
