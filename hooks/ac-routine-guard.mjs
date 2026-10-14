// agent-console: ac-routine と、その合言葉・宛先を、サブエージェント（Agent ツールで起動した担当）から触らせないための PreToolUse hook（同期）。
// 設計 docs/handoff/ac-hardening/design.md §3-2（元は ac-routine 設計 §4-1-2）。水準A（うっかり防止と記録）。入力に agent_id があるときだけ判定する。
// Bash で拒否するもの（どれか1つ）: "/bin/ac-routine.mjs"、"agent-console/reserve-token"、"Application Support/agent-console"、
//   127.0.0.1 か localhost を含み、かつ /api/agent/routines・/api/routines・routine-approval のどれかを含むもの。
// Read で拒否するもの: file_path が "Application Support/agent-console" を含むもの（dataDir の下）。Grep と Glob は settings の `if` が効かない（第0段 U5）ので対象にしない。
// 通すときは終了コード 0 で、標準出力・標準エラーとも完全に無出力。会話の文脈には何も足されない。
// 誤用防止であり、悪意への対策ではない。引用符や glob で迂回できる（README の「限界」）。入力が読めないときも通す（fail-open。全 Bash を止める方へは倒さない）。
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GUARDED_FRAGMENT = "/bin/ac-routine.mjs";
export const TOKEN_FRAGMENT = "agent-console/reserve-token";
export const DATA_DIR_FRAGMENT = "Application Support/agent-console";
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const ROUTINE_ENDPOINTS = ["/api/agent/routines", "/api/routines", "routine-approval"];
/** 拒否の理由（1 行・80 字以内） */
export const DENY_MESSAGE = "ac-routine と合言葉・宛先はサブエージェントからは使えません。Opus 本体の会話から実行してください。";

/** Bash の command を拒否するか */
export function bashDenied(command) {
  if (command.includes(GUARDED_FRAGMENT) || command.includes(TOKEN_FRAGMENT) || command.includes(DATA_DIR_FRAGMENT)) return true;
  return LOCAL_HOSTS.some((h) => command.includes(h)) && ROUTINE_ENDPOINTS.some((e) => command.includes(e));
}

/** 入力（PreToolUse の JSON を読んだ値）から、終了コードと標準エラーを返す。通すときは { code: 0, stderr: "" } */
export function judge(input) {
  const agentId = input && typeof input.agent_id === "string" ? input.agent_id : "";
  if (agentId === "") return { code: 0, stderr: "" };
  const toolInput = input && typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
  const tool = input && typeof input.tool_name === "string" ? input.tool_name : "Bash";
  const denied = tool === "Read" ? typeof toolInput.file_path === "string" && toolInput.file_path.includes(DATA_DIR_FRAGMENT) : typeof toolInput.command === "string" && bashDenied(toolInput.command);
  return denied ? { code: 2, stderr: `${DENY_MESSAGE}\n` } : { code: 0, stderr: "" };
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
