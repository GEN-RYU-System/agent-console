# 未読の印は「PO の番で止まっている窓」だけに付ける 設計

状態: 設計案 第4版（Opus 作成・2026-11-01）。第1版〜第3版の設計審査はどれも REVISE（対応は §11・§12・§13）。

## 1. 目的（PO に見える変化）
- PO の願い（2026-11-01 原文）:「未読が出すぎて見づらいので調整して、人間の返答街で停まっているものだけ未読を表示するようにしてくれ」
- PO の選択（同日）: 選択肢「1」（AI が返事を書き終えて PO を待つ窓すべてに付ける）。追加の原文:「3も、とにかくボールが人間で停まっているものを見分けるバッジとして使いたい」（3 = 失敗で止まった窓）
- 変化:
  1. 印が付くのは、いま PO の番で止まっている窓だけ。次の 3 つ。
     - AI が返事を書き終え、自分で続きを始める予定（裏で動かしている作業・一度きりの時刻を決めた再開）が無い。
     - 許可の確認・選択肢の画面で止まっている。
     - 失敗（API のエラー）で止まった。
  2. AI が自分で続きを始めた（裏の作業の終わりの知らせ・担当の報告の戻りなどが届いた）ら、PO が送らなくても印は消える。失敗の印だけは PO が送るまで消えない。
  3. 予定があって付けなかった窓でも、30 分たって何も起きなければ印を付ける（付け漏れの予備）。
  4. 印は「付いている／いない」の 1 つ。行の言葉は「未読」だけにし、数を出さない。
  5. ブラウザのタブの題の「(N)」は、印の付いた窓の数になる（今は返事の回数の合計）。題の作りは変えない。
- 変えないこと: PO が送ると消える（v0.49.0 と同じ）。行を選ぶ・窓を開くだけでは消えない。macOS の通知。

## 2. 現在地（事実。agent-console origin/main ff59975 = v0.49.0）
- 印の足し方: server/notify.ts `BreakTracker`。`addTurnEnd`（R1・:119-129）は Stop・StopFailure を受けると `if (w.open === "none") w.unread += 1`。`stop_hook_active` が true の Stop は、前の Stop の後に PO の送信で消したときだけ受ける（:123）。`observe` の R2（待ちに入った・:98-102）・R3（hook の無い窓の予備・:104-107）も `unread += 1`。R4（busy の観測・:109）は `w.open = "none"` にするだけで `unread` を減らさない。消すのは `clear`（PO の送信・:136-147）だけ。
- よって、AI が自分で再開しても印は残り、次の Stop でさらに 1 足される。
- 受ける条件（v0.49.0 R1 の 2〜4）: 起動前の記録は捨てる・同じ（会話番号, ts）は 1 回だけ（server/activity.ts:278 `ts < this.startedAt || state.turnEndTs.has(ts)`）、`ts > lastClearAt`（notify.ts:124）。
- 表示: src/components/SessionList/SessionList.tsx:109 `data-unread`・:135-138 の印、言葉は src/locales/ja.json:180 `"unread": "未読 {{count}} 件"`（言葉のファイルは ja.json だけ）。src/pages/ConsolePage.tsx:213-216 はタブの題に合計 `(${totalUnread})` を出す。
- Stop の記録: hooks/activity-hook.mjs:173-177 は `stop_hook_active` と `last_assistant_message` だけを残す。UserPromptSubmit は本文を全文残し、担当の報告の戻りにだけ `source: "agent"` を付ける（:167-171、`AGENT_MESSAGE_PREFIX` :24）。server/activity.ts:427-434 が Stop / StopFailure で `emitTurnEnd`（:277-285）を呼び、server/hub.ts:245 が `tracker.addTurnEnd` に渡す。
- Claude Code の公式資料（https://code.claude.com/docs/en/hooks の「Stop input」。Context7 `/websites/code_claude` と審査役の取得で 2026-11-01 確認）:
  - Stop の入力に `background_tasks`（id・type・status・description・command など。type は shell・subagent・monitor・workflow・teammate・cloud session・MCP task）と `session_crons`（id・schedule・recurring・prompt。CronCreate・ScheduleWakeup・/loop から来る）がある。
  - 原文:「Both arrays are present when the task registry is reachable and are empty when nothing is in flight or scheduled」。欄が無いことがある。
  - StopFailure の入力には 2 つの欄が無い。
