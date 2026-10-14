# 端末ページのホイールを滑らかにする（terminal-wheel）設計 第1版

- 状態: 第1版（Opus 2026-10-14）。Fable 審査前。PO の要望「滑らかに動くようにしてほしい」により着手（目的は PO 承認済み。作り方の y/n は不要と判断: 画面の内部の動きだけで、PO が決める事業上の選択を含まない）。
- PO の言葉（2026-10-14）: 「端末ページのマウスホイールのスクロールの動きがカクカクするので滑らかに動くようにしてほしい、ターミナルでは滑らかに動いた、それと右側の最近の入力履歴だがクリックしたら履歴の箇所にジャンプする機能はつけることは出来る？」
- 根拠の生出力: /tmp/CC報告ファイル/terminal-scroll-history/recon/facts.md（以下 R1）、recon2/facts.md（R2）、recon3/facts.md（R3）。行番号は origin/main 078c9e4。

## 0. 事実
- 端末は @xterm/xterm 6.0.0（package.json:22）。生成は src/components/TerminalPane/TerminalPane.tsx:102-107（scrollback 2000、smoothScrollDuration 0）。物理ホイールと判定した時だけ smoothScrollDuration を terminalSmoothScrollMs（agent-console.config.json:25、125）にする仕組みがある（TerminalPane.tsx:175-184、wheelClassifier.ts）。(R1)
- Claude（v2.1.299、~/.claude/settings.json の tui=fullscreen）は alternate screen とマウス追跡を使う。本番の Claude の pane 11個はすべて alternate_on=1・mouse_any_flag=1・mouse_sgr_flag=1・history_size=0（R1 の tmux-live.txt）。PO が普段の端末で使う起動も同じ設定を読む（R2）。
- このときホイールは xterm のスクロールバックを動かさず、SGR のマウス信号として Claude に送られ、Claude が自分の画面を動かす（R1、docs/handoff/keep-sessions/step0.md:53,104,175）。smoothScrollDuration はスクロールバックの動きにしか効かない（xterm src/browser/Viewport.ts:45-50、R3）。→ 今の滑らか設定は Claude の画面には効いていない。
- xterm 6.0.0 は wheel イベント1つにつき信号を最大1つしか送らない。何行分動かしても1つ（src/browser/CoreBrowserTerminal.ts:641-682、R3）。ピクセルの量は行に直し、|deltaY|<50 は 0.3 倍し、1行に満たない端数は貯める（src/common/services/CoreMouseService.ts:241-269、R3）。
- 実測（Chromium、xterm 6.0.0、R3 の表）: deltaY=100 を5回 → 信号5つ。deltaY=4 を25回（トラックパッド相当）→ 信号1つ（scrollSensitivity 3 でも5つ）。smoothScrollDuration の値で信号の数は変わらない。
- 入力の経路に間引きは無い: onData → ws → tmux の send-keys（R3 §3、TerminalPane.tsx:157-158、server/tmux-terminal.ts:212-234、server/tmux-protocol.ts:41-49）。
- Claude 公式（https://code.claude.com/docs/en/fullscreen、R3 §5）: 「端末がノッチごとに1イベントしか送らないとホイールが遅く感じる。Ghostty や iTerm2 は増幅する」。CLAUDE_CODE_SCROLL_SPEED（倍率）、wheelScrollAccelerationEnabled（加速）がある。
- xterm 6.0.0 の公開 API: `attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean)`（typings/xterm.d.ts:1094。false を返すと xterm はそのイベントを処理しない）、`term.modes.mouseTrackingMode: 'none'|'x10'|'vt200'|'drag'|'any'`（:1932）。
- 【未確認】PO のマウスが出す deltaY・deltaMode・間隔。PO の普段の端末の種類（R3 §1）。

## 1. 原因（観測と判定の対応）
ブラウザの端末は、ホイールを大きく回しても小さく何度も動かしても、Claude には「1イベント=1信号」でしか伝えない。トラックパッドでは25回動かしても1信号になる。Claude は信号1つにつき決まった量を一気に描き直すので、動きが段になる。

## 2. 方針
Claude などがマウス追跡を有効にしている間（`term.modes.mouseTrackingMode !== "none"`）だけ、ホイールの量を「行の数」に直し、1行につき1つの信号を、短い間隔に分けて送る。普通の画面（シェル等、追跡なし）では今のまま（xterm のスクロールバックと smoothScrollDuration）。

