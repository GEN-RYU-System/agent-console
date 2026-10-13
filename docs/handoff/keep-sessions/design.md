# 設計: 更新してもセッションを切らない（tmux の control mode に端末を預ける）（第4版）

- 状態: 第4版。Fable 審査 APPROVE（2026-10-14、必須修正なし。推奨 R1〜R3 は反映済み）。PO 承認済み（2026-10-14。「この設計で作り始めてよいですか（y/n）」に PO が「y」）。
  - 第3版への審査は REVISE だった。この版はその指摘 1〜12 を反映した。
  - 審査の生出力: /tmp/CC報告ファイル/keep-sessions/review-v3/、review-v4/
- 実装について: PO の承認と実装カードが揃うまで始めない。
- 第2版（PO 承認 2026-10-13）からの変更
  - 第2版は `tmux attach` を node-pty でつなぐ方式だった。工程0で2つの問題が分かったため、つなぎ方を tmux の control mode（`tmux -C`）に変える。
    - スクロールバックが欠ける（R1。step0.md・step0b.md）。
    - Esc が約 0.6 秒遅れる（R3。同上）。
  - 目的、保存リスト、切戻しの決めは引き継ぐ。第2版の全文は docs/handoff/keep-sessions/design-v2.md に写した（会話の記録から復元した）。必要な所はこの版の本文に書き写したので、実装者は design-v2.md を読まなくてよい。
- 版の番号: 実装の時点の main の次の minor。
- PO の言葉（2026-10-13・14）
  - 「アップデートした後に会話の続きから再開させることは出来る？」
  - 「tmux の中で Claude を動かし、アプリの端末はつなぐだけにする」方向に y。
  - 切戻しの間は routine も止まり、同じ会話を手で開かない、に y。
  - control mode で測ることに y。
  - 「開発ルールも確認してレビュアーにも設計案をレビューしてもらい事実ベースで確実に成功するエビデンスを確立してくれ」
- 調査
  - docs/handoff/keep-sessions/recon.md（第2版の調査）
  - /tmp/CC報告ファイル/keep-sessions/recon3/recon3.md（df660d0 での照合）
  - /tmp/CC報告ファイル/keep-sessions/review-v3/（8f45eb7 での照合）
  - /tmp/CC報告ファイル/keep-sessions/v4-check/（この版で足した実測）
- 実測: docs/handoff/keep-sessions/ の step0.md・step0b.md・step0c.md・step0d.md
- 対象ADR: なし。agent-console に ADR は無く、README.md:123-128 の決めに従い、設計は docs/handoff/<名前>/ に置く。
- 画面: 文言は t() と src/locales/ja.json に置く（このアプリは ja だけ。src/i18n.ts）。見た目は SA の金型とトークンを使う（scripts/check-design-governance.mjs が強制する）。

## 0. 事実（origin/main 8f45eb7・v0.18.0 で確かめた）
### 今の作り
- 端末は node-pty で起動する（server/sessions.ts:280-286）。アプリが使うのは次の6つだけで、Session.term の型は IPty（server/sessions.ts:46）。
  - onData、onExit、write、resize、kill、pid
- 出力
  - 出力は string で来る（node-pty の既定 utf8）。
  - その文字列を ring.push と ws.send に渡す（server/sessions.ts:300-305）。onExit は exited を立てるだけ（server/sessions.ts:306-309）。
  - ring は生バイトの Buffer で、1MiB まで持つ（server/ring-buffer.ts:32-48）。つないだ時に全量を1回送る（server/ws.ts:24-26）。
- 入力
  - ブラウザは 16K の UTF-16 単位で分けて送る（src/components/TerminalPane/TerminalPane.tsx:14）。
  - server/ws.ts:36 が受けて、server/sessions.ts:332 の term.write に渡す。
  - サーバーから書く所: server/hub.ts:211,370,374,389,392（389・392 は routine の指示を送る submitText）。
- 大きさ
  - 大きさの変更は間引かずに送る（src/components/TerminalPane/TerminalPane.tsx:110-123）。
  - server/sessions.ts:337 が 1〜500 に収めて term.resize に渡す。
- 停止（server/index.ts:98-109）
  - 流れは beginShutdown（:103、server/sessions.ts:255）→ killAll（:104、server/sessions.ts:376-380）。killAll は term.kill() で全端末に SIGHUP を送る。
  - beginShutdown の後は保存リストを書かない（server/restore.ts:60-62）。
- 起動時の復元（server/restore.ts:105-152）
  - id は毎回 randomUUID で作り直す（server/sessions.ts:288）。保存項目に id は無い（server/session-store.ts:12-18。FORMAT_VERSION=1 は :9）。
  - 復元の対象は「終わっていない」かつ「アカウント切替（ACCOUNT_LOGIN_ROLE_ID）ではない」物（server/restore.ts:74）。
  - 各件の間に restoreStaggerMs を空ける（server/restore.ts:138）。
- routine（v0.18.0 で変わった）
  - routine 専用の端末は無い。決まった時刻に、ふつうのセッションを開く（server/routines.ts:114-126）。手順は次のとおり。
    1. sessions.restore で開く（:122）。
    2. 準備を待つ（:123）。
    3. hub.submitText で指示を送る（:125）。
  - 開いたセッションは、ふつうのセッションとして保存リストに入る（docs/CHANGELOG.md 0.18.0）。
  - routine の予定は routines.json に持つ（server/routines.ts:43）。
