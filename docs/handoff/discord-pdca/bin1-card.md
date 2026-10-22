# 実装カード: discord-pdca 便1 — 1時間の関門・予約の監査記録・ac-reserve の許可の一覧・「予約で選べない」役割（v0.44.0）

設計: [design.md](design.md)（第13版。§2 K5・K6、§4-3、§4-5 の「サーバー側で塞ぐもの」、§8 の便1）。根拠: [recon.md](recon.md)。
PO 承認: 2026-10-21「1」（この設計で進める）、2026-10-21「1」（§14-2: 60分未満・画面には関門をかけない）、2026-10-22「1」（便1 の指示書を作り、作る係に渡して作らせてよい）。
作業場所: `/Users/tanizawashingo/agent-console-wt/discord-pdca-bin1`（ブランチ `release/discord-pdca-bin1`、このカードが入った origin/main 起点）。

## 守ること
- 触ってよいのは §変更 のファイルだけ。`src/components/Routines/`・ほかの hooks・`scripts/`・`agent-console.config.json`・`.github/` は触らない
- cd を使わない（`git -C`・`npm --prefix` 等で絶対パス指定）
- Bash の命令に `Application Support/agent-console` の文字列を書かない。`pkill` `killall` `kill` `launchctl` を実行しない。導入（ac-update・install）しない。本番の dataDir を読まない・書かない
- 画面の文字は t() と `src/locales/ja.json` だけ。部品は `@sa/components/*` の金型。色や寸法の直値を書かない（今回の画面の変更は選択肢を絞るだけなので、新しい文字・部品は出ない見込み。出そうなら NEEDS_DECISION:）
- 迷ったら全停止して `NEEDS_DECISION:`。報告は DONE / BLOCKED: / NEEDS_DECISION: で始め、生出力の保存パスを添える。試験を通すために試験の期待値を変えない

## 変更

### 1. `server/schedule-gate.ts`（新規）
- `export class ScheduleConflictError extends SessionInputError {}`（http.ts:619 の決まりで 400 になる）
- `export class ScheduleGate`:
  - `private readonly serial = createSerial()`（`./json-store.ts`）。`run<T>(fn: () => Promise<T>): Promise<T>` はこの順番待ちで fn を1つずつ動かす
  - `attach(sources: { reservations: () => readonly Reservation[]; reservationsReady: () => boolean; routines: () => readonly Routine[] })` で比べる相手を受け取る（配線で両方を作ったあとに1回呼ぶ）。attach 前に check が呼ばれたら Error を投げる
  - `reservationsReady()` が false（予約の読み込みが終わっていない・読めなかった）のときは、比べずに `ScheduleConflictError("schedule conflict: 予約の一覧をまだ読めていないため確かめられません（起動直後なら数秒待って再試行。続くなら PO に報告）")` を投げる（重なりを見ずに通さない。全員拒否に倒す。PR #70 の審査 L-c）
  - `checkReservation(runAt: number, nowMs: number, name: string): void` と `checkRoutine(candidate: { id?: string; name: string; weekdays: number[]; timeHHmm: string }, nowMs: number): void`。ぶつかれば `ScheduleConflictError` を投げる
- 比べ方（design §4-3）:
  - 相手は、`status === "pending"` の予約全部（画面・AI どちらが作ったものも）と、`enabled === true` の定期実行全部。定期実行の変更・切り替えでは自分の id を外す
  - 窓は `[nowMs, nowMs + 366日]`。定期実行の開始は、窓の中の日本時間の各日のうち曜日が合う日の `timeHHmm`（日本時間は固定で UTC+9。`routines.ts` の `jstSlot` と同じ曜日の数え方: 0=日曜）
  - 候補の開始のどれかと相手の開始のどれかの差の絶対値が `60 * 60_000` 未満ならぶつかり。ちょうど60分は通す。日付をまたぐ差も同じ式で数える
  - 候補が定期実行のときは、候補の開始も窓の中で同じように作る
