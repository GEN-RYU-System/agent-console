# v0.7.0 端末の画面の改善 recon

> 版の番号は 0.8.0 に変更（main の v0.7.0 は別の機能が使用）。

調査日 2026-10-12。基準は origin/main cee6737（v0.6.1）。製品コードは変更していない。
再現の道具（本リポジトリ外）: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/probe/（probe-role.mjs、run.sh、repro2.mjs、scan.mjs、width.mjs、paste.mjs、mincho.mjs）。
スクリーンショット（本リポジトリ外）: /tmp/CC報告ファイル/shot-before-gothic.png、/tmp/CC報告ファイル/shot-after-mincho.png。
再現は別ポート 4399（AGENT_CONSOLE_PORT=4399、AGENT_CONSOLE_RESTORE=off、一時の dataDir）の開発用サーバーで行った。本番 4319 には触れていない。claude は使わず、node の役割（echo 相当）だけ。

## A. はみ出し

### A-1 現在のコード
- 【事実】xterm 生成: `src/components/TerminalPane/TerminalPane.tsx:68-71` は `new Terminal({ scrollback: SCROLLBACK_LINES, ...readTerminalAppearance() })` だけ。scrollback は 2000（同:10）。
- 【事実】読み込んでいる addon は FitAddon だけ（同:2, 72-73）。unicode11 / unicode-graphemes は import も load も無い。
- 【事実】`term.unicode.activeVersion` を設定する箇所は src に無い（`grep -rn "unicode" src` に該当なし）。
- 【事実】letterSpacing・lineHeight・smoothScrollDuration・scrollSensitivity・fastScrollSensitivity・rescaleOverlappingGlyphs の指定は TerminalPane.tsx に無い（すべて xterm の既定）。
- 【事実】大きさ合わせ: `src/components/TerminalPane/TerminalPane.tsx:81-86` の syncSize が、host の clientWidth/Height が 0 なら何もせず、それ以外は `fit.fit()` の後に `send({type:"resize", cols: term.cols, rows: term.rows})`。呼び出しは ws.onopen（同:88）、ResizeObserver（同:93-94）、テーマ変化（同:102）、初回 `fit.fit()`（同:105）。
- 【事実】host の CSS は `src/components/TerminalPane/TerminalPane.css:1-8`（padding は `var(--space-2)`=8px、overflow hidden）。
- 【事実】node_modules/@xterm には addon-fit と xterm だけが入っている（`ls node_modules/@xterm` = addon-fit, xterm）。package.json の dependencies は `@xterm/addon-fit 0.11.0` と `@xterm/xterm 6.0.0`（package.json:30-31 付近）。
- 【事実】サーバー側: `server/sessions.ts:296-299` の resize が `session.term.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS))`。clampDimension は `server/sessions.ts:65-68`（数値でなければ既定、1〜MAX_DIMENSION=500 に丸め、floor）。DEFAULT_COLS=120、DEFAULT_ROWS=30（`server/sessions.ts:11-12`）、MAX_DIMENSION=500（同:13）。

### A-2 xterm 6.0.0 の公式の事実
- 【事実】typings node_modules/@xterm/xterm/typings/xterm.d.ts:1901（本リポジトリ外） `activeVersion: string`。本体に登録されている版は `term.unicode.versions` = ['6']、activeVersion = '6'（width.mjs の実測。素の Terminal、addon 無し）。
- 【事実】Context7 /xtermjs/xterm.js: `@xterm/addon-unicode11` は「Unicode version 11 rules」を提供し、`terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';` で有効にする。node_modules/@xterm/xterm/README.md:85 も同じ説明（「Updates character widths to their unicode11 values」）。
- 【事実】npm レジストリ（`npm view`）: `@xterm/addon-unicode11` latest 0.9.0（beta 0.10.0-beta.301）。`@xterm/addon-unicode-graphemes` latest 0.4.0。`@xterm/xterm` latest 6.0.0（beta 6.1.0-beta.304）。いずれも本リポジトリには未導入。peerDependencies の出力は空だった。
- 【事実】`rescaleOverlappingGlyphs`（typings 217-228 行付近）: 「幅1マスだが隣に重なる字形を横に縮める。曖昧幅の文字（U+2160 以降のローマ数字など）向け。絵文字・Powerline・Nerd font は縮めない。DOM レンダラでは効かない。既定 false」。
- 【事実】xterm の曖昧幅（ambiguous width）の設定項目は typings に見当たらない（`grep -n ambiguous xterm.d.ts` は rescaleOverlappingGlyphs の説明の 219 行だけ）。実測では ●○◯※→─│ はすべて幅 1（width.mjs）。

### A-3 xterm 6.0.0 の既定（unicode 6）での文字の幅（width.mjs の実測。buffer の cell.getWidth()）
- 幅2: ひらがな あ、漢字 日、全角空白 U+3000、、。（U+3001/3002）、（（FF08）、・（30FB）、：（FF1A）、「（300C）、！（FF01）、全角数字 １（FF11）、𠮷（20BB7）。
- 幅1: ｱ（半角カナ）、─ │ ● ○ ◯ ※ → ✻ ✓ — … Ⅳ ° ·。
- 幅1（注意）: 😀（U+1F600）= 幅1、❤️（2764+FE0F）= 幅1、👨‍👩‍👧（ZWJ 列）= 先頭セルの幅1 で、後続の X が 3 列目に来る（字形が分割されて配置される）。
- 【事実】絵文字 😀 を xterm は幅1として数える。DOM 描画では字形が2マス幅で、span に letter-spacing -8.81px が付いて詰められる（repro2.mjs、emoji 行）。shot-after-mincho.png の emoji 行では字形が互いに重なっている。

