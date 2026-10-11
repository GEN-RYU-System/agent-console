#!/bin/bash
# Dock の起動アプリから呼ばれる。サーバーを相互認証（HMAC チャレンジ）で確かめてから、1 回限りのペアリングコードを受け取り、
# Chrome のアプリ窓（--app）で /pair?code= を開く。
# 長期秘密は変数に持つだけで、ネットワーク（4319 の相手）にも、引数・URL・ログにも出さない。
# 偽のサーバーが 4319 を先に待ち受けていても、サーバーの証明を検証できなければ何も送らずに中止する。
set -euo pipefail

# 差し替え用の AC_* は、テストモード（AC_STUB_LOG が設定されているとき）だけ有効
if [ -z "${AC_STUB_LOG:-}" ]; then
  unset AC_SECURITY AC_CURL AC_LAUNCHCTL AC_OPEN AC_PORT AC_LABEL AC_UID AC_CHROME_APP AC_HEALTH_WAIT_SEC
fi

AC_SECURITY="${AC_SECURITY:-/usr/bin/security}"
AC_CURL="${AC_CURL:-/usr/bin/curl}"
AC_LAUNCHCTL="${AC_LAUNCHCTL:-/bin/launchctl}"
AC_OPEN="${AC_OPEN:-/usr/bin/open}"
AC_PORT="${AC_PORT:-4319}"
AC_LABEL="${AC_LABEL:-local.agent-console.server}"
AC_UID="${AC_UID:-$(id -u)}"
AC_CHROME_APP="${AC_CHROME_APP:-Google Chrome}"
HEALTH_WAIT_SEC="${AC_HEALTH_WAIT_SEC:-10}"
# 起動アプリ（AppleScript）が導入時に解決した node の絶対パスを渡す
NODE_BIN="${AC_LAUNCHER_NODE:-node}"
PROOF_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pair-proof.mjs"
BASE="http://127.0.0.1:${AC_PORT}"

die() {
  echo "agent-console launcher: $*" >&2
  exit 1
}

healthy() {
  "$AC_CURL" -fsS -m 2 "${BASE}/healthz" >/dev/null 2>&1
}

post_json() {
  "$AC_CURL" -fsS -m 5 -X POST -H 'Content-Type: application/json' -d "$2" "${BASE}$1" 2>/dev/null
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\\([0-9a-f]\\{$3\\}\\)\".*/\\1/p"
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

# 1) チャレンジ: 乱数 cnonce を送る（秘密は送らない）
cnonce="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
challenge="$(post_json /api/pair/challenge "{\"cnonce\":\"${cnonce}\"}")" || die "チャレンジに失敗しました"
snonce="$(json_field "$challenge" snonce 64)"
server_proof="$(json_field "$challenge" proof 64)"
[ -n "$snonce" ] && [ -n "$server_proof" ] || die "チャレンジ応答の形式が不正です"

# 2) サーバーの証明を検証し、クライアントの証明を作る（秘密は標準入力で渡す。printf は組み込みなので引数に載らない）
client_proof="$(printf '%s' "$secret" | "$NODE_BIN" "$PROOF_SCRIPT" exchange "$cnonce" "$snonce" "$server_proof")" ||
  die "サーバーの証明が一致しません（偽のサーバーの可能性）。何も送らずに中止しました"
unset secret

# 3) クライアントの証明を送り、1 回限りのコードを受け取る
response="$(post_json /api/pair "{\"cnonce\":\"${cnonce}\",\"snonce\":\"${snonce}\",\"proof\":\"${client_proof}\"}")" ||
  die "ペアリングコードを取得できません"
code="$(json_field "$response" code 64)"
[ -n "$code" ] || die "ペアリングコードの形式が不正です"

"$AC_OPEN" -na "$AC_CHROME_APP" --args "--app=${BASE}/pair?code=${code}"