- この Mac の Claude Code は 2.1.316（`claude --version`）。この版で 2 つの欄が本当に入るかは【未確認】（今の hook は残さない）。→ §5 段0。
- 観測の間隔: 同梱の設定の agentsPollMs は 10000。この Mac に入っている値は【未確認】。
- 実物の記録（この Mac の activity の events-20261025〜20261101.jsonl・29,609 件。数えの台本は §9 の場所に置く。生出力: scratchpad/unread/count_v2.txt）。Stop（stop_hook_active が false）と StopFailure を、同じ会話で次に来た UserPromptSubmit で分けた。次の入力が `<agent-message`・`<task-notification`・`<cross-session-message`・`# Autonomous loop` で始まれば「AI が自分で再開」、それ以外は「PO の番」:

| 止まり | 次が AI の再開 | 次が PO | 次の入力なし |
|---|---|---|---|
| Stop | 2,245 | 1,433 | 142 |
| StopFailure | 4 | 6 | 1 |

- stop_hook_active が true の Stop は 219 件（数えから除いた）。
- 次の入力までの時間: Stop の後に AI が再開した 2,245 件は中央値 193 秒・上位 1 割 941 秒。PO が送った 1,433 件は中央値 297 秒。
- つまり今の数え方では、印の約 6 割（2,245 / 3,678）が PO の番ではない止まりに付いていた。v0.49.0 は同じ窓の Stop ごとに 1 足す（間に busy の観測が入って `open` が戻ったときだけ +1。入らなければ足さない）。
- 数えの限界: ScheduleWakeup で自分で決めた文で再開した回は「PO」に数えている（文の形で見分けられない）。PO の数は多めに出ている。`<cross-session-message` が上の 2,245 件のうち何件かは【未確認】（台本が分けて数えていない）。
- 第1版の表との差（1,437 と 1,459・2,214）は、第1版で台本を 2 本使い、片方が貼り付けの扱い・StopFailure の扱いが違ったため。第2版は 1 本の台本で数え直した。

