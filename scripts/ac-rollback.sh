#!/bin/bash
# 1 つ前の版（semver 順）へ切戻し: current を切替 → 再起動 → /healthz 確認。失敗したら元に戻す。
# 使い方: bash scripts/ac-rollback.sh
set -euo pipefail
# shellcheck source=lib/ac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"

ac_guard_test_paths
[ -f "$AC_HOME/$AC_MARKER" ] || ac_die "導入されていません"
ac_acquire_lock

cur="$(ac_current_tag)"
[ -n "$cur" ] || ac_die "使用中の版が分かりません（current がありません）"

previous=""
while IFS= read -r v; do
  [ "$v" = "$cur" ] && break
  previous="$v"
done < <(ac_list_versions)
[ -n "$previous" ] || ac_die "$cur より前の版が導入されていません（切戻し先がありません）"

ac_switch_current "$previous"
if ! ac_restart_and_wait "$previous"; then
  ac_log "$previous での起動確認（/healthz の版・コミットの一致）に失敗しました。$cur に戻します"
  ac_switch_current "$cur"
  ac_restart_and_wait "$cur" || ac_log "警告: $cur への復帰後も /healthz が期待の版・コミットで応答しません"
  ac_die "切戻しに失敗しました（current は $cur に戻しました）"
fi
echo "切り戻しました: $cur -> ${previous}（コミット $(ac_commit_of "$AC_HOME/versions/$previous")）"
