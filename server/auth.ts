import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { createSerial, writeJsonAtomic } from "./json-store.ts";
import { clientProof, serverProof } from "./pair-proof.ts";

const TOKEN_BYTES = 32;
const MIN_FIXED_TOKEN_LENGTH = 32;
const FIXED_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSIONS = 64;
const MAX_PENDING_CODES = 64;
const MAX_PENDING_CHALLENGES = 64;

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

/** issueChallenge の結果: 形式不正 / 保留が上限（古いものを押し出さずに拒否する） / 成功。 */
export type ChallengeResult = Challenge | "invalid" | "busy";

export interface Auth {
  /** サーバー秘密（Bearer）またはセッショントークン（Bearer / ac.<token> サブプロトコル）。どちらでもなければ null。 */
  authenticate(credentials: RequestCredentials): AuthMethod | null;
  isOriginAllowed(origin: string | undefined): boolean;
  isHostAllowed(host: string | undefined): boolean;
  /** 相互認証 1/2: cnonce に対し snonce とサーバーの証明を返す。cnonce が不正なら "invalid"、保留が上限なら "busy"。 */
  issueChallenge(cnonce: string): ChallengeResult;
  /** 相互認証 2/2: クライアントの証明が正しければペアリングコードを返す。snonce は成否にかかわらず消費される。 */
  redeemChallenge(input: { cnonce: string; snonce: string; proof: string }): string | null;
  issuePairingCode(ttlMs: number): string;
  /** コードを消費してセッショントークンを返す。無効・失効・再使用は null。 */
  consumePairingCode(code: string): string | null;
  revokeSession(token: string): boolean;
  /** 要求が有効なセッション（Bearer か ac.<token> サブプロトコル）を示していれば、そのトークンを返す。秘密の Bearer は null。 */
  sessionTokenOf(credentials: RequestCredentials): string | null;
  /** セッションがまだ有効か（失効・期限切れなら false）。 */
  isSessionValid(token: string): boolean;
  /** セッションが失効（ログアウト）したときに呼ばれる。期限切れは isSessionValid の定期確認で検出する。 */
  onSessionRevoked(listener: (token: string) => void): void;
  /** WebSocket の要求サブプロトコルから、有効なセッションの `ac.<token>` をそのまま返す（応答に同じ値を返すため）。 */
  sessionFromProtocols(protocols: readonly string[]): string | null;
}

export interface AuthOptions {
  now?: () => number;
  /** ログイン（セッション）の記録を残すファイル。無ければメモリだけ（試験・自己診断のサーバー）。 */
  sessionsFile?: string;
  /** 記録の読み書きの失敗を知らせる先（既定は console.error。トークンは渡さない） */
  onPersistError?: (message: string) => void;
}

/** ログインの記録を残すのは本番のポートで起動したときだけ（AGENT_CONSOLE_PORT が未設定か空）。picker-extension の isPickerSetupEnabled と同じ式。 */
export const isAuthPersistEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === "";

const SESSIONS_FILE_VERSION = 1;
const SECRET_TAG_LABEL = "agent-console auth-sessions v1";
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;

interface StoredSession {
  digest: string;
  expiresAt: number;
}

const secretTagOf = (secret: string): string => createHmac("sha256", secret).update(SECRET_TAG_LABEL).digest("hex");

const pad2 = (n: number): string => String(n).padStart(2, "0");
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

