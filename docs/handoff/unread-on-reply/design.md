# 返事が来たら未読を付け、PO が送るまで消さない 設計

> 第2の決まり（未読の数え方）は docs/handoff/unread-ball-with-po/design.md（v0.50.0）で置き換えた。

状態: 設計案 第4版（Opus 作成・2026-11-01）。第1版の設計審査は REVISE・12 件（対応は §10）。第2版は REVISE・8 件（対応は §11）。第3版（bcb25ae）も REVISE・直す点 5 件と推奨 3 件。第4版で全件を直した（対応は §12）。第4版（062eda9）の設計審査は APPROVE（直す点 2 件は形の書き方だけ・推奨 3 件。再審査は不要）。第4.1版でその 5 件を入れた（対応は §13）。PO 決定 2026-11-01「1」（その窓で PO が何か送ったら消す）。設計審査の APPROVE と PO の実装承認の後に実装へ進む。

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
- hub の時計: `Hub` の constructor（server/hub.ts:129-134）は options に時計を持たず、時刻は `Date.now()` を直接呼ぶ（:192・:408 など）。一覧から外した窓は `sessions.onRemoved` で `tracker.forget(id)` する（:139-140、server/notify.ts:71-74）。
- 待ちの理由: `claude agents --json` の `waitingFor` は status に関係なく、空でない文字なら残す（server/agents.ts:47。:12 の注釈は「waiting のときだけ付く」）。製品は idle＋waitingFor（server/agents.ts:86）と busy＋waitingFor（:101）を「確認待ち」として扱う。実機で waiting になったのは許可の確認だけで、選択肢・質問の画面が何を返すかは未確認（docs/handoff/chat/recon.md:218・:220）。
- 観測の呼び出し: `detectBreaks` は `this.tracker.observe(s.id, agent?.status ?? null)`（server/hub.ts:584）の 1 か所。agents の取得に失敗した回は :572 で早く戻り、観測しない。
- 会話ごとの記録の状態: `SessionState`（server/activity.ts:133-153）は会話番号ごとに持ち、`dropOldSessions`（:352）で古い会話ごと捨てる。重なり防止の鍵 `chatKeys`（:148）も同じ所にある。
- 試験の作り: 結合試験の harness は本物の `ActivityStore` を作って `hub.watchActivity(activity)` に渡す（tests/unit/helpers/harness.ts:268-269）。偽の store は無い。記録の単体試験は tests/unit/activity.test.ts。
- 既存の設計の定義: docs/handoff/stage2/design.md:14（K1「行を選ぶと未読が消える」）・:32。今回これを変える。

## 3. 対象と対象外
- 対象（直すファイル）:
  - server/notify.ts（未読の足し方 4 本の決まり・窓ごとの状態・消し方）
  - server/activity.ts（返事の終わりを知らせる口・起動時刻・二重の防止の組を `SessionState` に持つ）
  - server/hub.ts（返事の終わりで足す・結べない記録の保留・PO の送信で消す口 `clearUnread`・`watchActivity` の型 :215・時計の注入 :133・`observe` に waitingFor を渡す :584・取得失敗の回の保留の捨て方 :572）
  - server/ws.ts（端末の入力に Enter があれば消す合図。`attachTerminal` の呼び出し :102 に引数を足す）
  - src/pages/ConsolePage.tsx（自動の既読 :219-223 と行を選んだときの既読 :232 を外す）
  - 試験: tests/unit/notify.test.ts:42-60、tests/unit/activity.test.ts（`onTurnEnd` の単体）、hub の結合試験（harness は本物の `ActivityStore` を使うので、型が変わっても harness の直しは要らない。tests/unit/helpers/harness.ts:268-269）、src/pages/ConsolePage.test.tsx:339-344、tests/e2e/console.spec.ts:612-650、新しい単体試験（§7）
  - 言葉: src/locales/ja.json:165 `notifyHelp`（通知の説明として残し、変えない。言葉のファイルは ja.json だけ。未読の説明は README で直す）
  - 文書: README.md:295（未読は §4-1 で付き §4-2 で消える、通知は今までどおり、に分けて直す）、docs/handoff/stage2/design.md:14・:32（新しい定義へ。この設計を指す）、docs/CHANGELOG.md（docs/CHANGELOG.md:5 の形で 1 行。戻し方を含む）
  - 版: 0.48.1 → 0.49.0（package.json:3、package-lock.json、extension/manifest.json:4）。未読の意味が変わるので中の版を上げる。
