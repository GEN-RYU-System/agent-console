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
