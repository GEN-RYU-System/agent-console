# recon: Mac再起動後に会話タブが空になる（2026-10-15）

既存ADR: agent-console 自体に ADR 制度は無い。関連する salesanchor 側 ADR は無し（tmux 復元の判定は agent-console 内部の挙動）。

## 観測事実（生出力: /tmp/CC報告ファイル/agent-console-restart/ — ローカル）
- Mac起動 2026-10-15 20:53:35（01-boot-disk.txt）
- ~/Library/Application Support/agent-console/logs/server.out.log 末尾: `open-sessions: つなぎ直し 9・resume 1`
- ~/Library/Application Support/agent-console/logs/server.err.log:173-181: 9件 `terminal: ac-… is unreachable, trying to attach`
- 再起動後 tmux に残るのは resume された1件のみ（06-tmux.txt）
- 配布物 v0.38.0 server/sessions.ts:448-452: unreachable なら新規起動せず pid 0 でつなぎ直し待ち（空タブ）
- server/terminal-host/tmux-protocol.ts classifyHasSession: stderr が `can't find session|no server running|no current target` のときだけ gone
- server/terminal-host/tmux-runner.ts:60-68 probeSession: `display -p -t =name: #{pane_pid}`。rc=0 でも pid が数でなければ unreachable

## 実測（22-probe-matrix.txt, tmux 3.8）
| 条件 | 返り | 現行判定 |
|---|---|---|
| サーバー無し | `error connecting to /private/tmp/tmux-501/<socket> (No such file or directory)` rc=1 | unreachable（誤り） |
| サーバー有り・セッション無し（display） | 空出力 rc=0 | unreachable（誤り） |
| サーバー有り・セッション無し（has-session） | `can't find session: <name>` rc=1 | — |
| 生存セッション（display） | `1772` rc=0 | alive |