function isStoredSession(v: unknown): v is StoredSession {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.digest === "string" && DIGEST_HEX_PATTERN.test(o.digest) && typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqualDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 合言葉の定数時間比較（拡張の合言葉・予約の合言葉の受け取り口が共有する）。文字列でなければ false */
export const sameSecret = (given: unknown, expected: string): boolean => typeof given === "string" && safeEqualDigest(sha256(given), sha256(expected));

export function createAuth(secret: string, port: number, options: AuthOptions = {}): Auth {
  const now = options.now ?? Date.now;
  const ownOrigin = `http://127.0.0.1:${port}`;
  const ownHost = `127.0.0.1:${port}`;
  const secretDigest = sha256(secret);
  // コードもセッションもハッシュで保持し、全件を定数時間で比較する（入力値の一致位置が漏れない）
  const codes = new Map<string, { digest: Buffer; expiresAt: number }>();
  // キーはトークンの sha256（16 進）。生のトークンはメモリにもファイルにも持たない
  const sessions = new Map<string, { digest: Buffer; expiresAt: number }>();
  const challenges = new Map<string, { cnonce: string; expiresAt: number }>();
  const revokedListeners: Array<(token: string) => void> = [];

  const sessionsFile = options.sessionsFile;
  const reportPersistError = options.onPersistError ?? ((message: string): void => console.error(message));
  const serial = createSerial();
  const secretTag = secretTagOf(secret);

  /** メモリの全セッションをファイルへ写す（直列・失敗してもメモリで続ける） */
  const persist = (): void => {
    if (sessionsFile === undefined) return;
    const items: StoredSession[] = [...sessions.values()].map((v) => ({ digest: v.digest.toString("hex"), expiresAt: v.expiresAt }));
    void serial(() => writeJsonAtomic(sessionsFile, { version: SESSIONS_FILE_VERSION, secretTag, items })).catch((err: unknown) =>
      reportPersistError(`auth-sessions の保存に失敗しました: ${(err as { code?: string }).code ?? "error"}`),
    );
  };

  const loadSessions = (file: string): void => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") reportPersistError(`auth-sessions を読めませんでした: ${(err as { code?: string }).code ?? "error"}`);
      return;
    }
    let items: StoredSession[] | null = null;
    let tagMatches = false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const o = parsed as Record<string, unknown>;
        if (o.version === SESSIONS_FILE_VERSION && typeof o.secretTag === "string" && Array.isArray(o.items) && o.items.every(isStoredSession)) {
          items = o.items as StoredSession[];
          tagMatches = o.secretTag === secretTag;
        }
      }
    } catch {
      items = null;
    }
    if (items === null) {
      // 壊れている: 空で始め、壊れたファイルは名前を変えて残す（ログインし直しで済むので止めない）
      try {
        renameSync(file, `${file}.broken-${stamp(new Date(now()))}`);
      } catch {
        reportPersistError("壊れた auth-sessions の名前を変えられませんでした");
      }
      return;
    }
    if (!tagMatches) return; // secret が変わった: 前のログインは全部無効
    const t = now();
    const alive = items.filter((v) => v.expiresAt > t).sort((a, b) => a.expiresAt - b.expiresAt).slice(-MAX_SESSIONS);
    for (const v of alive) sessions.set(v.digest, { digest: Buffer.from(v.digest, "hex"), expiresAt: v.expiresAt });
  };
  if (sessionsFile !== undefined) loadSessions(sessionsFile);

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
      if (!NONCE_PATTERN.test(cnonce)) return "invalid";
      purge();
      // 上限に達したら新規を拒否する。古い（launcher が待っている）チャレンジを押し出して妨害されないようにする
      if (challenges.size >= MAX_PENDING_CHALLENGES) return "busy";
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
      const digest = sha256(token);
      sessions.set(digest.toString("hex"), { digest, expiresAt: now() + SESSION_MAX_MS });
      persist();
      return token;
    },
    revokeSession(token) {
      const key = sessionKey(token);
      if (key === null) return false;
      sessions.delete(key);
      persist();
      for (const listener of revokedListeners) listener(token);
      return true;
    },
    sessionTokenOf({ authorization, protocols }) {
      if (authorization?.startsWith("Bearer ")) {
        const presented = authorization.slice("Bearer ".length);
        if (!safeEqualDigest(sha256(presented), secretDigest) && sessionKey(presented) !== null) return presented;
      }
      for (const protocol of protocols ?? []) {
        if (!protocol.startsWith(SESSION_SUBPROTOCOL_PREFIX)) continue;
        const token = protocol.slice(SESSION_SUBPROTOCOL_PREFIX.length);
        if (sessionKey(token) !== null) return token;
      }
      return null;
    },
    isSessionValid(token) {
      return sessionKey(token) !== null;
    },
    onSessionRevoked(listener) {
      revokedListeners.push(listener);
    },
  };
}
