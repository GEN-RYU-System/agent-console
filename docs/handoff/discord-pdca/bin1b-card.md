# 実装カード: discord-pdca 便1b — 画面の予約・定期実行の作成で、ほかとの重なりを見せる（v0.45.0）

設計: [design.md](design.md)（第13版。§4-3 の「PO が画面から作るものには関門をかけず、確認の欄で重なりを見せる」、§8 の便1b、§14-2 (b)）。根拠: [recon.md](recon.md) と、このカードの「点検した事実」。
PO 承認: 2026-10-21「1」（§14-2: 60分未満・画面には関門をかけず確認の欄で見せる）、2026-10-23「1」（便1b の指示書を作り、作る係に作らせてよい）。
作業場所: `/Users/tanizawashingo/agent-console-wt/discord-pdca-bin1b`（ブランチ `release/discord-pdca-bin1b`、このカードが入った origin/main 起点）。

## 決めたこと（設計の読み方）
- 「確認の欄」: 今の作成・変更の画面には、保存の前に内容を見せる別の画面は無い（点検 c）。保存ボタンのすぐ上の、お知らせの欄（`Callout`）の並びを「確認の欄」とする。新しい確認の画面は作らない。
- 画面からの保存は止めない（PO 2026-10-21「1」）。重なりが出ていても保存ボタンはそのまま押せる。
- 重なりの判定は、便1 の関門と同じ計算を使う（2つ目の計算を作らない。SSOT）。画面に答えるための入口を1つ足し、関門の部品から「相手・前後の空き」を構造のまま返す。
- 定期実行は、関門と同じく「有効になるもの」だけを見る。無効の定期実行を変える画面では出さない。

## 点検した事実（origin/main d25da9a。生出力は /tmp/CC報告ファイル/discord-pdca-bin1b/）
- a. `server/schedule-gate.ts:57-73` `checkReservation` と `:76-88` `checkRoutine` は、保存・監査・順番待ちをしない。相手は `best`（型 `Hit` :27）、前後の空きは文字列 `prev`/`next`（予約は `stamp` :35 の `YYYY-MM-DDTHH:mm+09:00`、定期実行は `hhmm` :36 の `HH:mm`、無ければ "なし"）。文は `conflict`（:90-92）。読めていない間は `ready`（:50-54）が投げる。`PassThroughGate`（:169-172）は check の2つを空にしている
- b. 配線は `server/index.ts:79-82`（`new ScheduleGate()`・attach）。画面用の入口は `server/http.ts` の handleApi（:147〜）。予約の一覧の GET は :196。認証は :618-630（session の GET は Origin 不要）。`SessionInputError` は 400 `{error}`
- c. 予約の作成は `src/components/Reservations/ReservationEditor.tsx`（:44 日付・:45 時刻・:47 info の Callout・:48 失敗の Callout・:49 保存）。`date` と `time` の文字列をそのまま送り、runAt はサーバーの `resolveRunAt`（`server/reservations.ts:103-112`、export されていない）が作る。定期実行は `src/components/Routines/RoutineEditor.tsx`（:17 の state、:27 時刻、:28 曜日、:31 info、:32 失敗、:33 保存。props の `routine` に id。:19 で `enabled: routine?.enabled ?? true`）
- d. 画面の API は `src/api.ts:36-45` の `request<T>` と :161-167。型は `src/types.ts:117-130`
- e. 部品は `@sa/components/*`（Callout は `variant="info"|"warning"` と `title` を使用中）。`npm run lint`（`scripts/check-design-governance.mjs`）が色名・寸法の直値・tsx の日本語の直書きを止める
- f. 文言は `src/locales/ja.json` だけ（en.json は無い）。キーは `ac.reservations.*`（:308〜）・`ac.routines.*`（:253〜）
- g. 画面の試験は `ReservationEditor.test.tsx`・`RoutineEditor.test.tsx`（vitest・testing-library・`vi.mock("../../api")`）。関門の試験 `tests/unit/schedule-gate.test.ts` は :34 で文を完全一致、:64・:70 で前後の書き方を照合している
- h. 予約の時刻の見せ方は `ReservationsPane.tsx:16` の `formatJst`（"2026/10/15 09:00 JST"。export されていない）

