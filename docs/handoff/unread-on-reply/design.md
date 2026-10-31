# 返事が来たら未読を付け、PO が送るまで消さない 設計

状態: 設計案 第2版（Opus 作成・2026-11-01）。第1版の設計審査（クラウド Opus、a5ee1b2）は REVISE・直す点 12 件。第2版で全件を直した（対応は §10）。PO 決定 2026-11-01「1」（その窓で PO が何か送ったら消す）。設計審査の APPROVE と PO の実装承認の後に実装へ進む。

## 1. 目的（PO に見える変化）
- PO の願い（2026-11-01 原文）:「agent consoleのあなたが私の返答街をしているときも未読を表示させるようにして、殆どの場合で未読バッジがなくて気づかないことが多い」
- 同日の追加の観測（PO 原文）:「今も選択肢を出していたが未読はついていなかった」
- 変化: Claude が PO の返事を待つ状態になるたびに、その窓の行に「未読」の印が付く。待つ状態とは次の 2 つ。
  1. Claude が返事を書き終えた（返事の本文に選択肢を書いて終えた場合を含む）。
  2. 返事の途中で、許可の確認や選択肢の画面を出して止まった。
- PO がその窓で何か送る（端末で Enter を押す・チャット欄から送る）まで消えない。窓を開いているだけ・行を選んだだけでは消えない。
- PO の「選択肢」が 1 と 2 のどちらだったかは未確認。この設計は両方で印を付けるので、PO に確かめなくても願いを満たす。

## 2. 現在地（事実。agent-console origin/main de28ba7）
- 未読の数え方: server/notify.ts:9-11 `isBreak(prev,next)` は `prev === "busy" && (next === "waiting" || next === "idle")`。server/notify.ts:50-60 `BreakTracker.observe()` がこのときだけ未読を 1 増やす（:58）。
- 呼ばれる間隔: server/hub.ts:570-590 `detectBreaks()` は `claude agents --json` の取得ごと。同梱の agent-console.config.json:9 は agentsPollMs = 10000。この Mac の installed の値は未確認。
- 原因1（見ている窓は自動で既読になる）: src/pages/ConsolePage.tsx:219-223 は、選んでいる行に未読があり画面が見えていれば `markRead` を呼ぶ。:230-233 `handleSelect` も行を選ぶと既読にする（:232）。PO が今の窓を開いたままなら、未読は付いた直後に消える。PO の「今も…未読はついていなかった」はこの経路と合う。
- 原因2（短い返事は数えられない）: 状態は 10 秒ごとにしか見ない。10 秒未満で終わる返事は busy を一度も観測しないので、`isBreak` が成り立たず未読が増えない。
- 返事の途中の待ち（許可・選択肢）は、今は busy→waiting の観測だけが拾う。返事の途中なので Claude の Stop の記録は来ない。記録用 hook の PreToolUse は `Agent|SubagentHandback` だけで、選択肢の道具は記録しない（server/activity-hooks.ts:54）。
- 返事の終わりの印: agent-console の記録用 hook が Claude の Stop を書く（server/activity-hooks.ts:60 `{ event: "Stop" }`、hooks/activity-hook.mjs:173-177 は `stop_hook_active` も残す）。server/activity.ts:393-395 は Stop を会話の記録にだけ使う。:396-397 の StopFailure（API の失敗で返事が終わった）も会話の記録だけ。記録の読み込みは 2 秒ごと（server/activity-start.ts:10 `ACTIVITY_POLL_MS = 2000`）と agents 取得ごと（server/index.ts:114）。
- 実物の記録（この Mac。2026-11-01 01:36 JST に、events-20261031.jsonl を 1 行ずつ JSON として読み、event ごとに数えた。ファイルは UTC の日付で、まだ書き足されている途中）: Stop 503 行（stop_hook_active が false 454・true 49）、会話番号 12 種類。StopFailure は 0 行。
- 読み直し: 起動後の最初の読み込みで今日・昨日の記録を先頭から読む（server/activity.ts:269-278、カーソルは 0 から :311）。ファイルが縮んでいたら先頭から読み直す（:312-313）。会話の記録は `chatKey` で重複を除く（:403-405）が、本文が空の Stop はそこを通らない。
- 時刻: `ActivityStore` は時計 `now` を注入できる（server/activity.ts:243-250）。Stop の ts は hook の中の `Date.now()`（hooks/activity-hook.mjs:134・:139）。同じ Mac の時計。
- 窓と Claude の会話の対応: hub は窓ごとに `claudeSessionId` を持つ。件でない窓は agents の取得のとき（10 秒ごと）に付く（server/hub.ts:578-582）。件の窓は `attachCaseSessionIds`（server/hub.ts:596-615）が case-home の記録から付け、ほかの窓と同じ番号なら外す（:606-608）。
- 件の窓の記録の道: 件の窓の hook はファイルに書かず、POST /api/agent/case-activity へ送る（server/case-sandbox.ts:450、hooks/activity-hook.mjs:281-288）。次のときは記録が捨てられる。送り元の件が引けない（401。server/http.ts:439-440・:445）、件で最初に受けた番号と違う（409。:416-426・:446）、送信が 2 秒で時間切れ（hooks/activity-hook.mjs:13・:256）。どの失敗も、サーバーにも hook にも跡を残さない（http.ts:436-450 は応答を返すだけ、activity-hook.mjs:253-260 は false を返すだけ）。この Mac の件の窓（cases/ に 6 件、session-id を持つのは 3 件）が当たっているかは未確認。件の部屋は今、PO の判断で使えない状態にしてある。
- PO の入力の道:
  1. 端末への直接入力: server/ws.ts:36（`msg.type === "input"` を `sessions.write`）。画面は xterm の `onData` をそのまま送る（src/components/TerminalPane/TerminalPane.tsx:291-293）。よく使う指示・差分のコメント・選んだ物の送信も、`pasteSubmitAfter`（TerminalPane.tsx:101-110）が `term.input("\r")` で `onData` に流すので、同じ道を通る。
  2. チャット欄からの送信: src/components/ChatPane/ChatPane.tsx:118 → server/chat-routes.ts:71 → server/hub.ts:402 `enqueueChat`（予約に積むだけ）。端末へは手が空いたときに `flushChatQueueOnce`（server/hub.ts:495-542）があとで書く（Enter は :533）。
