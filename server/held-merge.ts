import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// 切戻し（scripts/lib/merge-held.mjs）で退避された保存リストと routine を、起動時に元へ戻す。
// 退避ファイルがあれば、今のファイルと合わせてから元の名前で書き、退避ファイルは消す。
// 合わせ方は scripts/lib/merge-held.mjs と同じ（設計 docs/handoff/keep-sessions/design.md §11 #3）。
// 鍵: open-sessions は id、または claudeSessionId の一致。routines は id の一致。一致したら退避側（tmux の本体）を採る。

export type HeldKind = "open-sessions" | "routines";
const FILES: ReadonlyArray<{ kind: HeldKind; base: string }> = [
  { kind: "open-sessions", base: "open-sessions" },
  { kind: "routines", base: "routines" },
];

type Item = Record<string, unknown>;
interface Doc {
  version?: unknown;
  items: Item[];
  [key: string]: unknown;
}

const isString = (v: unknown): v is string => typeof v === "string" && v !== "";

export function mergeItems(kind: HeldKind, held: readonly Item[], current: readonly Item[]): Item[] {
  const keep = current.filter(
    (c) =>
      !held.some((h) => {
        if (kind === "routines") return isString(c.id) && c.id === h.id;
        return (isString(c.id) && c.id === h.id) || (isString(c.claudeSessionId) && c.claudeSessionId === h.claudeSessionId);
      }),
  );
  return [...held, ...keep];
}

async function readDoc(file: string): Promise<Doc | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Doc).items)) throw new Error(`${path.basename(file)}: unsupported format`);
  return parsed as Doc;
}

export interface HeldLogger {
  log(message: string): void;
  error(message: string): void;
}

/** 戻した種類の数を返す。読めない物は触らず（退避も今のも残して）ログに出す。 */
export async function restoreHeldFiles(dataDir: string, logger: HeldLogger = { log: (m) => console.log(m), error: (m) => console.error(m) }): Promise<number> {
  let restored = 0;
  for (const { kind, base } of FILES) {
    const heldFile = path.join(dataDir, `${base}.tmux-held.json`);
    const file = path.join(dataDir, `${base}.json`);
    try {
      const held = await readDoc(heldFile);
      if (held === null) continue;
      const current = await readDoc(file);
      const items = current === null ? held.items : mergeItems(kind, held.items, current.items);
      const tmp = `${file}.${process.pid}.held.tmp`;
      await writeFile(tmp, `${JSON.stringify({ ...(current ?? held), items }, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
      await rm(heldFile);
      restored += 1;
      logger.log(`held-restore: ${base}.tmux-held.json を ${base}.json へ戻しました（${items.length} 件）`);
    } catch (err) {
      logger.error(`held-restore: ${base} を戻せませんでした（退避ファイルは残します）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return restored;
}