## 守ること
- 触ってよいのは §変更 のファイルだけ。`hooks/`・`scripts/`・`agent-console.config.json`・`.github/`・予約と定期実行の保存の道（`server/reservations.ts` の create/cancel/tick、`server/routines.ts`）は触らない
- 関門の拒否の文（AI に返す文）は1文字も変えない（`schedule-gate.test.ts` :34・:64・:70 が通ったままであること）
- cd を使わない（`git -C`・`npm --prefix` 等で絶対パス指定）
- Bash の命令に `Application Support/agent-console` の文字列を書かない。`pkill` `killall` `kill` `launchctl` を実行しない。導入（ac-update・install）しない。本番の dataDir を読まない・書かない
- 画面の文字は t() と `src/locales/ja.json` だけ。部品は `@sa/components/*` の金型だけ（新しい部品を作らない）。色や寸法の直値・インライン style を書かない。CSS を足さない
- 迷ったら全停止して `NEEDS_DECISION:`。報告は DONE / BLOCKED: / NEEDS_DECISION: で始め、生出力の保存パスを添える。試験を通すために試験の期待値を変えない

## 変更

### 1. `server/schedule-gate.ts`
- 型を足して export する:
  ```ts
  /** 画面に見せる重なり。at は相手のぶつかった回の YYYY-MM-DDTHH:mm+09:00。before/after は空いている近い時刻（予約の候補は YYYY-MM-DDTHH:mm+09:00、定期実行の候補は HH:mm。無ければ null） */
  export interface ScheduleOverlap { name: string; kind: "reservation" | "routine"; at: string; before: string | null; after: string | null }
  /** ready=false は予約の一覧をまだ読めていない */
  export type SchedulePreview = { ready: false } | { ready: true; overlap: ScheduleOverlap | null }
  ```
- `checkReservation` と `checkRoutine` の中の「相手と前後の空きを求める」部分を、private の `findReservation(s, runAt, nowMs)`・`findRoutine(s, candidate, nowMs)` に移す（戻りは `{ hit: Hit; prev: string | null; next: string | null } | null`。探し方・範囲・順番は今のまま）。`checkReservation`・`checkRoutine` は `this.ready()` のあとそれを呼び、null なら return、あれば `throw this.conflict(hit, prev ?? "なし", next ?? "なし")`。**拒否の文・投げる場面は今と同じ**
- public のメソッドを2つ足す（保存・監査・順番待ちをしない。`run` を呼ばない）:
  - `previewReservation(runAt: number, nowMs: number): SchedulePreview`
  - `previewRoutine(candidate: RoutineCandidate, nowMs: number): SchedulePreview`
  - attach 前なら今の `ready` と同じ Error を投げる。`reservationsReady()` が false なら `{ ready: false }`（投げない）。それ以外は find の結果を `ScheduleOverlap` にして返す（`kind` は `Hit.kind` の "予約"→"reservation"、"定期実行"→"routine"。`at` は `stamp(hit.otherMs)`）
  - `previewRoutine` は `candidate.weekdays` が空なら `{ ready: true, overlap: null }`
- `PassThroughGate` に `previewReservation`・`previewRoutine` の上書きを足し、どちらも `{ ready: true, overlap: null }` を返す（「比べない関門」の意味をそろえる）
- 先頭コメントの末尾に「画面には preview で重なりを見せる（止めない）」を足す

### 2. `server/reservations.ts`
- `resolveRunAt`（:103）に `export` を付けるだけ。中身は変えない

