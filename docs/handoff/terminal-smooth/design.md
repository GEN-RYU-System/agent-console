# 端末の表示をターミナル並みに滑らかにする — 便0 測定の設計

- 状態: 設計案（Opus 作成・自己審査済み・2026-11-27）。PO 決定: 2026-11-27「1」（先に測る）。
- 枝: release/terminal-smooth-measure（origin/main 6839691 = v0.56.0 起点）
- 表記: 【事実】コマンド出力・ファイルで確認済み／【推測】根拠からの考え／【未確認】

## 1. 目的（PO の言葉）

「表示がカクカクしていて昔のPCみたいに重たい」「ターミナルは滑らかに動いている」「ターミナルと差分がない滑らかさが実現したい」（2026-11-27）。

KGI（最終の判定。便0では測らない）: PO が同じ操作（打鍵・スクロール・Claude の返事の流れ）を Terminal.app と agent-console で見比べ、「差が分からない」と言う（○×）。

便0 の目的: 画面が届くまでの中継のどこで「途中の絵」と「待ち」が生まれるかを数で示し、直す場所を1つに決める。製品のコードは変えない。

## 2. 現在地（recon）

- 【事実】中継の数: Terminal.app は Claude → Terminal の2段。agent-console は Claude → tmux 3.8（`-C attach-session` の制御モード）→ サーバー（`server/terminal-host/tmux-terminal.ts:113-137` で `%output` を読み `server/sessions.ts:36-41` で ws.send）→ Chrome → xterm.js 6.0.0 + WebGL（`src/components/TerminalPane/TerminalPane.tsx:164-172`, `:279-280` で term.write）。
- 【事実】環境の違い（ps eww、2026-11-27 11:40）: Terminal の Claude は `TERM=xterm-256color TERM_PROGRAM=Apple_Terminal`、agent-console の Claude 13個はすべて `TERM=tmux-256color TERM_PROGRAM=tmux TMUX=/private/tmp/tmux-501/agent-console`。両方とも `~/.claude/settings.json:643 "tui": "fullscreen"`。
- 【事実】Claude 2.1.332 の中身（strings 抜き出し、/tmp/CC報告ファイル/ac-smooth/claude-sync2.txt）: TMUX があると (a) 画面の同期描き（DEC 2026）の判定が tmux の返事待ちになる（`if(s.TMUX&&...synchronizedOutput").state==="pending")return`）、(b) `s.TMUX?1024:0` という 1024 バイトの区切り値を持つ、(c) tmux の性質表に `syncRedrawsEverything:!0` がある。これらが実際の出力の小分け・同期の有無にどう効くかは【未確認】。
- 【事実】サーバーは `%output` を1行受けるごとにそのまま ws.send する（まとめ直さない）。xterm.js はそれを受けた順に描く。
- 【事実】Mac の負荷（11:36）: load 15.0（8コア）、交換領域 8239/9216MB、kernel_task 111%。agent-console の窓13個のうち12個は 11/26 03:30 から動きなし。Terminal は同じ負荷で滑らか（PO 申告）。
- 【事実】過去: 10/16 のホイール調査（~/CC報告ファイル-keep/ac-webgl/scroll-decision.md）は「主因は Claude 側の描き直し」として変更なし。ただし Terminal.app との比較はしていない。WebGL 化（v0.39.0）で入力の遅れは 101→37ms に改善済み。
- 既存 ADR・設計: docs/handoff/terminal-webgl/design.md、docs/handoff/terminal-wheel/design.md、docs/handoff/keep-sessions/step0.md（tmux 設定の理由）。今回の測定はこれらを変えない。

## 3. 対象と対象外

- 対象: 測定の道具（新規 `scripts/measure-smooth/` 配下）と結果の文書（本フォルダ `evidence/`）。
- 対象外: `src/`・`server/`・`ops/`・設定・本番の agent-console・PO の窓13個。Chrome での描画の測定（便0b、必要なら PO の許可を取って Mac で行う）。

## 4. 測り方

### 4-1 2つの道（同じ Claude・同じ会話・同じ操作）

- 道A（tmux なし）: node-pty で Claude を直接起動し、出力を @xterm/headless 6.0.0 に流す。headless が返す端末の返事（onData）は pty に書き戻す（Claude の問い合わせに答えるため）。`TERM=xterm-256color`、TMUX なし。＝「tmux を外した agent-console」に当たる。
- 道B（今の agent-console）: 試験用ソケット `-L ac-smooth-test` と `ops/tmux/agent-console.tmux.conf` で tmux を起こし、`server/terminal-host/tmux-terminal.ts:51` の TmuxControlTerminal（本物の部品。`npx tsc -p tsconfig.server.json` で作る dist-server 版を使う。画面側の組み立て `npm run build` は色の値の取り込みが要り測定に関係しないので流さない）と `server/terminal-host/tmux-runner.ts:82` の newSessionでつなぐ。onData の塊を headless に流す。返事の書き戻しは本物と同じ道（TmuxTerminal の書き込み）。
- 端末の大きさは両方 120 列 × 40 行。