### A-4 再現（開発用サーバー 4399＋Playwright chromium、viewport 1400x800、DOM の実測）
- 方法: 役割 probe-role.mjs が端末の列数 N を読み、各行を「ラベル6桁＋対象文字を埋めて N-1 桁＋`|`」で出す（日本語は2マス幅として数える）。出力後、DOM の行の描画矩形（Range.getBoundingClientRect）の右端と `.xterm-screen` の右端を比較。
- 【事実】使っている renderer は DOM。`.xterm-rows` が存在し、`canvas` は 0 個（repro2.mjs: `renderer: {domRows:true, canvasCount:0}`）。
- 【事実】viewport 1400: term の列数 97、`.xterm-screen` 幅 794px、1マス 8.186px、host 右端 1092、screen 右端 1082（host の padding 8px を引くと右に約2px の余り）。
- 【事実】行ごとの描画右端 − screen 右端（overshootPx）: ascii +0.05、日本語 +0.30、罫線 +0.05、縦線 +0.05、●○◯ +0.05、※ +0.48、→ +0.05、混在（日本語+英字）+0.36。絵文字は -368px（xterm が幅1と数えるので、出した側の想定より短く終わる＝右にはみ出さず左に寄る）。
- 【事実】viewport 幅 900〜1483（53 刻み、12 点）× devicePixelRatio 1 と 2 の全点で、最悪値は +0.31〜+0.50px（※ の行、または混在行）。1px を超えるはみ出しは出なかった（scan.mjs の出力）。列数は 62〜103。
- 【事実】日本語の span: `letter-spacing: 2.77738px`、span 幅 = 文字数×16.37px（= 2マス）。例: 「ああ…」45字の span 幅 736.98px。英字の span の letter-spacing は -0.0019px。つまり日本語の字形（13.6px）に 2.78px の字間が足されて2マスに合わせている。字間の隙間はこの letter-spacing の値で説明される（スクリーンショットの「3 つ と も 、」と同じ見え方。因果の断定はしない）。
- 【事実】日本語を実際に描いている書体（CDP `CSS.getPlatformFontsForNode`）: 現在の指定 `Menlo, Monaco, "Courier New", monospace` で、日本語行は `HiraKakuProN-W3`（Hiragino Kaku Gothic ProN）45 グリフ＋`Menlo-Regular` 7 グリフ。※ の行は `Monaco` 90 グリフ。絵文字の行は `AppleColorEmoji` 45 グリフ。罫線・●○◯→ は `Menlo-Regular`。`document.fonts` は空（Web フォントの読み込み無し）。
- 【事実】出力幅が1マスずれる再現は、この実験の範囲では絵文字だけ（A-3）。日本語の行の幅そのものは、xterm の描画上、列数×1マスの幅に収まっていた（上の数値）。
- 【未確認】PO の実機スクリーンショット（/Users/tanizawashingo/Downloads/スクリーンショット 2026-10-12 22.25.56.png、本リポジトリ外）で見える「日本語の行の右端が切れる」は、この環境の再現では起きなかった。原因は未特定。候補（推測として列挙するだけで、どれも測っていない）: (1) Claude Code 側が数える文字の幅と xterm の幅の差、(2) PO の実機のフォント寸法・画面の倍率、(3) 端末の幅と pty の列数の同期の遅れ、(4) 実際の Claude の出力に含まれる文字（再現で使っていない文字）。
- 【未確認】Claude Code が文字の幅をどう数えるか（曖昧幅・絵文字・Unicode の版）は、Context7 /websites/code_claude の範囲では記載を見つけていない。

### A-5 窓を開いたまま縮める・広げる実測（ページを開き直さない）と、ページ全体の横幅
測定: 別ポート 4399、Playwright（probe/shrink.mjs、shrink2.mjs。本リポジトリ外）。セッションを1つ作って probe の日本語行を出し、setViewportSize で窓を変え、各段階 1.2 秒待って計測。
- 【事実】CSS: `src/pages/ConsolePage.css:1-11` `.ac-page { display:grid; grid-template-columns: 20% 1fr 22%; grid-template-rows: 1fr auto; ...; height: 100vh }`。`.ac-page__center`（:22）は `min-width: 0; min-height: 0`、`.ac-page__terminal`（:23）も `min-width: 0`。`.ac-page__left` / `.ac-page__right`（:13-21）は `min-width: 0` を持たない（列が % 指定のため、列幅は内容で変わらない）。footer は `grid-area: footer`（:39-48）。
- 【事実】窓 1483 で開き → 1300 → 1100 → 1000 → 900 に縮めた結果（document.documentElement.scrollWidth = window.innerWidth の全段階。窓より右に出ている要素は 0 個）:
  | 段階 | innerWidth | docScrollW | grid 列 | center（左端〜右端、幅） | right（左端〜右端、幅） | .xterm-screen 幅 | cols |
  |---|---|---|---|---|---|---|---|
  | open 1483 | 1483 | 1483 | 296.594 / 860.156 / 326.25 | 296.6〜1156.8（860.2） | 1156.8〜1483（326.3） | 843 | 103 |
  | →1300 | 1300 | 1300 | 260 / 754 / 286 | 260〜1014（754） | 1014〜1300（286） | 737 | 90 |
  | →1100 | 1100 | 1100 | 220 / 638 / 242 | 220〜858（638） | 858〜1100（242） | 622 | 76 |
  | →1000 | 1000 | 1000 | 200 / 580 / 220 | 200〜780（580） | 780〜1000（220） | 565 | 69 |
  | →900 | 900 | 900 | 180 / 522 / 198 | 180〜702（522） | 702〜900（198） | 508 | 62 |
