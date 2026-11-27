#!/bin/bash
# 便1 測り直し: 今の版（v056copy）と直した版（v0561copy）を交互に 2 回ずつ。測り方は run9（measure5・AC_COALESCE なし）と同じ
set -u
B=/tmp/ac-smooth0b; S=$B/scripts; R=$B/run10; mkdir -p $R
for i in 1 2; do
  for v in base fix; do
    if test "$v" = base; then W=$B/v056copy; else W=$B/v0561copy; fi
    D=$R/$v$i; mkdir -p $D; uptime > $D/uptime.txt
    (cd $W && AC_WTROOT=$W AC_SMOOTH0B_SID=5dc7aa19-47c8-498f-aa23-dd121e620042 node_modules/.bin/tsx $S/servers2.ts start $D) > $D/start.log 2>&1
    (cd $S && AC_RUN_DIR=$D node measure5.mjs claude $D/claude-raw.json) > $D/measure.log 2>&1; echo "$v$i exit=$?"
    (cd $S && AC_RUN_DIR=$D node_modules/.bin/tsx servers2.ts stop $D) > $D/stop.log 2>&1
    tmux -L ac-smooth0b-test kill-server 2>/dev/null; uptime >> $D/uptime.txt
  done
done
echo ALLDONE
