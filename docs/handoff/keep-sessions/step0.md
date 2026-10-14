# 工程0 実測結果: 更新してもセッションを切らない（tmux）

**停止：PO 報告が必要**（R1 が ×。R2 は ○）

- R1（スクロール、K7）: 一度にまとめて出た出力（40・100・300 行）では、tmux 経由だと xterm.js のスクロールバックに過去の行が入らず、ホイールで過去へ動かない。1 行ずつ流れる出力では direct と同じに動く。設計 §7 R1「駄目なら実装せず、PO に y/n を聞く」、§9 工程0「R1 か R2 が駄目なら止める」に該当する。
- R3 の Esc: 内容は同じだが、tmux 経由は届くまで中央値 639 ms（direct は 10 ms）。`escape-time 0` を設定した状態での値。
- R2（launchd の下の node が起こした tmux が SIGTERM の後も残るか）、K1、K3（本物の claude）、K11、R5 は ○。

## 1. 目的

設計 `docs/handoff/keep-sessions/design.md` §9 の工程0 として、tmux を xterm.js の後ろに置いて問題ないかを実測した。対象は R1〜R6、K1、K3、K6、K7、K10、K11。結果から、実装に進めるか、止めて PO に聞くかを決める。製品コードは触っていない。

## 2. 実行日時と環境（生データから分かる範囲）

- 日付: 2026-10-13。生データの時刻は 13:44（cleanup-check.txt:1）から 14:13（r3-esc-direct.json 等の更新時刻）。K3 は server 側ログで 05:04:34Z〜05:06:16Z（JST 14:04〜14:06、k3-real-claude.json:3-14）。
- OS: macOS（Darwin。ps の出力が日本語表記）。
- tmux: `tmux 3.8`（k3-real-claude.json:18、r1-scroll-tmux.json:4）。パスは `/opt/homebrew/bin/tmux`（r2.sh:10）。
- 試験用ソケット: `acstep0`（rig.mjs:13）。アプリ専用のソケット名 `agent-console` は使っていない。
- tmux 設定: `ops/tmux/agent-console.tmux.conf`（新規・未追跡。更新時刻 13:54）。r1 の tmux 側（13:55 以降）と r3、K3 はこの設定で測っている。
- 画面側: xterm.js をアプリと同じ版（rig.mjs:1 のコメントに 6.0.0 とある。版は別途測っていない）で Chromium（Playwright）上で動かし、node-pty の出力をそのまま書き込む試験台（rig.mjs:44-83）。大きさは 100x30（K3 は 120x30。real-claude.mjs:17-18）、scrollback 2000（rig.mjs:78）。
- node: `/usr/local/bin/node`（rig.mjs:32、r2.sh:17）。
- 環境: 親の環境に秘密名（AGENT_CONSOLE_TOKEN など 4 つ）を入れ、除外してから tmux に渡す（rig.mjs:23-25、r2-server.mjs:15-17）。TERM=xterm-256color、LANG=ja_JP.UTF-8 を渡す。
- 本物の claude: `Claude Code v2.1.296`、`Sonnet 5.5`（k3-real-claude.before.txt:2-3）。実行は 1 回だけ（real-claude.mjs:3）。
- 比較の取り方: direct（今の作り。node-pty が直接起動）と tmux（tmux の中で起動し、node-pty で `attach-session` をつなぐ）を同じ試験台で測っている（rig.mjs:62-67）。

### 生データと試験台の版について（事実）
- `step0-scripts/rig.mjs` と `inner.mjs` の更新時刻は 14:27 で、生データ（最後が r3 の 14:13、K3 は 14:06）より後。
- `r3-esc-*.json` には、現在の rig.mjs:118-120 が書くはずの `xdaAnsweredByServer`、`startupRepliesFromXterm`、`startupQueriesFromTmux` が入っていない。したがって r3-esc の生データは、現在の rig.mjs より前の版で採ったもの。
- inner.mjs には `plain` `bp` `mouse` `bpmouse`（inner.mjs:17-26）、rig.mjs には `XDA_REPLY=1`（rig.mjs:69-74）と `AC_CONF`（rig.mjs:18）の切り分けの仕掛けがあるが、その結果の生データは `step0-raw/` に無い。

## 3. 項目ごとの結果

判定の凡例: ○ = 基準を満たす / × = 基準を満たさない / 判定不能 = データが足りない。

### R1 / K7 スクロール

