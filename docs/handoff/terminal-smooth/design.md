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
- 最初の起動の準備（2026-11-27 追記。2回目の実行で初回の設定画面「Choose the text style」で止まったため。evidence/blocked.txt）: 測る前に1回だけ、道A で `claude` を起動し、初回の画面（文字スタイル・注意書き・フォルダの信頼）で Enter を押して既定の選択のまま進む。押すのは最大6回。1回押すごとに画面の文字を evidence/warmup.txt に足す。ログイン・ログアウト・アカウントに関わる画面が出たら押さずに BLOCKED。6回で入力欄に着かなければ BLOCKED。終わったら `claude` を閉じる。これはクラウドの使い捨ての機械の上だけの準備で、PO の Mac には関係しない。
  - フォルダの信頼の画面（2026-11-27 追記。3回目で既定が「No, exit」と分かった。evidence/warmup.txt 画面2）: 表示されたフォルダが測定専用の `/tmp/measure-smooth-cwd` のときだけ、下矢印1回で「Yes, I trust this folder」を選んで Enter。別のフォルダが出たら押さずに BLOCKED。道B の tmux の中でも同じ画面が出たら同じ扱い。
- 起動後、画面が落ち着く（500ms 何も来ない）まで待ってから測る。

### 4-3 操作（各道 5 回、A と B を交互に）

- O1 打鍵: 入力欄に「あいうえおabcde」を 40 文字、80ms おきに 1 文字ずつ送る。
- O2 スクロール: SGR のホイール信号（上向き）を 30 回、33ms おきに送る。その後下向き 30 回。
- O3 返事の流れ（任意・1 回だけ）: 「1から40まで1行ずつ数字だけ書いて」を送り、返事が終わるまで。--model sonnet。ログインできない場合は飛ばして理由を書く。

### 4-4 記録（塊ごと）

時刻（ms・performance.now）、バイト数、`ESC[?2026h` と `ESC[?2026l` の数、どの操作の何番目の入力の後か。

- 生データの置き方（2026-11-27 追記。4回目で試し1回分を `rm` で消そうとして安全確認に止められた）: evidence/raw/ のファイルは消さない。本測定は同じ名前で上書きする（試し分は commit e471d97 に残っている）。summary.json も書き直す。

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

## 12. 便0 の結果と判定（Opus・2026-11-27）

- 結果の正本: evidence/result.md（クラウド Linux・load 0.1〜0.3。commit e128310）。
- 【事実】tmux を通しても、1回の更新の塊の数（U1）・広がり（U2）・途中の絵（U4）はほぼ同じ（O2 の U4: A 28・B 30）。差が出たのは O2 の入力→最後の塊（U5）だけで、p50 4.3→5.6ms・p90 13.1→16.2ms（増え方 +1.3ms・+3.1ms。画面の1こま 16.7ms より小さい）。
- 【事実】同期描き（2026h/l）は A・B とも0回。tmux の中かどうかで同期の有無は変わっていない。§2 の (a)〜(c) の仮説（tmux の中だと同期を使わず途中の絵が増える）は、この測定では当たらなかった。
- 【事実】G1 は 0/5（K2 ×）。差は最下行の注意書き1行（道A だけ「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」が出て、画面全体が1行ずれる）。測定役の Claude の環境変数を道A が引き継いだための差で、会話の本体の行はずらすと一致する。O2 の2回は1行目も違う（スクロール位置の1行差）。【推測】描き方の差ではなく起動環境の差。
- 判定: §5 の行3（「それ以外」。O2 の U5 だけが2割を超えたため）。Opus の判断: 差は ms 単位で1こまに満たないため、tmux の層は主因でない（行2 と同じ扱い）として 便0b（Mac の Chrome で「受信→描画」を測る）へ進む。便0b は PO の Mac で動かすため PO の許可を取る。
- 限界: クラウドは負荷がほぼ無い。PO の Mac（load 15・交換領域 8.2GB）で tmux の層が重くなるかはこの測定では分からない【未確認】。便0b で Mac の上の各段を測るときに併せて見る。

## 13. 便0b の結果（Opus・2026-11-27・PO「1」で Mac の上で測定）