- PO の入力ではない道: `submitText`（server/hub.ts:548-567）を呼ぶ定期実行（server/launch.ts:114）と引き継ぎ（server/relay.ts:232・:272）。名前の変更の `/rename …\r`（server/hub.ts:300・:369・:386）。どれも ws を通らない。
- ws の中: `attachTerminal`（server/ws.ts:22）は hub を持っていない。hub は `attachWebSockets` の deps にある（:53）。
- `markRead` の呼び出し元（git grep）: 製品では src/pages/ConsolePage.tsx:222・:232 だけ（src/api.ts:55 → server/http.ts:327-328 → server/hub.ts:618-620）。extension/ には無い。試験は tests/unit/daily-use.integration.test.ts:127（無い窓への POST が 404）と tests/unit/notify.test.ts:53-60。
- 既存の設計の定義: docs/handoff/stage2/design.md:14（K1「行を選ぶと未読が消える」）・:32。今回これを変える。

## 3. 対象と対象外
- 対象（直すファイル）:
  - server/notify.ts（未読の足し方 2 本・重ね足しの防止・消し方）
  - server/activity.ts（返事の終わりを知らせる口・起動時刻・二重の防止）
  - server/hub.ts（返事の終わりで足す・結べない記録の保留・PO の送信で消す・`watchActivity` の型 :215）
  - server/ws.ts（端末の入力に Enter があれば消す合図）
  - src/pages/ConsolePage.tsx（自動の既読 :219-223 と行を選んだときの既読 :232 を外す）
  - 試験: tests/unit/notify.test.ts:42-60、hub の試験の偽の store（`watchActivity` の型が変わるため）、src/pages/ConsolePage.test.tsx:339-344、tests/e2e/console.spec.ts:612-650、新しい単体試験（K1〜K12）
  - 言葉: src/locales/ja.json:165 `notifyHelp`（今は「作業の区切り」を説明する文で、未読には触れていない。この文は通知の説明として残し、変えない。言葉のファイルは ja.json だけ（src/locales/ に en.json は無い）。未読の説明は README で直す）
  - 文書: README.md:295（「作業中から待ちに変わると未読…行を選ぶと未読が消えます」を、未読は §4-1 の 2 本で付き §4-2 の 2 本で消える、通知は今までどおり、に分けて直す）、docs/handoff/stage2/design.md:14・:32（新しい定義へ。この設計を指す）、docs/CHANGELOG.md（docs/CHANGELOG.md:5 の形で 1 行。戻し方を含む）
  - 版: 0.48.1 → 0.49.0（package.json:3、package-lock.json、extension/manifest.json:4）。未読の意味が変わるので小さい版でなく中の版を上げる。
