# 工程0b 追加測定: R1（スクロール）と R3（Esc の遅れ）の原因切り分け

日付 2026-10-13。製品コードは触っていない。生データと道具は `/tmp/CC報告ファイル/keep-sessions/step0b/`（`scripts/` に道具）。試験用ソケットは `acstep0b*` のみ使い、終了後に個別 rm 済み（`/private/tmp/tmux-501/` は `default` のみ残る）。tmux 3.8、xterm.js 6.0.0（step0 の rig.mjs と同じ試験台を `scripts/rig2.mjs` に複製して拡張）。

## R3: Esc が 639ms 遅れる原因 = 特定できた

### 原因（事実）
tmux のサーバーログ（`tmux -vv`）に、Esc 1 byte を受け取った直後 `partial key \033` → `increasing delay (active query)` が出て、約 575ms 後に `complete key \033` になる（scratchpad の vv ログ。再現: `scripts/esc.mjs`）。tmux 3.8 の `tty-keys.c:1002-1009` は、次のどれかが成り立つ間は escape-time を 500ms 以上に引き上げる:
`TTY_WAITFG|TTY_WAITBG`、`TTY_OSC52QUERY|TTY_WINSIZEQUERY`、`TTY_HAVEDA|HAVEDA2|HAVEXDA|HAVESYNC` が揃っていない、`input_requests` が空でない。
escape-time 0 でもこの下限 500ms が掛かる。`show -sv escape-time` の実値は 0（設定は反映済み。原因ではない）。

実際に残っていた条件（事実）:
1. `TTY_WINSIZEQUERY`: tmux は attach 時に `\e[18t\e[14t` を外側へ送る（pty の ws_xpixel/ypixel が 0 のとき。`tty.c:145-150`。node-pty 1.1.0 は pixel を常に 0 にする: `pty.cc:304-305,476-477,519-520`）。この旗は 14t への応答（`\e[4;高さ;幅t`）でだけ下りる（`tty-keys.c:728-733`）。xterm.js は既定でこの 2 つに答えない（`windowOptions` 既定は無効）。タイマーでは下りない。
2. `TTY_HAVEXDA`: `\e[>q`（XTVERSION）に xterm.js は答えない。こちらは attach から 5 秒（`TTY_QUERY_TIMEOUT`、`tty.c:85,308-323`）で start timer が旗を立てるので、最初の 5 秒だけ効く。

### 実測（Esc 単体を送ってから pane に 1b が届くまで、ms）
| 条件 | 最小 | 中央値 | 最大 | 生データ |
|---|---|---|---|---|
| direct（step0 の rig） | 1 | 2 | 6 | r3-direct.json |
| tmux・現状の設定・xterm.js 既定（再現） | 505 | 565 | 578 | r3-xterm-default.json |
| tmux・xterm.js に `windowOptions:{getWinSizePixels:true,getWinSizeChars:true}` のみ | 7 | 553 | 579 | r3-xterm-winopts.json（10 回中 5 回は 7〜20、5 回は 553〜579。遅い 5 回は attach 後 5 秒未満＝XDA 未応答の間） |
| 上記 + `\e[>q` にサーバー側で `\eP>|xterm.js(6.0.0)\e\\` と返す（rig の XDA_REPLY=1） | 4 | 6 | 8 | r3-xterm-winopts-xda.json |

pty 直結の node-pty 試験（`scripts/esc.mjs`、12 回）での切り分け:
- 設定の変更（extended-keys off / unbind なし / prefix なし / smcup 上書きなし / 最小設定 `escape-time 0` のみ）: どれも中央値 567〜584ms。設定行は原因ではない。
- DA1・DA2・XDA・DECRQM 2026・OSC10/11・996 に答えるだけ（18t/14t に答えない）: 中央値 552〜566ms。
- 上に加えて 18t/14t に答える: 全 12 回 2〜6ms（中央値 5）。
- 18t/14t だけ答える（他は未応答）: 最初の 5 回が 549〜576、5 秒後から 4〜6ms。
- tmux 側の別案: control mode（`tmux -C`）で `send-keys -t %0 -H 1b`: 12 回で 0〜3ms（中央値 0、届いたバイトは `1b`。`scripts/ctrlesc.mjs`）。この経路は外側の端末の key 解析を通らない。

### 合格に届く方法（測定値で）
アプリ側（xterm.js / サーバー）で、tmux の問い合わせに答える: ①xterm.js の `windowOptions` で 18t/14t を有効にする（これは必須）、②`\e[>q` に XTVERSION を返す（無いと attach 後 5 秒は遅い）。両方で tmux 経由の Esc は中央値 6ms（direct 2ms）。もう 1 つは control mode 経由で入力する案（0ms）。
【未確認】本物の claude を載せた Esc の測定は未実施（道具は rig の plain シナリオ。claude 本体は重いので省略。tmux 側の遅れはクライアント端末への入力解析で決まり、pane 内のプログラムに依らないことはログで確認）。【未確認】`extended-keys`／`focus-events` の影響は、上の設定切り分けでは差が出なかった（extended-keys on/off とも同じ）。focus-events は未測定。