- 何を: PO が使っている v0.56.0 の組み立て済みのもの（`~/Library/Application Support/agent-console/versions/v0.56.0`）を、別のポート 4395・別の tmux（`-L ac-smooth0b-test`）・別の dataDir で起動。Playwright の Chrome（headed・WebGL・1400×900・dpr2）で、合成会話を `claude --resume` した画面をホイールで動かした。PO の窓（ポート 4319）には触れていない。測定道具は 10/16 の scroll2 の写し（evidence/bin0b/scripts/）。
- 生データ: evidence/bin0b/claude-raw.json、集計: evidence/bin0b/summary.md（10/16 の v0.39.0 の同じ測定と並べた）。
- 測定中の Mac: load 16〜28、CPU 99%、メモリ 71%、ディスク 94%（アプリ画面の表示）。

| 組 | 回 | 描画間隔 p50/p90/max ms | 33ms超の描画間隔 | Chrome のこま（rAF）間隔 p90/max | rAF 33ms超 |
|---|---|---|---|---|---|
| 何もしない 10秒 | 2 | - | - | 18.3/68.6 | 7/1197 |
| 1ノッチ（6行） | 8 | 15.6/30.6/32.3 | 0 | 18.2/18.8 | 0/726 |
| 30ノッチ連続 | 4 | 18.1/52.1/417.4 | 61 | 18.2/33.4 | 1/699 |
| （10/16 v0.39.0）30ノッチ連続 | 4 | 38.7/249.9/1183.0 | 23 | 32.7/50.2 | 49/629 |

- 【事実】Chrome のこま送り（rAF）は、重い Mac の上でもスクロール中もほぼ 60 こま/秒で回っている（30ノッチで 33ms 超は 699 中 1）。Chrome の描く力は足りている。
- 【事実】それでも端末の描き直しは 30ノッチで 33ms 超の間が 61 回、最大 417ms 空く。描画は受信のあとにしか起きないので、間が空くのは「データが届かない」間。
- 【事実】1ノッチ（6行）の受信は 77 通（10/16 は 12 通）。1回の描き直しが細かい通に分かれて届く。描画は 3 回にまとまっている。
- 【推測】カクつきの元は Chrome の描画ではなく、届くまでの側（Claude の描き直しの速さ、または Mac の上の中継）。便0 で tmux の差は小さかった（負荷の無いクラウド）。重い Mac の上で Claude 本体の描き直しが遅れているか、中継が遅れているかは、この測定では分けられない【未確認】。
- 【未確認】PO の Terminal.app で Claude が同じ「全画面の描き直し」方式で動いているか（Terminal.app のスクロールが手元の履歴を動かすだけなら、Claude の描き直しを待たないので滑らかに見える）。
- 次の候補: (a) Mac の上で、試験用の写しのサーバーに受け取り時刻の記録を足し、「Claude が出した時刻→ブラウザが受けた時刻」を分ける。(b) Terminal.app で Claude がどの方式で動いているかを確かめる。どちらも製品のコードは変えない。

## 14. 便0c の結果（2026-11-27、PO の Mac、試験用の写しに時刻の記録を足して測定）

- 対象: v0.56.0 の dist-server を /tmp に写し、`terminal-host/tmux-terminal.js` だけに時刻の記録を足した（差分: evidence/bin0c/trace-patch.diff）。製品・PO の窓・ポート 4319 は触っていない。試験ポート 4395、tmux ソケット ac-smooth0b-test。合成会話を `claude --resume`。
- 記録した時刻: W＝サーバーが入力を tmux へ送った時、C＝tmux からの返りを受けた時、O＝画面の出力をブラウザへ送る直前。ブラウザ側は従来どおり送信・受信・描画（壁時計に直して突き合わせ）。
- 生データ: evidence/bin0c/（trace.txt、claude-raw.json、stages.md、gaps2.txt、summary.md）。集計: scripts/stages.mjs、scripts/gaps2.mjs。

