// agent-console の記録用 hook を、Claude の設定（~/.claude/settings.json）に足す・外す・点検する道具。
// 使い方: node scripts/ac-hooks.mjs install|uninstall|check [--settings <settings.json>] [--data-dir <dataDir>]
// - install: hook の本体を dataDir/hooks/ に置いてから、設定に自分の handler だけを足す（足す前に控えを取る。2 回実行しても増えない）
// - uninstall: 自分の handler だけを外す（ほかの設定には触れない）
// - check: 設定に handler があり、node と hook のファイルがあるかを JSON で返す（ok でなければ終了コード 1）
// 設定の書き換えは、実行した人が自分で行う（アプリは設定を書き換えない）。判定の中身は server/activity-hooks.ts（アプリの点検と同じ）。
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../server/config.ts";
import { checkHooks, installHooks, uninstallHooks } from "../server/activity-hooks.ts";
import { hookPathIn, installHookFile } from "../server/activity-setup.ts";

const USAGE = "使い方: node scripts/ac-hooks.mjs install|uninstall|check [--settings <settings.json>] [--data-dir <dataDir>]";
const COMMANDS = new Set(["install", "uninstall", "check"]);
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { settings: { type: "string" }, "data-dir": { type: "string" } } });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, EXIT_USAGE);
}
const [command] = parsed.positionals;
if (parsed.positionals.length !== 1 || !COMMANDS.has(command)) fail(USAGE, EXIT_USAGE);

const settingsPath = parsed.values.settings ?? path.join(os.homedir(), ".claude", "settings.json");
const dataDir = parsed.values["data-dir"] ?? loadConfig(process.env.AGENT_CONSOLE_CONFIG ?? path.join(root, "agent-console.config.json")).dataDir;
const hookPath = hookPathIn(dataDir);

try {
  if (command === "install") {
    installHookFile(path.join(root, "hooks"), dataDir);
    const r = installHooks({ settingsPath, nodePath: process.execPath, hookPath });
    console.log(r.changed ? `記録用 hook を ${settingsPath} に足しました（控えは同じフォルダの settings.json.ac-backup-*）` : "記録用 hook はすでに入っています（変更なし）");
  } else if (command === "uninstall") {
    const r = uninstallHooks({ settingsPath });
    console.log(r.changed ? `記録用 hook を ${r.removed} 件外しました（控えは同じフォルダの settings.json.ac-backup-*）` : "外す記録用 hook はありません（変更なし）");
  } else {
    const result = checkHooks({ settingsPath, hookPath });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : EXIT_FAILED);
  }
} catch (err) {
  fail(`失敗しました: ${err instanceof Error ? err.message : String(err)}`, EXIT_FAILED);
}