- 対象外: macOS の通知（今の busy→待ちの判定 `isBreak` のまま）、未読の保存（メモリだけ・再起動で消える）、印の見た目と ac.unread「未読 {{count}} 件」の言葉、記録用 hook（hooks/activity-hook.mjs は変えない）、件の窓の記録の受け口（server/http.ts は変えない）、定期実行・引き継ぎ・名前の変更。

## 4. 変更（前 → 後）
### 4-1. 未読を足すとき
- 前: 10 秒ごとの観測で busy→waiting/idle を見たとき 1 増やす（`isBreak`、1 本）。
- 後: 未読の判定を通知の `isBreak` から切り離す。通知は今までどおり `observe()` が `isBreak` で true/false を返す。未読は `BreakTracker` の中の別の決まり（下の R1〜R5）で数える。正本は `BreakTracker` 1 か所のまま。
- 窓ごとにメモリに持つもの（窓の id ごと。`forget` で全部捨てる）:
  - `unread`（数）
  - `lastClearAt`（最後に PO の送信で消した時刻。初めは 0）
  - `hookSeen`（この窓で返事の終わりの記録を 1 度でも受けたか）
  - `open`（いま数えている待ち。`none`／`stop`（記録で数えた）／`obs`（観測で数えた））
  - `prevObs`（未読用の前回の観測の種類。通知用の `last` とは別に持つ）
  - `lastTurnEndTs`（この窓に結んだ返事の終わりの記録のうち、最後の ts。受けなかった記録も含む）
- 観測の種類: `observe(windowId, status, waitingFor)` で、status が "waiting" か waitingFor があれば「待ち」、それ以外は status そのもの（busy／idle／unknown）とする。busy＋waitingFor・idle＋waitingFor も「待ち」。
- 時計: hub の constructor の options に `now?: () => number`（既定 `Date.now`）を足し、`lastClearAt` と保留の時刻はこれで取る。`BreakTracker` には hub から時刻を渡す。
- 決まり（上から順に当てる）:
  - R1 返事の終わりの記録（道A）: 記録に Stop か StopFailure が届き、次の全部に当てはまるとき「受けた」とする。
    1. `stop_hook_active` が true でない（別の Stop hook に止められて続けた後の終わりは、同じ 1 回の返事なので受けない）。ただし true でも、その窓の `lastClearAt` が `lastTurnEndTs`（前の Stop）より後なら受ける（見張りの続きの間に PO が送って消した場合、続きの終わりを漏らさない）。この判定は窓の値が要るので `BreakTracker` で行い、`ActivityStore` は `stop_hook_active` を事件に載せて渡す。
    2. ts が `startedAt` 以上（`startedAt` は `ActivityStore` を作ったときに注入の `now()` で取る。起動時に読み直す昔の記録で足さない）。
    3. （会話番号, ts）の組がまだ受けていない組。組はその会話の `SessionState` に持ち、`dropOldSessions` で会話ごと捨てる（ファイルを先頭から読み直したときに 2 度受けない）。組は会話ごとに新しい 500 個までにし、超えたら ts の古い順に捨てる（`chatKeys` の刈り方 server/activity.ts:409-413 と同じ形。1 日の Stop は全会話で 503 行なので、1 会話で 500 を超える前に読み直しの範囲（今日・昨日）を外れる）。
    4. 窓に結んだ後で、ts がその窓の `lastClearAt` より後（PO が Enter を押した後に、押す前の Stop を読み込んだ場合に付け直さない）。
    - 結んだ記録は、受けても受けなくても `lastTurnEndTs = max(lastTurnEndTs, ts)` にする（1 の判定の後で更新する）。
    - 受けたら: `hookSeen = true`。`open` が `none` なら 1 足して `open = stop`。`open` が `stop` か `obs` なら足さず `open = stop`（同じ待ちを観測か前の記録が既に数えている）。
  - R2 待ちに入った観測（道W）: 観測の種類が「待ち」かつ `prevObs` が「待ち」でないとき。`open` が `none` なら 1 足して `open = obs`。それ以外は足さない。busy を観測していなくても足す（idle→waiting を 10 秒以内に通った場合・PO が答えた後に次の確認が出た場合）。
  - R3 返事の終わりの観測（道B、hook の無い窓の予備）: 観測で `prevObs === "busy"` かつ `next === "idle"`、かつ `hookSeen` が false のとき。`open` が `none` なら 1 足して `open = obs`。`hookSeen` が true の窓では使わない（返事の終わりは R1 が数える。Stop の後に遅れて busy を見ても 2 度数えない）。
  - R4 仕事の観測: 観測の種類が busy（waitingFor なし）のとき `open = none`（次の待ちを別に数えられるようにする）。
  - R5 毎回の観測の最後に `prevObs` = 今回の観測の種類。Claude が見つからない（status が null）ときは `prevObs` を消す（今の `observe` :51-53 と同じ）。