| 組 | 送信→サーバー受け p50/p90 ms | サーバー送り→ブラウザ受け p50/p90/max ms | ブラウザ受けの 33ms 超の間 / 最大 | 描画の 33ms 超の間 / 最大 |
|---|---|---|---|---|
| 1行（A） | 1.0/3.4 | 0.6/2.9/3.1 | 3 / 598 | 4 / 586 |
| 1ノッチ（B） | 0.8/2.7 | 0.5/2.7/8.5 | 5 / 81 | 5 / 81 |
| 30ノッチ（C） | 0.3/2.7 | 0.4/1.2/53.7 | 10 / 533 | 46 / 610 |

- 【事実】中継（ブラウザ→サーバー→tmux、サーバー→ブラウザ）は p90 で 3ms 以内。1フレーム（16.7ms）より小さい。
- 【事実】100ms を超える受信の間は、すべて同じ時刻にサーバーの送り（O）にも同じ長さの間がある（gaps2.txt: 30ノッチ1回目 O@645+534 と R@645+533、3回目 O@515+123 と R@516+123）。間はサーバーより手前（tmux の中の Claude が画面を出さない間）で生まれている。
- 【事実】30ノッチでは、受信が続いているのに描画が 100ms 超止まる間もある（1回目 D@84+368、3回目 D@284+200・D@557+212、4回目 D@651+101。同じ時刻に受信の間は無い）。描画1回あたりの受信は最大 223 通。rAF の 33ms 超は 695 回中 3 回。
- 【推測】カクつきの元は 2 つ。①Claude 本体が画面を出すのが止まる間（最大 0.5 秒）。中継のせいではない。②細かい通が大量に届くとき、ブラウザの端末が描き直しをまとめて遅らせる間（0.1〜0.4 秒）。
- 【未確認】②で描画が止まる理由（端末部品が受けた文字の読み取りに時間を取られているのか、画面の中身が変わらず描画の知らせが出ないだけか）。Terminal.app で同じ Claude を同じように回したときに①の止まりが出るか。
- 次の候補: (a) Terminal.app で同じ合成会話を開き、同じ 30ノッチを回して画面の録画で止まりを数える（①が Claude 本体の性質かを分ける）。(b) ブラウザで端末部品の読み取り時間を記録し、②の理由を分ける。どちらも製品のコードは変えない。

## 15. 便0d の結果（2026-11-27、PO の Mac、Claude だけを直接動かす）

- 方法: 端末の画面も tmux も agent-console も通さず、node-pty で `claude --resume`（合成会話）を 99×39 で起動。便0c で記録した送り時刻（1ノッチ 8 回、30ノッチ 4 回）をそのまま再現して、ホイールの信号（SGR、64＝上・65＝下）を直接送り、Claude の出力の塊の時刻を記録。起動は PO の許可（permit-danger "local agent"、2026-11-27 07:11Z 発行）の下で 1 回。
- 生データ: evidence/bin0d/（direct-raw.json、direct-sum.md、load-before.txt）。

| 組 | 回 | 出力の間 p50/p90 ms | 33ms 超の間 | 100ms 超の間 | 最大 ms | 比べ: 便0c の サーバー送り(O)の 100ms 超の間 / 最大 |
|---|---|---|---|---|---|---|
| 1ノッチ | 8 | 0.2/17.3 | 0 | 0 | 22 | 0 / 82 |
| 30ノッチ | 4 | 0.1/11.2 | 3 | 0 | 47 | 3 / 534 |

- 【事実】Claude を直接動かすと、30ノッチでも出力が 100ms 以上止まる間は 0 回。最大 47ms。
- 【事実】Claude は直接動かしても、全画面に切り替え（`?1049h`）、マウスの動きを全部受ける（`?1003h` `?1006h`）。Terminal.app と同じ名乗り（TERM_PROGRAM=Apple_Terminal）でも同じ。ホイールは Claude が画面を描き直して応える方式。
- 【推測】便0c で見えた最大 0.5 秒の止まり（§14 の原因①）は Claude 本体ではなく、Claude と agent-console の間（tmux）で生まれている。ただし 4 回ずつで、便0c でも止まりは 4 回中 2 回だけ。同じ時間帯に交互に測っていない。
- 【未確認】tmux を通すと止まるか（同じ時間帯に、直接と tmux 経由を交互に回して比べる必要がある）。