- 【事実】逆（900 で開き → 1000 → 1100 → 1300 → 1483 に広げる）も、全段階で docScrollW = innerWidth、窓より右に出る要素 0 個、cols は 62 → 69 → 76 → 90 → 103、term の列数（probe が pty から読んだ COLS）と `.xterm-screen` 幅÷1マス（8.19px）から求めた列数が全段階で一致。
- 【事実】負荷あり（quick prompt 7個: 「エビデンスとSSOTの念押し」ほか PO のスクショと同じラベル、区切りのない長い名前のセッション）で 1483 → 1100 → 900 に縮めても同じ（docScrollW = innerWidth、はみ出す要素 0、cols 103 / 76 / 62）。長い名前が実際に反映されたか（名前は 40 字までの検査 `server/sessions.ts` validateName）は確認していない【未確認】。
- 【事実】ページ全体が窓より横に広くなる現象は、この再現では出なかった。min-content を押し広げている要素も見つからなかった（「窓より右に出ている要素」の列挙が全段階で空）。
- 【未確認】PO の実機では、右の台帳パネルも窓の右端で切れている（スクリーンショット2枚）。この再現（Chromium headless、1483px 以下の幅、DPR 1）ではその状態を作れていない。実機の窓の実寸・ブラウザの拡大率・拡張機能の有無・台帳パネルの中身（実データ）は未測定。

### A-6 本物の Claude Code（Ink の TUI）での再現（窓 1296x1000、DPR 2）
測定: 別ポート 4399 の開発用サーバー（claude は PATH の 2.1.296、`claude --model sonnet`、LANG=ja_JP.UTF-8、作業場所は e2e の一時 git リポジトリ。信頼の確認は上矢印＋Enter を1回）。Playwright chromium（Chrome/156.0.8078.4）。道具と生データは本リポジトリ外の scratchpad probe/（real.mjs、real-raw.txt、real-recv.json、real-dom.json、real-spans.json、replay.mjs、punct.mjs）。スクリーンショット（本リポジトリ外）: probe/real-term.png。
依頼は「次の2つの文章を、それぞれ1行ずつ、一字一句そのまま出力して」＋PO のスクショで切れていた2文。

- 【事実】再現した。窓 1296 で term の cols は 90（ws の送信 `{"type":"resize","cols":90,"rows":52}`）、`.xterm-screen` 幅 737px（1マス 8.19px）、screen 右端 1004.19px、host 右端 1010.89px。日本語を含む行の DOM の描画右端は 1030.9〜1031.0px（行 6, 7, 8, 9, 12, 14）で、screen 右端より約 26.7px（約 3.3 マス）右に出る。このため行末の字（例「次の3つ」の「つ」、「次の3つと」の「と」）が画面の右端で見切れる（real-term.png でも「次の3つ」の「つ」、「src/tokens.app.c」の途中などが右端で切れている）。折り返しはされない（Claude が列数 90 に収めて出した行で、xterm は折り返さず、描画だけが右に伸びる）。
- 【事実】pty から届いた生のバイト列（ws の受信フレーム 51 個、5960 文字。real-raw.txt）:
  - (a) DECAWM の切り替え `ESC[?7l` / `ESC[?7h` は 0 回。ほかは `ESC[?1049h` 1 回、`ESC[?2004h` 5 回、`ESC[?25l`/`ESC[?25h` 計 60 回。同期出力 `ESC[?2026` は 0 回。
  - (b) 行を出すときの制御: 毎回 `ESC[?25l ESC[H` の後、`LF`、`ESC[<n>B`（n 行下へ）、`ESC[<n>C`（右へ）、`ESC[<n>G`（桁指定）を使い、行ごとに 2 桁のインデントを `ESC[2C` で置き、行の最後は `LF`。入力の echo の行は `ESC[1B␣␣ESC[38;5;231m<本文>ESC[39m<空白>` の形で、本文の後に空白を詰めて 90 桁にしている。末尾は `ESC[52;1H ESC[49;3H`（カーソル位置の復帰）。
  - (c) 返答の行の並び（生）: `ESC[2C ESC[12B 端末の書体：英数字は今の書体（Menlo）のまま、日本語だけをヒラギノ明朝にします。次の3つと`、次行 `ESC[2C ESC[13B 同じ版（v0.7.0）でまとめて入れます。`、`ESC[2C ESC[14B アプリ専用の登録ファイル（src/tokens.app.css）に足して使う決まりにしました。最初に、上部`、`ESC[2C ESC[1B タブを約2倍（高さ ESC[21G 56px・文字 ESC[32G 24px）にします。`。`56px` と `24px` の桁指定（21G、32G）は、「（」「・」を幅2として数えた位置と一致する。