- 対象外: macOS の通知（今の busy→待ちの判定のまま）、未読の保存（今までどおりメモリだけ・再起動で消える）、印の見た目と ac.unread「未読 {{count}} 件」の言葉、記録用 hook（hooks/activity-hook.mjs は変えない）、件の窓の記録の受け口（server/http.ts は変えない）、定期実行・引き継ぎ・名前の変更。

## 4. 変更（前 → 後）
### 4-1. 未読を足すとき（足す道を 2 本にする）
- 前: 10 秒ごとの観測で busy→waiting/idle を見たとき 1 増やす（1 本）。
- 後: 次の 2 本で足す。どちらも `BreakTracker` の中で数え、正本は 1 か所のまま。
  - 道A（返事の終わりの記録）: 記録に Stop か StopFailure が届き、次の全部に当てはまるとき、その会話番号を `claudeSessionId` に持つ窓へ 1 足す。
    1. `stop_hook_active` が true でない（別の Stop hook に止められて続けた後の終わりは、同じ 1 回の返事なので足さない）。
    2. ts が `startedAt` 以上。`startedAt` は `ActivityStore` を作ったときに注入の `now()` で取る（起動時に読み直す昔の記録で足さないため）。
    3. （会話番号, ts）の組がまだ足していない組。ファイルが縮んで先頭から読み直したときに 2 度足さないため。覚えておく組は、`dropOldSessions` と同じく古い会話を捨てるときに一緒に捨てる。
    4. StopFailure も足す（API の失敗で止まったことに PO が気づく必要があるため）。条件は Stop と同じ。
  - 道B（状態の観測）: 今の `observe()` の busy→waiting/idle（返事の途中の許可・選択肢の待ちと、長い返事の終わりを拾う）。
- 同じ待ちを 2 度足さない決まり（窓ごとに 2 つの印をメモリに持つ）:
  - `stopSeen`: 道A で足したら立てる。立っている間、道B は足さない（Stop が先に届き、次の観測で busy→idle を見た場合）。
  - `breakSeen`: 道B で足したら立てる。立っている間、道A は足さずに印を倒す（観測が先に waiting/idle を見て、そのあと Stop が届いた場合）。
  - 両方の印は、観測で busy を見たとき（次の仕事が始まった）と、PO の送信で消したとき（§4-2）に倒す。
  - 例: 返事の途中で許可を出す → 道B で 1。PO が Enter で答える → 0 と印を倒す。返事が終わる → 道A で 1。
  - 例: 3 秒の短い返事 → 観測は busy を見ない → 道A だけで 1。
  - 例: PO が送らずに、背景の仕事の知らせで Claude が起きて短い返事をした → 道A で足す（道A は `stopSeen` を見ないので、前の返事の印に邪魔されない）。