- 基準（design.md:45 K7）: 「ホイール1回で、xterm.js の画面が過去の出力の方へ動く。tmux の copy-mode に入らない。文字の選択とコピーも今と同じ」。design.md:134 R1: 「スクロール（K7）。駄目なら実装せず、PO に y/n を聞く。」design.md:147: 「R1 か R2 が駄目なら止める」。
- 観測値（ホイール 1 回 = 縦 -300。`afterWheelUp.viewportY`、`length`、`selectAllHasLine1`、`paneInMode`）:

| シナリオ | direct | tmux |
|---|---|---|
| scroll（300 行を一度に） | length=302、viewportY 272→269（動く）、selectAllHasLine1=true、selectAll=2604 文字（r1-scroll-direct.json:9,19,42-43） | length=30、viewportY 0→0（動かない）、selectAllHasLine1=false、selectAll=264 文字、paneInMode="0"（r1-scroll-tmux.json:9,19,42-44） |
| scroll100（100 行を一度に） | length=102、viewportY 72→69、selectAllHasLine1=true、804 文字（r1-scroll100-direct.json:9,19,42-43） | length=31、viewportY 1→0（1 行だけ動く）、selectAllHasLine1=false、245 文字、paneInMode="0"（r1-scroll100-tmux.json:9,19,42-44） |
| scroll40（40 行を一度に） | length=42、viewportY 12→9、selectAllHasLine1=true、323 文字（r1-scroll40-direct.json:9,19,42-43） | length=30、viewportY 0→0（動かない）、selectAllHasLine1=false、236 文字、paneInMode="0"（r1-scroll40-tmux.json:9,19,42-44） |
| scrollslow（1 行ずつ 8 ms 間隔で 300 行） | length=302、viewportY 272→269、selectAllHasLine1=true、2604 文字（r1-scrollslow-direct.json:9,19,42-43） | length=302、viewportY 272→269、selectAllHasLine1=true、2604 文字、paneInMode="0"（r1-scrollslow-tmux.json:9,19,42-44） |

- ホイールが pty へ送ったバイト列: 全シナリオ・両モードで `[]`（例 r1-scroll-tmux.json:29）。
- 判定:
  - copy-mode に入らない: ○（tmux 側 4 シナリオとも `paneInMode: "0"`）。
  - ホイールで過去の出力の方へ動く: 一度にまとめて出た出力（scroll・scroll100・scroll40）は ×。1 行ずつ流れる出力（scrollslow）は ○。
  - 文字の選択とコピー（全選択に先頭行 `line 1` が入るか）: scroll・scroll100・scroll40 は ×、scrollslow は ○。
  - **R1 総合: ×**
- 本物の claude での補足（k3-real-claude.json:26,39-41）: claude 実行中の xterm.js は `mouseTrackingMode: "any"`。ホイールは `\e[<64;23;12M` として claude へ送られ、xterm.js のスクロールバックは動かない（`viewportY: 0`、`baseY: 0`）。この挙動の direct 側の対照は採っていないため、claude 実行中のスクロールが今と同じかは **判定不能**（足りないもの: 本物の claude を direct で動かした同じ手順の記録）。同じ「マウス追跡中はホイールが中へ届く」挙動は、疑似プログラムでは direct・tmux とも同じ（r3-keys-direct.json:104-108、r3-keys-tmux.json:104-108）。
- 根拠ファイル: `step0-raw/r1-*.json`、`step0-scripts/rig.mjs:94-115`、`step0-scripts/inner.mjs:6-15,47-59`、`ops/tmux/agent-console.tmux.conf:37-39`（`smcup@:rmcup@` を設定済みの状態での結果）。
- 原因: 生データには原因を示す観測が無い。**【未確認】** 一度にまとめて出た出力で xterm.js の length が 30 のままになることと、tmux が画面を描き直して送ることとの関係は、この実測では確かめていない。

### R2 / K1 launchd の下の node が起こした tmux が SIGTERM の後も残るか

- 基準: design.md:135 R2「launchd の job の下の node が起こした tmux が、SIGTERM の後も残るか。残らなければ止める。」design.md:39 K1「サーバーを再起動しても（SIGTERM。`kickstart -k` と同じ）、各セッションの本体が同じ pid で動き続ける」。
- 観測値（r2.txt）:
  - 起動時: `pane_pid=35572`（:2）、launchd の job pid 35553（:4）、tmux セッション `ac-step0-r2` 1 つ（:6）、クライアント 1 つ（:8）。
  - `launchctl kill SIGTERM` の後: job は `-	0`（終了。status 0）（:28）、server.log に `SIGTERM: killing attach only`（:33）、`35572 35560 Ss+ sleep 900`（:35-36。同じ pid、生存）、セッション `ac-step0-r2` が残る（:38）、クライアントは空（:39）、tmux サーバー pid 35560、ppid 1（:42）。
  - `launchctl remove` の後も: `35572 ... sleep 900` が生存（:45-46）、セッションが残る（:48）。
