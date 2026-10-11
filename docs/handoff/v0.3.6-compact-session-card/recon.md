# recon: v0.3.6 左のセッション一覧のコンパクト化

調査日: 2026-10-11 / 基準: origin/main 66aef88 / SA 展開元: 252d9e3e6b77fc510c18f4e487a5ec989cec6ff3（.sa-cache/SOURCE）
既存 ADR 検索: 設計の対象 ADR は ADR-067・ADR-144（design.md 冒頭）。本リポジトリ内に docs/adr/ は無い（SA 側 ADR）。

## 1. 変更前（フルパス:行番号）
- /Users/tanizawashingo/agent-console-wt/compact-card/src/components/SessionList/SessionList.tsx:32-73 — Card(density="compact") の中に ghost Button（名前・役割・状態の3段）と下段の操作ボタン。
- /Users/tanizawashingo/agent-console-wt/compact-card/src/components/SessionList/SessionList.tsx:41-47 — 選択ボタン（aria-current は選択中のみ "true"）。
- /Users/tanizawashingo/agent-console-wt/compact-card/src/components/SessionList/SessionList.tsx:61-72 — rename（ghost sm・state!==stopped）/ remove（outline sm・stopped）。
- /Users/tanizawashingo/agent-console-wt/compact-card/src/components/SessionList/SessionList.css:1-41 — 縦並び（flex-direction: column）、.ac-session--selected は border-strong / bg-active。
- /Users/tanizawashingo/agent-console-wt/compact-card/src/components/SessionList/SessionList.test.tsx:1-69 — 既存の単体試験6件（getByText("名前を変える") 等の文言検索あり → アイコンボタン化で getByRole(name) に更新）。
- /Users/tanizawashingo/agent-console-wt/compact-card/tests/e2e/console.spec.ts:100,105,116,154-158,393 — session-row / status / unread-badge / 名前を変える / 一覧から外す を data-testid・role+name で参照（維持）。
- /Users/tanizawashingo/agent-console-wt/compact-card/src/pages/ConsolePage.test.tsx:13,142 — 版 0.3.5（0.3.6 へ）。

## 2. リスト行向けの SA 金型の有無（.sa-cache/frontend/src/components）
- ListRow.tsx / ListRow.css あり。結論: 使えない。
  - /Users/tanizawashingo/agent-console-wt/compact-card/.sa-cache/frontend/src/components/ListRow.css:32 — min-height: var(--min-height-conv-item)。値は /Users/tanizawashingo/agent-console-wt/compact-card/.sa-cache/frontend/src/tokens.css:273 で 92px → K1（64px 以下）を満たせない。ListRow.tsx:9 「行の高さ…は渡す側が上書きしない」。
  - /Users/tanizawashingo/agent-console-wt/compact-card/.sa-cache/frontend/src/components/ListRow.tsx:80-86 — onClick 指定時は行全体が <button>。右端に別ボタン（rename/remove）を置くと button の入れ子になる。data-testid / data-* を渡す口も無い。
- NavItemList.tsx / SubMenu.tsx / Tabs.tsx はナビ・タブ用で、状態・未読・右端操作の構成に合わない（ファイル名のみ確認）。
- 設計 §3 の代替（ghost Button(SA) + 右端の小さな Button(SA) を横に並べた行）を採用。

## 3. 使うトークン（定義箇所）
- --space-1(4px) / --space-2(8px): /Users/tanizawashingo/agent-console-wt/compact-card/.sa-cache/frontend/src/tokens.css:68-69
- --radius-md(6px): tokens.css:91
- --font-base / --font-xs: tokens.css:16 / :14
- --font-weight-semi: tokens.css:30
- --bg-surface / --bg-active / --text-primary / --text-secondary / --border / --border-strong（ライト）: /Users/tanizawashingo/agent-console-wt/compact-card/.sa-cache/frontend/src/index.css:17,20,23,24,28,29。ダーク: index.css:228,231,233,234,237,238
- 新トークンの追加なし。

## 4. 実測（変更前）
- 設計 §0: PO スクリーンショットで約 140px。変更後の実測は PR 本文・報告の K1 を参照。
