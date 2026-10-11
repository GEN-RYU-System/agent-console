import type { ConsoleState, LedgerSnapshot } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// 認証はセッション Cookie（HttpOnly。JS からは見えない）。URL に秘密は載せない。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
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

export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
