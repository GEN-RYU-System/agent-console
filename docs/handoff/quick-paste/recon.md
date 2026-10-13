# 現在地: 端末の上の「よく使う指示」が、押すとすぐ送られる

- 基準: origin/main f897ff6（v0.15.0）の実物。
- 依頼（PO 2026-10-13 原文）: 「よく使う指示だが選択すると自動で送信されてしまう、ボタンを押したら入力欄にペーストはするが自動送信されないように出来る？」→ 設計者の提案（端末タブの「よく使う指示」は貼るだけにして Enter を送らない）に PO「y」。

## 事実
- 端末の上のバーと、一覧（Modal）の「使う」は、どちらも `src/components/QuickPrompts/QuickPromptBar.tsx:41-42` の同じ処理を通る。onPick が無いときは `onSend(p.id)`。
- 端末の上のバーの配線: `src/pages/ConsolePage.tsx:359-365`（`canSend={activeSession?.canInput === true}`・`onSend={handleSendPrompt}`）。
- `handleSendPrompt`（`src/pages/ConsolePage.tsx:183-195`）は `checkQuickPromptSend` でサーバーに状態を取り直させ、返った本文を `terminalRef.current?.pasteAndEnter(checkedId, text)`（:191）で入れる。false なら `ac.quick.switched` を出す。
- `pasteAndEnter` は `src/components/TerminalPane/TerminalPane.tsx:18-25` で型を宣言、`:69-75` で実装: 表示中の端末が確認したセッションと違えば false、同じなら `term.paste(text)` の後に `term.input("\r", true)` を送る。**この `\r` が「自動で送信」の原因。**
- `pasteAndEnter` の呼び出し元は `src/pages/ConsolePage.tsx:191` の 1 か所だけ（試験の mock を除く）。
- `pasteSubmitAfter`（`src/components/TerminalPane/TerminalPane.tsx:76-85`）は変更タブ・部品タブ・チャットが使う別の口で、今回は触らない。
- チャットの入力欄の上のバーは、すでに `onPick`（入力欄に入れるだけ）で動く（`src/components/ChatPane/ChatPane.tsx:213`）。
- サーバーの `POST /api/sessions/:id/send-check`（`server/http.ts:276`）は本文を返すだけで、端末には書かない。作業中・確認の待ちは 409。
- 試験: `src/components/TerminalPane/TerminalPane.test.tsx:84-110`（pasteAndEnter）、`src/pages/ConsolePage.test.tsx:28,96-98,137,320,337,349,423`（pasteAndEnter の mock）、`tests/e2e/console.spec.ts:634-653`（バーを押すと端末に echo-quick-prompt-v2 が出る）。
- 文言: `src/locales/ja.json:139` `ac.quick.textHint`「ボタンを押すと、選択中の端末へこの文章と改行を送ります（8KB まで）。」、`README.md:139`「「使う」で選択中の端末へ送れ」「ボタンを押すと、選択中の端末へ文章と改行を送ります（8KB まで）」、`README.md:67`「「よく使う指示」「変更」「部品」の送信は、今までどおり（手すきのときに、その場で端末へ貼って送る）です。」。言語の辞書は ja.json だけ（en.json は無い）。

## 既存 ADR の確認
- ADR-027（i18n）: 文言は ja.json の鍵で出す。新しい文言は足さず、既存の `textHint` を書き換える。
- ADR-067・ADR-144（デザイン）: 画面の部品・見た目は変えない。

## 未確認
- なし。
