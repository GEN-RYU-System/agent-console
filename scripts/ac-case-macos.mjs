// 件の部屋（Seatbelt）が動いてよい macOS の版を記録する。設計 room-design §4-4・§9。
// 使い方: node scripts/ac-case-macos.mjs accept [--data-dir <dataDir>]
// 今の `sw_vers -productVersion` を <dataDir>/case-room-macos.json に { productVersion, acceptedAt } で書き、監査記録（dataDir/routine-audit.jsonl）に
// { action: "caseRoomMacosAccepted", outcome: "ok", callerSessionId: null, productVersion } を 1 行足す。
// サーバーは起き直したときに読み直す（この命令のあと ac-update か再起動で効く）。記録が無い・版が違うあいだ、件は開かない（503）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASE_ROOM_MACOS_FILE, readProductVersion } from "../server/case-proxy.ts";
import { loadConfig } from "../server/config.ts";
import { writeJsonAtomic } from "../server/json-store.ts";
import { RoutineAudit } from "../server/routine-audit.ts";

const USAGE = "使い方: node scripts/ac-case-macos.mjs accept [--data-dir <dataDir>]";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { "data-dir": { type: "string" } } });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, 2);
}
if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "accept") fail(USAGE, 2);

const dataDir = parsed.values["data-dir"] ?? loadConfig(process.env.AGENT_CONSOLE_CONFIG ?? path.join(root, "agent-console.config.json")).dataDir;
const productVersion = await readProductVersion();
if (productVersion === null) fail("sw_vers -productVersion を読めませんでした（macOS で実行してください）", 1);

try {
  await writeJsonAtomic(path.join(dataDir, CASE_ROOM_MACOS_FILE), { productVersion, acceptedAt: new Date().toISOString() });
  await new RoutineAudit(dataDir).append({ at: new Date().toISOString(), action: "caseRoomMacosAccepted", outcome: "ok", callerSessionId: null, productVersion });
  console.log(`macOS ${productVersion} を記録しました（${path.join(dataDir, CASE_ROOM_MACOS_FILE)}）。サーバーを起き直す（ac-update か再起動）と効きます`);
} catch (err) {
  fail(`記録に失敗しました: ${err instanceof Error ? err.message : String(err)}`, 1);
}