## 3. 対象と対象外
- 対象:
  - hooks/activity-hook.mjs: Stop の 1 件に次を足す。欄が無い・配列でないときは何も足さない。説明文・コマンド・prompt の文字は残さない。足す場所は `withFullText`（:65-78）に渡す前の `base`（後から足すと 1 行の上限 64KiB を超えるおそれがあるため）。
    - `bg_tasks`（`background_tasks` の件数）と `bg_types`（type ごとの件数。shell・subagent・monitor・workflow・teammate・cloud session・MCP task 以外は `other`）。
    - `crons_once`（`session_crons` で recurring が false の件数）・`crons_repeat`（true の件数）。
    - `cron_prompt_hashes`（§4-6 の `promptKey` を recurring が false の prompt に当てたもの。最大 10 個）。
  - server/activity.ts:
    - `TurnEndEvent` に `pendingSelfResume: boolean | null` を足す（null = 欄が無かった）。true は `bg_tasks ≥ 1` か `crons_once ≥ 1`。StopFailure は null。
    - `SessionState` に `cronPromptKeys: string[]`（同じ会話の最後の Stop の `cron_prompt_hashes`。その Stop に欄が無ければ `[]` にする）と `resumeTs: Set<number>`（AI の再開の重なりを見る。`turnEndTs` とは別。上限は TURN_ENDS_KEEP と同じ）を足す。
    - `applyPrompt`（:506）の最初、:509 の早い return より前で、記録が §4-3 C2 の「AI の再開」なら `onSelfResume({ claudeSessionId, ts })` を出す。受ける条件は Stop と同じ（`ts < startedAt` は捨てる・`resumeTs` で同じ ts は 1 回）。その後の処理（右の欄・チャット）は今のまま。
    - `onSelfResume(listener)` の口を `onTurnEnd` と同じ形で足す。
  - server/hub.ts:
    - :245 で `pendingSelfResume` を渡す。
    - `onSelfResume` を窓に結ぶ。結べないときは返事の終わりと同じ保留（`pendingTurnEnds`）に種類を付けて入れる。`reviewPendingTurnEnds`（:251）は種類を問わず ts の順に結ぶ（今の並べ替えのまま）。
    - `detectBreaks`（:613）の最初、:615 の早い return より前で `tracker.sweepStale(this.now())` を呼ぶ（§4-2 S5）。
    - :627 の `this.tracker.observe(...)` に 4 つ目の引数として `this.now()` を渡す。
    - `watchActivity`（:224-226）の store の型に `onSelfResume` を足し、`store.onSelfResume((e) => this.onSelfResume(e))` を結ぶ。試験の偽の store（tests/unit の `watchActivity` に渡す物）にも `onSelfResume` を足す。
    - 画面に届く道は足さない。`sweepStale` の変化は、同じ回の pollAgents の最後の `publish`（:190）で届く。返事の終わりと AI の再開の変化は、活動の記録の `onChange`（:229-233）の `publish` で届く。
  - server/notify.ts: `BreakTracker` を §4 に変える。足す口は `addSelfResume(sessionId, ts)` と `sweepStale(now)`。変える口は次の 2 つ。
    - `observe(sessionId, status, waitingFor?, now?)`: `now` を省略できる 4 つ目の引数にする。省略したときは `Date.now()`。今の試験は呼び出しの形を変えずに通る。新しい試験は `now` を必ず渡す。
    - `TurnEnd` に `pendingSelfResume?: boolean | null` を省略できる欄として足す。省略（undefined）は null と同じ扱い（付ける）。tests/unit/notify.test.ts:77 の補助は変えずに通る。row1〜row14 の Stop は「欄なし（null）」として流れ、v0.49.0 と同じく付ける側になる。
  - src/locales/ja.json:180: `"未読"` にする（`{{count}}` を外す）。
  - src/components/SessionList/SessionList.tsx: 印の言葉の呼び出しから count を外す（見た目は変えない）。
  - 試験: tests/unit/notify.test.ts（§4-5 の表）、tests/unit/activity.test.ts、tests/unit/activity-hook.test.ts、tests/unit/daily-use.integration.test.ts（印の数の期待がある行）、src/components/SessionList/SessionList.test.tsx:123（`toContain("3")` を「未読」に）。
  - 数えの台本: scripts/measure-unread.mjs（新規。§9。node で記録を読むだけで、何も書かない）。
  - 文書: README.md:295（未読の説明と「窓のタイトルに未読数」→「印の付いた窓の数」）、docs/handoff/unread-on-reply/design.md の冒頭に「第2の決まりはこの設計で置き換えた」1 行、docs/CHANGELOG.md に 1 行（戻し方を含む）。
  - 版: 0.49.0 → 0.50.0（package.json・package-lock.json・extension/manifest.json）。
- 対象外: macOS の通知（`isBreak` のまま）、PO の送信で消す道（ws.ts・chat の enqueueChat）、件の窓の受け口（server/http.ts）、印の色・形、タブの題の作り（ConsolePage.tsx:213-216 は変えない）。

## 4. 変更（前 → 後）
### 4-1. 窓ごとに持つもの
- 前: `unread`・`lastClearAt`・`hookSeen`・`open`・`prevObs`・`lastTurnEndTs`。
- 後: 上に足す。
  - `unread` は 0 か 1 だけ（型は number のまま）。
  - `cause`: `"none" | "stop" | "failure" | "wait" | "obs" | "stale"`（いま付いている印の理由）。
  - `markTs`: いまの印を付けた時刻。初めは 0。値は理由ごとに次。
    - stop・failure: その Stop・StopFailure の記録の ts。
    - wait・obs・stale: hub の `now()`。
    - 時計の混ざり: 記録の ts は hook の `Date.now()`（hooks/activity-hook.mjs:134）、`now()` も同じ Mac の `Date.now()`。v0.49.0 も `lastClearAt`（`now()`）と記録の ts を比べている（notify.ts:124・:144）。同じ時計なので混ぜてよい。
    - 印が付いたまま新しい理由で付け直すとき（例: wait の後の stop）は `markTs = max(markTs, 新しい値)`。`cause` も新しい理由にする。ただし `cause` が failure のときは `cause` も `markTs` も変えない。
  - `lastResumeAt`: AI の再開（C2）を受けた最後の記録の ts。初めは 0。
  - `deferred`: 予定があって付けなかった最後の Stop の ts と、それを受けた hub の時刻（`now()`）。無ければ undefined。
- `forget` で全部捨てる（今と同じ）。

