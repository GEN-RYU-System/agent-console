import type { ActivityResponse, BoardResponse, ChatResponse, ConsoleState, DiffComment, DiffCommentInput, DiffList, FileDiff, LedgerSnapshot, MemorySnapshot, PickItem, PrResponse, QuickPrompt, ResumeTarget, Routine, RoutineInput } from "./types";

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
export const renameSession = (id: string, name: string): Promise<{ mode: "claude" | "app" | "queued" }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name }) });
/** 動いているセッションを閉じる（止まっているものは一覧から外す）。確認は画面側で行ってから呼ぶ。 */
export const closeSession = (id: string): Promise<{ closed: boolean }> => request(`/api/sessions/${encodeURIComponent(id)}/close`, { method: "POST" });
/** セッションの並び順を変える（toIndex は動かしたあとの位置）。画面はサーバーの合図（snapshot）で並び直る。 */
export const moveSession = (id: string, toIndex: number): Promise<{ moved: boolean }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ toIndex }) });
export const fetchQuickPrompts = (): Promise<{ items: QuickPrompt[] }> => request("/api/quick-prompts");
export const createQuickPrompt = (input: { label: string; text: string }): Promise<QuickPrompt> =>
  request("/api/quick-prompts", { method: "POST", body: JSON.stringify(input) });
export const updateQuickPrompt = (id: string, input: { label: string; text: string } | { pinned: boolean }): Promise<QuickPrompt> =>
  request(`/api/quick-prompts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteQuickPrompt = (id: string): Promise<{ removed: boolean }> =>
  request(`/api/quick-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
/** サーバーが状態を取り直して、入れてよければ本文を返す（サーバーは端末へ書かない。画面が paste() で入れる）。 */
export const moveQuickPrompt = (id: string, direction: "up" | "down"): Promise<{ moved: boolean }> =>
  request(`/api/quick-prompts/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ direction }) });
export const checkQuickPromptSend = (sessionId: string, promptId: string): Promise<{ text: string }> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/send-check`, { method: "POST", body: JSON.stringify({ promptId }) });
export const fetchResumeTargets = (): Promise<{ items: ResumeTarget[] }> => request("/api/resume-targets");
/** 再開用の端末を開く。会話の選択は端末内の Claude 公式の選択リストで人が行う（kind と path だけを送る）。 */
export const resumeSession = (target: Pick<ResumeTarget, "kind" | "path">): Promise<{ id: string }> =>
  request("/api/sessions/resume", { method: "POST", body: JSON.stringify({ kind: target.kind, path: target.path }) });
const diffBase = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}`;
export const fetchDiff = (sessionId: string): Promise<DiffList> => request(`${diffBase(sessionId)}/diff`);
export const fetchDiffFile = (sessionId: string, path: string): Promise<FileDiff> => request(`${diffBase(sessionId)}/diff/file?path=${encodeURIComponent(path)}`);
export const fetchDiffComments = (sessionId: string): Promise<{ items: DiffComment[] }> => request(`${diffBase(sessionId)}/diff-comments`);
export const createDiffComment = (sessionId: string, input: DiffCommentInput): Promise<DiffComment> =>
  request(`${diffBase(sessionId)}/diff-comments`, { method: "POST", body: JSON.stringify(input) });
export const updateDiffComment = (sessionId: string, commentId: string, input: DiffCommentInput): Promise<DiffComment> =>
  request(`${diffBase(sessionId)}/diff-comments/${encodeURIComponent(commentId)}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteDiffComment = (sessionId: string, commentId: string): Promise<{ removed: boolean }> =>
  request(`${diffBase(sessionId)}/diff-comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
/** 未送信のコメントの文章を作らせる。入れてよい状態のときだけ返る（サーバーは端末へ書かない。画面が貼る）。 */
export const checkDiffCommentsSend = (sessionId: string): Promise<{ text: string; ids: string[]; submitDelayMs: number }> =>
  request(`${diffBase(sessionId)}/diff-comments/send-check`, { method: "POST", body: JSON.stringify({}) });
/** 貼り付けが成功したあとに、送ったコメントを送信済みにする。 */
export const markDiffCommentsSent = (sessionId: string, ids: string[]): Promise<{ marked: boolean }> =>
  request(`${diffBase(sessionId)}/diff-comments/mark-sent`, { method: "POST", body: JSON.stringify({ ids }) });
/** 保存済みの写しを返す（GitHub は呼ばない）。 */
export const fetchPr = (sessionId: string): Promise<PrResponse> => request(`${diffBase(sessionId)}/pr`);
/** そのセッションの分をすぐ取り直す（前回から短い間隔以内なら、今の結果が返る）。 */
export const refreshPr = (sessionId: string): Promise<PrResponse> => request(`${diffBase(sessionId)}/pr/refresh`, { method: "POST", body: JSON.stringify({}) });
/** 届いた部品の一覧と、Chrome に読み込む拡張のフォルダの場所。 */
export const fetchPicks = (): Promise<{ items: PickItem[]; extensionDir: string }> => request("/api/picks");
export const updatePickNote = (id: string, note: string): Promise<PickItem> =>
  request(`/api/picks/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ note }) });
