# 工程0d 追加測定: control mode 方式の「確実に成功する」証拠（D1〜D5）

日付 2026-10-14。製品コードは触っていない。生データと道具は `/tmp/CC報告ファイル/keep-sessions/step0d/`（`scripts/` に道具、`raw/` に生出力、`d1/` `d2/` に daemon の記録、`try1/` は1回目の失敗した D2）。tmux 3.8、xterm.js 6.0.0（`/Users/tanizawashingo/agent-console-wt/keep-sessions/node_modules`）。
試験用ソケットは `acstep0d-*` のみ、LaunchAgent は `local.acstep0d.test` のみ。本番 `local.agent-console.server`（pid 71962、開始から終了まで同じ・`raw/cleanup.txt` 末尾）・`local.ac-update-when-idle`・ポート 4319〜4329 には触れていない。本番 job は `launchctl print` の読み取りだけ（`raw/prod-launchctl-print.txt`）。

## 共通の仕組み
- 本番 job の設定（`raw/prod-launchctl-print.txt` 末尾 `properties = runatload`、`raw/prod-plist-copy.txt`）: RunAtLoad=true、KeepAlive=false、ProcessType なし、AbandonProcessGroup なし、WorkingDirectory あり、minimum runtime=10・exit timeout=5（launchd 既定）。試験 job の plist（`scripts/mkplist.sh` が生成）は RunAtLoad=true・KeepAlive=false・WorkingDirectory・StandardOut/ErrPath のみで同じ。ProcessType と AbandonProcessGroup は書いていない（本番も無い）。
- `scripts/daemon.mjs`（node。launchd の job として動く）: 起動時に `has-session -t =<名前>` → 無ければ `new-session -d`、有れば再利用。続けて `spawn(tmux,["-u","-L",sock,"-f",conf,"-C","attach-session","-t","=<名前>"],{stdio:"pipe"})` で control client をつなぐ。`%output` を 8 進デコードして Buffer のまま `out-<run>.bin` に追記。入力は受信箱ファイル経由で `send-keys -t %0 -H`（1コマンド 1000 バイト以下に分割）、リサイズは `refresh-client -C`。再接続のとき（既存セッションを見つけたとき）は先入れ（`display -p` のフォーマット変数＋`capture-pane -p -e -S -`、alt 中は `-a` も）のバイト列を `replay-*.bin` に保存。SIGTERM を受けたら control client を kill して終了（本番の「attach だけ終わらせる」と同じ）。
- 時刻はすべて同じマシンの `Date.now()`（ms）。

## D1 本番と同じ形の再起動（`kickstart -k` ×3）: ○
方法: `launchctl bootstrap` → 6 秒後に基準 → 12 秒以上空けて `launchctl kickstart -k gui/501/local.acstep0d.test` を3回。毎回、6 秒後に pane の pid・開始時刻・tmux サーバー・client・出力の継続を記録（`scripts/d1.sh`、`raw/d1.txt`、`d1/events.log`）。pane は `sh -c 'while :; do echo tick $i $(date +%s); sleep 1; done'`。
| 項目 | 起動直後 | kick1 後 | kick2 後 | kick3 後 |
|---|---|---|---|---|
| launchd の runs / node pid | 1 / 95290 | 2 / 6357 | 3 / 16700 | 4 / 23306 |
| pane の pid | 95438 | 95438 | 95438 | 95438 |
| pane の開始時刻 (`ps -o lstart`) | 00:25:21 | 00:25:21 | 00:25:21 | 00:25:21 |
| tmux サーバー pid / ppid | 95422 / 1 | 95422 / 1 | 95422 / 1 | 95422 / 1 |
| control client | 1（95442） | 1（6450） | 1（16794） | 1（23362） |
| pane の最後の tick | 6 | 24 | 42 | 59（1秒1つで連続） |
再接続の時間（`raw/d1.txt` 末尾の events.log から計算。kick 発行時刻を起点）:
| kick | 旧 node が SIGTERM を見るまで | 新 node 起動まで | control client の `%begin/%end`（接続完了）まで | 新 node 起動から接続完了まで | 往復（display -p）| 先入れ作成 |
|---|---|---|---|---|---|---|
| 1 | 12ms | 128ms | 168ms | 40ms | 0ms | 2ms |
| 2 | 87ms | 305ms | 418ms | 114ms | 1ms | 4ms |
| 3 | 42ms | 184ms | 250ms | 67ms | 1ms | 6ms |
【事実】3回とも pane の pid・開始時刻・tmux サーバーが同じ。新しい node が control client をつなぎ直せた（`ctl-exit code 0` の旧 client → 新 client）。kick 発行から接続完了まで 168〜418ms。旧 node の `kickstart -k` は SIGTERM（`signal` ログに `SIGTERM`）で、node は自分で終了した。
【事実】別の追試（D2b）で、前回の起動から 10 秒以内に `kickstart -k` を打つと、新 node の起動まで 1162ms かかった（`raw/d2b-driver.log` の tK と `d2/events.log`。launchd の minimum runtime 10 秒の影響と考えられるが、その因果は【未確認】）。
後片付け: `raw/d1-cleanup.txt`（bootout rc=0、kill-server rc=0）。
注意【事実】: SIGKILL による node 停止（`exit timeout` 5 秒を超えた場合）は測っていない【未確認】。