### 4-2 Claude の準備（返事を作らせない操作はお金がかからない）

- 試験用フォルダに合成の会話記録（利用者と Claude の発言 60 往復・各 5〜15 行）を置き、`claude --resume <id>` で開く（10/16 の scroll2 と同じやり方）。
- 起動後、画面が落ち着く（500ms 何も来ない）まで待ってから測る。

### 4-3 操作（各道 5 回、A と B を交互に）

- O1 打鍵: 入力欄に「あいうえおabcde」を 40 文字、80ms おきに 1 文字ずつ送る。
- O2 スクロール: SGR のホイール信号（上向き）を 30 回、33ms おきに送る。その後下向き 30 回。
- O3 返事の流れ（任意・1 回だけ）: 「1から40まで1行ずつ数字だけ書いて」を送り、返事が終わるまで。--model sonnet。ログインできない場合は飛ばして理由を書く。

### 4-4 記録（塊ごと）

時刻（ms・performance.now）、バイト数、`ESC[?2026h` と `ESC[?2026l` の数、どの操作の何番目の入力の後か。

### 4-5 数え方（1回の更新 = 入力1つの後、50ms 何も来ないまでの塊）

| 指標 | 意味 |
|---|---|
| U1 塊の数 | 1回の更新が何個に分かれて届くか（p50/p90） |
| U2 広がり | 最初の塊から最後の塊までの ms（p50/p90） |
| U3 同期の割合 | 更新のうち、全部の塊が 2026h〜2026l の中にあった割合 |
| U4 途中の絵 | 同期の外で、次の塊まで 8ms 以上空いた塊の数（画面に途中の絵として出うる回数）の合計 |
| U5 入力→最後の塊 | ms（p50/p90） |
| U6 バイト数 | 1回の更新のバイト数（p50） |

忠実度: G1 各回の最後の画面の文字（headless の buffer 全行）が A と B で一致する。一致しない回は数えず理由を書く。G2 1回の測定の間の load を記録する。

## 5. 判定（便0 の出口）

| 結果 | 意味 | 次の便 |
|---|---|---|
| B の U4 が A の 2 倍以上、または U3 が A より 30 ポイント以上低い | tmux を通すと途中の絵が増える | 便1: tmux の設定（同期描きを通す）を試す → 効かなければ tmux を通さない作り |
| U1〜U5 が A と B で 2 割以内 | tmux の層は主因でない | 便0b: Mac の Chrome で「受信→描画」を測る（PO 許可を取る） |
| それ以外 | 判断できない | 表を PO に見せ、Opus が次を決める |

## 6. 受入条件

| 基準 | 検証方法 |
|---|---|
| K1 道A・道B で O1・O2 を各5回測り、U1〜U6 の表がある | evidence/result.md の表 |
| K2 G1 の一致が各道・各操作 4/5 回以上 | evidence/result.md の忠実度の欄 |
| K3 製品のコードに差分が無い | `git diff origin/main --stat -- src server ops agent-console.config.json` が空 |
| K4 生データが残っている | evidence/raw/*.jsonl（塊ごと1行） |
| K5 試験用 tmux を片付けた | `tmux -L ac-smooth-test ls` が「no server」 |

## 7. 実行場所

- クラウド（Linux）で行う（PO 2026-11-02「試験はMacで回さずクラウドで」）。Mac の負荷とは切り離される。違いは Mac の値ではないこと（表に明記する）。比べるのは A と B の差なので、場所の違いは両方に同じく効く【推測】。
- 要るもの: node 24 以上（package.json:6 engines）、tmux 3.4 以上、claude CLI（ログイン済み）。無ければ BLOCKED で止める。

## 8. 危険と対処

- Claude が --resume の合成会話を読まない → 読み込みの画面の文字を記録して止める。
- 道B で TmuxControlTerminal を外から使えない（輸出されていない等）→ 同じ手順（`tmux -C attach-session` を spawn し `%output` を tmux-protocol.js の parser で読む）で代える。代えたことを書く。
- 道A の headless の返事が Claude の判定を変える（Terminal.app と同じではない）→ 便0 は「tmux の有無」の差を測るもの。Terminal.app そのものとの比較は便0b で行う。

## 9. 外部事例

- 該当事例は使わない。理由: 今回は自分たちの部品（tmux 3.8 と xterm.js 6.0.0 と Claude 2.1.332）の組み合わせでの差を測るもので、他社の数字はこの判定の根拠にならない。

## 10. 維持

- 測定の道具は `scripts/measure-smooth/` に残す。便1 の後に同じ道具で測り直す（変更の前後を同じ物差しで測る）。

## 11. 自己審査（Opus・同一AIの自己審査）

判定: APPROVE（測定のみ・製品変更なし）。
- 根拠: 製品の部品（TmuxTerminal・tmux 設定）をそのまま使い、差を作る要素を「tmux の有無」1つに絞っている。受入条件はすべてファイルかコマンドで判定できる。
- 未解決: クラウドで claude にログインできるか【未確認】→ §7 で止める条件にした。Chrome の描画の層は便0b に分けた。
