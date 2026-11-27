#!/bin/bash
# 便0e: 試験用 agent-console（tmux 経由）と 直接 を同じ時間帯に交互に回す
set -u
B=/tmp/ac-smooth0b; S=$B/scripts; R=$B/run5; mkdir -p $R
for i in 1 2; do
  D=$R/ac$i; mkdir -p $D; uptime > $D/uptime.txt
  (cd $B/v056copy && AC_SMOOTH0B_SID=5dc7aa19-47c8-498f-aa23-dd121e620042 node_modules/.bin/tsx $S/servers.ts start $D) > $D/start.log 2>&1
  (cd $S && AC_RUN_DIR=$D node measure.mjs claude $D/claude-raw.json) > $D/claude-run.log 2>&1; echo "ac$i exit=$?"
  (cd $S && AC_RUN_DIR=$D node_modules/.bin/tsx servers.ts stop $D) >> $D/start.log 2>&1
  tmux -L ac-smooth0b-test kill-server 2>/dev/null; uptime >> $D/uptime.txt
  E=$R/direct$i; mkdir -p $E; uptime > $E/uptime.txt
  (cd $S && node direct.mjs $D/claude-raw.json $E/direct-raw.json) > $E/direct-run.log 2>&1; echo "direct$i exit=$?"
  uptime >> $E/uptime.txt
done