## D2 本物の claude の作業が再起動をまたぐ
経緯【事実】:
- 1回目（`try1/`）: claude の Bash ツールの出力は画面で「Ran 1 shell command」に畳まれ、`step N` が画面に出ない（`try1/d2-prekick-plain.txt`）ため、画面で待つ作りだと待つ前に作業が終わってしまい、kick が作業の後になった。この結果は採用しない（キー反応の数値だけ参考: slash 32ms / esc 172ms / abc 112ms / ctrl-u 192ms、`try1/d2-driver.log`）。
- 2回目（やり直し1回）: コマンドを `... | tee -a <steps.txt>` にして、ファイルで進み具合を見た。以降の数値は2回目。起動方法は pane を `sh -c '(60行の埋め行 "step N (claude 起動前の埋め行)" を出す); exec claude --model sonnet --allowedTools Bash'`（信頼済みの使い捨てディレクトリ、`CLAUDE_CODE*` なし＝launchd の環境）。埋め行は「再起動前の行がスクロールバックに入るか」を見るための仕掛けで、claude 自身の出力ではない。
- 【事実・要注意】その後の追試（下の (b) の作業中再接続と D3 の注入）で claude の `!` bash モード（`!for i in ...`、`!sleep 6`）を使った。モデルへの依頼のつもりではなかったが、`raw/d2b-final-plain.txt` には `⏺ 完了`＋`Stop hooks` が出ており、使用量表示が 7% → 9% に増えた（同ファイル）。bash モードの出力に claude が1回応答した形で、依頼は「D2 の1回＋やり直し1回」に加えて、この意図しない応答が少なくとも1回あった。

結果（`raw/d2-driver.log`）:
- (a) 作業が DONE まで終わるか: ○。`step 8` を `d2/steps.txt` で確認した時点で `kickstart -k`（kick 発行 → 旧 node の SIGTERM +23ms → 新 node 起動 +216ms → 接続完了 +286ms → 先入れ作成完了 +295ms、`d2/events.log`）。pane の pid は kick の前後とも 2652、開始時刻 `00:30:23` も同じ（`same:true`）。`steps.txt` は step 1〜30 と DONE が揃い（30 行＋DONE）、画面は `Ran 1 shell command / ⏺ 完了 / ✻ Sautéed for 44s · done 0:31`（`raw/d2-final-plain.txt`）。kick から DONE まで 24953ms。
- (b) 再接続直後に先入れした xterm.js の画面テキスト＝同時点の `capture-pane -p`: ○（行の文字列 30 行すべて一致、差 0）。測り方: `scripts/cmp.mjs`（Playwright の Chromium、xterm.js 120x30、scrollback 2000）に `replay-*.bin` を書き、可視 30 行（行末の空白除去）を、先入れ作成の前と後に取った `capture-pane -p`（plainA/plainB）と比較。
  - 作業中の再接続（claude の `!` bash モードが `bang 6` まで進んだ時点で kick。`d2/replay-1791905605774-43997-1.*`）: xterm vs plainA 差 0 行、vs plainB 差 0 行、plainA vs plainB 差 0 行（`raw/d2b-xterm-compare-new.json`）。バッファ種別 alternate、カーソル (2,26)＝tmux の `cursor_x=2 cursor_y=26`。先入れ作成 6ms・4,891 バイト。
  - claude への依頼を処理中だった再接続の replay ファイルは、保存名が同じ（`replay-<run>.bin`）だったため、同じ run の最後の replay で上書きされ、残っていない（私の道具の不具合）。事実として残っているのは `d2/events.log` の `replay ms 5, bytes 3557, alt true` と、上書き後（作業完了後の入力待ち状態）の比較（差 0 行、`raw/d2-xterm-compare.json`）。→ 依頼の処理中そのものの先入れの一致は【未確認】。代わりに上の bash モード作業中の結果を示した（モデル処理中ではない）。
  - 比較したのは画面の文字列だけ。セル属性（色・太字）と、カーソル形状の復元後の見た目は比較していない【未確認】。
