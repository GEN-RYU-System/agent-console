HEAD: a5ee1b2418d152d9c92b641275a8253bb5e9f89b
判定: REVISE

# 設計審査 v1: 返事が来たら未読を付け、PO が送るまで消さない

- 対象: docs/handoff/unread-on-reply/design.md（origin/release/unread-on-reply a5ee1b2）
- 照合したコード: origin/main de28ba7（a5ee1b2 と origin/main の差分は design.md 1 ファイルだけ。`git diff --stat origin/main HEAD` で確認）
- 審査役は製品コードを変更していない。見張りに止められたことは無い。
- この Mac の実物（installed の設定、events-*.jsonl、件の窓 case-home の今の状態）は見られないので、それに関する主張は「未確認」と書く。

## 1. §2 の現在地の事実

| 設計の記述 | 実物 | 結果 |
|---|---|---|
| server/notify.ts:9-10 `isBreak` | server/notify.ts:9-11 同じ式 | 合う |
| `BreakTracker.observe()` が未読を 1 増やす | server/notify.ts:50-60（:58 で加算） | 合う |
| server/hub.ts:569-589 `detectBreaks()` | :569 は注釈、関数は :570-590 | ほぼ合う（1 行ずれ） |
| agentsPollMs = 10000 | 同梱の agent-console.config.json:9 は 10000。installed の値は未確認 | 一部未確認 |
| ConsolePage.tsx:216-220 自動既読 | src/pages/ConsolePage.tsx:219-223 | 3 行ずれ |
| :226-229 `handleSelect`、:228 の既読 | :230-233、既読は :232 | 3〜4 行ずれ |
| タイトルの合計 :212-215（§4-3） | :214-217 | 2 行ずれ |
| server/activity-hooks.ts:60 `{ event: "Stop" }` | 合う | 合う |
| hooks/activity-hook.mjs:173-177 stop_hook_active、:174 の注釈 | 合う | 合う |
| server/activity.ts:393-394 Stop は会話の記録だけ | 合う | 合う |
| server/activity-start.ts:10 `ACTIVITY_POLL_MS = 2000` | 合う（:40 で startPolling） | 合う |
| server/index.ts:114 agents 取得ごとの refresh | 合う | 合う |
| events-20261031.jsonl に Stop 489 行 | Mac の実物なので見られない | 未確認 |
| server/hub.ts:577-581 で claudeSessionId を控える | :578-582（件の窓は :581 で除外し、:596-615 `attachCaseSessionIds` で付ける） | ずれ＋説明不足（§2 の 7 を参照） |
| server/ws.ts:36 端末入力 | 合う | 合う |
| server/hub.ts:526-533 チャット送信 | 合う（Enter は :533） | 合う。ただし経路の説明が足りない（§3 の 2・3） |
| server/hub.ts:548-566 `submitText` | :548-567 | 1 行ずれ |
| server/hub.ts:614-617 `markRead` | :617-620 | 3 行ずれ |
| docs/handoff/stage2/design.md:14・:32 | 合う | 合う |
| src/pages/ConsolePage.test.tsx:343 | 合う（試験は :339-344） | 合う |
| `loadFileHistory` は Stop を通さない | server/activity.ts:301 で PostToolUse の書き込み系だけを通す | 合う |
| 起動時に今日・昨日を読み直す | server/activity.ts:269-278。カーソルは最初 0 から（:311） | 合う |

## 2. 原因1・原因2で現象をすべて説明できているか → できていない

原因1（src/pages/ConsolePage.tsx:219-223・:230-233）と原因2（10 秒ごとの観測。server/hub.ts:570-590）は、コード上どちらも本当にある。ただし次の点が抜けている。