- 判定: **R2: ○**、**K1（実測の部分）: ○**（pane の pid が起動時と SIGTERM 後と remove 後で 35572 のまま）。
- 注意（事実）: 使ったのは使い捨ての `launchctl submit` の job と `launchctl kill SIGTERM`（r2.sh:17,39）。実際の LaunchAgent の plist と `kickstart -k` そのものではない。本番の plist での確認は工程0のデータには無い。

### R5 attach を SIGHUP で終わらせた時に tmux のセッションが残るか

- 基準: design.md:139 R5「attach を SIGHUP で終わらせた時に、tmux のセッションが残るか。」
- 観測値: K3 で `attach A killed (SIGHUP)`、`attach A exited {"exitCode":1,"signal":0}`、`pane_pid after kill = 48149 (before 48149); list-clients=[]`（k3-real-claude.json:7-9）。R2 でも node が attach を終わらせた後にセッションが残る（r2.txt:38）。
- 判定: **○**

### K3 作業中の claude の作業が、再起動で切れずに最後まで終わる

- 基準: design.md:41 K3「作業中の claude の作業が、再起動で切れずに最後まで終わる」（検証: 本物の claude で実測）。
- 観測値（k3-real-claude.json、時刻は UTC）:
  - 05:04:34 tmux 内で `claude --model sonnet ... 'sleep 30 && echo DONE ... 1 から 120 ... FINISHED'` を起動、pane_pid=48149（:3）。
  - 05:05:04 画面に `sleep 30` が見える（:5）。05:05:05 `ps` 48149 の開始時刻 `10/13 14:04:34`（:6）。
  - 05:05:08 attach A を SIGHUP で終了（:8）。05:05:09 pane_pid は 48149 のまま、クライアントは空（:10）。
  - 05:05:13 attach B で新しいサーバー役がつなぎ直す（:11-12）。
  - 05:06:10 `FINISHED visible: true`（:13）。05:06:12 `ps` が前と同じ行（:14）。`samePanePidAndStartTime: true`（:55）。
  - 最後の画面: `99` から `120`、`FINISHED`、`✻ Sautéed for 3s · done 14:06`（k3-real-claude.after.txt:1-25）。
- 判定: **○**（作業が切れずに最後まで終わり、pane の pid と開始時刻が同じ）。
- 注意（事実）:
  - `sameClaudeChildren: true`（:56）は、前後とも子の一覧が空（:6,15）の比較なので、根拠にならない。pane の pid 自体が `claude`（:6）で、この検索は子孫だけを見ている（real-claude.mjs:37）。
  - `sameSleepHistoryInTmux: false`（:57）。`capture-pane -S -400` の結果が 30 行しかなく（after.txt は 30 行）、`DONE` の行は無い。画面に出ていた確認は 99〜120 と FINISHED まで。
  - 実行は 1 回だけ（real-claude.mjs:3）。
  - 切ったのは attach のみ（SIGHUP）。launchd 配下の node の SIGTERM とは別の試験（R2 が担当）。

### R3 / K6 キー、貼り付け、マウス、OSC 52

- 基準: design.md:136 R3「キー、貼り付け（bracketed paste）、マウス、OSC 52（選択のコピー）が今と同じか。」design.md:44 K6「キーを横取りしない。Ctrl+B、Shift+Enter、Esc が今と同じく claude に届く。貼り付けが1回で届く」。
- 観測値（direct と tmux のバイト列。r3-keys-direct.json / r3-keys-tmux.json、ともに :17-91）:

| 項目 | direct | tmux | 判定 |
|---|---|---|---|
| Ctrl+B | `02`（:21） | `02`（:21） | ○ |
| Esc（バイト） | `1b`（:28） | `1b`（:28） | ○ |
| Shift+Enter | `0d`（:35） | `0d`（:35） | ○（今と同じ。どちらも修飾なしの Enter と同じ 0d） |
| Enter / ArrowUp / Ctrl+C / a / Shift+Tab / Alt+Enter | `0d`/`1b5b41`/`03`/`61`/`1b5b5a`/`1b0d` | 同じ | ○ |
| Alt+B、Ctrl+Shift+A | 届かない（hex 空） | 届かない（hex 空） | 同じ（direct・tmux とも試験台からは届かない） |
| 貼り付け（短い） | 1 read、`1b5b3230307e...1b5b3230317e`、bracketed=true（:92-96） | 同じ列（:92-96） | ○ |
| 貼り付け（4000 文字） | 4 reads、4012 bytes、xCount=4000、前後に bracket（:97-103） | 同じ（:97-103） | ○ |
| マウス（ホイール、追跡中） | `1b5b3c36343b31323b364d`（:104-108） | 同じ（:104-108） | ○ |
| OSC 52 | `\e]52;c;aGVsbG8=\a` を受け取る（:122-123） | 同じ（:122-123） | ○ |
| 日本語 | `japanese: true`（:130） | `japanese: true`（:130） | ○ |
| リサイズ（K8 の一部） | `RESIZE 70x20`（:131-133） | `RESIZE 70x20`（:131-133） | ○ |

- Esc の遅れ（r3-esc-*.json、各 10 回）:
  - direct: 最小 3 ms、中央値 10 ms、最大 51 ms（r3-esc-direct.json:67-71）。
  - tmux: 最小 562 ms、中央値 639 ms、最大 698 ms（r3-esc-tmux.json:67-71）。設定は `escape-time 0`（ops/tmux/agent-console.tmux.conf:20）のまま。
  - キー試験でも同じ傾向: Esc の firstLatencyMs は direct 76、tmux 588（r3-keys-direct.json:30、r3-keys-tmux.json:30）。他のキーは tmux の方が同等かそれ以下（例 Enter は direct 143、tmux 8）。
  - tmux 起動直後に tmux が外側の端末へ問い合わせを出している（r3-esc-tmux.raw.txt:1 に `\e[c\e[>c\e[>q\e[?2026$p\e]10;?\e\\e]11;?\e\\`）。
- 判定:
  - バイト列の内容（キー・貼り付け・マウス・OSC 52）: **○**
  - Esc の届くまでの時間: **×**（基準は「今と同じく」で、数値の基準は設計に無い。中央値で 10 ms → 639 ms は同じとは言えない。許容値の決定は設計者の判断）
  - **R3 総合: ×**（Esc の遅れのみ）
- 原因: 遅れの原因は **【未確認】**。上の問い合わせに xterm.js が答えないことと関係するかを rig.mjs:69-74（`XDA_REPLY=1`）で切り分けようとした形跡はあるが、その結果の生データは無い（セクション 2 参照）。
- 補足（事実）: Shift+Enter が direct・tmux とも `0d` なので、`extended-keys on`（conf:26）と terminal-features（conf:29）が効いているかは、この試験では見えない。

### R4 / K10 環境変数、秘密、TERM

- 基準: design.md:137 R4「環境変数と秘密（K10、K11）。TERM が tmux-256color に変わることで、ccopusgo と claude の動きが変わらないか。」design.md:48 K10「hooks・作戦ボード・チャットが、今と同じに動く。セッションごとの環境変数が渡る。日本語が正しく出る」。
- 観測値:
  - TERM: direct は `TERM=xterm-256color`、tmux は `TERM=tmux-256color`（r3-keys-direct.json:129、r3-keys-tmux.json:129）。LANG は両方 `ja_JP.UTF-8`。
  - セッションごとの環境変数: `AC_RESUME_ID=demo-resume`（r2.txt:20、r3-keys-tmux.json:129）。`TOKEN=[]`（秘密は子に渡っていない。同:129、r2.txt:23）。
  - 日本語: `japanese: true`（r3-keys-tmux.json:130）。
  - 本物の claude が tmux の中で正しく描画・動作した: バナー（k3-real-claude.before.txt:2-4）、最後の画面（after.txt:25-30）。
- 判定:
  - 環境変数が渡る / 日本語 / claude が TERM=tmux-256color で動く: **○**（claude は 1 回の実行で）。
  - ccopusgo: **判定不能**（足りないもの: ccopusgo を tmux 内で動かした記録）。
  - hooks・作戦ボード・チャット: **判定不能**（足りないもの: 統合試験。工程0のデータには無い）。
  - **R4 総合: 判定不能**（ccopusgo、hooks・作戦ボード・チャットが未測定）。

### K11 tmux サーバーの環境に秘密が無い

- 基準: design.md:49 K11「tmux サーバーの環境に、秘密（CHILD_ENV_BLOCKLIST の物）が無い（`show-environment -g` で確かめる）」。
- 観測値: 親の環境に `AGENT_CONSOLE_TOKEN` がある状態（r2.txt:30 `parent env has AGENT_CONSOLE_TOKEN=true`）で、`show-environment -g` に AGENT_CONSOLE_TOKEN / AGENT_CONSOLE_AUTH / AC_SECURITY / AC_STUB_LOG はいずれも無い（r2.txt:10-13）。セッションの環境にも無い（r2.txt:15-18）。pane の中でも `token=[]`（r2.txt:23）。
- 判定: **○**
- 注意（事実）: 確かめた名前は試験台が持つ 4 つ（r2-server.mjs:15）で、本体の `CHILD_ENV_BLOCKLIST`（config.ts:206）そのものを読んではいない。`ps eww` による pane プロセスの環境の確認は出力が空（r2.txt:21-22）で、そこでは確認できていない。

### R6 過去の出力の先入れ（capture-pane）

- 基準: design.md:139 R6、design.md:96「`capture-pane -p -e -S -<N>` で ring に先に入れる案を、工程0で試す。うまくいけば入れる。駄目なら『最後の画面だけ』とし、step0.md に書く」。
- 観測値: `capture-pane -p -J -S -400`（`-e` なし）で取った K3 の最後の画面は 30 行で、`DONE` の行を含まない（real-claude.mjs:30、k3-real-claude.after.txt、k3-real-claude.json:57）。ring に入れてからつなぎ直した結果の画面の記録は無い。
- 判定: **判定不能**（足りないもの: `-e` つきの取得を ring へ先入れしてから attach したときの画面と、先入れ前後の比較）。

### §10-B 判定の文字列（has-session の stderr）

- 基準: design.md:161 B「判定の文字列は工程0で実測し、step0.md に書く」。
- 観測値（tmux 3.8。has-session-strings.txt）:
  - サーバー無し: `no server running on /private/tmp/tmux-501/acstep0`、rc=1（:3-4）
  - サーバーあり・セッション無し: `can't find session: ac-x`、rc=1（:6-7）
  - `=ac-ke` は `ac-keep` に一致しない: `can't find session: ac-ke`、rc=1（:9-10）。`=` なしの `ac-ke` は一致して rc=0（:12）。これで §10-C（`=` で完全一致）の根拠になる。
  - あり: rc=0（:14）
  - ソケットのある場所に入れない: `error connecting to ... (Permission denied)`、rc=1（:16-17）
  - ソケットのパスが通常ファイル: `error connecting to ... (Socket operation on non-socket)`、rc=1（:19-20）
  - ソケットのディレクトリが無い: `error connecting to ... (No such file or directory)`、rc=1（:22-23）
  - 古いソケットファイルだけ残る: `no server running on /tmp/kspr-stale.sock`、rc=1（:25-27）
- 判定: 文字列は実測できた。**要判断（設計者）**: §10-B は「本体が終わったとみなすのは `can't find session` の時だけ」だが、最後のセッションが終わると `exit-empty on`（conf:35）で tmux サーバーも終わるため、その後の `has-session` は `no server running`（:3）になる。この文字列を「つなげません」の扱いにするか「本体が終わった」にするかを、実装前に決める必要がある。古いソケットだけ残る場合（:26）も同じ文字列で、区別できない。

### 後片付け

- 基準: design.md:148「recon の実験の残り（/private/tmp/tmux-501/acexp、kspr）を消す」。
- 観測値: cleanup-check.txt:3-4 で `acexp`・`kspr` のサーバーは無く、:6-8 で `/private/tmp/tmux-501/` には `default` だけ。
- 判定: **○**。この文書の作成後にも、試験で使った `acstep0` のソケットを消した（手順は報告に別記。default は触っていない）。

## 4. tmux 設定の各行と実測（design.md:58）

`ops/tmux/agent-console.tmux.conf` の現状と、実測との対応。

