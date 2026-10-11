#!/bin/bash
# Dock の起動アプリから呼ばれる。サーバー秘密をキーチェーンから読み、1 回限りのペアリングコードを受け取り、
# Chrome のアプリ窓（--app）で /pair?code= を開く。秘密は変数に持つだけで、引数・URL・ログに出さない。
set -euo pipefail

AC_SECURITY="${AC_SECURITY:-/usr/bin/security}"
AC_CURL="${AC_CURL:-/usr/bin/curl}"
AC_LAUNCHCTL="${AC_LAUNCHCTL:-/bin/launchctl}"
AC_OPEN="${AC_OPEN:-/usr/bin/open}"
AC_PORT="${AC_PORT:-4319}"
AC_LABEL="${AC_LABEL:-local.agent-console.server}"
AC_UID="${AC_UID:-$(id -u)}"
AC_CHROME_APP="${AC_CHROME_APP:-Google Chrome}"
HEALTH_WAIT_SEC="${AC_HEALTH_WAIT_SEC:-10}"
BASE="http://127.0.0.1:${AC_PORT}"

die() {
  echo "agent-console launcher: $*" >&2
  exit 1
}

healthy() {
  "$AC_CURL" -fsS -m 2 "${BASE}/healthz" >/dev/null 2>&1
}

secret="$("$AC_SECURITY" find-generic-password -s agent-console -a server -w 2>/dev/null)" ||
  die "キーチェーンからサーバー秘密を読めません（scripts/ac-install.sh で導入してください）"
[ -n "$secret" ] || die "サーバー秘密が空です"

if ! healthy; then
  "$AC_LAUNCHCTL" kickstart "gui/${AC_UID}/${AC_LABEL}" >/dev/null 2>&1 || true
  waited=0
  until healthy; do
    waited=$((waited + 1))
    [ "$waited" -le "$HEALTH_WAIT_SEC" ] || die "サーバーが ${HEALTH_WAIT_SEC} 秒以内に起動しませんでした"
    sleep 1
  done
fi

# Authorization ヘッダは curl の設定として標準入力から渡す（printf は組み込みなので引数に載らない）
response="$(printf 'header = "Authorization: Bearer %s"\n' "$secret" |
  "$AC_CURL" -fsS -m 5 -X POST -K - "${BASE}/api/pair" 2>/dev/null)" || die "ペアリングコードを取得できません"
unset secret
code="$(printf '%s' "$response" | sed -n 's/.*"code":"\([0-9a-f]\{64\}\)".*/\1/p')"
unset response
[ -n "$code" ] || die "ペアリングコードの形式が不正です"

"$AC_OPEN" -na "$AC_CHROME_APP" --args "--app=${BASE}/pair?code=${code}"
