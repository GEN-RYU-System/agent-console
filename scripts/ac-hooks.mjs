// agent-console の記録用 hook を、Claude の設定（~/.claude/settings.json）に足す・外す・点検する道具。
// 使い方: node scripts/ac-hooks.mjs install|uninstall|check [--settings <settings.json>] [--data-dir <dataDir>]
// - install: hook の本体（記録用 activity-hook と、ac-routine のサブエージェント拒否 ac-routine-guard の 2 本）を dataDir/hooks/ に、ac-routine 命令を dataDir/bin/ に置いてから、設定に自分の handler（15 本）だけを足す（足す前に控えを取る。2 回実行しても増えない）。
//   そのあとに別の段として、利用量の命令を dataDir/bin/ に置き、statusLine を足す（別の statusLine があれば上書きせず、見送りの行を出す）
// - uninstall: 自分の handler と自分の statusLine だけを外す（ほかの設定には触れない）
// - check: 設定に handler があり、node と hook のファイルがあるかを JSON で返す（ok でなければ終了コード 1）。statusLine の結果は別の行で標準エラーに出す
// 終了コードは hooks の段の結果で決める（statusLine の見送り・未導入では変えない。statusLine の書き込みの失敗だけ 1）。
// 設定の書き換えは、実行した人が自分で行う（アプリは設定を書き換えない）。判定の中身は server/activity-hooks.ts（アプリの点検と同じ）。
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../server/config.ts";
import { checkHooks, checkStatusLine, installHooks, installStatusLine, uninstallHooks, uninstallStatusLine } from "../server/activity-hooks.ts";
import { hookPathIn, installGuardFile, installHookFile, installRoutineCommand, installStatuslineCommand, statuslineCommandPathIn } from "../server/activity-setup.ts";

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
const statuslinePath = statuslineCommandPathIn(dataDir);

/** statusLine の段（hooks の段のあとに別に行う）。失敗は例外にせず、「hooks は入った・statusLine は入っていない」と分けて出して 1 を返す */
function installStatusLineStage() {
  try {
    installRoutineCommand(path.join(root, "hooks"), dataDir);
    installStatuslineCommand(path.join(root, "hooks"), dataDir);
    const r = installStatusLine({ settingsPath, nodePath: process.execPath, scriptPath: statuslinePath });
    const messages = {
      added: `statusLine（利用量の写し取り）を ${settingsPath} に足しました`,
      updated: `statusLine（利用量の写し取り）の node のパスを直しました`,
      unchanged: "statusLine（利用量の写し取り）はすでに入っています（変更なし）",
      foreign: "statusLine: 別の設定があるので足していません（そのまま残しました）",
    };
    console.log(messages[r.outcome]);
    return 0;
  } catch (err) {
    console.error(`statusLine の段に失敗しました（hooks は入りました・statusLine は入っていません）: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAILED;
  }
}

const STATUSLINE_REASONS = { noSettings: "settings.json が無い", unreadable: "settings.json を読めない", missing: "無い", foreign: "別の物", nodeMissing: "node のパスが無い", scriptFileMissing: "命令のファイルが無い" };

try {
  if (command === "install") {
    installHookFile(path.join(root, "hooks"), dataDir);
    installGuardFile(path.join(root, "hooks"), dataDir);
    const r = installHooks({ settingsPath, nodePath: process.execPath, hookPath });
    console.log(r.changed ? `記録用 hook と ac-routine の guard hook を ${settingsPath} に足しました（控えは同じフォルダの settings.json.ac-backup-*）` : "記録用 hook はすでに入っています（変更なし）");
    process.exitCode = installStatusLineStage();
  } else if (command === "uninstall") {
    const r = uninstallHooks({ settingsPath });
    console.log(r.changed ? `記録用 hook を ${r.removed} 件外しました（控えは同じフォルダの settings.json.ac-backup-*）` : "外す記録用 hook はありません（変更なし）");
    const sl = uninstallStatusLine({ settingsPath, scriptPath: statuslinePath });
    console.log(sl.changed ? "statusLine（利用量の写し取り）を外しました" : "外す statusLine はありません（変更なし）");
  } else {
    const result = checkHooks({ settingsPath, hookPath });
    console.log(JSON.stringify(result));
    const sl = checkStatusLine({ settingsPath, scriptPath: statuslinePath });
    console.error(sl.ok ? "statusLine: ok" : `statusLine: 無い（または別の物）: ${STATUSLINE_REASONS[sl.reason] ?? sl.reason}`);
    process.exit(result.ok ? 0 : EXIT_FAILED);
  }
} catch (err) {
  fail(`失敗しました: ${err instanceof Error ? err.message : String(err)}`, EXIT_FAILED);
}