1. **【重大】ターンの途中の「選択肢・許可待ち」では Stop が来ない。** Stop hook は返事（ターン）が終わったときだけ動く。許可の確認や AskUserQuestion の選択肢は、ターンの途中で waiting になる。記録用 hook は AskUserQuestion を記録しない（PreToolUse の matcher は `Agent|SubagentHandback` だけ。server/activity-hooks.ts:54）。今これを拾っているのは busy→waiting の観測（server/notify.ts:10）だけである。§4-1 の最後で「`observe()` は未読を増やさない」とすると、**長く考えたあとの許可待ち・選択肢待ちで、今は付いている未読まで付かなくなる。**
   PO の観測「今も選択肢を出していたが未読はついていなかった」が、どちらの「選択肢」なのかは未確認である。(a) 返事の本文に選択肢を書いてターンを終えた場合は Stop が来る。(b) 許可・AskUserQuestion の画面の場合は Stop が来ない。PO の願いは「返答待ちのときも」なので、両方とも未読を付ける設計にする必要がある。
2. **窓と会話番号が結べない間の Stop は捨てられる（§4-1「何もしない」）。**
   - 件でない窓: `claudeSessionId` が付くのは agents の取得のときだけ（server/hub.ts:579-581。10 秒ごと）。新しく開いた窓の最初の返事や、会話番号が変わった直後（`/clear` など。Claude 側で番号が変わることは未確認）の返事が、次の取得より前に終わると、結べずに捨てられる。原因2と同じ「短い返事で付かない」が、形を変えて残る。
   - 件の窓: 番号は `attachCaseSessionIds`（server/hub.ts:596-615）が case-home の sessions/<pid>.json から付ける。ほかの窓や agents の一覧が同じ番号を持っていると外される（:606-608）。
3. **件の窓では Stop の記録そのものが届かない道がある。** 件の窓の hook はファイルに書かず、POST /api/agent/case-activity へ送る（server/case-sandbox.ts:450、hooks/activity-hook.mjs:281-288）。サーバーは次の場合に記録を捨てる。
   - 送り元の pid から件が引けないとき → 401（server/http.ts:439-440。lsof と親プロセスのたどり :397-413 に頼っている）
   - 件で最初に受けた session_id と違う番号のとき → 409（server/http.ts:416-426・:446。番号は最初の 1 つに固定される）
   - POST が 2 秒で時間切れのとき（hooks/activity-hook.mjs:13・:256）
   件の窓 case-home がこのどれかに当たっているかは未確認（Mac の D/cases/<id>/session-id と、サーバーのログで確かめられる）。設計の §6 は「hook が入っていない環境」しか挙げていない。
4. **記録ファイルが縮んだら先頭から読み直す**（server/activity.ts:312-313）。このとき起動後の Stop が 2 度 `apply` され、未読が 2 度足される。会話の記録は `chatKey` で重複を除くが（:403-405）、本文が空の Stop（hooks/activity-hook.mjs:176-177）はそこを通らない。
5. **日付の切り替わり**: 読むのは昨日と今日の UTC ファイル（server/activity.ts:271）で、hook も UTC の日付で書く（hooks/activity-hook.mjs:188-190）。日付をまたぐ前後で読み漏れる道は見つからなかった。問題なし。
6. **StopFailure**（API エラーでターンが終わる。server/activity.ts:396-397）の扱いが決まっていない。PO が気づくべき終わり方なので、足すか足さないかを設計に書く。

## 3. §4 の変更で K1〜K10 を満たせるか