- 1 つの窓で起きる順番と数（K7・K10・K11・K13 で固定する）:

| 起きた順 | 未読 |
|---|---|
| 3 秒の短い返事: Stop | 1 |
| 長い返事: 観測 busy → Stop → 観測 idle | 1 |
| 長い返事: 観測 busy → 観測 waiting → Stop | 1 |
| Stop → 遅れた観測 busy → 観測 idle | 1 |
| 見張りが止めて続けた返事: Stop(false) → 観測 busy → Stop(true) → 観測 idle | 1 |
| 返事の途中の確認: 観測 idle → 観測 waiting（busy を見ない） | 1 |
| 確認に Enter で答える → 次の確認: 観測 waiting → Enter → 観測 waiting | 1 → 0 → 1 |
| 確認に答え、返事が終わる: 観測 busy → waiting → Enter → busy → Stop | 1 → 0 → 1 |
| StopFailure と Stop が同じ返事で両方来た場合 | 1 |
| Enter の後に、押す前に書かれた Stop を読み込んだ | 0 |
| hook の無い窓: 観測 busy → 観測 idle | 1 |
| 選択肢の画面が idle＋waitingFor で返る: 観測 busy → 観測 idle＋waitingFor（Stop を受けたことのある窓） | 1 |
| 選択肢の画面が busy＋waitingFor で返る: 観測 busy → 観測 busy＋waitingFor | 1 |
| 見張りの続きの間に PO が送る: 観測 busy → Stop(false) → Enter → Stop(true) → 観測 idle | 1 → 0 → 1 |

- 結べない記録の保留: `onTurnEnd` で届いた記録（R1 の 2・3 を満たしたもの）で、その会話番号を `claudeSessionId` に持つ窓がまだ無いとき（新しく開いた窓の最初の返事など）は、`stopHookActive` ごと保留する。R1 の 1 は保留の前に当てない。結ぶときに ts の順に R1 の 1（前半・後半）・4・`lastTurnEndTs` の更新・「受けたら」を当てる。
  - 保留の時刻は hub が受けた時刻（注入の `now()`）。待つ長さは `max(30 秒, 3 × agentsPollMs)`（agents の取得 3 回分。設定 agentsPollMs は正の数なら何でも通る server/config.ts:141・:301）。以下の「30 秒」はこの長さを指す。
  - 見直しは `detectBreaks()` の最後（番号を付けた後）。順は「結べるものを結ぶ（上の順で当てる）→ 残りのうち受けてから 30 秒を超えたものを捨てる」。捨てた件数をサーバーのログに 1 行出す。
  - agents の取得に失敗した回（server/hub.ts:572 で早く戻る）は、早く戻る前に「30 秒を超えたものを捨てる」だけを行う（番号が付かないので結ぶ見直しはしない）。
  - 窓を一覧から外したとき（`forget`）は、その窓の状態を捨てる。保留はまだ窓に結んでいないので、30 秒で捨てる決まりのまま。
  - 同じ会話番号を持つ窓が 2 つあるとき（server/hub.ts:582 で起こりうる）は、両方の窓に R1 を当てる（漏らさない方を選ぶ）。