## 16. 便0e の結果（2026-11-27 16:26〜16:30 JST、PO の Mac、同じ時間帯に交互）

- 方法: 「試験用の agent-console（tmux 経由、便0c と同じ）」→「Claude だけを直接（便0d と同じ。送り時刻はその直前の agent-console の回の記録を再現）」を 2 巡。tmux への打ち込みは agent-console 自身が行い、測る側は打ち込みの命令を書いていない（見張り consent-guard の tmux-inject は変えていない）。load は 13〜18。
- 生データ: evidence/bin0e/（ac1・ac2・direct1・direct2、all.md）。

30ノッチで「画面の出力が 100ms 以上止まった回」（agent-console はサーバーの送り O、直接は Claude の出力）:

| 測った回 | agent-console（tmux 経由） | Claude だけ（直接） |
|---|---|---|
| 便0c / 便0d | 4 回中 2 回（最大 534ms） | 4 回中 0 回（最大 47ms） |
| 便0e 1巡目 | 4 回中 1 回（254ms） | 4 回中 0 回（最大 64ms） |
| 便0e 2巡目 | 4 回中 2 回（522ms・240ms） | 4 回中 1 回（340ms）※ |
| 合計 | 12 回中 5 回 | 12 回中 1 回 |

- ※ direct2 は 1ノッチ 8 回すべてで Claude の出力が 0 バイト。その直後の 30ノッチ 1 回目だけが 18KB で止まりあり。Claude が起動の途中でホイールに応えていなかった見込み【推測】。この回を外すと直接は 11 回中 0 回。
- 【事実】止まりのあった agent-console の回は、出力の量が少ない回に寄っている（39KB・54KB・177KB・178KB。止まりの無い回は 192〜257KB）。
- 【事実】ブラウザの描画の 33ms 超の間は、30ノッチで 54〜56 回（便0c は 46 回）。原因②（受けは続くのに描画が止まる）は毎回出ている。
- 【推測】原因①（最大 0.5 秒の止まり）は tmux を通す道で起きやすい。ただし回数が少なく（12 回ずつ）、決め手ではない。tmux のどこで止まるか（tmux が描き直しをまとめるのか、Claude が tmux の中では違う動きをするのか）は【未確認】。

## 17. 便0f 原因②（受けは続くのに描画が止まる）の仕組み（2026-11-27 16:45〜16:51 JST、PO の Mac、試験用 agent-console v0.56.0 の写し）

- 方法: 便0c と同じ測り方に、ブラウザの中で次を足した（measure2〜4.mjs）。①受けた文の中の `ESC[?2026h`（絵の始まり）・`ESC[?2026l`（絵の終わり）の数 ②`term.write` が読み終わった時刻と、その時点の xterm の同期中の印（`modes.synchronizedOutputMode`）③rAF ごとの同期中の印 ④長い処理（longtask）。3 回（run6・run7・run8）。load は 11〜20。生データ: evidence/bin0f/。
- 【事実】Claude は 1 枚の絵ごとに `?2026h … ?2026l` で囲んで送っている（30ノッチ 1 回で 85〜167 枚）。便0（クラウド Linux）では 0 回だった。
- 【事実】xterm 6.0.0 は同期中のあいだ描かない。描く番（rAF）が来ても、同期中なら行を貯めるだけで描かずに戻る（`lib/xterm.mjs` の `_renderRows`: `if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,i);return}`）。次に描くのは、絵の終わりで描き直しを頼み直した後の次の rAF。同期中が 1 秒続くと打ち切って描く。
- 【事実】run8: 出力が続く時間のうち 20.9% が同期中だった。同期中の 1 区間は p50 1.1ms・p90 3.6ms・最大 67.6ms（490 区間）。
- 【事実】run7・run8: 受けた文を読み終えるまで p90 0.2〜0.3ms（読む重さは原因ではない）。rAF の間は p90 17.5〜18.2ms で 33ms 超は 1〜2 回（ブラウザは止まっていない）。長い処理は 0 件。
- 【事実】run8: 絵を読み終えてから描くまで p50 8.2・p90 17.1・最大 92.5ms。描画の 33ms 超の間 43 回の長さは、ほとんどが 33・50・67ms（描く番 2〜4 回分）。
- 【推測】原因②の仕組み: 1 枚の絵が複数の受けに分かれて届き、そのすき間に描く番が来ると、その回は描かれない（描く番の約 2 割が同期中に当たる）。1 回飛ぶと間が 33ms になる。読む重さ・ブラウザの止まりではない。描く番の正確な時刻と xterm の描く番は同じではないため、1 回ずつの対応は【未確認】。
- 【未確認】絵が分かれて届く場所（Claude の書き方・tmux の %output の区切り・node の送り・WebSocket）と、Terminal.app が同期の印をどう扱うか。
- 直し方の候補（設計はまだ）: (a) サーバーで絵の終わりまで貯めてから 1 通で送る (b) ブラウザで絵の終わりまで貯めてから 1 回で xterm に渡す (c) xterm の同期の扱いを変える。どれも、測ってから 1 つずつ。