### 3. `server/index.ts` と `server/http.ts`
- http の依存（handleApi が受け取る `deps` の型。実物の名前に合わせる）に `schedule: ScheduleGate` を足し、`server/index.ts` で :79 の `gate` を渡す。`tests/unit/helpers/harness.ts` も、作っている gate を同じ名前で渡す
- 画面用の入口を1つ足す（:196 の予約の一覧の GET の近く。共通の認証 :618-630 の内側＝session の Bearer が要る）:
  - `GET /api/schedule/preview?kind=reservation&date=YYYY-MM-DD&time=HH:mm`
    - `resolveRunAt(date, time)` で runAt を作り（形の誤りはそこで `SessionInputError` → 400）、`deps.schedule.previewReservation(runAt, Date.now())` を 200 で返す
  - `GET /api/schedule/preview?kind=routine&weekdays=1,2,3&time=HH:mm&excludeId=<id>`
    - `weekdays` はカンマ区切りの 0〜6 の整数（重複なし、空なら空の配列）。`time` は `/^([01]\d|2[0-3]):[0-5]\d$/`。どちらかが違えば `SessionInputError("schedule preview input invalid")` → 400。`excludeId` は省けて、あれば長さ1〜200の文字列（違えば同じ 400）
    - `deps.schedule.previewRoutine({ id: excludeId, name: "", weekdays, timeHHmm: time }, Date.now())` を 200 で返す
  - `kind` がそれ以外なら同じ 400。監査には書かない（読むだけ）
  - 定期実行の時刻の形の検査が `server/routines.ts` に既にあれば、それを使う（2つ目の正規表現を作らない）。使えない形なら上の正規表現を http.ts に置き、報告に書く

### 4. `src/types.ts` と `src/api.ts`
- `src/types.ts` に、サーバーと同じ形の `ScheduleOverlap`・`SchedulePreview` を足す（:130 の近く）
- `src/api.ts` の :167 の後に:
  ```ts
  export const previewReservationSchedule = (date: string, time: string): Promise<SchedulePreview> => request(`/api/schedule/preview?${new URLSearchParams({ kind: "reservation", date, time })}`);
  export const previewRoutineSchedule = (weekdays: number[], timeHHmm: string, excludeId?: string): Promise<SchedulePreview> => request(`/api/schedule/preview?${new URLSearchParams({ kind: "routine", weekdays: weekdays.join(","), time: timeHHmm, ...(excludeId ? { excludeId } : {}) })}`);
  ```
  （`request` の呼び方は :161-167 の並びに合わせる）

### 5. 画面に見せる部品 `src/components/ScheduleOverlap/ScheduleOverlapNotice.tsx`（新規。予約と定期実行で共用）
- props: `{ preview: SchedulePreview | null; failed: boolean }`
- 出すもの（どれも `Callout variant="warning"`。`@sa/components/Callout` を使う）:
  - `failed` が true: title `ac.schedule.checkFailedTitle`、本文 `ac.schedule.checkFailed`
  - `preview` が `{ ready: false }`: title `ac.schedule.notReadyTitle`、本文 `ac.schedule.notReady`
  - `preview.overlap` がある: title `ac.schedule.overlapTitle`、本文は1段落目 `ac.schedule.overlapBody`（`name`・`kind`＝`t("ac.schedule.kind.<kind>")`・`at`＝下の整形）、2段落目 `ac.schedule.freeTimes`（`before`・`after`。null は `t("ac.schedule.none")`。`HH:mm` の形はそのまま、日時の形は下の整形）、3段落目 `ac.schedule.saveAllowed`
  - それ以外（`preview` が null、または overlap が null）は何も出さない（`null` を返す）
- 段落は `Stack`（`@sa/components/Stack`）か、Callout の子に並べる。生の `p`・`div` に class や style を付けない（lint の決まりに合わせる。生の要素が lint で止まるなら `Stack` を使う）
- 日時の整形: `ReservationsPane.tsx:16` の `formatJst` を `src/components/Reservations/formatJst.ts`（新規）に移して export し、`ReservationsPane.tsx` とこの部品の両方から使う（同じ整形を2つ作らない）。`formatJst` の中の " JST" の文字は今のまま（今もある表示。tsx の日本語ではない）
- `data-testid="schedule-overlap"` を、出したときの Callout を包む要素か Callout 自身に付ける（Callout が props を通さなければ報告に書いて、包む要素を `Stack` にする）

