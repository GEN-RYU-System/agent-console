#!/bin/bash
# e2e 用スタブ: active-work.d/<セーフ形>.md から該当行を出す。exit 0=あり / 1=未登録 / 2=衝突
set -u
BRANCH="${1:-}"
[ -z "${BRANCH}" ] && exit 1
ROOT="$(git rev-parse --show-toplevel)"
FILE="${ROOT}/.claude-pipeline/active-work.d/${BRANCH//\//-}.md"
[ -f "${FILE}" ] || exit 1
DECLARED="$(grep -m1 '^branch: ' "${FILE}" | sed 's/^branch: //')"
[ "${DECLARED}" != "${BRANCH}" ] && exit 2
ROW="$(awk -F'|' -v b="${BRANCH}" 'NF>=4{f=$2; gsub(/^ +| +$/,"",f); if(f==b){print; exit}}' "${FILE}")"
[ -n "${ROW}" ] && { echo "${ROW}"; exit 0; }
exit 1