- 作る時の呼び方
  - sessions.create は await で呼ばれる（server/http.ts:169）。
  - sessions.restore は同期で、すぐ Session を返す（server/routines.ts:122、server/restore.ts:140）。
- × で閉じる（server/sessions.ts:358-373）: kill → 5 秒 → 子孫に SIGKILL → 2 秒 → remove。
- pid（同期のプロパティとして読む）
  - server/sessions.ts:360,366,368
  - server/hub.ts:229,352,401,423,532
  - server/memory.ts:55,62,121
  - server/http.ts:210
- 更新（scripts/ac-update.sh:19-25、scripts/lib/ac-common.sh:185-189,403-408）
  - 切替は `ln -sfn`、続けて `launchctl kickstart -k`。
  - 失敗したら前の版に戻す。手で戻す時は scripts/ac-rollback.sh を使う。
- launchd の job（ops/launchd/local.agent-console.server.plist.template）: RunAtLoad=true、KeepAlive=false。AbandonProcessGroup の指定は無い。
- 子の環境
  - 秘密を除く仕組みがある（server/sessions.ts:74-84、server/config.ts:211）。
  - TERM は xterm-256color に固定（server/sessions.ts:82）。
- CI
  - .github/workflows/ci.yml の1本で、ubuntu-latest と macos-latest で動く。
  - tmux を入れる手順は無い。リポジトリに tmux の記述は無い。

### 実測（工程0。生データは /tmp/CC報告ファイル/keep-sessions/ の各フォルダ。数値は Fable が生データと照合済み）
| 確かめたこと | 結果 | 根拠 |
|---|---|---|
| 本番と同じ形の job で `kickstart -k` を3回しても、中の本体が同じ pid・開始時刻で動き続け、tmux サーバーも残る（SIGTERM で止まる場合） | ○。つなぎ直しまで 168〜418ms | step0d.md D1 |
| 本物の claude の作業（30 秒）が、途中の `kickstart -k` をまたいで最後まで終わる | ○。pid 不変・DONE まで完走 | step0d.md D2 |
| つなぎ直した直後の画面が tmux の今の画面と同じ | ○。差は 0 行（文字列） | step0d.md D2 |
| つなぎ直した後も、再起動前の行がスクロールバックに入る | ○。`history_size` 行も先に入れれば入る | step0d.md D2、step0b.md R1 |
| まとめて出た 300 行がスクロールバックに全部入る | ○。直結と同じ値（302/269） | step0b.md |
| キー入力（ASCII・日本語・Ctrl-C・Esc・矢印・Enter・Tab・F5・Shift+Enter） | ○。10×10 回一致、最大 6ms | step0c.md C1 |
| Esc の遅れ | ○。0〜3ms（attach 方式は 565ms） | step0b.md R3 |
| 貼り付け 1KB・64KB | ○。sha256 一致。1 回の `send-keys -H` は 9,780 バイトまで。64KB は 500 バイト分割で 251ms、1000 バイト分割で 296ms | step0c.md C2 |
| マウス | ○。バイト一致 | step0c.md C3 |
| 大きさの変更 | △。最後の大きさは正しい。続けて変えると約 250ms に間引かれる | step0c.md C4 |
| 端末のモードを戻す | ○。`pane_private_modes` で 1004・2031 まで取れる | step0c.md C5、step0d.md D3 |
| 全 256 バイトと UTF-8 | ○。sha256 一致。文字は行の途中で割れるので、続けて decode する | step0c.md C6 |
| 10MB の出力 | ○。sha256 一致。約 470ms（直結 150ms） | step0c.md C7 |
| 終わり方の知らせ | `%exit` だけでは区別できない。`has-session` の結果で決める | step0d.md D4 |
| 12 セッション同時 | ○。tmux サーバー最大 22MB、client 約 4MB/本。1MB×12 の同時出力が 1 秒以内 | step0d.md D5 |
| 秘密が tmux サーバーに入らない | ○ | step0.md K11 |
| `new-session -d -P -F '#{pane_pid}'` で、作った直後に pid が返る | ○。返った pid の中身は起動した命令（sleep）だった | v4-check/pane-pid-sync.txt |
| target の書き方 | pane を指す命令（display・send-keys・capture-pane）は `=<名前>:` でないと動かない。`=<名前>` だけだと display は空を返して rc=0、send-keys は `can't find pane`。セッションを指す命令（has-session・kill-session）は `=<名前>` で完全一致。`=` を付けないと前方一致になる（`t` が `t1` に当たった） | v4-check/display-target.txt、pane-target.txt |

## 1. 方針
- 各セッションの本体（今と同じ起動の命令）は、アプリ専用の tmux サーバー（`-L agent-console`）の中で動かす。
- サーバー（node）はセッションごとに control client を1本持つ。
  - 起動の形: `child_process.spawn(tmux, ["-u","-L","agent-console","-f",<conf>,"-C","attach-session","-E","-t","=<名前>"], {stdio:"pipe"})`
  - node-pty は使わない。
- 今の6つの形に合わせる部品
  - 出力: `%output` を戻して文字列にする。
  - 入力: `send-keys -H`。
  - 大きさ: `refresh-client -C`。
  - pid: `#{pane_pid}`。
  - その外側（ring・WebSocket・xterm.js・hub・memory・routine）は変えない。
- サーバーの停止時: control client だけを終わらせる。
- 起動時
  - tmux のセッションが残っていれば、つなぎ直して画面を先に入れる。
  - 残っていなければ、今と同じく `--resume` で開き直す。
