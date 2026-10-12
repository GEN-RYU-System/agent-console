# 工程0の記録: v0.7.0 端末の見やすさ

- 実施: 2026-10-12、実装担当（Sonnet）。worktree は release/terminal-ux（origin/main cee6737 起点）。
- 生の出力の置き場（本リポジトリ外）: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/ の vsc/（VS Code の取得物）、step0b/（probe.mjs、out.raw）、src8/（W3C の HTML）。

## (i) VS Code の「物理的なマウスのホイールか」の判定

- 取得: `gh api repos/microsoft/vscode/contents/<path> -H "Accept: application/vnd.github.raw"`。取得時点の main の SHA は 4ae086070b67a1fad92f1394fbb50760408c7d11。
- 【事実】src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts（1233 行）
  - :54-56 `const enum RenderConstants { SmoothScrollDuration = 125 }`。
  - :132 `private _isPhysicalMouseWheel = MouseWheelClassifier.INSTANCE.isPhysicalMouseWheel();`（記録が無い初期値は false になる。下の scrollableElement.ts:79-83）。
  - :532-542 `raw.element` の wheel イベント（passive）で `classifier.acceptStandardWheelEvent(new StandardWheelEvent(e))` を呼び、`classifier.isPhysicalMouseWheel()` の値が前回と変わったときだけ `_updateSmoothScrolling()` を呼ぶ。コメント: 「as it must be disabled when a trackpad is used」。
  - :640-641 `raw.options.smoothScrollDuration = config.smoothScrolling && this._isPhysicalMouseWheel ? 125 : 0`。
- 【事実】src/vs/base/browser/ui/scrollbar/scrollableElement.ts の `MouseWheelClassifier`（:63-、capacity は :73）
  - 直近 5 件（capacity 5）の wheel を覚える。
  - `isPhysicalMouseWheel()`（:79-、記録なしは false）: 新しい順に重み 1/2, 1/4, 1/8, …（最古は残りの重み）で score を足し、`score <= 0.5` なら物理ホイール。
  - `_computeScore`（:146-183）:
    - deltaX と deltaY が両方 0 でなければ score 1（トラックパッド）。
    - 基本 0.5。deltaX か deltaY のどちらかが整数でない（誤差 0.01）と +0.25。
    - 直前の項目があり、絶対値の大きい方が小さい方（下限 1）の倍数（X と Y の両方）なら −0.5（加速しない＝物理ホイール）。
    - 0〜1 に丸める。
  - `_isAlmostInt`（:185-189）: `|round(v) − v| < 0.01 + EPSILON*100`。
- 【事実】src/vs/base/browser/mouseEvent.ts の `StandardWheelEvent`（:122-）: Chrome 123 以上では DPR で割らず、`wheelDeltaY / 120` を deltaY とする（wheelDeltaY が無ければ `deltaMode` が LINE のとき `-deltaY`、それ以外は `-deltaY / 40`）。X も同様。
- 本実装の写し方: 5 件の履歴・重み・score の式を同じにする。入力は `wheelDeltaX/Y ÷ 120`（無ければ deltaMode で VS Code と同じ換算）。初期値と判定できないとき（履歴なし）は 0。

## (ii) 空白を含むパスを、本物の claude に括弧付き貼り付けで貼る

- 【事実】やり方: 捨てディレクトリの cwd（git init 済み）で `claude --model sonnet`（node-pty、zsh -ic、LANG=ja_JP.UTF-8、160x50）を起動。信頼の確認に上矢印と Enter を1回。ready を待ち、`ESC[200~` ＋ 空白 ＋ パス ＋ 空白 ＋ `ESC[201~` を書いた（xterm の paste と同じ括弧付き。Enter は送っていない）。
  - 画像は v0.6.0 の試作 PNG（3537 bytes）の写し。パスは <捨てディレクトリ>/Application Support/agent-console/uploads/0b9c5c6e-6f0e-4f7d-9f34-1a2b3c4d5e6f.png（空白は Application Support の1か所。本リポジトリ外）。
- 【事実】結果（probe.mjs の出力。制御文字を除いた貼り付け後の画面）: `[Image #1]Pasting…⏵⏵ auto mode on (shift+tab to cycle)`。
  - 空白入りのパスは `[Image #1]` に置き換わった。パスの文字は入力欄に残らなかった。
- 【事実】生のバイト列は scratchpad の step0b/out.raw。
- 判定: 設計 §3-4 のとおり進める（止まる分岐ではない）。
- 【未確認】PO の普段の起動（ccopusgo）での動き。K8 の目視で確かめる。

## (iii) 設計 §8 の出典の書き写し

- W3C CSS Text Module Level 4（https://www.w3.org/TR/css-text-4/、取得したページの版: W3C Working Draft 14 August 2026）
  - 8.5「CJK Punctuation Spacing: the text-spacing-trim property」: `Name: text-spacing-trim`、`Value: <spacing-trim> | auto`、`Initial: normal`、`Applies to: text`、`Inherited: yes`。
  - `space-all`: 「All fullwidth punctuation characters are set with full-width glyphs (spaced).」
  - `normal`: 「Set fullwidth opening punctuation with full-width glyphs (spaced) at the start of each line; set fullwidth closing punctuation with half-width glyphs (flush) at the end of each line if it does not otherwise fit prior to justification, else set the punctuation with full-width glyphs; and collapse spacing between punctuation glyphs as described below.」
- MDN browser-compat-data（https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/properties/text-spacing-trim.json、mdn_url https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/text-spacing-trim）
  - chrome: `version_added: "123"`。firefox: `version_added: false`（impl_url https://bugzil.la/1951795）。safari: `version_added: false`（impl_url https://webkit.org/b/252068）。
- Chrome Status（https://chromestatus.com/api/v0/features?q=text-spacing-trim で取得）
  - 機能 5170044014690304「CJK punctuation kerning: the CSS `text-spacing-trim` property」、Chrome desktop 123、状態 "Enabled by default"。
- VS Code（microsoft/vscode）: 上の (i) の行番号のとおり。なめらかなスクロールは 125ms で、物理ホイールのときだけ。
