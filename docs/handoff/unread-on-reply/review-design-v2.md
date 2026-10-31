HEAD: 8d3daeea39b35263298e4e8a4c3d3ba969630676
判定: REVISE

# 設計審査 v2: 返事が来たら未読を付け、PO が送るまで消さない（第2版）

- 対象: docs/handoff/unread-on-reply/design.md 第2版（origin/release/unread-on-reply 8d3daee）
- 第1版の審査: origin/release/unread-on-reply-review-report の docs/handoff/unread-on-reply/review-design-v1.md（a5ee1b2 に対して REVISE・12 件）
- 照合したコード: origin/main de28ba7（8d3daee と origin/main の差分は design.md 1 ファイルだけ。`git diff --stat origin/main HEAD` で確認）
- 審査役は製品コードを変更していない。見張りに止められたことは無い。
- この Mac の実物（installed の設定、events-*.jsonl の 503 行、cases/ の状態）と、`claude agents --json` が Stop hook を実行している間に何を返すかは見られないので「未確認」と書く。

## 1. 第1版の 12 件への対応（§10 の表と本文の照合）

| # | 第1版の指摘 | 第2版の本文 | 結果 |
|---|---|---|---|
| 1 | 返事の途中の許可・選択肢待ちで未読が付かなくなる | §4-1 道B を残し、道A と 2 本にした | 直った。ただし道B 自体に、今もある数え漏れが残る（§2 の 順番1・2。直す点 1） |
| 2 | チャットで消す場所は受付 | §4-2 の 2 で `enqueueChat`（server/hub.ts:402）で消す。:533 では消さない | 直った |
| 3 | 結べない記録の扱い | §4-1 の 30 秒保留、K12 | 直った。時計の出どころなどの細部は直す点 5 |
| 4 | 件の窓で記録が届かない道 | §2（design.md:25）と §6（design.md:96）。401（server/http.ts:440・:445）・409（:446）・時間切れ（hooks/activity-hook.mjs:13・:256）を書き、確かめる手順も書いた | 直った |
| 5 | 起動時刻と二重の防止 | §4-1 の 2・3、K8 | 直った（§3 で実装できる形か確認） |
| 6 | 見張りの 1 回目の Stop で早く付く | §6（design.md:97）で受け入れ | 早く付くことは書いた。ただし「数は 1 のまま」は成り立たない順番がある（§2 の 順番5。直す点 3） |
| 7 | StopFailure | §4-1 の 4、K13 | 直った。Stop と両方来たときは未確認（直す点 7） |
| 8 | 送っていないのに消える場合・ws への hub の渡し方 | §4-2 の 1（design.md:73-76）と §6 | 直った |
| 9 | pasteSubmitAfter・引き継ぎ・/rename | §2（design.md:27・:29）、§4-2、K4・K6 | 直った |
| 10 | markRead の扱い | §4-2（design.md:80）で残す。画面からは呼ばない | 直った |
| 11 | 触る範囲の漏れ | §3 に e2e・notify.test・ja.json・README・stage2・CHANGELOG・版 0.49.0 を足した | ほぼ直った。「hub の試験の偽の store」は実在しない（直す点 6） |
| 12 | 行番号・489 行 | §2 の行番号は下の §5 の表のとおり全部 origin/main と合う。503 行は数えた時刻と方法を書いた | 直った（503 行そのものは未確認） |

## 2. 道A・道B と 2 つの印で正しく数えられるか（観測 10 秒・記録の読み込み 2 秒）

前提（コードの事実）:
- 道B の判定は `isBreak(prev,next)` = `prev === "busy" && (next === "waiting" || next === "idle")`（server/notify.ts:9-11）。`prev` は前の観測の値（server/notify.ts:55-56）。観測は agents の取得ごと（server/hub.ts:570-590、同梱の agent-console.config.json:9 で 10000ms）。
- 道A の記録は 2 秒ごとの `refresh`（server/activity-start.ts:10・:40）と agents の取得ごと（server/index.ts:114）に読まれる。
- 印の規則（design.md:57-60）: 道A で足したら `stopSeen`、道B で足したら `breakSeen`。`stopSeen` が立っていれば道B は足さない。`breakSeen` が立っていれば道A は足さずに倒す。両方とも「観測で busy を見たとき」と「PO の送信で消したとき」に倒す。道A は `stopSeen` を見ない。

以下 t は秒。O は観測、R は記録の読み込み、E は PO の Enter（消す）。

