HEAD: bcb25ae981c69a2262a7d4d682093071217df736
判定: REVISE

# 設計審査 v3: 返事が来たら未読を付け、PO が送るまで消さない（第3版）

- 対象: docs/handoff/unread-on-reply/design.md 第3版（origin/release/unread-on-reply bcb25ae）
- 第2版の審査: origin/release/unread-on-reply-review-v2-report の docs/handoff/unread-on-reply/review-design-v2.md（8d3daee に対して REVISE・8 件）
- 照合したコード: origin/main de28ba7（bcb25ae と origin/main の差分は design.md 1 ファイルだけ。`git diff --stat origin/main HEAD` で確認）
- 審査役は製品コードを変更していない。見張りに止められたことは無い。
- この Mac の実物（`claude agents --json` が選択肢の画面・許可の画面・返事の終わりで返す status と waitingFor、installed の設定、記録ファイル）は見られないので「未確認」と書く。

## 1. 第2版の 8 件と推奨への対応（§11 の表と本文の照合）

| # | 第2版の指摘 | 第3版の本文 | 結果 |
|---|---|---|---|
| 1 | busy を観測しない待ちを漏らす | §4-1 R2（design.md の「R2 待ちに入った観測」）。消すとき `prevObs` を消す（§4-2）。K10 に idle→waiting と waiting→Enter→waiting | 直った。ただし R2 は status が "waiting" のときだけで、waitingFor を見ない（直す点 1） |
| 2 | Stop → 遅れた busy → idle で 2 | R3 は `hookSeen` が false の窓だけ。表の 4 行目、K11 | 直った（§2 で計算して 1） |
| 3 | 見張りで続けた返事が観測をまたぐと 2 | R1 の 1 で Stop(true) を受けず、R3 も使わない。表の 5 行目、K7 | 返事の終わりが idle なら直った。終わりが waiting だと 2（直す点 3）。PO が途中で Enter を押すと漏れる（直す点 2） |
| 4 | Enter が Stop の読み込みより先だと 1 が残る | R1 の 4（`lastClearAt` より後の ts だけ）。K15 | 直った |
| 5 | 保留の細目 | 時計を hub に注入、受けた時刻から 30 秒、結ぶときも R1 の 4、`forget`、同じ番号の窓 2 つは両方。K12 | ほぼ直った。agents の取得に失敗した回の扱いと、結ぶ／捨てるの順が無い（直す点 4） |
| 6 | 偽の store は無い | §3 を直した（tests/unit/helpers/harness.ts:268-269 は本物の `ActivityStore`。照合で一致） | 直った |
| 7 | StopFailure と Stop の両方で 2 | R1 の「受けたら」で `open = stop` なら足さない。表の 9 行目、K13 | 直った（両方来るかは未確認のまま、と書いてある） |
| 8 | チャットの消す場所 | 確かめ（server/hub.ts:403-407）の後、:409 の後で消す。K16 | 直った（:409 は `this.chatQueue.set`、:410 `bumpChat` が配信する。server/hub.ts:440-443） |
| 推奨 | 組の置き場・単体の場所 | 組は `SessionState`、単体は tests/unit/activity.test.ts | 直った。組の上限は書いていない（推奨 1） |

## 2. R1〜R5 と §4-1 の表の計算（観測 10 秒・記録の読み込み 2 秒・PO の Enter）

前提（コードの事実）: 観測は agents の取得ごと（server/hub.ts:175-181 `pollAgents` → :178 `detectBreaks`、同梱 agent-console.config.json:9 で 10000ms）。記録の読み込みは 2 秒ごと（server/activity-start.ts:10・:40）と agents の取得ごと（server/index.ts:114）。`claude agents --json` の status は busy/waiting/idle 以外を "unknown" にする（server/agents.ts:24・:41）。

表の 11 行を R1〜R5 と消し方（`unread=0`・`lastClearAt=now`・`open=none`・`prevObs` を消す）で順に計算した。全行が表の数になる。

