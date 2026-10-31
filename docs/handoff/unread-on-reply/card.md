---
mode: handoff
---
# 実装カード: 返事が来たら未読を付け、PO が送るまで消さない（v0.49.0）

親: [design.md](./design.md)（第4.1版。§4 変更・§7 受入条件 K1〜K17）

この文書は何か: agent-console の「未読」の印を、Claude が PO の返事を待つたびに付け、PO がその窓で何か送るまで消さないように直す作業指示です。

- 状態: 設計 第4版 審査 APPROVE（第4.1版で注記5件を反映）・PO 決定「1」（その窓で送ったら消す）・PO 実装承認 済（2026-11-01「このセッションだけで最後まで完結させる…PRマージ、デプロイまで完走させてくれ」）・クラウドの Sonnet へ実装依頼
- 担当: Sonnet（クラウドで実装〜push まで）。PR の起票・審査・マージ・この Mac への導入・実機の確かめ K17 は Opus。
- 土台: origin/main de28ba7（v0.48.1）。設計の行番号はこの版のもの。

## 読んだ節と照合（Opus、2026-11-01）

- Sales Anchor の docs/handoff/design-partner-card-ops/guards/00-common.md・03-file.md・05-pr.md・10-executor.md: プレースホルダを残さない・触るファイルを §1 で全部挙げた・PR は Opus が起票（Sonnet は push まで）・散文で組み立てを頼まず設計の決まりと期待値を指した。○
- design.md §2 の行番号は origin/main de28ba7 で Opus が確かめたもの（第4版の審査でも照合済み）。
- 設計の決まり R1〜R5・保留・消す口は design.md §4-1・§4-2 を正本とし、このカードに写し直さない（2か所に分けないため）。このカードは、触るファイル・順番・確かめ方・止まる条件だけを決める。
- 受領確認: 着手前に、報告の1行目へ「受領確認: unread-on-reply card を読んだ」と書く。

## 1. 作るもの・触らないもの

触る（design.md §3 の「対象」と同じ。これ以外は触らない）:

1. `server/notify.ts`（R1〜R5・窓ごとの状態・`clear`・`addTurnEnd`・保留）
2. `server/activity.ts`（`onTurnEnd`・`startedAt`・（会話番号, ts）の組を `SessionState` に500個まで）
3. `server/hub.ts`（`watchActivity` の型・`now` の注入・`observe` に waitingFor・保留の見直しと捨て方・`clearUnread`・`markRead` の中身・`enqueueChat` で消す）
4. `server/ws.ts`（`attachTerminal` に `onSubmit` を渡し、`\r` を含む入力で `sessions.write` の前に呼ぶ）
5. `src/pages/ConsolePage.tsx`（:219-223 の自動既読と :232 の選んだら既読を削る）
6. 試験: `tests/unit/notify.test.ts`・`tests/unit/activity.test.ts`・hub の結合試験（既存のファイルに足す）・`src/pages/ConsolePage.test.tsx:339-344`・`tests/e2e/console.spec.ts:612-650` の書き換え
7. 文書: `README.md:295`・`docs/handoff/stage2/design.md:14`・`:32`・`docs/CHANGELOG.md`（:5 の形で1行。戻し方を含む）
8. 版: 0.48.1 → 0.49.0（`package.json:3`・`package-lock.json`・`extension/manifest.json:4`）

触らない: `hooks/activity-hook.mjs`・`server/http.ts`・`server/activity-hooks.ts`・`src/locales/ja.json`・`server/launch.ts`・`server/relay.ts`・`server/agents.ts`・ほかのすべて。macOS の通知の判定 `isBreak` は変えない。

## 2. 進め方（順番どおり）

1. `git log -1 origin/main` が de28ba7 か、de28ba7 を含むことを確かめる。design.md §2 の行番号のうち、§1 の1〜5のファイルの行が5行以上ずれていたら `BLOCKED:` に続けてずれたファイルと行番号。
2. 試験を先に書く（design.md §7 の K1・K3〜K8・K10〜K13・K15・K16 の「検証方法」の欄の数を、そのまま期待値にする。§4-1 の表の14行は、1行ずつ notify の単体試験にする）。流して落ちることを確かめる。
3. design.md §4-1・§4-2 のとおりに実装する。設計に書いていない決まりを足さない。設計で決まっていないことに当たったら `NEEDS_DECISION:` に続けて、どこの何が決まっていないか。
4. 文書と版を直す。
5. 確かめ: `npm run typecheck`・`npm run lint`・`npm test`・`npm run build`・`npm run test:e2e`。どれも通る（K9・K14）。結果の最後の行を報告に書く。

## 3. 停止する条件

- §2 の1でずれた → `BLOCKED:`。
- 既存の試験が今回の変更の前から落ちている → 落ちている試験の名前を書いて `NEEDS_DECISION:`。
- 設計の §4-1 の表の数と、試験の結果が合わない → 推測で設計を変えず `NEEDS_DECISION:` に続けて表の行と数。

## 4. 終わりの条件

- §2 の5がすべて通る。
- `git diff --name-only origin/main...HEAD` が §1 のファイルと docs/handoff/unread-on-reply/ だけ。
- 枝 `release/unread-on-reply` に push 済み（設計の docs と同じ枝）。PR は作らない。
- 報告の最後の行は `DONE` / `BLOCKED:` ＋理由 / `NEEDS_DECISION:` ＋内容 のどれか。

## 5. Opus がすること（Sonnet はしない）

- PR の起票・審査役（opus）の審査・CI の確かめ・マージ・この Mac への導入（README の更新の手順）。
- 導入の後、画面を読み込み直して K1・K2・K4 を実機で確かめ、K17 (a)〜(e) を記録する。(b)・(c)・(e) が × なら、直すかを PO に聞く。

## 6. カードの自己審査（2026-11-01 Opus。同じ AI による自己審査）

- 判定: APPROVE
- 設計との整合: 触るファイルは design §3 と同じ。試験は §7 の検証方法をそのまま期待値にした。決まりの正本は design §4 の1か所。
- 残る未確認: design §6 の未確認（返事の終わりが idle か waiting か・数字キーでの応答・答えた後の戻り 等）は K17 で実機で取る。

END OF CARD