### 正しく数えられる順番（設計の例どおり）
- 順番A（K1 短い返事）: O(t=0) idle → E(t=1) 0 → Claude 3 秒で終わり Stop(ts=4) → R(t≤6) 道A +1・stopSeen → O(t=10) idle（idle→idle で道B なし）。**1。正しい。**
- 順番B（K11 Stop が先）: O(0) busy → Stop(ts=12) → R(≤14) 道A +1・stopSeen → O(20) idle、busy→idle だが stopSeen で道B なし。**1。正しい。**
- 順番C（K11 観測が先）: O(0) busy → O(10) idle、道B +1・breakSeen → Stop(ts=9.8) が R(11) で届く → breakSeen で道A なし・印を倒す。**1。正しい。**
- 順番D（K10 遅い許可）: O(0) busy → 許可の画面 → O(10) waiting、道B +1・breakSeen → E で 0・印を倒す → Claude が続けて終わり Stop → 道A +1。**合計で付いたのは 2 回（待ちも 2 回）。正しい。**
- 順番E（背景の知らせ）: 前の返事で stopSeen が立ったまま → Claude が背景の知らせで起き、3 秒で Stop → 道A は stopSeen を見ないので +1 → 2。**正しい。** 長い返事なら O で busy を見て印が倒れ、順番B か C と同じ。正しい。
- 順番F（K12 新しい窓）: 窓に `claudeSessionId` が無い → Stop は保留 → 次の O で server/hub.ts:581 が番号を付け、:584 で observe（初回なので prev は undefined、道B なし）→ 最後に保留を見直して道A +1。**1。正しい。** 長い返事なら :584 で道B が先に +1・breakSeen、その後の保留の見直しで道A は足さない。**1。正しい**（見直しが同じ規則を通ることが条件。直す点 5）。

### 数え漏れ・数えすぎになる順番
- **順番1【数え漏れ・重大】返事の始まりから 10 秒以内に許可・選択肢の画面が出る。** O(0) idle → E(1) → Claude が 3 秒で許可を求めて止まる（waiting）→ O(10) waiting。`prev` は idle なので `isBreak` は false（server/notify.ts:10）。Stop は来ない（返事の途中）。**未読 0。** K10（design.md:114）は「観測で busy → waiting」しか試さないので、この順番は試験でも見つからない。§1 の「待つ状態になるたびに」「許可の確認や選択肢の画面を出して止まった」（design.md:8-10）を満たさない。これは今の製品にもある漏れ（§2 原因2 と同じ仕組み）で、第2版は道B を「今のまま」残したので直っていない。PO の観測「選択肢を出していたが未読はついていなかった」（design.md:7）がこの順番だった可能性もある（どちらだったかは未確認）。
- **順番2【数え漏れ】許可に答えた直後に次の許可が出る。** O(0) waiting → E(2) で答えて 0 → Claude が 2 秒動いて次の許可（waiting）→ O(10) waiting。waiting→waiting で道B なし。**未読 0。**
- **順番3【数えすぎ】Stop の記録が先に読まれ、その後の観測がまだ busy を返す。** 件でない窓には同期の見張りの Stop hook がある（server/activity-hooks.ts:70-71、timeout 15、設計の注釈で最大実測 3.7 秒）。記録用 hook は Stop の時点で書くので、Stop の記録は見張りが動いている間に読まれ得る。O(0) busy → Stop(ts=9) → R(10) 道A +1・stopSeen → O(10.5) まだ busy（見張りの実行中、または状態の更新の遅れ）→ **印が倒れる** → O(20.5) idle、busy→idle で stopSeen が無いので道B +1。**2。** `claude agents --json` が Stop hook の実行中に busy を返すかは未確認。返すなら、見張りの時間 ÷ 10 秒の割合で毎回起こり得るので、K11「どちらが先でも 1 回」（design.md:115）が崩れる。
- **順番4【数えすぎ】返事の終わりから記録の読み込みまでの間（最大 2 秒）に PO が Enter を押す。** Stop(ts=10) → E(10.5) で 0 → R(11) 道A +1。PO がもう答えた待ちで未読が 1 残る。道A の条件（design.md:51-55）に「最後に消した時刻より前の ts は足さない」が無い。
- **順番5【数えすぎ】見張りに止められて続けた返事が観測をまたぐ。** O(0) busy → 見張りが 1 回目の Stop(false) を止める → R 道A +1・stopSeen → Claude が続ける → O(10) busy で**印が倒れる** → Claude が終わる → Stop(true) は道A が足さない（design.md:52）→ O(20) idle、道B +1。**2。** §6 の「本当の終わり（true）では足さないので、数は 1 のまま」（design.md:97）は、続きが 10 秒に届かないときだけ成り立つ。K7 の試験（design.md:111）は記録 2 行だけで観測を入れないので見つからない。見張りは窓ごとに 1 回だけ止める（hooks/board-guard.mjs:96・:102）ので頻度は低い。

