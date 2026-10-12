#!/bin/bash
# Agent Console の導入・更新・切戻し・撤去スクリプトの共通部品。source して使う。
# 実環境を触る外部コマンドと置き場所は、すべて環境変数で差し替えられる（テストは一時ディレクトリ＋スタブ）。
# 秘密（サーバー秘密）は変数に持つだけで、引数・ログ・ps に出さない。
# 片付け（撤去・失敗した版・置き換える起動アプリ）は削除せず Trash へ移す（元に戻せる）。

# 差し替え用の AC_* 環境変数は、テストモード（AC_STUB_LOG が設定されているとき）だけ有効。
# 本番実行では無視する（汚染された環境変数で取得元・security・curl・launchctl などが差し替わらないように）。
if [ -z "${AC_STUB_LOG:-}" ]; then
  unset AC_HOME AC_LAUNCH_AGENTS_DIR AC_APPS_DIR AC_TRASH AC_LAUNCHCTL AC_SECURITY AC_GH AC_NPM AC_OSACOMPILE \
    AC_PLUTIL AC_CODESIGN AC_CURL AC_REPO AC_PORT AC_DIAG_PORT AC_LABEL AC_UID AC_NODE AC_CLAUDE AC_HEALTH_WAIT_SEC
fi

AC_HOME="${AC_HOME:-$HOME/Library/Application Support/agent-console}"
AC_LAUNCH_AGENTS_DIR="${AC_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
AC_APPS_DIR="${AC_APPS_DIR:-$HOME/Applications}"
AC_TRASH="${AC_TRASH:-$HOME/.Trash}"
AC_LAUNCHCTL="${AC_LAUNCHCTL:-launchctl}"
AC_SECURITY="${AC_SECURITY:-security}"
AC_GH="${AC_GH:-gh}"
AC_NPM="${AC_NPM:-npm}"
AC_OSACOMPILE="${AC_OSACOMPILE:-osacompile}"
AC_PLUTIL="${AC_PLUTIL:-plutil}"
AC_CODESIGN="${AC_CODESIGN:-codesign}"
AC_CURL="${AC_CURL:-curl}"
AC_REPO="${AC_REPO:-GEN-RYU-System/agent-console}"
AC_PORT="${AC_PORT:-4319}"
AC_DIAG_PORT="${AC_DIAG_PORT:-4320}"
AC_LABEL="${AC_LABEL:-local.agent-console.server}"
AC_APP_NAME="Agent Console.app"
# osacompile が生成するアプリの Info.plist の CFBundleIconFile（実測: applet）
AC_ICON_FILE="applet.icns"
AC_ICON_REL="ops/launcher/icon/AgentConsole.icns"
AC_MARKER=".agent-console-home"
AC_UID="${AC_UID:-$(id -u)}"
AC_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AC_HEALTH_WAIT_SEC="${AC_HEALTH_WAIT_SEC:-20}"