- 【事実】xterm の buffer（生のバイト列を素の xterm 6.0.0・90x52 に流して実測、replay.mjs）: 日本語の行の最後の字は 89 列目（0 始まり、行 6〜9）または、行 12 は「と」が 88 列目（幅2で 89 列まで）。いずれも 90 列に収まり、切れた字も buffer に入っている（行 12 の `lastChar` = 「と」、行 13 の末尾「。」は 36 列目）。つまり buffer は 90 列に収まっていて、DOM の描画だけが右に伸びている。
- 【事実】DOM の行の中身（real-spans.json、1 マス = 8.19px で換算）: 全角の句読点・括弧（「（」「）」「、」「。」）が 1 文字ずつ別の span になっており、その span は `letter-spacing: 9.378px`、幅 2.81 マス（本来は 2 マス）。かなや漢字の span は `letter-spacing: 2.784px`、幅は文字数×2 マスちょうど。英数字は `0.0014px`。例: 行 7 は「（」「）」「、」「。」の 4 個で +0.81×4 = +3.24 マス、行の右端は 91.27 マス（90 列を超える）。行 6 は「、」3 個と「。」2 個で 5 個、右端 93.27 マス。行 9 の右端は 80.26+13 = 93.26 マス。
  - 上の letter-spacing 9.378px は 16.37px（2 マス）− 6.99px。つまり xterm は句読点の字形の幅を約 7px と測り、2 マスとの差を字間に足している。実際に描かれた句読点の字形は約 13.6px 幅（span 幅 2.81 マス = 23px = 13.6 + 9.38）。
  - Chrome の `text-spacing-trim` の計算値は既定で `normal`（punct.mjs で `getComputedStyle(row).textSpacingTrim` を確認）。
- 【事実】介入の実測（punct.mjs。probe の役割で、PO のスクショの2文＋句読点の行を出し、`.xterm, .xterm * { text-spacing-trim: <値> !important }` を読み込み前に差し込む。窓 1296、DPR 2、cols 90）:
  - `normal`（既定）: 行の描画右端 91.27 / 92.26 マス。句読点の span は 9.38px の字間（幅 2.81）で別 span になる。
  - `space-all`: 行の描画右端 88.04 / 89.03 マス（90 列の中）。句読点の別 span は無くなる。
  - 句読点だけの行（「，．、。（）「」・：！？ ABC」）は、`normal` で 32.30 マス、`space-all` で 30.01 マス（期待値 2+24+1+3 = 30）。
  - `font-kerning: none` を同時に足した最初の試行も同じ結果（88.04 / 89.03）だったので、効いているのは `text-spacing-trim` のほう（`text-spacing-trim: space-all` だけの再試行でも同じ数字）。
- 【事実】文字の幅の数え方の比較（replay.json、unicodedata は Python 標準）:
  - xterm unicode 6 の `cellsUsed` と、Python `unicodedata.east_asian_width`（W と F を 2、A を 1）で数えた幅は、満行（行 12、右端まで詰めた行）で 90 と 90 で一致。ほかの行は右の空白を含めて数えるかの差で、xterm 側は行末の空白を含めて 90。
  - 行 7 の「端末の書体…次の3つ」は Python 88（行末の空白2桁を除く）、xterm では空白を含め 90。
  - Node の `string-width` と `wcwidth` は node_modules に無い（本店の node_modules でも `find -name string-width|wcwidth|get-east-asian-width` が空）。未実施【未確認】。Claude Code が実際に使っている幅の数え方は公式文書で未確認。ただし生のバイト列の桁指定（上の 21G、32G）は xterm の数え方（全角の句読点を 2、英数字を 1）と一致した。
- 【事実】A-4 / A-5（printf の出力）で右端が切れなかったのは、そのときの probe の行に全角の句読点・括弧（「（」「）」「、」「。」）が含まれていなかったため（全角の「あ」と漢字だけ。A-4 の「ja」「mixed」行）。
- 【未確認】PO の実機の Chrome のバージョンと、実機での `text-spacing-trim` の計算値。この再現は Chrome/156（Playwright の chromium）。

## B. 画像の添付

### B-1 今の動き
- 【事実】src には paste / drop / dragover / ClipboardEvent / dataTransfer の処理が無い（`grep -rn "paste\|drop\|onPaste\|dataTransfer" src` の該当は、`paste()` で文章を入れる TerminalPane.tsx の pasteAndEnter / pasteSubmitAfter と、ロケール文字列だけ）。
- 【事実】実測（paste.mjs。合成イベントを xterm の textarea に dispatch して ws の送信フレームを観測）:
  - 画像だけの paste（DataTransfer に File image/png のみ）: ws へ何も送られない。defaultPrevented=false。
  - テキストの paste: `{"type":"input","data":"hello"}` が送られた。
  - 画像の drop（`.xterm-screen` に dispatch）: defaultPrevented=false、ws へ何も送られない。dragover も defaultPrevented=false。
- 【未確認】実ブラウザ（Chrome）で画像ファイルをドロップしたとき、ページが画像を開く（既定動作）かの実機確認はしていない。合成イベントで preventDefault が呼ばれていないことだけを確認した。

### B-2 v0.6.0 工程0の記録
`docs/handoff/v0.6.0-picker/step0.md:9-15` から引用:
- 「結果は分岐 (i)「確認なしで読む」に当たる。ただし、Read ツールではなく、端末の画面側が画像として取り込んだ。」
- 「貼った直後の入力欄の表示が `[Image #1][Pasted text #2 +16 lines]` になった（out-a1.raw）。」
- 「貼った文の「画像: <パス>」の行は `画像:` だけになった（パスが文字として残らず、添付に置き換わった）。」
- 「許可の確認は出ず、Read ツールの呼び出しの表示も無かった。」
- 同:15「空白入りのパス（…Application Support/agent-console/picks/<UUID>.png）で同じ試験を繰り返した（out-a2.raw）。結果は同じで、`[Image #1]` になり」。
- 同:16-17: tools 無しの claude（-p など）では添付の形にならなかった（本試験では確かめていない【未確認】）、`auto mode on` の影響の可能性。