## 3. 仕組み（src/components/TerminalPane/ のみ）
### 3-1 wheelLines.ts（新規、純関数とクラス）
- `class WheelLineAccumulator`: `add(e: {deltaY, deltaMode}, cellHeightPx, rows): number` が、今回送る行数（符号付き整数）を返し、端数は持ち越す。
  - deltaMode 0（ピクセル）: deltaY / cellHeightPx。xterm の 0.3 倍の補正はしない（トラックパッドでも動いた量のとおりに送るため）。
  - deltaMode 1（行）: deltaY。deltaMode 2（ページ）: deltaY × rows。
  - 向きが変わったら端数を捨てる。
  - 1イベントで送る行数の上限 MAX_LINES_PER_EVENT = rows（画面1枚分。暴走を防ぐ）。
- `class LineEmitter`: 送る行の待ち行列。`push(lines, emitOne)` で溜め、requestAnimationFrame ごとに最大 LINES_PER_FRAME（2）行ずつ emitOne を呼ぶ。向きが逆の push が来たら待ち行列を捨てて入れ替える（逆回しで行き過ぎない）。待ち行列の上限 rows × 2。dispose で止める。
### 3-2 TerminalPane.tsx
- term.open の後に `term.attachCustomWheelEventHandler(handler)` を付ける。
  - 自分が作った合成イベント（WeakSet に登録）は true を返す（xterm にそのまま処理させる）。
  - `term.modes.mouseTrackingMode === "none"` → true（今のまま）。
  - それ以外 → accumulator で行数を出し、LineEmitter に積み、false を返す（xterm の1信号は出さない）。
- emitOne: 元のイベントの clientX・clientY・修飾キーを写した `new WheelEvent("wheel", { deltaMode: 1, deltaY: ±1, clientX, clientY, bubbles: true, cancelable: true })` を作り、WeakSet に入れて、元のイベントの target（xterm の画面要素）へ dispatchEvent する。信号の形（SGR など）の作り方は xterm に任せる（自前で信号の文字列を作らない。形の正本を xterm の1か所に保つ）。
- cellHeightPx は `host.clientHeight / term.rows`（公開 API だけで出す）。
- 既存の onWheel（smoothScrollDuration の切り替え、:175-184）は合成イベントでは何もしない（WeakSet で見分ける）。それ以外は変えない。
- 後始末（useEffect の return）で LineEmitter.dispose。
### 3-3 触らない物
server、tmux の設定（mouse off のまま）、Claude の設定（CLAUDE_CODE_SCROLL_SPEED 等は付けない）、wheelClassifier.ts、入力経路、画面の見た目。UI 文字列の追加なし（i18n・トークンの変更なし）。

## 4. 成功条件（○×）
- K1（単体、wheelLines.test.ts）: ピクセル deltaY=100・行高17 → 5行、残り端数 0.88 を持ち越し次の 100 で 6行。deltaY=4 を25回・行高17 → 合計5行（今は1信号）。deltaMode 1 の 3 → 3行。ページ → rows 行。向きが変わると端数を捨てる。上限 rows で切る。
- K2（単体）: LineEmitter がフレームごとに最大2行ずつ、合計が push の合計と一致。逆向きの push で前の残りを捨てる。dispose 後は呼ばない。
- K3（画面の単体、TerminalPane.ux.test.tsx の作法）: mouseTrackingMode が none なら custom handler が true を返し合成イベントを出さない。any なら false を返し、行数ぶんの合成イベントを出す。合成イベントには true を返す。
- K4（工程0 と e2e、Chromium 実物の xterm 6.0.0）: マウス追跡を有効にした端末で、deltaY=100 の wheel 1回（行高17）→ onData に SGR の wheel 信号がちょうど 5つ、すべて同じ向き・同じ座標で届く。deltaY=4×25回 → 5つ。追跡なし（none）では信号0・スクロールバックが動く（今と同じ）。
- K5（PO 目視）: 実際の Claude のセッションの端末ページで、マウスホイールで上下に動かすと、段にならず連続して動く。止めた所で止まり、行き過ぎない。普段の端末と比べて違和感がない。

## 5. 工程
- 工程0（製品コードは変えない。R3 の harness を使う）: (a) 合成した `WheelEvent(deltaMode 1, deltaY ±1)` を xterm の画面要素へ dispatch すると、マウス追跡中に信号が1つずつ出ること。(b) custom handler が false を返すと信号が出ないこと。(c) 合成イベントの座標が信号の列・行に入ること。どれかが成り立たなければ止めて設計を直す。
- 工程1: wheelLines.ts と試験（K1・K2）、TerminalPane.tsx と試験（K3）、e2e（K4）。版上げ・CHANGELOG・README（端末の節に1行）。
- 工程2: PR → CI → Fable 審査 → マージ → タグ → update-when-idle → K5。

