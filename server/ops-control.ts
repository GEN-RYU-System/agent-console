// 保守 API の全停止の読み取り（設計 discord-pdca §4-4）。鍵・答えの本文を記録・例外の文に入れない。
export const OPS_CONTROL_URL = "https://api.salesanchor.jp/api/v1/ops/control";
export const OPS_CONTROL_TIMEOUT_MS = 10_000;

export type OpsHalt = "running" | "halted" | "unreadable";

export type OpsFetchFn = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const defaultFetch: OpsFetchFn = (url, init) => globalThis.fetch(url, init);

export async function readOpsHalt(token: string | null, fetchFn: OpsFetchFn = defaultFetch, timeoutMs: number = OPS_CONTROL_TIMEOUT_MS): Promise<OpsHalt> {
  if (token === null) return "unreadable";
  try {
    const res = await fetchFn(OPS_CONTROL_URL, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return "unreadable";
    const body: unknown = JSON.parse(await res.text());
    if (typeof body !== "object" || body === null || Array.isArray(body)) return "unreadable";
    const h = (body as Record<string, unknown>).halt_all;
    return h === false ? "running" : h === true ? "halted" : "unreadable";
  } catch {
    return "unreadable";
  }
}
