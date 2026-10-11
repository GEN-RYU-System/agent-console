#!/bin/bash
# 撤去: bootout → plist と起動アプリを Trash へ移す。versions/ とキーチェーンの秘密は残す（--purge で撤去）。
# 削除はせず、すべて ~/.Trash/agent-console-<種類>-<日時> へ移す（元に戻せる）。
# 使い方: bash scripts/ac-uninstall.sh [--purge]
set -euo pipefail
# shellcheck source=lib/ac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"

purge=0
case "${1:-}" in
  "") ;;
  --purge) purge=1 ;;
  *) ac_die "使い方: ac-uninstall.sh [--purge]" ;;
esac
ac_guard_test_paths

if [ "$purge" -eq 1 ] && [ ! -f "$AC_HOME/$AC_MARKER" ]; then
  ac_die "$AC_HOME に $AC_MARKER が無いため --purge しません（Agent Console の置き場所ではない可能性があります）"
fi
if [ -f "$AC_HOME/$AC_MARKER" ]; then ac_acquire_lock; fi

"$AC_LAUNCHCTL" bootout "gui/$AC_UID/$AC_LABEL" >/dev/null 2>&1 || ac_log "サービスは読み込まれていませんでした（続行）"

ac_trash "$(ac_plist_path)" "plist"
ac_trash "$AC_APPS_DIR/$AC_APP_NAME" "app"

if [ "$purge" -eq 1 ]; then
  ac_log "--purge: 導入済みの版を Trash へ移し、キーチェーンの秘密を削除します（秘密の削除は元に戻せません）"
  "$AC_SECURITY" delete-generic-password -s agent-console -a server >/dev/null 2>&1 || ac_log "キーチェーンの秘密はありませんでした（続行）"
  for d in versions current logs; do
    ac_trash "$AC_HOME/$d" "$d"
  done
  echo "撤去しました（導入済みの版は Trash へ移動。キーチェーンの秘密は削除）"
else
  echo "撤去しました（plist と起動アプリは Trash へ移動。導入済みの版 $AC_HOME/versions とキーチェーンの秘密は残してあります。完全に撤去するには --purge）"
fi
