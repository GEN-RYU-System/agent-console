# footer-layout recon（現在地の事実。origin/main d46d365・v0.35.0 時点）

- フッター: `src/pages/ConsolePage.tsx:601-630`。sa-source(602)・app-version(605)・commit(608、空でないときだけ)・claude-version(613)・AccountBadge(616)・account-error(617)・UsageMeter(622)・メモリ(623)・ThemeToggle(626)・ログアウト(627) が横に並び折り返す。
- フッター CSS: `src/pages/ConsolePage.css:48-58`（flex・flex-wrap: wrap・gap・font-size var(--font-xs)・color var(--text-muted)）。ページは grid で footer は 3 列全部を使う（`src/pages/ConsolePage.css:1-11`）。
- AccountBadge: `src/components/AccountBadge/AccountBadge.tsx:45-71`、CSS `src/components/AccountBadge/AccountBadge.css:1-23`（横並び）。
- UsageMeter: `src/components/UsageMeter/UsageMeter.tsx:116-122`（行は :40-59）、CSS `src/components/UsageMeter/UsageMeter.css:1-36`（flex）。フッターでしか使われない（`src/pages/ConsolePage.tsx:45`・`:622`）。
- アプリ固有トークン: `src/tokens.app.css:10-11`（`--ac-tab-h: 56px` が前例）。lint は `scripts/check-design-governance.mjs`（`package.json` の `lint`）。
- e2e: 画面幅 1400×800（`playwright.config.ts:36`）。`tests/e2e/console.spec.ts:238-296` が testid を見て、`AC_USAGE_SHOT_DIR` 指定時に幅ごとのスクリーンショットを保存。
- 実測（変更前、1400×800）: フッター高さ 124.1875px（値なし・週41%5時間23%）、125.84375px（週97%5時間85%）。`evidence/footer-height-before.json`。
- 環境の注意: 本店の node_modules・.sa-cache は古く、worktree では `npm ci` と `npm run sa-sync` が要る。