順番3〜5 は未読が多めに出るだけで「気づかない」を悪くはしないが、設計が「1 回と数える」と約束している（K7・K11）ので、規則か約束のどちらかを直す必要がある。順番1・2 は PO の願いそのものに当たる。

## 3. K12 の保留と K8 の二重防止は実装できる形か

- K8:
  - `startedAt` を `ActivityStore` の作成時に注入の `now()`（server/activity.ts:243-250）で取る形は実装できる。リスナーの登録は作成の直後（server/activity-start.ts:37-38）で、最初の `refresh` は :40 の `startPolling` からなので、`startedAt` から登録までの間の取りこぼしは無い。
  - （会話番号, ts）の組の記憶を「`dropOldSessions`（server/activity.ts:352-355）と同じく古い会話を捨てるときに一緒に捨てる」は、`SessionState` の中に持たせれば :354 の削除で一緒に消えるので実装できる。設計に「どこに持つか（`SessionState` の中）」を 1 行書くと迷わない（直す点ではなく推奨）。
  - ファイルが縮んだときの読み直し（server/activity.ts:312-313）でも、組の記憶で 2 度足さない。`loadFileHistory`（:301）は PostToolUse のファイルの記録だけを通すので Stop は来ない。設計の記述（design.md:66）と合う。
- K12:
  - 見直しの場所「`detectBreaks()` の最後」は、番号付け（server/hub.ts:571 の `attachCaseSessionIds`、:581 の `setClaudeSessionId`）の後なので正しい。
  - 足りない点（直す点 5）: (1) 30 秒をどの時刻から測るか（hub が受けた時刻か、記録の ts か）と、時計を `Date.now` にするか注入にするか。K12 の「31 秒後の見直し」を試験で書くには決まっている必要がある。(2) 保留が解けて足すときも、`breakSeen` と（直す点 4 を入れるなら）最後に消した時刻を同じ規則で見ること。§2 の順番F の 2 つ目はこれが前提。(3) `BreakTracker.forget()`（server/notify.ts:71-74。窓を一覧から外したとき server/hub.ts:139-140 で呼ぶ）で印と保留も消すこと。(4) 同じ会話番号を持つ窓が 2 つあるとき（件でない窓同士は server/hub.ts:582 で外されない）にどちらへ足すか。

## 4. 消す道・消さない道の事実

- 消す道1（ws の `\r`）: 端末の入力は server/ws.ts:36 の 1 か所で `sessions.write` に渡る。`attachTerminal`（:22）は hub を持たず、hub は `attachWebSockets` の deps（:53）にある。設計の「deps の hub から `onSubmit` を作って渡す」（design.md:73）はこの形に合う。画面は `onData` を分割して送る（src/components/TerminalPane/TerminalPane.tsx:291-293）が、`\r` を含む塊があればよいので判定は崩れない。`pasteSubmitAfter`（TerminalPane.tsx:101-110）は :108 の `term.input("\r", true)` で同じ道を通る。事実どおり。
- 消す道2（`enqueueChat`）: 製品の呼び出し元は server/chat-routes.ts:71 だけ（`git grep` で確認。画面は src/components/ChatPane/ChatPane.tsx:118）。PO 以外が呼ぶ道は無い。事実どおり。ただし `enqueueChat` は :403-407 で 404・409 を投げるので、消すのは予約を積んだ後（:409 の後）と書く（直す点 8）。
- 消さない道: `submitText`（server/hub.ts:548-567）の呼び出し元は server/launch.ts:114、server/relay.ts:232・:272。`/rename …\r` は server/hub.ts:300・:369・:386。どれも `sessions.write` を直接呼び、ws と `enqueueChat` を通らない。チャットの予約の書き込み（:529・:533）も同じ。事実どおり。

## 5. 触る範囲と行番号

