# recon: v0.3.4 よく使う指示の並び替え

基準: origin/main 4407665（変更前）。行番号は変更前のもの。

## 既存 ADR
- ADR は SA 側（docs/adr/）。本アプリでは設計の対象 ADR として ADR-067（デザイントークン）、ADR-144（UIガバナンス）を design.md に記載。並び替えに固有の ADR は未確認。

## store と直列キュー
- /Users/tanizawashingo/agent-console-wt/quick-reorder/server/quick-prompts.ts:54 class QuickPromptStore（1 ファイル、書込は一時ファイル→rename、権限 600）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/server/quick-prompts.ts:57 queue（直列キュー本体）、:63 serial()（全操作がここを通る）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/server/quick-prompts.ts:81 save()（mkdir 700、tmp 書込 mode 600、chmod、rename）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/server/quick-prompts.ts:121 remove()（find→save の既存形。move は同じ形で追加する）
- 並び順は items の配列順のみ（順番用の項目は無い）

## http の quick-prompts API
- /Users/tanizawashingo/agent-console-wt/quick-reorder/server/http.ts:166 GET /api/quick-prompts、:170 POST、:175 promptMatch（PUT/DELETE）
- すべて handleDailyUse 内（認証・Origin 検査の内側）。SessionInputError→400、SessionNotFoundError→404 は /Users/tanizawashingo/agent-console-wt/quick-reorder/server/http.ts:346,350 で変換済み

## 画面
- /Users/tanizawashingo/agent-console-wt/quick-reorder/src/components/QuickPrompts/QuickPromptEditor.tsx:37 run()（busy→task→onChanged→reset）。move ではフォーム入力を消さないため keepForm を追加する
- /Users/tanizawashingo/agent-console-wt/quick-reorder/src/components/QuickPrompts/QuickPromptEditor.tsx:67 prompts.map（行の描画。index を使う）、:75 編集ボタン（Button 金型 outline/sm）

## API クライアント
- /Users/tanizawashingo/agent-console-wt/quick-reorder/src/api.ts:58-64 fetch/create/update/deleteQuickPrompt。move を追加する

## i18n
- /Users/tanizawashingo/agent-console-wt/quick-reorder/src/locales/ja.json:88-107 ac.quick.*。en.json は本アプリに存在しない（ja のみ。ja.json にキー追加）

## 既存の試験
- /Users/tanizawashingo/agent-console-wt/quick-reorder/tests/unit/quick-prompts.test.ts:9-62（store）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/tests/unit/daily-use.integration.test.ts:207-247（API）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/src/components/QuickPrompts/QuickPromptEditor.test.tsx:24-60（画面）
- /Users/tanizawashingo/agent-console-wt/quick-reorder/tests/e2e/console.spec.ts:471-（登録・編集・削除）

## 版の置き場所
- /Users/tanizawashingo/agent-console-wt/quick-reorder/package.json:3、/Users/tanizawashingo/agent-console-wt/quick-reorder/package-lock.json:3 と :9、/Users/tanizawashingo/agent-console-wt/quick-reorder/src/pages/ConsolePage.test.tsx:13 と :142、/Users/tanizawashingo/agent-console-wt/quick-reorder/README.md:32
