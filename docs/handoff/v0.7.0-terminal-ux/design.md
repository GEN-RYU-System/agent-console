# 設計: v0.7.0 端末の見やすさ（はみ出しの解消・なめらかなスクロール・日本語の明朝・画像の添付）

> 版の番号は 0.8.0 に変更（main の v0.7.0 は別の機能が使用）。

- 状態: 設計者（Opus）が作成。Fable の設計審査 第1回 REVISE（HIGH 3・MEDIUM 2）を反映した。スクロールの入力機器は PO が回答済み（§3-2）。
- PO 承認（2026-10-12）:
  - 「スクロールすると方ついているのだがもっとぬるっと動くように」
  - 「明朝のような…書体を採用したい」→「英数字は今の書体、日本語だけヒラギノ明朝」に「入れる」
  - 「画面幅から文字がはみ出したりしてしまう現象…も解消」
  - 「スクショも添付できるようにしたい」
- 調査: docs/handoff/v0.7.0-terminal-ux/recon.md（Sonnet）
- 対象ADR: ADR-067、ADR-144
- 本書の対象外（別の版で扱う）:
  - 上部タブの2倍（recon E）
  - 「よく使う指示」のバー（recon F）
  - 1つの版で変えるのは、1つのテーマ（端末）だけにする。