- 形:
  - `ActivityStore` に `onTurnEnd(listener: (e: { claudeSessionId: string; ts: number; failed: boolean; stopHookActive: boolean }) => void)` を足す。`apply()` の `case "Stop"`・`case "StopFailure"` から、R1 の 2・3 を満たすときに呼ぶ（1 は窓の値が要るので `BreakTracker` が見る）。`loadFileHistory`（server/activity.ts:301）は通らない。
  - hub の `watchActivity` の型（server/hub.ts:215）に `onTurnEnd` を足す。受けたら窓を探して `BreakTracker.addTurnEnd(windowId, { ts, stopHookActive, failed }, now)` を呼ぶ（結べなければ保留）。配信は既存の `onChange`（server/activity.ts:280-283）に任せる。
  - `BreakTracker.observe(windowId, status, waitingFor)` は今までどおり `isBreak(prev, status)` で true/false を返す（通知用。waitingFor は通知の判定に使わない）。同じ呼び出しの中で R2〜R5 を当てる。hub は server/hub.ts:584 で `agent?.waitingFor` も渡す。

### 4-2. 未読を消すとき（PO 決定「1」）
- 前: 行を選んだとき、選んでいる行に未読が来たとき（窓が見えていれば）に消える。
- 後: 次の 2 つのときだけ消す。消すと `unread = 0`、`lastClearAt = now()`、`open = none`、`prevObs` を消す。
- 消す口: hub に `clearUnread(windowId)` を足す。`BreakTracker.clear(windowId, now())` を呼び、数が 0 でなかったら配信する（`publish`。今の `markRead` の配信 server/hub.ts:618-619 と同じ）。`markRead` もこれを呼ぶ。
  1. 端末への入力に Enter の文字（`\r`）が含まれるとき。`attachWebSockets` が deps の hub から `onSubmit`（= `hub.clearUnread`）を作って `attachTerminal` に渡し、server/ws.ts:36 で `sessions.write` の前に呼ぶ（`lastClearAt` が Claude の受け取りより必ず前になるように）。端末の入力を `sessions.write` に流す製品の場所はここ 1 か所。
     - 消える: 普通に送る・選択肢を Enter で選ぶ・許可に Enter で答える・よく使う指示／差分のコメント／選んだ物の送信（`pasteSubmitAfter`）。
     - 消えない: クリックやフォーカスで端末が出す文字（`\x1b[I`・`\x1b[O`）、矢印、マウスの報告、端末の自動の応答。どれも `\r` を含まない。
     - 確認の画面で数字キーだけで答えた場合、`\r` が送られるかは未確認。送られなければ消えない（印が残る。§6・K17）。
     - 送っていないのに消える（受け入れる。§6）: 改行を含む文の貼り付け（TerminalPane.tsx:32-33・:97・:104）、「挿入だけ」のよく使う指示で複数行を入れたとき、Alt+Enter。
  2. チャット欄から送り、予約に積めた時点。`enqueueChat`（server/hub.ts:402）の中で、窓が無い・止まっている・予約が満杯の確かめ（:403-407）を通り、予約に積んだ後（:409 の後、:410 `bumpChat` の前）に `BreakTracker.clear` を呼ぶ（配信は :410 の `bumpChat` に任せる。server/hub.ts:440-443）。確かめで断ったときは消さない。端末へ書く :533 では消さない（予約があとで書かれたとき、その前に付いた未読を消さないため）。製品の呼び出し元は server/chat-routes.ts:71 だけ。
  - 消さない: 定期実行・引き継ぎの `submitText`（server/launch.ts:114、server/relay.ts:232・:272）、名前の変更の `/rename`（server/hub.ts:300・:369・:386）。どれも ws と `enqueueChat` を通らない。
- 画面: src/pages/ConsolePage.tsx:219-223 の自動の既読を削る。:232 の `handleSelect` の既読も削る。
- `markRead` の API（src/api.ts:55、server/http.ts:327-328、server/hub.ts:618-620）は残す。画面からは呼ばない。中身は上の消し方（`lastClearAt` などもそろえる）にする。理由: 試験 tests/unit/daily-use.integration.test.ts:127 が受け口の 404 を確かめている。

