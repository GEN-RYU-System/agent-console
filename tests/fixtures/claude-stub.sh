#!/bin/bash
# e2e 用スタブ: `claude agents --json` / `claude --version`。
# 役割プロセス（コマンドラインに agent-console-e2e-role を含む）の pid に、$STUB_STATUS_FILE の状態を返す。
# 本物と同様に CRLF と末尾のエスケープを混ぜる。
case "${1:-}" in
  --version) echo "0.0.0-stub (Claude Code)"; exit 0 ;;
  agents)
    STATUS="$(cat "${STUB_STATUS_FILE:-/dev/null}" 2>/dev/null || echo idle)"
    PIDS="$(ps -axo pid=,command= | grep 'agent-console-e2e-role' | grep -v grep | awk '{print $1}')"
    printf '[\r\n'
    FIRST=1
    for P in ${PIDS}; do
      [ "${FIRST}" = 1 ] || printf ',\r\n'
      FIRST=0
      printf '{"pid":%s,"status":"%s","name":"stub","sessionId":"x","unknownKey":1}' "${P}" "${STATUS}"
    done
    printf '\r\n]\033[?25h'
    exit 0 ;;
esac
exit 1