## 18. 便0g 見送りを xterm の中で直接数える＋「絵の終わりまで貯めて渡す」を試す（2026-11-27 17:12〜17:17 JST、PO の Mac、試験用 v0.56.0 の写し）

- 方法: measure5.mjs。xterm の描く番（`_renderService._renderRows`）を包み、呼ばれた時刻とその時の同期中の印を記録した（全 4 回で包みは成功 `rrOk=1`）。`AC_COALESCE=1` のときだけ、ブラウザで `term.write` の前に「`ESC[?2026h` から `ESC[?2026l` まで」を貯めて 1 回で渡す（終わりが 100ms 来なければ貯めた分を渡す）。サーバー側は `%output` 1 件ずつの長さと h・l の数を記録（tmux-terminal.traced.js）。貯めない回（base）と貯める回（co）を交互に 2 回ずつ。30ノッチ×上下×2 で 1 回あたり 4 場面。load 7〜15。生データ: evidence/bin0g/。
- 【事実】結果（sync-sum6.md・gap-nocall.md）:

| | base（今のまま）2 回 | co（貯めて渡す）2 回 |
|---|---|---|
| 描画の回数 | 527 | 590 |
| 描く番のうち同期中で見送った回 | 37 | 0 |
| 描画の 33ms 超の間 | 73 | 38 |
| うち中に見送りあり | 26 | 0 |
| うち描く番の呼び出しなし・新しい出力も読んでいない | 20 | 24 |
| うち描く番の呼び出しなし・出力は読んだ | 23 | 6 |
| うち呼び出しあり・見送りなし | 4 | 8 |

- 【事実】§17 の【推測】「描く番が同期中に当たると描かれない」は、xterm の中で直接確かめた（base で 37 回、その 26 回は 33ms 超の間の中）。「呼び出しなし・出力は読んだ」の 23 回は、途中までの絵を読んで同期中になり、描き直しの頼みが貯められただけの間（xterm の `refreshRows` は同期中なら頼まずに貯める）。貯めて渡すとこの 2 種は 49 → 6 に減った。
- 【事実】残る間の多く（co で 24/38）は、その間に新しい出力が 1 件も届いていない。Claude が次の絵を出していない間で、ブラウザ側では埋められない。
- 【事実】絵が分かれる場所: macOS の pty は、子が 1 回で書いた 5000 バイトを 1024・1024・1024・1024・904 の 5 回に分けて読ませた（pty-chunk.mjs、Darwin 25.3.0）。tmux から読んだ `%output` も、印を含む約 1100 件のうち約 1000 件で h と l の数が合わない。ブラウザの受けでも 1024 バイトちょうどが 1 回あたり約 400 件。よって分かれは tmux より手前（Claude → pty の読み）で起きており、tmux を外しても分かれる。
- 【未確認】Terminal.app の同期の印の扱い（直し方の判断には使わない。目標との比較は直した後に PO の目視で行う）。

## 19. 直し方の設計案（草案・PO 未承認・実装未着手）

