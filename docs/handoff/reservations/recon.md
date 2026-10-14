# 予約（日時を指定して1回だけ送る）— recon

## PO の依頼（原文）
- 「定期実行と別タブで予約機能を実装したいのだが実現可能か？日付と時間を指定して予約実行させられる機能、定期実行との差分はルーティンではなくスポットでの指示を予約させる」
- 寝ていた回の扱い:「起きたときに遅れて1回送るか」に「y」
- 「手動でもかけるしAIエージェントが書き込みもできるようにしてほしい」「配線とDBのSSOTは遵守してデータを分散させることは禁止」「デザイントークンとデザインシステムを遵守して、金型登録のないハードコードを禁止」
- 2026-10-14、セッション「Token消費の最適化」

## 基準
- origin/main f255892（#34 マージ、package.json 0.19.0）。導入済みは 0.17.0（`curl 127.0.0.1:4319/healthz` → version 0.17.0, commit df660d0）。
- 生出力: /tmp/CC報告ファイル/agent-console-reservation/recon-raw/（01〜08）

## 今の動き（事実）
### 定期実行（server/routines.ts、141行）
- 保存: dataDir/routines.json（VERSION=2、READ_VERSIONS=[1,2]）`server/routines.ts:9-23`。書き込みは `RoutineStore.save` が tmp＋rename・0600・`serial()` で直列化、書く前に read して壊れた内容は上書きしない `server/routines.ts:44-47`。
- 時計: 1秒ごとの tick `server/routines.ts:72`、`jstSlot` は Asia/Tokyo の曜日と HH:mm `server/routines.ts:50-54`。
- 発火: 分が完全一致のときだけ `server/routines.ts:95`。寝ていた・止まっていた回は追いかけない（試験 `tests/unit/routines.test.ts:148`「does not catch up」）。
- 二重送信防止: 送る前に lastSlot を保存、保存失敗ならその回は送らない `server/routines.ts:98-99`。
- 送り方: cwd 再検査→空き確認→新しいセッションを開く→Claude が入力待ちになるまで3秒おき最大120秒待つ→`hub.submitText`（括弧付き貼り付け＋2秒後に Enter）`server/routines.ts:114-140`、`server/hub.ts:391-399, 424-429`。
- 結果: outcome は sent / not_ready / full / cwd_invalid / failed `server/routines.ts:25-29`、最大100件 `server/routines.ts:110`。
- 入力検査: 名前1〜40字、指示8192字以下・制御文字不可、HH:mm、役割、cwd は classifyCwd、worktree 必須の役割は branch 必須 `server/routines.ts:78-87`。
- 配線: `server/index.ts:20,67,77,84,101`、API `server/http.ts:173-178`、`src/api.ts:148-151`、`src/types.ts:89-91`、画面 `src/pages/ConsolePage.tsx:55,381-388,448`。

### 認証（server/http.ts）
- `/api/*` は Bearer（サーバー秘密 または ペアリングで得たセッショントークン）`server/http.ts:388-401`。セッショントークンの状態変更は Origin 一致必須。Host が 127.0.0.1:<port> 以外は 421 `server/http.ts:372`。
- 認証前に通す例外: `/healthz`、`/api/pair*`、`POST /api/picks`（Chrome 拡張の合言葉 `dataDir/picker-token`、0600、本番ポートのときだけ作る）`server/http.ts:383-387`、`server/picker-extension.ts:1-60`。
- サーバー秘密で /api を叩く既存 CLI は見つからなかった（scripts・ops の grep）。

### AI が書く既存の経路（作戦ボード）
- `hooks/ac-board.mjs`（230行）を起動時に `dataDir/bin/ac-board.mjs` へ写す `server/activity-setup.ts:17-20,42-45`、`server/activity-start.ts:49`。
- ファイルへ直接書く（HTTP なし）。セッションは環境変数 CLAUDE_CODE_SESSION_ID、書込先 dataDir/boards/<UUID>.json。サーバーは読むだけ（書込口なし）`server/board-routes.ts:11-20`。
- ボードはセッションごとに1ファイルで書き手は1人。予約は「サーバーが状態を書き換える」ので、同じ方式だと書き手が2人（CLI とサーバー）になる。

### 画面・金型
- 定期実行の画面: `src/components/Routines/RoutinesPane.tsx`（55行）、`src/components/Routines/RoutineEditor.tsx`（29行）、`src/components/Routines/Routines.css`（13行）。部品は `@sa/components/` の Badge, Button, Callout, EmptyState, Modal, Select, Stack, Textarea, TextField。
- 時刻は TextField の文字入力（HH:mm）`src/components/Routines/RoutineEditor.tsx:22`。
- SA 金型の TextField は type に date を正式に含む（`.sa-cache/frontend/src/components/TextField.tsx:4`）。SA に専用の DatePicker / TimeInput 部品は無い。
- 生 input 禁止の検査は `src/pages/` 配下のみ（`scripts/check-design-governance.mjs:164-166`）。日本語直書き禁止は全 tsx（:168-176）。
- --ac- トークンは2つ（`src/tokens.app.css:9,11`）。文言は `src/locales/ja.json` のみ（en.json なし）。

### 試験・CI
- `tests/unit/routines.test.ts`（K1〜K11 ほか）、`tests/unit/session-restore.integration.test.ts:416-432`（K8）。画面試験なし。e2e はタブ並び `tests/e2e/chat.spec.ts:85` のみ。
- CI `.github/workflows/ci.yml`: typecheck → lint（設計ガバナンス含む）→ vitest → build → Playwright（ubuntu・macOS）。

## 進行中の作業（事実）
- PR #35（release/keep-sessions、v0.20.0、OPEN）が `server/index.ts`、`server/hub.ts`、`server/sessions.ts`、`src/pages/ConsolePage.tsx`、`src/types.ts`、`src/locales/ja.json`、README、CHANGELOG を触る。`server/routines.ts`・`hooks/`・`src/components/Routines/` は触らない。
- v0.18.0・v0.19.0 はタグ済み・未導入。K15（定期実行の実機確認）は未実施【未確認】。

## 既存の決め
- 定期実行（アプリのタイマーで指示を送る）は PO が 2026-10-13 に「残す」と決定済み（memory project_orca_selfbuilt_app）。予約は同じ仕組みの1回版として扱う。
- デザイン: SA の部品を土台にし、SA に無い大きさ・色だけ `src/tokens.app.css`（--ac-）に登録（PO y 2026-10-12）。
