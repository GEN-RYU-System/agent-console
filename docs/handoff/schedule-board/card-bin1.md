# 予定画面 便1 — 実装カード

設計: design.md（同じフォルダ。第12回）。調査: recon.md。PO 承認: D3「作り始めてよい」（2026-10-30「1」）・D4（2026-11-06「1」）。
土台の版: agent-console origin/main 412717f（v0.51.0）、Sales Anchor origin/main 826fbf83d（金型 CalendarView 入り）。
このカードに無いことはしない。迷ったら止まって `NEEDS_DECISION:` で返す。

## 0 作る物（一言）
中央に「予定」タブを足す。やることを足す・終わった・消すができ、日（今日と明日の2列）／週（月〜日の7列）／月（升目）の時間割で、開発／秘書に分けて見える。重なる2つは赤枠と「重なり」の札。Google カレンダー・見積もり・予定係は入れない（便2〜4）。

## 1 触るファイル（これ以外は触らない）
| ファイル | 変更 |
|---|---|
| package.json・package-lock.json | dependencies に `@fullcalendar/core`・`@fullcalendar/daygrid`・`@fullcalendar/react`・`@fullcalendar/timegrid` を `6.1.22` ちょうど（^ を付けない）で足す。version を 0.52.0 |
| extension/manifest.json | version を 0.52.0（v0.51.0 の PR と同じ扱い） |
| server/schedule-items.ts（新） | ScheduleItem の型・検査・`ScheduleItemStore`・`ScheduleItemService`（§3） |
| server/http.ts | AppDeps に `scheduleItems: ScheduleItemService`（§4）、画面用の道4つ（§4）。第17回: :748 の contentSecurityPolicy の `img-src 'self' data:;` の直後に `font-src 'self' data:;` を足す（並びはほかを変えない）。:741-746 の説明に「font-src に data: が要る理由: FullCalendar の CSS が矢印などの印の字体（fcicons）を data: で持ち、Chrome は data: の字体を使う前に読むため、予定タブを開かなくても CSP 違反が出る（e2e で実測）」を足す |
| server/index.ts | :119 の createRequestHandler に `scheduleItems` を渡す（:90 の reservations と同じ並びで `new ScheduleItemService(new ScheduleItemStore(config.dataDir))` を作る） |
| tests/unit/helpers/harness.ts | :281 の createRequestHandler にも `scheduleItems` を渡す（同じ作り方。AppDeps の必須欄が増えると tsconfig.server.json の型検査がここで落ちるため）。返す物（:55-68 の型）に `scheduleItems: ScheduleItemService` を足す。schedule-http の試験はこの harness を使う |
| src/types.ts | `ScheduleSide`・`ScheduleKind`・`ScheduleItem`・`ScheduleItemInput`・`ScheduleItemPatch` |
| src/api.ts | `fetchSchedule(from,to)`・`createScheduleItem`・`updateScheduleItem`・`deleteScheduleItem`（:165-167 の予約と同じ書き方） |
| src/components/Schedule/SchedulePane.tsx（新） | 画面（§5） |
| src/components/Schedule/ScheduleItemEditor.tsx（新） | 足す小窓の中身（ReservationEditor.tsx と同じ型） |
| src/components/Schedule/scheduleView.ts（新） | 純粋な関数: `findOverlaps`・`jstToday`・`viewRange`・`toCalendarEvents`（§6） |
| src/components/Schedule/Schedule.css（新） | var() だけ。border は 1px だけ。第16回: `.ac-schedule` に display を付けるので、ほかの画面（ac-diff・ac-files 等）と同じく `.ac-schedule[hidden] { display: none; }` を必ず置く |
| src/pages/ConsolePage.tsx | :57 の CenterTab に `"schedule"`、:540 の後に `{ key: "schedule", label: t("ac.tabs.schedule") }`、:602 の後に `<SchedulePane active={centerTab === "schedule"} />`、:46 の後に import |
| src/locales/ja.json | `ac.tabs.schedule`＝「予定」、新しい名前の段 `ac.scheduleBoard.*`（§7）。既存の `ac.schedule.*`（:309、予約の重なりの知らせ）は触らない |
| tests/unit/schedule-items.test.ts（新）・tests/unit/find-overlaps.test.tsx（新）・tests/unit/schedule-view.test.tsx（新）・tests/unit/schedule-http.test.ts（新） | §8 | 第15回: find-overlaps と schedule-view は src と @sa を読むので .tsx（tests/unit/**/*.ts は server 側の tsconfig で検査され src を解決できないため） |
| tests/e2e/chat.spec.ts | 第16回: :86 の中央タブの並びの期待値の最後に「予定」を足す。ほかは変えない |
| src/pages/ConsolePage.test.tsx | 第15回: 中央タブが1つ増えるので、タブの数と並びを数える試験（「8 tabs」・チャットが先頭でほかは今の順）を「予定」入りの数と並びに直す。ほかの試験は変えない |
| tests/e2e/schedule.spec.ts（新） | §8 |
| playwright.config.ts | :27 の app の testMatch に `schedule` を足す |
| tests/e2e/console.spec.ts | :785 の除外に `schedule.json` を足す（activity・boards と同じ。起動時には作らないため）。一覧の配列は変えない。第17回: :598 の中央タブの数の期待値 `toBe(8)` を `toBe(9)` にする（「予定」が増えたぶん。その下の 1400px ではみ出さない確かめは変えない） |
| src/pages/ConsolePage.css | 第18回: :26-30 の `.ac-center-tabs.comp-tabs .comp-tabs__tab` の `padding: 0 var(--space-3);` を `padding: 0 var(--space-2);` にする（12px→8px。9本で72px空く）。height・font-size の2行と上の説明は変えない（ConsolePage.test.tsx の「px/rem の直書きが無い」試験をそのまま通す）。説明に「タブ9本が1400pxで収まるよう左右の余白は --space-2（第18回、ubuntu の e2e で 0.03px はみ出しを実測）」を1行足す |
| tests/unit/pairing.integration.test.ts | 第17回: :370 の CSP の期待の文字列に、http.ts と同じ位置で `font-src 'self' data:; ` を足す。ほかは変えない |
| README.md | 「予定」節（使い方・保存先 dataDir/schedule.json・戻し方） |
| docs/CHANGELOG.md | 0.52.0 の1行（戻し方 `bash scripts/ac-update.sh v0.51.0`）。第19回: main の v0.51.1（PR #101）を取り込み、0.51.1 の行を残してその上に 0.52.0 の行を置く。戻し方は `v0.51.1` にする（README の「予定」節の戻し方も同じ） |

