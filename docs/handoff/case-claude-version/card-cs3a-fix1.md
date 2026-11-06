# 便CS3a 直し1 — 実装カード（マージ前審査の指摘への対応）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14（第12版）。親カード: docs/handoff/case-claude-version/card-cs3a.md（§2 の触らない範囲はそのまま守る）。
土台: release/case-claude-version-probe の 18fa8351b3a2f5b27735135a349dd0d2c226ec71。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## F1（MEDIUM-1）P3 は idle に戻ったことを条件にする
- 場所: server/case-say-probe.ts の P3 の `await idleWait(...)`（18fa835 で :446-448）。
- 変更: 戻り値を受け、false なら `throw new ProbeFailed("P3")`。P1・P2 と同じ扱いにする。ほかの判定は変えない。
- 試験: tests/unit/case-say-probe.test.ts に1件。偽の状態を文3の後 busy のままにする → 結果は × で failedCheck が "P3"。

## F2（MEDIUM-2）P2 の下請けの証拠を設計 P2 行のとおりにする
- 設計 P2 行の条件: PostToolUse の `tool: "Write"` で path が probe-2.txt に完全一致し、かつ agent_id が空でない記録がある。さらに、その agent_id の SubagentStart と SubagentStop がそれぞれ 1 以上ある。
- 場所: server/case-say-probe-wiring.ts の realProbePorts.agentEvidence（18fa835 で :99-106）。必要なら case-say-probe.ts の P2 の判定の受け方も直す。
- 材料は既存の物を読むだけにする。server/activity.ts・http.ts の handleCaseActivity・activity-hooks.ts は変えない（親カード §2）。
  - Write の記録: probe の受け口の記録（this.records。pre/post・tool・agent_id・path を持つか先に確かめる）か、activity の記録で道具の名前が取れる物。
  - SubagentStart／Stop の agent_id ごとの数: activity の既存の読み口から取る。
- 上の材料のどれかが既存の読み口で取れないときは、作らずに停止して NEEDS_DECISION:（何が取れて何が取れないかを file:line で書く）。
- 決定（Opus・1回目の NEEDS_DECISION への答え）。1回目の報告では、Write の path は ProbeToolRecord（case-say-probe.ts:32-39）に無く、agent_id ごとの開始・終了は activity.ts:188,192 の Map にあるが読み口が合計の sizes()（:599-602）だけだった。次のとおり作る。
  - Write の path: probe の受け口の記録を使う。`ProbeToolRecord` に `path: string`（無ければ ""）を足す。`toolRecordOf` は `tool_name` が "Write" のときだけ `tool_input.file_path` を文字列なら取る。ほかの道具では "" のまま。受け口は今までどおり runActivityHook に渡さない。
  - agent_id ごとの開始・終了の数: server/activity.ts に読み取りだけの口を1つ足す（例: `agentLifecycle(csid, agentId): { starts: number; stops: number }`。restarts・stops の Map から数を返すだけ）。親カード §2 の「activity.ts を触らない」の例外として、この1つの読み口だけを許す。記録の書き方・状態の形・既存の関数は1文字も変えない。
  - agentEvidence は「P2 の間の post で tool が "Write"・path が probe-2.txt の完全一致の道・agent_id が空でない記録」を探し、その agent_id で agentLifecycle を読む。starts ≥ 1 かつ stops ≥ 1 のときだけ ○。probe-2.txt の完全一致の道は、今の agentEvidence に渡している probeFile と同じ値を使う。
  - activity.ts に足した読み口の単体試験を1件足す（agent_id が違えば 0 を返す）。
- 試験: 本物の配線（realProbePorts か、それと同じ対応づけの関数）を通す試験を1件以上。場面は次の3つ。
  - (a) 下請けが Write で書き、同じ agent_id の開始と終了がある → ○
  - (b) 主の会話（agent_id 空）だけが書いた → ×
  - (c) 書いた agent_id と別の agent_id の開始・終了しかない → ×

## F3（LOW-1）README を実装と設計 K53・§14-14-6 の 1 に合わせる
- README.md の「版はサーバーが自分で確かめる」節の該当の1文を次の意味に直す: MAC が合わない項目はその項目だけ捨て（記録は上書きしない）、知らせ n5 を出す。記録が壊れた JSON で読めないときは使える版 0。実装は変えない。

## F4（LOW-2）起動時の片付けで runningVersionProbe の caseId を確かめる
- 場所: server/case-say-probe-wiring.ts の startupCleanup（18fa835 で :137-165）。
- 変更: `running` を読んだ直後に caseId が UUID の形かを確かめる（case-sandbox.ts の既存の UUID の正規表現を使う。新しく作らない）。合わなければ kill-session と cleanup はせず、`setRunning(undefined)` と知らせ n5 だけ行い、そのまま recheck へ進む。
- 試験: 1件。running の caseId が UUID でない → recheck が呼ばれる・running が消える・n5 が1回・kill と cleanup は0回。

## F5（LOW-3）setRunning の失敗を見る
- 場所: server/case-say-probe.ts の `await this.store.setRunning(...)`（18fa835 で :358）。
- 変更: setRunning が投げたら、probe を打ち切る（既存の打ち切りと同じ片付けの道に入れ、outcome は aborted）。openCase より前へは動かさない（caseId が開くまで決まらないため）。
- 試験: 1件。偽の store の setRunning を失敗させる → 件が片付けられる・監査の outcome が "aborted"。

## 確かめ
- `npm run build`・`npm run typecheck`・`npm run lint`・`npm test`。単体の赤は親カード §3 の 2 の一覧（8件）と同じであること。typecheck の数は 171 から増やさない。
- 版は 0.53.0 のまま。CHANGELOG は変えない。

## 提出
- `git fetch origin` → `git switch release/case-claude-version-probe` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-claude-version-probe`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: F1〜F5 ごとに変えた file:line、足した試験の名前、試験の数（通った・赤）と赤の名前の一覧、typecheck の数、`git diff --stat 18fa8351b3a2f5b27735135a349dd0d2c226ec71..HEAD`。

END OF CARD