## R1: まとめて出た出力がスクロールバックに入らない = 原因特定、attach 方式では解消せず、別方式で合格

### 測り方
step0 と同じ（burst 300 行、ホイール -300、全選択）。ただし step0 の `scroll` は pane の node 起動と attach が競走するので、attach 後 2.5 秒で 300 行を 1 回で書く `scrolllate`（`scripts/inner2.mjs`）も使った。direct と tmux の両方で同じ。

### 原因（事実）
- 外側（xterm.js）に届いた生出力を数えた: tmux 経由は `line N` が 123 回、重複を除くと 101 行（74〜103 と 167〜300 など）。direct は 300 行すべて（r1-late-tmux.raw.txt / r1-late-direct.raw.txt）。tmux は届ける途中に `\e[30S`（スクロールアップ）と画面の描き直しを 3 回出している。
- tmux のソース（3.8）`screen-write.c:2284-2307`: 1 回の flush で溜まったスクロール行数 `ctx->scrolled` を領域の高さ（30）で頭打ちにして 1 つの scrollup として送る。つまり一度に 30 行を超えて流れた分は、外側の端末へそもそも送られない。tmux の仕様で、設定項目は無い。
- よって「外側のスクロールバックに行が残る tmux 設定」は無い。

### attach 方式で設定を変えた結果（scrolllate、300 行。length は xterm.js の buffer.length）
| 設定 | length | ホイール後 viewportY | 先頭行 `line 1` が全選択に入る |
|---|---|---|---|
| direct | 302 | 269 | true（2604 文字） |
| 現状（smcup@:rmcup@） | 30 | 0 | false |
| smcup 上書きなし（`*:smcup@:rmcup@` を外す） | 30 | 0 | false |
| alternate-screen off | 30 | 0 | false |
| history-limit 50000 | 30 | 0 | false |
| terminal-overrides に Tc 追加 | 30 | 0 | false |
| default-terminal screen-256color | 30 | 0 | false |
| window-size manual 他 5 項目 | 30 | 0 | false |
（生データ r1-late-*.json）

### 代替の測定（実装ではなく成立するかだけ）
| 方式 | length | ホイール後 viewportY | `line 1` | 1〜300 が順に並ぶ | 生データ |
|---|---|---|---|---|---|
| control mode（`tmux -C attach`）の `%output` を xterm.js に書く（attach 前に起動した出力を live で受ける） | 302 | 269 | true（2604 文字） | 300/300 | r1-ctrl-live.json |
| 出力の後で attach し `capture-pane -p -e -J -S -` を先入れ（初期表示） | 303 | 270 | true（2605 文字） | 300/300 | r1-replay.json |
| control mode で出力の後に attach（先入れなし） | 30 | 0 | false | 0 | r1-ctrl-late-attach.json |
| control mode で attach → 同じ接続で capture-pane（出力の後）→ 以降 %output | 302 | 269 | true | 300/300 | r1-hybrid-after.json |
| 同（capture が空の画面のとき、burst は attach 後） | 331 | 298 | true | 300/300 | r1-hybrid-before.json |
- direct と同値（302/269/2604）。control mode では tmux が外側の端末を描く部分を通らず、pane が書いた生のバイトが `%output` で来るため、行が欠けない。
- 先入れは 303 行を 54ms で取得（captureMs=54）。
- hybrid-before は、空の画面を先入れしたせいで先頭に空行 30 行が入る（length が 30 増える）。見た目だけの差で、先入れ時に空行を除けば消せる【推測】。

### 合格に届く方法（測定値で）
attach 方式（今の step0 の作り）では届かない（上の表）。control mode で出力を受け、先入れを `capture-pane -e -S -` にする方式は、burst 300 行で direct と同値（302/269/true/300 行順）。
【未確認】control mode にすると、入力（キー・貼り付け・マウス）、リサイズ、`%output` のエスケープ復元、mouse/bracketed-paste/alt-screen のモード復元（`capture-pane` はモードを持ち越さない。tmux のフォーマット変数で取れるかは未測定）が別の設計と実測になる。この測定は出力側とEscのみ。

## 再現コマンド
- `scripts/esc.mjs <direct|tmux> <名前> [conf]`（環境変数 REPLY=none|xterm|winsz|all）
- `scripts/rig2.mjs`（step0 の rig.mjs に TERMOPTS・WAIT・N・INNER2・AC_CONF 環境変数を足した複製）
- `scripts/r1run.sh <名前> <direct|tmux> scrolllate [conf]`、`scripts/ctrl.mjs <live|replay|hybrid> <out.json>`、`scripts/ctrlesc.mjs`
