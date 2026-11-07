#!/bin/bash
# Discord の受け口の設定ファイル（dataDir/discord-intake.config.json）を書く台本（PO が ! で実行）。
# 使い方: bash scripts/ac-discord-intake-config.sh（引数なし）
# 不具合のチャンネル1つを testMode で有効にする設定を書く。打った値は端末に表示される（id と呼び名は秘密ではない）が、ログ・エラー文には入れない。
# 書く前に node の中で決まり（id の形・bug は testMode・種類の重なりなし）を確かめ、合わなければ何も書かない。
# サーバーの起こし直しはここではしない。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"
ac_guard_test_paths

[ "$#" -eq 0 ] || ac_die "使い方: bash scripts/ac-discord-intake-config.sh（引数なし）"
[ -f "$AC_HOME/$AC_MARKER" ] || ac_die "agent-console が入っていません"

# 入力元: 試験の印（AC_STUB_LOG）があるときだけ AC_CONFIG_INPUT（1行1項目のファイル）、ないときは必ず端末
if [ -n "${AC_STUB_LOG:-}" ]; then
  src="${AC_CONFIG_INPUT:-/dev/tty}"
else
  src="/dev/tty"
fi
# exec の向け先の失敗は台本ごと終わって || に届かないことがあるため、子のシェルで先に開けるかを確かめる
( : <"$src" ) 2>/dev/null || ac_die "端末が無いため取り消しました（書いていません）"
exec 3<"$src"

file="$AC_HOME/discord-intake.config.json"
ask() { # 問いの文 → 変数 REPLY_VALUE
  printf '%s: ' "$1" >&2
  REPLY_VALUE=""
  if ! IFS= read -r -u 3 REPLY_VALUE; then
    printf '\n' >&2
    ac_die "取り消しました（書いていません）"
  fi
}

if [ -e "$file" ] || [ -L "$file" ]; then
  ask "設定ファイルが既にあります。上書きしますか（yes と打つと上書き）"
  [ "$REPLY_VALUE" = "yes" ] || ac_die "取り消しました（書いていません）"
fi

ask "サーバーの id（guildId）";                 guild="$REPLY_VALUE"
ask "不具合のチャンネルの id（channelId）";       channel="$REPLY_VALUE"
ask "投稿してよい人の Discord の id";             author="$REPLY_VALUE"
ask "その人の呼び名（1〜40字）";                  aname="$REPLY_VALUE"
ask "本番のボットの id";                          botid="$REPLY_VALUE"

is_id() { [[ "$1" =~ ^[0-9]{1,20}$ ]]; }
is_id "$guild"   || ac_die "サーバーの id の形が違います（数字1〜20桁）"
is_id "$channel" || ac_die "不具合のチャンネルの id の形が違います（数字1〜20桁）"
is_id "$author"  || ac_die "投稿してよい人の id の形が違います（数字1〜20桁）"
is_id "$botid"   || ac_die "本番のボットの id の形が違います（数字1〜20桁）"
[ "$channel" != "$botid" ] || ac_die "不具合のチャンネルの id と本番のボットの id が同じです"
[ "$author" != "$botid" ] || ac_die "投稿してよい人の id と本番のボットの id が同じです"

node="$(ac_resolve_node)"
tmp="$AC_HOME/discord-intake.config.json.tmp.$$"
trap 'rm -f "$tmp"' EXIT

# ①確かめて ②tmp に 0600 で書く（JSON は node の JSON.stringify で作る。値は環境変数で渡す）
AC_I_GUILD="$guild" AC_I_CHANNEL="$channel" AC_I_AUTHOR="$author" AC_I_NAME="$aname" AC_I_BOT="$botid" AC_I_TMP="$tmp" \
  "$node" -e '
const fs = require("node:fs");
const e = process.env;
const ID = /^[0-9]{1,20}$/;
const fail = (field) => { process.stderr.write("設定の決まりに合いません: " + field + "\n"); process.exit(2); };
if (![e.AC_I_GUILD, e.AC_I_CHANNEL, e.AC_I_AUTHOR, e.AC_I_BOT].every((v) => ID.test(v ?? ""))) fail("id");
const name = e.AC_I_NAME ?? "";
if (name.length < 1 || name.length > 40 || /[\r\n"\\]/.test(name)) fail("allowedAuthors.name");
if (e.AC_I_CHANNEL === e.AC_I_BOT || e.AC_I_AUTHOR === e.AC_I_BOT) fail("forbiddenBotIds");
const cfg = {
  testMode: true,
  forbiddenBotIds: [e.AC_I_BOT],
  channels: [{ kind: "bug", enabled: true, guildId: e.AC_I_GUILD, channelId: e.AC_I_CHANNEL, allowedAuthors: [{ id: e.AC_I_AUTHOR, name }], allowedMessageTypes: [0, 19] }],
};
fs.writeFileSync(e.AC_I_TMP, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
' || ac_die "設定の決まりに合わないため書きませんでした（元のファイルはそのままです）"
unset guild channel author aname botid

# ③古いファイルは Trash へ移す ④tmp を本名に置き換える（同じフォルダの中の名前の付け替え）
ac_trash "$file" intake-config
mv -- "$tmp" "$file" || ac_die "設定ファイルを置き換えられませんでした。元のファイルは Trash（intake-config）にあります"

ac_log "受け口の設定を書きました（値は表示しません）。サーバーを起こし直すと読みます: bash scripts/ac-update.sh <今の版>"