### 4-3. 変えないこと
- タイトルの合計（ConsolePage.tsx:214-217）と一覧の印（SessionList.tsx）は今の `unread` をそのまま出す。
- macOS の通知は `isBreak`（`observe()` が true）のまま。

## 5. 代替案と選ばなかった理由
- A. 観測の間隔を短くする（10 秒→1 秒）: `claude agents --json` を 10 倍呼ぶ。1 秒未満の返事はなお漏れる。原因1も直らない。不採用。
- B. 画面が見えていないときだけ自動既読を止める: PO はほとんど今の窓を開いたまま待つので、原因1が残る。PO の決定「1」と合わない。不採用。
- C. 行を選んだら消す（今の定義を残す）: PO が選んだ「1」と違う。不採用。
- D. 道A（Stop）だけにする（第1版）: 返事の途中の許可・選択肢の待ちで未読が付かなくなる。不採用。
- E. 未読も通知の `isBreak` に頼る（第2版）: busy を観測しない待ち（idle→waiting を 10 秒以内に通る・答えた後に次の確認が出る）を漏らす（第2版の審査 直す点1）。不採用。
- F. 選択肢の道具を記録用 hook で記録して足す: hook の形と Claude の設定の入れ替えが要る。許可の確認は道具ではないので拾えない。不採用。
- G. 採用案（R1〜R5、`open` で同じ待ちを 2 度数えない、PO の送信で消す）: 既にある記録と観測を使い、hook も Claude の設定も変えない。

