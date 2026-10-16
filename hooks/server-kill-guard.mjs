// agent-console: 本番の agent-console サーバー（127.0.0.1:4319）を、名前やポートで止める命令を拒否する PreToolUse hook（同期）。
// 設計 docs/handoff/server-kill-guard/design.md §3-1。水準A（うっかり防止）。担当（agent_id あり）にも Opus 本体にも効く（agent_id は見ない）。
// 拒否するもの（どれか1つ）: R1 pkill・killall の部分が保護語を含む／R2 kill 系があり pgrep の部分が保護語を含む／
//   R3 kill 系があり lsof の部分が :4319 を含む／R4 launchctl の kill・stop・bootout・remove・disable が local.agent-console.server を含む。
// 通すときは終了コード 0 で、標準出力・標準エラーとも完全に無出力。会話の文脈には何も足されない。
// 誤用防止であり、悪意への対策ではない。引用符の分割・変数経由・pid の直書きで迂回できる（README の「限界」）。入力が読めないときも通す（fail-open）。
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 本番サーバーのポート（agent-console.config.json は読まない。hook は速さと fail-open を優先） */
export const PROD_PORT = "4319";
const LAUNCHD_LABEL = "local.agent-console.server";
const LAUNCHCTL_STOPS = new Set(["kill", "stop", "bootout", "remove", "disable"]);
const SKIP_WORDS = new Set(["sudo", "nohup", "env", "exec", "command", "xargs"]);
const KILLERS = new Set(["kill", "pkill", "killall"]);
const NODE_WORD = /(^|[^A-Za-z0-9_./-])node($|[^A-Za-z0-9_./-])/;
/** 拒否の理由（1 行・80 字以内） */
export const DENY_MESSAGE = "本番の agent-console を止める形です。試験サーバーは番号で止めてください（例: lsof -ti tcp:4329 | xargs kill）";

/** 保護語（本番サーバーを指す語）を含むか */
export function hasProtected(text) {
  return text.includes("dist-server") || text.includes("server/index.js") || text.includes("agent-console") || NODE_WORD.test(text);
}

const stripQuotes = (w) => w.replace(/^["']+/, "").replace(/["']+$/, "");

/** 部分の先頭語と、その次の語を返す（前置きの NAME=値・sudo 等・timeout <n>・-オプションを飛ばす） */
function headOf(part) {
  const words = part.split(/\s+/).filter((w) => w !== "").map(stripQuotes);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === "timeout") i += 2;
    else if (SKIP_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith("-") || w === "") i += 1;
    else break;
  }
  return { head: words[i] ?? "", next: words[i + 1] ?? "" };
}

/** command を拒否するか */
export function commandDenied(command) {
  const parts = command.split(/;|&&|\|\||\||\n|\$\(|`|\(|\)/).map((text) => ({ text, ...headOf(text) }));
  if (parts.some((p) => (p.head === "pkill" || p.head === "killall") && hasProtected(p.text))) return true;
  const hasKill = parts.some((p) => KILLERS.has(p.head));
  if (hasKill && parts.some((p) => p.head === "pgrep" && hasProtected(p.text))) return true;
  if (hasKill && parts.some((p) => p.head === "lsof" && p.text.includes(`:${PROD_PORT}`))) return true;
  return parts.some((p) => p.head === "launchctl" && LAUNCHCTL_STOPS.has(p.next) && p.text.includes(LAUNCHD_LABEL));
}

/** 入力（PreToolUse の JSON を読んだ値）から、終了コードと標準エラーを返す。通すときは { code: 0, stderr: "" }（agent_id は見ない） */
export function judge(input) {
  const toolInput = input && typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
  if (typeof toolInput.command !== "string") return { code: 0, stderr: "" };
  return commandDenied(toolInput.command) ? { code: 2, stderr: `${DENY_MESSAGE}\n` } : { code: 0, stderr: "" };
}

function isMain() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = undefined;
  }
  const result = judge(input);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