- (c) スクロールバックに再起動前の行: 条件つき ○。claude は alternate screen で動く（`alternate_on=1`、%output に `?1049h` 1回）。claude 自身の会話・Bash 出力は alt 画面内で、tmux にも xterm.js にもスクロールバックとして残らない（`step N` の実行結果は claude が「Ran 1 shell command」に畳むので、どこにも出ない）。
  - 通常画面側（claude 起動前に出した 60 行の埋め行）: 先入れを `capture-pane -p -e -a -q -S -`（保存された通常画面 30 行）だけで作ると、xterm.js の通常バッファは 30 行で `step 1` が無い（`step 32`〜`60`、`raw/d2b-xterm-compare-old.json`）。`display -p '#{history_size}'` ぶんの履歴（`capture-pane -p -e -S -` の先頭 31 行）も先頭に足すと、通常バッファは 61 行になり `step 1`〜`step 60` が入る（`raw/d2b-xterm-compare-new.json`、`step1_in_normal:true`）。【事実】tmux は alt 中でも通常画面の履歴（hist=31）を保持し、`-a` は画面ぶんの 30 行しか返さない（`scripts/q.sh`: `-a lines: 30`、`plain -S - lines: 61`）。
- (d) 再接続後にキーが claude に届き反応する: ○（`raw/d2-driver.log`、`latency` は送信→最初の出力バイト）。
  | 送信 | 反応した画面 | 最初の出力まで |
  |---|---|---|
  | `/`（2f） | スラッシュ候補メニューが出る（`raw/d2-after-slash.txt`） | 17ms |
  | Esc（1b） | メニューが閉じ、入力欄は `/` が残る（`raw/d2-after-esc.txt`） | 99ms |
  | `abc` | 入力欄 `/abc`、`No commands match "/abc"`（`raw/d2-after-abc.txt`） | 70ms |
  | Ctrl+U（15） | 入力が消え `Ctrl+Y to paste deleted text`（`raw/d2-after-ctrlu.txt`） | 58ms |
  Esc で「作業を中断」する動き自体は試していない【未確認】（作業が終わった後に測った）。

## D3 claude が使う端末モード
方法: `display -p` のフォーマット変数を 1 秒ごとに記録（`raw/d3-samples.txt`、1回目の失敗した D2 の記録は `try1/d3-samples.txt`）。tmux 3.8 の `pane_private_modes`・`pane_key_mode` も別に記録（`raw/d3b-private-modes.txt`、`raw/d3-private-modes-idle.txt`）。`%output` の生バイトの `\e[?…h/l` を数えた（`scripts/seqcount.py`、`raw/d3-sequence-counts.txt`。1つ目が最初の接続の分、2つ目が再接続後の分）。
- フォーマット変数（起動中 → 入力待ち → 作業中 → 作業後は同じ値）【事実】: 起動直後の 4 サンプルだけ `alternate_on=0`・mouse 全 0・`bracket_paste_flag=0`。その後は一貫して `alternate_on=1`、`mouse_any_flag=1`、`mouse_all_flag=1`、`mouse_sgr_flag=1`、`mouse_standard_flag=0`、`mouse_button_flag=0`、`bracket_paste_flag=1`、`cursor_flag=1`（描画中に 0 が出る瞬間あり）、`keypad_cursor_flag=0`、`keypad_flag=0`、`cursor_shape=default`、`pane_in_mode=0`。入力待ち・作業中（Bash 実行中）・kick の前後で変化なし（`raw/d3-samples.txt`、`phase=` 列）。
- `pane_private_modes`（tmux 3.8）: `7,25,1003,1004,1006,2004,2031`（入力待ちも bash 作業中も同じ）、`pane_key_mode=Ext 2`。→ 1004（フォーカス報告）はこの変数で取れる。step0c C5 では「フォーマット変数で取れない」としていたが、`pane_private_modes` は C5 の変数一覧に入っていなかった。
- 生バイトの回数（最初の接続の分 14,155 バイト）: `?1004h` 2回・`?1004l` 1回、`?2004h` 3回・`?2004l` 1回、`?1000h/?1002h/?1003h/?1006h` 各2回、`?1049h` 1回、`?2026h/l`（同期出力）各119回、`?2031h` 2回・`?2031l` 1回、`?25h/?25l` 各120回、`\e[>4;Nm`（modifyOtherKeys）4回、`\e[<u` 5回。再接続後の分（21,813 バイト）: `?1000h/?1002h/?1003h/?1006h/?2004h` 各1回、`?1004` は0回、`?1049` は0回。
- フォーカス報告を claude が使うか【事実】: 使う。`?1004h` を出し、`pane_private_modes` に 1004 が入り、`\e[O`（フォーカス外れ）を `send-keys -H` で注入すると claude が 1,818 バイトの出力（再描画）を返し、`\e[I`（フォーカス入り）で 456 バイトを返した（`raw/d3b-private-modes.txt` 末尾）。
- 再接続後に失われる影響（具体）: 再接続後の `%output` に `?1004h` は来ない（上の0回）。先入れで 1004 を足さないと、xterm.js の `sendFocusMode` が false のまま（`raw/d2b-xterm-compare-new.json` の `modes.sendFocusMode:false`。この replay では 1004 を足していない）。その状態ではブラウザのフォーカス変化が `\e[I`/`\e[O` として claude に送られず、claude は上の再描画を起こさない。`pane_private_modes` から 1004 を足せるが、足した結果 xterm.js が実際に `\e[I/O` を送るかは測っていない【未確認】。また `?2031h`（テーマ通知）も同じく再接続後の `%output` に来ない（`pane_private_modes` には出る）。
- 補足【事実】: claude は alt screen で動くため、tmux 側のスクロールは使えず、マウスはすべて claude へ渡る（`mouse_any_flag=1` `mouse_all_flag=1`）。

