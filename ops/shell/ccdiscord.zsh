# 件のセッション（役割 discord-case）を開く関数。agent-console が AC_CASE_* を渡して `source` して呼ぶ（-i を付けない。PO の ~/.zshrc は読ませない）。
# 設計 §4-5。ccopusgo と同じ作りで、違いは --restricted・件ごとの設定・gh の名義・一時の置き場。
# 条件が揃わないときは、理由を標準エラーに1行出して 2 で終わる（claude を開かない）。値（トークン）を画面・記録に出さない（set -x を使わない）。
ccdiscordcase() {
  local claude_bin="${AC_CLAUDE_BIN:-claude}"
  local sandbox_exec="${AC_SANDBOX_EXEC:-/usr/bin/sandbox-exec}"
  local p1="$HOME/.claude/prompts/salesanchor-designer.md"
  local p2="$HOME/.claude/prompts/salesanchor-ops-incident-agent.md"

  if [[ -z "${AC_CASE_SETTINGS:-}" || ! -r "$AC_CASE_SETTINGS" ]]; then print -u2 "ccdiscordcase: AC_CASE_SETTINGS is empty or unreadable"; return 2; fi
  if [[ -z "${AC_CASE_GH_DIR:-}" || ! -d "$AC_CASE_GH_DIR" ]]; then print -u2 "ccdiscordcase: AC_CASE_GH_DIR is empty or not a directory"; return 2; fi
  if [[ -z "${AC_CASE_REPORT:-}" || ! -d "$AC_CASE_REPORT" ]]; then print -u2 "ccdiscordcase: AC_CASE_REPORT is empty or not a directory"; return 2; fi
  if [[ -z "${AC_CASE_TMP:-}" || ! -d "$AC_CASE_TMP" ]]; then print -u2 "ccdiscordcase: AC_CASE_TMP is empty or not a directory"; return 2; fi
  if [[ ! -x "$sandbox_exec" ]]; then print -u2 "ccdiscordcase: sandbox-exec is not executable"; return 2; fi
  if [[ ! -r "$p1" || ! -s "$p1" ]]; then print -u2 "ccdiscordcase: prompt file 1 is unreadable or empty"; return 2; fi
  if [[ ! -r "$p2" || ! -s "$p2" ]]; then print -u2 "ccdiscordcase: prompt file 2 is unreadable or empty"; return 2; fi

  # 版の確かめ: 2.1.295 以上（比べは数の3つ組で）
  local ver
  ver="$("$claude_bin" --version 2>/dev/null)"
  if [[ ! "$ver" =~ '([0-9]+)\.([0-9]+)\.([0-9]+)' ]]; then print -u2 "ccdiscordcase: claude version is unreadable"; return 2; fi
  local -i major=$match[1] minor=$match[2] patch=$match[3]
  if (( major < 2 || (major == 2 && (minor < 1 || (minor == 1 && patch < 295))) )); then
    print -u2 "ccdiscordcase: claude ${major}.${minor}.${patch} is older than 2.1.295"
    return 2
  fi

  # 囲いの外で gh のトークンを取る（件の名義 shingo-cc）
  local token
  token="$(gh auth token -u shingo-cc 2>/dev/null)"
  if [[ -z "$token" ]]; then print -u2 "ccdiscordcase: gh token for shingo-cc is empty"; return 2; fi
  export GH_TOKEN="$token"
  unset token
  export GH_CONFIG_DIR="$AC_CASE_GH_DIR"
  export GIT_CONFIG_COUNT=3
  export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
  export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential'
  export GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false
  export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
  # ほかのセッションと共有の一時の置き場を使わせない
  export CLAUDE_CODE_TMPDIR="$AC_CASE_TMP"

  local prompt
  prompt="$(<"$p1")"$'\n\n'"$(<"$p2")"

  local -a args
  args=(--restricted --tools "Bash,Read,Edit,Write,Glob,Grep,Agent,TodoWrite" --settings "$AC_CASE_SETTINGS" --add-dir "$AC_CASE_REPORT" --strict-mcp-config --disallowedTools "mcp__*" WebFetch WebSearch --permission-mode dontAsk --model opus --effort medium --append-system-prompt "$prompt")
  if [[ "${AC_RESUME_ID:-}" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]; then
    args+=(--resume "$AC_RESUME_ID")
  fi
  command "$claude_bin" "${args[@]}"
}
