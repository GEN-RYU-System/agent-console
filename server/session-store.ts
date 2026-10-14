import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isClaudeSessionId } from "./sessions.ts";

// 端末の本体（tmux のセッション）を見つけるための id
// 形は UUID のみ（sessions.ts の isClaudeSessionId と同じ判定）

export const OPEN_SESSIONS_FILE = "open-sessions.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const FORMAT_VERSION = 1;

/** 復元リストの1件。Claude の sessionId は取れたときだけ（UUID の形のものだけ）。 */
export interface OpenSessionItem {
  /** このアプリのセッション id（tmux のセッション名 ac-<id> になる）。古い保存には無い */
  id?: string;
  roleId: string;
  name: string;
  cwd: string;
  branch?: string;
  claudeSessionId?: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

function parseItem(raw: unknown): OpenSessionItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isNonEmptyString(r.roleId) || !isNonEmptyString(r.name) || !isNonEmptyString(r.cwd)) throw new Error("open-sessions.json: item needs roleId, name and cwd");
  return normalizeItem({
    ...(r.id !== undefined ? { id: r.id as string } : {}),
    roleId: r.roleId,
    name: r.name,
    cwd: r.cwd,
    ...(isNonEmptyString(r.branch) ? { branch: r.branch } : {}),
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId as string } : {}),
  });
}

/** UUID の形でない sessionId は捨てる（保存しない・使わない）。余計なキーは持たない。 */
export function normalizeItem(item: OpenSessionItem): OpenSessionItem {
  return {
    ...(isClaudeSessionId(item.id) ? { id: item.id } : {}),
    roleId: item.roleId,
    name: item.name,
    cwd: item.cwd,
    ...(item.branch !== undefined ? { branch: item.branch } : {}),
    ...(isClaudeSessionId(item.claudeSessionId) ? { claudeSessionId: item.claudeSessionId } : {}),
  };
}

function parseFile(content: string): OpenSessionItem[] {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("open-sessions.json: object required");
  const { version, items } = parsed as { version?: unknown; items?: unknown };
  if (version !== FORMAT_VERSION || !Array.isArray(items)) throw new Error("open-sessions.json: unsupported format");
  return items.map(parseItem);
}

/**
 * 復元リスト（今開いているセッションの写し）の 1 ファイル。書込は quick-prompts と同じ作法
 * （直列・一時ファイル 600・chmod・rename）。壊れた・版違いのファイルは例外にし、上書きしない。
 */
export class OpenSessionStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, OPEN_SESSIONS_FILE);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<OpenSessionItem[]> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    return parseFile(content);
  }

  /** 読めなければ例外（呼び出し側が案内を出す）。無ければ空。 */
  load(): Promise<OpenSessionItem[]> {
    return this.serial(() => this.read());
  }

  /** 写しを保存する。いまのファイルが読めない（壊れている・版違い）ときは、上書きせず例外にする。 */
  save(items: readonly OpenSessionItem[]): Promise<void> {
    return this.serial(async () => {
      await this.read();
      await mkdir(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      const body = { version: FORMAT_VERSION, items: items.map(normalizeItem) };
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: FILE_MODE });
      await chmod(tmp, FILE_MODE);
      await rename(tmp, this.file);
    });
  }
}