| 表の行 | 計算 | 数 |
|---|---|---|
| 短い返事 Stop | R1 open none→+1, stop | 1 |
| busy → Stop → idle | R4 none / R1 +1 / R3 は hookSeen で無し | 1 |
| busy → waiting → Stop | R2 +1 obs / R1 open≠none で足さず stop | 1 |
| Stop → 遅れた busy → idle | R1 +1 / R4 none / R3 無し | 1 |
| Stop(false) → busy → Stop(true) → idle | R1 +1 / R4 none / R1 の 1 で拒否 / R3 無し | 1 |
| idle → waiting | R2 +1 | 1 |
| waiting → Enter → waiting | R2 +1 / 消す（prevObs なし）/ R2 +1 | 1→0→1 |
| busy → waiting → Enter → busy → Stop | R2 +1 / 消す / R4 / R1（ts>lastClearAt）+1 | 1→0→1 |
| StopFailure と Stop | R1 +1 / R1 open=stop で足さず | 1 |
| Stop(ts) → Enter → 読み込み | R1 の 4 で拒否 | 0 |
| hook の無い窓 busy → idle | R3 +1 | 1 |

不変条件: `open` が none でないのは +1 した後だけで、消すとき必ず none に戻す（§4-2、markRead も同じ）。よって「印が無いのに `open` が残って足されない」ことは起きない。数え漏れは「`unread` 0・`open` none の窓で、待ちに入ったのにどの R も成り立たない」順番だけを探せばよい。

### 数え漏れの順番（PO が見たい「待ちで印が付く」が漏れる）

- **順番1【中・未確認に依存】選択肢・質問の画面が status "waiting" でなく waitingFor 付きの idle／busy で返る場合。** R2 は `next === "waiting"` だけを見る（design.md §4-1 R2）。コードは idle なのに waitingFor がある組（server/agents.ts:86）と busy で waitingFor がある組（server/agents.ts:101、docs/CHANGELOG.md:49 の 0.19.0「確認待ち（waiting・waitingFor あり）」）を別に扱っており、これらが実機で起きるかは未確認（docs/handoff/chat/recon.md:218）。実測で waiting になったのは許可の確認（waitingFor "permission prompt"）だけ（docs/handoff/chat-busy-send/recon.md:36、docs/handoff/chat/recon.md:220）。選択肢の道具（PO の言う「選択肢」）の画面が何を返すかは未確認。
  - 例: Stop を受けたことのある窓（`hookSeen` true）。O(0) busy → Claude が 4 秒目に選択肢を出す → O(10) idle＋waitingFor。R2 無し（waiting でない）、R3 無し（hookSeen）、Stop は来ない（返事の途中）。**未読 0。** 今の製品は busy→idle の `isBreak`（server/notify.ts:9-11）で 1 付くので、第3版は**今より悪くなる**。busy＋waitingFor なら R4 が `open` を none にするだけで、やはり 0。
  - PO の願いの中心（選択肢を出していたが未読が付かない、design.md:7）に当たる。直す点 1。
- **順番2【小】見張りが止めた返事の続きの間に PO が Enter を押す。** 見張りは 1 回目の Stop(false) を止める（hooks/board-guard.mjs:96 の注釈「2 回目は必ず止めない」、:102 で `stop_hook_active` が true なら止めない）。R1 の Stop(false) で印が早く付く（§6 で受け入れ済み）ので、PO が印を見て返事を打つ順番は起こりやすい。
  - O(0) busy → Stop(false, ts=5) → R(6) +1 → PO が印を見て打ち Enter(8) で消す → Claude が続けて Stop(true, ts=15) → R1 の 1 で拒否 → O(20) idle、R3 無し（hookSeen）。**未読 0、Claude は待っている。**
  - PO の打った文が同じ回に取り込まれた後（docs/handoff/chat-busy-send/recon.md:34 の absorbed_mid_turn）の Stop の `stop_hook_active` が true のままかは未確認。取り込まれず次の回になれば Stop(false) が来て付く。直す点 2。
- 起動直後（R1 の 2）: 再起動の前に終わった返事は付かない。未読はメモリだけ（§3 の対象外）なので今と同じ。漏れとしては扱わない。

### 数えすぎの順番