- 設定 `terminalHost: "tmux" | "direct"`。既定は "tmux"。
  - tmux が見つからない時は "direct"（今の作り）で動く。
  - アカウント切替の端末（ACCOUNT_LOGIN_ROLE_ID）は、いつも "direct" にする。復元の対象外で、終了で完了を知る作りだから（src/pages/ConsolePage.tsx:285）。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 サーバーを `kickstart -k` で再起動しても、各セッションの本体が同じ pid・同じ開始時刻で動き続ける|統合試験：再起動の前後で `display -p -t =<名前>: '#{pane_pid}'` と `ps -o lstart= -p <pid>` が同じ。工程0 D1 で実測済み|
|K2 再起動の後、保存リストの全セッションが `--resume` ではなく、つなぎ直しで戻る。起動のログに、つなぎ直しの件数と resume の件数を出す|統合試験：3 件開いて再起動 → ログが「つなぎ直し 3・resume 0」、セッション一覧が 3 件、各 pane の pid が前と同じ|
|K3 作業中の claude が、再起動で切れずに最後まで終わる|工程0 D2 で実測済み。導入後は K16|
|K4 ×で閉じると、tmux のセッションも本体も終わる。control client が無い状態から閉じても同じ|統合試験：× の後に `has-session` が rc≠0、控えた子孫の pid がすべて消えている（2 件：client あり／なし）|
|K5 専用のソケット（`-L agent-console`）と設定（`-f`）だけを使う。target はセッションの命令が `=<名前>`、pane の命令が `=<名前>:`|単体試験：組み立てた引数を命令ごとに固定。統合試験：名前が前方一致する2つのセッション（`ac-a` と `ac-ab`）で、違う方に届かない|
|K6 キー・貼り付け・マウスが、今と同じバイトで本体に届く。Esc の遅れは中央値 20ms 以内。64KB の貼り付けは 1 回の write で全部届く|統合試験：本物の tmux＋受信器で sha256 一致と遅れの中央値。e2e は今の物が通る|
|K7 まとめて出た 300 行が xterm.js のスクロールバックに全部入る。再起動の後も、再起動前の行がスクロールバックにある。copy-mode に入らない|統合試験：工程0 step0b・D2 と同じ手順で、スクロールバックの行数と最初の行の文字を比べる。`#{pane_in_mode}` が 0|
|K8 大きさを変えると、1 秒以内に中の幅と高さが最後の大きさになる|統合試験：続けて 5 回変えた 1 秒後に `#{pane_width}x#{pane_height}` が最後の値|
|K9 作業中・待ちの判定、メモリ、閉じるときの子孫たどりが、pane の pid を起点に今と同じに動く。pid は作った直後から同期で読める|単体試験：今の hub・memory の試験が通る。統合試験：`sessions.restore` が返した直後の `term.pid` が `#{pane_pid}` と同じ|
|K10 hooks・作戦ボード・チャット・routine の指示送りが今と同じに動く。セッションごとの環境変数が渡る。日本語・絵文字が化けない|統合試験：C6 と同じデータで U+FFFD が 0 件。`show-environment -t =<名前>` にセッションの環境がある。routine の試験（submitText）が tmux で通る。導入後に PO が目視|
|K11 tmux サーバーの環境に秘密（CHILD_ENV_BLOCKLIST の物）が無い|統合試験：`show-environment -g` にブロック対象のキーが 0 件|
|K12 control client が本体より先に終わった時、本体が残っていれば、つなぎ直す（最大3回）。本体が終わっていれば、今と同じ終了の扱いにする|統合試験：client だけを kill → 1 秒以内につながり pid は同じ。本体を終わらせる → exited。単体試験：§3-2 の stderr の振り分け表を全行|
|K13 routine が開いたセッションも、再起動の後に同じ tmux セッションへつなぎ直す|統合試験：routine で 1 件開いて再起動 → その pane の pid が同じ、つなぎ直しの件数に入る|
|K14 前の版に戻す時（自動・手動）も、tmux の中の claude は同じ pid で動き続ける。同じ会話を二重に起動しない|scripts の単体試験と統合試験。§11 #1〜#6 の各 1 件で、戻す前後に pane の pid と `ps -o lstart` が同じ。前の版の起動のログで resume が 0 件。同じ claudeSessionId の claude の数が 1|
|K15 tmux が見つからない時は "direct" で動き、画面に一度だけその旨を出す|単体試験：tmux の場所を空にする → 端末層が direct、知らせが 1 回|
|K16（導入後）作業中のセッションがある状態で更新しても、作業が続き、画面とスクロールが戻る|PO の目視|
|K17 つなぎ直した直後の画面が tmux の今の画面と同じ（文字と色）。端末のモード（マウス・貼り付け・フォーカス・alt 画面・カーソル）が、つなぎ直しの前と同じ。出力が流れている最中につなぎ直しても、行が重ならず欠けない|統合試験：xterm.js（headless）の画面とモードを `capture-pane -p -e` と `#{pane_private_modes}` と比べる。連番を出し続ける本体でつなぎ直し、番号の重複も欠けも 0|

## 3. 仕組み
### 3-1 tmux の設定（アプリの持ち物）
- 置き場は ops/tmux/agent-console.tmux.conf（新規）。中身は工程0で使った物を正にする。各行の理由は step0.md §4 にある。
- 工程0の物との違いは次の3点。
  - `terminal-overrides` の smcup/rmcup の行は除く。control mode は外側の端末を描かないため。
  - `history-limit` は 2000。xterm.js のスクロールバック（src/components/TerminalPane/TerminalPane.tsx:12）と同じ数。
  - `exit-empty` は on のまま。
