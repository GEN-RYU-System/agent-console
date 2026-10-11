import type { ConsoleState, LedgerSnapshot, MemorySnapshot, PastSession, QuickPrompt } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// 認証はタブの sessionStorage に置いたセッショントークン（オリジン＝ポート単位で分離される）。
// Cookie は使わない（Cookie は同じホストの別ポートへも送られるため）。URL にも秘密を載せない。
const SESSION_KEY = "ac.session";

export function getSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  window.sessionStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage が使えない環境では何もしない */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export const fetchState = (): Promise<ConsoleState> => request("/api/state");
export const fetchLedger = (): Promise<LedgerSnapshot> => request("/api/ledger");
export const refreshLedger = (): Promise<LedgerSnapshot> => request("/api/ledger/refresh", { method: "POST" });
export const removeSession = (id: string): Promise<{ removed: boolean }> =>
  request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const createSession = (input: { name: string; roleId: string; branch?: string }): Promise<{ id: string }> =>
  request("/api/sessions", { method: "POST", body: JSON.stringify(input) });

export const markRead = (id: string): Promise<{ read: boolean }> => request(`/api/sessions/${encodeURIComponent(id)}/read`, { method: "POST" });
export const renameSession = (id: string, name: string): Promise<{ mode: "claude" | "app" }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name }) });
export const fetchQuickPrompts = (): Promise<{ items: QuickPrompt[] }> => request("/api/quick-prompts");
export const createQuickPrompt = (input: { label: string; text: string }): Promise<QuickPrompt> =>
  request("/api/quick-prompts", { method: "POST", body: JSON.stringify(input) });
export const updateQuickPrompt = (id: string, input: { label: string; text: string }): Promise<QuickPrompt> =>
  request(`/api/quick-prompts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteQuickPrompt = (id: string): Promise<{ removed: boolean }> =>
  request(`/api/quick-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
export const sendQuickPrompt = (sessionId: string, promptId: string): Promise<{ sent: boolean }> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/send`, { method: "POST", body: JSON.stringify({ promptId }) });
export const fetchPastSessions = (): Promise<{ available: boolean; items: PastSession[] }> => request("/api/past-sessions");
export const resumeSession = (sessionId: string): Promise<{ id: string }> =>
  request("/api/sessions/resume", { method: "POST", body: JSON.stringify({ sessionId }) });
export const fetchMemory = (): Promise<MemorySnapshot> => request("/api/memory");

/** ペアリングコードを引換えてセッショントークンを得る（認証前の API）。 */
export async function redeemCode(code: string): Promise<string> {
  const res = await fetch("/api/pair/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
  return body.token;
}

/** サーバー側でセッションを失効させ、sessionStorage を消す。 */
export async function logout(): Promise<void> {
  try {
    await request("/api/logout", { method: "POST" });
  } finally {
    clearSessionToken();
  }
}

export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** WebSocket の認証は Sec-WebSocket-Protocol: ac.<セッショントークン>（サーバーが同じ値を応答に返す）。 */
export function openSocket(path: string, params: Record<string, string> = {}): WebSocket {
  const token = getSessionToken();
  return new WebSocket(wsUrl(path, params), token ? [`ac.${token}`] : []);
}
