// agent-console: ac-routine をサブエージェント（Agent ツールで起動した担当）から打たせないための PreToolUse hook（同期）。設計 docs/handoff/ac-routine/design.md §4-1-2。
// 判定: Bash の command が命令の実行形 "/bin/ac-routine.mjs" を含み、かつ入力に agent_id があれば、終了コード 2 と標準エラー 1 行で拒否する。
// それ以外（通すとき）は終了コード 0 で、標準出力・標準エラーとも完全に無出力。会話の文脈には何も足されない。
// 誤用防止であり、悪意への対策ではない（設計 §4-1 前提）。入力が読めないときも通す（fail-open。全 Bash を止める方へは倒さない）。
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GUARDED_FRAGMENT = "/bin/ac-routine.mjs";
/** 拒否の理由（1 行・80 字以内） */
export const DENY_MESSAGE = "ac-routine はサブエージェントからは使えません。Opus 本体の会話から実行してください。";

/** 入力（PreToolUse の JSON を読んだ値）から、終了コードと標準エラーを返す。通すときは { code: 0, stderr: "" } */
export function judge(input) {
  const command = input && input.tool_input && typeof input.tool_input.command === "string" ? input.tool_input.command : "";
  const agentId = input && typeof input.agent_id === "string" ? input.agent_id : "";
  if (command.includes(GUARDED_FRAGMENT) && agentId !== "") return { code: 2, stderr: `${DENY_MESSAGE}\n` };
  return { code: 0, stderr: "" };
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