- 版印 `@ac_conf_version` は使わないので、行ごと除く。設定の中身は git で追い、照合はしない。
- サーバーの起動時に毎回 `source-file <conf>` を実行する。
- tmux の場所
  - 設定の `tmuxPath` で持つ。既定は起動時に PATH と /opt/homebrew/bin・/usr/local/bin で探す。
  - 起動のログに `tmux -V` を残す。

### 3-2 端末の層（新しい部品 server/terminal-host/）
#### 型
- `TerminalHandle` の型を置く。中身は今の6つ（onData、onExit、write、resize、kill、pid）。
- pid は同期のプロパティのまま。Session.term の型を IPty からこれに替える。
- direct の実装は IPty をそのまま包む。
#### pid を同期で持つ
- 作る時: `spawnSync(tmux, [..., "new-session","-d","-P","-F","#{pane_pid}", ...])` を使う。tmux が返す pid を、そのまま持つ（実測 v4-check）。
- つなぎ直す時: `spawnSync` の `display -p -t =<名前>: '#{pane_pid}'` で、pid だけを先に取る。画面を戻すための残りの値は、つないだ後に control client で取る（下の「つなぎ直す」の手順2）。
- これで sessions.restore は今と同じく同期で Session を返す。呼び出し元（server/routines.ts:122、server/restore.ts:140、server/http.ts:169）は変えない。
- 1 回の spawnSync は tmux の命令 1 本分、待ちが短い。12 件のつなぎ直しで、合わせて 1 秒を超えないことを統合試験で測る。超えたら工程2で止めて設計者に返す。
#### tmux の実装（`TmuxControlTerminal`）
- 命令の送り方
  - control client の stdin に、1 行に 1 命令ずつ書く。
  - 応答の `%begin <時刻> <番号> <flags>` と `%end` / `%error` を、送った順の待ち行列に1つずつ対応させて、命令ごとの Promise を解く。各 control client の応答は送った命令の順に1つずつ返る（番号はサーバー全体の通し番号で、送る前に予測できない。実測 r3probe.txt）。応答の番号は直前に受けた番号より大きいことを確かめる（§13 S8）。
  - 番号が直前より大きくない応答は、warn ログに出して捨てる。工程0の道具は番号を見ていなかったので、新しく書く。
- 出力（onData）
  - `%output %<pane> <値>` の値の `\ooo` を戻して Buffer にする。
  - セッションごとに1つの StringDecoder（utf8）に流し、出てきた文字列を onData に渡す。今の string の流れ（ring・ws）は変えない。
- 入力（write）
  - 文字列を UTF-8 のバイトにし、1000 バイトずつに分けて `send-keys -t =<名前>: -H <16進…>` を送る。
  - 1000 バイトにした理由: 上限 9,780 バイトに十分な余裕がある。最速の 500 バイトより 45ms 遅いだけ（C2）。
  - 順番の守り方
    - write ごとに分けた命令は、stdin に順番に書き込む。命令は書いた順に tmux が実行する。応答を待ってから次を書く必要はない。
    - 応答は待ち行列で受け取り、`%error` が来たらログに出す。
    - 次の write は前の write の命令の後ろに並ぶので、順番は変わらない。
- 大きさ（resize）: `refresh-client -C <cols>x<rows>` を送る。tmux の間引き（約 250ms）は受け入れる（C4。最後の大きさは正しい）。
- 名前
  - `ac-<セッション id>` にする。routine が開いた物も同じ（routine 専用の端末は無い）。
  - 名前を作る関数で、`:` と `.` が無いことを確かめる。
- target
  - セッションの命令（has-session・kill-session・attach-session）: `=<名前>`
  - pane の命令（display・send-keys・capture-pane）: `=<名前>:`
#### 作る
- `tmux -u -L agent-console -f <conf> new-session -d -P -F '#{pane_pid}' -s <名前> -x <cols> -y <rows> -c <cwd> -e KEY=VAL… -- <command…>` を、`buildChildEnv()` の環境で実行する。tmux サーバーは最初の命令で起き、`-f` はその時だけ読まれるので、tmux を呼ぶ全ての命令に `-L agent-console -f <conf>` を付ける（K5）。
- 続けて control client をつなぐ。
#### つなぎ直す（起動時、または K12）
1. control client をつなぐ。
2. `display -p` で次の値を取る。
   - `#{pane_pid}`、`#{alternate_on}`、`#{history_size}`
   - `#{cursor_x}`、`#{cursor_y}`、`#{cursor_flag}`
   - `#{alternate_saved_x}`、`#{alternate_saved_y}`
   - `#{pane_private_modes}`、`#{cursor_shape}`
3. 画面を取る。
   - 通常の画面: `capture-pane -p -e -S -<history_size>`（履歴と通常画面）。
   - alt 画面に居る時: `capture-pane -p -e -a -q` で通常画面を取る。それとは別に、`-S -<history_size> -E -1` で履歴だけを取る。
4. 先に入れるバイト列を、次の順で組む。step0c C5・step0d D2 で画面が一致した順番。
   1. 画面を消す。
   2. 履歴と通常画面を書く。
   3. alt 中なら、保存カーソルへ移り、`\e[?1049h` を送り、alt 画面を書く。
   4. `pane_private_modes` の各モードを `\e[?<n>h` にする（1004・2031 も含む）。
   5. カーソルの形・位置・表示を戻す。