### B-3 dataDir への画像保存の作法（server/picks.ts）
- ファイルモード 0o600（`server/picks.ts:10`）、ディレクトリモード 0o700（同:11）。
- フォルダ: `path.join(dataDir, PICKS_DIR)`、PICKS_DIR = "picks"（同:8, 185）。
- `ensureDir`: `mkdir(this.dir, { recursive: true, mode: DIR_MODE })` の後 `chmod(this.dir, DIR_MODE)`（同:210-213）。
- 原子的書き込み `writeAtomic`: 一時ファイル `${file}.${randomUUID()}.tmp` に `writeFile(..., { mode: FILE_MODE })`、`chmod`、`rename`（同:215-220）。
- id は `randomUUID()`（同:276）。画像パスは `${id}.png`、`assertId(id)` 通過後（同:205-208）。
- 画像の検査: PNG の先頭バイトで始まること、1.5MiB まで（`PICK_LIMITS.imageBytes = 1536 * 1024` 同:26、検査 同:131-138）。
- 本文の上限: 既定 `MAX_BODY_BYTES = 64 * 1024`（`server/http.ts:21`）、`readJsonBody(req, maxBytes = MAX_BODY_BYTES)`（同:56）、超過は BodyTooLargeError（同:53）。拡張の受け口だけ `PICK_BODY_MAX_BYTES = 2 * 1024 * 1024`（`server/picks-routes.ts:9`、使用 同:43）。

### B-4 公式文書（Context7 /websites/code_claude、出典 https://code.claude.com/docs/en/common-workflows）
- 「Work with images」: 画像を会話に入れる方法として (1) Drag and drop an image into the Claude Code window、(2) 画像をコピーして CLI に `Ctrl+V`（Windows/WSL は `Alt+V`）で貼る、(3) 画像のパスを Claude に渡す（例「Analyze this image: /path/to/your/image.png」）。
- 同ページ: Claude が画像を参照するとき（`[Image #1]` など）、Cmd+Click（Mac）でリンクを既定のビューアで開ける。
- 出典 https://code.claude.com/docs/en/best-practices: 「Paste images directly. Copy/paste or drag and drop images into the prompt.」
- 【未確認】ブラウザ上の xterm 経由（ws でテキストを送る端末）で、Ctrl+V の画像貼り付け（OS のクリップボードの画像）が Claude Code に届くかは、実測していない。xterm は text/plain の貼り付けだけを扱う（B-1 の実測: 画像だけの paste では何も送られない）。

## C. スクロール
- 【事実】既定値（node_modules/@xterm/xterm/lib/xterm.js（本リポジトリ外） の既定オプション。typings 付記: smoothScrollDuration は xterm.d.ts:271-275、scrollSensitivity は同:267-269、fastScrollSensitivity は同:111-113）: `smoothScrollDuration: 0`、`scrollSensitivity: 1`、`fastScrollSensitivity: 5`、`letterSpacing: 0`、`lineHeight: 1`、`rescaleOverlappingGlyphs: false`、`ignoreBracketedPasteMode: false`。
- 【事実】typings の説明: smoothScrollDuration は「元の位置から目標までなめらかにスクロールする時間（ms）。0 で即時」。fastScrollSensitivity は「Alt を押しているときの倍率」。
- 【事実】`src/components/TerminalPane/TerminalPane.tsx:68-71` はこれらを設定していない（A-1）。scrollback のみ 2000。

## D. 書体
- 【事実】`src/tokens.app.css:8` `--ac-font-mono: Menlo, Monaco, "Courier New", monospace;`（同:1-6 にコメント。SA に --font-mono が来たら置き換える【PO 判断待ち】）。
- 【事実】読み込み: `src/components/TerminalPane/terminalTokens.ts:3` `FONT_FAMILY_TOKEN = "--ac-font-mono"`、`:13-15` tokenValue（getComputedStyle の getPropertyValue）、`:28` `fontFamily: tokenValue(FONT_FAMILY_TOKEN)`。文字サイズは `--font-sm`（同:2, 26）。再読み込みは `src/components/TerminalPane/TerminalPane.tsx:97-104`（`<html>` の class 変化で theme / fontFamily / fontSize を再設定）。
- 【事実】この Mac に明朝がある（`system_profiler SPFontsDataType`）: `HiraMinProN-W3`（Hiragino Mincho ProN W3）、`HiraMinProN-W6`（W6）。fc-list: /System/Library/Fonts/ヒラギノ明朝 ProN.ttc。
- 【事実】governance の font stack 検査（`scripts/check-design-governance.mjs:32-41`）は、`Menlo, "Hiragino Mincho ProN", monospace` のような「引用符付きの名前を含むカンマ区切り＋末尾に総称名」を許す形（isFontStack: 末尾が monospace などの総称名、各要素が引用符付きか英数の語）。
- 【事実】実測（mincho.mjs、dpr 2）: `--ac-font-mono` を `Menlo, "Hiragino Mincho ProN", monospace` に差し替えて `<html>` の class を切り替えると、TerminalPane が fontFamily を読み直した（`.xterm-rows` の font-family が新しい値）。CDP の描画書体: ascii 行は `Menlo-Regular` 97 グリフ、ja 行は `HiraMinProN-W3` 45 グリフ＋`Menlo-Regular` 7 グリフ、混在行は `HiraMinProN-W3` 33＋`Menlo-Regular` 31。screen 右端との差 +0.30px、列数 97 のまま。切り替え前（ゴシック）のスクリーンショット: /tmp/CC報告ファイル/shot-before-gothic.png、切り替え後: /tmp/CC報告ファイル/shot-after-mincho.png。
- 【事実】shot-after-mincho.png では日本語が明朝で、英数字・罫線が Menlo で描かれている。日本語の字間の隙間（letter-spacing）は残る。絵文字行は字形が重なって見える（A-3）。