- 目的: Claude の絵が途中で描く番に当たって 1 回分止まるのを無くす。PO に見える変化は、スクロール中の小さな引っかかりが約半分に減ること（§18 の 73 → 38）。
- 対象: agent-console `src/components/TerminalPane/TerminalPane.tsx:279-281`（origin/main v0.56.0 で確認）の `socket.onmessage` 内の `term.write`。対象外: サーバー（sessions・tmux）、xterm 本体、入力側、Claude の出し方。
- 変更前: 受けた文をそのまま `term.write(e.data)`。
- 変更後: 小さな純粋関数（例 `syncFrameCoalescer`、新規ファイル＋単体試験）を通す。受けた文の後ろに、閉じていない `ESC[?2026h` があれば、そこから後ろを手元に残し、前だけ渡す。`ESC[?2026l` が来たら残りと合わせて 1 回で渡す。100ms 来なければ残りを渡す（測った同期区間の最大は 67.6ms、§17）。文の末尾が `ESC[?2026h` の途中（例 `ESC[?20`）で切れているときも残す。つなぎ直し（`onopen` の `term.reset()`）と片付けのときは残りを捨ててタイマーを止める。
- 選んだ理由: 分かれは pty で起きており（§18）、サーバーで直すとリング・つなぎ直しの道にも手が入る。ブラウザは描く直前で 1 か所、§18 で効果を測った形そのもの。xterm を書き換える案は更新のたびに直し直しになる。
- 弊害と対処: 絵の途中の部分は最大 100ms 遅れて渡る。ただし今も同期中は描かれないため、見える遅れは増えない（同期が 100ms を超えて続くと、今は 1000ms 待ってから描くが、変更後は 100ms で途中を渡す）。印を使わない出力（シェル等）は今と同じに通す。
- 受入条件:

| 基準 | 検証方法 |
|---|---|
| 単体試験: 印なし・1 通で完結・2〜3 通に分かれる・印の途中で切れる・100ms で渡る・reset で捨てる の 6 例が通る | `npm test` |
| 30ノッチ 上下×2 を 今のまま／直した版 で交互に 2 回ずつ測り、同期中で見送った回が直した版で 0 | measure5.mjs の `rr`（試験用の写し） |
| 同じ測りで、描画の 33ms 超の間が直した版で今のままの 6 割以下 | sync-sum6.mjs |
| 打った字が画面に出るまで（便0c の入力→描画）の p90 が今のままより 10ms 以上悪くならない | 便0c と同じ測り |
| PO が本番の agent-console でスクロールして、引っかかりが減ったと目視で ○ | PO の目視 |

- 維持: 単体試験が CI で毎回走る。xterm を上げるときは `_renderRows` の同期の扱いを読み直す（便0g の measure5 で再測定できる）。
- 戻し方: その 1 か所を `term.write(e.data)` に戻す 1 コミットの取り消し。

### 19.1 設計審査（同一 AI の自己審査。独立の第二者審査ではない）

- 判定: APPROVE（設計として）。根拠: 効果・原因・分かれの場所を実測で確かめた（§17・§18）。変更点は 1 か所で、受入条件はすべて数か ○× で判定できる。
- 未解決: Terminal.app の扱いは未確認（目標比較は PO の目視で代える）。実装の開始には PO の承認と実装カードが要る。

## 20. 実装カード（PO 2026-11-28「1」で §19 の実装を承認。マージ・本番反映は測り直しの後に別に決める）

- ブランチ: `release/terminal-sync-frame-hold`（origin/main 6839691 = v0.56.0 起点）。PR は作らない（Opus が作る）。
- 新規 `src/components/TerminalPane/syncFrameCoalescer.ts`:
  - `export const SYNC_FRAME_HOLD_MS = 100;`
  - `export function createSyncFrameCoalescer(write: (data: string) => void, holdMs = SYNC_FRAME_HOLD_MS): { push(data: string): void; reset(): void; dispose(): void }`
  - 印は `const BEGIN = "\x1b[?2026h"; const END = "\x1b[?2026l";`
  - push: `buf = pending + data`。`h = buf.lastIndexOf(BEGIN)`、`l = buf.lastIndexOf(END)`。`h > l` なら `buf.slice(0, h)` を（空でなければ）write し、`pending = buf.slice(h)`。そうでなければ、buf の末尾が BEGIN の途中（BEGIN の長さ 1〜7 文字の頭と同じ。必ず ESC で始まる）ならその末尾だけを pending に残し、前を（空でなければ）write。どちらでもなければ buf を全部 write して pending を空。pending が空でなくタイマーが無ければ `setTimeout(holdMs)` を張り、時間が来たら pending を（空でなければ）write して空にする。pending が空になったらタイマーを消す。
  - reset・dispose: pending を空にしてタイマーを消す（write しない）。
