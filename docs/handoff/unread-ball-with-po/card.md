---
mode: handoff
---
# 実装カード: 未読の印は「PO の番で止まっている窓」だけに付ける（v0.50.0）

親: [design.md](./design.md)（第6版 cd8d845。§3 対象・§4 変更・§6 受入条件 K1〜K7・§9 測り方）

この文書は何か: agent-console の「未読」の印を、AI が自分で続きを始める予定が無い・許可や選択の画面・失敗で止まった窓にだけ付け、AI が自分で再開したら消すように直す作業指示です。

- 状態: 設計 第6版 審査 APPROVE（cd8d845・クラウドの Opus 審査役 2026-11-01）・PO 決定「1」と「3も」（2026-11-01）・PO 実装承認 済（2026-11-01「このセッションだけで最後まで完結させる…PRマージ、デプロイまで完走させてくれ」「未読の印の次の段へ進める」）・クラウドの Sonnet へ実装依頼
- 担当: Sonnet（クラウドで実装〜push まで）。PR の起票・審査・マージ・この Mac への導入・導入後の K1・K5・K6 の測定は Opus。
- 土台: origin/main ff59975（v0.49.0）。設計の行番号はこの版のもの（第6版の審査で照合済み）。

## 読んだ節と照合（Opus、2026-11-01）

- 前の段のカード docs/handoff/unread-on-reply/card.md と同じ形にした。プレースホルダを残さない・触るファイルを §1 で全部挙げた・PR は Opus が起票（Sonnet は push まで）。
- 決まり（S1〜S5・C1〜C2・`promptKey`）と §4-5 の表 n1〜n25 は design.md を正本とし、このカードに写し直さない。このカードは、触るファイル・順番・確かめ方・止まる条件と、審査の推奨で決めた細かい点（§2 の4）だけを決める。
- 受領確認: 着手前に、報告の1行目へ「受領確認: unread-ball-with-po card を読んだ」と書く。

## 1. 作るもの・触らないもの

触る（design.md §3 の「対象」と同じ。これ以外は触らない）:

1. `hooks/activity-hook.mjs`（Stop の記録に `bg_tasks`・`bg_types`・`crons_once`・`crons_repeat`・`cron_once_hashes`・`cron_repeat_hashes`。`promptKey`）
2. `server/activity.ts`（`TurnEndEvent.pendingSelfResume`・`SessionState.cronPromptKeys`・`resumeTs`・`applyPrompt` の最初で `onSelfResume`・`onSelfResume` の口・`TEXT_CONTROL_CHARS` と `fullText` と `promptKey` の写し）
3. `server/hub.ts`（:245 で `pendingSelfResume` を渡す・`onSelfResume` を窓に結ぶ・保留・`detectBreaks` で `sweepStale`・:627 の `observe` に `this.now()`・`watchActivity` の型）
4. `server/notify.ts`（`BreakTracker` を design §4 に変える。`addSelfResume`・`sweepStale`・`observe` の4つ目の引数・`TurnEnd.pendingSelfResume`）
5. `src/locales/ja.json:180`（`"未読"`）
6. `src/components/SessionList/SessionList.tsx`（印の言葉の呼び出しから count を外す）
7. 試験: `tests/unit/notify.test.ts`・`tests/unit/activity.test.ts`・`tests/unit/activity-hook.test.ts`・`tests/unit/daily-use.integration.test.ts`・`src/components/SessionList/SessionList.test.tsx:123`
8. 新規: `scripts/measure-unread.mjs`（design §9。読むだけで何も書かない）
9. 文書: `README.md:295`・`docs/handoff/unread-on-reply/design.md` の冒頭に1行・`docs/CHANGELOG.md` に1行（戻し方を含む）
10. 版: 0.49.0 → 0.50.0（`package.json`・`package-lock.json`・`extension/manifest.json`）

触らない: `server/ws.ts`・`server/http.ts`・`server/activity-hooks.ts`・`src/pages/ConsolePage.tsx`・`src/pages/ConsolePage.test.tsx`・`server/launch.ts`・`server/relay.ts`・`server/agents.ts`・ほかのすべて。macOS の通知の判定 `isBreak` は変えない。

## 2. 進め方（順番どおり）