## E. 上部タブ（端末・変更・PR・部品）の大きさ
.sa-cache は本店 /Users/tanizawashingo/agent-console/.sa-cache（本リポジトリ外。SOURCE = 6c1c5e82418e3ba38c10702f2a74161fd24a7e80）。worktree には .sa-cache が無いので、作業中だけシンボリックリンクを置いてビルドした（コミット対象外）。

- 【事実】(1) 使い方: `src/pages/ConsolePage.tsx:8` `import { Tabs } from "@sa/components/Tabs"`、`:328-` `<Tabs variant="underline" size="sm" activeKey={centerTab} onChange={setCenterTab} items={[terminal, changes（件数）, pr, picks（未送信数）]} />`。className・style は渡していない。
- 【事実】(2) SA の Tabs.css（.sa-cache/frontend/src/components/Tabs.css（本リポジトリ外））: `.comp-tabs--md .comp-tabs__tab { height: var(--comp-tab-h-md); padding: 0 var(--comp-tab-px-md); font-size: var(--font-sm); }`（:61-65）、`.comp-tabs--sm .comp-tabs__tab { height: var(--comp-tab-h-sm); padding: 0 var(--comp-tab-px-sm); font-size: var(--font-xs); }`（:67-71）。underline の下線は `border-bottom: var(--comp-tab-underline-w) solid transparent`（:86-89）。コメント（:8-10）: sm = 28px / font-xs、md = 36px / font-sm。
- 【事実】トークン（.sa-cache/frontend/src/tokens.css（本リポジトリ外））: `--comp-tab-h-sm: 28px`（:528）、`--comp-tab-h-md: var(--height-tab-item)`（:529）、`--height-tab-item: 36px`（:271）、`--comp-tab-px-sm: var(--space-3)`（12px、:532）、`--comp-tab-px-md: var(--space-4)`（16px、:533）、`--comp-tab-underline-w: 2px`（:536）、`--comp-tab-pill-radius: var(--radius-md)`（:539）。`--font-xs: 0.75rem`（12px、:14）、`--font-sm: 0.85rem`（13.6px、:15）。
- 【事実】(3) Tabs の props（Tabs.tsx:37-44（本リポジトリ外））: `items, activeKey, onChange, variant?, size?, className?`。`className` は受け取りコンテナ（role="tablist" の div）の class に連結される（:62-69）。`style` は受け取らない。タブボタン個別の className は受け取らない（:80-86、固定）。
- 【事実】(4) 検査 `scripts/check-design-governance.mjs`:
  - `src/tokens.app.css`（APP_TOKEN_FILE、:10）は、宣言の prop が `--ac-` で始まらなければ違反（:99）、値が font stack でなければ違反（:100）。つまり現状この検査では、tokens.app.css に置けるのは「--ac- ＋ font stack の値」だけで、px 直値（`56px`）や `var(...)` の値は違反になる。
  - それ以外の CSS の宣言（:103-116）: font-family 直書きは違反（:103-105）。`px|rem|em` の直書きは、0 と、`border`/`outline` 系の 1px を除いて違反（:111-116、LENGTH は :86）。`var(--x)` の中身は除外して判定（:107）。
  - SA のカスタムプロパティを上書きする宣言（例 `--comp-tab-h-sm: var(--ac-tab-h)`）自体を禁じる規則は、この検査には無い（prop 名による制限は tokens.app.css 内の `--ac-` だけ）。値に px 直値を書けば :111-116 で違反。
  - `--ac-` トークンを新設すること自体を禁じる規則は無い（tokens.app.css 内の `--ac-` 宣言は許可、ただし値は font stack のみ。:99-101）。
  - TSX の `style={{...}}` 内の 0 と 1 以外の数値、単位直書きは違反（:124-139）。`fontSize|lineHeight|letterSpacing: <数字>` も違反（:142）。
- 【事実】(5) SA の文字サイズのトークン（tokens.css:13-21, 24-25）: `--font-2xs` 0.7rem（11.2px）、`--font-xs` 0.75rem（12px）、`--font-sm` 0.85rem（13.6px）、`--font-base` 0.9rem（14.4px）、`--font-md` 1rem（16px）、`--font-lg` 1.1rem（17.6px）、`--font-xl` 1.25rem（20px）、`--font-2xl` 1.5rem（24px、コメント「KPI値・大見出し」:20）、`--font-3xl` 2rem（32px）、`--font-sidebar-brand` 1.6rem、`--font-display` 1.6rem。24px に当たるのは `--font-2xl`（:20）。
- 【事実】高さ 56px に当たる SA のトークン: `--topbar-height: 56px`（tokens.css:171）、`--comp-table-row-h-relaxed: 56px`（:512、表の行用）、`--sidebar-sub-item-indent: 56px`（:333、用途は別）。`--height-tab-bar: 54px`（:270、「受信箱タブバー高さ（36px × 1.5）」）。
- 【事実】アプリの CSS の読み込み順: `src/main.tsx:3-4` `import "@sa/index.css"; import "./tokens.app.css";`。