### 4-2. 印を付けるとき
- 書き方: 「付ける」は `unread = 1` にし、`cause` と `markTs` を §4-1 のとおり書く。`cause` が failure のときは、ほかの理由で上書きしない（失敗は PO が送るまで残す）。
- `addTurnEnd` の最初（Stop・StopFailure の両方・受けるかどうかの前）: `prevTurnEnd = lastTurnEndTs`、`lastTurnEndTs = max(lastTurnEndTs, ts)`。v0.49.0（notify.ts:121-122）と同じく、受けない Stop でも進める。起動前の記録と同じ ts の記録は ActivityStore が先に捨てるので、ここには来ない。
- S1 返事の終わり: 次を全部満たす Stop を受ける。
  - v0.49.0 R1 の 1〜4（起動前は捨てる・同じ ts は 1 回・`ts > lastClearAt`）。
  - `ts > lastResumeAt`（新しい再開の後に、遅れて結ばれた古い Stop で印を付けない）。
  - stop_hook_active が true のものは、`lastClearAt > prevTurnEnd` か `lastResumeAt > prevTurnEnd` か `deferred` があるときだけ受ける。
  - 受けたら: `hookSeen = true`。
  - `pendingSelfResume` が true でなければ（false・null・省略）付ける（`cause = "stop"`）。null は付ける。見落としより付けすぎを選ぶ。`open` が何であっても付ける（v0.49.0 の `if (w.open === "none")`・notify.ts:126 の条件は外す。`unread` は 1 までなので、付け直しても数は増えない。`cause` と `markTs` は §4-1 の付け直し）。`deferred = undefined`。`open = "stop"`（今と同じ）。
  - true なら付けず、`deferred` を入れ替える。このとき、いまの印が failure でなく、`ts > markTs` なら印を消す（`unread = 0`・`cause = "none"`）。その印より後に AI の番の返事の終わりが来たため。印を消したかどうかに関わらず `open = "none"`・`prevObs = undefined` にする（C2 と同じ。次の待ちの観測で S3 が当たり、次の Stop で S1 が付けられるように）。
- S2 失敗: StopFailure を、v0.49.0 R1 の 2〜4（起動前・重なり・`ts > lastClearAt`）を満たすときに受け、いつも付ける（`cause = "failure"`）。`deferred = undefined`。受けたら `hookSeen = true`・`open = "stop"`（v0.49.0 と同じ。StopFailure も同じ `addTurnEnd` を通っている）。
- S3 待ちの観測: v0.49.0 の R2 と同じ（status が waiting か waitingFor あり・`prevObs !== "waiting"`・`open === "none"`）。`cause = "wait"`。`markTs` は `observe` の `now`。
- S4 hook の無い窓の予備: v0.49.0 の R3 と同じ。`cause = "obs"`。`markTs` は `observe` の `now`。
- S5 付け漏れの予備: `sweepStale(now)` で、`deferred` があり、`now - deferred を受けた hub の時刻 >= 30 分`（30 分ちょうどを含む）の窓に付ける（`cause = "stale"`）。その後に C1・C2・新しい Stop が来ていれば `deferred` は消えているので付かない。付けたら `deferred = undefined`。
- `open` の扱いは v0.49.0 と同じ（R4 の busy の観測で `open = "none"`）。`unread` が 1 のまま次の理由が来ても 1 のまま。

### 4-3. 印を消すとき
- C1 PO の送信: v0.49.0 と同じ。`unread = 0`・`cause = "none"`・`lastClearAt = now`・`open = "none"`・`prevObs = undefined`・`deferred = undefined`。
- C2 AI が自分で再開: `addSelfResume(sessionId, ts)` を受けたとき。AI の再開とは、UserPromptSubmit の記録が次のどれかのもの。
  - 本文が正規表現 `/^\s*(<agent-message\b|<task-notification\b|<cross-session-message\b|# Autonomous loop\b)/` に当たる（先頭の空白を許すのは今の `AGENT_MESSAGE_PREFIX`・server/activity.ts:30 と同じ）。順に、担当の報告の戻り、裏の作業の終わりの知らせ、別の会話からの知らせ、loop の定期の回。
  - 記録に `source: "agent"` が付いている（hooks/activity-hook.mjs:167-171 が担当の報告の戻りに付ける）。
  - `promptKey(本文)` が、同じ会話の `cronPromptKeys` にある（ScheduleWakeup などの一度きりの予定の文）。
