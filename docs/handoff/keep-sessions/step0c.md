# 工程0c 追加測定: control mode にしたときの出力以外の項目（C1〜C8）

日付 2026-10-14（作業開始 10-13）。製品コードは触っていない。生データと道具は `/tmp/CC報告ファイル/keep-sessions/step0c/`（`scripts/` に道具）。試験用ソケットは `acstep0c*` のみ使い、終了後に個別 rm 済み（`/private/tmp/tmux-501/` は `default` のみ）。tmux 3.8、xterm.js 6.0.0（`/Users/tanizawashingo/agent-console-wt/keep-sessions/node_modules`）。ポート 4319〜4329・本番サーバーには触れていない（試験台は node の単体プロセス＋Playwright の Chromium）。

## 共通の測り方
- 「直結」= node-pty で pane 内と同じプログラムを直接起動し write する。「control mode」= tmux セッション内で同じプログラム、`tmux -C attach` の stdin に `send-keys -t %0 -H <16進>…` を流す。設定は `ops/tmux/agent-console.tmux.conf`、pane サイズ 100x30（C8 は 120x30）。
- pane 内の受信器 `scripts/recv.mjs`: raw モードで stdin を読み、1 read ごとに `時刻ms D 16進` をファイルに書く。SIGWINCH は `W 列 行`。時刻は受信側の `Date.now()`。
- 道具: `scripts/lib.mjs`（makeTarget）、`c1.mjs`〜`c8.mjs`、`writer.mjs`（C6/C7 の書き手）、`screenapp.mjs`（C5 の画面アプリ）。

## C1 キー入力: ○
方法: ASCII・日本語・Ctrl-C(03)・Esc(1b)・矢印(1b5b41/44)・Enter(0d)・Tab(09)・F5(1b5b31357e)・Shift+Enter(1b5b31333b3275) を各 10 回送り、pane が受けたバイトが送ったものと一致するか、送信→受信の遅延(ms)。
| 項目 | 直結 一致 | 直結 遅延 中央値/最大 | control 一致 | control 遅延 中央値/最大 |
|---|---|---|---|---|
| ascii `hello world` | 10/10 | 2 / 6 | 10/10 | 1 / 1 |
| 日本語 6 字（UTF-8 18byte） | 10/10 | 0 / 3 | 10/10 | 0 / 1 |
| Ctrl-C 03 | 10/10 | 0 / 1 | 10/10 | 1 / 1 |
| Esc 1b | 10/10 | 0 / 0 | 10/10 | 0 / 1 |
| 上 1b5b41 | 10/10 | 0 / 0 | 10/10 | 1 / 1 |
| 左 1b5b44 | 10/10 | 0 / 2 | 10/10 | 0 / 1 |
| Enter 0d | 10/10 | 0 / 1 | 10/10 | 1 / 4 |
| Tab 09 | 10/10 | 0 / 1 | 10/10 | 1 / 5 |
| F5 | 10/10 | 0 / 0 | 10/10 | 1 / 6 |
| Shift+Enter(CSI u) | 10/10 | 0 / 0 | 10/10 | 0 / 6 |
【事実】全 10 項目×10 回が両方式で一致。遅延は直結 最大 6ms、control 最大 6ms。`send-keys -H` は ESC(1b)・0x80 以上も渡せる。pane は raw モードのため Ctrl-C は 03 のまま届く（SIGINT 化は未測定。cooked モードの pane は未確認）。
生データ: `c1.json`