触らない: server/reservations.ts・server/schedule-gate.ts・`/api/schedule/preview`（http.ts:227）・既存の `ac.schedule.*` 文言・ScheduleOverlap/・作戦ボード・Google・見積もり・予定係・.sa-cache/（コミットしない）。

## 2 先に確かめること（実物点検。結果を PR 本文に書く）
1. `node scripts/sa-sync.mjs` のあと `.sa-cache/SOURCE` が 826fbf83d 以降で、`.sa-cache/frontend/src/components/CalendarView.tsx` がある。無ければ止まる（BLOCKED）。
2. `.sa-cache/frontend/src/locales/ja.json` に `calendarView.more`・`calendarView.allDay` がある（src/i18n.ts:19 で混ぜて読まれる）。
3. `npm install` 後 `npm ls @fullcalendar/core` が 6.1.22 の1つだけ。
4. 想定の分かれ道: (a) typecheck が .sa-cache の CalendarView で落ちる → 依存の版を確かめ、直らなければ止まる（金型は直さない）。(b) `npm run lint`（check-design-governance）が .sa-cache の CSS を見て落ちる → 検査の対象は変えずに止まる。(c) e2e で FullCalendar の名前を使わないと測れない → 止まる。

## 3 保存（server/schedule-items.ts）
- 型は design §4-3 のとおり（id `"sch_"`＋乱数12文字、side、kind、title 1〜200字・制御文字禁止、date "YYYY-MM-DD"、start/end "HH:mm"、end は start があるときだけで start より後、waitingOn 100字まで（kind waiting のときだけ）、note 1000字まで、status、createdBy、createdAt、updatedAt、doneAt）。
- ファイル `dataDir/schedule.json` ＝ `{ "version": 1, "items": [...] }`。書き手は `ScheduleItemStore` だけ。reservations.ts:86-101 の ReservationStore と同じ形（createSerial、書く前に read して壊れた中身・知らない版は上書きしない、writeJsonAtomic）。
- 日付の検査: 正規表現のあと、`Date.UTC` で作った日付を日本時間で書き戻し、元の文字列と同じかを見る（reservations.ts:103-114 resolveRunAt の考え）。存在しない日付・時刻は SessionInputError（400）。
- 上限: open が 300 件ある状態の追加は 400（`SessionInputError("schedule open limit")`）。全体 1000 件を超えたら doneAt の古い done から消す（reservations.ts:117-123 prune と同じ形）。
- 作り方: `new ScheduleItemStore(dataDir)`、`new ScheduleItemService(store)`（引数はこの1つだけ）。
- ScheduleItemService: `list(from, to)` は date が [from, to] のもの＋date の無いもの（終わったものも返す）。`create(input, "ui")`・`update(id, patch)`（title・date・start・end・note・waitingOn・status。status を done にしたら doneAt、open に戻したら doneAt を消す）・`remove(id)`。無い id は SessionNotFoundError（404）。