## 0. 事実
- はみ出しの原因（recon A-6。本物の Claude Code、窓 1296×1000、DPR 2、Chrome 156 で再現）:
  - xterm の buffer では、行は 90 列に収まっていた（切れた字も buffer に入っていた）。描画（DOM）だけが右に伸びていた。
  - 全角の句読点と括弧（（ ）、 。）は、1文字ずつ別の span になり、`letter-spacing: 9.378px` が付いて、2.81 マス分の幅で描かれる（本来は 2 マス）。
  - これは、xterm がこれらの字形の幅を約 7px と測っているためだった。
  - Chrome の `text-spacing-trim` の値は、既定の `normal` だった。
  - `.xterm, .xterm *` に `text-spacing-trim: space-all` を付けると、句読点が別の span にならなくなった。行の右端は 88.04 / 89.03 マスで、90 列の中に収まった。句読点だけの行は 30.01 マス（期待は 30）。
  - 生のバイト列に、自動の折り返しを切る制御（ESC[?7l）は無かった。Claude 側の桁の指定は、xterm の数え方と一致した。
- 日本語の字間の隙間: かなと漢字は 2.784px の字間で、ちょうど 2 マスに収まっている。字間の隙間は、字形（13.6px）と 2 マス（16.37px）の差（recon A-4）。
- 書体:
  - `--ac-font-mono` を `Menlo, "Hiragino Mincho ProN", monospace` にすると、日本語は HiraMinProN-W3、英数字と罫線は Menlo で描かれた。列の数は変わらなかった（recon D、shot-after-mincho.png）。
  - デザインの検査は、この形の font stack を許している（scripts/check-design-governance.mjs:32-41、97-101）。
- スクロール: xterm 6.0.0 の既定は smoothScrollDuration 0（なめらかさ無し）、scrollSensitivity 1。TerminalPane はどちらも設定していない（recon C）。
- 画像:
  - 今の画面には、画像の貼り付けやドロップの処理が無い。画像だけの貼り付けやドロップでは、何も送られない（recon B-1）。
  - 画像の絶対パスを貼ると、Claude Code は `[Image #n]` として取り込んだ。空白を含むパスでも同じだった（v0.6.0 step0 (a)、recon B-2）。
  - 公式文書では、画像はドラッグ、Ctrl+V、パスを書く、で渡せる（recon B-4）。
  - 保存の作法は picks.ts にある: 600/700、UUID、一時ファイル→rename（recon B-3）。
- 絵文字は、xterm（unicode 6）が幅1と数えるため、字形が重なる（recon A-3）。Claude の数え方は【未確認】。本書では扱わない（§2）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 全角の句読点・括弧と「※」を含む日本語の行が、端末の右端で切れない。描画の右端が、列数×1マスの幅を超えない|e2e（句読点と ※ の行を出す役割で、recon A-6 の2文・句読点だけの行・※ の行を出し、各行の DOM の右端 ≤ .xterm-screen の右端 +1px を確かめる。正は macOS のジョブ。Linux は CJK の書体の有無で意味が変わるため参考）|
|K2 マウスのホイールでのスクロールが、なめらかに動く（物理的なホイールのときだけ `smoothScrollDuration` が config の値、既定 125ms。トラックパッドと判定できないときは 0）|単体試験（ホイールとトラックパッドの合成イベントで値が切り替わる）＋目視（PO）|
|K3 日本語はヒラギノ明朝で、英数字と罫線は今の Menlo で、Menlo に無い記号（※ など）は Monaco で描かれる。列の数は変わらない|単体試験（トークンの値）＋e2e（描画の書体の確認は recon D の方法。macOS のジョブだけで行い、Linux では skip）|
|K4 端末に画像を貼り付けるか、ドロップすると、アプリが画像を保存し、その絶対パスを端末の入力欄に貼る（Enter は押さない）。Claude Code に送ると `[Image #n]` として取り込まれる|統合試験（保存）＋e2e（端末に入る文字）＋PO の目視（取り込み）|
|K5 画像は PNG と JPEG だけを受け付ける（先頭のバイトで確かめる）。1枚 `uploadMaxBytes`（既定 5MiB、config）まで。保存は dataDir/uploads/<UUID>.<拡張子>（ディレクトリ 700、ファイル 600）。残すのは新しい順に `uploadMaxKeep`（既定 100、config）枚まで|統合試験|
|K6 画像の受け口は、既存の認証と Origin の検査の内側にある|統合試験（401・403）|
|K7 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K8（導入後）PO の画面で、端末の枠（.xterm-screen）の中で日本語の行が右端で切れない。日本語が明朝に見える。マウスのホイールでのスクロールがなめらか。スクリーンショットを貼るかドロップすると Claude が見られる。画像以外のファイルを落としても、画面が別のページに変わらない|PO の目視（ブラウザの拡大率が 100% であることも確かめる）|

## 2. 対象と対象外
- 対象:
  - src/components/TerminalPane/（TerminalPane.tsx、CSS、試験）
  - src/tokens.app.css（--ac-font-mono の値）
  - server/uploads.ts と uploads-routes.ts（新設）、server/http.ts（つなぐ）
  - server/config.ts、agent-console.config.json（`terminalSmoothScrollMs`、`uploadMaxBytes`、`uploadMaxKeep`）
  - /api/state で、画面に terminalSmoothScrollMs を渡す（config の値。画面にじかに書かない）
  - src/api.ts、src/types.ts、ja.json
  - tests/fixtures/e2e-env.ts（config）
  - 試験、版 0.7.0、CHANGELOG、README
- 対象外:
  - 絵文字の幅（unicode11 の addon）。Claude の数え方が未確認のため（§0）。
  - 日本語の字間の隙間そのもの。2 マスに収める仕組みの結果で、はみ出しではない（§0）。
  - 上部タブ・よく使う指示（別の版）
  - 画像以外のファイルの添付
  - ページ全体が窓より広くなる現象（recon A-5 で再現せず。K8 は端末の枠の中に限る）
  - shell の役割のセッションへの画像のパスの貼り付け（空白が区切りになるため。Claude Code の入力欄が対象）

## 3. 仕組み
### 3-1 はみ出し（K1）
- TerminalPane の CSS に `.xterm { text-spacing-trim: space-all; }` を足す。
  - text-spacing-trim は継承される（W3C の定義で Inherited: yes）。xterm が幅を測る要素（.xterm-helpers の中）も、行も、.xterm の子孫なので、これだけで足りる。
  - xterm.css にこの指定は無いので、`!important` は要らない（Fable の審査で確認）。
- 長さの値は無いので、トークンは要らない。

### 3-2 なめらかなスクロール（K2）
- config の `terminalSmoothScrollMs` を、/api/state で画面に渡す。TerminalPane は term を作るときと、値が変わったときに `term.options.smoothScrollDuration` に入れる。
- 既定の値は 125ms にする。VS Code の端末と同じ値（microsoft/vscode の xtermTerminal.ts:55-57）。
- 【事実】VS Code は、トラックパッドではこのなめらかさを切っていて、物理的なマウスのホイールのときだけ使う（同 :532-533、:641）。
- PO の回答（2026-10-12）: 「マウスホイールがメインだが、スマホや出先ではトラックパッドやスライドで移動させる」。
- そこで VS Code と同じく、物理的なマウスのホイールのときだけ 125ms のなめらかさを使い、トラックパッドとタッチでは 0（ブラウザのそのままの動き）にする。
  - 見分け方は VS Code の実装（xtermTerminal.ts の _isPhysicalMouseWheel と、それが使う判定）を読み、同じ考え方で作る。読んだ行を step0.md に書く。
  - 判定できない場合は 0 にする（トラックパッドの動きを悪くしないため）。
- スマホからの操作は、公式の Remote Control で Claude のアプリから行う。このアプリの画面には出ない（127.0.0.1 だけで動いているため）。そのため、スマホのスライドは本書の対象外。
- PO の目視（K8）で変えたいと言われたら、config の値だけを変える。

### 3-3 書体（K3）
- `src/tokens.app.css` の `--ac-font-mono` を `Menlo, Monaco, "Hiragino Mincho ProN", monospace` に変える。
  - Monaco は残す。Menlo に無い「※」は、今は Monaco で1マスに描かれている（recon A-4）。外すと「※」がヒラギノ明朝の全角の字形で描かれ、1マスに詰められて重なるおそれがある（Fable の審査 HIGH-1）。
  - Monaco には、かなと漢字が無いので、日本語は引き続きヒラギノ明朝に落ちる。
  - "Courier New" は Mac では使われないので外す。
- この形が検査に通ることは、Fable の審査で確かめた（isFontStack の結果 true）。
- 冒頭のコメント（SA に等幅フォントが無いための置き場）は、そのまま残す。

### 3-4 画像の添付（K4〜K6）
- 画面（TerminalPane の包み）:
  - `dragover` と `drop` は、包みの要素で必ず既定の動きを止める（止めないと、ブラウザがファイルをページとして開き、アプリの画面が置き換わる）。画像以外のファイルを落としたときは、何もせず、案内を出す。
  - `paste` は capture 段階で受ける。クリップボードに画像のファイル（image/png か image/jpeg）があり、かつ text/plain が空のときだけ、既定の動きを止めて画像として扱う。文字があれば、今までどおり xterm に任せる（文字と画像の二重の貼り付けを防ぐ）。
- 送り方:
  - `POST /api/uploads` に、画像のバイト列を base64 で JSON にして送る。readJsonBody の上限は、この口だけ `uploadMaxBytes` × 4/3 + 余白にする（picks と同じ作法）。
  - サーバーは、先頭のバイトで形式を確かめる。PNG は 8 バイト（89 50 4E 47 0D 0A 1A 0A）、JPEG は 3 バイト（FF D8 FF）。拡張子はサーバーがこの署名から決める。保存して `{path}`（絶対パス）を返す。
  - 大きさの上限を超えたときは、画面に案内の文（ja.json）を出す。
- 画面は、受け取ったパスの前後に空白を付けて、その端末に `term.paste()` で入れる。Enter は押さない。
  - 送るかどうかは PO が決める。Claude が作業中でも、入力欄に残るだけ。
- 貼る直前にセッションが切り替わったら、入れない（v0.4.0 と同じ）。案内は ja.json に置く。
- 保存:
  - dataDir/uploads/。一時ファイル→chmod 600→rename。
  - 件数を超えたら、ファイルの更新時刻（rename の後の mtime）が古い順に、その UUID のファイルだけを消す。保存は picks.ts と同じく1本ずつ順に行う（並行の書き込みを避ける）。
  - UUID の形でないものは扱わない。

## 4. SSOT
- 書体の正本は tokens.app.css の1か所。
- スクロールの時間・画像の上限は config だけに置き、画面には /api/state で渡す。
- 画像の正本は dataDir/uploads/。Claude に渡すのはそのパスだけ。

## 5. 安全
- 画像の受け口は認証の内側にある。PNG と JPEG の先頭のバイトで確かめ、大きさの上限を付ける。
- パスはサーバーが作る（UUID）。画面からパスを受け取らない。
- 消すのは、uploads の UUID のファイルだけ。
- 画像の中身は、Claude にとっては PO が自分で貼ったもの。部品のピッカーと違い、よそのページの中身が勝手に入ることはない。

## 6. 代替案
- 描画を WebGL か canvas に変える（マス目に固定して描く）: addon が増え、描画の仕組みが丸ごと変わる。1行の CSS で直ることを実測したので、不採用。
- 画像をクリップボードのまま Claude に渡す: ブラウザの xterm からは、OS のクリップボードの画像を Claude Code に渡す方法が無い（recon B-1。画像だけの貼り付けでは何も送られない）。不採用。

## 7. リスクと対処
- PO の Chrome は 154（v0.6.0 step0.md）。text-spacing-trim は Chrome 123 から既定で有効（Chrome Status、MDN の browser-compat-data）なので、実機でも同じ原因と見てよい。直っていなければ、§6 の WebGL の案を次の版で設計する。
- 明朝にすると、記号の字形が変わる: K8 で見てもらう。

## 8. 外部・過去事例の参照と我々への応用
- 本書の原因の特定は、本物の Claude Code での再現と DOM の実測による（recon A-6）。外部事例ではない。
- W3C CSS Text Module Level 4（Working Draft 2026-08-14、https://www.w3.org/TR/css-text-4/）:
  - text-spacing-trim の初期値は normal、継承される。
  - space-all は「全角の句読点をすべて全角の字形で描く」。
  - normal は「行末の全角の閉じの句読点を、半角の字形にする」。
- MDN の browser-compat-data: Chrome は 123 から対応。Safari と Firefox は未対応（このアプリは Chrome 前提）。
- VS Code の端末（microsoft/vscode）: なめらかなスクロールは 125ms で、物理的なホイールのときだけ使う。
- 適用限界: 測ったのは Chrome 156（Playwright）だけ。

## 9. 設計審査
- 第1回（Fable、2026-10-12）: REVISE。
  - HIGH-1 Monaco を残す。
  - HIGH-2 dragover を止める。
  - HIGH-3 スクロールは 125ms（VS Code）にして、入力機器を PO に確かめる。
  - MEDIUM-1 ページ全体の幅は対象外。K8 は端末の枠の中に限る。
  - MEDIUM-2 文字と画像の同時の貼り付け、消す順番、署名のバイト数。
  - すべて反映した。
- 工程0に足すもの: 空白を含むパスだけを、本物の claude に term.paste() で貼り、`[Image #n]` になるかを確かめる。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1 の e2e で、句読点を含む行が右端を越えないことを固定する。
