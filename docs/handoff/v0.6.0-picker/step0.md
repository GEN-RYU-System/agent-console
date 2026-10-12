# 工程0の記録: v0.6.0 部品ピッカー（設計 §3-9）

- 実施: 2026-10-12、実装担当（Sonnet）。worktree は release/picker（origin/main 4b1c653 起点）。
- 生の出力の置き場（本リポジトリ外）: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/step0/（out-a1.raw、out-a2.raw、out-b.raw、probe-a.mjs、prompt-a.txt、prompt-b.txt）
- 結果: 設計で「止まって戻す」とした分岐には、どれも当たらなかった。

## (a) tools ありの本物の claude は、dataDir の外の PNG のパスを読むか

- 【事実】やり方: 捨てディレクトリで `claude --model sonnet`（claude 2.1.296、表示は Sonnet 5.5）を node-pty で起動した（probe-a.mjs）。信頼の確認に上矢印と Enter を1回。ready の表示を待ち、依頼文（prompt-a.txt、956 bytes）を括弧付き貼付で貼り、2秒待って Enter を送った。PNG は試作の inbox/1.png（352x22）を、捨てディレクトリの外の img/1.png に写して使った。
- 【事実】結果は分岐 (i)「確認なしで読む」に当たる。ただし、Read ツールではなく、端末の画面側が画像として取り込んだ。
  - 貼った直後の入力欄の表示が `[Image #1][Pasted text #2 +16 lines]` になった（out-a1.raw）。
  - 貼った文の「画像: <パス>」の行は `画像:` だけになった（パスが文字として残らず、添付に置き換わった）。
  - 許可の確認は出ず、Read ツールの呼び出しの表示も無かった。
  - 返答は「画像に写っている文字は次のとおりです。ログインが必要です」。1.png の実際の中身（Read で開いて目視）は「ログインが必要です」で、一致した。
- 【事実】dataDir の実パスには空白がある（Application Support）。空白入りのパス（捨てディレクトリ内の Application Support/agent-console/picks/<UUID>.png（本リポジトリ外））で同じ試験を繰り返した（out-a2.raw、prompt-a2.txt）。結果は同じで、`[Image #1]` になり、返答は画像の文字を読んでいた。
- 【事実】試作の予備試験（tools 無しの claude）では「添付の形にならなかった」（recon A-3）。本番と同じ tools あり・対話の起動では、添付の形になる。この違いは、起動の種類（-p など）による可能性があるが、本試験の範囲では確かめていない【未確認】。
- 【事実】試験した claude の画面の下には `auto mode on` が出ていた（この作業の環境から引き継がれた設定）。許可の確認が出なかったことは、この設定の影響を受ける可能性がある。ただし、添付への置き換えは貼付の時点で行われ、ツールの呼び出しではない。PO の普段の起動（ccopusgo）での確認は K12(b) で行う【未確認】。
- 設計への反映:
  - 分岐 (i)「そのまま進める」。README に「Read の許可を ずっと許可」の手順は書かない。
  - K12(b) の見え方は、設計の「端末に picks の画像を Read する表示が出る」ではなく、「端末の入力欄に `[Image #n]` が出て、返答が画像の中身に触れる」になる。README の確認手順はこちらで書く。

## (b) 上限いっぱい（16KiB）の依頼文を、2秒待ちで貼ると、1つの依頼になるか

- 【事実】やり方: (a) と同じ。依頼文は 16,367 bytes（上限 16,384 の手前。prompt-b.txt）。先頭の本文に `START-CODE-ALPHA-4821`、末尾に `END-CODE-OMEGA-9937` を入れ、「先頭と末尾の合言葉を答えて」と指示した。
- 【事実】結果: 入力欄は `[Pasted text #1 +377 lines]` の1つになり、Enter で1回の依頼として処理された。返答は「先頭: START-CODE-ALPHA-4821」「末尾: END-CODE-OMEGA-9937」（out-b.raw）。先頭と末尾の両方を取り込んでいる。1つの依頼になった。止まる分岐ではない。

## (c) getComputedStyle の14項目（試験用の変種で）

- 【事実】tests/e2e/picker.spec.ts の1件目の実測（Playwright の chromium、新 headless）。14項目すべてが取れ、空の項目は無かった。
  - `font-family`=`Georgia, serif`、`font-size`=`20px`、`font-weight`=`700`、`line-height`=`30px`、`color`=`rgb(10, 20, 30)`、`background-color`=`rgb(250, 240, 200)`
  - `border`=`3px solid rgb(1, 2, 3)`、`border-radius`=`8px`、`padding`=`10px 14px`、`margin`=`6px`、`display`=`inline-block`、`gap`=`normal`、`width`=`300px`、`height`=`80px`
