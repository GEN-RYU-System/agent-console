HEAD: 062eda95cbca693854955127a6162beb9a21a855
判定: APPROVE（第3版の直す点 5 件・推奨 3 件は本文まで直っている。§4-1 の表 14 行と K1〜K17 を R1〜R5 で計算すると全部その数になり、新しい規則で数が壊れる場面は §6 に書けば足りる小さなものだけ。残る直す点 2 件は「形」の書き方の食い違いで数は変わらない。実装カードに正しい形で写すことを条件に、設計の再審査は要らない）

# 設計審査 v4: 返事が来たら未読を付け、PO が送るまで消さない（第4版）

- 対象: docs/handoff/unread-on-reply/design.md 第4版（origin/release/unread-on-reply 062eda9）
- 第3版の審査: origin/release/unread-on-reply-review-v3-report の docs/handoff/unread-on-reply/review-design-v3.md（bcb25ae に対して REVISE・直す点 5 件・推奨 3 件）
- 照合したコード: origin/main de28ba7（`git diff --stat origin/main origin/release/unread-on-reply` は design.md 1 ファイルだけ）
- 審査役は製品コードも設計文書も変えていない。見張りに止められたことは無い。
- この Mac の実物（`claude agents --json` が選択肢の画面で返す status と waitingFor、installed の agentsPollMs、記録ファイル）は見られないので「未確認」と書く。
- 以下、【事実】はコードか文書で確かめたこと、【推測】は確かめていない見立て、【未確認】は実機でしか分からないこと。

## 1. 第3版の直す点・推奨への対応（§12 の表と本文の照合）

| # | 第3版の指摘 | 第4版の本文 | 結果 |
|---|---|---|---|
| 1 | R2 が status "waiting" だけ | design.md:63 観測の種類「待ち」= status "waiting" か waitingFor あり。R2（:73）・R4（:75 は「busy（waitingFor なし）」）・R5（:76）がこの種類で判定。:105 で hub.ts:584 から `agent?.waitingFor` を渡す。§2 :33 に server/agents.ts:47・:86・:101。表 :92・:93、K10 :159、K17(d) :166 | 直った |
| 2 | 見張りの続きの間に Enter で漏れる | :67 R1 の 1 に「true でも `lastClearAt` > `lastTurnEndTs` なら受ける」、:62 `lastTurnEndTs`、:71 受けなくても更新、:103 `stopHookActive` を事件に載せる。表 :94、K7 :156、K17(e) | 本文は直った。ただし :104 の `addTurnEnd(windowId, ts)` に `stopHookActive` が無い（直す点 1） |
| 3 | §6「数は 1 のまま」は idle のときだけ | :137 に終わりが「待ち」なら 2 と明記 | 直った |
| 4 | 取得失敗の回と、結ぶ／捨てるの順 | :98 順は「結ぶ → 30 秒超を捨てる」、:99 失敗の回は :572 で戻る前に捨てるだけ。K12 :161 に 31 秒目の結び・失敗が続く場合 | 直った。保留に入れる条件の書き方が :67・:103 と食い違う（直す点 2） |
| 5 | ws の道が配信しない | :110 `clearUnread(windowId)` が数が 0 でなければ publish、`markRead` も同じ口。K4 :153 に publish 1 回／0→0 で 0 回 | 直った |
| 推1 | 組の上限 | :69 会話ごとに 500 個、古い順に捨てる | 直った（根拠は【推測】。§5 補足 4） |
| 推2 | SessionState の行 | :35 server/activity.ts:133-153 | 直った（照合で一致） |
| 推3 | `lastClearAt` を write より前 | :111 `onSubmit` を `sessions.write` の前、K4 に順の確かめ | 直った |

## 2. R1〜R5 の机上計算

前提【事実】: 観測は agents の取得ごと（server/hub.ts:570-590、agent-console.config.json:9 で 10000ms）。取得失敗の回は server/hub.ts:572 で戻り observe を呼ばない。Claude が見つからない窓は `agent?.status ?? null` で null（server/hub.ts:584）。記録の読み込みは 2 秒ごと（server/activity-start.ts:10・:40）と agents 取得ごと（server/index.ts:114）。見張りは会話ごとに 1 回だけ止める（hooks/board-guard.mjs:96「2 回目は必ず止めない」、:102 `stop_hook_active` が true なら止めない）。