1. `git log -1 origin/main` が ff59975 か、ff59975 を含むことを確かめる。design.md §2・§3 の行番号のうち、§1 の1〜6のファイルの行が5行以上ずれていたら `BLOCKED:` に続けてずれたファイルと行番号。
2. 試験を先に書く。design.md §4-5 の表 n1〜n25 は1行ずつ notify の単体試験にする（期待の数と印の種類は表のまま）。K3（欄あり・欄なし・配列でない の3本）・K4（「未読」を含み数字を含まない）・§4-6 の「同じ文を hook と server に通して同じ値になる」試験も書く。流して落ちることを確かめる。
3. design.md §3・§4 のとおりに実装する。設計に書いていない決まりを足さない。設計で決まっていないことに当たったら `NEEDS_DECISION:` に続けて、どこの何が決まっていないか。
4. 審査の推奨で決めた細かい点（2026-11-01 Opus の決定。設計の決まりは変えない）:
   - (a) `onChange` は実物では server/hub.ts:230-234（設計の :229-233 は1行ずれ）。中身は変えない。
   - (b) 保留の型 server/hub.ts:135 の `pendingTurnEnds` の要素を広げる。`kind: "turnEnd" | "selfResume"` と `pendingSelfResume: boolean | null` を足す（AI の再開の要素では `failed: false`・`stopHookActive: false`・`pendingSelfResume: null` を入れる）。`reviewPendingTurnEnds` は `kind` を見て `addTurnEnd` か `addSelfResume` を呼ぶ。
   - (c) ハッシュの上限: `cron_repeat_hashes` だけで20個を超えたら `session_crons` の並び順で先頭の20個を残し、`cron_once_hashes` は `[]` にする。`background_tasks` と `session_crons` の片方だけ欄があるとき: 欄がある方は数とハッシュを書き、無い方の欄は書かない。`pendingSelfResume` は、2つの欄がどちらも無ければ null。どちらかでもあれば、ある方で `bg_tasks ≥ 1` か `crons_once ≥ 1` なら true、それ以外は false。
   - (d) `src/pages/ConsolePage.test.tsx:330` の `unread: 2` は作り物のデータで、今のまま通るので触らない。
5. 文書と版を直す。
6. 確かめ: `npm run typecheck`・`npm run lint`・`npm test`・`npm run build`・`npm run test:e2e`。どれも通る（K2・K3・K4・K7）。結果の最後の行を報告に書く。
7. `node scripts/measure-unread.mjs --help` が使い方を出して 0 で終わる。ほかに何も書かないことを、試験の記録を1つ作って流して確かめる。

## 3. 停止する条件

- §2 の1でずれた → `BLOCKED:`。
- 既存の試験が今回の変更の前から落ちている → 落ちている試験の名前を書いて `NEEDS_DECISION:`。
- design §4-5 の表の数と試験の結果が合わない → 推測で設計を変えず `NEEDS_DECISION:` に続けて表の行と数。
- v0.49.0 の row1〜row14 のどれかが新しい決まりで落ちる → 期待を書き換えず `NEEDS_DECISION:` に続けて行の名前。

## 4. 終わりの条件

- §2 の6・7がすべて通る。
- `git diff --name-only origin/main...HEAD` が §1 のファイルと docs/handoff/unread-ball-with-po/ だけ。
- 枝 `release/unread-ball-with-po` に push 済み（設計の docs と同じ枝）。PR は作らない。
- 報告の最後の行は `DONE` / `BLOCKED:` ＋理由 / `NEEDS_DECISION:` ＋内容 のどれか。

## 5. Opus がすること（Sonnet はしない）

- PR の起票・審査役（opus）の審査・CI の確かめ・マージ・この Mac への導入（README の更新の手順）。
- 導入の後、画面を読み込み直して印が1つ・言葉が「未読」だけになったことを確かめる。導入から Stop 10 件以上たったら K1 を、24 時間（足りなければ72時間）たったら K5・K6 を `measure-unread.mjs` で測る。K1 で欄が入っていなければ design §5 のとおり止まって設計を見直す。

## 6. カードの自己審査（2026-11-01 Opus。同じ AI による自己審査）

- 判定: APPROVE
- 設計との整合: 触るファイルは design §3 と同じ。試験は §4-5 の表と §6 の検証方法をそのまま期待値にした。決まりの正本は design §4 の1か所。§2 の4は審査の推奨への答えで、design の決まりは変えていない。
- 残る未確認: design の【未確認】（この版で2つの欄が入るか・ScheduleWakeup の文が再開の本文になるか・間隔を決めた /loop が CronCreate を使うか）は、導入後の K1 で確かめる。

END OF CARD
