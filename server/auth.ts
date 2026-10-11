import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clientProof, serverProof } from "./pair-proof.ts";

const TOKEN_BYTES = 32;
const MIN_FIXED_TOKEN_LENGTH = 32;
const FIXED_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSIONS = 64;
const MAX_PENDING_CODES = 64;

/** 起動アプリが発行するペアリングコードの有効期間。 */
export const PAIRING_TTL_MS = 30_000;
/** 開発時に起動ログへ出すペアリングコードの有効期間。 */
export const DEV_PAIRING_TTL_MS = 5 * 60_000;
/** 相互認証のチャレンジ（snonce）の有効期間。 */
export const CHALLENGE_TTL_MS = 30_000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const SESSION_SUBPROTOCOL_PREFIX = "ac.";

const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
const PROOF_PATTERN = /^[0-9a-f]{64}$/;

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

export type AuthMethod = "bearer" | "session";

export interface RequestCredentials {
  authorization?: string;
  /** Sec-WebSocket-Protocol に載った値（ac.<セッショントークン>）。 */
  protocols?: readonly string[];
}

export interface Challenge {
  snonce: string;
  proof: string;
}

export interface Auth {
  /** サーバー秘密（Bearer）またはセッショントークン（Bearer / ac.<token> サブプロトコル）。どちらでもなければ null。 */
  authenticate(credentials: RequestCredentials): AuthMethod | null;
  isOriginAllowed(origin: string | undefined): boolean;
  isHostAllowed(host: string | undefined): boolean;
  /** 相互認証 1/2: cnonce に対し snonce とサーバーの証明を返す。cnonce が不正なら null。 */
  issueChallenge(cnonce: string): Challenge | null;
  /** 相互認証 2/2: クライアントの証明が正しければペアリングコードを返す。snonce は成否にかかわらず消費される。 */
  redeemChallenge(input: { cnonce: string; snonce: string; proof: string }): string | null;
  issuePairingCode(ttlMs: number): string;
  /** コードを消費してセッショントークンを返す。無効・失効・再使用は null。 */
  consumePairingCode(code: string): string | null;
  revokeSession(token: string): boolean;
  /** WebSocket の要求サブプロトコルから、有効なセッションの `ac.<token>` をそのまま返す（応答に同じ値を返すため）。 */
  sessionFromProtocols(protocols: readonly string[]): string | null;
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

export function createAuth(secret: string, port: number, options: AuthOptions = {}): Auth {
  const now = options.now ?? Date.now;
  const ownOrigin = `http://127.0.0.1:${port}`;
  const ownHost = `127.0.0.1:${port}`;
  const secretDigest = sha256(secret);
  // コードもセッションもハッシュで保持し、全件を定数時間で比較する（入力値の一致位置が漏れない）
  const codes = new Map<string, { digest: Buffer; expiresAt: number }>();
  const sessions = new Map<string, { digest: Buffer; expiresAt: number }>();
  const challenges = new Map<string, { cnonce: string; expiresAt: number }>();

  const purge = (): void => {
    const t = now();
    for (const [key, v] of codes) if (v.expiresAt <= t) codes.delete(key);
    for (const [key, v] of sessions) if (v.expiresAt <= t) sessions.delete(key);
    for (const [key, v] of challenges) if (v.expiresAt <= t) challenges.delete(key);
  };

  const findByDigest = (store: Map<string, { digest: Buffer; expiresAt: number }>, value: string): string | null => {
    const digest = sha256(value);
    let found: string | null = null;
    for (const [key, v] of store) {
      if (safeEqualDigest(v.digest, digest)) found = key;
    }
    return found;
  };

  const dropOldest = (store: Map<string, unknown>, max: number): void => {
    if (store.size < max) return;
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  };

  const sessionKey = (token: string): string | null => {
    purge();
    return findByDigest(sessions, token);
  };

  return {
    authenticate({ authorization, protocols }) {
      if (authorization?.startsWith("Bearer ")) {
        const presented = authorization.slice("Bearer ".length);
        if (safeEqualDigest(sha256(presented), secretDigest)) return "bearer";
        if (sessionKey(presented) !== null) return "session";
      }
      for (const protocol of protocols ?? []) {
        if (protocol.startsWith(SESSION_SUBPROTOCOL_PREFIX) && sessionKey(protocol.slice(SESSION_SUBPROTOCOL_PREFIX.length)) !== null) {
          return "session";
        }
      }
      return null;
    },
    sessionFromProtocols(protocols) {
      for (const protocol of protocols) {
        if (protocol.startsWith(SESSION_SUBPROTOCOL_PREFIX) && sessionKey(protocol.slice(SESSION_SUBPROTOCOL_PREFIX.length)) !== null) {
          return protocol;
        }
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
    issueChallenge(cnonce) {
      if (!NONCE_PATTERN.test(cnonce)) return null;
      purge();
      dropOldest(challenges, MAX_PENDING_CODES);
      const snonce = randomBytes(TOKEN_BYTES).toString("hex");
      challenges.set(snonce, { cnonce, expiresAt: now() + CHALLENGE_TTL_MS });
      return { snonce, proof: serverProof(secret, cnonce, snonce) };
    },
    redeemChallenge({ cnonce, snonce, proof }) {
      purge();
      const pending = challenges.get(snonce);
      // 成否にかかわらず 1 回で消費する（証明の総当たりをさせない）
      challenges.delete(snonce);
      if (!pending || pending.cnonce !== cnonce || !PROOF_PATTERN.test(proof)) return null;
      const expected = Buffer.from(clientProof(secret, cnonce, snonce), "hex");
      const given = Buffer.from(proof, "hex");
      if (!safeEqualDigest(expected, given)) return null;
      return this.issuePairingCode(PAIRING_TTL_MS);
    },
    issuePairingCode(ttlMs) {
      purge();
      dropOldest(codes, MAX_PENDING_CODES);
      const code = randomBytes(TOKEN_BYTES).toString("hex");
      codes.set(code, { digest: sha256(code), expiresAt: now() + ttlMs });
      return code;
    },
    consumePairingCode(code) {
      purge();
      const key = findByDigest(codes, code);
      if (key === null) return null;
      codes.delete(key);
      dropOldest(sessions, MAX_SESSIONS);
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      sessions.set(token, { digest: sha256(token), expiresAt: now() + SESSION_MAX_MS });
      return token;
    },
    revokeSession(token) {
      const key = sessionKey(token);
      if (key === null) return false;
      sessions.delete(key);
      return true;
    },
  };
}