- **順番3【小】見張りで続けた返事の終わりが waiting の場合。** Stop(false) +1 → busy で `open` none → Stop(true) 拒否 → O waiting、prevObs busy で R2 +1。**2。** §6 の waiting の段落は「Stop → 遅れた busy → waiting で 2」だけを書き、見張りの段落は「数は 1 のまま」と書いている（design.md §6 の 3 つ目の項目）。返事の終わりが waiting なら見張りの場合も 2。直す点 3。
- 答えた直後にまだ waiting と出る場合（§6 と K17(c) に書いてある）: 計算どおり 1 戻る。受け入れの書き方は妥当。
- 表に無いが正しく動く順番（参考）: 印が付いたまま PO が答えず、背景の知らせで Claude が 10 秒未満だけ動いて Stop → `open` が stop のままなので足さず 1 のまま。印は残るので願いには影響しない。数は「待ちの回数」より少ない。書くなら §6 に 1 行。

## 3. 保留（K12）・二重防止（K8・K15）・消し方（K4・K5・K16）は実装カードへ写せるか

- K8: `startedAt` は `ActivityStore` の作成時の注入 `now()`（server/activity.ts:243-250）。リスナー登録は作成直後（server/activity-start.ts:37-38）、最初の読み込みは :40。写せる。組を `SessionState` に持てば `dropOldSessions`（server/activity.ts:352-355）で会話ごと捨てられる。組の数の上限が無い（`chatKeys` は CHAT_KEEP で刈る。server/activity.ts:409-413）。keepDays 7 日 × 1 日 503 行程度なので実害は小さいが、上限か刈り方を 1 行書くと迷わない（推奨 1）。
- K15: R1 の 4 で写せる。`lastClearAt` を取るのは ws の `sessions.write`（server/ws.ts:36）の後と書いてある。Claude の Stop は入力を受けた後なので順は崩れないが、write の前に取る方が安全（推奨 3）。
- K12: 見直しの場所「`detectBreaks()` の最後」は番号付け（server/hub.ts:571・:581・:610）の後で正しい。ただし `detectBreaks` は agents の取得に失敗した回に :572 で早く戻るので、そこでは見直しも 30 秒の判定も走らない。30 秒を過ぎたものを「結べるか試してから捨てる」のか「先に捨てる」のかも書いていない（直す点 4）。
- K4: 端末の入力を `sessions.write` に流す製品の場所は server/ws.ts:36 だけ（`git grep "sessions.write("` で他は hub.ts:300・:369・:386・:529・:533・:559・:562 だけ。どれも PO の入力ではない）。事実どおり。`attachTerminal`（server/ws.ts:22）は hub を持たず deps（:53）にある。写せる。ただし ws の道で消したときに配信（`publish`）することが書いていない。今の `markRead` は変化があれば配信する（server/hub.ts:618-619）。enqueueChat の道は :410 の `bumpChat` が配信する（:440-443）。ws の道は次の agents の取得（最大 10 秒）まで画面の印が消えない（直す点 5）。hub に足す口の名前（例 `clearUnread(id)`）も書くと写しやすい。
- K5・K16: :403-407 の確かめ、:409 の後で消す。写せる。

## 4. §6 の未確認 3 つと K17

- (a) 返事の終わりの状態: 未確認と書き、waiting なら 2 になる場面を書いた。扱いは妥当。ただし見張りの場合も 2 になる（直す点 3）。
- (b) 数字キーだけで答えたとき: `\r` が無ければ消えず残る。「付かないより残る」を選んだのは PO の願いと合う。妥当。
- (c) 答えた直後の waiting: R2 で 1 戻る。K17 で見て PO に聞く。妥当。
- K17 に足りないもの: (d) 選択肢の画面・質問の画面のときの status と waitingFor（直す点 1。R2 がこれに依存する）、(e) 見張りの続きの間に PO が送ったとき、その後の Stop の `stop_hook_active`（直す点 2）。K17 は実装の後の実機確認なので、(d) は規則を waitingFor でも足す形にしておけば、どちらの結果でも漏れない。

## 5. 触る範囲・行番号

