# v0.2.1 recon（テーマ切替）

調査対象は Sales Anchor の origin/main（1af58612ed97、`git show origin/main:<path>`）。

## 既存 ADR の検索結果
- ADR-033（アプリ内テーマ切り替え）: `docs/adr/` で `git grep -i theme` 相当。SA の frontend/src/contexts/ThemeContext.tsx:2 が ADR-033 を参照。
- ADR-067（デザイントークン）、ADR-144（UI ガバナンス）: 金型を使い、直値を持たない。

## 事実
- 切替の仕組み: `<html>` の `force-dark` クラス。frontend/src/contexts/ThemeContext.tsx:52-60（add / remove）。CSS は frontend/src/index.css:220 `:root.force-dark`。
- 保存: cookie `theme=light|dark`（有効 1 年、path=/、SameSite=Lax）frontend/src/contexts/ThemeContext.tsx:41-49。サーバー同期は `/staff/me`（:79）と `/staff/me/theme`（:101）。
- 初期値: `readThemeCookie() ?? "light"`、OS の prefers-color-scheme は無視 frontend/src/contexts/ThemeContext.tsx:64（コメント :6）。
- 依存: `../lib/api`（:30）と `useAuth`（:31）。Provider なしの `useTheme()` は空実装を返す（:21-24）。frontend/src/contexts/UiPrefsContext.tsx:128-130 はクラス操作を ThemeContext に委譲している。
- UI: SA のテーマ切替は frontend/src/components/DesktopShell.tsx:464-472 の `<button className="user-drawer-action">`。金型 frontend/src/components/IconToggleButton.tsx（pressed / iconOff / iconOn / aria-label 必須）。アイコンは frontend/src/constants/icons.tsx:238 `THEME_ICONS`。文言は SA の辞書 `nav.switchToDark` / `nav.switchToLight`（frontend/src/locales/ja.json:266-267）。
- agent-console 側: 端末は MutationObserver で `<html>` の class 変化に追従する（src/components/TerminalPane/TerminalPane.tsx:47-54）。CSP は server/http.ts:220。

## 判断
- SA の ThemeProvider は SA の認証と API に依存するため import 不可。規則（キー名 `theme`・値 `light|dark`・クラス `force-dark`・初期値 light）だけを薄く再実装する（src/theme.ts）。
- 保存は cookie でなく localStorage（設計者決定 2026-10-11）。理由: 127.0.0.1 の Cookie はポートで分離されず、段階1.5 で Cookie を全廃した設計と一貫させる。localStorage はオリジン（ポート）単位。
