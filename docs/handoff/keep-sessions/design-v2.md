# 設計: 更新してもセッションを切らない（tmux に端末を預ける）（第2版）

- 状態: 第2版は APPROVE（条件つき）。§3-4 は §11 で確定。PO 承認済み（2026-10-13。切戻しの間は routine も止まり、同じ会話を手で開かない、の y/n に PO が「y」）。
- 版の番号: 実装の時点の main の次の minor。
- PO 承認（2026-10-13）
  - 「アップデートした後に会話の続きから再開させることは出来る？」「claude の web 版のように続きから再開できる仕様」に対して、調査を y。
  - 「tmux の中で Claude を動かし、アプリの端末はつなぐだけにする」方向に y。
- PO の判断（2026-10-13）: 「失敗して前の版に戻すときだけ claude が切れる」案に n。戻すときも claude を切らない（§3-4 第3版）。
- 調査: docs/handoff/keep-sessions/recon.md（Sonnet。実測つき）
- 対象ADR: ADR-067、ADR-144（画面の文言と見た目に触れる部分だけ）

## 0. 事実（recon と Fable 審査より）
- 今は、サーバーが止まると全ての端末に SIGHUP を送り、端末を終わらせる（server/index.ts:98-109、server/sessions.ts:360-364）。そのため更新のたびに claude は全部終わる。`--resume` で開き直すが、その場の作業は切れる（recon A-1〜A-3）。
- そのため今は、全セッションの手が空くまで更新を待っている。11件のうち8件が作業中で、何時間も更新できないことがある（2026-10-13 の実測）。
- 端末の中身（master fd）を握る者が居ないと、新しいサーバーはつなぎ直せない（recon A-5、B-2）。
- tmux 3.8 がある（/opt/homebrew/bin/tmux）。launchd の job が終わっても、tmux と pane の子は残った。tmux につないでいる node を SIGKILL しても、中身は残り、つなぎ直せた（recon F-2）。
- 端末に触るのは、spawn（sessions.ts:268）と、5つのメソッドと、pid だけ（recon E-1）。
- pid の参照は次の所にある: hub.ts:194,210,232,341、memory.ts:55,62,121、http.ts:205（`term: s.term` を memory へ渡す）、sessions.ts:344,350,352。
- `Session.id` は spawn のたびに `randomUUID()` で作る（sessions.ts:276）。保存リスト `OpenSessionItem` に id は無い（session-store.ts:12-18。normalizeItem :35-43 は未知のキーを捨てる）。
- routine の端末は、routines.ts:71-72 で起こし、保存リストの対象外（restore.ts:74）。
- 停止の時、`beginShutdown()` の後は `canWrite()` が偽になる。そのため、停止で attach を終わらせても、保存リストは消えない（restore.ts:60-62、index.ts:103-106）。
- 更新に失敗すると、自動で前の版へ戻す（scripts/ac-update.sh:21-25）。手で戻す手順もある（scripts/ac-rollback.sh）。
- 子の環境から秘密を除く仕組み（`buildChildEnv`、sessions.ts:76-86。除く一覧は config.ts:206）がある。
- tmux の man（3.8）:
  - default-terminal は「screen か tmux かその派生にすること」。
  - `-f` の設定は、tmux サーバーの起動時に1回だけ読む。
  - `new-session -e` は、そのセッションだけの環境変数を足す。
  - tmux サーバーは、最初に起こしたプロセスの環境を持つ。