規則を次のように読んだ（design.md:56-76・:109）:
- 種類 k = W（status "waiting" か waitingFor あり）／busy／idle／unknown。null は種類なし。
- observe: R2 k=W かつ prevObs≠W → open=none なら +1・open=obs。R3 prevObs=busy かつ k=idle かつ !hookSeen → open=none なら +1・open=obs。R4 k=busy → open=none。R5 prevObs=k（null なら消す）。
- 記録: 受ける = (!sha ∨ lastClearAt > lastTurnEndTs) ∧ ts > lastClearAt。その後 lastTurnEndTs = max(…, ts)。受けたら hookSeen=true、open=none なら +1、open=stop。
- 消す: unread=0、lastClearAt=now、open=none、prevObs を消す。

### 2-1. §4-1 の表 14 行（design.md:79-94）

| 行 | 計算 | 数 | 表 |
|---|---|---|---|
| :81 Stop | 受け +1 | 1 | 1 ✓ |
| :82 busy → Stop → idle | R4 / 受け +1 / R3 は hookSeen で無し | 1 | 1 ✓ |
| :83 busy → waiting → Stop | R4 / R2 +1 obs / 受け・open≠none で足さず | 1 | 1 ✓ |
| :84 Stop → busy → idle | +1 / R4 none / R3 無し | 1 | 1 ✓ |
| :85 Stop(false,5) → busy → Stop(true,15) → idle | +1・lTE=5 / R4 / 0>5 偽で拒否・lTE=15 / R3 無し | 1 | 1 ✓ |
| :86 idle → waiting | R2 +1 | 1 | 1 ✓ |
| :87 waiting → Enter → waiting | +1 / 0・prevObs 消 / R2 +1 | 1→0→1 | ✓ |
| :88 busy → waiting → Enter → busy → Stop | +1 / 0 / R4 / ts>lC で +1 | 1→0→1 | ✓ |
| :89 StopFailure と Stop | +1 stop / open=stop で足さず | 1 | 1 ✓ |
| :90 Stop(100) → Enter(150) → 読み込み | 100>150 偽で拒否 | 0 | 0 ✓ |
| :91 hook 無し busy → idle | R3 +1 | 1 | 1 ✓ |
| :92 busy → idle＋wf（hookSeen） | R4 / k=W、R2 +1 | 1 | 1 ✓ |
| :93 busy → busy＋wf | k=W、R2 +1（R4 は wf 無しだけ） | 1 | 1 ✓ |
| :94 busy → Stop(false,5) → Enter(8) → Stop(true,15) → idle | +1・lTE=5 / 0・lC=8 / 8>5 で受け・15>8 で +1・lTE=15 / R3 無し | 1→0→1 | ✓ |

全行が表の数になる【事実：規則どおりの計算】。

### 2-2. K1〜K17 の試験の手順

- K7（:156）: 「Enter が無ければ Stop(true) は受けない」= :85 の行。✓
- K8（:157）: `startedAt` は `ActivityStore` の注入 `now()`（server/activity.ts:243-250）。最初の `readNew` は今日・昨日を `readFile` で 0 から読む（:269-278・:311）ので、そこを通る Stop は R1 の 2 で落ちる。縮みの読み直し（:312-313）は R1 の 3 で落ちる。✓
- K10（:159）: busy→waiting 1、idle→waiting 1、waiting→Enter→waiting 1→0→1、busy→idle＋wf 1、busy→busy＋wf 1。✓
- K11（:160）: Stop→idle 1、busy→waiting→Stop 1、Stop→busy→idle 1、Stop→waiting 1（Stop で open=stop、R2 は open≠none で足さず）。✓
- K12（:161）: 番号の無い窓で Stop → 0 → 番号を付けて detectBreaks → 1。31 秒目に番号が付いた窓 → 結ぶが先なので 1。取得失敗が続いても 31 秒後の回で捨てる（:99）。結ぶ前に Enter で消していたら ts ≤ lC で 0。✓（保留に入れる条件は直す点 2）
- K13（:162）: StopFailure → 1、StopFailure → Stop → 1。✓
- K15（:164）: ts 100・lC 150 → 0。✓
- 既存の単体 tests/unit/notify.test.ts:42-51・:61-67・:68-75 も新しい規則で同じ数になる（idle,busy,idle,idle,busy,waiting → R3 +1・R4・R2 +1 で 2。busy,null,idle → prevObs 消で R3 無し 0）。【事実：計算】

### 2-3. 新しく入れた規則が別の場面で数を壊さないか

二重に数える・漏れる順番を探した。表を壊すものは無い。次の 4 つは表に無い場面で、§6 に 1 行ずつ足せば足りる（推奨）。

