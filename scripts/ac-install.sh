#!/bin/bash
# 初回導入: 秘密の作成 → 版の導入 → plist 書出し・lint・bootstrap → 起動アプリ生成 → /healthz 確認
# 使い方: bash scripts/ac-install.sh vX.Y.Z
set -euo pipefail
# shellcheck source=lib/ac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"

tag="${1:-}"
ac_require_tag "$tag"
ac_guard_test_paths
ac_require_plain_path "$AC_HOME"
node_bin="$(ac_resolve_node)"

ac_acquire_lock
ac_init_dirs

ensure_secret() {
  if "$AC_SECURITY" find-generic-password -s agent-console -a server >/dev/null 2>&1; then
    ac_log "サーバー秘密はキーチェーンに既にあります（作り直しません）"
    return
  fi
  local secret
  secret="$(ac_random_hex)"
  # security -i はコマンドを標準入力から読む。秘密を引数（ps に出る）に載せない
  printf 'add-generic-password -U -s agent-console -a server -w %s\n' "$secret" | "$AC_SECURITY" -i >/dev/null
  unset secret
  "$AC_SECURITY" find-generic-password -s agent-console -a server >/dev/null 2>&1 ||
    ac_die "キーチェーンへの秘密の保存を確認できませんでした"
  ac_log "サーバー秘密をキーチェーンに保存しました（値は表示しません）"
}

ensure_secret
ac_install_version "$tag" "$node_bin" || ac_die "$tag の導入に失敗しました（current は変更していません）"
ac_switch_current "$tag"
ac_write_plist "$node_bin"
ac_build_launcher_app "$node_bin"

plist="$(ac_plist_path)"
"$AC_LAUNCHCTL" bootout "gui/$AC_UID/$AC_LABEL" >/dev/null 2>&1 || true
"$AC_LAUNCHCTL" bootstrap "gui/$AC_UID" "$plist" || ac_die "launchctl bootstrap に失敗しました"

if ac_wait_matches "$AC_PORT" "${tag#v}" "$AC_LAST_COMMIT" "$AC_HEALTH_WAIT_SEC"; then
  health="200 ok（version ${tag#v}・commit ${AC_LAST_COMMIT:0:7} が一致）"
else
  health="失敗（期待の版・コミットで応答しません。ログ: $AC_HOME/logs/）"
fi
echo "--- 導入結果 ---"
echo "版: $tag"
echo "コミット: $AC_LAST_COMMIT"
"$AC_LAUNCHCTL" print "gui/$AC_UID/$AC_LABEL" 2>/dev/null | grep -E '^\s*(state|pid) =' || echo "launchctl print: 取得できません"
echo "healthz: $health"
case "$health" in "200 ok"*) ;; *) exit 1 ;; esac