- 受ける条件: `ts > lastTurnEndTs` かつ `ts > lastClearAt`。満たさないものは何もしない（古い再開で新しい印を消さない）。
- 受けたら:
  - `lastResumeAt = max(lastResumeAt, ts)`・`deferred = undefined`。
  - `cause` が failure でなく、`ts > markTs` なら `unread = 0`・`cause = "none"`。
  - `open = "none"`（次の Stop で付けられるように）・`prevObs = undefined`（次の待ちの観測で R2 が当たるように）。`hookSeen` は変えない。
- 消すきっかけは記録の順（ts）で決める。10 秒ごとの観測（busy）では消さない（§8 C）。

### 4-4. 分かりにくい点の決め
- 繰り返しの予定（`recurring` が true。固定の間隔の /loop・CronCreate の繰り返し）は「AI の番」に数えない。何日も先の予定で印が出ないことを防ぐ。loop の定期の回が始まったら C2 で消える。
- 裏の作業は type を問わず全部「AI の番」に数える。`tail -f` のような終わらない作業・monitor で付け漏れが続く場合は、S5（30 分）で付く。
- 30 分は、§2 の「AI が再開した」止まりの上位 1 割（941 秒 ≒ 16 分）の約 2 倍。
- 担当（subagent）を裏で動かして止まった Stop が `background_tasks` に入るかは段0 で確かめる（`bg_types` の subagent の数で見る）。

### 4-5. 起きた順と結果の表（試験の正本）
- v0.49.0 の試験 row1〜row14（tests/unit/notify.test.ts）は、期待を変えずにそのまま通す。v0.49.0 には同じ窓で unread が 2 以上になることを期待する行は無い（審査役の確認）。row4（Stop → 遅れた busy → idle ＝ 1）・row5（Stop(false) → busy → Stop(true) ＝ 1）も同じ。
- 新しい行（ts は記録の ts。「30 分たつ」は `sweepStale` に渡す時刻）:

| # | 起きた順 | unread | cause |
|---|---|---|---|
| n1 | Stop(予定なし) | 1 | stop |
| n2 | Stop(予定なし) → busy → Stop(予定なし) → busy → Stop(予定なし) | 1 | stop |
| n3 | Stop(予定あり) | 0 | none |
| n4 | Stop(欄なし=null) | 1 | stop |
| n5 | Stop(予定なし, ts=100) → AI の再開(ts=110) | 0 | none |
| n6 | StopFailure(ts=100) → AI の再開(ts=110) | 1 | failure |
| n7 | StopFailure → Stop(予定なし) | 1 | failure |
| n8 | StopFailure → PO の送信 | 0 | none |
| n9 | Stop(予定あり) → 30 分たつ | 1 | stale |
| n10 | Stop(予定あり) → 29 分で AI の再開 → 30 分たつ | 0 | none |
| n11 | Stop(予定なし, ts=100) → AI の再開(ts=110) → Stop(true, 予定なし, ts=120) | 1 | stop |
| n12 | 待ちの観測(now=100) → AI の再開(ts=110) | 0 | none |
| n13 | Stop(予定なし) → 遅れた busy の観測 → idle の観測 | 1 | stop |
| n14 | Stop(予定なし, ts=100) → AI の再開(ts=90・保留から結んだ) | 1 | stop |
| n15 | AI の再開(ts=110) → Stop(予定なし, ts=100・保留から結んだ) | 0 | none |
| n16 | Stop(予定あり, ts=100) → Stop(true, 予定なし, ts=110) | 1 | stop |
| n17 | 待ちの観測(now=100) → Stop(予定あり, ts=110) | 0 | none |
| n18 | StopFailure(ts=100) → Stop(予定あり, ts=110) | 1 | failure |
| n19 | Stop(予定あり) → 30 分たつ（同じ回で agents の取得に失敗） | 1 | stale |
| n20 | Stop(予定なし, ts=100) → AI の再開(ts=110) → 待ちの観測 | 1 | wait |
| n21 | 待ちの観測(now=100) → Stop(予定あり, ts=110) → 待ちの観測(now=120) | 1 | wait |
| n22 | 待ちの観測(now=100) → Stop(予定あり, ts=110) → Stop(true, 予定なし, ts=120) | 1 | stop |
| n23 | 待ちの観測(now=100) → Stop(予定なし, ts=110) | 1 | stop |
| n24 | Stop(予定あり, now=0) → 30 分ちょうど（now=1,800,000） | 1 | stale |