### 6. 予約の作成の画面 `src/components/Reservations/ReservationEditor.tsx`
- 状態を2つ足す: `preview: SchedulePreview | null`、`previewFailed: boolean`
- `date` と `time` が変わるたびに（`useEffect`）、`date` が空でなく `time` が `/^\d{2}:\d{2}$/` に合うときだけ、300ms 待ってから `previewReservationSchedule(date, time)` を呼ぶ。合わないときは `preview=null`・`previewFailed=false`
  - 古い答えは捨てる（呼ぶたびに番号を1つ増やし、答えが返ったとき番号が最新でなければ使わない。effect の後始末でタイマーを止める）
  - 答えが 400（`ApiError` の status 400）なら、入力の途中とみなして `preview=null`・`previewFailed=false`。そのほかの失敗は `previewFailed=true`
- :47 の info の Callout の**後**、:48 の失敗の Callout の**前**に `<ScheduleOverlapNotice preview={preview} failed={previewFailed} />`
- 保存ボタンの `disabled` は変えない（重なりでも押せる）

### 7. 定期実行の作成・変更の画面 `src/components/Routines/RoutineEditor.tsx`
- 予約と同じ形で、`weekdays` と `timeHHmm` が変わるたびに 300ms 待ってから `previewRoutineSchedule(weekdays, timeHHmm, routine?.id)`
  - 呼ぶのは、`(routine?.enabled ?? true)` が true で、`weekdays` が空でなく、`timeHHmm` が `/^\d{2}:\d{2}$/` に合うときだけ。それ以外は何も出さない
  - 古い答えの捨て方・400 の扱いは §6 と同じ
- :31 の info の Callout の**後**、:32 の失敗の Callout の**前**に `<ScheduleOverlapNotice … />`
- 保存ボタンは変えない
- :17 の1行に state を詰めている今の書き方はそのまま（足す state は別の行でよい）

### 8. 文言 `src/locales/ja.json`（`ac.schedule` を新しく足す）
```json
"schedule": {
  "overlapTitle": "ほかの予定と開始が1時間以内です",
  "overlapBody": "「{{name}}」（{{kind}}・{{at}}）と開始の差が60分未満です。",
  "kind": { "reservation": "予約", "routine": "定期実行" },
  "freeTimes": "空いている近い時刻: 前 {{before}} ／ 後 {{after}}",
  "none": "なし",
  "saveAllowed": "このまま保存することもできます。",
  "notReadyTitle": "重なりをまだ確かめられません",
  "notReady": "予約の一覧をまだ読めていません。数秒待ってから時刻を選び直してください。",
  "checkFailedTitle": "重なりを確かめられませんでした",
  "checkFailed": "保存はできます。続くときは PO に知らせてください。"
}
```
- `ac` の下の、`routines`・`reservations` と同じ階層に置く

### 9. 版・文書
- `package.json`・`package-lock.json`（2 か所）・`extension/manifest.json` を 0.45.0
- `docs/CHANGELOG.md` の :5 の上に 0.45.0 の 1 行（画面で予約・定期実行を作るとき、ほかと開始が60分未満なら確認の欄に相手の名前・時刻と空いている近い時刻を出す。保存は止めない／戻し方 `bash scripts/ac-update.sh v0.44.0`／設計パス）
- `README.md`: 予約の節と定期実行の節に1行ずつ「画面から作るときは、ほかと開始が60分未満なら確認の欄に知らせる（保存は止めない）」

### 10. テスト
- `tests/unit/schedule-gate.test.ts`（足す。今の G1〜G16 は変えない）:
  - P1 予約: 59分差の相手があると `previewReservation` が `{ ready: true, overlap: { name, kind: "reservation", at, before, after } }` を返し、`before`/`after` が、同じ入力の `checkReservation` の拒否の文の前後と同じ値
  - P2 予約: 60分ちょうどは `overlap: null`
  - P3 定期実行: 相手が定期実行で `kind: "routine"`、`before`/`after` が `HH:mm`。`id` に自分を入れると自分とは比べない
  - P4 空きが無いとき `before`/`after` が null（文では「なし」）
  - P5 `reservationsReady` が false なら `{ ready: false }`（投げない）。attach 前は投げる
  - P6 `previewReservation`・`previewRoutine` を呼んでも、`run` の順番待ちに入らない（呼んでいる間に `run` の中の処理が止まらない、で確かめる）
  - P7 `PassThroughGate` は両方 `{ ready: true, overlap: null }`