## 6. リスクと対処
- 記録用 hook が入っていない環境: R1 が来ないので `hookSeen` が false のまま。R2・R3 が今の判定と同じかそれ以上に拾うので、今より悪くはならない。この Mac では入っている（~/.claude/settings.json の Stop に activity-hook.mjs）。
- `hookSeen` が true になった窓で、後から記録が届かなくなった場合: 返事の終わりで idle になる待ちを数えない（R3 を使わないため）。件の窓の記録が捨てられる道（401・409・時間切れ。§2）がこれに当たる。件の部屋は今使えない状態なので、今は起きない。件の部屋を使えるように戻す便の受入に次を写す。(1) D/cases/<id>/session-id の番号と、その件の窓の今の会話番号を比べ、違えば 409 で捨てられている。(2) その件の窓で短い質問を送り、5 秒以内に印が付くかを見る。
- 1 回の入力に Stop が何度か来る（hooks/activity-hook.mjs:174 の注釈）: `stop_hook_active` が true の Stop は受けない。件でない窓には同期の作戦ボードの見張りの Stop hook がある（server/activity-hooks.ts:70-71）。見張りが止めた 1 回目の Stop（false）で印が付く（Claude はまだ書いている）。続きの間に busy を観測しても、終わりの Stop(true) は受けない。終わりの観測が idle なら R3 を使わないので、数は 1 のまま（§4-1 の表）。終わりの観測が「待ち」なら、busy で `open` が `none` に戻っているので R2 で 1 足し、2 になる。印が早く付くことと、この場合に 2 と数えることは受け入れる。続きの間に PO が送って消した場合は、Stop(true) も受けるので漏れない（§4-1 R1 の 1・K7）。
- 返事の終わりの状態が waiting になるかは未確認（notify.ts:24 の言葉では waiting は「回答待ち」、idle は「指示待ち」）。waiting になる場合、「Stop → 遅れた観測 busy → 観測 waiting」で 2 と数える（busy で `open` が `none` に戻るため）。印は付くので PO の願いには影響しない。実機の確かめ K17 で状態を記録し、2 と数える場面が実際に出たら、直すかを PO に聞く。
- StopFailure と Stop が同じ返事で両方来るかは未確認（Claude Code の hooks の文書は書いていない。この Mac の記録で StopFailure は 0 行）。来ても R1 の `open = stop` で 2 つ目は足さない（§4-1 の表）。
- PO が確認に Enter で答えた直後、次の観測（10 秒以内）でまだ waiting と出る場合: `prevObs` を消しているので R2 で 1 足す（答えたのに印が戻る）。答えた後に状態が何秒で変わるかは未確認。実機の確かめ K17 で見る。戻る場合は直すかを PO に聞く。
- 送っていないのに消える場合（§4-2 の 1）: どれも PO がその窓の端末に打った操作なので受け入れる。
- 数字キーだけで答えて `\r` が送られない場合: 消えずに印が残る。印が付かない（PO の困りごと）よりは、残る方を選ぶ。K17 で確かめる。
- 結べない記録の保留が溜まる: 30 秒で捨てるので、数は agents の 3 回分の間に終わった返事の数を超えない。
- PO の送信が今の返事に取り込まれず次の返事になる場合（見張りの続きの間の送信・作業中の先打ち）: 印は早く付き、次の返事の終わりまでに busy を観測すると 2 と数える。印は付くので願いには影響しない。取り込まれるかは未確認で、K17(e) で「送った文が同じ返事に入ったか」も記録する。
- busy＋waitingFor と busy（waitingFor なし）が、PO の入力なしに交互に観測される場合: 待ちに入るたびに 1 足す。busy＋waitingFor が実機で何を意味するかは未確認（server/agents.ts:12・:47）。K17(d) で「busy＋waitingFor が続く間の数」も記録し、増える場面が出たら直すかを PO に聞く。
- 起動直後、または Claude が一度見つからず観測が空になった後の最初の観測が「待ち」の場合: `prevObs` が無いので R2 で 1 足す（今の通知は最初の観測を数えない server/notify.ts:55-57）。実際に待っている窓なので、印を付ける方を選ぶ。
- 2 つの窓が同じ会話番号を持つ場合: 両方に付く。片方で送っても他方は残る。
- 試験の書き換え: src/pages/ConsolePage.test.tsx:339-344 と tests/e2e/console.spec.ts:612-650 は「選んだら既読」を確かめている。新しい定義（選んでも残る・Enter で消える）を確かめる試験に書き換える。e2e の通知の確かめ（K9）は未読と分けて残す。

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 Claude が 3 秒で終わる短い返事をしたとき、5 秒以内にその窓の行に「未読 1 件」が付く | 単体（窓に `claudeSessionId` を付けた状態で、Stop の記録を 1 行足して refresh → unread 1）＋PO の目視 |
| K2 その窓を開いて見ている間も、印は消えない（30 秒見続けても残る） | 単体（ConsolePage で選んでいる行に unread 1 が来ても markRead が呼ばれない）＋PO の目視 |
| K3 行を選んだだけでは消えない | 単体（handleSelect で markRead が呼ばれない） |
| K4 その窓の端末で Enter を押す（選択肢を選ぶを含む）と消える。矢印キー・クリックだけでは消えない。消えたことがすぐ画面に届く | 単体（ws に "\r" を含む input → unread 0。"\x1b[A"・"\x1b[I"・"\x1b[O" → 残る。`clearUnread` で数が 1→0 のとき publish が 1 回呼ばれる・0→0 では呼ばれない。`onSubmit` は `sessions.write` より前に呼ばれる）＋PO の目視 |
| K5 チャット欄から送って予約に積めた時点で消える。予約があとで端末に書かれても、その後に付いた未読は消えない | 単体（enqueueChat の後 unread 0。その後 Stop で unread 1 → 予約を flush しても 1 のまま） |
| K6 定期実行・引き継ぎ・名前の変更の送信では消えない | 単体（submitText の後と /rename の後も unread が残る） |
| K7 見張りに止められて続けた返事は 1 回と数える。続きの間に PO が送って消したら、続きの終わりで付く | 単体（Stop(false) → 観測 busy → Stop(true) → 観測 idle で 1。Stop(false) → 観測 busy → Enter（0）→ Stop(true) → 観測 idle で 1。Enter が無ければ Stop(true) は受けない） |
| K8 サーバーを入れ替えて起動した直後、昔の返事で未読が付かない。記録ファイルを先頭から読み直しても 2 度足さない | 単体（now を固定し、startedAt より前の ts の Stop → 0。同じ Stop の行を持つファイルを縮めて読み直す → 1 のまま）。`onTurnEnd` の単体は tests/unit/activity.test.ts |
| K9 macOS の通知は今までどおり出る | 既存の通知の試験と、書き換えた e2e の通知の部分が通る |
| K10 返事の途中で許可・選択肢の画面を出して止まったとき、busy を観測していなくても未読が付く。選択肢の画面が idle・busy に waitingFor を添えて返っても付く | 単体（tests/unit/notify.test.ts。最初の観測が waiting → unread 1・observe は false。観測 busy→waiting で 1。観測 idle→waiting で 1。観測 waiting → Enter → 観測 waiting で 1→0→1。Stop を受けたことのある窓で busy → idle＋waitingFor で 1。busy → busy＋waitingFor で 1。e2e の偽の claude は waitingFor を返さないので単体で見る） |
| K11 Stop と観測の両方が来ても、同じ待ちは 1 回と数える | 単体（Stop → idle で 1。busy → waiting → Stop で 1。Stop → busy → idle で 1。Stop → waiting で 1） |
| K12 窓と会話番号が結ばれる前に終わった返事は、結ばれた後に付く | 単体（保留中の Stop(false)・Stop(true) を一度に結ぶと 1、2 つの間に Enter があれば 0→1。agentsPollMs を 20000 にすると待つ長さは 60 秒。時計を注入。番号の無い窓で Stop → 0 → 番号を付けて detectBreaks → 1。受けてから 31 秒後の見直しでは捨ててログ 1 行。同じ見直しで結べるものは捨てる前に結ぶ（31 秒目に番号が付いた窓 → 1）。agents の取得が失敗し続けても、31 秒後の回で保留は捨てられる。結ぶ前に Enter で消していたら、結んでも Stop の ts が `lastClearAt` 以前なら 0。同じ番号の窓 2 つ → 両方 1。窓を外した後 `forget` で状態が消える） |
| K13 API の失敗で返事が止まったとき（StopFailure）も付く。StopFailure と Stop が両方来ても 1 | 単体（StopFailure → 1。StopFailure → Stop → 1） |
| K14 既存の試験・型検査・lint がすべて通る | CI |
| K15 PO が Enter を押す前に書かれた Stop を、押した後に読み込んでも付かない | 単体（Stop の ts = 100、Enter で `lastClearAt` = 150、その後に Stop を読み込む → 0） |
| K16 チャット欄の送信を断ったとき（窓が止まっている・予約が満杯）は消えない | 単体（予約満杯で enqueueChat が投げる → unread 1 のまま） |
| K17 実機の確かめ（結果を記録に残す。合否でなく事実を取る）: (a) 返事の終わりの状態が idle か waiting か (b) 確認の画面で数字キーだけで答えたとき印が消えるか (c) 確認に Enter で答えた後 20 秒の間に印が戻らないか (d) 選択肢・質問の画面での status と waitingFor (e) 見張りに止められて続けた返事で、続きの間に送ったとき終わりで印が付くか | Opus が実機の窓で行い、server のログか画面で記録する。(b)・(c)・(e) が × なら、直すかを PO に聞く |