- 表の決め: 「待ちの観測」は `observe("w", "waiting", undefined, now)`。「Stop(予定なし)」は `pendingSelfResume: false`、「欄なし」は null。v0.49.0 の row1〜row14 は欄を省略した Stop で流す（null と同じ）。

### 4-6. 予定の文と再開の文の突き合わせ（`promptKey`）
- 公式資料では `session_crons` の prompt は 1000 文字で切られ、「… [+N chars]」の印が付く（§2）。再開の本文は全文が残る（hooks/activity-hook.mjs:167-171）。
- 両方を同じ形にする: `promptKey(s)` = `fullText(s)` の後、末尾の `… [+数字 chars]` を外し、先頭 200 文字（コードポイントで数える。`Array.from(s).slice(0, 200).join("")`）の UTF-8 の sha256 の 16 進の先頭 16 文字。200 文字は 1000 文字の切りより短いので、切られた予定の文と全文の再開の文で同じ値になる。
- 予定側は hook が計算する（prompt の文字を記録に残さないため）。再開側は server が記録の本文から計算する。同じ式を hooks/activity-hook.mjs と server/activity.ts の 2 か所に置き、同じ文を両方に通して同じ値になる試験を 1 本足す（tests/unit/activity.test.ts）。
- ScheduleWakeup の予定の文が、そのまま再開の本文になるかは【未確認】。段0（K1）で確かめる。ならない場合は C2 の後半が働かず、その回は PO の送信か S5 で決まる（K6 に出る）。

## 5. 進め方
- 段0（確かめ）と段1（決まりの変更）は同じ PR・同じ版で入れる。段0 で欄が無いと分かった場合も、§4-2 S1 の null の扱いで v0.49.0 とほぼ同じに動き（数が 1 までになり、AI の再開で消えるだけ）、壊れない。
- 導入後の確かめで欄が入っていなければ、そこで止まって設計を見直す（決まりは戻さず、付けすぎが残るだけ）。
- K5（付けすぎ率）が 1 割を超えたとき: 決まりは戻さない（v0.49.0 の約 6 割より少なければ悪くはなっていない）。`measure-unread.mjs` の type ごとの内訳で、どの止まりが付けすぎかを見て、設計を直す次の版を起こす。6 割以上なら v0.49.0 に戻す（§9 の戻し方）。K6（付け漏れ率）が 5% を超えたときは R1 のとおり見直す。

## 6. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 段0: 導入後の Stop 10 件以上で `bg_tasks`・`bg_types`・`crons_once`・`crons_repeat` が数で残る。`bg_types` の subagent が 1 以上の Stop が 1 件以上ある。ScheduleWakeup を使った回があれば、その再開の本文の `promptKey` が直前の Stop の `cron_prompt_hashes` と 1 件以上一致する（使った回が無ければ「該当なし」と書く） | `node scripts/measure-unread.mjs --since <導入時刻>` の「欄あり件数」「type ごとの件数」「予定の文の一致件数」 |
| K2 §4-5 の表 n1〜n24 と、v0.49.0 の row1〜row14（期待を変えた行は該当なし）が全部通る | `npm test`（tests/unit/notify.test.ts） |
| K3 hook が Stop に数とハッシュだけを書き、説明文・コマンド・prompt を書かない | tests/unit/activity-hook.test.ts（欄あり・欄なし・配列でない の 3 本） |
| K4 行の言葉が「未読」だけで数字が出ない | SessionList.test.tsx（「未読」を含み、数字を含まない） |
| K5 付けすぎ率が 1 割以下（今の数え方で約 6 割） | `measure-unread.mjs` の「付けすぎ率」（式は §9） |
| K6 付け漏れ率が 5% 以下 | `measure-unread.mjs` の「付け漏れ率」（式は §9） |
| K7 型・試験・ビルドが通る | agent-console の CI（`npm test`・`npm run typecheck`） |

- K5・K6 は印の状態ではなく記録から計算する（印はメモリだけで記録に残らないため）。