- server の入口（harness を使う試験。今の `reservations.test.ts` の画面の入口の試験 :332-335 と同じ書き方。新しいファイル `tests/unit/schedule-preview.test.ts` でよい）:
  - 認証なしは 401
  - 予約: 重なる相手がいる時刻で 200 と overlap。重ならない時刻で 200 と `overlap: null`。日付の形の誤りで 400
  - 定期実行: 重なり・重ならない・`excludeId` で自分を外す・`weekdays=7` で 400・`time=24:00` で 400・`kind=x` で 400
  - 呼んだあとで、予約の件数・定期実行の件数・監査の行数が変わらない
- 画面（`ReservationEditor.test.tsx`・`RoutineEditor.test.tsx` に足す。`vi.mock("../../api")` で preview の関数を偽にする。今の試験は変えない）:
  - 重なる答えのとき、`schedule-overlap` に相手の名前と「2026/10/23 10:00 JST」の形の時刻が出る
  - 重ならない答えのとき、`schedule-overlap` が無い
  - 重なりが出ていても保存ボタンを押すと `onSave` が呼ばれる
  - 先に投げた問い合わせの答えが後から返っても、最後の入力の答えだけが出る（古い答えを捨てる）
  - 答えが 400 のとき何も出ず、ほかの失敗のとき「確かめられませんでした」が出る
  - 定期実行: 無効の定期実行を変えるときは問い合わせない。変えるときは `routine.id` が `excludeId` に渡る
- `ScheduleOverlapNotice` の単体（`ready: false` の文・`before` null で「なし」）

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin1b/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/schedule-gate.test.ts tests/unit/schedule-preview.test.ts src/components/Reservations src/components/Routines src/components/ScheduleOverlap`  4. `npm test`
5. `git diff --stat origin/main...HEAD` が §変更 のファイルと新しい試験だけ
6. 画面の目で見る確認（試験用のサーバー。本番は使わない）: harness か試験用のポート・/tmp の dataDir で立てたサーバーに、予約を1件（例 10:00）入れておき、Playwright で予約の作成の画面を開いて 10:30 を選ぶと注意が出る・12:00 を選ぶと消える、の画面写真を2枚 /tmp/CC報告ファイル/discord-pdca-bin1b/ に保存。定期実行の画面でも同じく2枚。立て方が分からなければ、この項目だけ BLOCKED: で返してよい（ほかは進める）
7. コミット `feat: 画面の予約・定期実行の作成で、ほかと開始が1時間以内なら確認の欄に知らせる（v0.45.0）`（末尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）して push。PR は作らない

## 想定分岐
- http の依存の型の名前が違う・gate を渡す道が無い: 実物の名前に合わせて足す。依存の型を3つ以上のファイルで直す必要があれば NEEDS_DECISION:
- `Callout` が子に複数の段落を受けない・`data-testid` を通さない: `Stack` で包む。それでも lint に止まるなら NEEDS_DECISION:（生の要素や style で逃げない）
- `ApiError` が status を持たない・名前が違う: `src/api.ts:36-45` の実物に合わせる。400 を見分けられないなら NEEDS_DECISION:
- 定期実行の画面で `routine.enabled` が無い型: 型の実物に合わせる。無効を見分けられないなら、いつも問い合わせる形にして報告に書く
- `findReservation`/`findRoutine` に移したら G1〜G16 のどれかが落ちた: 移し方を直す（期待値は変えない）。直せなければ BLOCKED:
- 300ms の待ちで既存の画面の試験が落ちた（タイマーの偽物の使い方の違いなど）: 新しい試験の側でタイマーを扱う。既存の試験の期待値は変えない。直せなければ NEEDS_DECISION:
- `npm test` で今回のファイル以外が落ちたら、単独で回し直して結果を添える。単独で通るなら報告に書いて進める（便1 で chat-queue.integration:323・daily-use.integration:152 が負荷で落ち、単独では通った）。単独でも落ちるなら BLOCKED:
