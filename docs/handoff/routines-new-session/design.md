# 設計: 定期実行を「毎回新しいセッション」にする

状態: 設計案（Opus 作成）。審査: 第1回 REVISE → 第2回 APPROVE（条件の1行は反映済み）。PO の依頼は recon.md の原文。
参照: recon.md（同じフォルダ）、docs/handoff/v0.7.0-routines/design.md（このうち L5 の「Claude UUID を控える」・L7 の「登録時に専用セッションを1つ開き、起動時に同じ会話を開き直す」は、この設計で置き換える。それ以外の決まりは引き継ぐ）。

## 1. 目的（PO に見える変化）
- 定期実行を登録しても、その場ではセッションを開かない。
- 決めた曜日・時刻（Asia/Tokyo）になると、新しいセッションを1つ開く。Claude の入力待ちになったら、登録した指示を1回送る。
- 開いたセッションは、ふつうのセッションと同じように一覧に出る。アプリを再起動したときも開き直す。アプリは自動で閉じない（PO が閉じる）。
- 実行履歴には、結果と開いたセッションの名前が残る。

## 2. 対象と対象外
- 対象: server/routines.ts、server/sessions.ts（routineId の削除）、server/restore.ts（routineId の条件の削除）、server/hub.ts（送る関数を1つ足す）、src/components/Routines/*、src/types.ts、src/locales/ja.json（文言はこの1ファイルだけ。src/i18n.ts:19 が ja だけを読む。en.json は無いので作らない）、tests/unit/routines.test.ts（:128-132 の routineId を期待する試験は削除）、tests/unit/session-restore.integration.test.ts（:426-434 の「ordinary session but not a routine session」試験は削除し、K8 の試験に書き換える）、e2e（定期実行の画面がある場合はその分）、README.md、docs/CHANGELOG.md、package.json の版、docs/handoff/v0.7.0-routines/design.md（冒頭に「L5・L7 は routines-new-session/design.md で置き換え」の1行）。
- 対象外: 削除の機能、前回の会話を自動で閉じること、取りこぼした回の追い付き、権限モードの引数を足すこと、役割の command の変更、チャット送信（hub の flushChatQueueOnce）の変更。

## 3. 変更の前後
| 項目 | 前（v0.15.0） | 後 |
|---|---|---|
| 登録したとき | 専用セッションを開く（routines.ts:68,71） | 開かない。routines.json に保存するだけ |
| アプリ起動時 | 専用セッションを同じ会話で開き直す（routines.ts:54,72） | 定期実行のためには何も開かない（開いたセッションは、ふつうの復元で開き直る） |
| 時刻になったとき | 既存の専用セッションへ promptText+"\r"（routines.ts:75） | 新しいセッションを開く → 準備ができたら括弧付き貼り付けで送り、`pasteSubmitDelayMs` 待ってから "\r" |
| 二重実行の防止 | メモリの Set（再起動で消える） | routine ごとの `lastSlot` を、セッションを開く前に routines.json へ保存する。同じ slot は再起動をまたいでも2回目を実行しない |
| 復元リスト | routineId 付きは外す（restore.ts） | 区別しない。開いたセッションはふつうのセッション |
| routines.json | version 1、claudeSessionId あり | version 2。claudeSessionId を持たない。lastSlot を持つ。events に sessionName（任意） |

## 4. 詳しい動き（server/routines.ts）
1. tick（1秒ごと、現行どおり）: enabled・曜日・時刻が合い、`r.lastSlot !== slot.key` の routine を選ぶ。
2. 選んだ routine は、まず `this.routines` を map で新しい配列に差し替えて `lastSlot = slot.key` を入れる（同期。await の前）。その直後に `await persist()`。保存に失敗したら、その回は実行しない（console.error のみ）。メモリの lastSlot は戻さない（同じ slot を再び選ばない＝再試行しない。二重実行より取りこぼしに倒す）。
3. 実行（dispatch）は tick の中で await しない（別の routine や次の tick を止めないため）。例外はすべて catch して outcome=failed にする。
4. dispatch の順:
   a. cwd をもう一度検証する（routines.ts:63-64 と同じ classifyCwd）。駄目なら outcome=`cwd_invalid`。
   b. `sessions.hasCapacity()` が false なら outcome=`full`。
   c. 名前を作る: `${name の先頭 28 文字} ${MM/DD HH:mm}`（JST、合計 40 文字以内。sessions.ts:10 の上限）。
   d. `sessions.restore({ role, name, cwd, branch })` を claudeSessionId なしで呼ぶ（role.command で起動。sessions.ts:210）。worktree は作らない（登録済みの cwd を使う）。
   e. 準備を待つ: `READY_POLL_MS = 3000`（定数。config の agentsPollMs と同じ間隔）ごとに `hub.checkInput(sessionId)` を呼ぶ。`ok && hasClaude` になったら次へ。終了の判定は `this.sessions.get(sessionId)` が undefined か `.exited === true`（checkInput の reason 文字列は使わない）→ outcome=`failed`。`READY_TIMEOUT_MS = 120000` を過ぎた → outcome=`not_ready`（セッションは残す）。
   f. 送る直前に、`this.routines.find((r) => r.id === routine.id)?.enabled === true` を確かめる（引数の routine は古いので使わない）。無効にされた・見つからないなら outcome=`not_ready` で送らない。
   g. hub に足す `submitText(sessionId, text)` で送る: 括弧付き貼り付け（hub.ts:41-42 の定数）で本文 → `pasteSubmitDelayMs` 待つ → 終了・閉じる途中（`sessions.isClosing`）でなければ "\r"。送れたら outcome=`sent`。
5. 結果を events に1件足す: `{ at, slot, outcome, sessionName? }`（MAX_EVENTS=100 は現行どおり）。routines の配列は毎回新しく作る（書き換えない）。
6. 取りこぼした回は追い付かない（現行どおり）。

## 5. routines.json（唯一の保存先）
- `{ "version": 2, "items": [Routine] }`。Routine = { id, name, enabled, roleId, cwd, branch?, timeZone:"Asia/Tokyo", weekdays, timeHHmm, promptText, lastSlot?, createdAt, updatedAt, events }。
- event = { at, slot, outcome, sessionName? }。outcome は `sent | not_ready | full | cwd_invalid | failed`。
- version 1 のファイルは読める: claudeSessionId は捨てる。古い outcome（busy・waiting・unknown・stopped・missing）は履歴の表示用に読み込みを許す。書くときは version 2。
- 書き方は現行どおり（一時ファイル → rename、600/700）。
- 開いたセッションの続き（Claude の id）は open-sessions.json の側だけが持つ。routines.json には持たない（同じ事実を2か所に持たない）。

## 6. 画面
- 新しい部品は作らない。今の @sa/components（Badge・Button・Callout・EmptyState・Modal・Select・Stack・Textarea・TextField）とトークンだけを使う。色・大きさの直書きはしない。
- 登録・編集の画面に Callout を1つ足す: 「時刻になると新しいセッションを開いて、この指示を送ります。開いたセッションは自動では閉じません。」
- 履歴の行に、開いたセッションの名前を出す（あるときだけ）。
- 文言はすべて `t("ac.routines.*")`。ja.json にキーを足す（en.json は無い）。outcomes に `not_ready`（ja:「準備できず送らなかった」）・`full`（ja:「上限のため開かなかった」）・`cwd_invalid`（ja:「作業場所が無い」）を足す。古い outcome のキーは残す（version 1 の履歴を表示するため）。

## 7. 代替案と選んだ理由
- A（採用）: 毎回新しいセッションを開く。PO の依頼どおり。前回の会話の続きに混ざらない。
- B: 専用セッションを残し、選べるようにする。登録は 0 件で、残す理由が無い。2つの動き方を保つ費用が増えるので採らない。
- C: 前回開いたセッションを自動で閉じる。会話を自動で閉じない決まり（recon）に反するので採らない。

## 8. リスクと対処
- 起動直後の確認画面（フォルダの信頼など）で入力待ちのまま → 120 秒で not_ready。セッションは残るので、PO が画面で見られる。【未確認】その画面で `claude agents --json` が idle・待ち無しを返すか（返すと指示がその画面に入る）。K15 の実機確認で見る。
- セッションの上限は 16（sessions.ts:9 DEFAULT_MAX_SESSIONS）。開いたままにすると、毎日1回の routine 1つでも、ほかの会話と合わせて 16 に達した時点から full が並ぶ。PO が閉じる運用（自動では閉じない）。
- アプリ停止中（index.ts:99-107 の process.exit）に準備待ちだった回は、履歴が残らない。lastSlot は保存済みなので二重にはならない。
- 会話が増えてメモリを使う → 自動では閉じない。履歴にセッション名を残すので、どれを閉じてよいかが分かる。
- 同じ分に再起動が重なる → lastSlot を先に保存するので、2回目は開かない。
- 規約（Consumer Terms 3条7項）: アプリのタイマーで Claude Code に送る点は v0.7.0 と同じ。PO は 2026-10-13 に「残す」と判断済み（recon）。この設計で新たに足す種類の自動化は「セッションを開く」こと。

## 9. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 登録しただけではセッションが増えない | 単体: create 後に sessions.restore が呼ばれない |
| K2 時刻になると、新しいセッションを1つ開く（--resume しない） | 単体: 偽の時計で slot を合わせ、restore が claudeSessionId なしで1回呼ばれる |
| K3 準備できたら1回だけ送る（括弧付き貼り付け → 待つ → "\r"） | 単体: checkInput が 2 回目で ok&&hasClaude → write が「貼り付け本文」「\r」の順に1回ずつ |
| K4 準備できなければ送らない | 単体: 120 秒 ok にならない → write 0 回・outcome=not_ready |
| K5 同じ slot は再起動をまたいでも1回 | 単体: lastSlot を保存した routines.json から新しい service を作り、同じ時刻で tick → restore 0 回 |
| K6 lastSlot の保存に失敗したら開かない | 単体: store.save が失敗 → restore 0 回。その後、同じ slot で再び tick しても restore 0 回 |
| K7 上限・作業場所なしは開かない | 単体: hasCapacity false → full、cwd 検証失敗 → cwd_invalid |
| K8 開いたセッションは復元リストに入る | 単体: restore.ts の sync が、定期実行で開いたセッションも保存する |
| K9 version 1 のファイルを読める | 単体: claudeSessionId 付き・古い outcome 付きの v1 を読み、v2 で書き直す |
| K10 待つ間に他の routine を止めない | 単体: 同じ分の routine 2つ。1つ目が準備待ちでも、2つ目の restore が呼ばれる |
| K11 無効にしたら送らない | 単体: 準備待ちの間に setEnabled(false)（this.routines が差し替わる）→ write 0 回 |
| K12 画面に説明と履歴のセッション名が出る | e2e または単体（RTL）: Callout の文言・履歴にセッション名 |
| K13 文言・トークン | `npm run lint`（scripts/check-design-governance.mjs）が通る・画面の文字列はすべて ja.json のキー |
| K14 全体 | `env -u AC_RESUME_ID npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e` が通る。CI は ubuntu・macOS とも pass |
| K15 本番（導入後） | 実機確認（役割は opus-designer）: 2〜3 分後の時刻で1件登録 → 新しいセッションが開き、開いた直後の確認画面ではなく入力欄に指示が入り、履歴が「送信済み」とセッション名。履歴に「上限のため開かなかった」が出たら、古い会話を閉じる |

## 10. 実装の約束（Sonnet 向け）
- 作業場所: ~/agent-console-wt/routines-new-session（ブランチ release/routines-new-session、origin/main f897ff6 起点）。
- 試験を先に書く（K1〜K12）。試験は `env -u AC_RESUME_ID` を付けて実行する。
- 版は package.json を次の空き番号に上げる（この時点の予定は 0.16.0。マージ順でずれたら直す）。CHANGELOG に1行、README の定期実行の説明を直す。
- PR は GEN-RYU-System/agent-console へ、本文は pr-body-guard の書式（PR #30 が見本）。
- この設計に無いこと・合わないことが出たら、止まって報告する（DONE / BLOCKED: / NEEDS_DECISION:）。

## 11. 導入と戻し方
- 導入: マージ → タグ → launchd の一回きり job（~/CC報告ファイル-keep/agent-console/update-when-idle.sh <tag>）。全セッションが待機中になったときに ac-update が走る。投入済みの v0.15.0 の job は、新しいタグの job に差し替える（先に `launchctl list | grep ac-update` で確かめる）。
- 戻し方: `bash scripts/ac-rollback.sh`（前の版に戻る）。routines.json が version 2 になっていたら、前の版でもサーバーは起動するが、定期実行の読み込みと新規登録が失敗する（index.ts:84 は catch するだけ・routines.ts:39 の save は保存前に read する）。登録が 0 件なら影響は無い。登録した後に戻す場合は、routines.json を ~/.Trash に移してから戻す。

## 12. 維持の仕組み
- 単体試験 K1〜K12 が CI（両 OS）で毎回走る。
- 正本は routines.json だけ（§5）。セッションの続きは open-sessions.json だけ。
- 外部事例: 使わない（PO の指示で外部サイトは参照しない。根拠は手元のコードと既存の設計だけ）。

## 審査
- 第1回（Fable）: REVISE。HIGH-1 routineId の試験2件の漏れ・HIGH-2 en.json は無い、MEDIUM-1 lastSlot の同期更新・MEDIUM-2 有効の読み直し・MEDIUM-3 終了の判定手段・MEDIUM-4 上限16、LOW-1〜4 → すべて本文に反映した。
- 第2回（Fable）: APPROVE（条件付き）。MEDIUM-N1 §6 の en.json の残り・LOW-N1 状態表示 → 反映した。
