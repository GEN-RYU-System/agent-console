# 設計案（草案・未承認）: Mac再起動後に会話タブが空になる不具合の修正（agent-console）

状態: 設計案作成済み／設計審査済み（同一AIの自己審査）／PO実装承認待ち／実装未着手

## 目的（POから見える変化）
Macを再起動してagent-consoleを開くと、前回開いていたタブが全部「続きから再開」され、画面が映り文字を送れる。

## 成功条件（○×）
| 基準 | 検証方法 |
|---|---|
| K1 再起動相当（tmuxサーバー無し）で起動すると、保存タブ全件が resume される | 単体テスト: probe が "error connecting to ... (No such file or directory)" を受けたら gone 判定 |
| K2 tmuxサーバーはあるがセッションが無いとき resume される | 単体テスト: display が rc=0・空出力なら gone 判定 |
| K3 本当に生きているセッションは二重起動しない（つなぎ直し） | 既存テスト tmux-fallback / sessions-close-pid0 が緑 |
| K4 実機: 再起動後に起動ログが「つなぎ直し 0・resume N」、全タブが映り送信できる | server.out.log と PO目視 |

## 現在地（事実・file:line は v0.38.0 配布物）
- 起動時、保存タブ10件のうち「つなぎ直し 9・resume 1」（logs/server.out.log 末尾）、9件が `is unreachable, trying to attach`（logs/server.err.log:173-181）
- server/sessions.ts:448-452 unreachable なら新規起動せず pid 0 でつなぎ直しを待つ（=空タブ）
- server/terminal-host/tmux-runner.ts:56-60 classifyHasSession: stderr が `can't find session|no server running|no current target` のときだけ gone。それ以外は unreachable
- tmux-runner.ts:60-65 probeSession は `display -p -t =name: #{pane_pid}` を使い、rc=0 でも pid が数字でなければ unreachable
- 実測（22-probe-matrix.txt, tmux 3.8）:
  - サーバー無し → `error connecting to /private/tmp/tmux-501/<socket> (No such file or directory)` rc=1 → 正規表現に無く unreachable
  - サーバー有り・セッション無し → 出力空・rc=0 → pid NaN → unreachable
  - has-session なら `can't find session: …` rc=1 を返す
- つまり「再起動でtmuxごと消えた」場合も「セッションだけ消えた」場合も、消えたものを「到達不能」と誤判定し resume しない

## 変更案
1. tmux-runner.ts probeSession: 先に `has-session -t =name` で存在確認（rc=1 + can't find/no server/error connecting…No such file or directory|Connection refused → gone）。存在する場合のみ display で pid を取る
2. classifyHasSession の gone 条件に `error connecting to .*\((No such file or directory|Connection refused)\)` を追加。Permission denied 等は unreachable のまま（二重起動防止を優先）
3. テスト追加: 上記3パターン（tests/unit/tmux-fallback.test.ts 付近）
- 触らない: sessions.ts の unreachable 時の扱い（本当に到達不能なら二重起動しない方針は維持）、restore.ts

## 代替案
- unreachable でも一定時間後に resume → 二重起動の危険があるため不採用

## リスクと対処
- gone 誤判定で同じ会話の claude が二重に動く → has-session で存在を確かめてから判定、権限エラーは gone にしない
- 担当(Sonnet)のBashが ac-routine-guard フックに止められる（本調査で発生）→ 実装時に止まったら言い換えず Opus へ戻す

## 今回の9タブの復旧
- 会話記録は残っている（23/24: 17:00〜20:54 更新の11件、例: AI保守運用24時間化の続き2・試作解析システム本番運用 等）
- open-sessions.json は現在1件のみ。9件は保存リストから外れているので、画面の「再開」から会話を選んで開き直す

## 戻し方 / 測り方
- 戻し方: current リンクを v0.38.0 に戻す
- 測り方: K1〜K3 は CI/単体テスト、K4 は次回再起動時の server.out.log
