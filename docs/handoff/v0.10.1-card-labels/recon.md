# v0.10.1 セッション一覧カードの表示整理 recon 要点（origin/main 391b6093 基準）

元の調査: /tmp/CC報告ファイル/agent-console-status/recon.md・recon2.md。フルパスは /Users/tanizawashingo/agent-console-wt/card-labels 配下（リポジトリ内の相対で記す）。

## 版・位置の依頼
- PO が使っているのは v0.9.1。「位置の変更」は v0.10.0（PR #24）に入っていて未導入。docs/handoff/layout/design.md:8 に承認の記録。

## 描画（変更前）
- src/components/SessionList/SessionList.tsx:98-140 選択ボタン、:112-118 未読バッジ（1段目）、:120-139 2段目（役割・状態バッジ・CI バッジ・予約名）、:141-152 鉛筆、:105-107 ダブルクリック（stopped 以外 onRename）、:71-77 handleKeyDown（Alt+↑↓）、:2 Pencil import。
- src/components/StatusDot/StatusDot.tsx:5-12 STATE_LABEL_KEY。src/pages/ActivityPane（ActivityPane.tsx:10,120）の「今の状態」も同じキー。
- src/locales/ja.json:23-25 ac.state、:90 notifyHelp、:92 rename.open（鉛筆専用: git grep rename.open は SessionList.tsx:146-147 と試験のみ）、:95 hintClaude、:98 queueBody、:201 routines.outcomes.waiting（別画面・据え置き）。locales は ja.json のみ（src/i18n.ts:3-4,19）。
- server/notify.ts:24 STATE_LABEL（macOS 通知）。判定 isBreak :9-11 は不変。
- 状態判定 server/agents.ts:90-99（busy→working、waiting→waiting、idle→idle）。変更しない。

## 試験で触る箇所
- src/components/SessionList/SessionList.test.tsx（K2・offers rename・line1/line2・STATE_LABEL・K3）
- tests/unit/notify.test.ts:36-37、tests/unit/daily-use.integration.test.ts:98、tests/e2e/console.spec.ts:464,488-545,1362-1380

## 版に連動して直す物（設計に列挙が無かったが、版の試験が要求）
- extension/manifest.json:4（tests/unit/picker-extension.test.ts:46 が package.json の version と一致を検査）。package-lock.json:3,9（過去の版上げ a5e6222 でも同じ）。

## 競合
- release/chat は package.json:3 と docs/CHANGELOG.md:5 で競合する見込み（chat 側が後から追従）。