## 後始末
- 作業後の worktree には node_modules と .sa-cache のシンボリックリンク、dist/dist-server（ビルド生成物、git 管理外）を置いた。製品コードの変更なし。本ファイルは未コミット。

## F. 「よく使う指示」のバー
PO のスクリーンショット（/Users/tanizawashingo/Downloads/スクリーンショット 2026-10-12 22.31.30.png、本リポジトリ外）で確認した事実: 左に「よく使う指示」の文字、ボタン6個が1行目、「標準化と管理定着」の1個が2行目に折り返し、右端に「指示を編集」。

### F-1 画面（src/components/QuickPrompts/）
- 【事実】`src/components/QuickPrompts/QuickPromptBar.tsx:15-33`: `<div className="ac-quick" data-testid="quick-prompt-bar" role="toolbar">` の中に、`<span className="ac-quick__title">`（:19、表示は `t("ac.quick.title")`）、`<div className="ac-quick__buttons">`（:20、全件を `Button variant="outline" size="sm"` で並べる :22-26。`title={p.text}`、`disabled={!canSend}`）、`<Button variant="ghost" size="sm" onClick={onEdit}>`（:28-30、`t("ac.quick.edit")`）。props は `prompts, canSend, onSend, onEdit`（:6-12）。
- 【事実】折り返しの指定: `src/components/QuickPrompts/QuickPrompts.css:16-23` `.ac-quick__buttons { display:flex; flex:1; flex-wrap: wrap; align-items:center; gap: var(--space-2); min-width:0 }`。`flex-wrap: wrap` は :19。バー全体 `.ac-quick`（:1-8）は `display:flex; align-items:center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border-bottom; background: var(--bg-subtle)`。タイトル `.ac-quick__title`（:10-14）は `flex:none`、font-xs、text-muted。
- 【事実】「よく使う指示」の文字は今は `span`（ボタンではない）。表示の上限や「常に表示」の概念はコードに無い（全件を描く）。
- 【事実】編集: `src/components/QuickPrompts/QuickPromptEditor.tsx:23-138`。項目ごとに Card（`data-testid="quick-prompt-item"`、:68）に label・text のプレビュー、「↑」「↓」（`moveQuickPrompt`、:75-94）、編集、削除。下に追加/編集のフォーム（`data-testid="quick-prompt-form"`、:106）。保存先はサーバー（画面は保存しない、:22）。
- 【事実】呼び出し: `src/pages/ConsolePage.tsx:90-92`（quickPrompts, quickEditorOpen, quickError の state）、`:114-115`（fetchQuickPrompts で読み込み）、`:341-346`（`<QuickPromptBar ... onEdit={() => setQuickEditorOpen(true)} />`、端末タブのときだけ表示 :340）、`:421-423`（`<Modal open={quickEditorOpen} onClose=... title={t("ac.quick.editTitle")} size="md"><QuickPromptEditor prompts onChanged={loadQuickPrompts} /></Modal>`）。
- 【事実】型: `src/types.ts:69-73` `QuickPrompt { id; label; text }`。

### F-2 保存の正本 server/quick-prompts.ts
- 【事実】ファイル quick-prompts.json（dataDir 内。server/quick-prompts.ts:6）、`FORMAT_VERSION = 1`（:12）、`MAX_ITEMS = 40`（:9）、ラベル 1〜40 文字（:8, 28-34）、本文 8KB 以内・改行とタブ以外の制御文字禁止（:7, 36-41）。ファイルモード 0o600、ディレクトリ 0o700（:10-11）。
- 【事実】項目の型 `QuickPrompt { id, label, text }`（:16-20）。保存形は `{ "version": 1, "items": [...] }`（:86、整形 JSON＋末尾改行）。
- 【事実】読み込み `parseFile`（:43-53）: オブジェクトでなければ例外。`version !== FORMAT_VERSION`（= 1 以外）または items が配列でなければ `Error("quick-prompts.json: unsupported format")`（:47）。各項目は `id` が文字列でなければ例外、label と text は再検査し、`{ id, label, text }` の3つだけを取り出す（:48-52）。つまり他のフィールド（未知のキー）は読み込みの時点で落ちる。古い版を読み替える処理（マイグレーション）は無い。
- 【事実】ファイルが無ければ空配列（`load`、:71-78、ENOENT）。壊れた/対応外のファイルは上書きせず例外（:79-80。試験 `tests/unit/quick-prompts.test.ts:47-56` が「壊れたファイルは上書きされない」を確認）。
- 【事実】書き込み `save`（:83-89）: `mkdir(dirname, {recursive, mode 0o700})`、`${file}.${randomUUID()}.tmp` に書き、chmod、rename。読み書きは `serial`（:65-69）で1本ずつ順に実行。
- 【事実】`create`（:103-111）は id を `randomUUID()`、`{id,label,text}` を作り末尾に追加（上限超過は SessionInputError）。`update`（:113-121）は `next = { id, label, text }` を作って置き換える（label と text 以外の項目は引き継がれない作りになっている）。`remove`（:123-129）。
- 【事実】並び順: 正本は items の配列の順番だけ。`move(id, direction)`（:132-142）が "up"/"down" の隣と入れ替える（元の配列は変えず新しい配列を作る）。端や不正な方向は SessionInputError、id が無ければ SessionNotFoundError。
- 【事実】API（`server/http.ts`）: `GET /api/quick-prompts`（:182-183、`{items}`）、`POST /api/quick-prompts`（:186-188、201、body の label と text だけを渡す）、`PUT /api/quick-prompts/:id`（:191, 199-200、label と text だけを渡す）、`DELETE /api/quick-prompts/:id`（:191, 204）、`POST /api/quick-prompts/:id/move`（:192-194、`direction`）、`POST /api/sessions/:id/...` の送信確認で `quickPrompts.get(promptId)`（:243）。画面側は `src/api.ts:60-69`（fetchQuickPrompts / createQuickPrompt / updateQuickPrompt / deleteQuickPrompt / moveQuickPrompt）。
- 【事実】本リポジトリの既存の version 扱いの根拠: FORMAT_VERSION は 1 だけで、`version !== 1` は「対応外」として例外にする（上記 :47）。version を上げた場合の読み込み側の分岐は現状のコードに無い。

