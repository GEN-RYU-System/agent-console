import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionConflictError, SessionInputError, SessionNotFoundError } from "./sessions.ts";

export const DIFF_COMMENTS_FILE = "diff-comments.json";
export const MAX_COMMENT_CHARS = 2000;
const MAX_LINE_TEXT_CHARS = 500;
const MAX_ITEMS_PER_DIR = 200;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const FORMAT_VERSION = 1;

export type CommentSide = "new" | "old" | "file";

export interface DiffCommentItem {
  id: string;
  path: string;
  side: CommentSide;
  /** side が new / old のときだけ（1 以上の整数） */
  line?: number;
  /** 保存したときのその行の中身（ずれの検知と、送る文章の「該当行」に使う） */
  lineText?: string;
  body: string;
  createdAt: number;
  sentAt?: number;
}

export interface CommentInput {
  path: string;
  side: CommentSide;
  line?: number;
  lineText?: string;
  body: string;
}

/** 今ある作業場所（本店と git worktree list の各行）。コメントの置き場の正本。 */
export interface KnownPlace {
  dir: string;
  branch: string | null;
}

/** どの作業場所のコメントを扱うか。known は、その時点の本店と worktree の一覧。 */
export interface CommentScope {
  dir: string;
  known: readonly KnownPlace[];
}

/** 保存ファイルが読めない（壊れている・版違い）。上書きはせず、画面に案内を出す。 */
export class DiffCommentsUnreadableError extends Error {}

interface Place {
  branch: string | null;
  items: DiffCommentItem[];
}
type Data = Record<string, Place>;

// 改行・タブ以外の制御文字（ESC など）は端末に送らない（quick-prompts.ts と同じ）
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/g;

/** 画面から来たコメントの形を確かめる（path が一覧にあるかは呼び出し側が照合する）。 */
export function validateCommentInput(raw: unknown): CommentInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SessionInputError("JSON object required");
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || r.path === "") throw new SessionInputError("path is required");
  if (r.side !== "new" && r.side !== "old" && r.side !== "file") throw new SessionInputError("side must be new, old or file");
  if (typeof r.body !== "string" || r.body.trim() === "") throw new SessionInputError("body is required");
  if (r.body.length > MAX_COMMENT_CHARS) throw new SessionInputError("body must be at most 2000 characters");
  if (BODY_CONTROL.test(r.body)) throw new SessionInputError("body must not contain control characters");
  let line: number | undefined;
  if (r.side === "file") {
    if (r.line !== undefined && r.line !== null) throw new SessionInputError("line must not be given for a whole-file comment");
  } else {
    if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 1) throw new SessionInputError("line must be an integer of 1 or more");
    line = r.line;
  }
  if (r.lineText !== undefined && r.lineText !== null && typeof r.lineText !== "string") throw new SessionInputError("lineText must be a string");
  const lineText = typeof r.lineText === "string" ? r.lineText.replace(ANY_CONTROL, " ").slice(0, MAX_LINE_TEXT_CHARS) : undefined;
  return { path: r.path, side: r.side, ...(line !== undefined ? { line } : {}), ...(lineText !== undefined && r.side !== "file" ? { lineText } : {}), body: r.body };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseItem(raw: unknown): DiffCommentItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const side = r.side;
  if (!isString(r.id) || !isString(r.path) || !isString(r.body) || !isNumber(r.createdAt) || (side !== "new" && side !== "old" && side !== "file")) {
    throw new DiffCommentsUnreadableError("diff-comments.json: invalid item");
  }
  if (r.line !== undefined && !isNumber(r.line)) throw new DiffCommentsUnreadableError("diff-comments.json: invalid line");
  if (r.lineText !== undefined && !isString(r.lineText)) throw new DiffCommentsUnreadableError("diff-comments.json: invalid lineText");
  if (r.sentAt !== undefined && !isNumber(r.sentAt)) throw new DiffCommentsUnreadableError("diff-comments.json: invalid sentAt");
  return {
    id: r.id,
    path: r.path,
    side,
    ...(r.line !== undefined ? { line: r.line } : {}),
    ...(r.lineText !== undefined ? { lineText: r.lineText } : {}),
    body: r.body,
    createdAt: r.createdAt,
    ...(r.sentAt !== undefined ? { sentAt: r.sentAt } : {}),
  };
}