## 8. 維持の仕組み
- 未読の正本は hub のメモリ（BreakTracker）1 か所のまま。足す決まりは R1〜R5、消す道は PO の送信 2 本に固定し、試験 K3〜K8・K10〜K13・K15・K16 で固定する。
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

## 11. 第2版の審査（REVISE・8 件）への対応
| # | 指摘 | 対応 |
|---|---|---|
| 1 | busy を観測しない待ち（idle→waiting・答えた後の次の確認）を漏らす | 未読を `isBreak` から切り離し、R2（待ちに入った観測）を足した。PO の送信で `prevObs` を消す（§4-1・§4-2）。K10 |
| 2 | Stop → 遅れた busy → idle で 2 と数える | Stop を受けた窓では返事の終わりの idle を数えない（R3 は `hookSeen` が false の窓だけ）。K11 |
| 3 | 見張りで続けた返事の間に観測が入ると 2 になる | 同じく R3 を使わないので 1。§6 を直した。K7 |
| 4 | Enter が Stop の読み込みより先だと 1 が残る | `lastClearAt` より前の ts の Stop は受けない（R1 の 4。保留を結ぶときも同じ）。K15 |
| 5 | 保留の細目 | 時計を hub に注入し、受けた時刻から 30 秒。結ぶときも R1 の 4 を当てる。`forget` で窓の状態を捨てる。同じ番号の窓 2 つは両方。K12 |
| 6 | 偽の store は無い | §3 を直した。harness は本物の `ActivityStore`（tests/unit/helpers/harness.ts:268-269）。`onTurnEnd` の単体は tests/unit/activity.test.ts |
| 7 | StopFailure と Stop の両方が来ると 2 | 来るかは未確認と書き、来ても `open = stop` で 1 にした。K13 |
| 8 | チャットの消す場所 | 確かめ（:403-407）を通って予約に積んだ後（:409 の後）に消す。断ったら消さない。K16 |
| 推奨 | 二重防止の組の置き場・単体の場所 | 組は `SessionState` に持つ。単体は tests/unit/activity.test.ts（§4-1・§7） |