- 順番A【小・新しい規則による】R1 の 1 の例外で、PO の送信が「同じ回に取り込まれず次の回になる」場合。Stop(false,5) +1 → Enter(8) で 0 → Stop(true,15) は例外で受けて +1 → Claude は PO の文で次の回を始める → 観測 busy（open=none）→ Stop(false,25) +1 → **2**（busy を観測しなければ 1）。印は Stop(true) の時点で付き、Claude が PO の文を処理している間も残る（早く付く）。第3版ではこの場合 1 で漏れも無かったので、例外を入れたことで「取り込まれない場合」は 1 つ多くなる。同じことは見張りが無くても、PO が作業中に打って Enter した（先打ち）場合に起きる（Enter(8) → 今の回の Stop(false,15) が 15>8 で +1 → 次の回の Stop で +1）。これは第3版からある性質。どちらも印は付くので願いには影響しない。取り込まれるかは【未確認】（docs/handoff/chat-busy-send/recon.md:34 の absorbed_mid_turn）。K17(e) で「送った文が同じ回に入ったか」も記録すると判断できる。見張りは会話ごとに 1 回だけ（hooks/board-guard.mjs:96）なので、例外が効く場面自体が少ない【事実】。
- 順番B【小・新しい種類 W による】busy＋waitingFor と busy（wf なし）が、PO の入力なしに交互に観測される場合。R4 が open を none に戻し、R2 が W に入るたびに +1 する。busy＋waitingFor が実機で何を意味するか（選択肢の画面か、背景の待ちか、古い値が残るだけか）は【未確認】（server/agents.ts:12 の注釈は「waiting のときだけ付く」、:47 は status に関係なく残す）。PO が答えなければ待ちは続くので交互にはならない、と見るのが自然だが【推測】。K17(d) で「busy＋wf が続く間の数」も記録する。
- 順番C【小・R2 の帰結】起動直後（または Claude が一度見つからず null になった後）の最初の観測が W なら、prevObs が無いので R2 で +1 する。今の製品は最初の観測を数えない（server/notify.ts:55-57、tests/unit/notify.test.ts:42 の名前）。R1 の 2 は「起動時に昔の記録で足さない」としているのに、観測では起動時に待っている窓へ付く。PO の願いには合う（実際に待っている）が、表と §6 に書かれていない。null → W は open が obs のまま残るので 2 にはならない【事実：計算】。
- 順番D【小・設定に依存】保留の 30 秒は agentsPollMs = 10000 を前提にしている（:143「agents の 3 回分」）。agentsPollMs は正の数なら何でも通る（server/config.ts:141・:301）。installed の値が 30000 以上なら、新しい窓の最初の返事は番号が付く前に捨てられ、hookSeen も false のままなので R3 頼み（短い返事は busy を観測しないので 0）になる【推測：installed の値は未確認】。30 秒を `max(30s, 3 × agentsPollMs)` にするか、§6 に前提として書く（推奨 2）。

## 3. 行番号（file:line）の照合

origin/main de28ba7 で次を開いて一致を確かめた【事実】:
server/notify.ts:9-11・:24・:50-60・:51-53・:58・:71-74、server/hub.ts:129-134・:139-140・:192・:215・:300・:369・:386・:402・:403-407・:408・:409・:410・:440-443・:495-542（:495 `flushChatQueueOnce`）・:533・:548-567・:570-590・:572・:578-582・:582・:584・:596-615・:606-608・:618-620、server/agents.ts:12・:47・:86・:101、server/activity.ts:133-153・:148・:243-250・:269-278・:280-283・:301・:311・:312-313・:352・:393-397・:403-405・:409-413、server/activity-hooks.ts:54・:60・:70-71、server/activity-start.ts:10、server/index.ts:114、server/ws.ts:22・:36・:53、server/http.ts:327-328・:416-426・:436-450（:439-440・:445・:446）、server/case-sandbox.ts:450、server/launch.ts:114、server/relay.ts:232・:272、server/chat-routes.ts:71、hooks/activity-hook.mjs:13・:134・:139・:173-177・:174・:253-260・:256・:281-288、src/pages/ConsolePage.tsx:214-217・:219-223・:222・:230-233・:232、src/components/TerminalPane/TerminalPane.tsx:32-33・:97・:101-110・:104・:291-293、src/components/ChatPane/ChatPane.tsx:118、src/api.ts:55、src/locales/ja.json:165、README.md:295、docs/handoff/stage2/design.md:14・:32、docs/CHANGELOG.md:5、package.json:3・extension/manifest.json:4・package-lock.json（0.48.1）、tests/unit/notify.test.ts:42-60、tests/unit/daily-use.integration.test.ts:127、tests/unit/helpers/harness.ts:268-269、src/pages/ConsolePage.test.tsx:339-344、tests/e2e/console.spec.ts:612-650、docs/handoff/chat/recon.md:218・:220、agent-console.config.json:9。

