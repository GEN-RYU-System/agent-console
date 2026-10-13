#!/bin/bash
# 工程0 R2/R5/K1/K11: launchd の job（使い捨ての launchctl submit）の下の node が起こした tmux が、SIGTERM の後も残るか。
# 別ソケット acstep0 と使い捨て dir だけを使う。本番の LaunchAgent・サーバー・dataDir には触らない。
set -u
REPO="$1"
OUT="$2"
SOCK=acstep0
LABEL=local.acstep0.job
CONF="$REPO/ops/tmux/agent-console.tmux.conf"
T=/opt/homebrew/bin/tmux
mkdir -p "$OUT"
: >"$OUT/server.log"
rm -f "$OUT/pane-pid.txt" "$OUT/attach-output.txt"

echo "== 1. submit job (node = server role) at $(date '+%T')"
# 汚れた環境（秘密）を job の環境に入れる: launchctl submit は環境を引き継がないので、sh -c の中で export する
launchctl submit -l "$LABEL" -o "$OUT/job.out" -e "$OUT/job.err" -- /bin/sh -c "export AGENT_CONSOLE_TOKEN=FAKE-SECRET-STEP0 AGENT_CONSOLE_AUTH=keychain AC_SECURITY=x; exec /usr/local/bin/node '$REPO/docs/handoff/keep-sessions/step0-scripts/r2-server.mjs' $SOCK '$CONF' '$OUT' '$REPO'"
for _ in $(seq 1 30); do [ -f "$OUT/pane-pid.txt" ] && break; sleep 0.5; done
PANE="$(cat "$OUT/pane-pid.txt")"
sleep 1
echo "pane_pid=$PANE"
echo "-- launchctl list (job)"; launchctl list | grep acstep0
echo "-- tmux list-sessions"; $T -L $SOCK ls
echo "-- tmux list-clients"; $T -L $SOCK list-clients
echo "-- K11: tmux global environment, secret names present? (names only)"
for k in AGENT_CONSOLE_TOKEN AGENT_CONSOLE_AUTH AC_SECURITY AC_STUB_LOG; do
  if $T -L $SOCK show-environment -g 2>/dev/null | grep -q "^$k="; then echo "$k: PRESENT in global env"; else echo "$k: absent in global env"; fi
done
echo "-- K11: tmux session environment, secret names present?"
for k in AGENT_CONSOLE_TOKEN AGENT_CONSOLE_AUTH AC_SECURITY AC_STUB_LOG; do
  if $T -L $SOCK show-environment -t "=ac-step0-r2" 2>/dev/null | grep -q "^$k="; then echo "$k: PRESENT in session env"; else echo "$k: absent in session env"; fi
done
echo "-- session env AC_RESUME_ID / TERM"; $T -L $SOCK show-environment -t "=ac-step0-r2" | grep -E "^(AC_RESUME_ID|TERM|LANG)="
echo "-- pane process environment (ps eww, names only for secrets)"
ps eww -p "$PANE" 2>/dev/null | tr ' ' '\n' | grep -E "^(AGENT_CONSOLE_TOKEN|AGENT_CONSOLE_AUTH|AC_SECURITY|AC_RESUME_ID|TERM|LANG)=" | sed -E 's/^(AGENT_CONSOLE_[A-Z]+|AC_SECURITY)=.*/\1=<PRESENT>/'
echo "-- pane screen"; $T -L $SOCK capture-pane -p -t "=ac-step0-r2:" | head -3

echo "== 2. SIGTERM the node via launchctl kill (same signal as kickstart -k) at $(date '+%T')"
launchctl kill SIGTERM "gui/$(id -u)/$LABEL"
sleep 2
echo "-- launchctl list (job)"; launchctl list | grep acstep0 || echo "(job not in list)"
echo "-- server.log"; cat "$OUT/server.log"
echo "-- ps (pane pid $PANE still alive, same pid?)"; ps -p "$PANE" -o pid,ppid,stat,command
echo "-- tmux list-sessions"; $T -L $SOCK ls
echo "-- tmux list-clients (expect empty)"; $T -L $SOCK list-clients
echo "-- tmux server process"; ps -axo pid,ppid,pgid,command | grep "[t]mux.*acstep0"

echo "== 3. launchctl remove at $(date '+%T')"
launchctl remove "$LABEL" 2>&1
sleep 1
echo "-- after remove: pane pid alive?"; ps -p "$PANE" -o pid,ppid,stat,command
echo "-- tmux list-sessions"; $T -L $SOCK ls