## 12. 第3版の審査（REVISE・直す点 5 件・推奨 3 件）への対応

| # | 指摘 | 対応（第4版の場所） |
|---|---|---|
| 1 | R2 が status "waiting" だけを見る。選択肢の画面が idle・busy＋waitingFor で返ると、Stop を受けた窓で 0 になる | 観測の種類「待ち」を status "waiting" か waitingFor ありと決め、R2・R4・R5 をこの種類で判定（§4-1）。`observe` に waitingFor を渡す（server/hub.ts:584・§3）。§2 に server/agents.ts:47・86・101 を追加。K10 に 2 つの単体、K17 に (d) |
| 2 | 見張りの続きの間に PO が Enter を押すと、終わりの Stop(true) を受けず漏れる | R1 の 1 に「`lastClearAt` が前の Stop より後なら true でも受ける」を追加。窓ごとに `lastTurnEndTs` を持つ。判定は `BreakTracker`、`onTurnEnd` は `stopHookActive` を渡す（§4-1）。表に 1 行、K7 に追加、K17 に (e) |
| 3 | §6 の「数は 1 のまま」は終わりが idle のときだけ | §6 に終わりが「待ち」なら 2 と数えることを明記 |
| 4 | agents の取得が失敗した回（hub.ts:572）は保留の見直しも 30 秒の捨てるも動かない。結ぶと捨てるの順が無い | 順を「結ぶ → 30 秒超を捨てる」と決め、失敗の回は早く戻る前に捨てるだけ行う（§4-1）。K12 に追加 |
| 5 | ws の消す道が配信しない | hub に `clearUnread(windowId)` を足し、数が変わったら publish。`markRead` も同じ口を使う（§4-2）。K4 に追加 |
| 推1 | （会話番号, ts）の組に上限が無い | 会話ごとに新しい 500 個まで、古い順に捨てる（§4-1 R1 の 3） |
| 推2 | SessionState の行 | server/activity.ts:133-153 に直した（§2） |
| 推3 | `lastClearAt` を write より前に取る | `onSubmit` を `sessions.write` の前に呼ぶ（§4-2・K4） |

## 13. 第4版の審査（APPROVE・直す点 2 件・推奨 3 件）への対応

| # | 指摘 | 対応（第4.1版の場所） |
|---|---|---|
| 1 | `addTurnEnd(windowId, ts)` に `stopHookActive` が無い | §4-1 の形を `addTurnEnd(windowId, { ts, stopHookActive, failed }, now)` に |
| 2 | 保留に入れる条件「R1 の 1〜3」が §4-1 の形と食い違う | 保留は R1 の 2・3 を満たした記録を `stopHookActive` ごと持ち、結ぶときに ts の順で R1 の 1・4 を当てる（§4-1）。K12 に 2 件 |
| 推1 | 表に無い 3 つの場面を §6 に | §6 に 3 行。起動直後の最初の待ちは K10 に 1 件 |
| 推2 | 保留の 30 秒が agentsPollMs 10000 前提 | 待つ長さを `max(30 秒, 3 × agentsPollMs)` に（§4-1）。K12 に 1 件 |
| 推3 | ws.ts :102 を §3 に | §3 に追加 |
