# 便CS3a 直し2 — 実装カード（直し1 の審査の指摘 MEDIUM-1 への対応）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14（第12版）。親カード: card-cs3a.md（§2 の触らない範囲はそのまま守る）。直し1: card-cs3a-fix1.md。
土台: release/case-claude-version-probe の 6f5a5d223509705e8c979cd08ef6dfdd0e64397c。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## なぜ
直し1 の F5 は「setRunning が投げたら」と書いたが、本物の器 `CaseSayVersionStore.setRunning`（server/case-say-versions.ts:228-231）は投げず、書けない状態・書き込みの失敗のどちらも `false` を返す（persist の :245-257 が失敗を受け止める）。カードの書き方の誤り（設計者 Opus の誤り）。

## F5'（MEDIUM-1）setRunning の戻り値 false で打ち切る
- 場所: server/case-say-probe.ts の P0 直後の setRunning（6f5a5d2 で :364-369 の try/catch）。
- 変更: 戻り値を受け、`false` なら `throw new ProbeAborted("setRunning")`。投げたときの try/catch はそのまま残す（同じ ProbeAborted へ）。ほかは変えない。
- 片付けの最後の `setRunning(undefined).catch(() => undefined)`（:495）は残す。
- 試験: tests/unit/case-say-probe.test.ts の「F5: when setRunning throws」は残し、もう1件足す: 偽の store の setRunning を、引数が undefined でないときだけ `false` を返す形にする（undefined のときは本物の動きのまま）→ outcome は "aborted"・閉じた件と片付けた件が ["probe-1"]・送った文は 0・監査の最後の行が caseClaudeVersionProbe / aborted・使える版にならない。
  - この試験は直す前のコード（6f5a5d2）なら落ちること（false が返っても先へ進み、文を送るため）。

## 確かめ
- `npm ci`・`npm run build`・`npm run typecheck`・`npm run lint`・`npm test`。単体の赤は直し1 と同じ一覧（土台と同じ）であること。typecheck の数は 171 から増やさない。
- build がクラウドで `.sa-cache` の無いことで止まるのは直し1 と同じ既知の事情。その場合はそう書く（直さない）。
- 版は 0.53.0 のまま。CHANGELOG・README は変えない。

## 提出
- `git fetch origin` → `git switch release/case-claude-version-probe` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-claude-version-probe`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: 変えた file:line、足した試験の名前、試験の数（通った・赤）と赤が土台と同じかどうか、typecheck の数、push の結果1行、`git diff --stat 6f5a5d223509705e8c979cd08ef6dfdd0e64397c..HEAD`。

END OF CARD