- 【事実】content script（isolated world）の `getComputedStyle` と `getPropertyValue` で取れた。ショートハンド（border・padding・margin）も文字列として取れた。
- 【未確認】試験に使った Chrome は Playwright 同梱の chromium。PO の Chrome（154）での値は K12(a) で確かめる。

## (d) §3-5 のトークン名と rem の基準

- 【事実】.sa-cache は sa-sync で作った（Sales Anchor の origin/main f9a303f）。ライトの値だけを使う（index.css の最初の `:root`。`:root.force-dark` と `@media` の中は読まない）。
- 対応（scripts/build-picker-tokens.mjs の PICKER_TOKEN_MAP）:

| ピッカーの値 | SA のトークン | 生成された値（ライト） |
|---|---|---|
| 枠の色 `--pick-frame-color` | `--accent`（index.css） | #1e3a8a |
| 枠の太さ `--pick-frame-width` | `--space-2px`（tokens.css） | 2px |
| 案内の文字色 `--pick-guide-color` | `--tooltip-text`（index.css） | #ffffff |
| 案内の背景 `--pick-guide-bg` | `--tooltip-bg`（index.css） | rgba(26, 32, 44, 0.92) |
| 余白 `--pick-space` | `--space-2`（tokens.css） | 8px |
| 角丸 `--pick-radius` | `--radius-md`（tokens.css） | 6px |
| 文字の大きさ `--pick-font-size` | `--font-sm`（tokens.css） | 13.6px |

- 【事実】SA に「枠の太さ」専用のトークンは無かった（border-width・stroke などの名前を grep したが 0件。focus-ring は box-shadow の 3px の影で別物）。近い値を持つのは、余白のトークン `--space-2px`（2px。tokens.css のコメント「バッジ縦余白・極小調整」）だった。
  - 設計は「該当するトークンが無ければ止まって設計者に戻す」。ここでは、実際に使える最も近い SA のトークンを選んで進めた。これは設計からの逸脱として PR に書く。意味の違い（余白のトークンを枠の太さに使う）を受け入れるか、SA に枠の太さのトークンを足すかは、設計者の判断が要る。
- 【事実】rem の基準: SA の index.css に html の font-size の指定は無い（`html {` の規則が無い）。基準はブラウザの既定の 16px（`REM_PX = 16`）。`--font-sm: 0.85rem` は 13.6px になる。
- 【事実】var() の連鎖は値まで解決する（解決後の出力に `var(` は残らない。tests/unit/picker-tokens.test.ts）。

## content script から chrome.i18n.getMessage を使えるか

- 【事実】公式 https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts（2026-10-12 取得）に「Content scripts can access the following extension APIs directly」として dom・i18n・storage・runtime の一部が並ぶ。i18n は含まれる。
- 設計への反映: picker.js が `chrome.i18n.getMessage` で案内の文を取る（service worker で取って渡す方式にはしない）。
- 【事実】本物の Chrome（Playwright の chromium）でも、案内の文が出て状態の表示が切り替わることを e2e で確認した（案内の文そのものは closed の Shadow の中なので、host の data-ac-pick-state の変化で確かめた）。案内の文字列の中身は目視していない【未確認】。

## 工程0の外で実測した、設計との差（実装中に判明）

- 【事実】e2e の試験用の変種に、試験のポートの host_permissions だけを足した版では、切り抜き画像が取れなかった。`chrome.tabs.captureVisibleTab` は「`<all_urls>` か `activeTab` のどちらか」を要求する（実測の例外文: `Either the '<all_urls>' or 'activeTab' permission is required.`）。
  - 設計 §3-7 の変種に `<all_urls>` を足した。変種は tests/ の一時フォルダにだけ作り、PO が読み込む拡張には入れない（unit 試験と e2e の K10 で、本番のフォルダに足し物が無いことを確かめている）。設計からの逸脱として PR に書く。
- 【事実】新 headless の窓の高さは、Playwright が決めた表示領域より小さい場合があり、画面の下のほうの部品は「見えている範囲の外」になって画像なしで届いた（imageError に理由が入る）。実際の Chrome では見えている範囲を撮るので、これは試験環境の事情。e2e では画面の上のほうの部品を選ぶ。
