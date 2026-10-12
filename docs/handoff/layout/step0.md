# step0: 実装前の実測（画面の並べ方 v0.10.0）

SA の金型・トークンは sa-sync した .sa-cache（SA main 63340e9a16e5303692bc8bc0efbf0912cce8a820、本リポジトリ外）から読んだ。

## 余白・文字のトークンの実在（design.md 3-1）
コマンド: `grep -n "^\s*--space-6:\|^\s*--font-2xl:\|^\s*--comp-tab-h-sm:\|^\s*--font-xs:" .sa-cache/frontend/src/tokens.css`

```
14:  --font-xs:            0.75rem;    /* 12px   — バッジ・フッタ */
20:  --font-2xl:           1.5rem;     /* 24px   — KPI値・大見出し */
73:  --space-6:  24px;
529:  --comp-tab-h-sm:  28px;                    /* sm — KartePanel 系（font-xs） */
```

- 余白は --space-6（24px）を使う（実在を確認）。
- 件数の印（SA の Badge）の文字は --font-xs（12px、Badge.css:18）。SA の共通トークンは上書きしないので、印の大きさは変わらない。
- 右の欄のタブは size="sm" のまま（高さ --comp-tab-h-sm = 28px）。変えない。

## 直書きの値
- 直書きは src/tokens.app.css の `--ac-tab-h: 56px` の1か所だけ。src/pages/ConsolePage.css は `var(--ac-tab-h)` で参照するだけ。

## 着手の条件（design.md 2）
- v0.7.0・v0.8.0・v0.9.x が main にマージ済みの 807e9fa（v0.9.1）から作業した。recon の行番号は 838507f〜cee6737 時点のもの。実装時に、StatusDot の STATE_LABEL_KEY（src/components/StatusDot/StatusDot.tsx）が export 済みであること、中央のタブが端末・変更・PR・部品・定期タスクの5つであること（src/pages/ConsolePage.tsx）を読んで確かめた。