## C2 貼り付け: ○（ただし分割が必須、64KB は遅い）
方法: pane が `\e[?2004h` を出した状態で `\e[200~` + 日本語・改行(\n と \r\n)・絵文字を含む文章 + `\e[201~` を送り、受信バイトの sha256 一致と所要時間（受信側タイムスタンプで、送信開始→最後のバイト到着）。各 5 回。
| 方式 | 貼り付け総バイト | sha256 一致 | 所要 中央値(最小〜最大) ms |
|---|---|---|---|
| 直結 | 1,036 | 5/5 | 1 (1〜2) |
| 直結 | 65,532 | 5/5 | 15 (7〜18) |
| control（1 回で送信） | 1,036 | 5/5 | 8 (6〜13)（chunk 9000） |
| control 分割 500B | 65,532 | 5/5 | 251 (242〜416) |
| control 分割 1000B | 65,532 | 5/5 | 296 (282〜336) |
| control 分割 2000B | 65,532 | 5/5 | 502 (500〜535) |
| control 分割 4000B | 65,532 | 5/5 | 1223 (1140〜1334) |
| control 分割 9000B | 65,532 | 5/5 | 2605 (2150〜23285) |
| control 分割 50〜300B | 65,532 | 5/5 | 311〜740 中央値（50B:351, 100B:311, 200B:357, 300B:740） |
send-keys の上限（事実）: `send-keys -H` に 1 コマンドで渡せるバイト数は 9,780 まで、9,781 以上は `parse error: yacc stack overflow` で 1 バイトも届かない（二分探索、`c2b.json`）。65,536 / 131,072 / 262,144 / 1 MiB / 4 MiB を 1 コマンドで送る試験も全て同じエラーで受信 0（`c2.json` の limits）。よって 64KB の貼り付けは分割が必須。安全側の分割は 1 コマンド 500〜1000 バイト（所要が最短）。大きい分割ほど遅くなる（9000B で 2.6 秒）。
【事実】1KB は分割不要・直結 1ms に対し control 8ms。64KB は分割して 250〜300ms（直結 15ms の約 17〜20 倍）。
【未確認】`send-keys -l`、`set-buffer`+`paste-buffer -p` など別経路での 64KB 貼り付けは未測定（速くなるかは不明）。
生データ: `c2.json`（初回・ポーリング負荷あり、時間は参考外）、`c2b.json`（上限）、`c2c.json`（分割 500〜9000B と直結、時間はこちらが正）、`c2d.json`（分割 50〜300B）

## C3 マウス: ○
方法: pane が `\e[?1000h\e[?1006h` を出した状態で SGR 列を送る: 押す `\e[<0;10;5M`、離す `...m`、ホイール上 `\e[<64;10;5M`、下 `<65`、右ボタン `<2;120;40M`、ドラッグ `<32;11;6M`、桁 3 桁 `<0;250;100M`、およびホイール 200 発を 1 回で。
【事実】直結・control とも 7 種すべて送ったバイトと完全一致（match:true）。200 発連続も一致（直結 13ms、control 32ms）。単発の遅延は直結 2〜8ms、control 1〜20ms。
注意【事実】`send-keys -H` は tmux の `mouse` 設定や pane のマウス状態に関係なく生バイトを渡す。
生データ: `c3.json`

## C4 リサイズ: △（正しく反映されるが、tmux が 250ms 付近で絞る）
書式（tmux 3.8 man で確認）: `refresh-client -C <幅>x<高さ>`（または `@ウィンドウID:<幅>x<高さ>`）。`window-size` は既定 `latest`。
方法: 6 種のサイズを 12 回順に切替。pane 内で `process.stdout.columns/rows` と SIGWINCH を記録。連続（直前の操作から 0.3 秒未満）と、間隔を空けた場合を比較。
| 項目 | 直結 | control |
|---|---|---|
| 12 回の列×行の一致 | 12/12 | 12/12 |
| SIGWINCH 回数 | 各 1 回 | 各 1 回 |
| 遅延 中央値(最小〜最大) | 1ms (0〜7) | 265ms (1〜278) |
| 前回操作から 300ms 以上空けた場合 | - | 0〜6ms（`c4b.json`: 間隔 300/400/600/1000/2000ms 各 4 回すべて 0〜6ms） |
| 前回操作から 50〜150ms の場合 | - | 104〜259ms |
| 5 回連続(5ms間隔未満) | - | SIGWINCH は 2 回（`93 28`→`94 29`）、最終サイズは正しい |
【事実】tmux は control client のリサイズを約 250ms 単位で間引く（直前から 250ms 以内の変更は遅れる／連続は合流）。ドラッグ中のリサイズは最終値に収束するが、中間は遅れる。最終サイズは直結と同じ。
生データ: `c4.json`、`c4b.json`