- 結べない記録の保留: 道A の記録の会話番号を持つ窓がまだ無いとき（新しく開いた窓の最初の返事・会話番号が変わった直後で、次の agents の取得より前に返事が終わった）は、捨てずに保留する。`detectBreaks()` の最後（番号を付けた後）に保留を見直し、結べたら足す。30 秒（agents の取得 3 回分）結べなかったものは捨て、捨てた件数をサーバーのログに 1 行出す。
- 形:
  - `ActivityStore` に `onTurnEnd(listener: (e: { claudeSessionId: string; ts: number; failed: boolean }) => void)` を足す。`apply()` の `case "Stop"`・`case "StopFailure"` から、上の 1〜3 を満たすときだけ呼ぶ。`loadFileHistory`（PostToolUse のファイルの記録だけを通す。server/activity.ts:301）は通らない。
  - hub の `watchActivity` の型（server/hub.ts:215）に `onTurnEnd` を足し、受けたら `BreakTracker.addTurnEnd(sessionId)` を呼ぶ（結べなければ保留）。その後の配信は既存の `onChange`（同じ読み込みの最後に呼ばれる。server/activity.ts:280-283）に任せる。
  - `BreakTracker.observe()` は今までどおり true/false を返し（通知は今までどおり）、未読を足すかは `stopSeen` を見て決める。

### 4-2. 未読を消すとき（PO 決定「1」）
- 前: 行を選んだとき、選んでいる行に未読が来たとき（窓が見えていれば）に消える。
- 後: 次の 2 つのときだけ消す（未読を 0 にし、`stopSeen`・`breakSeen` を倒す）。
  1. 端末への入力に Enter の文字（`\r`）が含まれるとき。`attachWebSockets` が deps の hub から `onSubmit` を作って `attachTerminal` に渡し、server/ws.ts:36 で `sessions.write` の後に呼ぶ。
     - 消える: 普通に送る・選択肢を Enter で選ぶ・許可に Enter で答える・よく使う指示／差分のコメント／選んだ物の送信（`pasteSubmitAfter`）。
     - 消えない: クリックやフォーカスで端末が出す文字（`\x1b[I`・`\x1b[O`）、矢印、マウスの報告、端末の自動の応答。どれも `\r` を含まない。
     - 送っていないのに消える（受け入れる。§6）: 改行を含む文の貼り付け（`paste()` が改行を `\r` に直す。TerminalPane.tsx:32-33・:97・:104）、「挿入だけ」のよく使う指示で複数行を入れたとき、Alt+Enter（xterm.js が ESC と `\r` を送る。この製品で Option をメタにしているかは未確認）。
  2. チャット欄から送った時点（`enqueueChat` server/hub.ts:402 の受付）。端末へ書く :533 では消さない（予約はあとで書かれるので、PO が作業中に送った文が返事の後に書かれ、PO が返事を見る前に消えてしまうため）。
  - 消さない: 定期実行・引き継ぎの `submitText`、名前の変更の `/rename`。どれも ws と `enqueueChat` を通らないので、上の 2 か所で消せば自然に消えない。
- 画面: src/pages/ConsolePage.tsx:219-223 の自動の既読を削る。:232 の `handleSelect` の既読も削る。
- `markRead` の API（src/api.ts:55、server/http.ts:327-328、server/hub.ts:618-620）は残す。画面からは呼ばない。理由: 試験 tests/unit/daily-use.integration.test.ts:127 が受け口の 404 を確かめており、消すと試験と受け口の一覧の直しが増える。中身は §4-2 の消し方（印も倒す）にそろえる。

### 4-3. 変えないこと
- タイトルの合計（ConsolePage.tsx:214-217）と一覧の印（SessionList.tsx）は今の `unread` をそのまま出す。
- macOS の通知は道B の判定（`observe()` が true）のまま。