1. **Stop の ts と起動時刻の比べ方（K8）**: ts は hook の中の `Date.now()`（hooks/activity-hook.mjs:134・:139）。同じ Mac の時計なので、比べること自体はできる。ただ「起動時刻」がどの時刻か書かれていない。`ActivityStore` に注入できる `now`（server/activity.ts:243-250）から、生成時に `startedAt` を取ること、`ts < startedAt` を除外することを明記する。こうすれば単体試験で時刻を固定できる。あわせて、§2 の 4 の二重計上を防ぐ（session_id と ts の組で 1 回だけ足す）ことも書く。
2. **stop_hook_active（K7）**: 件でない窓には、同期の board-guard の Stop hook がある（server/activity-hooks.ts:70-71）。止められた 1 回目の Stop（false）も、非同期の記録用 hook が書く。このため設計どおりだと、**Claude がまだ続きの作業をしている時点で未読が付き**、本当の終わり（true）では足さない。回数は 1 回で K7 は満たすが、印が付く時点が早いことを §6 に書く。件の窓は board-guard を外している（server/case-sandbox.ts:450 `skip: [BOARD_GUARD_HOOK_FILE]`）ので、true は来ない。
3. **ws 入力の `\r` 判定（K4）**:
   - 端末の入力は xterm の `onData` をそのまま送っている（src/components/TerminalPane/TerminalPane.tsx:291-293）。フォーカスの通知（`\x1b[I`・`\x1b[O`）、矢印、マウスの報告（SGR は `\x1b[<b;x;yM`、X10 は 32 以上の文字）、xterm の自動の応答（`\x1b[…R` など）には 0x0d が入らない。
   - 0x0d が入るのは次のとき。
     - 貼り付け: `paste()` が改行を `\r` に直す（TerminalPane.tsx:32-33・:97・:104）。「挿入だけ」のよく使う指示（`pasteOnly`）で複数行を入れた場合も含む。
     - Alt+Enter: xterm.js は ESC と `\r` を送る（xterm.js の既定の動き。この製品で Option をメタとして扱う設定かは未確認）。
     §6 は「貼り付け」を許すと書いているので、送っていないのに消える上の場合も含めて受け入れる旨を明記する。
   - ws.ts の `attachTerminal`（server/ws.ts:22）は hub を持っていない。hub は deps にだけある（:53）。消す合図をどう渡すかを書く。
4. **チャット送信の道（K5）**:
   - チャット欄は予約に積む（src/components/ChatPane/ChatPane.tsx:118 → server/chat-routes.ts:71 → server/hub.ts:402）。端末へは手が空いたときに `flushChatQueueOnce` があとで自動に書く（server/hub.ts:495-542）。:533 で消すと次の順になる。PO が作業中に送る → 返事が終わって Stop で未読 +1 → すぐに予約が書かれ :533 で 0。**PO が返事を見る前に消える。** 消すのは「PO が送った時点」、つまり `enqueueChat`（server/hub.ts:402）にするべきである。
   - よく使う指示・差分のコメント・選んだ物の送信は、`pasteSubmitAfter`（TerminalPane.tsx:101-110）が `term.input("\r")` を `onData` に流し、ws（server/ws.ts:36）を通る。つまり消す道 1 に含まれる。挙動としては正しいが、§2 と K4/K5 に書かれていないので明記する。
5. **定期実行で消さない（K6）**: `submitText` を呼ぶのは定期実行（server/launch.ts:114）だけではない。引き継ぎ（server/relay.ts:232・:272）も呼ぶ。名前の変更の `/rename …\r` も ws を通らずに書く（server/hub.ts:300・:369・:386）。いずれも消さない対象として列挙する。設計どおり ws と予約の受付だけで消すなら、自然に消さないことになる。
6. **markRead API のほかの呼び出し元**（`git grep` で確認）: 製品の中では src/pages/ConsolePage.tsx:222・:232 だけ（src/api.ts:55 → server/http.ts:327-328 → server/hub.ts:618-620）。extension/ には未読も既読も出てこない（background.js・picker.js だけ）。試験は tests/unit/daily-use.integration.test.ts:127（無い窓への POST が 404 になること）と tests/unit/notify.test.ts:53-60。設計の「無ければ」は「無い」で確定するので、API を残すか消すかを決めて書く。
7. **K1 の 5 秒**: hook が書く → 2 秒ごとの `refresh` → `apply` で `onTurnEnd` → `readNew` の listener（server/activity.ts:280-283）→ hub の `publish`（server/hub.ts:218-222）。`onTurnEnd` は `apply` の中で同期に呼ばれ、listener より先に走るので、同じ配信に載る。5 秒は満たせる見込み（実測は未確認）。
8. **K2・K3**: ConsolePage の 2 か所を削れば満たせる。
9. **K9**: `observe()` が true/false を返す働きと、通知を送る処理（server/hub.ts:584-587）を残せば満たせる。ただし既存の e2e は未読と通知を 1 本の試験で確かめているので、書き換えが要る（§4 を参照）。