- 拒むときの文（1行・日本語。ac-reserve / ac-routine がそのまま出す）:
  `schedule conflict: 「<相手の名前>」（<予約|定期実行> <時刻>）と開始が60分未満です。空いている近い時刻: 前 <時刻|なし> ／ 後 <時刻|なし>`
  - 相手の時刻は、ぶつかった回の `YYYY-MM-DDTHH:mm+09:00`（相手が定期実行でも、ぶつかった回の日時）。近い時刻は、予約の候補なら `YYYY-MM-DDTHH:mm+09:00`、定期実行の候補なら `HH:mm`
  - 近い時刻: 予約は候補から1分刻みで前後に最大24時間探し、ぶつからない最初の時刻。前は `nowMs + 60_000` より前にしない。定期実行は同じ曜日のまま `HH:mm` を1分刻みで前後に最大24時間（日付をまたいだら曜日も1日ずれる扱いにせず、`HH:mm` が 00:00〜23:59 の中だけで探す）。見つからなければ「なし」
  - ぶつかった相手が複数なら、開始が候補に一番近いもの1つを書く
- 先頭コメントに「1時間の関門（設計 docs/handoff/discord-pdca/design.md §4-3）。予約と定期実行の作成・変更を1本の順番待ちで並べ、AI のものだけ開始の差が60分未満を拒む」

### 2. `server/routine-audit.ts`
- `RoutineAuditAction` に `"reserveCreate" | "reserveCancel" | "reserveDispatch"` を足す（:11 のコメントにも1語ずつ足す）
- `RoutineAuditEntry` に `reservationId?: string`（コメント「予約の行だけ」）と `targetRoleId?: string`（コメント「reserveDispatch: 予約が開く役割。roleId は呼び出し元の役割」）を足す。`targetCreatedBy` のコメントに「予約の行では予約の createdBy」を足す
- `append` は変えない

### 3. `server/reservations.ts`
- 型 `ReservationAuditSink = (entry: Omit<RoutineAuditEntry, "at">) => Promise<void>`（書けなければ reject）を export
- コンストラクタの最後に省ける引数 `deps: { gate?: ScheduleGate; audit?: ReservationAuditSink } = {}` を足す（今の試験の呼び方 tests/unit/reservations.test.ts:43 等をそのまま通すため）。無ければ、gate は「並べるだけで比べない」もの、audit は何もしないもの。本番の配線（§6）と試験の harness（§11）は必ず両方渡す
- `create(input, createdBy, caller?: { callerSessionId: string | null; roleId?: string })`:
  - `await this.loaded`・形の検査（:168-174・:176-181）・`validateLaunchTarget`（:174）は `gate.run` の**外**で先に済ませる（予約の読み込みが壊れて `loaded` が解決しないとき、定期実行の操作まで止めないため）。`gate.run(...)` の中では、役割の検査・上限の検査（:182-184）・関門・監査・保存だけを行う
  - 役割の検査を足す: `this.config.roles` に `roleId` が無い、または `reservable === false` なら `SessionInputError("reservation role is not reservable")`（未知の役割の扱いが validateLaunchTarget で先に 400 になるなら、その順のままでよい）
  - `createdBy === "agent"` のときだけ `gate.checkReservation(runAt, nowMs, text.name)`
  - 役割の拒否・関門の拒否・上限の拒否（:183-184）は、監査に `{ action: "reserveCreate", outcome: "denied", error: err.message, targetCreatedBy: createdBy, callerSessionId, roleId }` を書いてから投げる（書けなければそのまま投げる）。日付・時刻・本文の形の誤り（:168-174・:177-179）は書かない
  - 通ったら、監査に `{ action: "reserveCreate", outcome: "ok", reservationId, targetCreatedBy: createdBy, callerSessionId, roleId }` を書く → 失敗したらそのまま投げる（items を変えない）→ 今の保存（:190-192）。保存に失敗したら、監査に `outcome: "denied", error: "save failed"` を書き足し（失敗は console.error だけ）、今の戻しをして投げる
- 取消と開始は「メモリの状態を先に同期で確保する → 監査 → 保存」の順にする（判定と書き換えの間に待ちを入れない。取消と開始が同時に来ても、先に状態を書き換えた方だけが進む。今の :201-203・:216-218 が同期なのと同じ）
- `cancel(id, caller?)`: `await this.loaded` は外。`gate.run` の中で、:199-201 の検査のあと、すぐに（待たずに）:202-203 の取消の書き換えを入れる → 監査に `reserveCancel` `ok`（`reservationId`・`targetCreatedBy` は予約の createdBy）→ 書けなければ `current` に戻して投げる → 保存。保存の失敗は今の戻し（:204）に加え、監査に `outcome: "denied", error: "save failed"` を書き足す（失敗は console.error だけ）
- `tick`: :216-218 の送信中の書き換えと `lastStartedAt` は今のまま同期で入れる → 監査に `{ action: "reserveDispatch", outcome: "ok", reservationId, targetCreatedBy, callerSessionId: null, targetRoleId: picked.roleId }` を書く（`roleId` 欄は呼び出し元の役割の意味なので使わない。§2）→ 失敗したら :220-221 と同じく `picked` に戻して `notBefore` を付け、console.error、return → 送信中の保存（:219）。保存に失敗したら、今の戻しに加え監査に `outcome: "denied", error: "save failed"` を書き足す（失敗は console.error だけ）
- 試験に足す（§11）: 開始の監査を待っている間に取消が来たら取消は 409 になり、予約は1回だけ開く／取消の監査を待っている間に tick が来ても、その予約は開かない
- `isLoaded(): boolean` を足す。`markLoaded()` を呼んだときに true にする（`preloaded = true` の :135 も、送信中の保存に失敗した :148 の道も、:150 も true）。`store.list()`（:143）が例外を投げて `markLoaded()` が呼ばれないときだけ false のまま
- :125 のコメントや README の「メモリだけ」は notBefore のことなので変えない

### 4. `server/routines.ts`
- コンストラクタの最後に省ける引数 `gate?: ScheduleGate`（無ければ並べるだけで比べないもの）
- `create`・`update`・`setEnabled` を、いまの `exclusive(...)` の**外側**で `gate.run(...)` に包む（gate.run → exclusive → 本体。逆にしない。gate.run の中から gate.run を呼ばない）
- AI 用の呼び出し（`create` の `createdBy === "agent"`、`update`・`setEnabled` の `agent === true`）で、結果が有効になるときだけ、保存の前に `gate.checkRoutine({ id（変更・切り替えのとき）, name, weekdays, timeHHmm }, Date.now())`。無効にする操作・結果が無効のものは比べない。上限の検査（assertAgentRoom）の後に置く
- `tick`・`dispatch` は変えない

### 5. `server/config.ts`
- `RoleConfig` に `reservable?: boolean`（コメント「false なら予約で選べない。画面の選択肢から外し、予約の入口で 400。省くと true」）
- `parseRole`（:137-158）: `r.reservable` が undefined でなく boolean でもなければ `config: roles[${index}].reservable must be boolean`。`false` のときだけ `reservable: false` を持たせる
- `Config` に `reserveRoles: string[]`（コメント「ac-reserve（AI による予約）を使ってよい役割の id（SSOT）。既定 ["opus-designer","shell"]。roles に無い id は起動時エラー」）
- `DEFAULT_RESERVE_ROLES = ["opus-designer","shell"]` と `parseReserveRoles`（:324-331 の `parseRoutineManagerRoles` と同じ形・同じ文言の型で `reserveRoles`）。呼ぶ場所は routineManagerRoles と並べる

### 6. `server/index.ts`
- :76-77 の前に `const gate = new ScheduleGate()` を作り、`RoutineService(…, undefined, undefined, gate)` と `ReservationService(…, undefined, undefined, false, { gate, audit })` に渡す。`audit` は :88 の `routineAudit` を使う（`(entry) => routineAudit.append({ at: new Date().toISOString(), ...entry })`）。そのため :88 の作成を :76 より前に移す
- 両方を作ったあとで `gate.attach({ reservations: () => reservations.list(), reservationsReady: () => reservations.isLoaded(), routines: () => routines.list() })`。`isLoaded()` は §3

### 7. `server/http.ts`
- :153 の役割の受け渡しに `reservable: r.reservable !== false` を足す
- :196 の画面の予約の作成は `create(…, "ui", { callerSessionId: null })`、:198 の取消は `cancel(id, { callerSessionId: null })`
- `handleAgentReservations`（:364-375）: 合言葉の検査のあと、本文（POST）か `callerSessionId` の検索語（GET）から名乗りを取り（`isClaudeSessionId` で形を見る。ac-routine の :435-436 と同じ）、新しい `checkReserveCaller`（:402-408 の `checkRoutineCaller` と同じ形で `config.reserveRoles` を見る。共通の関数にまとめてよい）で照合する。通らなければ、作成・取消なら監査に `reserveCreate`/`reserveCancel` `denied` `error: "forbidden: caller is not a reserve role session"` を書き（書けなくても 403 は返す）、403 `{ error: "ac-reserve is limited to reserve role sessions (起動直後は数秒〜数十秒待って再試行)" }`。通ったら本文から `callerSessionId` を外して `create(body, "agent", { callerSessionId, roleId })`・`cancel(id, { callerSessionId, roleId })`
- `handleAgentRoutines` の :492 の `RoutineLimitError` の条件に `|| err instanceof ScheduleConflictError` を足す（関門の拒否も `denied` で残す）

### 8. `hooks/ac-reserve.mjs` と `hooks/ac-reserve.d.mts`
- `runCommand` に `callerSessionId` を受け取らせる（ac-routine.mjs の形）。add は標準入力の JSON がオブジェクトでなければ拒み（ac-routine.mjs:68 と同じ文）、 `callerSessionId` を消してから、環境変数の名乗りを足して送る。list は `?callerSessionId=`、cancel は本文 `{ callerSessionId }`。名乗りが無ければ付けない（サーバーが 403）
- isMain で `callerSessionId: process.env.CLAUDE_CODE_SESSION_ID` を渡す（ac-routine.mjs:111 と同じ）
- `.d.mts` の型に `callerSessionId?: string` を足す

### 9. `src/types.ts` と `src/components/Reservations/ReservationEditor.tsx`
- `RoleView`（:27-31）に `reservable?: boolean`（コメント「false なら予約で選べない。省くと選べる」。省ける形にして、型付きの見本を持つ今の試験5つを直さずに通す。PR #70 の審査 M-c）
- ReservationEditor: 選択肢と既定（:18・:41）を `roles.filter((r) => r.reservable !== false)` から作る。RoutineEditor は触らない（便2 で決める）

### 10. 版・文書
- `package.json`・`package-lock.json`（2 か所）・`extension/manifest.json` を 0.44.0
- `docs/CHANGELOG.md` 先頭に 0.44.0 の 1 行（AI の予約・定期実行に1時間の関門／予約の作成・取消・開始を監査記録へ／ac-reserve は呼び出し元の役割で絞る（`reserveRoles`）／役割の `reservable: false`／戻し方 `bash scripts/ac-update.sh v0.43.0`／設計パス）
- `README.md`: AI の命令の節（:23-34 付近の ac-reserve）に「呼び出し元の役割が `reserveRoles` に無ければ 403」「AI の予約は、ほかの予約・定期実行と開始が60分未満なら拒まれ、空いている近い時刻が示される」。予約の節（:11 付近）に監査記録の1行。定期実行（AI）の節に関門の1行。設定の説明に `reserveRoles` と `reservable`

### 11. テスト（`tests/unit/`）
- `tests/unit/helpers/harness.ts:225-226`: 本番と同じく、定期実行（:225）と予約（:226）の両方に同じ gate を渡し、予約には audit も渡し（routineAudit は harness の dataDir のもの）、両方を作ったあとで本番と同じ形で `gate.attach` を呼ぶ
- `reservations.test.ts` に `isLoaded` を2本: `preloaded = true` なら作った直後から true／`store.list()` が投げる偽の置き場で `start()` したら false のまま
- 新規 `schedule-gate.test.ts`（K5）: 予約どうし 59分は拒否・60分は通る／予約と定期実行で日付またぎ（23:30 と翌 00:10 で拒否、23:30 と 00:30 で通る）／定期実行の変更で自分自身とは比べない／無効の定期実行・pending でない予約とは比べない／拒否の文に相手の名前・時刻・前後の近い時刻が入る／近い時刻が無いとき「なし」
- `reservations.test.ts`: AI の作成が2つ同時に来て、どちらも同じ時刻なら1つだけ通る（`Promise.allSettled` で片方が ScheduleConflictError）／画面の作成は重なっても通る／`reservable: false` の役割は画面・AI とも 400／K6: 作成・取消・開始で `reserveCreate`・`reserveCancel`・`reserveDispatch` が1件ずつ／監査が reject する sink で作成・取消は失敗し、予約が増えない・取消されない／開始は監査の失敗で送信中にならず、60秒後の tick で送られる／競合（H-1）: 監査の書き手を「外から終わらせられる約束」を返す形にして止めておき、開始の監査を待っている間に取消を呼ぶと取消は 409 で、予約は1回だけ開く／取消の監査を待っている間に tick を進めても、その予約は開かない
- `schedule-gate.test.ts` にもう1本: `reservationsReady` が false の間は、予約・定期実行の検査がどちらも拒まれる
- `routines.test.ts`: AI の追加・変更・有効化が予約と60分未満なら拒否、無効化は通る、画面の追加は通る
- `ac-reserve.test.ts`: 名乗りを送る（add の標準入力の `callerSessionId` は上書きされる・list の検索語・cancel の本文）／harness で、`reserveRoles` に無い役割・名乗り無しは 403 で監査に `denied`、ある役割は通る
- `config.test.ts`: `reservable` の型の誤り・`reserveRoles` の未知の id・既定の絞り込み
- `src/components/Reservations/ReservationEditor.test.tsx`: `reservable: false` の役割が選択肢に出ず、既定にもならないことを1本（今の試験の役割の見本は直さない）

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin1/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/schedule-gate.test.ts tests/unit/reservations.test.ts tests/unit/routines.test.ts tests/unit/ac-reserve.test.ts tests/unit/ac-routine.test.ts tests/unit/config.test.ts`  4. `npm test`
5. `git diff --stat origin/main...HEAD` が §変更 のファイルと、想定分岐の「入力だけを直す」で直した試験ファイル（報告に列挙したもの）だけ
6. 実物の拒否（K5 の「実物で各1回」）: harness か試験用のポートで立てたサーバーに、実物の `hooks/ac-reserve.mjs` と `hooks/ac-routine.mjs` を試験用の dataDir（/tmp 配下）から呼び、60分未満で拒否の文が出ることを各1回。本番のサーバー・本番の dataDir は使わない。試験の形で書けたら vitest に入れてよい
7. コミット `feat: AI の予約・定期実行に1時間の関門と予約の監査記録を足す（v0.44.0）`（末尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）して push。PR は作らない

## 想定分岐
- 既存の試験が、gate.run で並べたことで待ち合わせが変わって落ちたら、実装の並べ方を直す（試験の期待値は変えない）。直せなければ NEEDS_DECISION:
- `validateLaunchTarget` が未知の役割を先に拒むなら、`reservable` の検査はその後でよい。順番で答えの文が変わり既存の試験が落ちるなら NEEDS_DECISION:
- 366日の展開が試験で遅い（1件の検査が 50ms を超える）なら、展開をやめて「曜日と時刻の差」で同じ結果を出す計算に替えてよい（同じ試験がすべて通ること）
- 監査の sink を予約に渡すと、http.ts の `auditOf`（:390-394）と別の書き手が同じファイルに書くことになる。今の定期実行の自動クローズ（index.ts:88）も同じ形なので、そのままでよい。行が混ざる試験の失敗が出たら BLOCKED:
- `npm test` で今回のファイル以外が落ちたら、その試験名と出力を添えて BLOCKED:（たまに落ちる macOS の pc-meter.spec.ts:125 は e2e なので対象外）
- 監査に書けずに元の状態へ戻すまでの間に、別の予約の保存（開始の監査を待つ間は 作成 :192・取消 :204・開始 :219・送り終わり :241、取消の監査を待つ間は 開始 :219・送り終わり :241）がメモリの全件をファイルへ書くと、ファイルにだけ途中の状態（取消済み・送信中）が一時的に残る。今の「保存に失敗したら戻す」（:203-204・:217-220）と同じ形の隙間で、次の保存で直る。直さなくてよい（試験も足さない。PR #70 の審査 L-b）
- 今ある試験のうち、新しい決まり（関門・名乗りの照合）にぶつかる入力のものは、**入力だけ**を直す。期待値（成功・件数・上限の 400）は変えない（PR #70 の審査 M-b）:
  - 同じ時刻で何件も作る試験（ac-routine.test.ts:149-153・:172、ac-hardening.test.ts:290-294、reservations.test.ts:317-319）は、入力の時刻を1件ごとに60分以上ずらす
  - 名乗りなしで AI の予約を作る試験（reservations.test.ts:294-301・:312-316・:317-319・:372、ac-reserve.test.ts:27-36・:41-43）は、`reserveRoles` に入っている役割のセッションの名乗りを送る形にする
  - harness に `reserveRoles?: string[]` の option を足し、既定は `["echo"]`（:139・:204 の `routineManagerRoles` と同じ形）。`parseReserveRoles` も `parseRoutineManagerRoles`（config.ts:324-331）と同じく、明示が無ければ既定のうち roles に実在するものだけを使う（無ければ空＝全員 403。起動は止めない）
  - 上のほかにも同じ理由で落ちる試験があれば、同じく入力だけを直し、直した試験名と理由を報告に列挙する。期待値を変えないと直せないものは NEEDS_DECISION:
- 定期実行の窓の中に既に重なっている相手（導入前からの重なり）があって AI の変更が拒まれる試験が書けない場合は、試験の中の相手の時刻をずらす（本番の重なりは導入のときに Opus が一覧にして直す。design §4-3）