## C5 モード復元: ○（フォーマット変数で取れる。取れないものあり）
方法: `scripts/screenapp.mjs` が通常画面に 5 行出力 → alt-screen(`\e[?1049h`)に入り、飾り（太字・反転・256色・24bit色・下線・斜体・取り消し線・罫線・全角・絵文字）を描き、mouse(1000+1006)・bracketed-paste(2004)・`\e[?1h`・`\e=`・フォーカス(1004)・カーソル形状(`\e[5 q`)を有効にし、カーソルを (12,34) に置いて非表示。直結の xterm.js と、「後から attach した新しい control client」で `display -p` と `capture-pane -e` を取り xterm.js に書いた画面を比較。
フォーマット変数の実測値（alt+全モード中。`c5.json` の `alt.formatVars`）:
| 変数 | 実測 | 意味 |
|---|---|---|
| alternate_on | 1 | alt-screen 中 |
| mouse_any_flag / mouse_standard_flag / mouse_sgr_flag | 1 / 1 / 1 | 1000h と 1006h |
| mouse_button_flag / mouse_all_flag / mouse_utf8_flag | 0 / 0 / 0 | 1002 / 1003 / 1005 は未使用 |
| bracket_paste_flag | 1 | 2004h |
| cursor_flag | 0 | カーソル非表示（通常画面では 1） |
| keypad_cursor_flag | 1 | `\e[?1h` |
| keypad_flag | 1 | `\e=` |
| pane_in_mode | 0 | copy-mode 等ではない |
| cursor_shape / cursor_blinking | bar / 1 | `\e[5 q` |
| cursor_x / cursor_y | 33 / 11 | 0 始まり |
| alternate_saved_x / y | 0 / 5 | 通常画面側の保存カーソル（通常画面時は 4294967295＝未設定） |
| origin_flag / insert_flag / synchronized_output_flag | 0 | |
モード無し(altnomodes)では mouse_*・bracket_paste・keypad_* がすべて 0、cursor_shape=default。【事実】存在しない変数名のエラーは出なかった。
画面の復元（直結との比較。xterm.js のセル単位: 文字・幅・前景/背景色・太字等。空白セルの「未書込 `""`」と「空白 `" "`」は同一視）:
| 復元方法 | 画面テキスト | セル属性 | バッファ種別 | カーソル位置 | モード(xterm.modes) | alt 抜け(1049l)後の通常画面 |
|---|---|---|---|---|---|---|
| `capture-pane -e` の現在画面だけを 1049h の後に書く | 一致 | 一致 | alternate 一致 | 一致 | 不一致（下記） | 通常画面が空（不一致）、カーソルも不一致 |
| `capture-pane -e -a`（通常画面側）を先に書き、保存カーソルに移動してから 1049h、続けて現在画面 | 一致 | 一致 | 一致 | 一致 | 不一致（下記） | 通常画面もセルも一致、カーソルも一致 |
通常画面で動いている pane（mode=normal）は、画面・セル・モード・カーソルすべて一致。モード無し alt 画面は、モードも含めすべて一致。
【事実】`capture-pane -a` は alt-screen 中なら通常画面側（保存されている画面）を返し、alt でないときは `no alternate screen` のエラー（`-q` で抑止）。
不一致のモードは 1 つだけ: `sendFocusMode`（`\e[?1004h`）。直結 true、復元 false。フォーカス報告の状態を返すフォーマット変数は man に無く【未確認】（pane_flags 等で取れるかは未測定）。その他のモード(mouse vt200・bracketedPaste・applicationCursorKeys・applicationKeypad)は変数から `\e[?1000h` 等を組み立てて復元でき、xterm.modes が一致。
【未確認】カーソル形状は変数から取れる（bar/blinking）が、復元して xterm.js 側が同じ形になるかは未確認。スクロール領域・文字セット・タブ位置は未測定。
生データ: `c5.json`（cmp_* が比較結果）