export const deletePick = (id: string): Promise<{ removed: boolean }> => request(`/api/picks/${encodeURIComponent(id)}`, { method: "DELETE" });
/** 選んだ部品の依頼文を作らせる。入れてよい状態のときだけ返る（サーバーは端末へ書かない。画面が貼る）。 */
export const checkPicksSend = (sessionId: string, ids: string[]): Promise<{ text: string; ids: string[]; submitDelayMs: number }> =>
  request(`${diffBase(sessionId)}/picks/send-check`, { method: "POST", body: JSON.stringify({ ids }) });
/** 貼り付けが成功したあとに、送った部品を送信済みにする。 */
export const markPicksSent = (ids: string[]): Promise<{ marked: boolean }> => request("/api/picks/mark-sent", { method: "POST", body: JSON.stringify({ ids }) });

/** 部品の画像を data: URL にして返す。画面の CSP は blob: を許さず data: だけ許すので、取得して data: に直す。 */
export async function fetchPickImage(id: string): Promise<string> {
  const token = getSessionToken();
  const res = await fetch(`/api/picks/${encodeURIComponent(id)}/image`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
}
/** 右の欄「作戦ボード」の、動いている担当・最近の入力と、記録の仕組みの点検。 */
export const fetchActivity = (sessionId: string): Promise<ActivityResponse> => request(`${diffBase(sessionId)}/activity`);
/** 右の欄「作戦ボード」の計画（テーマ・KGI・KPI・ロードマップ）。 */
export const fetchBoard = (sessionId: string): Promise<BoardResponse> => request(`${diffBase(sessionId)}/board`);
/** チャットの会話（since より後の分。epoch がサーバーのものと違えば全件が返り reset: true）。 */
export const fetchChat = (sessionId: string, since: number, epoch: string | null): Promise<ChatResponse> =>
  request(`${diffBase(sessionId)}/chat?since=${since}${epoch !== null ? `&epoch=${encodeURIComponent(epoch)}` : ""}`);
/** 送る文章を検査させ、手すきのときだけ本文と待ち時間を返す（サーバーは端末へ書かない。画面が貼って Enter を送る）。 */
/** 送信の予約を足す（端末へはすぐ書かれない。手が空いたらサーバーが 1 件ずつ書く） */
export const queueChat = (sessionId: string, text: string): Promise<{ id: string }> =>
  request(`${diffBase(sessionId)}/chat/queue`, { method: "POST", body: JSON.stringify({ text }) });

/** 予約を取り消す（送信済みで受け取りを確認できていないものも消せる） */
export const cancelChatQueue = (sessionId: string, queueId: string): Promise<{ ok: true }> =>
  request(`${diffBase(sessionId)}/chat/queue/${encodeURIComponent(queueId)}`, { method: "DELETE" });

export const checkChatSend = (sessionId: string, text: string): Promise<{ text: string; submitDelayMs: number }> =>
  request(`${diffBase(sessionId)}/chat/send-check`, { method: "POST", body: JSON.stringify({ text }) });
export const fetchMemory =(): Promise<MemorySnapshot> => request("/api/memory");
export const fetchRoutines = (): Promise<{ items: Routine[] }> => request("/api/routines");
export const createRoutine = (input: RoutineInput): Promise<Routine> => request("/api/routines", { method: "POST", body: JSON.stringify(input) });
export const updateRoutine = (id: string, input: RoutineInput): Promise<Routine> => request(`/api/routines/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
export const setRoutineEnabled = (id: string, enabled: boolean): Promise<Routine> => request(`/api/routines/${encodeURIComponent(id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });

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

const BASE64_CHUNK_BYTES = 0x8000;

/** バイト列を base64 にする。btoa に一度に渡せる長さには限りがあるので、小さく区切って文字にする。 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES));
  return btoa(binary);
}

function readBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(file);
  });
}

/** 端末に貼る画像を保存してもらい、保存先の絶対パスを受け取る（PNG と JPEG だけ。形式と大きさはサーバーが検査する）。 */
export async function uploadImage(file: Blob): Promise<{ path: string }> {
  const data = toBase64(await readBytes(file));
  return request("/api/uploads", { method: "POST", body: JSON.stringify({ data }) });
}
