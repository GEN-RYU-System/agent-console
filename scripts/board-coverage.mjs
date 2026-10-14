// 作戦ボードの保有率を測る（読むだけ。何も書かない）。設計 docs/handoff/board-guard/design.md §3-3・K8。
// 使い方: node scripts/board-coverage.mjs [--data-dir <dataDir>]
// open-sessions.json の各 claudeSessionId について readBoard（hooks/ac-board.mjs が正本）の結果を数え、「ok 件数/全件数（日時）」を 1 行で出す。
// claudeSessionId がまだ無い項目も全件数には数える（保有率の分母は open-sessions.json の件数）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBoard } from "../hooks/ac-board.mjs";
import { loadConfig } from "../server/config.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({ options: { "data-dir": { type: "string" } } });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n使い方: node scripts/board-coverage.mjs [--data-dir <dataDir>]`);
}
const dataDir = parsed.values["data-dir"] ?? loadConfig(process.env.AGENT_CONSOLE_CONFIG ?? path.join(root, "agent-console.config.json")).dataDir;

let items;
try {
  const file = JSON.parse(readFileSync(path.join(dataDir, "open-sessions.json"), "utf8"));
  if (file === null || typeof file !== "object" || !Array.isArray(file.items)) throw new Error("open-sessions.json の形が想定と違います");
  items = file.items;
} catch (err) {
  fail(`open-sessions.json を読めません: ${err instanceof Error ? err.message : String(err)}`);
}

const counts = { ok: 0, invalid: 0, none: 0 };
for (const item of items) {
  const id = item !== null && typeof item === "object" ? item.claudeSessionId : undefined;
  const status = typeof id === "string" ? readBoard(dataDir, id).status : "none";
  counts[status] += 1;
}
const stamp = new Date().toISOString();
console.log(`${counts.ok}/${items.length}（${stamp}）ボード ok ${counts.ok}・形が壊れている ${counts.invalid}・無い ${counts.none}`);