## 6. 代替案
- CLAUDE_CODE_SCROLL_SPEED を agent-console の起動 env に付ける: 1信号で動く量が増えるだけで段は大きくなる。滑らかさには逆効果。不採用。
- xterm の scrollSensitivity を上げる: 信号の数は変わらない（R3 の表: deltaY=100 は sens 3 でも5）。不採用。
- tmux の mouse on: 信号は Claude に同じく届き、xterm の数え方は変わらない。tmux の copy-mode が絡み副作用が大きい。不採用。
- Claude を classic 表示（CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1）にする: xterm のスクロールバックで滑らかに動き、入力履歴へのジャンプも作れる余地があるが、PO が settings で選んでいる fullscreen の表示が agent-console の中だけ変わる。PO の判断が要るので今回は採らない（別件として PO に出せる）。

## 7. リスク
- Claude の加速（wheelScrollAccelerationEnabled 既定 on）で、短い間隔の信号が加速として扱われ、行き過ぎる恐れ【未確認】→ K5 で見る。行き過ぎるなら LINES_PER_FRAME を 1 にするか、PO の確認のうえ wheelScrollAccelerationEnabled の扱いを別途決める。
- PO のマウスの deltaY が小さい（例 4px 単位）場合、1ノッチで動く行数が減り「遅く」なる恐れ【未確認】→ K5。遅ければ倍率を config に足す（第2版）。
- 合成イベントの扱いは xterm の公開の約束ではない → 工程0 と e2e K4 で版を固定して確かめる。xterm を上げる時は K4 が守る。
- 端末の行高を host.clientHeight / rows で出すので、余白があると少しずれる。行数の端数は持ち越すので、ずれは量だけで向きや段には出ない。

## 8. 外部事例
- Claude 公式が「Ghostty・iTerm2 は増幅する」と書く（R3 §5）。両者は1ノッチで複数のイベントを送ることで Claude の中で滑らかに見える、という本設計と同じ考え方。数値つきの公開事例は確認していないので、成功の証明には使わない。

## 9. 入力履歴へのジャンプ（PO の2つ目の質問）
- 今の作りでは作れない。根拠: 履歴の記録は {ts, text}（src/types.ts:223-226、hooks/activity-hook.mjs:155-162）で、端末の中の位置を持たない。Claude 実行中の端末は alternate screen で、xterm にも tmux にも履歴の行が無い（history_size=0、R1）。Claude の画面の中の位置を外から知る手段が無い。
- 作れる条件: Claude を classic 表示にする（§6 の最後）。PO の判断が要るので、PO に聞く時は1件として出す。

## 触るファイル
- 触る: src/components/TerminalPane/wheelLines.ts（新規）、wheelLines.test.ts（新規）、TerminalPane.tsx、TerminalPane.ux.test.tsx、tests/e2e の端末の試験（既存の spec に足すか新規 1つ）、docs/CHANGELOG.md、README.md、版の4か所。
- 触らない: §3-3。

## 維持の仕組み
- K1〜K4 の試験が CI（ubuntu・macos）で毎回走る。xterm を上げる時は K4 の e2e が合成イベントの振る舞いの変化を捕まえる。

## 10. 工程0の結果（Sonnet 実測、Opus 判断 2026-10-14。生出力 /tmp/CC報告ファイル/terminal-scroll-history/step0/）
- HeadlessChrome 156・xterm 6.0.0・cols100 rows24・セル 9×17。
- (a) 本物の wheel の target は DIV.xterm-screen。そこへ合成の WheelEvent(deltaMode 1, deltaY ±1) を dispatch すると、追跡中（any+SGR）に信号が1つずつ出た（+1 → \e[<65;34;12M、-1 → \e[<64;34;12M）。フレームごと2つ×10回で10個。
- (b) custom handler が false の本物の wheel（deltaY 100 ×5）は信号0、合成（true）は10個。
- (c) 座標は floor(x/9)+1・floor(y/17)+1 で信号の列・行に入る。
- (d) mouseTrackingMode は 1003h で 'any'、1003l で 'none'（1000h は 'vt200'、1002h は 'drag'）。none では合成でも信号0。
- → §3 の方式の前提はすべて成り立つ。設計は変えない。dispatch 先は元のイベントの target（DIV.xterm-screen）とする。
