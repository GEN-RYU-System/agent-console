// 切戻し用: 保存リスト（open-sessions.json）と routine（routines.json）を「退避ファイル」へ合わせて書く。
// 使い方: node merge-held.mjs <open-sessions|routines> <今のファイル> <退避ファイル>
// 結果は退避ファイルに書く（一時ファイル＋rename、権限 600）。今のファイルは触らない（移すのは呼び出し側）。
// 鍵: open-sessions は id、または claudeSessionId の一致。routines は id の一致。一致したら退避側（tmux の本体）を採る。
// claudeSessionId の無い項目は両方残す。server/held-merge.ts（起動時に元へ戻す側）と同じ規則。
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function mergeItems(kind, heldItems, currentItems) {
  const keep = currentItems.filter((c) => {
    return !heldItems.some((h) => {
      if (kind === "routines") return typeof c.id === "string" && c.id === h.id;
      return (typeof c.id === "string" && c.id === h.id) || (typeof c.claudeSessionId === "string" && c.claudeSessionId === h.claudeSessionId);
    });
  });
  return [...heldItems, ...keep];
}

function readFile(file) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.items)) throw new Error(`${file}: unsupported format`);
  return parsed;
}

export function mergeFiles(kind, currentFile, heldFile) {
  if (kind !== "open-sessions" && kind !== "routines") throw new Error(`unknown kind: ${kind}`);
  const current = readFile(currentFile);
  const held = readFile(heldFile);
  if (current === null) return false;
  const base = held ?? current;
  const items = held === null ? current.items : mergeItems(kind, held.items, current.items);
  const tmp = `${heldFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...base, items }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, heldFile);
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [kind, currentFile, heldFile] = process.argv.slice(2);
  try {
    process.exit(mergeFiles(kind, currentFile, heldFile) ? 0 : 3);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