## 7. リスクと対処
- R1 ScheduleWakeup の予定で止まり、その後 PO が先に送った場合は印が出ない（予定で AI の番と数えるため）。→ K6 で数える。5% を超えたら一度きりの予定も「AI の番」から外すかを見直す。
- R2 Claude Code の版で欄の形が変わる → 欄が無い・配列でないときは null として付ける。
- R3 担当の報告の戻りが `background_tasks` に入らない版だと付けすぎが残る → C2 で再開時に消えるので、残る時間は再開までの間（中央値 193 秒）。K5 で測る。
- R4 記録に余計な文字が残る → 数とハッシュだけ。
- R5 AI の再開の見分けを本文の先頭の形に頼る → Claude Code の版で形が変わると C2 が働かず、PO の送信まで残る（v0.49.0 と同じ動き）。K5 で気づける。
- R6 記録から見た「PO の送信」は、C2 に当たらない入力すべて（ScheduleWakeup の文が一致しない回を含む）。K6 は多めに出る側に寄る（付け漏れを見逃さない側）。

## 8. 代替案と選んだ理由
- A 次の入力が来るまで待ってから付ける: 印が遅れ、PO の番かは結局分からない。採らない。
- B 数だけ減らす（同じ窓では 1 回だけ）: AI の番の窓に印が残る。採らない。
- C 10 秒ごとの観測で busy を見たら消す（第1版）: 観測が遅れて届くと PO の番の印まで消える（§11 (1)）。採らない。
- D（採用）Claude Code が Stop で教える予定と、記録に残る AI の再開の入力で決める。記録の順で決まり、観測の遅れの影響を受けない。

## 9. 戻し方・測り方・維持
- 戻し方: `bash scripts/ac-update.sh v0.49.0`（記録の欄が増えても古い版は読まないだけ）。
- 測り方: scripts/measure-unread.mjs（新規・読むだけ）。
  - 入力: activity の jsonl（`--since` から。既定は導入から 24 時間）。会話ごとに ts の順に並べる。
  - 数える止まり: stop_hook_active が false の Stop だけ。stop_hook_active が true の Stop と StopFailure は件数だけ別に出し、率の分母に入れない（StopFailure はいつも付けるので付けすぎに数えない）。
  - 次の入力: 同じ会話で次に来た UserPromptSubmit。C2 の判定（§4-3）に当たれば「AI の再開」、当たらなければ「PO」（R6 の近似）。次の入力が無い止まりは分母から外し、件数だけ出す。
  - 間の時間: 止まりの記録の ts と次の入力の記録の ts の差。
  - 付けすぎ率 = 「付けた止まり」のうち次の入力が AI の再開のもの ÷ 「付けた止まり」。「付けた止まり」は、`pendingSelfResume` が true でない Stop と、true で次の入力まで 30 分以上の Stop（S5）。
  - 付け漏れ率 = `pendingSelfResume` が true で、次の入力が PO、間が 30 分未満の Stop ÷ `pendingSelfResume` が true の Stop。type ごと（monitor を含む）にも分けて出す。`tail -f` は記録にコマンドを残さないので shell と分けられない。
  - 分母の下限: 付けすぎ率の分母が 100 件未満、付け漏れ率の分母が 30 件未満なら、`--since` を 72 時間まで延ばす。それでも足りなければ「判定できない」と出し、K5・K6 は判定しない。
  - 第2版の §2 の数は、C2 の判定のうち先頭の形だけで数えた（台本の元: scratchpad/unread/tool/count_stops.py）。
- 維持: 正本は `BreakTracker` 1 か所のまま。決まりは notify.test.ts の §4-5 の表で固める。

## 10. 外部事例
- 該当なし。理由: Claude Code の公式の欄（Stop hook の `background_tasks`・`session_crons`）と、この Mac の記録の実測で決める。外の事例の数値は判断を変えない。