ずれは見つからなかった。

補足【事実】: `attachTerminal` の呼び出しは server/ws.ts:102（`attachTerminal(deps.sessions, session, ws)`）。§4-2 の「`attachWebSockets` が deps の hub から `onSubmit` を作って渡す」はこの行の引数を足す変更になる。§3 の ws.ts の行に :102 を書くと写しやすい（推奨 3）。

## 4. 受入条件の粒度と実装範囲

- K1〜K16 はどれも「入力の列 → unread の数（と publish の回数・呼ぶ順）」で書かれており、tests/unit/notify.test.ts（BreakTracker）・tests/unit/activity.test.ts（`onTurnEnd`）・hub の結合（harness は本物の `ActivityStore`。tests/unit/helpers/harness.ts:268-269）・ConsolePage.test.tsx にそのまま写せる【事実】。時計の注入（hub の options :64、`ActivityStore` は既にある server/activity.ts:247）で K12 の 31 秒も単体にできる。
- K17 は実機の記録で、合否でなく事実を取ると明記（:166）。妥当。
- §3（:40-50）は直すファイル・行・版を列挙し、対象外（hook・http.ts・通知・保存・定期実行など）も明確【事実】。

## 5. 判定: APPROVE

### 直す点（数は変えない。実装カードに正しい形で写す。設計の再審査は要らない）
1. 【小】§4-1「形」design.md:104 の `BreakTracker.addTurnEnd(windowId, ts)` に `stopHookActive` が無い。R1 の 1 は `BreakTracker` で判定する（:67・:103）ので、`addTurnEnd(windowId, { ts, stopHookActive, failed }, now)` の形で渡す必要がある。このままだと K7・表 :94 の試験が書けない。
2. 【小】保留に入れる条件 design.md:96「R1 の 1〜3 を満たしたが」は、:103（`onTurnEnd` は 2・3 だけで呼び、1 は `BreakTracker` が見る）・:98（結ぶときに「1 の後半」を当てる）と食い違う。`stop_hook_active` が true の記録を保留の前に落とすと、新しい窓で「保留中に PO が送った → 続きの Stop(true)」が漏れる。正しくは「`onTurnEnd` で届いた記録（R1 の 2・3 を満たしたもの）を `stopHookActive` ごと保留し、結ぶときに ts の順に R1 の 1（前半・後半）・4・`lastTurnEndTs` の更新を当てる」。K12 に「保留中の Stop(false)・Stop(true) を一度に結ぶと 1、間に Enter があれば 0→1」を足すと固定できる。

### 推奨（直さなくても実装できる）
1. §6 に §2-3 の順番A〜C を 1 行ずつ書く（A: 取り込まれない送信・先打ちで早く付き 2 になりうる、B: busy＋wf と busy の交互、C: 起動直後・null 後の最初の観測が待ちなら付く）。C は notify.test.ts に 1 件（最初の観測 waiting → unread 1・observe は false）を足すと意図が残る。
2. 保留の 30 秒を agentsPollMs に連動させるか、10000ms 前提と §6 に書く（§2-3 順番D）。
3. §3 の ws.ts の行に :102（`attachTerminal` の呼び出し）を足す。

### 補足
- 組の上限 500（:69）の根拠「1 会話で 500 を超える前に読み直しの範囲を外れる」は、1 会話の Stop が 1 日 250 未満という見立て【推測】（全会話で 1 日 503 行・12 会話。design.md:21）。超えても、古い組を捨てた後にファイルが縮んで読み直された場合だけ 2 度目が起きるので、実害は小さい。
- 両方の窓に R1 を当てる（:101）・`forget` で状態を捨てる（:100、server/hub.ts:139-140）は、第3版の審査どおり写せる。
- 【未確認】のまま残るもの: 返事の終わりの status、選択肢の画面の status と waitingFor、数字キーだけの答えで `\r` が出るか、PO の送信が同じ回に取り込まれるか、installed の agentsPollMs。いずれも K17 で記録する設計になっており、結果で数が変わっても「印が付かない」方向には倒れない（順番D を除く）。