function parseFile(content: string): Data {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DiffCommentsUnreadableError("diff-comments.json: not JSON");
  }
  const { version, byDir } = (parsed ?? {}) as { version?: unknown; byDir?: unknown };
  if (version !== FORMAT_VERSION || typeof byDir !== "object" || byDir === null || Array.isArray(byDir)) {
    throw new DiffCommentsUnreadableError("diff-comments.json: unsupported format");
  }
  const data: Data = {};
  for (const [dir, place] of Object.entries(byDir)) {
    const p = (place ?? {}) as { branch?: unknown; items?: unknown };
    if ((p.branch !== null && !isString(p.branch)) || !Array.isArray(p.items)) throw new DiffCommentsUnreadableError("diff-comments.json: invalid place");
    data[dir] = { branch: p.branch, items: p.items.map(parseItem) };
  }
  return data;
}

/** 今ある作業場所（かつ同じブランチ）の項目だけを残す。消えた worktree や、別ブランチで作り直された場所のコメントは捨てる。 */
function prune(data: Data, known: readonly KnownPlace[]): Data {
  const out: Data = {};
  for (const [dir, place] of Object.entries(data)) {
    if (known.some((k) => k.dir === dir && k.branch === place.branch)) out[dir] = place;
  }
  return out;
}

/**
 * レビューコメントの正本（dataDir の 1 ファイル）。書込は session-store.ts と同じ作法
 * （直列・一時ファイル 600・chmod・rename）。壊れたファイルは上書きしない。
 * 作業場所ごとに持ち、読み書きのたびに今ある作業場所と照合して、無くなった場所の分を捨てる。
 */
export class DiffCommentStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, DIFF_COMMENTS_FILE);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Data> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return {};
      throw err;
    }
    return parseFile(content);
  }

  private async write(data: Data): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: FORMAT_VERSION, byDir: data }, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE);
    await rename(tmp, this.file);
  }

  /** 読んで、無くなった作業場所を捨てる。捨てたら保存する。 */
  private async load(scope: CommentScope): Promise<Data> {
    const raw = await this.read();
    const pruned = prune(raw, scope.known);
    if (Object.keys(pruned).length !== Object.keys(raw).length) await this.write(pruned);
    return pruned;
  }

  private branchOf(scope: CommentScope): string | null {
    const place = scope.known.find((k) => k.dir === scope.dir);
    if (!place) throw new SessionConflictError("working directory is not a known place");
    return place.branch;
  }

  /** この作業場所を、items で置き換えて保存する。 */
  private async save(data: Data, scope: CommentScope, items: DiffCommentItem[]): Promise<void> {
    await this.write({ ...data, [scope.dir]: { branch: this.branchOf(scope), items } });
  }

  list(scope: CommentScope): Promise<DiffCommentItem[]> {
    return this.serial(async () => (await this.load(scope))[scope.dir]?.items ?? []);
  }

  add(scope: CommentScope, input: CommentInput): Promise<DiffCommentItem> {
    return this.serial(async () => {
      const data = await this.load(scope);
      const items = data[scope.dir]?.items ?? [];
      if (items.length >= MAX_ITEMS_PER_DIR) throw new SessionInputError("too many comments");
      const item: DiffCommentItem = { id: randomUUID(), ...input, createdAt: Date.now() };
      await this.save(data, scope, [...items, item]);
      return item;
    });
  }

  /** 編集したら未送信に戻す（sentAt を消す）。 */
  update(scope: CommentScope, id: string, input: CommentInput): Promise<DiffCommentItem> {
    return this.serial(async () => {
      const data = await this.load(scope);
      const items = data[scope.dir]?.items ?? [];
      const current = items.find((c) => c.id === id);
      if (!current) throw new SessionNotFoundError("comment not found");
      const next: DiffCommentItem = { id, ...input, createdAt: current.createdAt };
      await this.save(data, scope, items.map((c) => (c.id === id ? next : c)));
      return next;
    });
  }

  remove(scope: CommentScope, id: string): Promise<void> {
    return this.serial(async () => {
      const data = await this.load(scope);
      const items = data[scope.dir]?.items ?? [];
      if (!items.some((c) => c.id === id)) throw new SessionNotFoundError("comment not found");
      await this.save(data, scope, items.filter((c) => c.id !== id));
    });
  }

  /** ids のうち、この作業場所にあるものを送信済みにする（無い id は黙って飛ばす）。 */
  markSent(scope: CommentScope, ids: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const data = await this.load(scope);
      const items = data[scope.dir]?.items ?? [];
      const now = Date.now();
      await this.save(data, scope, items.map((c) => (ids.includes(c.id) ? { ...c, sentAt: now } : c)));
    });
  }
}
