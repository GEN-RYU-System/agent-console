#!/bin/bash
# SVG（正本）から AgentConsole.icns を作り直す。macOS 専用（iconutil）。Playwright の Chromium を使う。
# 使い方: bash ops/launcher/icon/build-icns.sh
# 一時物は mktemp 配下に作り、OS の一時領域に任せる（削除コマンドは使わない）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
[ "$(uname -s)" = "Darwin" ] || { echo "macOS でのみ実行できます（iconutil が必要）" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/ac-icon.XXXXXX")"
set_dir="$work/AgentConsole.iconset"
mkdir -p "$set_dir"
master="$work/master-1024.png"
(cd "$repo" && node "$here/render.mjs" "$master")

# iconutil の命名: icon_<n>x<n>.png と icon_<n>x<n>@2x.png（@2x は 2n px）
for n in 16 32 128 256 512; do
  /usr/bin/sips -z "$n" "$n" "$master" --out "$set_dir/icon_${n}x${n}.png" >/dev/null
  /usr/bin/sips -z "$((n * 2))" "$((n * 2))" "$master" --out "$set_dir/icon_${n}x${n}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$set_dir" -o "$here/AgentConsole.icns"
echo "wrote $here/AgentConsole.icns"