## 4 画面用の道（server/http.ts、認証の後・:227 の preview の近くに置く）
- `GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD` → 200 `{ items }`。from > to・42日を超える・形が違う → 400。便1 では calendar・dev・assistant の欄は返さない（便3・4 で足す）。
- `POST /api/schedule/items` → 201 item。`PATCH /api/schedule/items/:id` → 200 item。`DELETE /api/schedule/items/:id` → 200 `{ ok: true }`。
- 道の判定は `url.pathname === "/api/schedule"` と `/^\/api\/schedule\/items(?:\/([^/]+))?$/` だけ。`/api/schedule/preview` は今の行のまま先に判定される（取り合わないことを試験で確かめる）。
- 変更系に Origin が要るのは既存の仕組み（http.ts の認証の後の検査）がそのまま効く。新しく足さない。

## 5 画面（SchedulePane.tsx）
- ReservationsPane.tsx（:26-80）と同じ型: `active` を受け、`<section hidden={!active} data-testid="schedule-pane">`。active の間、開いた時・60 秒ごと・表示の範囲を変えた時に `fetchSchedule`。
- 上の段: 金型 Tabs（開発／秘書。既定 秘書）、金型 Tabs（日／週／月。既定 日。localStorage のキー `ac.schedule.view` に覚える。読めない・書けないときは try/catch で日）、金型 Button「前へ」「今日」「次へ」（日は1日、週は7日、月は1か月）、Button「やることを足す」。
- 本体: 金型 `CalendarView`（`import { CalendarView, type CalendarViewEvent } from "@sa/components/CalendarView"`）。
  - 日: `mode="days" dayCount={2} date={先頭の日}`。週: `mode="days" dayCount={7} date={その週の月曜}`。月: `mode="month" date={その月の1日}`。`ariaLabel={t("ac.scheduleBoard.calendarLabel")}`。
  - events は `toCalendarEvents`（§6）で、選んでいる側（開発／秘書）の項目だけ。
  - renderEventContent: `<div className="ac-schedule__event" data-testid="schedule-event" data-item-id={id}>` の中に時刻・題名、重なりなら Badge（danger）「重なり」、終わったなら Badge（neutral）「終わった」。`.ac-schedule__event { height: 100%; }` など var() だけ。
  - onEventClick: 詳細の Modal（題名・日時・メモ、Button「終わった」（open のとき）／「開き直す」（done のとき）・「消す」）。消す前に確認の小窓は出さない（ブラウザの confirm は使わない。Modal の中で「消す」を押すと消す）。
  - onDayClick: 日表示に替え、その日を先頭にする。
- 右脇の欄「時刻の決まっていないこと」: date か start の無い項目（選んでいる側）。各行に Badge（種類）・題名・Button「終わった」「消す」。無ければ金型 EmptyState。
- 重なりの説明欄: 重なりが1つ以上あるとき、金型 Callout（warning）「時間が重なっています」と組の一覧（「〇〇 と △△」）。金型 Callout の variant は warning と info の2つだけ（salesanchor frontend/src/components/Callout.tsx:13）なので danger は使わない（第14回・実装役の NEEDS_DECISION を受けて直した）。赤い印は箱の赤枠（conflict）と Badge（danger）「重なり」で出す。
- 読めないとき: 金型 Callout（warning）で理由。前の中身は消さない。
- 足す小窓（ScheduleItemEditor）: 金型 Select（開発／秘書・種類）、TextField（題名・日付 type="date"・開始・終了。時刻は ReservationEditor.tsx:49 と同じ文字の欄と helperText）、Textarea（メモ）、TextField（返事待ちの相手。種類が返事待ちのときだけ）。送ったら閉じて取り直す。サーバーの 400 は Callout で出す。
- 新しい部品は作らない。生の input・select・button は使わない。色・寸法の直書きをしない。

## 6 純粋な関数（scheduleView.ts）
- `jstToday(now: Date): string` → 日本時間の "YYYY-MM-DD"（Intl.DateTimeFormat の timeZone "Asia/Tokyo"。server/routines.ts:60-64 jstSlot と同じ考え）。
- `viewRange(view, anchor)` → `{ first, from, to, dayCount }`。日: first＝anchor、to＝anchor＋1日。週: first＝anchor を含む週の月曜、to＝日曜。月: from＝月曜始まりの升目の最初の日、to＝最後の日（最大 42 日）。
- `findOverlaps(items)` → 重なる組の配列と id の集合。design §4-6: 同じ日・start のある open の項目だけ、[start, end) が少しでも重なれば重なり、end 無しは 30 分、端が接するだけは重なりでない、開発と秘書を合わせて数える（赤枠は選んでいる側に出る分だけ見える）。
- `toCalendarEvents(items, side, overlapIds)` → CalendarViewEvent[]。date と start のある項目だけ。start は `"YYYY-MM-DDTHH:mm:00"`（時差を付けない。画面の時刻としてそのまま置く）、end 無しは start＋30分。tone は todo＝personal・waiting＝shipping・deadline＝billing・done＝holiday。conflict は overlapIds に入っているとき。

## 7 文言（ja.json の ac.scheduleBoard、全部 t() で読む）
title「予定」、sideDev「開発」、sideSecretary「秘書」、viewDay「日」、viewWeek「週」、viewMonth「月」、prev「前へ」、today「今日」、next「次へ」、add「やることを足す」、calendarLabel「予定の時間割」、untimed「時刻の決まっていないこと」、untimedEmpty「時刻の決まっていないことはありません」、overlapTitle「時間が重なっています」、overlapPair「{{a}} と {{b}}」、overlapBadge「重なり」、doneBadge「終わった」、markDone「終わった」、reopen「開き直す」、remove「消す」、loadFailed「予定を読めませんでした」、saveFailed「保存できませんでした」、kind.todo「やること」、kind.waiting「返事待ち」、kind.deadline「締め切り」、field.side「どちら」、field.kind「種類」、field.title「題名」、field.date「日付」、field.start「開始」、field.end「終了」、field.timeHint「HH:mm（例: 09:00）。空なら時刻なし」、field.note「メモ」、field.waitingOn「返事待ちの相手」、save「足す」。
en.json は無い（agent-console は ja だけ。src/i18n.ts:19）。

