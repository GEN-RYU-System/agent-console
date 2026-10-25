#!/bin/bash
# Discord の秘密（ボットのトークン・報告チャンネルの Webhook URL）を Keychain に登録する台本（PO が ! で実行）。
# 使い方: bash scripts/ac-discord-secret.sh discord-bot | discord-report-webhook
# 値は入力画面（点で隠す）で受け取り、security の標準入力にだけ渡す（引数・標準出力・標準エラー・ログに出さない）。
# 形の決まりは server/discord-credentials.ts の1か所。ここでは保存だけして、形は状態の入口（credentials）で確かめる。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"
ac_guard_test_paths

account="${1:-}"
[ "$#" -eq 1 ] || ac_die "使い方: bash scripts/ac-discord-secret.sh discord-bot | discord-report-webhook"
case "$account" in
  discord-bot) prompt="Discord のボットのトークンを貼り付けてください" ;;
  discord-report-webhook) prompt="報告チャンネルの Webhook の URL を貼り付けてください" ;;
  *) ac_die "知らない項目です（discord-bot か discord-report-webhook を指定してください）" ;;
esac

if ! value="$("${AC_OSASCRIPT:-osascript}" -e "text returned of (display dialog \"$prompt\" default answer \"\" with hidden answer)")"; then
  ac_die "取り消しました（保存していません）"
fi

# security -i は1行の命令として読むので、空・空白・引用符・バックスラッシュ・改行は保存しない
if [ -z "$value" ]; then
  unset value
  ac_die "空の値は保存しません"
fi
case "$value" in
  *[[:space:]]* | *'"'* | *"'"* | *'\'*)
    unset value
    ac_die "空白・引用符・バックスラッシュを含む値は保存しません"
    ;;
esac

printf 'add-generic-password -U -s agent-console -a %s -w %s\n' "$account" "$value" | "$AC_SECURITY" -i >/dev/null
unset value
"$AC_SECURITY" find-generic-password -s agent-console -a "$account" >/dev/null 2>&1 ||
  ac_die "Keychain への保存を確認できませんでした"
ac_log "$account を Keychain に保存しました（値は表示しません）。形の確かめは画面の状態の入口で行います"