### F-3 SA の金型（.sa-cache/frontend/src/components/）
- 【事実】Popover.tsx（本リポジトリ外）: props は `children`（トリガー）、`content`、`placement?: "top"|"bottom"|"left"|"right"`（既定 bottom）、`open?`、`onOpenChange?`、`className?`（:23-36）。制御式/非制御式の両対応（:80-82）。トリガーを `<span style="display:inline-flex">` で包み、クリックで開閉（:125, 137-144）。パネルは `createPortal(..., document.body)`、`role="dialog"`、位置は `top/left` をトリガーの矩形から計算（:146-154、`calcPosition` :38-70）。外側 mousedown で閉じる（:110-123）。Esc で閉じる処理は Popover.tsx には見当たらない（`grep` の範囲では :1-155 に keydown 無し）。
- 【事実】Modal.tsx（本リポジトリ外）: props `open, onClose, title, size?: "sm"|"md"|"lg"|"xl", dismissOnOverlay?（既定 true）, children, footer?`（:24-33）。Esc で閉じる、フォーカストラップ、閉じたら元の要素へフォーカス復帰、Portal（:3-12）。
- 【事実】Button.tsx（本リポジトリ外）: variant は primary / secondary / ghost / danger / outline / tab、size は sm / md / lg、`fullWidth, loading, loadingText, active（tab 用）, iconOnly（aria-label 必須）, layoutClassName`（:7-9, 24-36）。className と style は受け付けない（`Omit<..., "className" | "style">`、:39）。
- 【事実】Badge.tsx（本リポジトリ外）: `variant: neutral|info|success|warning|danger`、`appearance: soft|solid`、`size: sm|md`、`dot`、`icon`、`children`、`className`（:14-33）。
- 【事実】IconToggleButton.tsx（本リポジトリ外）: `pressed, onClick, iconOff, iconOn, aria-label, size?: sm|md, variant?: default|badge, disabled?, count?`（:21-36。例: 白抜き/塗りのハート）。
- 【事実】SA の components に Checkbox / Switch に当たるファイルは無い（`ls` と `grep -l "Checkbox\|Switch"` の結果が空）。他に Drawer.tsx、NavDropdown.tsx、Tooltip.tsx、Select.tsx、Stack.tsx、Card.tsx、Callout.tsx、EmptyState.tsx、Textarea.tsx、TextField.tsx がある。

### F-4 既存の試験
- 【事実】`tests/unit/quick-prompts.test.ts`（105 行）: 空始まり、create/update/delete と権限 600・一時ファイルが残らない、再起動で残る、不正入力の拒否、壊れたファイルを上書きしない（:47-56）、同時更新で欠けない、K1 move の上下と保存順、K2 端の移動拒否、K3 未知 id と不正方向、K5 move と create の同時実行。
- 【事実】`src/components/QuickPrompts/QuickPromptEditor.test.tsx`（91 行）: 追加で create 呼び出しと onChanged、編集は update を呼び create は呼ばない、削除、サーバーのエラー表示と入力保持、K2 先頭の↑・末尾の↓が disabled、K1 move 呼び出し、K4 props の順で描画。QuickPromptBar の単体試験ファイルは無い（`QuickPromptBar.test` は存在しない）。
- 【事実】`src/pages/ConsolePage.test.tsx`: fetchQuickPrompts をモックし（:26, 52, 131-132）、ボタン押下で `checkQuickPromptSend("s1","p1")` が呼ばれること（:291-308）などを確認。
- 【事実】`tests/unit/daily-use.integration.test.ts`: `/api/quick-prompts` の POST/GET/PUT/DELETE（:306-326）、move の 200/400/404/401（:329-343）、本文 8KB 超で 400・認証なしで 401（:359-361）、送信確認の待機状態（:275-297）。
- 【事実】`tests/e2e/console.spec.ts`: K3（:505-552 付近、登録・編集・ボタン送信・保存ファイルが `{version:1, items}`・権限 600、dataDir の中身が `["chrome-extension","open-sessions.json","picker-token","quick-prompts.json"]`）、v0.3.4 K4（:553-577、バーのボタン列が `toHaveText(["並び一","並び二","指示を編集"])` で、並べ替え後の順も確認）、:582-632 付近に複数行・切替確認の試験（`quick-prompt-bar` の `getByRole("button", { name: "複数行" })` などでボタンを押す）。いずれもバーに全件のボタンが直接並ぶことと、ボタン名「指示を編集」を前提にしている。
- 【事実】`tests/unit/picker-extension.test.ts` と `tests/unit/helpers/harness.ts` にも quick の語が出る（未精査【未確認】）。