- `src/components/TerminalPane/TerminalPane.tsx`（v0.56.0 の行番号）:
  - `connect` を定義する前（:246 の `let ws` の近く）で `const coalescer = createSyncFrameCoalescer((data) => term.write(data));`
  - :280 `term.write(typeof e.data === "string" ? e.data : "")` → `coalescer.push(typeof e.data === "string" ? e.data : "")`
  - :276 `term.reset();` の直前に `coalescer.reset();`
  - :360 の片付け（`return () => {`）の中、`term.dispose()`（:377）より前に `coalescer.dispose();`
  - コメント 1 行: 「Claude の絵（?2026h〜?2026l）を途中で xterm に渡すと、描く番が同期中に当たり描かれない。終わりまで貯めて 1 回で渡す（docs/handoff/terminal-smooth/design.md §18）」
  - それ以外は触らない（入力・つなぎ直しの間隔・ファイル貼り付け・webgl）。
- 新規 `src/components/TerminalPane/syncFrameCoalescer.test.ts`（vitest、`vi.useFakeTimers()`）: ①印なし「abc」→ 1 回「abc」 ②`a`+BEGIN+`x`+END+`b` を 1 回で → 1 回で全部 ③`a`+BEGIN+`x` と `y`+END+`b` の 2 回 → 「a」と BEGIN+`xy`+END+`b` の 2 回 ④3 回に分かれる → 終わりの回で 1 回 ⑤末尾が `\x1b[?20` と次が `26h`+`x`+END → 末尾は次と合わせて 1 回 ⑥BEGIN+`x` のあと 99ms で 0 回・100ms で 1 回 ⑦BEGIN+`x` のあと reset → 100ms 進めても 0 回、その後の「z」は「z」だけ ⑧BEGIN+`a`+END+BEGIN+`b` → BEGIN+`a`+END を渡し BEGIN+`b` を残す。
- 版: 0.56.1（package.json・package-lock.json の2か所・extension/manifest.json・docs/CHANGELOG.md の先頭に 1 行。書き方は 0.56.0 の行に合わせ、戻し方 `bash scripts/ac-update.sh v0.56.0` と設計の場所を書く）。
- 確かめ: `npm run typecheck`・`npm run lint`・`npx vitest run src/components/TerminalPane`・`npm run build` が通る。`git diff origin/main --stat` が上の 6 ファイル＋package-lock.json だけ。
- 測り直し（Opus が Mac の試験用で行う）: §19 の受入条件の 2〜4 行目。

## 21. 便1 測り直し（2026-11-28 03:07〜03:12 JST、PO の Mac、試験用の写し）

- 実装: クラウドの Sonnet が `release/terminal-sync-frame-hold` に c64e601 を push（§20 のカードどおり 7 ファイル。新しい 8 試験と lint は通過。typecheck・build・既存試験はクラウドに `.sa-cache` が無く未実行）。PR #112（下書き）を作り、CI が判定する。
- 測り方: 今の版（v056copy）と直した版（v0561copy。c64e601 を Mac で `npm run build` した dist だけを入れ替え、サーバーは同じ）を、base1 → fix1 → base2 → fix2 の順に交互に測った。台本は run10.sh、測りは measure5.mjs（AC_COALESCE なし）。生データと集計: evidence/bin1/。Mac の load は 7.7〜14.3（uptime-*.txt）。

