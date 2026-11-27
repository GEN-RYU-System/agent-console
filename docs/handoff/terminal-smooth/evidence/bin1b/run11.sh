#!/bin/bash
# 便1b 測り直し: 今の版と直した版を交互に 5 回ずつ（判定は run11 の 5 回分の合計だけで行う。run10 は混ぜない。基準は §19 のまま）
set -u
B=/tmp/ac-smooth0b; S=$B/scripts; R=$B/run11; mkdir -p $R
for i in 1 2 3 4 5; do
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
