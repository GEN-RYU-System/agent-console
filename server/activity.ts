// セッションの様子（担当・やること・入力）の記録を読んで、セッションごとにまとめる。設計 §3-4。
// 正本は dataDir/activity/events-YYYYMMDD.jsonl（UTC の日付、hooks/activity-hook.mjs が追記する）。ここはその写しをメモリに持つだけ。
import { open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const ACTIVITY_DIR_NAME = "activity";
/** 終わりが記録されない担当を「動いている」とみなす最長（L-a）。開始からこれを過ぎたら外す */
export const RUNNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const FINISHED_MAX = 10;
export const TASKS_MAX = 50;
export const INPUTS_MAX = 3;
/** セッションごとに覚える担当・入力の上限（メモリが増え続けないため） */
const STARTS_KEEP = 400;
const STOPS_KEEP = 400;
const HANDBACKS_KEEP = 400;
const NESTED_KEEP = 400;
const TASKS_KEEP = 200;
const INPUTS_KEEP = 20;
const READ_CHUNK_BYTES = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_FILE = /^events-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const EVENTS = new Set(["PreToolUse", "PostToolUse", "SubagentStop", "TaskCreated", "TaskCompleted", "UserPromptSubmit"]);

export interface AgentItem {
  key: string;
  subagentType: string;
  model: string;
  resolvedModel: string;
  /** 頼んだ仕事の説明（Claude が書いた文のまま） */
  description: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  /** 結果のひとこと（報告の先頭 120 字） */
  summary: string;
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
  finished: AgentItem[];
  tasks: TaskItem[];
  inputs: InputItem[];
  lastEventAt: number | null;
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
  totalDurationMs: number | null;
  /** 担当の中で起きた呼び出し（孫の担当） */
  nested: boolean;
}
interface Report {
  ts: number;
  text: string;
  agentType: string;
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
  /** 孫の担当の呼び出しの tool_use_id → 記録した時刻 */
  nestedToolUses: Map<string, number>;
  posts: Map<string, Post>;
  stops: Map<string, Report>;
  handbacks: Map<string, Report>;
  tasks: Map<string, Task>;
  inputs: InputItem[];
  lastEventAt: number;
}

const newSession = (): SessionState => ({
  starts: new Map(),
  nestedToolUses: new Map(),
  posts: new Map(),
  stops: new Map(),
  handbacks: new Map(),
  tasks: new Map(),
  inputs: [],
  lastEventAt: 0,
});

const emptyActivity = (): SessionActivity => ({ running: [], finished: [], tasks: [], inputs: [], lastEventAt: null });

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
        this.applyPost(state, rec, ts, agentId);
        break;
      case "SubagentStop":
        if (agentId !== "") {
          state.stops.set(agentId, { ts, text: text(rec.last_assistant_message), agentType: text(rec.agent_type) });
          trimOldest(state.stops, STOPS_KEEP, (r) => r.ts);
        }
        break;
      case "TaskCreated":
      case "TaskCompleted":
        this.applyTask(state, rec, ts);
        break;
      case "UserPromptSubmit":
        this.applyPrompt(state, rec, ts);
        break;
    }
  }

  private applyPre(state: SessionState, rec: Raw, ts: number, agentId: string): void {
    if (rec.tool === "SubagentHandback") {
      if (agentId !== "") {
        state.handbacks.set(agentId, { ts, text: text(rec.message), agentType: "" });
        trimOldest(state.handbacks, HANDBACKS_KEEP, (r) => r.ts);
      }
      return;
    }
    if (rec.tool !== "Agent") return;
    const toolUseId = text(rec.tool_use_id) || `noid-${(this.seq += 1)}`;
    // agent_id が付いた呼び出しは、担当がさらに呼んだ担当（孫）。v0.8.0 では出さない
    if (agentId !== "") {
      state.nestedToolUses.set(toolUseId, ts);
      trimOldest(state.nestedToolUses, NESTED_KEEP, (v) => v);
      return;
    }
    state.starts.set(toolUseId, { toolUseId, ts, description: text(rec.description), subagentType: text(rec.subagent_type), model: text(rec.model) });
    if (state.starts.size > STARTS_KEEP) {
      const oldest = [...state.starts.values()].sort((a, b) => a.ts - b.ts)[0];
      state.starts.delete(oldest.toolUseId);
      state.posts.delete(oldest.toolUseId);
    }
  }

  private applyPost(state: SessionState, rec: Raw, ts: number, agentId: string): void {
    if (rec.tool !== "Agent") return;
    const toolUseId = text(rec.tool_use_id);
    if (toolUseId === "") return;
    const total = rec.totalDurationMs;
    state.posts.set(toolUseId, {
      ts,
      status: text(rec.status),
      agentId: text(rec.agentId),
      resolvedModel: text(rec.resolvedModel),
      totalDurationMs: typeof total === "number" && Number.isFinite(total) ? total : null,
      nested: agentId !== "",
    });
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
    const body = text(rec.prompt);
    if (rec.source === "agent" || body === "") return;
    if (state.inputs.some((i) => i.ts === ts && i.text === body)) return;
    state.inputs = [...state.inputs, { ts, text: body }].sort((a, b) => b.ts - a.ts).slice(0, INPUTS_KEEP);
  }

  /** メモリに持っている件数（上限の試験用） */
  sizes(sessionId: string): { starts: number; stops: number; handbacks: number; tasks: number; nested: number } {
    const s = this.sessions.get(sessionId);
    return { starts: s?.starts.size ?? 0, stops: s?.stops.size ?? 0, handbacks: s?.handbacks.size ?? 0, tasks: s?.tasks.size ?? 0, nested: s?.nestedToolUses.size ?? 0 };
  }

  /** そのセッションの、画面に出すまとめ。別のセッションの記録は入らない（K7） */
  view(sessionId: string): SessionActivity {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return emptyActivity();
    const now = this.now();
    const nestedAgentIds = new Set<string>();
    for (const [toolUseId, post] of state.posts) {
      if (post.agentId !== "" && (post.nested || state.nestedToolUses.has(toolUseId))) nestedAgentIds.add(post.agentId);
    }
    const linked = new Set<string>();
    const running: AgentItem[] = [];
    const finished: AgentItem[] = [];
    for (const start of state.starts.values()) {
      const post = state.posts.get(start.toolUseId);
      if (post?.agentId) linked.add(post.agentId);
      const stop = post?.agentId ? state.stops.get(post.agentId) : undefined;
      const handback = post?.agentId ? state.handbacks.get(post.agentId) : undefined;
      const completed = post?.status === "completed";
      const endedAt = stop?.ts ?? handback?.ts ?? (completed ? post.ts : null);
      const durationMs = stop !== undefined ? stop.ts - start.ts : endedAt === null ? null : completed && post.totalDurationMs !== null ? post.totalDurationMs : endedAt - start.ts;
      const item: AgentItem = {
        key: start.toolUseId,
        subagentType: start.subagentType,
        model: start.model,
        resolvedModel: post?.resolvedModel ?? "",
        description: start.description,
        startedAt: start.ts,
        endedAt,
        durationMs,
        // 結果は SubagentHandback の報告を優先する。無いときだけ SubagentStop の last_assistant_message
        summary: handback?.text || stop?.text || "",
      };
      if (endedAt !== null) finished.push(item);
      else if (now - start.ts <= RUNNING_MAX_AGE_MS) running.push(item);
    }
    for (const orphan of this.orphans(state, linked, nestedAgentIds)) finished.push(orphan);
    finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    running.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const tasks = [...state.tasks.values()]
      .sort((a, b) => (a.createdAt ?? a.completedAt ?? 0) - (b.createdAt ?? b.completedAt ?? 0) || a.seq - b.seq)
      .slice(-TASKS_MAX)
      .map((t): TaskItem => ({ id: t.id, subject: t.subject, done: t.completedAt !== null }));
    return { running, finished: finished.slice(0, FINISHED_MAX), tasks, inputs: state.inputs.slice(0, INPUTS_MAX), lastEventAt: state.lastEventAt };
  }

  /** 担当の開始の記録に結べなかった終わり（記録を始める前に呼ばれた担当など）。出せる項目だけ出す */
  private orphans(state: SessionState, linked: ReadonlySet<string>, nested: ReadonlySet<string>): AgentItem[] {
    const ids = new Set([...state.stops.keys(), ...state.handbacks.keys()]);
    const items: AgentItem[] = [];
    for (const agentId of ids) {
      if (linked.has(agentId) || nested.has(agentId)) continue;
      const stop = state.stops.get(agentId);
      const handback = state.handbacks.get(agentId);
      // Claude Code の内部の担当（提案の生成など）は agent_type が空で、報告も無い。これは人に見せない
      if ((stop?.agentType ?? "") === "" && handback === undefined) continue;
      items.push({
        key: `agent-${agentId}`,
        subagentType: stop?.agentType ?? "",
        model: "",
        resolvedModel: "",
        description: "",
        startedAt: null,
        endedAt: stop?.ts ?? handback?.ts ?? null,
        durationMs: null,
        summary: handback?.text || stop?.text || "",
      });
    }
    return items;
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