## D4 終わり方の判定（`scripts/d4.mjs`、生データ `raw/d4.txt`）
control client に来る行（`%output` と `%begin/%end` を除く。時刻は attach 起点）と終了:
| 場面 | 来た行 | client の終了 | その後の `has-session` |
|---|---|---|---|
| (a1) 唯一のセッションの pane が exit 3 | `%session-changed $0 a1`（14ms）→ `%exit`（3024ms） | code 0・stderr 空 | `no server running on …/acstep0d-d4a1` rc=1（サーバーも終了。exit code 3 はどこにも来ない） |
| (a2) 2セッション、接続中の pane が終了 | `%session-changed`（8ms）→ `%exit`（3061ms） | code 0 | 終了した側 `can't find session: a2` rc=1、残り側 rc=0。サーバー生存 |
| (a3) 接続していない側の pane が終了 | `%sessions-changed` と `%unlinked-window-close @1`（3047ms 同時刻）。`%exit` は来ない | 継続 | `can't find session: gone` rc=1 |
| (a4) 本物の claude を `/exit` | `%session-changed $0 a4`（33ms）、`%window-renamed @0 2.1.296`（3813ms）、`%exit`（11447ms） | code 0 | `no server running on …/acstep0d-d4a4` rc=1。`/exit` 送信は 10811ms、`%exit` は 636ms 後 |
| (b1) 2セッション、接続中を別 client から kill-session | `%session-changed`（10ms）→ `%exit`（814ms） | code 0 | サーバー生存 |
| (b2) 唯一のセッションを kill-session | `%exit`（809ms） | code 0 | `no server running on …` rc=1 |
| (b3) control client 自身が `kill-session -t =b3` | `%exit`（802ms） | code 0 | - |
| (d) サーバーに SIGTERM | `%exit`（803ms） | code 0・stderr 空 | `no server running on …` rc=1 |
| (d) サーバーに SIGKILL | `%exit server exited unexpectedly`（805ms） | code 1 | `no server running on …` rc=1 |
| (d) サーバーに SIGHUP | 何も来ない | 継続 | サーバー生存、rc=0（SIGHUP は無視された） |
| (d) `kill-server` コマンド | `%exit`（808ms） | code 0 | `no server running on …` rc=1 |
【事実】`%exit` だけでは、pane の終了・kill-session・SIGTERM・kill-server を見分けられない（どれも `%exit`、code 0）。見分けられるのは SIGKILL（`%exit server exited unexpectedly`、code 1）だけ。`%window-close` は来なかった（来たのは別セッション側の `%unlinked-window-close`）。`%session-changed` は接続直後にだけ来て、終了時には来ない。