5. ring を空にしてから、このバイト列を入れる。
6. 以後の `%output` を流す。
#### 先入れと `%output` の境目
- control client の `%output` は、つないだ時から一時的に溜めておく。
- 手順2〜3の命令の `%end` を受けた時点で、それより前に来た `%output` は捨てる。捨てた分は capture の中に入っている。
- `%end` より後に来た分を、先入れの後ろに流す。
- 重ならず欠けないことは、K17 の連番の試験で確かめる。
- 駄目だった時の替え: 手順2〜3の間だけ `refresh-client -A '%<pane>:pause'` で止め、`:continue` で再開する。pause の間の出力は tmux 側に残る。`pause-after` の自動の止まり（C7 で欠けた物）とは違う。
#### 終わり方（K12。D4 の実測に基づく）
- control client が終わったら、`has-session -t =<名前>` を実行して、その結果で振り分ける。

| has-session の結果 | 意味 | 扱い |
|---|---|---|
| rc=0 | 本体が残っている | つなぎ直す（最大3回、間 500ms）。3回とも失敗したら「端末につなげません」を出す。exited にはしない |
| rc≠0 で stderr が `can't find session`・`no server running`・`no current target` のどれか | 本体が終わった（`exit-empty on` で最後のセッションが終わり、古いソケットだけ残った場合も `no server running` になる。これも終わった扱いで正しい。step0.md:159） | 今と同じ exited |
| それ以外（`error connecting`・`protocol version mismatch` など） | つなげない | 「端末につなげません」。exited にはしない |

- exited の時の終了コードは取れないので 0 にする。今の onExit は exited を立てるだけ（server/sessions.ts:306-309）。
#### サーバーの停止（killAll）
- 各 control client の stdin を閉じる。2 秒以内に終わらなければ kill する。tmux には触らない。
- D1 で、この形で本体が残ることを確かめた（SIGTERM で止まる場合）。
#### 閉じる（×、kill）
1. pane の pid を起点に、子孫を控える。
2. `kill-session -t =<名前>` を実行する。
3. 今と同じ猶予（5 秒）の後に、残った子孫を SIGKILL する。
#### 複数のタブ
- 今と同じく、1本の control client・ring・clients を共有する。

### 3-3 保存リストと起動時（server/session-store.ts・server/restore.ts）
- `OpenSessionItem` に `id` を足す。parseItem と normalizeItem の両方に書く。
- `FORMAT_VERSION` は上げない。上げると古いファイルが読めず、全件の復元ができなくなるため。
- `sessions.restore()` に、保存してある id を渡せるようにする。id が無い古い項目は、今と同じく新しい id で `--resume` する。
- 起動時、保存リストの各項目について:
  - `has-session -t =ac-<id>` が真なら、つなぎ直す。
  - 偽なら、今と同じく `--resume` で開き直す。
  - 件数をログに出す（K2）。
- routine が開いたセッションも保存リストに入っているので、同じ扱いになる（K13）。
- 保存リストに無い `ac-*` は消さない。ログに名前を出す。
- つなぎ直しは新しい claude を起動しないので、restoreStaggerMs を待たずに続けて行ってよい。`--resume` の物は今と同じく間を空ける。

### 3-4 更新・前の版に戻す時（scripts）
- 正常に更新する流れは変えない。
- 前の版に戻す時（scripts/ac-update.sh:21-25 の失敗時と scripts/ac-rollback.sh）は、tmux のセッションを終わらせない。
- 戻す先の版が tmux を知っているかは、§11 #5 で判定する。
  - 知っている版なら、そのまま戻す。戻った版がつなぎ直す。
  - 知らない版で、`ac-*` の tmux セッションが1件以上あれば、§11 の手順で保存リストと routine を退避してから戻す。
    - 前の版は何も開き直さないので、同じ会話の claude を二重に起動しない。
    - tmux の中の claude は動き続ける。
- tmux を知っている版が次に起動した時: 退避したファイルがあれば、今の保存リストと合わせ直してからつなぎ直す（§11 #3）。
- 前の版で動いている間は、tmux の中のセッションは画面に出ない。そのため、scripts の出力とログに次を書く。
  - 件数
  - 見方 `tmux -L agent-console attach -t =<名前>`
- 古い版への巻き戻し防止は scripts/ac-update.sh・scripts/ac-rollback.sh には足さない（PO の手順で戻す道具だから）。自動の更新ジョブ（リポジトリ外）には 2026-10-14 に足した。

### 3-5 画面
- 端末の画面の部品は変えない。足すのは次の2つの知らせだけ。文言は t()・src/locales/ja.json、見た目は SA の金型とトークン。
  - 「tmux が無いので、今までどおりの方式で動いています」
  - 「端末につなげません」

### 3-6 CI
- .github/workflows/ci.yml の両方の OS に、tmux を入れる手順を足す。
  - macos: `brew install tmux`
  - ubuntu: `sudo apt-get install -y tmux`
- 入れた後に `tmux -V` をログに出す。
- CI（`CI=true`）で tmux が無ければ、tmux の試験は skip せずに失敗にする。手元で tmux が無い時は skip にし、ログに出す。
- control mode と `pane_private_modes` を使う。工程3で、CI の tmux の版で K6・K7・K17 が通ることを確かめる。通らない版なら、版を固定する手順を足す。

## 4. SSOT
- セッションの本体の正本: tmux サーバー（`-L agent-console`）の1か所。
- 「どのセッションを開くか」の正本: 今の保存リスト（dataDir/open-sessions.json）。id を足すだけで、対応表は作らない。tmux の名前は id から作る。
- 画面の正本: tmux の pane。ring は写しで、つなぎ直す時に tmux から作り直す。

