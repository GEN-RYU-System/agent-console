#!/bin/bash
# Agent Console の導入・更新・切戻し・撤去スクリプトの共通部品。source して使う。
# 実環境を触る外部コマンドと置き場所は、すべて環境変数で差し替えられる（テストは一時ディレクトリ＋スタブ）。
# 秘密（サーバー秘密）は変数に持つだけで、引数・ログ・ps に出さない。
# 片付け（撤去・失敗した版・置き換える起動アプリ）は削除せず Trash へ移す（元に戻せる）。

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
AC_CURL="${AC_CURL:-curl}"
AC_REPO="${AC_REPO:-shingo-cc/agent-console}"
AC_PORT="${AC_PORT:-4319}"
AC_DIAG_PORT="${AC_DIAG_PORT:-4320}"
AC_LABEL="${AC_LABEL:-local.agent-console.server}"
AC_APP_NAME="Agent Console.app"
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
ac_lock_dir() { printf '%s/lock' "$AC_HOME"; }

ac_acquire_lock() {
  mkdir -p "$AC_HOME"
  local lock
  lock="$(ac_lock_dir)"
  if ! mkdir "$lock" 2>/dev/null; then
    local holder=""
    [ -f "$lock/pid" ] && holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      ac_log "前回の異常終了で残ったロックを解除します（pid $holder は存在しません）"
      rm -f "$lock/pid"
      rmdir "$lock" 2>/dev/null || ac_die "ロックを解除できません: $lock"
      mkdir "$lock" || ac_die "ロックを取得できません: $lock"
    else
      ac_die "別の導入・更新・切戻しが実行中です（ロック: ${lock}）"
    fi
  fi
  printf '%s\n' "$$" >"$lock/pid"
  trap 'ac_release_lock' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

ac_release_lock() {
  local lock
  lock="$(ac_lock_dir)"
  rm -f "$lock/pid" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
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

ac_healthy() {
  "$AC_CURL" -fsS -m 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1
}

ac_wait_healthy() {
  local port="$1" max="$2" waited=0
  until ac_healthy "$port"; do
    waited=$((waited + 1))
    [ "$waited" -le "$max" ] || return 1
    sleep 1
  done
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

# 起動アプリ（Dock 用）を雛形から生成する（既存のアプリは Trash へ移してから作る）
ac_build_launcher_app() {
  local template="$AC_SOURCE_DIR/ops/launcher/AgentConsole.applescript" app tmp
  ac_require_plain_path "$AC_HOME"
  app="$AC_APPS_DIR/$AC_APP_NAME"
  mkdir -p "$AC_APPS_DIR"
  tmp="$(mktemp "${TMPDIR:-/tmp}/ac-launcher.XXXXXX")"
  sed -e "s|__AC_HOME__|$(printf '%s' "$AC_HOME" | ac_sed_escape)|g" "$template" >"$tmp"
  ac_trash "$app" "app"
  "$AC_OSACOMPILE" -o "$app" "$tmp" || ac_die "起動アプリの生成に失敗しました"
  rm -f -- "$tmp"
}

# --- 版の導入（clone → npm ci → sa-sync → build → 別ポートで自己診断 → versions/<tag> へ） ---
ac_diagnose() {
  local dir="$1" node_bin="$2" pid_file log_file diag_pid ok=1
  pid_file="$AC_HOME/logs/diag.pid"
  log_file="$AC_HOME/logs/diag.log"
  [ -f "$dir/dist-server/server/index.js" ] || { ac_log "自己診断: dist-server/server/index.js がありません"; return 1; }
  (
    umask 077
    cd "$dir" || exit 1
    # 診断用の使い捨て秘密は環境変数で渡す（引数に出さない）。本番のキーチェーン秘密は使わない
    AGENT_CONSOLE_TOKEN="$(ac_random_hex)" AGENT_CONSOLE_PORT="$AC_DIAG_PORT" AGENT_CONSOLE_AUTH="" \
      "$node_bin" dist-server/server/index.js >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )
  diag_pid="$(cat "$pid_file")"
  # 診断サーバーが落ちたら待たずに失敗とする
  local waited=0
  while [ "$waited" -lt 15 ]; do
    if ac_healthy "$AC_DIAG_PORT"; then ok=0; break; fi
    kill -0 "$diag_pid" 2>/dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  kill "$diag_pid" 2>/dev/null || true
  wait "$diag_pid" 2>/dev/null || true
  rm -f "$pid_file"
  if [ "$ok" -ne 0 ]; then
    ac_log "自己診断に失敗しました（ログ: ${log_file}）"
    return 1
  fi
  ac_log "自己診断 OK（別ポート $AC_DIAG_PORT で /healthz が 200）"
}

ac_install_version() {
  local tag="$1" node_bin="$2" final tmp
  final="$AC_HOME/versions/$tag"
  if [ -d "$final" ]; then
    ac_log "$tag は導入済みです。自己診断だけ行います"
    ac_diagnose "$final" "$node_bin" || return 1
    return 0
  fi
  tmp="$AC_HOME/versions/.tmp-$tag-$$"
  ac_log "$tag を取得します"
  if ! "$AC_GH" repo clone "$AC_REPO" "$tmp" -- --branch "$tag" --depth 1 >&2; then
    ac_log "取得に失敗しました: $tag"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  if ! (
    cd "$tmp" &&
      "$AC_NPM" ci >&2 &&
      "$node_bin" scripts/sa-sync.mjs >&2 &&
      "$AC_NPM" run build >&2
  ); then
    ac_log "導入手順（npm ci / sa-sync / build）に失敗しました: $tag"
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  if ! ac_diagnose "$tmp" "$node_bin"; then
    ac_trash "$tmp" "failed-$tag"
    return 1
  fi
  mv "$tmp" "$final"
  ac_log "$tag を導入しました"
}

# サービスを再起動して /healthz を待つ。成功 0 / 失敗 1
ac_restart_and_wait() {
  "$AC_LAUNCHCTL" kickstart -k "gui/$AC_UID/$AC_LABEL" >/dev/null 2>&1 || true
  ac_wait_healthy "$AC_PORT" "$AC_HEALTH_WAIT_SEC"
}