(c) `exit-empty` の on / off（control client なし。`raw/d4.txt` の `D4(c)`）:
| 設定 | 最後のセッションの消し方 | +0ms / +300ms / +1500ms の `has-session -t =c` | サーバー |
|---|---|---|---|
| on（リポジトリの設定） | kill-session | すべて rc=1・`no server running on /private/tmp/tmux-501/<sock>` | 即終了（+0ms で既に居ない） |
| on | pane の exit | 同上（`no server running on …`） | 終了 |
| off（設定の1行だけ変えた複製 `step0d/exit-empty-off.conf`） | kill-session | すべて rc=1・`no current target` | 生存 |
| off | pane の exit | すべて rc=1・`no current target` | 生存 |
off のとき、存在しない別名（`=zzz`）でも `no current target`（rc=1）。【事実】サーバーが生きていてセッションが1つも無いと `can't find session: <名前>` ではなく `no current target` になる。サーバーが生きていてセッションが他にある場合は `can't find session: <名前>`（(a2)(b1)）。step0.md の §10-B の3種類に、この `no current target` を足す必要がある。

## D5 1 サーバー・12 セッション・12 control client（`scripts/d5.mjs`、`raw/d5.txt`）
方法: 1つの tmux サーバー（ソケット `acstep0d-d5`）に pane 12 個（各 `read` で待つ）を作り、12 本の control client を attach（120x30）。各 pane に Enter を送って 1 MiB（1,048,576 バイトの ASCII）を出させ、全 client で `ENDMARK` が届くまでを測った。RSS は `ps -o rss=`（KB）。
| 状態 | tmux サーバー RSS | control client RSS（12 本） |
|---|---|---|
| 1 セッション・client 0 | 3,712 KB | - |
| 12 セッション・client 0 | 3,760 KB | - |
| 12 セッション・12 client・待機 | 3,872 KB | 4,032〜4,048 KB（合計 48,560 KB） |
| 全員に 1MB ずつ出した直後（1.5 秒後） | 20,336 KB（出力中に 22,432 KB を観測） | 1,648〜2,336 KB（合計 23,616 KB） |
| さらに 8 秒後 | 1,664 KB | 合計 19,392 KB |
時間: 12 本に 1MB ずつ送るよう同時に指示してから、各 client に `ENDMARK` が届くまで 946〜971ms（最後の client が 971ms）。各 client の回線上バイトは 1,137,559〜1,138,515（合計 13,653,755）。
【事実】RSS は macOS の圧縮・回収で上下する（待機 4MB の client が出力後 2MB に下がり、サーバーが 8 秒後に 20MB → 1.6MB に下がる）。ピークは 22MB 台。最大値と定常値の違いは `ps` の取り方で変わる。長時間の傾向は測っていない【未確認】。

## まとめ（事実のみ）
| 項目 | 結果 | 要点 |
|---|---|---|
| D1 launchd の再起動 ×3 | ○ | pane pid・開始時刻・サーバー同じ。接続完了まで 168/418/250ms。10 秒以内の連続 kick は新 node の起動が 1162ms |
| D2 本物の claude | ○（(b) の依頼処理中は【未確認】） | 作業が DONE まで継続。先入れ画面は差 0 行。通常画面履歴は `-S -` の先頭 history_size 行も足すと step 1 まで入る。キー反応 17〜99ms |
| D3 端末モード | 情報 | claude は alt screen・`?1004h`・`?2004h`・マウス 1003+1006・`?2031h`・modifyOtherKeys を使う。`pane_private_modes` で 1004 も取れる。フォーカス注入で claude が再描画する |
| D4 終わり方 | 情報 | `%exit` が基本で、理由は分からない。SIGKILL だけ `server exited unexpectedly`・code 1。exit-empty off は `no current target` |
| D5 12 本 | ○ | サーバー 3.7MB→ピーク約 22MB、client 約 4MB/本、1MB×12 は 0.95 秒 |

## 後片付け（`raw/cleanup.txt`）
`launchctl bootout`（rc=0）、`tmux -L acstep0d-d2 kill-server`、`/private/tmp/tmux-501/acstep0d-*` 18 本を個別に `rm -f`、plist を `rm -f`。後は `/private/tmp/tmux-501/` に `default` のみ、`launchctl list` に `acstep0d` なし、`ps` に残りなし。D1/D4/D5 の tmux サーバーは各試験の中で `kill-server` 済み。

## 再現
`scripts/mkplist.sh`（plist 生成）→ `launchctl bootstrap` → `scripts/d1.sh` / `scripts/d2.mjs`（1回目）/ `d2b.mjs`（追試）/ `d3b.mjs`、`scripts/cmp.mjs <replay.bin> <replay.json> <out.json>`、`scripts/d4.mjs`、`scripts/d5.mjs`。