## 5. 代替案と選ばなかった理由
- A. 観測の間隔を短くする（10 秒→1 秒）: `claude agents --json` を 10 倍呼ぶ。1 秒未満の返事はなお漏れる。原因1も直らない。不採用。
- B. 画面が見えていないときだけ自動既読を止める: PO はほとんど今の窓を開いたまま待つので、原因1が残る。PO の決定「1」と合わない。不採用。
- C. 行を選んだら消す（今の定義を残す）: PO が選んだ「1」と違う。不採用。
- D. 道A（Stop）だけにする（第1版）: 返事の途中の許可・選択肢の待ちで未読が付かなくなり、今より悪くなる（第1版の審査 直す点1）。不採用。
- E. 選択肢の道具を記録用 hook で記録して足す: hook の形を変える必要があり、Claude の設定の入れ替えが要る。許可の確認は道具ではないので拾えない。不採用。
- F. 採用案（道A＋道B、重ね足しの印、PO の送信で消す）: 既にある記録と観測を使い、hook も Claude の設定も変えない。

## 6. リスクと対処
- 記録用 hook が入っていない環境: 道A が来ない。道B は今までどおり働くので、今より悪くはならない。今の K8 の点検（hook が入っているか）で分かる。この Mac では入っている（~/.claude/settings.json の Stop に activity-hook.mjs）。
- 件の窓で記録が捨てられる道（401・409・時間切れ。§2）: 跡が残らないので、捨てられたかは外から分からない。道B は件の窓でも働くので、今より悪くはならない。件の部屋を使えるように戻すときに、次の手順で確かめる。(1) D/cases/<id>/session-id の番号と、その件の窓の今の会話番号（画面の行の情報）を比べ、違えば 409 で捨てられている。(2) その件の窓で短い質問を送り、5 秒以内に印が付くかを見る。付かなければ 401 か時間切れ。この手順は件の部屋を戻す便の受入に写す。
- 1 回の入力に Stop が何度か来る（hooks/activity-hook.mjs:174 の注釈）: `stop_hook_active` が true の Stop は足さない。件でない窓には同期の作戦ボードの見張りの Stop hook がある（server/activity-hooks.ts:70-71）。見張りが止めた 1 回目の Stop（false）も記録されるので、Claude がまだ続きの作業をしている時点で未読が付く。本当の終わり（true）では足さないので、数は 1 のまま。印が付く時点が早いことは受け入れる（PO が窓を見たとき、Claude はまだ書いている）。件の窓は見張りを外している（server/case-sandbox.ts:450）ので true は来ない。
- 送っていないのに消える場合（§4-2 の 1）: どれも PO がその窓の端末に打った操作なので受け入れる。PO の願い（気づかない、を無くす）には影響しない。
- 結べない記録の保留が溜まる: 30 秒で捨てるので、数は agents の 3 回分の間に終わった返事の数を超えない。
- 試験の書き換え: src/pages/ConsolePage.test.tsx:339-344 と tests/e2e/console.spec.ts:612-650 は「選んだら既読」を確かめている。新しい定義の逆の振る舞い（選んでも残る・Enter で消える）を確かめる試験に書き換える。e2e の通知の確かめ（K9）は未読と分けて残す。

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 Claude が 3 秒で終わる短い返事をしたとき、5 秒以内にその窓の行に「未読 1 件」が付く | 単体（窓に `claudeSessionId` を付けた状態で、Stop の記録を 1 行足して refresh → unread 1）＋PO の目視（短い質問を送り、別の窓を見ている間に印が付く） |
| K2 その窓を開いて見ている間も、印は消えない（30 秒見続けても残る） | 単体（ConsolePage で選んでいる行に unread 1 が来ても markRead が呼ばれない）＋PO の目視 |
| K3 行を選んだだけでは消えない | 単体（handleSelect で markRead が呼ばれない） |
| K4 その窓の端末で Enter を押す（選択肢を選ぶを含む）と消える。矢印キー・クリックだけでは消えない | 単体（ws に "\r" を含む input → unread 0。"\x1b[A"・"\x1b[I"・"\x1b[O" → 残る）＋PO の目視 |
| K5 チャット欄から送った時点で消える。予約があとで端末に書かれても、その後に付いた未読は消えない | 単体（enqueueChat の後 unread 0。その後 Stop で unread 1 → 予約を flush しても 1 のまま） |
| K6 定期実行・引き継ぎ・名前の変更の送信では消えない | 単体（submitText の後と /rename の後も unread が残る） |
| K7 別の hook に止められて続けた返事は 1 回と数える | 単体（stop_hook_active false → true の 2 行で unread 1） |
| K8 サーバーを入れ替えて起動した直後、昔の返事で未読が付かない。記録ファイルを先頭から読み直しても 2 度足さない | 単体（now を固定し、startedAt より前の ts の Stop → unread 0。同じ Stop の行を持つファイルを縮めて読み直す → unread 1 のまま） |
| K9 macOS の通知は今までどおり出る | 既存の通知の試験と、書き換えた e2e の通知の部分が通る |
| K10 返事の途中で許可・選択肢の画面を出して止まったとき、未読 1 件が付く（Stop は来ない） | 単体（観測で busy → waiting → unread 1。Stop は無し）＋PO の目視（許可の確認が出たときに印が付く） |
| K11 長い返事の終わりで、Stop と観測の両方が来ても 1 回と数える（どちらが先でも） | 単体（Stop → 観測 busy→idle で 1。観測 busy→waiting → Stop で 1） |
| K12 新しく開いた窓の最初の返事が、窓と会話番号が結ばれる前に終わっても、結ばれた後に未読が付く。30 秒結べなければ捨てる | 単体（番号の無い窓で Stop → unread 0 → 番号を付けて detectBreaks → unread 1。31 秒後の見直しでは捨てる） |
| K13 API の失敗で返事が止まったとき（StopFailure）も未読が付く | 単体（StopFailure の行 → unread 1） |
| K14 既存の試験・型検査・lint がすべて通る | CI |

