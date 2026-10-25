import { DISCORD_API_BASE, DISCORD_HOST } from "./discord-credentials.ts";

/** Discord への通信はこのファイルだけ。失敗の文・ログにトークンと URL を出さない */
export const REQUEST_TIMEOUT_MS = 10_000;
export const WEBHOOK_CONTENT_MAX = 2000;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "rateLimited"; retryAfterMs: number | null }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "forbidden" | "notFound"; status: number }
  | { ok: false; kind: "failed"; reason: "http" | "timeout" | "network" | "badJson" | "badHost"; status?: number };

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: { id: string; bot?: boolean };
  content: string;
  timestamp: string;
  webhook_id?: string;
  type: number;
}

export interface DiscordApi {
  listMessagesAfter(token: string, channelId: string, after: string | null): Promise<ApiResult<DiscordMessage[]>>;
  getChannel(token: string, channelId: string): Promise<ApiResult<{ guild_id: string | null }>>;
  getCurrentUser(token: string): Promise<ApiResult<{ id: string }>>;
  executeWebhook(url: string, content: string): Promise<ApiResult<null>>;
}

const defaultFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function toMessage(v: unknown): DiscordMessage | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.channel_id) || !isStr(v.content) || !isStr(v.timestamp) || typeof v.type !== "number") return null;
  const a = v.author;
  if (!isObj(a) || !isStr(a.id)) return null;
  if (a.bot !== undefined && typeof a.bot !== "boolean") return null;
  if (v.webhook_id !== undefined && v.webhook_id !== null && !isStr(v.webhook_id)) return null;
  return {
    id: v.id,
    channel_id: v.channel_id,
    author: { id: a.id, ...(a.bot !== undefined ? { bot: a.bot } : {}) },
    content: v.content,
    timestamp: v.timestamp,
    ...(isStr(v.webhook_id) ? { webhook_id: v.webhook_id } : {}),
    type: v.type,
  };
}

function retryAfterMs(body: unknown, header: string | null): number | null {
  if (isObj(body) && typeof body.retry_after === "number" && Number.isFinite(body.retry_after) && body.retry_after >= 0) return Math.ceil(body.retry_after * 1000);
  if (header !== null && header.trim() !== "") {
    const s = Number(header);
    if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  }
  return null;
}

export function createDiscordApi(fetchFn: FetchFn = defaultFetch, timeoutMs: number = REQUEST_TIMEOUT_MS): DiscordApi {
  async function request<T>(url: string, init: { method: string; headers: Record<string, string>; body?: string }, ok: (status: number, body: unknown) => ApiResult<T>): Promise<ApiResult<T>> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { ok: false, kind: "failed", reason: "badHost" };
    }
    if (host !== DISCORD_HOST) return { ok: false, kind: "failed", reason: "badHost" };
    let status: number;
    let retryHeader: string | null;
    let text: string;
    try {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      retryHeader = res.headers.get("Retry-After");
      text = await res.text();
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      return { ok: false, kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
    let body: unknown;
    let parsed = true;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = false;
    }
    if (status === 429) return { ok: false, kind: "rateLimited", retryAfterMs: retryAfterMs(parsed ? body : undefined, retryHeader) };
    if (status === 401) return { ok: false, kind: "unauthorized" };
    if (status === 403) return { ok: false, kind: "forbidden", status };
    if (status === 404) return { ok: false, kind: "notFound", status };
    if (status < 200 || status >= 300) return { ok: false, kind: "failed", reason: "http", status };
    if (!parsed) return ok(status, Symbol.for("badJson"));
    return ok(status, body);
  }

  const BAD = Symbol.for("badJson");
  const badJson = { ok: false, kind: "failed", reason: "badJson" } as const;
  const bot = (token: string): Record<string, string> => ({ Authorization: `Bot ${token}` });

  return {
    listMessagesAfter: (token, channelId, after) =>
      request(`${DISCORD_API_BASE}/channels/${channelId}/messages?limit=100${after !== null ? `&after=${after}` : ""}`, { method: "GET", headers: bot(token) }, (_s, body) => {
        if (body === BAD || !Array.isArray(body)) return badJson;
        const out: DiscordMessage[] = [];
        for (const item of body) {
          const m = toMessage(item);
          if (m === null) return badJson;
          out.push(m);
        }
        return { ok: true, value: out };
      }),
    getChannel: (token, channelId) =>
      request(`${DISCORD_API_BASE}/channels/${channelId}`, { method: "GET", headers: bot(token) }, (_s, body) => {
        if (body === BAD || !isObj(body)) return badJson;
        const g = body.guild_id;
        return { ok: true, value: { guild_id: isStr(g) ? g : null } };
      }),
    getCurrentUser: (token) =>
      request(`${DISCORD_API_BASE}/users/@me`, { method: "GET", headers: bot(token) }, (_s, body) => {
        if (body === BAD || !isObj(body) || !isStr(body.id)) return badJson;
        return { ok: true, value: { id: body.id } };
      }),
    executeWebhook: (url, content) =>
      request(`${url}?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: content.slice(0, WEBHOOK_CONTENT_MAX), allowed_mentions: { parse: [] } }) }, (status) =>
        // wait=true が効いていれば 200。204 は効いていない（保存されなかったかもしれない）ので失敗扱い
        status === 200 ? { ok: true, value: null } : { ok: false, kind: "failed", reason: "http", status },
      ),
  };
}