| 項目（30ノッチ上下×2、2 回分の合計） | 今の版 | 直した版 |
|---|---|---|
| 描画 | 430 | 505 |
| 同期中で描くのを見送った回 | 52 | 0 |
| 描画の 33ms 超の間 | 130 | 109 |
| うち 見送りを含む | 34 | 0 |
| うち 描く番なし・その間に出力を読み終えた | 50 | 20 |
| うち 描く番なし・出力なし | 41 | 85 |
| うち 描く番あり・見送りなし | 5 | 4 |
| 1行の打鍵 送信→最初の描画 p90（1回目／2回目） | 33.0／21.4 ms | 19.8／32.9 ms |

- 受入条件（§19）への当てはめ:
  - 2 行目（見送り 0）: ○（52 → 0）。
  - 3 行目（33ms 超の間が 6 割以下）: ×（130 → 109、84%）。
  - 4 行目（打鍵の p90 が 10ms 以上悪くならない）: ○（各回の p90 の最大は 33.0 → 32.9）。
- 【事実】直した版で減ったのは、ブラウザ側で描けたはずの間（見送りを含む＋出力を読んだのに描かない）で、84 → 20。
- 【事実】直した版で増えたのは「出力なし」の間で、41 → 85。直した版は絵の終わりが届くまで xterm に渡さないので、絵の途中までの出力は「出力なし」に数えられる。
- 【事実】便0g（§18）の今の版は 73、今回の今の版は 130。同じ測りで回ごとの差が大きい。
- 【未確認】残った「出力なし」の間が、Claude・tmux・pty のどこで絵の終わりが遅れているのか。Terminal.app でも同じ止まりが出るか。
- 判定: 受入条件の 3 行目が × のため、設計の受入は未達。マージ・本番反映には進まず、PO に戻す。

## 22. 便1b 5 回ずつの測り直し（2026-11-28、PO「1」、PO の Mac、試験用の写し）

- 測る前に決めた判定: run11 の 5 回分の合計だけで判定する。run10 は混ぜない。基準は §19 のまま。台本 run11.sh（run10.sh の回数を 5 にしただけ）。生データの集計: evidence/bin1b/。Mac の load は 6.6〜15.0。

| 項目（30ノッチ上下×2、5 回分の合計） | 今の版 | 直した版 | 基準 | 判定 |
|---|---|---|---|---|
| 同期中で描くのを見送った回 | 325 | 1 | 0 | × |
| 描画の 33ms 超の間 | 280 | 167（59.6%） | 6 割以下 | ○ |
| 1行の打鍵 送信→最初の描画 p90（65 打鍵） | 53.3 ms | 69.3 ms | 10ms 以上悪くならない | ×（+16.0） |

- 【事実】直した版の見送り 1 回は fix4 の 57571ms。その前の書き込みを並べると次のとおり（summary.txt と claude-raw.json の wr・recv）。
  - 57460.8 に絵の始まりを受けた。57464.2・57502.9・57503.2 に、絵の終わりと次の始まりを両方含む通を受けた。
  - 57560.9 から、同期中のまま xterm へ書いている。絵の終わりは届いていない。57560.9 は最初の始まりから 100ms 後。
- 【事実】`syncFrameCoalescer.ts` の待ちの時計は、時計が無いときだけ始まり、貯めた分が空になったときだけ止まる（`else if (timer === undefined)`、`if (pending === "") clearTimer()`）。絵が切れ目なく続くと、途中で絵が終わっても時計は止まらない。最初に貯め始めてから 100ms で、その時の途中の絵を渡してしまう。
- 【事実】直した版で「書いた直後に同期中」の書き込みは 2577 回中 66 回（今の版は 16958 回中 15049 回。wr-sync.txt）。
- 【推測】見送り 1 回はこの時計の作りが原因。時計を「今貯めている絵の始まり」から数え直せば 0 になる。§20 のカードに「新しい絵を貯め始めたら時計をかけ直す」と書かなかった。設計の書き漏れ。
- 【未確認】打鍵の p90 が 16ms 悪くなった理由。直した版の回は load が高めだった（fix は 8.4〜15.0、base は 6.6〜10.6）。時計の作りとの関係も確かめていない。
- 判定: 受入条件の 2 行目と 4 行目が × のため、未達。マージ・本番反映には進まない。