ac_log() {
  printf '%s agent-console: %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

ac_die() {
  ac_log "エラー: $*"
  exit 1
}

# テストモード（AC_STUB_LOG が設定されている）では、触る場所が一時ディレクトリ配下であることを強制する。
ac_guard_test_paths() {
  [ -n "${AC_STUB_LOG:-}" ] || return 0
  local p
  for p in "$AC_HOME" "$AC_LAUNCH_AGENTS_DIR" "$AC_APPS_DIR" "$AC_TRASH"; do
    case "$p" in
      /tmp/* | /private/tmp/* | /var/folders/* | /private/var/folders/*) ;;
      *) ac_die "テストモードでは一時ディレクトリ以外を対象にできません: $p" ;;
    esac
  done
}

ac_require_tag() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || ac_die "版は vX.Y.Z の形で指定してください（指定値: ${1:-なし}）"
}

# AppleScript に埋め込むため、引用符・バックスラッシュ・改行を含むパスは受け付けない
ac_require_plain_path() {
  case "$1" in
    *'"'* | *'\'* | *$'\n'*) ac_die "パスに使えない文字が含まれています: $1" ;;
  esac
  [[ "$1" = /* ]] || ac_die "絶対パスで指定してください: $1"
}

ac_init_dirs() {
  mkdir -p "$AC_HOME/versions" "$AC_HOME/logs"
  : >"$AC_HOME/$AC_MARKER"
}

# --- 片付け: 削除せず Trash へ移す（~/.Trash/agent-console-<種類>-<日時>） ---
# 許可する元の場所: マーカーのある AC_HOME 配下、AC_LAUNCH_AGENTS_DIR 配下、AC_APPS_DIR 配下のみ
ac_trash() {
  local src="$1" kind="$2" dest ts
  [ -e "$src" ] || [ -L "$src" ] || return 0
  case "$src" in
    "$AC_HOME"/?*)
      [ -f "$AC_HOME/$AC_MARKER" ] || ac_die "AC_HOME に $AC_MARKER が無いため移動しません: $AC_HOME"
      ;;
    "$AC_LAUNCH_AGENTS_DIR"/?* | "$AC_APPS_DIR"/?*) ;;
    *) ac_die "対象外の場所のため移動しません: $src" ;;
  esac
  ts="$(date '+%Y%m%d-%H%M%S')"
  dest="$AC_TRASH/agent-console-$kind-$ts"
  [ ! -e "$dest" ] || dest="$dest-$$"
  mkdir -p "$AC_TRASH"
  mv -- "$src" "$dest"
  ac_log "Trash へ移しました: $dest"
}

# --- 排他（macOS に flock は無いので mkdir ロック＋trap） ---
# 保持者は、ロック直下の空ディレクトリ pid-<pid> で表す（ファイルを作らない＝rmdir だけで解除できる）。
AC_LOCK_STALE_SEC=600
AC_LOCK_OWNED=0

ac_lock_dir() { printf '%s/lock' "$AC_HOME"; }

# 更新時刻（エポック秒）。GNU と BSD で stat の意味が違うため、GNU 形式（-c %Y）を先に試す。
#  - GNU: `-c format` と `%Y`（最終更新のエポック秒）。`-f` は「ファイルシステムの状態」で、`stat -f %m <file>` は
#    ファイル情報ではなく複数行（"File: …"）を出して終了コード 0 になる（CI ubuntu で再現）
#  - BSD(macOS): `-c` は "illegal option" で失敗するので、次の `-f %m`（最終更新のエポック秒）に落ちる
# 数値以外が返ったら 0 を返す（古い扱い）ではなく失敗にして、呼び出し側で安全側（回収しない）に倒す
ac_mtime() {
  local out
  out="$(stat -c %Y "$1" 2>/dev/null)" || out="$(stat -f %m "$1" 2>/dev/null)" || return 1
  [[ "$out" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$out"
}

# ロックの保持者（pid-<n> の n）を出す。無ければ空
ac_lock_holder() {
  local d
  for d in "$(ac_lock_dir)"/pid-*; do
    [ -d "$d" ] || continue
    basename "$d" | sed 's/^pid-//'
    return 0
  done
}

ac_lock_busy() {
  ac_die "別の導入・更新・切戻しが実行中です（ロック: $(ac_lock_dir)）"
}

ac_take_lock() {
  local lock
  lock="$(ac_lock_dir)"
  # mkdir 成功の直後に保持者を記録する
  mkdir "$lock/pid-$$" 2>/dev/null || { rmdir "$lock" 2>/dev/null || true; ac_lock_busy; }
  AC_LOCK_OWNED=1
  trap 'ac_release_lock' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

ac_acquire_lock() {
  mkdir -p "$AC_HOME"
  local lock holder age mtime
  lock="$(ac_lock_dir)"
  if mkdir "$lock" 2>/dev/null; then
    ac_take_lock
    return
  fi
  # 既にロックがある。回収してよいのは次の 2 つだけ
  #  (1) pid-<n> があり、そのプロセスが存在しない
  #  (2) pid-<n> が無く、ロックの作成から AC_LOCK_STALE_SEC 秒を超えている（mkdir 直後に落ちた場合）
  # 回収の各段（rmdir / mkdir）のどれかが失敗した側は「実行中」として中止する（同時回収で両方が取得しない）
  holder="$(ac_lock_holder)"
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null && ac_lock_busy
    ac_log "前回の異常終了で残ったロックを回収します（pid $holder は存在しません）"
    rmdir "$lock/pid-$holder" 2>/dev/null || ac_lock_busy
  else
    mtime="$(ac_mtime "$lock")" || { ac_log "ロックの作成時刻を取得できないため回収しません"; ac_lock_busy; }
    age=$(($(date +%s) - mtime))
    [ "$age" -gt "$AC_LOCK_STALE_SEC" ] || ac_lock_busy
    ac_log "保持者の記録が無いまま ${age} 秒経ったロックを回収します"
  fi
  rmdir "$lock" 2>/dev/null || ac_lock_busy
  mkdir "$lock" 2>/dev/null || ac_lock_busy
  ac_take_lock
}

ac_release_lock() {
  [ "$AC_LOCK_OWNED" -eq 1 ] || return 0
  local lock
  lock="$(ac_lock_dir)"
  rmdir "$lock/pid-$$" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
  AC_LOCK_OWNED=0
}

# --- 版の管理 ---
ac_current_tag() {
  local target
  target="$(readlink "$AC_HOME/current" 2>/dev/null || true)"
  [ -n "$target" ] && basename "$target"
}

ac_switch_current() {
  local tag="$1"
  [ -d "$AC_HOME/versions/$tag" ] || ac_die "未導入の版です: $tag"
  ln -sfn "versions/$tag" "$AC_HOME/current"
}

# 導入済みの版を semver 昇順で 1 行ずつ出す（versions/ の中身が正本。一時ディレクトリは除く）
ac_list_versions() {
  local d
  for d in "$AC_HOME"/versions/v*; do
    [ -d "$d" ] || continue
    basename "$d"
  done | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/'
}

ac_random_hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# /healthz の本文が期待の版・コミットと一致するか（旧プロセスや別プロセスの応答では成功にしない）
ac_healthz_matches() {
  local port="$1" version="$2" commit="$3" body
  body="$("$AC_CURL" -fsS -m 2 "http://127.0.0.1:$port/healthz" 2>/dev/null)" || return 1
  [ "$body" = "{\"ok\":true,\"version\":\"$version\",\"commit\":\"$commit\"}" ]
}

ac_wait_matches() {
  local port="$1" version="$2" commit="$3" max="$4" waited=0
  until ac_healthz_matches "$port" "$version" "$commit"; do
    waited=$((waited + 1))
    [ "$waited" -le "$max" ] || return 1
    sleep 1
  done
}

ac_commit_of() {
  git -C "$1" rev-parse HEAD 2>/dev/null
}

ac_resolve_node() {
  if [ -n "${AC_NODE:-}" ]; then
    printf '%s' "$AC_NODE"
    return
  fi
  command -v node || ac_die "node が見つかりません"
}

# launchd の PATH は最小限なので、node と claude のあるディレクトリを含めた PATH を plist に書く
ac_build_path() {
  local node_bin="$1" claude_bin="${AC_CLAUDE:-}" out="" d claude_dir=""
  [ -n "$claude_bin" ] || claude_bin="$(command -v claude 2>/dev/null || true)"
  [ -z "$claude_bin" ] || claude_dir="$(dirname "$claude_bin")"
  for d in "$(dirname "$node_bin")" "$claude_dir" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    [ -n "$d" ] || continue
    case ":$out:" in *":$d:"*) continue ;; esac
    out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}

ac_xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# 置換値を sed の置換文字列として安全にする（\ & | をエスケープ）
ac_sed_escape() {
  sed -e 's/[\\&|]/\\&/g'
}

ac_plist_path() { printf '%s/%s.plist' "$AC_LAUNCH_AGENTS_DIR" "$AC_LABEL"; }

# 雛形から plist を生成して lint する（既存の plist は Trash へ移してから書く）
ac_write_plist() {
  local node_bin="$1" template="$AC_SOURCE_DIR/ops/launchd/local.agent-console.server.plist.template"
  local plist current logs path_value node_esc label_esc
  plist="$(ac_plist_path)"
  current="$(printf '%s' "$AC_HOME/current" | ac_xml_escape | ac_sed_escape)"
  logs="$(printf '%s' "$AC_HOME/logs" | ac_xml_escape | ac_sed_escape)"
  path_value="$(ac_build_path "$node_bin" | ac_xml_escape | ac_sed_escape)"
  node_esc="$(printf '%s' "$node_bin" | ac_xml_escape | ac_sed_escape)"
  label_esc="$(printf '%s' "$AC_LABEL" | ac_xml_escape | ac_sed_escape)"
  mkdir -p "$AC_LAUNCH_AGENTS_DIR"
  ac_trash "$plist" "plist"
  sed -e "s|__LABEL__|$label_esc|g" -e "s|__NODE__|$node_esc|g" -e "s|__CURRENT__|$current|g" \
    -e "s|__LOGS__|$logs|g" -e "s|__PATH__|$path_value|g" "$template" >"$plist"
  if [ "$(uname -s)" = "Darwin" ] || [ -n "${AC_STUB_LOG:-}" ]; then
    "$AC_PLUTIL" -lint "$plist" >/dev/null || ac_die "生成した plist の lint に失敗しました: $plist"
  fi
}

# 起動アプリ（Dock 用）を雛形から生成する（既存のアプリは Trash へ移してから作る。スクリプトは標準入力で渡し、一時ファイルを作らない）
# 第2引数: アイコン（icns）を取る版のタグ（$AC_HOME/versions/<tag>/ops/launcher/icon/AgentConsole.icns）
# 第3引数: "require" のとき icns が無ければ失敗、それ以外は標準の絵で作り、その旨を出力する
ac_build_launcher_app() {
  local node_bin="$1" tag="$2" mode="${3:-optional}" template="$AC_SOURCE_DIR/ops/launcher/AgentConsole.applescript" app icon
  icon="$AC_HOME/versions/$tag/$AC_ICON_REL"
  ac_require_plain_path "$AC_HOME"
  ac_require_plain_path "$node_bin"
  if [ ! -f "$icon" ]; then
    [ "$mode" = "require" ] && ac_die "アイコン（${AC_ICON_REL}）が $tag にありません。起動アプリを作れません"
    icon=""
  fi
  app="$AC_APPS_DIR/$AC_APP_NAME"
  mkdir -p "$AC_APPS_DIR"
  ac_trash "$app" "app"
  sed -e "s|__AC_HOME__|$(printf '%s' "$AC_HOME" | ac_sed_escape)|g" -e "s|__AC_NODE__|$(printf '%s' "$node_bin" | ac_sed_escape)|g" "$template" |
    "$AC_OSACOMPILE" -o "$app" || ac_die "起動アプリの生成に失敗しました"
  if [ -z "$icon" ]; then
    ac_log "$tag にはアイコンが無いため、起動アプリは標準の絵で作りました"
    echo "起動アプリ: $tag にアイコンが無いため標準の絵で作りました"
    return 0
  fi
  mkdir -p "$app/Contents/Resources"
  cp "$icon" "$app/Contents/Resources/$AC_ICON_FILE" || ac_die "アイコンの複製に失敗しました"
  # 差し替えで osacompile の署名が無効になるため、ad-hoc 署名をし直す（新しい鍵・証明書は使わない）
  if [ "$(uname -s)" = "Darwin" ] || [ -n "${AC_STUB_LOG:-}" ]; then
    "$AC_CODESIGN" --force --sign - "$app" >/dev/null 2>&1 || ac_die "起動アプリの再署名に失敗しました"
  fi
  touch "$app"
  ac_log "起動アプリのアイコンを $tag のものにしました"
}

# --- 版の導入（clone → 到達性確認 → npm ci --ignore-scripts → postinstall → sa-sync → build → 別ポートで自己診断 → versions/<tag> へ） ---
# 診断サーバーを別ポートで起動し、/healthz の本文が期待の版・コミットと一致したら成功
ac_diagnose() {
  local dir="$1" node_bin="$2" version="$3" commit="$4" diag_pid log_file ok=1 waited=0 old_pwd old_umask
  log_file="$AC_HOME/logs/diag.log"
  [ -f "$dir/dist-server/server/index.js" ] || { ac_log "自己診断: dist-server/server/index.js がありません"; return 1; }
  old_pwd="$PWD"
  old_umask="$(umask)"
  umask 077
  cd "$dir" || return 1
  # 診断用の使い捨て秘密は環境変数で渡す（引数に出さない）。本番のキーチェーン秘密は使わない
  # AGENT_CONSOLE_RESTORE=off: 本番と同じ dataDir を読むので、前回のセッションの復元と復元リストの書込をさせない
  AGENT_CONSOLE_TOKEN="$(ac_random_hex)" AGENT_CONSOLE_PORT="$AC_DIAG_PORT" AGENT_CONSOLE_AUTH="" AGENT_CONSOLE_RESTORE=off \
    "$node_bin" dist-server/server/index.js >"$log_file" 2>&1 &
  diag_pid=$!
  cd "$old_pwd" || return 1
  umask "$old_umask"
  # 診断サーバーが落ちたら待たずに失敗とする
  while [ "$waited" -lt 15 ]; do
    if ac_healthz_matches "$AC_DIAG_PORT" "$version" "$commit"; then ok=0; break; fi
    kill -0 "$diag_pid" 2>/dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  kill "$diag_pid" 2>/dev/null || true
  wait "$diag_pid" 2>/dev/null || true
  if [ "$ok" -ne 0 ]; then
    ac_log "自己診断に失敗しました（期待: version $version / commit ${commit}。ログ: ${log_file}）"
    return 1
  fi
  ac_log "自己診断 OK（別ポート $AC_DIAG_PORT の /healthz が version ${version}・commit ${commit:0:7} と一致）"
}

# タグのコミットが origin/main から到達可能か（GitHub の compare API: identical か behind なら到達可能）
ac_reachable_from_main() {
  local sha="$1" status
  status="$("$AC_GH" api "repos/$AC_REPO/compare/main...$sha" --jq .status 2>/dev/null)" || return 1
  case "$status" in identical | behind) return 0 ;; *) ac_log "コミット $sha は origin/main から到達できません（compare の status: ${status:-不明}）"; return 1 ;; esac
}

# 成功すると AC_LAST_COMMIT にタグのコミット SHA が入る
AC_LAST_COMMIT=""
ac_install_version() {
  local tag="$1" node_bin="$2" final tmp version sha
  version="${tag#v}"
  final="$AC_HOME/versions/$tag"
  if [ -d "$final" ]; then
    sha="$(ac_commit_of "$final")" || sha=""
    [ -n "$sha" ] || { ac_log "$tag のコミットを取得できません"; return 1; }
    ac_log "$tag は導入済みです（コミット ${sha}）。自己診断だけ行います"
    ac_diagnose "$final" "$node_bin" "$version" "$sha" || return 1
    AC_LAST_COMMIT="$sha"
    return 0
  fi
  tmp="$AC_HOME/versions/.tmp-$tag-$$"
  ac_log "$tag を取得します"
  if ! "$AC_GH" repo clone "$AC_REPO" "$tmp" -- --branch "$tag" --depth 1 >&2; then
    ac_log "取得に失敗しました: $tag"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  sha="$(ac_commit_of "$tmp")" || sha=""
  if [ -z "$sha" ]; then
    ac_log "取得した $tag のコミットを確認できません"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  ac_log "$tag のコミット: $sha"
  if ! ac_reachable_from_main "$sha"; then
    ac_log "$tag は origin/main に含まれないコミットを指しています。導入を中止します"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  # 依存のライフサイクルスクリプトは実行しない（--ignore-scripts）。必要な処理（node-pty の spawn-helper の実行権）は
  # リポジトリ内の scripts/postinstall.mjs を明示的に実行する
  if ! (
    cd "$tmp" &&
      "$AC_NPM" ci --ignore-scripts >&2 &&
      "$node_bin" scripts/postinstall.mjs >&2 &&
      "$node_bin" scripts/sa-sync.mjs >&2 &&
      "$AC_NPM" run build >&2
  ); then
    ac_log "導入手順（npm ci --ignore-scripts / postinstall / sa-sync / build）に失敗しました: $tag"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  if ! ac_diagnose "$tmp" "$node_bin" "$version" "$sha"; then
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  mv "$tmp" "$final"
  AC_LAST_COMMIT="$sha"
  ac_log "$tag を導入しました（コミット ${sha}）"
}

# サービスを再起動して、/healthz の本文が指定した版（タグ）の期待値と一致するまで待つ。成功 0 / 失敗 1
ac_restart_and_wait() {
  local tag="$1" sha
  sha="$(ac_commit_of "$AC_HOME/versions/$tag")" || return 1
  "$AC_LAUNCHCTL" kickstart -k "gui/$AC_UID/$AC_LABEL" >/dev/null 2>&1 || true
  ac_wait_matches "$AC_PORT" "${tag#v}" "$sha" "$AC_HEALTH_WAIT_SEC"
}