照合して合った行: server/notify.ts:9-11・:50-60・:51-53・:58・:71-74、server/hub.ts:129-134・:139-140・:192・:215・:300・:369・:386・:402・:403-407・:408・:409・:495-542・:533・:548-567・:570-590・:578-582・:582・:596-615・:606-608・:618-620、server/activity.ts:243-250・:269-278・:280-283・:301・:311・:312-313・:352・:393-397・:403-405、server/activity-hooks.ts:54・:60・:70-71、server/activity-start.ts:10、server/index.ts:114、server/ws.ts:22・:36・:53、server/http.ts:327-328・:416-426・:436-450、server/launch.ts:114、server/relay.ts:232・:272、server/chat-routes.ts:71、src/pages/ConsolePage.tsx:214-217・:219-223・:230-233・:232、src/components/TerminalPane/TerminalPane.tsx:101-110・:108・:291-293、src/api.ts:55、src/locales/ja.json:165、README.md:295、docs/handoff/stage2/design.md:14、package.json:3・extension/manifest.json:4（0.48.1）、tests/unit/notify.test.ts:42-60、src/pages/ConsolePage.test.tsx:339-344、tests/e2e/console.spec.ts:612-650、tests/unit/helpers/harness.ts:268-269、agent-console.config.json:9。

ずれ・漏れ:
- `SessionState` は server/activity.ts:133-153（design.md §2 は :133-150）。推奨 2。
- 直す点 1 を入れるなら、`BreakTracker.observe()` に waitingFor を渡す形に変わる。呼び出し元は server/hub.ts:584 の 1 か所（`agent?.status` を渡している）。§3 の hub.ts の行にこれを足す。
- 直す点 1 の試験: e2e の偽 claude は waitingFor を返さない（docs/handoff/chat/recon.md:183）。単体（notify.test.ts）で waitingFor 付きの idle／busy を試す。

## 6. 判定: REVISE

直す点（5 件）:
1. 【中】R2 が status "waiting" だけを見るので、選択肢・質問の画面が waitingFor 付きの idle／busy で返ると、Stop を受けたことのある窓では印が付かず、今の製品（busy→idle で付く）より悪くなる（§2 の順番1。server/agents.ts:86・:101、docs/handoff/chat/recon.md:218 で未確認）。R2 の「待ち」を `status === "waiting" || waitingFor !== undefined` にし、`prevObs` も同じ「待ち」かで持つ。`observe()` に waitingFor を渡す（server/hub.ts:584）。K10 に「busy → idle＋waitingFor」「busy → busy＋waitingFor」の単体を足す。K17 に (d) 選択肢の画面の status と waitingFor を足す。
2. 【小】見張りの続きの間に PO が Enter で消すと、続きの終わりの Stop(true) は R1 の 1 で拒否され、R3 も使わないので、Claude が待っていても印が付かない（§2 の順番2）。例: 「`stop_hook_active` が true の Stop も、その窓の `lastClearAt` がその会話で最後に受けた Stop の ts より後なら受ける」。表と K7 にこの順番を足すか、起こり得ると §6 に書いて受け入れる。K17 に (e) を足す。
3. 【小】§6 の見張りの段落「数は 1 のまま」は返事の終わりが idle の場合だけ。終わりが waiting なら Stop(false) → busy → Stop(true) → waiting で 2（§2 の順番3）。§6 の waiting の段落に並べて書く。
4. 【小】保留: agents の取得に失敗した回は `detectBreaks` が server/hub.ts:572 で早く戻るので、見直しも 30 秒の判定も走らない。その扱い（早く戻る前に 30 秒の判定だけ走らせるか、次の成功まで持つか）と、30 秒を過ぎたものは「結べるか試してから捨てる」のか「先に捨てる」のかを書き、K12 の試験に足す。
5. 【小】ws の道（server/ws.ts:36）で消したときに配信する（`publish`）ことを書く。今の `markRead` は変化があれば配信する（server/hub.ts:618-619）。書かないと画面の印が次の agents の取得（最大 10 秒）まで残る。K4 に「消した後に配信される」を足す。hub に足す消す口の名前も書く。

推奨（直さなくても実装できる）:
1. （会話番号, ts）の組の上限か刈り方を書く（`chatKeys` は server/activity.ts:409-413 で刈っている）。
2. §2 の `SessionState` の行を server/activity.ts:133-153 に直す。
3. `lastClearAt` は ws の `sessions.write` の前に取る。

第2版の 8 件はすべて対応され、表の 11 行は決まりどおり計算するとその数になる。残る直す点 1 は PO の言う「選択肢」の場面に当たり、今より悪くなる可能性があるので、直してから実装に進むのがよい。