## 5. 安全
- PO の普段の tmux とは、ソケットも設定も分ける（K5）。
- 秘密を tmux サーバーに渡さない（K11）。
- 消すのはアプリが作った `ac-*` だけで、それも PO が閉じた時だけ。
- この版を入れる最初の更新
  - 今動いているセッション（direct）は今までどおり切れて、`--resume` で開き直る。
  - 次の更新から切れなくなる。
  - 最初の更新は、今の決まりどおり全員の手が空くのを待つ。
- tmux を brew で更新した時
  - 古い tmux サーバーと新しい tmux の命令の版が合わないことがある（`protocol version mismatch`）。
  - その時は「端末につなげません」を出し、本体は止めない。
  - 直し方（全セッションを閉じて開き直す）を README に書く。
  - 起動のログに tmux の版を出す。

## 6. 代替案
- `tmux attach` を node-pty でつなぐ（第2版）: スクロールバックが欠け（R1）、Esc が遅れる（R3）。不採用。
- 公式の `claude --bg`＋`attach`: 素のシェルの役目に使えない（recon F-1）。不採用。
- 番人のプロセスを自作する: Orca は約 8.7 万行（recon D-1）。不採用。
- 手が空くのを待ってから更新する（今）: 何時間も更新できない。

## 7. リスク
| リスク | 起きた時 | 対処 | 確かめ方 |
|---|---|---|---|
| 先入れと `%output` の境目で出力が重なる・欠ける | つなぎ直した直後に1行ずれる | `%end` の後だけ流す。駄目なら §3-2 の pause の替え | K17 の連番の試験 |
| 大量の出力で遅れる | 10MB の乱数で 2.4〜4.0 秒（C7） | claude の出力は文字なので影響は小さい。`pause-after` は使わない | 統合試験：10MB の文字が 1 秒以内 |
| 大きさの変更が 250ms 遅れる | 端の描画が一瞬ずれる | 受け入れる | K8 |
| tmux の更新で命令の版が合わない | 端末につなげない | §5 の知らせと README | 単体試験（stderr の振り分け） |
| フォーカス（1004）を戻した後に xterm.js が `\e[I/O` を送るか未確認（D3） | claude がフォーカスで再描画しない | 送らなければ、先入れの後に `\e[I` を1回送る | K17 |
| 色の一致は本物の claude では未確認（D2） | 色が少し違う | K17 で色も比べる。C5 の疑似画面では一致 | K17 |
| node が止まりきらず、launchd が SIGKILL で止めた時の tmux の残り方は未測定（D1 は SIGTERM のみ） | 本体が巻き添えで止まる恐れ | 統合試験で、node を SIGKILL して tmux の本体が残るかを測る。残らなければ工程2で止めて設計者に返す | 統合試験 |
| spawnSync で起動・つなぎ直しが遅くなる | 起動が遅れる | 12 件で 1 秒以内か測る | §3-2 |

## 8. 外部・過去事例の参照と我々への応用
- VS Code は「プロセスにつなぎ直す」と「内容を戻して起動し直す」を分けている（recon D-2）。この設計も同じ2段にしている。
  - tmux があれば、つなぎ直す。
  - 無ければ、`--resume` で開き直す。
- iTerm2 は tmux の control mode（`tmux -CC`）で tmux のセッションを自分の窓として描く。これは tmux の公式の使い道（tmux の man「CONTROL MODE」）で、この設計ではその役を xterm.js が担う。
  - 【未確認】iTerm2 のつなぎ直しの細部は読んでいない。根拠には使わず、根拠は工程0の実測だけにする。
- 適用限界: xterm.js を control mode の後ろに置いた実測は、工程0（step0b〜0d）の物だけ。

## 9. 工程
- 工程0: 済（step0〜0d、v4-check）。
- 工程1: 試験を先に書く。
  - 単体: 8 進の戻し、命令の番号の対応、分割、名前、target、stderr の振り分け、先入れのバイト列の組み立て。
  - 統合: 本物の tmux で K1・K2・K4〜K13・K17、§7 の SIGKILL。
- 工程2: 実装（Sonnet）。
- 工程3: CI と e2e。
- 工程4: Fable のコード審査。
- 導入
  - 全員の手が空くのを待って、1回だけ更新する。
  - その次の更新で、K16 を PO が確かめる。

## 触るファイル・触らないファイル
- 触る
  - server/terminal-host/（新規）
  - server/sessions.ts、server/hub.ts（型だけ）、server/memory.ts（型だけ）、server/http.ts（型だけ）
  - server/restore.ts、server/session-store.ts、server/routines.ts（§11 #1 の退避の読み戻しだけ）、server/config.ts、server/index.ts
  - ops/tmux/agent-console.tmux.conf（新規）
  - scripts/ac-update.sh、scripts/ac-rollback.sh、scripts/lib/ac-common.sh（§11）
  - src/locales/ja.json（知らせ2つ）、知らせを出す画面の部品
  - .github/workflows/ci.yml
  - tests/unit/ と tests/ の統合試験
  - README.md、docs/CHANGELOG.md、package.json、package-lock.json、extension/manifest.json（版）
- 触らない
  - src/components/TerminalPane/（画面の端末の部品）
  - server/ring-buffer.ts、server/ws.ts
  - アカウント切替（direct のまま）
  - hooks の仕組み
  - src/i18n.ts（ja だけのまま）

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1・K2・K5・K6・K7・K11・K12・K14・K17 を試験で固定する。CI で tmux を必ず入れて毎回まわす（§3-6）。
- tmux の版が変わったら、K6・K7・K17 の統合試験で気付く。

## 10. 実装時の決め（第2版 §10 を引き継ぎ、B と D を改めた）
- A: tmux の時の「終了したか」は `has-session` の結果で決める。`kill-session` の後に `has-session` が偽になったら exited にする。K4 に「control client が無い状態から ×」を1件入れた。
- B: §3-2「終わり方」の表に従う。工程0 D4 で、本体が終わった時の文言が3種類あると分かったため、第2版の「`can't find session` だけ」から改めた。
- C: target は §3-2 のとおり。セッションは `=<名前>`、pane は `=<名前>:`。K5 で固定する。
- D: `update-environment` は設定に書かない。環境は `new-session -e` だけで渡す。control client の attach には `-E` を付け、tmux の既定の update-environment（DISPLAY・SSH_AUTH_SOCK など13個。秘密は含まれない）もセッションへ写さない（tmux 3.8 man:651。Fable 審査 review-v4）。
- E: 名前を作る関数で `:` と `.` が無いことを確かめる。

## 11. 切戻しの決め（第2版 §11 を書き写した。PO 承認 2026-10-13。§3-4 より優先）
- #1 routine
  - routines.json を routines.tmux-held.json に移す。前の版では routine の予定も止まる（PO が y）。
  - tmux を知っている版が起動したら、held を元の名前に戻してから RoutineService を start する（server/routines.ts:72）。
  - K14 の試験に routine を1件含める。
  - v0.18.0 から routine は新しいセッションを開くだけで、同じ会話の二重起動にはならない。それでも PO が承認した「止める」を守る。
- #2 順番
  1. 今のサーバーを止める（`launchctl kill SIGTERM gui/<uid>/<label>`、pid が消えるまで待つ）。
  2. 移す（open-sessions.json → open-sessions.tmux-held.json、routines.json → routines.tmux-held.json）。
  3. `ac_switch_current`。
  4. `kickstart`。
  - 切戻し専用の関数を scripts/lib/ac-common.sh に足し、scripts/ac-update.sh の失敗時と scripts/ac-rollback.sh の両方で使う。
  - K14 で「移す前にサーバーの pid が消えている」を確かめる。
- #3 合わせ直しの鍵
  - 鍵は「id、または claudeSessionId の一致」。
  - 一致したら held 側（tmux の本体）を採り、今のリスト側を捨てる。
  - claudeSessionId が無い項目は両方残す。
  - K14 に、同じ claudeSessionId がある場合を1件足す。
- #4 PO への注意
  - 前の版で動いている間は、同じ会話を手で開き直さない。
  - scripts/ac-update.sh と scripts/ac-rollback.sh の出力に「裏で N 件が動いています。この間は会話を開き直さないでください」を出す。README にも書く。
- #5 判定の印
  - 戻す先の版の dist-server に、server/terminal-host/ の tmux の実装ファイルがあるかで判定する。
  - ファイル名は実装で決め、単体試験で固定する。
- #6 held が既にある時: 上書きしない。今のリストと合わせてから held に書く。K14 に1件足す。

## 12. コード審査（Fable、PR #35 HEAD 17938ca、REVISE）を受けた決め（Opus、2026-10-14）
審査記録: /tmp/CC報告ファイル/keep-sessions/review-code/review.md。設計 §3・§7・§8 の範囲での補い。PO 承認済みの目的・受入条件は変えない。
- R1（審査 #1・#10、高）pid が 0 以下の端末に対してプロセスの木を辿らない。
  - server/process-tree.ts の descendantPids は root <= 0 なら空の集合を返す。
  - closeRunning は pid <= 0 のとき SIGKILL の走査をしない。kill-session → has-session の結果だけで判断する。gone なら閉じる。unreachable のままなら何も殺さず、今の「止まらない」エラーとログで返す（何も消さない側に倒す）。
  - hub・memory も同じ関数を通るので、pid 0 の端末は「子孫なし」になる。
  - 単体試験: pid 0 の端末を閉じても process.kill が呼ばれないこと（spy）。descendantPids(0, …) が空であること。
- R2（審査 #2、中）先入れの4本目の %end を受けた同じ同期処理の中で replaying を下げ、同じ塊の後ろの %output を捨てない。単体試験: 1つの data に「4本目の %end の直後に %output」を入れ、出力が落ちないこと。
- R3（審査 #3、中）§3-2 の「応答を番号で対応させる」を実装する。応答は送った順に対応させ、%begin の番号が直前に受けた番号より大きいことを確かめる。大きくなければ warn ログを出して捨てる。番号は attach ごとに数え直す。（§13 S8 で改版。番号はサーバー全体の通し番号で、送る前に予測できない）単体試験を足す。
- R4（審査 #4、中）
  - K17 に、xterm-headless の画面（文字と前景・背景の色）と capture-pane -p -e、pane のモードの比較を足す。
  - e2e を少なくとも1本、terminalHost "tmux" と試験用ソケット ac-test-<pid>-<乱数> で通す。他の e2e は direct のままでよい（本番ソケットに触れないための既定）。
- R5（審査 #5・#6、中・低）所要時間の判定は消さずに、環境変数 AC_TMUX_TIMING=1 のときだけ §7 の閾値（10MB 1秒、12件のつなぎ直し 1秒、K6 Esc 中央値 20ms）で判定する。CI に、tmux の統合試験だけをファイル並列なしで AC_TMUX_TIMING=1 で走らせる段を1つ足す。全試験の並列実行では閾値を判定せず、ログだけを出す（並列時の値は参考値）。
- R6（審査 #7、低）K13（routine で1件開いて再起動しても続く）を1本足す。K14 は「切戻しのあとで has-session が alive で、new-session が呼ばれない」ことを、試験用ソケットの本物の tmux で1本確かめる。
- R7（審査 #8・#9、低）
  - 使っていない send() と冗長な式を消す。
  - 再試行回数は、先入れが終わった時に 0 へ戻す（attach 直後ではない）。
  - 送れずに溜めた入力には 64KB の上限を置く。超えたら古い物を捨てずに新しい入力を断り、warn ログを出す。
- R8（設計に無い振る舞い2件。受け入れる）
  - tmux.conf が無い時に tmuxMissing の案内を出して direct で開く。
  - new-session が失敗した時に warn ログを出して direct で開く。
  - どちらも会話は開けるが、更新で保たれない。後者でも tmuxMissing と同じ案内を出す（黙って続けない）。
- 審査記録 #11 は記載のみで、変えない。

## 13. コード再審査（Fable、PR #35 HEAD b5765fc、REVISE）を受けた決め（Opus、2026-10-14）
審査記録: /tmp/CC報告ファイル/keep-sessions/review-code2/review.md。§12 と同じく設計 §3・§7 の範囲での補い。PO 承認済みの目的・受入条件（K1〜K17）は変えない。
- S1（審査 #1、高）先入れの履歴と可視画面を1命令で取る。
  - 先入れで送る命令を ①display（`#{pane_height}` を足す）②`capture-pane -p -e -S -`（-E なし。履歴の先頭から可視の末尾まで）③`capture-pane -a`（alt）の3本にする。今の②（`-S - -E -1`）と④（可視）は消す。
  - ②の出力の末尾 `pane_height` 行を可視、残りを履歴とする。末尾の空行の扱いは今の④の扱いと同じにする（行数で分けるので、tmux が末尾の空行を落とすかを実物で確かめてから分け方を決め、結果を試験で固定する）。
  - 「4本目の %end」で replaying を下げている所（R2）は「3本目の %end」に改める。同期で下げる形は保つ。
  - 単体試験（偽 tmux）: ②の応答の行数が pane_height より多い台本で、履歴と可視が欠けも重なりもなく連結されること。
- S2（審査 #2、中）tmux の版の下限を「モードを戻すのは 3.8 以上」とし、§3-6 の約束（CI の版で K17 が通る）は ubuntu で守る。
  - CI ubuntu: apt の tmux（3.4）をやめ、tmux 公式の 3.8 リリースの tarball をダウンロードし、sha256 を照合してからビルドして入れる。sha256 の値は実装役が公式の配布物から取り、ci.yml に書く（値を作らない）。3.8 の公式 tarball が見つからない時は実装を止めて Opus に報告する。
  - CI macOS: brew の tmux のまま（3.7c）。K17(screen) のうちモード比較だけ、`tmux -V` が 3.8 未満なら skip してログに版を出す。文字・色・カーソルの比較は skip しない。
  - CI（`CI=true`）かつ ubuntu で 3.8 未満なら、skip ではなく失敗にする（下限の確認が黙って消えないため）。
  - アプリ: setupTmux で版を読み、3.8 未満なら warn ログ「tmux <版> は 3.8 未満のため、つなぎ直しで端末のモード（貼り付けモード等）が戻らない」を1回出す。動作は止めない（PO の Mac は 3.8）。
  - K17(screen) の正規表現の第3項（モード）は任意にする。
- S3（審査 #3、中）CI の tmux 単独段を `if: always()` にし、`npm test` が赤でも走らせる。結果で次を決める。
  - ubuntu で単独段が通り、並列の `npm test` だけで K6/K7/K10-11 の待ちが切れる → 負荷が原因とする。統合試験（tmux-host.integration.test.ts）の waitFor の既定を 20 秒に延ばす。所要時間の判定は TIMING だけなので §7 と矛盾しない。
  - 単独段でも同じ所で落ちる → 原因を推測で決めない。実装役は生ログを添えて止まり、Opus が決める。
- S4（審査 #4、低）K17(screen)・K1・K2 の `sleep(300)` を `await h1.recorder.sync()` に替える。
- S5（審査 #5、低）R5 の所要時間の判定に K12（1秒以内につなぎ直す。試験の閾値 1500ms）を足し、TIMING の時だけ判定する。§12 R5 の列挙はこの項で補う。
- S6（審査 #6、低）R7 の試験「3回で止まる」の timeout を 15 秒にする。
- S7（審査 #7、低）tests/unit/helpers/harness.ts の terminalHost "tmux" で、ソケットの既定 "agent-console" を外す。未指定なら throw にする。
- S8（R3 の改版）§3-2 と §12 R3 の「送った順の期待番号と照合」を次に改める: 「各 control client の応答は送った命令の順に1つずつ返る（番号はサーバー全体の通し番号で、送る前に予測できない。実測 r3probe.txt）。応答は送った順に対応させ、%begin の番号が直前に受けた番号より大きいことを確かめる。大きくなければ warn ログを出して捨てる」。
- 完了条件: 手元で typecheck・lint・build・governance が rc0。CI の両 OS が緑（ubuntu は tmux 3.8 で K17(screen) のモード比較まで通る）。Fable の再審査で APPROVE。