## 4. 実装で迷う点・触る範囲の漏れ

- **tests/e2e/console.spec.ts:612-650**「段階2 K1」が対象から漏れている。busy→idle で未読が付くこと（:624-625）と、行を選ぶと消えること（:648）を確かめ、:650 でほかの行を押して未読を消している。新しい定義では全部成り立たないので、通知の確認（K9）と分けて書き直す必要がある。
- tests/unit/notify.test.ts:42-60 は `observe` が未読を数えることを確かめている。`addUnread` に合わせて書き換える。
- `watchActivity` の型（server/hub.ts:215 `{ onChange; rev } & ChatSource`）に `onTurnEnd` を足すこと。偽の store を使っている hub の試験に影響する。
- src/locales/ja.json:165 `notifyHelp` は「区切り」の定義を説明する文で、画面に出ている（tests/e2e/console.spec.ts:632）。未読は区切りと別のものになるので、文を直すか、通知だけの説明だと分かるようにする。§3 の対象外「言葉」との関係も書く。
- README.md:295 の「行を選ぶと未読が消えます」を直すことを、行番号付きで書く。
- docs/handoff/stage2/design.md:14・:32 を直す（§8 には書いてあるが、§3 の対象の一覧に無い）。
- 版の数（今は package.json:3・extension/manifest.json:4 とも 0.48.1）と CHANGELOG の 1 行（戻し方を含む。docs/CHANGELOG.md:5 の形）を決める。
- K1 の単体試験は「Stop の記録を 1 行足して refresh」と書いているが、窓と会話番号を結ぶ手順（`claudeSessionId` を持つ窓を用意すること）も試験の前提に書く。

## 5. 判定: REVISE

直す点（12 件）:
1. ターンの途中の許可・選択肢待ち（Stop が来ない）でも未読が付くようにする。例: busy→waiting の観測で足す道を残し、そのターンの Stop では重ねて足さない。あるいは PO に「選択肢」がどちらだったか確かめたうえで、足す道を 2 本にする。今のままでは後退になる。
2. チャット欄の送信で消す場所を、server/hub.ts:533 から受付（`enqueueChat` server/hub.ts:402）に変える。
3. 会話番号と結べない Stop の扱いを決める（次の agents 取得まで保留する、など）。件でない窓の最初の返事・番号が変わった直後を K に入れる。
4. 件の窓で記録が届かない道（server/http.ts:440・:446 の 401/409、POST の時間切れ）を §2・§6 に書く。件の窓 case-home が当たっているかを実物で確かめる手順を書く（今は未確認）。
5. 起動時刻の定義（store の `now` から取る `startedAt`、`ts < startedAt` は除外）と、読み直しのときの二重計上の防止（session_id と ts で 1 回）を書く。K8 に二重計上の試験を足す。
6. board-guard の 1 回目の Stop で、作業がまだ続いている時点で未読が付くことを §6 に書く。
7. StopFailure を数えるかどうかを決める。
8. ws 入力の `\r` が「送っていないのに消える」場合（複数行の貼り付け・挿入だけの指示・Alt+Enter）を §6 に列挙して受け入れを明記する。ws.ts に hub をどう渡すかを書く。
9. 消す道として `pasteSubmitAfter` 経由（よく使う指示・差分のコメント・選んだ物）を、消さない道として `submitText` の引き継ぎ（server/relay.ts）と `/rename` を、§2 と K に明記する。
10. markRead API の呼び出し元は ConsolePage だけと確定した。残すか消すかと、試験 daily-use.integration.test.ts:127 の扱いを書く。
11. 触る範囲に tests/e2e/console.spec.ts:612-650、tests/unit/notify.test.ts:42-60、hub の試験の偽 store、src/locales/ja.json:165、版の数を足す。
12. §2 の行番号を origin/main に合わせる（ConsolePage.tsx 219-223・230-233・232・214-217、hub.ts 570-590・578-582・548-567・617-620）。events の 489 行は、Mac で数えた手順を書くか「未確認」とする。