§2 の行番号は次のとおり origin/main と全部合う: server/notify.ts:9-11・:50-60・:58、server/hub.ts:215・:300・:369・:386・:402・:495-542・:533・:548-567・:570-590・:578-582・:596-615・:606-608・:617-620、server/activity.ts:243-250・:269-278・:280-283・:301・:311・:312-313・:393-397・:403-405、server/activity-hooks.ts:54・:60・:70-71、server/activity-start.ts:10、server/index.ts:114、server/ws.ts:22・:36・:53、server/http.ts:327-328・:416-426・:439-440・:445・:446、server/case-sandbox.ts:450、hooks/activity-hook.mjs:13・:134・:139・:173-177・:253-260・:281-288、src/pages/ConsolePage.tsx:214-217・:219-223・:230-233・:232、src/components/TerminalPane/TerminalPane.tsx:32-33・:97・:101-110・:104・:291-293、src/api.ts:55、src/locales/ja.json:165、README.md:295、docs/handoff/stage2/design.md:14・:32、docs/CHANGELOG.md:5、package.json:3、extension/manifest.json:4（どちらも 0.48.1）、tests/unit/notify.test.ts:42-60、src/pages/ConsolePage.test.tsx:339-344、tests/e2e/console.spec.ts:612-650、tests/unit/daily-use.integration.test.ts:127、agent-console.config.json:9。

漏れ・ずれ:
- §3（design.md:41）の「hub の試験の偽の store（`watchActivity` の型が変わるため）」に当たるものは無い。hub の試験の土台は本物の `ActivityStore` を渡している（tests/unit/helpers/harness.ts:268-269）。ほかの試験の `onChange:`（tests/unit/reservations.test.ts:34、tests/unit/routines.test.ts:61、tests/unit/case-agents.test.ts:103）は sessions などの偽物で `watchActivity` には渡っていない。型を足しても試験の偽物の直しは要らない見込み。書き方を直す（直す点 6）。
- `onTurnEnd` の単体試験は tests/unit/activity.test.ts に置くのが自然だが、§3 は「新しい単体試験」としか書いていない。置き場所を書くと迷わない（推奨）。

## 6. 判定: REVISE

直す点（8 件）:
1. 【重大】道B は busy を観測しないと許可・選択肢の待ちを拾えない。返事の始まりから 10 秒以内に許可が出る（idle→waiting）、答えた直後に次の許可が出る（waiting→waiting）順番で未読 0 になり、§1 の約束と K10 を満たさない（§2 の 順番1・2）。未読のための判定を通知の判定（server/notify.ts:9-11、通知は変えない）と分けて決める。例: 未読は「waiting に入った」（前が waiting でない）でも足す・PO の送信で未読用の前回値を消す、など。K10 に「busy を観測しない許可」と「続けて 2 回の許可」の試験を足す。
2. 【中】Stop を道A で足した後、観測がまだ busy を返すと印が倒れ、次の idle で道B がもう 1 回足す（§2 の 順番3）。見張りの同期 hook（server/activity-hooks.ts:70-71）の実行中や状態の遅れで起こり得る（`claude agents --json` の振る舞いは未確認）。印を倒す条件を「観測で busy」から変えるか（例: 倒すのは PO の送信と、Stop の ts より後に始まったと分かる busy だけ）、起こり得ると受け入れて K11 の約束を直す。K11 に「Stop → 観測 busy → 観測 idle」の順番を足す。
3. 【中】§6（design.md:97）「数は 1 のまま」は、見張りに止められた続きが観測をまたぐと 2 になる（§2 の 順番5）。直す点 2 の規則で 1 にするか、2 になり得ると書き直す。K7 の試験に観測を挟む順番を足す。
4. 【小】返事の終わりから記録の読み込みまで（最大 2 秒）の間に PO が Enter を押すと、消した後に前の Stop で 1 足される（§2 の 順番4）。窓ごとに最後に消した時刻を持ち、それより前の ts の Stop は足さない、などを道A の条件に足す。保留が解けたときも同じ。
5. 【小】K12 の保留: 30 秒を測る起点と時計（`Date.now` か注入か）、解けたときに `breakSeen`・直す点 4 の時刻を同じ規則で見ること、`forget()`（server/notify.ts:71-74、server/hub.ts:139-140）で印と保留も消すこと、同じ会話番号の窓が 2 つあるときの扱いを書く。
6. 【小】§3 の「hub の試験の偽の store」は実在しない（tests/unit/helpers/harness.ts:268-269 は本物の `ActivityStore`）。書き方を直す。
7. 【小】同じ回に StopFailure と Stop が両方来るかは未確認（この Mac の記録に StopFailure は 0 行。design.md:21）。両方来ると、道A は `stopSeen` を見ないので 2 になる。未確認と書いて受け入れるか、同じ回の 2 本目を足さない規則を書く。
8. 【小】`enqueueChat` で消すのは、検査（server/hub.ts:403-407）を通って予約を積んだ後（:409 の後）と書く。投げた要求で消さないため。

第1版の 12 件はすべて対応されている。残る直す点 1 は PO の願い（許可・選択肢の待ちで気づかない）そのものに当たるので、直してから実装に進むのがよい。
