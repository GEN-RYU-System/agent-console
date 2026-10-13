#!/bin/bash
# e2e 用スタブ: `claude agents --json` / `claude --version`。
# 役割プロセス（コマンドラインに agent-console-e2e-role を含む）の pid に、$STUB_STATUS_FILE の状態を返す。
# 本物と同様に CRLF と末尾のエスケープを混ぜる。
case "${1:-}" in
  --version) echo "0.0.0-stub (Claude Code)"; exit 0 ;;
  agents)
    # $STUB_SLOW_FILE に秒数があるときだけ、その秒数待ってから答える（状態確認が遅い場面の再現用）
    SLOW="$(cat "${STUB_SLOW_FILE:-/dev/null}" 2>/dev/null | head -1)"
    [ -n "${SLOW}" ] && sleep "${SLOW}"
    STATUS="$(cat "${STUB_STATUS_FILE:-/dev/null}" 2>/dev/null || echo idle)"
    # $STUB_NAME_FILE に中身があるときだけ name を返す（Claude 側の名前。無ければアプリの名前が表示される）
    NAME="$(cat "${STUB_NAME_FILE:-/dev/null}" 2>/dev/null | head -1)"
    NAME_JSON=""
    [ -n "${NAME}" ] && NAME_JSON="\"name\":\"${NAME}\","
    # $STUB_UUID_FILE に中身があるときだけ、sessionId を pid から作った UUID の形にする（本物の claude は UUID を返す。既定は UUID でない "x"）
    UUID_MODE="$(cat "${STUB_UUID_FILE:-/dev/null}" 2>/dev/null | head -1)"
    PIDS="$(ps -axo pid=,command= | grep 'agent-console-e2e-role' | grep -v grep | awk '{print $1}')"
    printf '[\r\n'
    FIRST=1
    for P in ${PIDS}; do
      [ "${FIRST}" = 1 ] || printf ',\r\n'
      FIRST=0
      SESSION_ID="x"
      [ -n "${UUID_MODE}" ] && SESSION_ID="$(printf '00000000-0000-4000-8000-%012d' "${P}")"
      printf '{"pid":%s,"status":"%s",%s"sessionId":"%s","unknownKey":1}' "${P}" "${STATUS}" "${NAME_JSON}" "${SESSION_ID}"
    done
    printf '\r\n]\033[?25h'
    exit 0 ;;
  auth)
    # `auth status --json`: $STUB_AUTH_FILE の中身をそのまま返す。loggedIn が false なら終了コード 1（本物と同じ）
    # `auth logout` / `auth login`: 引数を $STUB_AUTH_LOG に 1 行追記して終了コード 0
    case "${2:-}" in
      status)
        cat "${STUB_AUTH_FILE:-/dev/null}" 2>/dev/null
        grep -q '"loggedIn": *false' "${STUB_AUTH_FILE:-/dev/null}" 2>/dev/null && exit 1
        exit 0 ;;
      logout|login)
        echo "auth $2" >> "${STUB_AUTH_LOG:-/dev/null}"
        exit 0 ;;
    esac ;;
esac
exit 1