| 行 | 内容 | 実測での根拠 |
|---|---|---|
| conf:7-11 | `prefix None`、`prefix2 None`、`unbind -q -a`、`unbind -q -n -a` | Ctrl+B が `02` で届く（r3-keys-tmux.json:21）。 |
| conf:14 | `mouse off` | copy-mode に入らない（`paneInMode: "0"`）。マウス追跡中のホイールが中へ届く（r3-keys-tmux.json:104-108）。 |
| conf:17 | `status off` | 画面は 30 行そのまま使われている（r3-keys-tmux.json:9 `length: 30`）。 |
| conf:20 | `escape-time 0` | Esc の遅れは中央値 639 ms で、これだけでは直っていない（r3-esc-tmux.json:67-71）。効果は未確認。 |
| conf:23 | `default-terminal tmux-256color` | 中の TERM が `tmux-256color`（r3-keys-tmux.json:129）。claude は動いた（K3）。 |
| conf:26-29 | `extended-keys on`、`terminal-features ",xterm*:extkeys"` | 効果は見えない（Shift+Enter が direct・tmux とも `0d`）。 |
| conf:32 | `history-limit 2000` | 数値は xterm.js の scrollback と揃えただけで、実測で決めてはいない。一度にまとめて出た出力で xterm.js 側のスクロールバックに行が入らないことが R1 の原因で、この値では解決していない。 |
| conf:35 | `exit-empty on` | 最後のセッションが終わるとサーバーも終わる想定。has-session の文字列に影響する（上の §10-B 要判断）。 |
| conf:38-39 | `terminal-overrides ",xterm*:smcup@:rmcup@"` | 外側に `?1049h` は出ていない（r3-keys-tmux.json:127 `smcup1049h: false`）。それでも R1 は ×。 |
| conf:42 | `set-clipboard on` | OSC 52 が外側に届く（r3-keys-tmux.json:122-123）。 |
| conf:45 | `@ac_conf_version "0.14.0"` | 実測の対象外。 |

設計 §3-1 の案との差: `mouse off`、`prefix2 None`、`set-clipboard on` が追加されている。`update-environment ""` は §10-D（設定に書かない）に合わせて書いていない。

## 5. 総合

| 項目 | 判定 |
|---|---|
| R1 スクロール（K7） | **×**（まとめて出た出力でスクロールバックに入らない。1 行ずつの出力は ○） |
| R2 tmux が SIGTERM の後も残る | ○ |
| R3 キー・貼り付け・マウス・OSC 52（K6） | **×**（Esc の遅れのみ。他は ○） |
| R4 環境変数・TERM（K10） | 判定不能（ccopusgo、hooks・作戦ボード・チャットが未測定。他は ○） |
| R5 SIGHUP で attach を終わらせても残る | ○ |
| R6 過去の出力の先入れ | 判定不能 |
| K1 同じ pid で動き続ける | ○（実測の部分） |
| K3 本物の claude の作業が最後まで終わる | ○（1 回の実行） |
| K11 tmux の環境に秘密が無い | ○ |
| §10-B has-session の文字列 | 実測済み・要判断あり |
| 後片付け | ○ |

**停止：PO 報告が必要。** R1 が × のため、設計 design.md:134 に従い、実装に進まず、PO に y/n を聞く。

PO に聞く内容（設計者が案を 1 つに絞って示す。この文書では判断しない）:
- 事実: tmux 経由では、一度にまとめて出た出力が xterm.js のスクロールバックに入らず、ホイールで過去へ動かない。選択・コピーで取れる範囲も画面の 30 行になる（r1-scroll-tmux.json:9,19,43-44）。1 行ずつ流れる出力では direct と同じに動く（r1-scrollslow-tmux.json）。
- 事実: 本物の claude 実行中は、tmux 経由でもホイールのバイト（`\e[<64;23;12M`）が claude へ届いた（k3-real-claude.json:39-41）。direct の本物の claude での対照は未測定。
- 事実: 更新で作業が切れない効果（R2、K1、K3、R5）は、この実測で確認できた。

追加で必要な測定（設計者の判断で決める）:
- R1: 本物の claude を direct で動かした場合のスクロール・選択の記録（対照）。
- R3: Esc の遅れの原因の切り分け結果（rig.mjs の `XDA_REPLY=1`、inner.mjs の `plain`/`bp`/`mouse`/`bpmouse` の結果の保存）。
- R4: ccopusgo。
- R6: `capture-pane -e` の先入れ。

## 6. 根拠ファイル一覧

- 設計: `docs/handoff/keep-sessions/design.md`
- 生データ: `docs/handoff/keep-sessions/step0-raw/`（cleanup-check.txt、has-session-strings.txt、k3-real-claude.*、r1-*、r2.txt、r3-*）
- 試験台: `docs/handoff/keep-sessions/step0-scripts/`（inner.mjs、r2-server.mjs、r2.sh、real-claude.mjs、rig.mjs）
- tmux 設定: `ops/tmux/agent-console.tmux.conf`
