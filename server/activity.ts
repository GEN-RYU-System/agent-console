// セッションの様子（担当・やること・入力）の記録を読んで、セッションごとにまとめる。設計 §3-4。
// 正本は dataDir/activity/events-YYYYMMDD.jsonl（UTC の日付、hooks/activity-hook.mjs が追記する）。ここはその写しをメモリに持つだけ。
import { createHash, randomUUID } from "node:crypto";
import { open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const ACTIVITY_DIR_NAME = "activity";
/** 終わりが記録されない担当を「動いている」とみなす最長（L-a）。開始からこれを過ぎたら外す */
export const RUNNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const TASKS_MAX = 50;
export const INPUTS_MAX = 3;
/** セッションごとに覚える担当・入力の上限（メモリが増え続けないため） */
const STARTS_KEEP = 400;
const STOPS_KEEP = 400;
const HANDBACKS_KEEP = 400;
const RESTARTS_KEEP = 400;
const TASKS_KEEP = 200;
const INPUTS_KEEP = 20;
const READ_CHUNK_BYTES = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_FILE = /^events-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const EVENTS = new Set(["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "UserPromptSubmit", "Stop", "StopFailure"]);
/** 右の欄の「最近の入力」に出す文字数（表示のときに切る。記録は全文） */
const INPUT_PREVIEW_CHARS = 80;
/** チャットに残す会話の件数（1 セッション） */
export const CHAT_KEEP = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const AGENT_MESSAGE_PREFIX = /^\s*<agent-message\b/;
/** 貼り付けの包みの行（工程0 (c)。`<pasted_content id="…">` と `</pasted_content id="…">`）。行ごと外す */
const PASTED_WRAPPER_LINE = /^[ \t]*<\/?pasted_content\b[^>\n]*>[ \t]*\n?/gm;

/** 動いている担当 1 つ。終わった担当は画面に出さないので持たない（終わりは「動いている」の判定にだけ使う） */
export interface AgentItem {
  key: string;
  subagentType: string;
  model: string;
  resolvedModel: string;
  /** 頼んだ仕事の説明（Claude が書いた文のまま） */
  description: string;
  /** 動き始めた時刻。再開した担当は、再開（SubagentStart）の時刻 */
  startedAt: number;
}
export interface TaskItem {
  id: string;
  subject: string;
  done: boolean;
}
export interface InputItem {
  ts: number;
  text: string;
}
export interface SessionActivity {
  running: AgentItem[];
  tasks: TaskItem[];
  inputs: InputItem[];
  lastEventAt: number | null;
}
/** チャットの 1 件。user=しんごさんの入力、assistant=Claude の返事（Stop）、error=API エラー（StopFailure。error に種類） */
export interface ChatItem {
  /** そのセッションの中の連番（読み込んだ順）。画面は since=<seq> で続きだけ取る */
  seq: number;
  ts: number;
  role: "user" | "assistant" | "error";
  text: string;
  error?: string;
  /** 記録の時点で長さの上限（64KiB）により切られている */
  truncated?: boolean;
}
export interface ChatPage {
  items: ChatItem[];
  lastSeq: number;
}

/** 同じ会話かどうかの鍵（本文は最大 64KiB なので、そのまま持たずに要約する） */
function chatKey(entry: Omit<ChatItem, "seq">): string {
  return `${entry.role}:${entry.ts}:${entry.error ?? ""}:${createHash("sha1").update(entry.text).digest("base64")}`;
}

/** 貼り付けの包みの行・先頭と末尾の空行を外した表示用の本文。包みが無ければ、先頭と末尾の空行だけを外す */
export function unwrapPasted(body: string): string {
  return body.replace(PASTED_WRAPPER_LINE, "").replace(/^\n+|\n+$/g, "");
}

/** 右の欄の短い項目: 制御文字と連続する空白を空白 1 つにまとめ、先頭 INPUT_PREVIEW_CHARS 字（コードポイント単位） */
function previewOf(body: string): string {
  const flat = body.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, INPUT_PREVIEW_CHARS).join("");
}

type Raw = Record<string, unknown>;
interface Start {
  toolUseId: string;
  ts: number;
  description: string;
  subagentType: string;
  model: string;
}
interface Post {
  ts: number;
  status: string;
  agentId: string;
  resolvedModel: string;
}
interface Task {
  id: string;
  subject: string;
  createdAt: number | null;
  completedAt: number | null;
  seq: number;
}
interface SessionState {
  starts: Map<string, Start>;
  posts: Map<string, Post>;
  /** agent_id → 最後の SubagentStop の時刻 */
  stops: Map<string, number>;
  /** agent_id → 最後の SubagentHandback（報告）の時刻 */
  handbacks: Map<string, number>;
  /** agent_id → 最後の SubagentStart の時刻（担当を呼んだとき・再開したとき） */
  restarts: Map<string, number>;
  tasks: Map<string, Task>;
  inputs: InputItem[];
  chat: ChatItem[];
  /** chat に入っている会話の重なり防止の鍵（同じ記録を読み直しても二重に出さない） */
  chatKeys: Set<string>;
  chatSeq: number;
  lastEventAt: number;
}

const newSession = (): SessionState => ({
  starts: new Map(),
  posts: new Map(),
  stops: new Map(),
  handbacks: new Map(),
  restarts: new Map(),
  tasks: new Map(),
  inputs: [],
  chat: [],
  chatKeys: new Set(),
  chatSeq: 0,
  lastEventAt: 0,
});

const emptyActivity = (): SessionActivity => ({ running: [], tasks: [], inputs: [], lastEventAt: null });

/** 渡された時刻（無いものは除く）のうち一番新しいもの。1 つも無ければ 0 */
const latestOf = (...times: Array<number | undefined>): number => Math.max(0, ...times.map((t) => t ?? 0));

/** map の agent_id に、新しい方の時刻を覚える。件数が上限を超えたら古い時刻から落とす */
function rememberLatest(map: Map<string, number>, agentId: string, ts: number, keep: number): void {
  map.set(agentId, Math.max(map.get(agentId) ?? 0, ts));
  trimOldest(map, keep, (v) => v);
}

/** 件数が上限を超えたら、時刻（ts）の古いものから落とす */
function trimOldest<V>(map: Map<string, V>, keep: number, tsOf: (value: V) => number): void {
  if (map.size <= keep) return;
  const oldestFirst = [...map.entries()].sort((a, b) => tsOf(a[1]) - tsOf(b[1]));
  for (const [key] of oldestFirst.slice(0, map.size - keep)) map.delete(key);
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** events ファイルの名前（UTC の日付） */
export const dayFileName = (ts: number): string => `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;

/** 1 行を読んで、形の合うものだけ返す。合わなければ null（数えて捨てる） */
function parseLine(line: string): Raw | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return null;
  if (typeof parsed.event !== "string" || !EVENTS.has(parsed.event)) return null;
  if (typeof parsed.session_id !== "string" || !SESSION_ID.test(parsed.session_id)) return null;
  return parsed;
}

interface FileCursor {
  offset: number;
}

export class ActivityStore {
  /** このアプリの起動ごとに変わる id。チャットの seq はアプリを起動し直すと振り直されるので、画面は epoch が変わったら全件を取り直す */
  readonly epoch = randomUUID();
  /** 取り込んだ記録の版。変化があったときだけ進む（画面へは WebSocket の合図で伝える） */
  rev = 0;
  /** 読めなかった行の数（起動からの合計） */
  invalidLines = 0;
  private readonly sessions = new Map<string, SessionState>();
  private readonly cursors = new Map<string, FileCursor>();
  private readonly listeners = new Set<(rev: number) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private readonly keepDays: number;
  private readonly now: () => number;

  constructor(
    private readonly dataDir: string,
    options: { keepDays?: number; now?: () => number } = {},
  ) {
    this.keepDays = options.keepDays ?? 7;
    this.now = options.now ?? Date.now;
  }

  get activityDir(): string {
    return path.join(this.dataDir, ACTIVITY_DIR_NAME);
  }

  onChange(listener: (rev: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 今日と昨日のファイルを、前回の読み終わりの位置から読み足す。呼ぶ順に 1 つずつ実行する（重ならない） */
  refresh(): Promise<{ applied: number }> {
    const run = this.queue.then(() => this.readNew());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readNew(): Promise<{ applied: number }> {
    const now = this.now();
    const names = [dayFileName(now - MS_PER_DAY), dayFileName(now)];
    for (const known of [...this.cursors.keys()]) if (!names.includes(known)) this.cursors.delete(known);
    let applied = 0;
    for (const name of names) applied += await this.readFile(name);
    this.dropOldSessions(now);
    if (applied > 0) {
      this.rev += 1;
      for (const listener of this.listeners) listener(this.rev);
    }
    return { applied };
  }

  private async readFile(name: string): Promise<number> {
    const file = path.join(this.activityDir, name);
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) return 0;
    const cursor = this.cursors.get(name) ?? { offset: 0 };
    // 小さくなっていたら作り直されたとみなして先頭から読み直す（担当・やることは id で上書きされ、入力は重複を除く）
    let offset = info.size < cursor.offset ? 0 : cursor.offset;
    let applied = 0;
    const handle = await open(file, "r");
    try {
      while (offset < info.size) {
        const want = Math.min(READ_CHUNK_BYTES, info.size - offset);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buf, 0, want, offset);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        // 書きかけの最後の行は、行が完成する（改行が付く）まで取り込まない
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          if (bytesRead < want || offset + bytesRead >= info.size) break;
          // 1 行がチャンクより長い（想定外）。この行は読めないものとして飛ばす
          offset += bytesRead;
          this.invalidLines += 1;
          continue;
        }
        for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
          if (line === "") continue;
          const record = parseLine(line);
          if (record === null) {
            this.invalidLines += 1;
            continue;
          }
          this.apply(record);
          applied += 1;
        }
        offset += lastNewline + 1;
      }
    } finally {
      await handle.close();
    }
    this.cursors.set(name, { offset });
    return applied;
  }

  private dropOldSessions(now: number): void {
    const cutoff = now - this.keepDays * MS_PER_DAY;
    for (const [id, state] of this.sessions) if (state.lastEventAt < cutoff) this.sessions.delete(id);
  }

  private apply(rec: Raw): void {
    const sessionId = rec.session_id as string;
    const ts = rec.ts as number;
    const state = this.sessions.get(sessionId) ?? newSession();
    this.sessions.set(sessionId, state);
    state.lastEventAt = Math.max(state.lastEventAt, ts);
    const agentId = text(rec.agent_id);
    switch (rec.event) {
      case "PreToolUse":
        this.applyPre(state, rec, ts, agentId);
        break;
      case "PostToolUse":
        this.applyPost(state, rec, ts);
        break;
      case "SubagentStart":
        if (agentId !== "") rememberLatest(state.restarts, agentId, ts, RESTARTS_KEEP);
        break;
      case "SubagentStop":
        if (agentId !== "") rememberLatest(state.stops, agentId, ts, STOPS_KEEP);
        break;
      case "TaskCreated":
      case "TaskCompleted":
        this.applyTask(state, rec, ts);
        break;
      case "UserPromptSubmit":
        this.applyPrompt(state, rec, ts);
        break;
      case "Stop":
        if (text(rec.last_assistant_message) !== "") this.addChat(state, { ts, role: "assistant", text: text(rec.last_assistant_message), ...(rec.truncated === true ? { truncated: true } : {}) });
        break;
      case "StopFailure":
        this.addChat(state, { ts, role: "error", text: "", error: text(rec.error) || "unknown" });
        break;
    }
  }

  /** 会話を 1 件足す。同じ内容（役割・時刻・本文・エラー）がすでにあれば足さない。上限を超えたら ts の古いものから落とす */
  private addChat(state: SessionState, entry: Omit<ChatItem, "seq">): void {
    const key = chatKey(entry);
    if (state.chatKeys.has(key)) return;
    state.chatKeys.add(key);
    state.chatSeq += 1;
    state.chat.push({ seq: state.chatSeq, ...entry });
    if (state.chat.length <= CHAT_KEEP) return;
    const oldestFirst = [...state.chat].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const dropped = oldestFirst.slice(0, state.chat.length - CHAT_KEEP);
    const droppedSeqs = new Set(dropped.map((d) => d.seq));
    for (const d of dropped) state.chatKeys.delete(chatKey(d));
    state.chat = state.chat.filter((c) => !droppedSeqs.has(c.seq));
  }

  private applyPre(state: SessionState, rec: Raw, ts: number, agentId: string): void {
    if (rec.tool === "SubagentHandback") {
      if (agentId !== "") rememberLatest(state.handbacks, agentId, ts, HANDBACKS_KEEP);
      return;
    }
    if (rec.tool !== "Agent") return;
    const toolUseId = text(rec.tool_use_id) || `noid-${(this.seq += 1)}`;
    // agent_id が付いた呼び出しは、担当がさらに呼んだ担当（孫）。出さない（開始として覚えない）
    if (agentId !== "") return;
    state.starts.set(toolUseId, { toolUseId, ts, description: text(rec.description), subagentType: text(rec.subagent_type), model: text(rec.model) });
    if (state.starts.size > STARTS_KEEP) {
      const oldest = [...state.starts.values()].sort((a, b) => a.ts - b.ts)[0];
      state.starts.delete(oldest.toolUseId);
      state.posts.delete(oldest.toolUseId);
    }
  }

  private applyPost(state: SessionState, rec: Raw, ts: number): void {
    if (rec.tool !== "Agent") return;
    const toolUseId = text(rec.tool_use_id);
    if (toolUseId === "") return;
    state.posts.set(toolUseId, { ts, status: text(rec.status), agentId: text(rec.agentId), resolvedModel: text(rec.resolvedModel) });
  }

  private applyTask(state: SessionState, rec: Raw, ts: number): void {
    const id = text(rec.task_id);
    if (id === "") return;
    const previous = state.tasks.get(id);
    const created = rec.event === "TaskCreated";
    state.tasks.set(id, {
      id,
      subject: text(rec.task_subject) || previous?.subject || "",
      createdAt: created ? ts : (previous?.createdAt ?? null),
      completedAt: created ? (previous?.completedAt ?? null) : ts,
      seq: previous?.seq ?? (this.seq += 1),
    });
    trimOldest(state.tasks, TASKS_KEEP, (t) => t.createdAt ?? t.completedAt ?? 0);
  }

  private applyPrompt(state: SessionState, rec: Raw, ts: number): void {
    const raw = text(rec.prompt);
    // 担当の報告の戻りは人の入力ではない（記録は残るが、右の欄にもチャットにも出さない）
    if (rec.source === "agent" || AGENT_MESSAGE_PREFIX.test(raw)) return;
    const shown = unwrapPasted(raw);
    if (shown === "") return;
    this.addChat(state, { ts, role: "user", text: shown, ...(rec.truncated === true ? { truncated: true } : {}) });
    const preview = previewOf(shown);
    if (preview === "" || state.inputs.some((i) => i.ts === ts && i.text === preview)) return;
    state.inputs = [...state.inputs, { ts, text: preview }].sort((a, b) => b.ts - a.ts).slice(0, INPUTS_KEEP);
  }

  /** そのセッションの会話（ts の順、同じ ts は seq の順）。since より後の seq だけ。lastSeq は今の最大の seq */
  chat(sessionId: string, since = 0): ChatPage {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return { items: [], lastSeq: 0 };
    const items = state.chat.filter((c) => c.seq > since).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    return { items, lastSeq: state.chatSeq };
  }

  /** メモリに持っている件数（上限の試験用） */
  sizes(sessionId: string): { starts: number; stops: number; handbacks: number; restarts: number; tasks: number } {
    const s = this.sessions.get(sessionId);
    return { starts: s?.starts.size ?? 0, stops: s?.stops.size ?? 0, handbacks: s?.handbacks.size ?? 0, restarts: s?.restarts.size ?? 0, tasks: s?.tasks.size ?? 0 };
  }

  /** そのセッションの、画面に出すまとめ。別のセッションの記録は入らない（K7） */
  view(sessionId: string): SessionActivity {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return emptyActivity();
    const now = this.now();
    const running: AgentItem[] = [];
    // 動いているのは、Agent の呼び出し（PreToolUse）から始まる担当だけ。SubagentStart だけで呼び出しと結べない担当
    // （Claude の内部の担当・孫の担当）は、ここに入らない
    for (const start of state.starts.values()) {
      const post = state.posts.get(start.toolUseId);
      const agentId = post?.agentId ?? "";
      // 始まり = 呼び出しと最後の SubagentStart（再開）の新しい方。終わり = 最後の停止・報告・前景の担当の完了の新しいもの
      // （agent_id が空のキーは Map に入れていないので、結べていない担当は call の時刻だけ・終わりなしになる）
      const startedAt = latestOf(start.ts, state.restarts.get(agentId));
      const endedAt = latestOf(state.stops.get(agentId), state.handbacks.get(agentId), post?.status === "completed" ? post.ts : undefined);
      const isRunning = endedAt === 0 || startedAt > endedAt;
      if (!isRunning || now - startedAt > RUNNING_MAX_AGE_MS) continue;
      running.push({ key: start.toolUseId, subagentType: start.subagentType, model: start.model, resolvedModel: post?.resolvedModel ?? "", description: start.description, startedAt });
    }
    running.sort((a, b) => a.startedAt - b.startedAt);
    const tasks = [...state.tasks.values()]
      .sort((a, b) => (a.createdAt ?? a.completedAt ?? 0) - (b.createdAt ?? b.completedAt ?? 0) || a.seq - b.seq)
      .slice(-TASKS_MAX)
      .map((t): TaskItem => ({ id: t.id, subject: t.subject, done: t.completedAt !== null }));
    return { running, tasks, inputs: state.inputs.slice(0, INPUTS_MAX), lastEventAt: state.lastEventAt };
  }

  /** activityKeepDays より古い日付の events-YYYYMMDD.jsonl だけを消す。消した名前を返す（本番のポートのサーバーだけが呼ぶ） */
  async pruneOldFiles(): Promise<string[]> {
    const now = this.now();
    const todayStart = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
    const cutoff = todayStart - this.keepDays * MS_PER_DAY;
    const names = await readdir(this.activityDir).catch(() => [] as string[]);
    const removed: string[] = [];
    for (const name of names.sort()) {
      const m = EVENT_FILE.exec(name);
      if (m === null) continue;
      const fileDay = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!Number.isFinite(fileDay) || fileDay >= cutoff) continue;
      await unlink(path.join(this.activityDir, name)).then(
        () => removed.push(name),
        () => undefined,
      );
    }
    return removed;
  }
}