## 8. 維持の仕組み
- 未読の正本は hub のメモリ（BreakTracker）1 か所のまま。足す道は 2 本（道A・道B）、消す道は PO の送信 2 本に固定し、試験 K3〜K6・K10〜K12 で固定する。
- README の未読の説明と docs/handoff/stage2/design.md の K1 の定義の変更を、この設計の場所と CHANGELOG に書く。
- 件の部屋を使えるように戻す便では、§6 の確かめる手順を受入に入れる。

## 9. 外部事例
- 該当なし。理由: 未読の付け方・消し方は PO の運用（「送るまで消さない」）で決めた。外の数値を根拠にしない。

## 10. 第1版の審査（REVISE・12 件）への対応
| # | 指摘 | 対応 |
|---|---|---|
| 1 | 返事の途中の許可・選択肢の待ちで未読が付かなくなる | 道B を残し、道A と 2 本にした。重ね足しは `stopSeen`・`breakSeen` で防ぐ（§4-1）。K10・K11 |
| 2 | チャットで消す場所は受付 | `enqueueChat` で消す（§4-2 の 2）。K5 |
| 3 | 結べない記録の扱い | 30 秒保留して見直す（§4-1）。K12 |
| 4 | 件の窓で記録が届かない道 | §2・§6 に書き、件の部屋を戻すときの確かめる手順を書いた。道B が残るので今より悪くならない |
| 5 | 起動時刻の定義と二重の防止 | `startedAt` は注入の `now()`。（会話番号, ts）で 1 回（§4-1）。K8 |
| 6 | 見張りの 1 回目の Stop で早く付く | §6 に書いて受け入れた |
| 7 | StopFailure | 足す（§4-1）。K13 |
| 8 | 送っていないのに消える場合・ws への hub の渡し方 | §4-2 に列挙し §6 で受け入れた。`onSubmit` を deps の hub から渡す |
| 9 | pasteSubmitAfter・引き継ぎ・/rename | §2 と §4-2 に書いた。K4・K6 |
| 10 | markRead の扱い | 残す。画面からは呼ばない（§4-2）。試験 daily-use:127 はそのまま |
| 11 | 触る範囲の漏れ | §3 に全部足した。版は 0.49.0 |
| 12 | 行番号・489 行 | origin/main に合わせた。記録の数は数えた時刻と方法を書いた（503 行） |