## C6 `%output` のエスケープ復元: ○
方法: pane（`stty raw -echo`）が (a) 0x00〜0xFF 全バイトを 400 順列(102,400B)、(b) 日本語・絵文字・欧文記号の UTF-8 を 588,906B、(c) 同 9,601B（改行入り）を、1〜97 バイトのランダム長で分割して書く。`%output` の `\ooo` を戻して連結し、書き手が計算した sha256 と比較。
| データ | 直結 sha一致 | control sha一致 | control の `%output` 行数 / 回線上バイト |
|---|---|---|---|
| 全 256 バイト 102,400B | 一致 | 一致 | 143 / 143,573 |
| UTF-8 588,906B | 一致 | 一致 | 458 / 593,944 |
| UTF-8 9,601B | 一致 | 一致 | 9 / 10,060 |
多バイト文字が行の境目で割れる件【事実】: UTF-8 588,906B では 458 行中 318 行（約 69%）が文字の途中で終わる。直結(node-pty の onData)でも 2005 チャンク中 1317 が途中終わり。行ごとに文字列へ変換して連結した結果は全体と不一致（`perChunkStringDecodeEqualsWhole:false`）、ストリーミングデコード（TextDecoder stream）や Uint8Array のまま書けば一致。xterm.js に 9,601B 版を (A) 全体 (B) 行ごと Uint8Array (C) 行ごと文字列にして書いた画面テキスト: B は A と一致、C は不一致（U+FFFD が 13 個）。→ `%output` は Buffer のまま xterm.js に `write(Uint8Array)` すれば安全、行ごとに文字列化してはいけない。
`%output` の最大 1 行は 2,730 バイト（デコード後）。
生データ: `c6.json`（`c6.out.txt`）

## C7 大量出力 10MB: ○（速度は遅い。pause-after は取りこぼしあり）
方法: pane（raw）が 10 MiB（64B 行の ASCII、`big`）と 10 MiB の乱数バイト(`bigbin`)を 64KB ずつ書く。受信側が 10 MiB に達するまでの時間（開始合図→最終到着）、sha256。
| 条件 | 所要 ms | sha256 | 回線上バイト | イベント |
|---|---|---|---|---|
| 直結 big | 145, 150（2 回） | 一致 | - | - |
| control big（既定） | 469, 473 | 一致 | 11.5MB | `%output` 7,0〜7,5 千行 |
| 直結 bigbin | 130, 141 | 一致 | - | - |
| control bigbin（既定） | 3957, 2367 | 一致 | 14.7MB（約 1.4 倍） | `%output` 約 7 千行 |
| control big + `pause-after=1`（消費者は普通に読む） | 470, 445 | 一致 | 11.6MB | `%extended-output` 7,1〜7,6 千行、`%pause` 0 回、age 最大 1〜2 |
| control bigbin + `pause-after=1` | 2843 | 一致 | 14.8MB | `%extended-output` 7,000 行、age 最大 6 |
| control big 既定 + 消費者を 4 秒止める | 4167, 4616 | 一致 | 11.6MB | `%output` 約 16.9 千行。tmux が溜めて全部送る（遅れて全量届く） |
| control big + `pause-after=1` + 消費者を 4 秒または 10 秒止める | 完了せず | 不一致 | 約 129KB | `%pause %0` 1 回 → `refresh-client -A '%0:continue'` を送ると `%continue %0` が来るが、届いた総量は 116,736〜118,784 バイトで頭打ち |
【事実】`%pause` 中に pane が出した出力は、その client へは届かない。再開後も欠けたまま（`c7dbg.mjs` で書き手は約 371ms で 10MB を書き終えており、`%continue` の後に残りは来なかった）。したがって pause-after を使う場合、`%pause`→`continue` の後に `capture-pane -e -S -` で画面を取り直す再同期が必須（その再同期の正しさは未測定）。
【事実】`refresh-client -A %0:continue` と書くとパーサーが `%` を指令と解釈し `parse error: syntax error`。`'%0:continue'` と引用符が必要。
【事実】既定（pause-after なし）は、消費者が止まっても tmux 側に溜めて全量を送る（欠けない）。メモリ使用量は未測定。
【未確認】tmux が溜めるバッファの上限・メモリ。`bigbin` の control 時間が 2.4〜4.0 秒とばらつく原因。
生データ: `c7.json`（= `c7-main.json`、2 回目の全件実行）、`c7.out.txt`（1 回目含む）、`c7b.json` / `c7b.out.txt`（pause 追試）