## 11. 第1版の審査（REVISE）への対応
- (1) busy で消すと遅れた観測で PO の番の印が消える → C2 を記録の AI の再開に替えた（§4-3・§8 C）。row4 を n13 で固定。
- (2) busy で消した後の Stop(true) を受けない → C2 は `lastResumeAt` を持ち、S1 で Stop(true) を受ける条件に入れた（§4-2 S1・n11）。
- (3) 理由の置き場所 → `cause` を足し、失敗は上書きしない（§4-1・§4-2）。
- (4) 起きた順の表 → §4-5。row4・row5 は期待を変えずに通す。
- (5) 付け漏れの基準 → K6。
- (6) 終わらない作業・遠い予定 → 繰り返しの予定は数えない・S5（30 分）（§4-4）。
- (7) K1・K5 の観測の手順 → measure-unread.mjs と式（§9）。
- (8) 数の 2 通り → 1 本の台本で数え直した（§2）。
- (9) §5 の食い違い → 同じ PR にし、欄が無いときの動きを書いた（§5）。
- (10) 対象の漏れ → SessionList.test.tsx:123・タブの題（§1 の 5）・activity-hook.test.ts を入れた（§3）。
- 推奨 (1) → 採用（C2）。(2) → S1 を「v0.49.0 R1 の 1〜4」と書いた。(3) → 原文を §2 に写した。(4) → S2 に条件を書いた。(5) → 10 秒を「観測 1 回」に（K の表から外した）。

## 12. 第2版の審査（REVISE）への対応
- (1) `markTs` の定義 → §4-1 に理由ごとの値・付け直し・同じ時計の根拠を書いた。古い再開は `ts > lastTurnEndTs` で捨てる（§4-3）。
- (2) 遅れた古い Stop → S1 に `ts > lastResumeAt`。再開と返事の終わりは同じ保留で ts の順に結ぶ（§3 hub.ts）。n15。
- (3) C2 が `open`・`prevObs`・`hookSeen` に何をするか → §4-3 に書いた。予定ありの Stop も `hookSeen = true`（§4-2 S1）。n11・n20。
- (4) 予定ありの後の Stop(true) → `deferred` があれば受けて S1 をやり直す（§4-2 S1）。n16。
- (5) 突き合わせの形 → `promptKey`（§4-6）。hook と server の同じ式を試験で比べる。ScheduleWakeup の一致は K1 で見る。
- (6) 担当と shell の見分け → `bg_types`（§3）。K1 で subagent の数を見る。
- (7) K5・K6 の式 → §9 に分母・外すもの・時間の測り方・下限を書いた。PO の送信は近似（R6）。
- (8) n2 と K2 → n2 を busy を挟む形に、K2 の「期待を変えた行」を該当なしに直した。
- 推奨: S5 は :615 の前（n19）、daily-use.integration.test.ts を対象に、`cronPromptKeys` と `resumeTs` を `SessionState` に、C2 は :509 の前、§2 の言い方を直した、K6 を type ごとに、cross-session の内訳は【未確認】と書いた。
- 第3版で足した決め: 予定ありの Stop は、それより前に付いた印（failure 以外）を消す（§4-2 S1・n17・n18）。その印の後に AI が仕事を続けて、AI の番で止まったため。

## 13. 第3版の審査（REVISE）への対応
- (1) 予定ありの Stop で印を消したとき `open`・`prevObs` が残る → S1 の予定ありの道で、印を消したかどうかに関わらず `open = "none"`・`prevObs = undefined` にした（§4-2 S1）。n21・n22。
- (2) S1 で付けるときの `open === "none"` → 外した。`unread` は 1 までで、`cause`・`markTs` は §4-1 の付け直し（§4-2 S1）。n23。
- (3) `lastTurnEndTs` を進める時 → `addTurnEnd` の最初で、受けるかどうかの前に進める（v0.49.0 と同じ）。StopFailure も同じ。S2 は受けたら `hookSeen = true`・`open = "stop"`（§4-2）。
- (4) `observe` の `now` → 省略できる 4 つ目の引数。hub.ts:627 で `this.now()` を渡す（§3）。
- (5) `TurnEnd.pendingSelfResume` → 省略できる欄。省略は null と同じ。row1〜row14 は欄を省略して流す（§3・§4-5 の表の決め）。
- 推奨: C2 の正規表現と `source: "agent"`（§4-3）、`promptKey` はコードポイントで 200 文字（§4-6）、hook の欄は `withFullText` の前の `base`・欄の無い Stop の後は `cronPromptKeys = []`（§3）、画面に届く道（§3 hub.ts）、30 分ちょうどを含む（S5・n24）、`watchActivity` の型と偽の store（§3）、K5 が 1 割を超えたとき（§5）、applyPrompt の行を :506 に直した（§3）。
