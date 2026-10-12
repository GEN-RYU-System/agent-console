#!/bin/bash
# 試験用の偽 gh。`gh pr list|view|checks` だけに答える。切り替えは $STUB_GH_DIR の中のファイル:
#   <sub>.out / <sub>.err / <sub>.exit / <sub>.delay   （sub = list | view | checks。delay は秒）
#   <sub>@<キー>.* があれば、そちらを優先する。キー: list は --head の値の「/」を「_」にしたもの、view / checks は PR 番号。
# 呼ばれるたびに $STUB_GH_LOG へ「引数 | GH_PROMPT_DISABLED=… GH_NO_UPDATE_NOTIFIER=…」を1行足す。
LOG="${STUB_GH_LOG:-/dev/null}"
DIR="${STUB_GH_DIR:-/nonexistent}"
printf '%s | GH_PROMPT_DISABLED=%s GH_NO_UPDATE_NOTIFIER=%s\n' "$*" "${GH_PROMPT_DISABLED:-}" "${GH_NO_UPDATE_NOTIFIER:-}" >> "${LOG}"

if [ "${1:-}" != "pr" ]; then echo "gh-stub: only pr is supported" >&2; exit 99; fi
SUB="${2:-}"
case "${SUB}" in
  list|view|checks) ;;
  *) echo "gh-stub: pr ${SUB} is not supported" >&2; exit 99 ;;
esac

KEY=""
if [ "${SUB}" = "list" ]; then
  PREV=""
  for A in "$@"; do
    [ "${PREV}" = "--head" ] && KEY="${A//\//_}"
    PREV="${A}"
  done
else
  KEY="${3:-}"
fi

pick() {
  # $1 = 拡張子。キー付きがあればそれ、無ければ共通
  if [ -n "${KEY}" ] && [ -f "${DIR}/${SUB}@${KEY}.$1" ]; then echo "${DIR}/${SUB}@${KEY}.$1"; else echo "${DIR}/${SUB}.$1"; fi
}

DELAY="$(cat "$(pick delay)" 2>/dev/null | head -1)"
# 待ちは出力先を持たない子で行う（時間切れで bash が殺されても、受け手のパイプが開いたままにならない）
if [ -n "${DELAY}" ]; then sleep "${DELAY}" >/dev/null 2>&1 </dev/null & wait $!; fi
cat "$(pick out)" 2>/dev/null
cat "$(pick err)" >&2 2>/dev/null
CODE="$(cat "$(pick exit)" 2>/dev/null | head -1)"
exit "${CODE:-0}"