## C8 本物の claude: △（起動画面は同等、文字列の細部は起動ごとに揺れる）
方法: 信頼済みの使い捨てディレクトリ（`~/.claude.json` で信頼済みを確認）で `claude`（2.1.296）を起動し、プロンプトは送らない（トークン消費なし）。9 秒待って出力を xterm.js(120x30) に書き画面テキスト・カーソル・モードを直結と比較。その後 `/` を送る→Esc→`/`→Esc で、キー送信から最初の出力バイトが来るまでの時間を測る。`CLAUDE_CODE*` 環境変数は両方とも除去。
【事実】最初の試行は信頼確認ダイアログのディレクトリ（`c8work`）を使ったため、Esc でダイアログが閉じて claude が終了した（本物の画面ではない）。この結果は採用しない。信頼済みディレクトリで以降を実施。
| 試行 | 起動画面の差 | 終了時画面の差 |
|---|---|---|
| 直結 vs control（env 除去、run1: `c8-envclean-run1.json`） | 4 行差（ヒント文 `Try "..."` が別文面、control が 1 秒遅れて起動し下 2 行が未描画、カーソル・モード不一致） | 差なし |
| 直結 vs control（env 除去、run2: `c8.json`） | 1 行差（ヒント文 `Try "fix lint errors"` と `Try "write a test for <filepath>"`）、カーソル・モードは一致 | 差なし |
| 直結 vs 直結（基準: `c8base.json`） | 1 行差（同じヒント文のランダム差）、カーソル・モード一致 | 差なし |
| 直結 vs control（env 未除去、`c8-main.json`） | 6 行差（下部の行が 1 行ずれ、`⚠ Transcript saving is off … CLAUDE_CODE_CHILD_SESSION` の行が direct にのみある、`· ← for agents`） | 差あり（Esc again to clear の位置が 1 行ずれ） |
【事実】1 行差はヒント文の乱数のみで、直結同士でも同じ差が出る。env 未除去の差は継承された環境変数 `CLAUDE_CODE_CHILD_SESSION` による警告行で、control mode が原因ではない根拠は env 除去後に消えたこと（因果の完全な確定は未確認）。run1 は control の起動が遅かった（`/` の遅延が 1939ms）ため途中画面と比較した可能性がある【未確認】。
Esc 後の最初の出力までの時間（キー送信→最初の出力バイト, ms）:
| 方式 | `/` | Esc(1 回目) | Esc(2 回目) |
|---|---|---|---|
| 直結 run1/run2 | 2 / 2 | 58 / 68 | 61 / 54 |
| control run1/run2 | 1939 / 4 | 899 / 93 | 60 / 58 |
| 直結(基準) | 1 | 72 | 61 |
【事実】run2 は直結 54〜68ms、control 58〜93ms で同程度（claude 自身の再描画時間が支配的）。run1 の control の 899ms と `/` の 1939ms は、claude の起動がまだ終わっていなかった時期の値で、安定後の値ではない。
【未確認】画面が反応する時間の厳密比較（claude の起動直後の揺れを除くには起動完了の検出が必要）。
生データ: `c8.json`、`c8-envclean-run1.json`、`c8base.json`、`c8-main.json`、`c8.out.txt`

## まとめ（事実のみ）
| 項目 | 結果 | control mode で直結と違うところ |
|---|---|---|
| C1 キー | ○ | 遅延は同程度（最大 6ms） |
| C2 貼り付け | ○ | 1 コマンド 9,780 バイトまで。64KB は 500〜1000B に分割して約 250〜300ms（直結 15ms） |
| C3 マウス | ○ | 差なし |
| C4 リサイズ | △ | 反映は同じ。連続操作は約 250ms に間引かれ、直近 250ms 以内の変更は 100〜280ms 遅れる |
| C5 モード復元 | ○ | フォーカス報告(1004)の状態だけ変数で取れない。他は取れる。alt-screen 中は `capture-pane -a` で通常画面も先に復元が必要 |
| C6 エスケープ復元 | ○ | `%output` は Uint8Array のまま書く（行単位の文字列化は文字化け） |
| C7 大量出力 | ○ | 10MB が約 470ms（直結 150ms）、乱数バイトは 2.4〜4.0 秒（直結 130ms）。pause-after は停止中の出力が欠ける |
| C8 本物の claude | △ | 起動画面は直結同士の揺れの範囲。Esc 反応は安定時 58〜93ms |

## 再現コマンド
`node scripts/c1.mjs` ～ `c8.mjs`（`c7.mjs` は `ONLY=pa` で pause 追試、`c7dbg.mjs` は `STALL=4000`）。出力先は `/tmp/CC報告ファイル/keep-sessions/step0c/` 直下。
