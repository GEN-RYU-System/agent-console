import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionInputError, SessionNotFoundError } from "./sessions.ts";

export const QUICK_PROMPTS_FILE = "quick-prompts.json";
export const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_LABEL_LENGTH = 40;
const MAX_ITEMS = 40;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const FORMAT_VERSION = 1;

export interface QuickPrompt {
  id: string;
  label: string;
  text: string;
}

// eslint-disable-next-line no-control-regex
const LABEL_CONTROL = /[\u0000-\u001f\u007f]/;
// 改行・タブ以外の制御文字（ESC など）は端末に送らない
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function validateLabel(raw: unknown): string {
  if (typeof raw !== "string") throw new SessionInputError("label is required");
  const label = raw.trim();
  if (label.length < 1 || label.length > MAX_LABEL_LENGTH) throw new SessionInputError("label must be 1-40 characters");
  if (LABEL_CONTROL.test(label)) throw new SessionInputError("label must not contain control characters");
  return label;
}

export function validateText(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new SessionInputError("text is required");
  if (Buffer.byteLength(raw, "utf8") > MAX_PROMPT_BYTES) throw new SessionInputError("text must be at most 8KB");
  if (TEXT_CONTROL.test(raw)) throw new SessionInputError("text must not contain control characters");
  return raw;
}

function parseFile(content: string): QuickPrompt[] {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("quick-prompts.json: object required");
  const { version, items } = parsed as { version?: unknown; items?: unknown };
  if (version !== FORMAT_VERSION || !Array.isArray(items)) throw new Error("quick-prompts.json: unsupported format");
  return items.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string") throw new Error("quick-prompts.json: item.id required");
    return { id: r.id, label: validateLabel(r.label), text: validateText(r.text) };
  });
}

/** よく使う指示の正本（1 ファイル）。書込は一時ファイル→rename、権限 600。 */
export class QuickPromptStore {
  private readonly file: string;
  /** 読み書きを 1 本ずつ順に実行する（同時の更新で内容が欠けない）。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, QUICK_PROMPTS_FILE);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<QuickPrompt[]> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    // 壊れたファイルは上書きせず例外にする（黙って空にしない）
    return parseFile(content);
  }

  private async save(items: QuickPrompt[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: FORMAT_VERSION, items }, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE);
    await rename(tmp, this.file);
  }

  list(): Promise<QuickPrompt[]> {
    return this.serial(() => this.load());
  }

  get(id: string): Promise<QuickPrompt> {
    return this.serial(async () => {
      const item = (await this.load()).find((p) => p.id === id);
      if (!item) throw new SessionNotFoundError("quick prompt not found");
      return item;
    });
  }

  create(input: { label: unknown; text: unknown }): Promise<QuickPrompt> {
    return this.serial(async () => {
      const item: QuickPrompt = { id: randomUUID(), label: validateLabel(input.label), text: validateText(input.text) };
      const items = await this.load();
      if (items.length >= MAX_ITEMS) throw new SessionInputError("too many quick prompts");
      await this.save([...items, item]);
      return item;
    });
  }

  update(id: string, input: { label: unknown; text: unknown }): Promise<QuickPrompt> {
    return this.serial(async () => {
      const items = await this.load();
      if (!items.some((p) => p.id === id)) throw new SessionNotFoundError("quick prompt not found");
      const next: QuickPrompt = { id, label: validateLabel(input.label), text: validateText(input.text) };
      await this.save(items.map((p) => (p.id === id ? next : p)));
      return next;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const items = await this.load();
      if (!items.some((p) => p.id === id)) throw new SessionNotFoundError("quick prompt not found");
      await this.save(items.filter((p) => p.id !== id));
    });
  }
}