## 8 試験
- 単体 schedule-items: 保存と読み直し・壊れたファイルと version 2 を上書きしない・存在しない日付（2026-02-30）と 25:00 は 400・end ≤ start は 400・open 300 件目の次は 400・1001 件で古い done から消える・done で doneAt が付き open で消える・無い id は 404。
- 単体 find-overlaps: 13:00〜14:15 と 14:00〜15:00 は重なり、14:00〜15:00 と 15:00〜16:00 は重ならない、end 無しは 30 分（10:00 と 10:20 は重なり、10:00 と 10:30 は重ならない）、done と日の違う項目は数えない、開発と秘書をまたいでも数える。
- 単体 schedule-view: jstToday（UTC 2026-11-04T15:00Z は 2026-11-05）、viewRange（水曜 2026-11-04 の週は 11/2〜11/8、2026-11 の月の升目は 10/26（月）〜12/6（日）の 42 日ちょうど。11/1 は日曜・11/30 は月曜のため6週になる）、toCalendarEvents（時刻なしは入らない・end 無しは＋30分・tone の対応・conflict）。
- 単体 schedule-http: 4つの道の成功と 400・404、`/api/schedule/preview` の既存の応答が変わらない。
- e2e schedule.spec.ts（`test.use({ timezoneId: "Asia/Tokyo" })`、`page.clock.setFixedTime(new Date("2026-11-04T09:00:00+09:00"))`。項目は API（POST /api/schedule/items）で作る。認証は file-link.spec.ts:13 の BEARER（Authorization に Bearer と E2E_TOKEN、Content-Type に application/json）と同じ物を headers に付けて `page.request.post` で送る。E2E_TOKEN は tests/fixtures/e2e-env から読む）:
  - K1: design §9 K1 (a)〜(d)。測る箱は `[data-testid=schedule-event]` の boundingBox。開発側に替えて開発の項目でも (a)(c)。
  - K1b: 11/2（月）・11/4（水）・11/5（木）の 14:00 を作る。週表示で x が 月 < 水 < 木。月表示で3つとも出る。月表示で 11/4 の日付（`getByTitle("2026年11月4日")`）を押すと日表示で 11/4 と 11/5 の2列になる（第15回: 金型の月の日付は href の無い a で link の役にならず、名前は title「2026年11月4日」だけのため、title で押す。FullCalendar の名前（fc- や data-navlink）は使わない）。title でも見つからなければ止まって報告する。
  - K4: 画面から足す→ブロックが出る→押して「終わった」→「終わった」の札→「消す」→消える。画面を読み直しても状態が残る。
  - K7b: 13:00〜14:15 と 14:00〜15:00 の箱の x の範囲が重ならず両方に「重なり」、16:00〜17:00 には無い。重なりの説明欄が出る。
  - FullCalendar のクラス名・属性（fc-*、data-date 等）を試験に書かない。
- 既存: `npm run typecheck`・`npm run lint`・`npm test`・e2e の既存の試験が緑のまま。Mac では回さない（CI に任せる）。

- 第15回の補足（実装役の2回目の報告を受けて）: SchedulePane の CalendarView には `key`（月か日か・列の数）を付けてよい。同じ部品のまま日から月へ替えると画面が落ちるため。金型は直さない。全体の `npm test` で今回触っていないファイルが赤くなったら、土台（origin/main 412717f）でも同じ試験が赤いかを確かめる。同じなら直さずに報告に書き、土台では緑なら止まって報告する。

- 第16回の補足（審査役の指摘を受けて）: e2e は schedule.spec.ts だけでなく `npm run test:e2e` の全体を回し、結果の数を報告する。土台 412717f で緑の e2e が赤になったら止まる。

## 9 受入（design §9 のうち便1の分）
K1・K1b・K4・K7・K7b・K9。CI の結果に schedule.spec.ts の行があること（K9）。

## 10 PR
- ブランチ release/schedule-board（設計書と同じ PR #92 に積む）。PR 本文に: §2 の点検結果の生の出力、触ったファイルの一覧（§1 と一致）、試験の数、戻し方。
- 終わりの返事は `DONE` / `BLOCKED: <理由>` / `NEEDS_DECISION: <問い>` のどれか1行で始める。