## 1. 方針
- 各セッションの本体（今と同じ起動の命令）は、アプリ専用の tmux サーバーの中で動かす。アプリのサーバーは `tmux attach` をつなぐだけにする。xterm.js・WebSocket・ring は今のまま使う。
- サーバーの停止時は、attach だけを終わらせる。起動時に tmux のセッションが残っていれば、つなぎ直す。残っていなければ、今と同じく `--resume` で開き直す。
- tmux のセッション名は、保存したアプリのセッション id から作る。対応表は別に持たない。
- 設定 `terminalHost: "tmux" | "direct"` で切り替える。既定は "tmux"。tmux が無いときは "direct"（今の作り）で動く。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 サーバーを再起動しても（SIGTERM。`kickstart -k` と同じ）、各セッションの本体が同じ pid で動き続ける|統合試験（stub で pid が同じ）＋工程0の実測|
|K2 再起動の後、保存リストの全セッションが `--resume` ではなく attach で戻る。起動のログに attach の件数と resume の件数を出す|統合試験（attach=全件、resume=0）|
|K3 作業中の claude の作業が、再起動で切れずに最後まで終わる|工程0の実測（本物の claude）|
|K4 閉じる（×）と、tmux のセッションも本体も終わる|統合試験|
|K5 アプリ専用のソケット（`-L agent-console`）と、アプリの設定（`-f`）だけを使う|単体試験（起動の引数）|
|K6 キーを横取りしない。Ctrl+B、Shift+Enter、Esc が今と同じく claude に届く。貼り付けが1回で届く|工程0の実測＋e2e|
|K7 ホイール1回で、xterm.js の画面が過去の出力の方へ動く。tmux の copy-mode に入らない。文字の選択とコピーも今と同じ|工程0の実測。できなければ止めて PO に報告（§7 R1）|
|K8 端末の大きさを変えると、中の claude の幅も変わる|e2e|
|K9 作業中・待ちの判定、メモリ、閉じるときの子孫たどりが、pane の pid（`#{pane_pid}`）を起点に今と同じに動く|単体試験＋統合試験|
|K10 hooks・作戦ボード・チャットが、今と同じに動く。セッションごとの環境変数が渡る。日本語が正しく出る|統合試験＋工程0|
|K11 tmux サーバーの環境に、秘密（CHILD_ENV_BLOCKLIST の物）が無い（`show-environment -g` で確かめる）|統合試験＋工程0|
|K12 attach が本体より先に終わったとき（tmux 側の事情）は、本体が残っていれば、つなぎ直す（最大3回）。本体が終わっていたら、今と同じ終了の扱いにする|統合試験（`detach-client` で attach だけ終わらせる）|
|K13 routine の端末も、再起動の後に同じ tmux セッションへつなぎ直す|統合試験|
|K14 更新の失敗で前の版に戻すとき（自動・手動の両方）、tmux の中の claude は同じ pid で動き続ける。tmux を知らない版に戻す時は保存リストを移し、同じ会話の claude を二重に起動しない。tmux を知っている版がまた起動すると、移した保存リストを読み直してつなぎ直す|単体試験（scripts の試験）＋統合試験|
|K15 tmux が無いときは "direct" で動き、画面に一度だけその旨を出す（i18n）|単体試験|
|K16（導入後）作業中のセッションがある状態で PO が更新しても、作業が続いている|PO の目視|

## 3. 仕組み
### 3-1 tmux の設定（アプリの持ち物）
- 置き場は `ops/tmux/agent-console.tmux.conf`。版と一緒に入れる。中身は工程0で確定し、step0.md に理由を書く。案は次のとおり。
  - `set -g prefix None`、`unbind -a`
  - `set -g status off`
  - `set -g escape-time 0`
  - `set -g default-terminal tmux-256color`
  - `set -g extended-keys on`、必要なら `terminal-features` に extkeys を足す
  - `set -g history-limit`（数値は工程0で決める）
  - `set -g exit-empty on`
  - `set -g update-environment ""`
  - `set -g @ac_conf_version <版>`
  - `set -ga terminal-overrides` で、スクロールを xterm.js に残す（`smcup@:rmcup@` など）
- 版を上げても tmux サーバーは古い設定のままなので、サーバーの起動時に、毎回 `source-file <conf>` を実行する。
- tmux の場所は、設定の `tmuxPath` で持つ。既定は起動時に探す。起動時に `tmux -V` をログに残す。

### 3-2 サーバー（sessions.ts ほか）
- 端末の層を `TerminalHost` の後ろに置く。中身は `direct`（今の作り）と `tmux` の2つ。外に見せるのは、今の5つのメソッドと `processPid`。
- tmux の名前は、ふつうのセッションが `ac-<セッション id>`、routine が `ac-r-<routineId>`。
- 作る
  - `new-session -d -s <名前> -x <cols> -y <rows> -c <cwd> -e KEY=VAL… -- <command…>` を実行する。
  - 実行の環境は、`buildChildEnv()` の環境にする。tmux サーバーを最初に起こす時も同じにして、秘密を tmux サーバーに渡さない。
  - その後、node-pty で `tmux -u -L agent-console attach -t <名前>` を起動する。attach の環境も `buildChildEnv()` にする。
- つなぎ直す: `has-session` が真なら、attach だけする。
- pid: `display -p -t <名前> '#{pane_pid}'` で取る。sessions.ts:344,350,352、hub.ts:194,210,232,341、memory.ts:55,62,121、http.ts:205 を全部、`processPid` に替える。sessions.ts:350 の除外も pane の pid にする。
- attach の終了
  - attach が終わったら、`has-session` を確かめる。
  - 偽なら、本体が終わったので、今と同じ終了（exited）にする。
  - 真なら、exited にせず、つなぎ直す（最大3回）。3回とも失敗したら、画面に「端末につなげません」を出す。この時、exited にはしない。
  - attach がすぐ失敗した場合（tmux の更新でクライアントとサーバーが合わない時など）も、同じ扱いにする。
- サーバーの停止（killAll）: attach だけを終わらせる。tmux には触らない。
- 閉じる（×）: `kill-session` を実行し、今の猶予の後に、pane の pid を起点に子孫を SIGKILL する。
- 複数のタブ: 今と同じく、1本の attach と ring と clients を共有する。変えない。

### 3-3 保存リストと起動時（session-store.ts・restore.ts・routines.ts）
- `OpenSessionItem` に `id` を足す。parseItem と normalizeItem の両方に書く。`FORMAT_VERSION` は上げない（上げると、古いファイルが読めずに全件の復元ができなくなる）。
- `sessions.restore()` に、保存してある id を渡せるようにする。id が無い古い項目は、今と同じく新しい id で `--resume` する。
- 起動時に、保存リストの各項目について `has-session` が真ならつなぎ直し、偽なら今と同じに `--resume` で開き直す。件数をログに出す（K2）。
- routine は `ac-r-<routineId>` を見て、同じくつなぎ直す。
- 保存リストにも routine にも無い `ac-*` は、勝手に消さない。ログに名前を出す。
- 再起動の前の過去の出力は、つなぎ直す前に `capture-pane -p -e -S -<N>` で ring に先に入れる案を、工程0で試す。うまくいけば入れる。駄目なら「最後の画面だけ」とし、step0.md に書く。今の `--resume` でも過去の出力は消えるので、悪くはならない。

### 3-4 更新の手順（scripts）（第3版）
- 正常に更新する流れは変えない。
- 前の版に戻す時（ac-update.sh:21-25 の失敗時と、ac-rollback.sh）は、tmux のセッションを終わらせない。
- 戻す先の版が tmux を知っているかは、`versions/<tag>/ops/tmux/agent-console.tmux.conf` があるかで判定する。
  - 知っている版なら、そのまま戻す。戻った版が、tmux のセッションにつなぎ直す。
  - 知らない版で、`ac-*` の tmux セッションが1件以上あれば、戻す前に、保存リスト（dataDir/open-sessions.json）を `open-sessions.tmux-held.json` に移す。これで、前の版は何も開き直さず、同じ会話の claude を二重に起動しない。tmux の中の claude は、そのまま動き続ける。
- tmux を知っている版が次に起動した時に、`open-sessions.tmux-held.json` があれば、今の保存リストと合わせて読み直す。その後、移したファイルを消す。合わせる時は、同じ id のものを1つにし、tmux に残っている物はつなぎ直す。
- 移している間（前の版で動いている間）は、tmux の中のセッションはアプリの画面に出ない。画面の上に「前の版に戻したため、N 件のセッションが裏で動いています」と出す、とは前の版ではできない。そのため、ac-update.sh と ac-rollback.sh の出力と、ログに件数と `tmux -L agent-console attach -t =<名前>` での見方を書く。
- 前の版に戻すのは、アプリが正しく動かない時だけ。

### 3-5 画面
- 端末の画面の部品は変えない。次の2つの知らせだけを足す。文言は ja.json に、見た目は SA の金型とトークンにする。
  - tmux が無い時の知らせ。
  - 「端末につなげません」の知らせ。

### 3-6 CI
- CI の両方の OS で tmux を入れる（`brew install tmux`、`apt-get install tmux`）。入らなければ、tmux の試験を skip し、そのことをログに出す。

## 4. SSOT
- セッションの本体の正本は、tmux サーバー（`-L agent-console`）の1か所。
- 「どのセッションを開くか」の正本は、今の保存リスト。id を足すだけで、対応表は作らない。tmux の名前は、id から作る。

## 5. 安全
- PO の普段の tmux とは、ソケットも設定も分ける（K5）。
- 秘密を tmux サーバーに渡さない（K11）。
- 消すのは、アプリが作った `ac-*` だけ。それも、PO が閉じた時だけ。
- 前の版に戻す時も、claude を切らない（PO の n）。前の版が同じ会話を二重に起動しないよう、保存リストを一時的に移す（§3-4）。
- この版を入れる最初の更新は、今動いているセッション（direct）が今までどおり切れて、`--resume` で開き直る。次の更新から切れなくなる。

## 6. 代替案
- 公式の `claude --bg`＋`attach`: 素のシェルの役目に使えない。作り直しが多い（recon F-1）。不採用。
- 番人のプロセスを自作する: Orca は約8.7万行（recon D-1）。不採用。
- AbandonProcessGroup で残す: つなぎ直せない（recon B-2）。不採用。
- 手が空くのを待ってから更新する（今）: 何時間も更新できない。

## 7. リスク（工程0で確かめる。駄目なら止める）
- R1 スクロール（K7）。駄目なら実装せず、PO に y/n を聞く。
- R2 launchd の下の node が起こした tmux が、SIGTERM の後も残るか。残らなければ止める。
- R3 キー、貼り付け（bracketed paste）、マウス、OSC 52（選択のコピー）が今と同じか。
- R4 環境変数と秘密（K10、K11）。TERM が tmux-256color に変わることで、ccopusgo と claude の動きが変わらないか。
- R5 attach を SIGHUP で終わらせた時に、tmux のセッションが残るか。
- R6 過去の出力の先入れ（§3-3）。

## 8. 外部・過去事例の参照と我々への応用
- VS Code は「プロセスにつなぎ直す」と「内容を戻して起動し直す」を分けている（recon D-2）。この設計の「tmux があればつなぎ直す、無ければ `--resume`」も同じ2段。
- Orca は、端末を別の常駐プロセスに持たせている（recon D-1）。この設計は、その役を tmux に任せる。
- 適用限界: tmux を xterm.js の後ろに置いた事例の実測は、工程0のものだけ。

## 9. 工程
- 工程0: 実測する（R1〜R6、K3、K6、K7、K10、K11）。結果は step0.md に書く。R1 か R2 が駄目なら止める。
  - 後片付けとして、recon の実験の残り（/private/tmp/tmux-501/acexp、kspr）を消す。
- 工程1: 試験を先に書く。
- 工程2: 実装。
- 工程3: CI と e2e。
- 工程4: Fable のコード審査。
- 導入: この版の導入だけは、今の決まりどおり、全員の手が空くのを待つ。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1、K2、K5、K11、K12、K14 を試験で固定する。

## 10. 実装時の決め（Fable 第2回審査の条件を設計者が確定）
- A: tmux の時の「終了したか」は、`has-session` の結果で決める。`kill-session` の後に `has-session` が偽になったら、exited にする。K4 の統合試験に、「attach が無い状態から ×」を1件足す。
- B: 本体が終わったとみなすのは、`has-session` の stderr が `can't find session` の時だけにする。`error connecting` や `protocol version mismatch` などは「つなげません」の扱いにし、exited にしない。判定の文字列は工程0で実測し、step0.md に書く。
- C: target は `-t =<名前>` にして、完全一致に固定する。K5 の単体試験で `=` を確かめる。
- D: `update-environment` は設定に書かない。`new-session -E` と `attach -E` で、適用を止める。
- E: 名前を作る関数で、`:` と `.` が無いことを確かめる。

## 11. 切戻しの決め（Fable 第3回審査の指摘を設計者が確定。§3-4 より優先）
- #1 routine: `routines.json` も `routines.tmux-held.json` に移す。前の版では、routine の予定も止まる。tmux を知っている版が起動したら、held を元の名前に戻してから RoutineService を start する。K14 の試験に、routine を1件含める。
- #2 順番: ①今のサーバーを止める（`launchctl kill SIGTERM gui/<uid>/<label>`、pid が消えるまで待つ）→ ②移す（open-sessions.json、routines.json）→ ③`ac_switch_current` → ④`kickstart`。切戻し専用の関数を ac-common.sh に足し、ac-update.sh の失敗時と ac-rollback.sh の両方で使う。K14 で「移す前にサーバーの pid が消えている」を確かめる。
- #3 合わせ直しの鍵: 鍵は「id、または claudeSessionId の一致」。一致したら held 側（tmux の本体）を採り、今のリスト側を捨てる。claudeSessionId が無い項目は両方残す。K14 に、同じ claudeSessionId がある場合を1件足す。
- #4 PO への注意: 前の版で動いている間は、同じ会話を手で開き直さない。ac-update.sh と ac-rollback.sh の出力に、「裏で N 件が動いています。この間は会話を開き直さないでください」を出す。README にも書く。
- #5 判定の印: 戻す先の版の `dist-server` に、tmux の端末層の実装ファイルがあるかで判定する。ファイル名は実装で決め、単体試験で固定する。
- #6 held が既にある時: 上書きしない。今のリストと合わせてから、held に書く。K14 に1件足す。
