#!/bin/bash
# 版の更新: 導入（自己診断つき）→ current を切替 → 再起動 → /healthz 確認。失敗したら元の版に戻す。
# 使い方: bash scripts/ac-update.sh vX.Y.Z
set -euo pipefail
# shellcheck source=lib/ac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"

tag="${1:-}"
ac_require_tag "$tag"
ac_guard_test_paths
node_bin="$(ac_resolve_node)"

[ -f "$AC_HOME/$AC_MARKER" ] || ac_die "導入されていません。先に scripts/ac-install.sh を実行してください"
ac_acquire_lock

prev="$(ac_current_tag)"
[ -n "$prev" ] || ac_die "使用中の版が分かりません（current がありません）。scripts/ac-install.sh を実行してください"

ac_install_version "$tag" "$node_bin" || ac_die "$tag の導入（自己診断）に失敗しました。current は $prev のままです"
ac_switch_current "$tag"
if ! ac_restart_and_wait; then
  ac_log "$tag での起動確認に失敗しました。$prev に戻します"
  ac_switch_current "$prev"
  ac_restart_and_wait || ac_log "警告: $prev への切戻し後も /healthz が応答しません"
  ac_die "更新に失敗しました（current は $prev に戻しました）"
fi
echo "更新しました: $prev -> $tag"
