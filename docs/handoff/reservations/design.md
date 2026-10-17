# 予約（日時を指定して1回だけ送る）— design

状態: 設計案（Opus 作成）。調査は recon.md（同じフォルダ）。PO 決定は recon.md「PO の依頼（原文）」。

## 1 目的
- 「予約」タブで、日付・時刻（日本時間）・役割・作業フォルダ・指示を登録すると、その日時に新しいセッションを1つ開いて指示を1回だけ送る。
- AI エージェントもコマンド（`node "<dataDir>/bin/ac-reserve.mjs" …`）で同じ予約を登録・一覧・取消できる。
- Mac が寝ていた・アプリが止まっていたときは、次に動いたとき1回だけ遅れて送り、「遅れて送信（N分）」と表示する（PO y）。

## 2 対象と対象外
- 対象: 予約の保存・時計・送信、HTTP API（画面用と AI 用）、AI 用コマンド、予約タブの画面、文言、試験、README・CHANGELOG・版。
- 対象外: 定期実行の動きの変更（送る処理を共通化するだけ。挙動・保存形式・試験の期待は変えない）、予約の編集（取り消して作り直す）、削除、繰り返し、通知、Sales Anchor 側の変更、導入（ac-update）は別手順（§11）。

## 3 変更の前後
| | 前 | 後 |
|---|---|---|
| 指定できるもの | 曜日＋時刻（毎週） | 加えて 日付＋時刻（1回） |
| 寝ていた回 | 送らない | 予約は起きたとき1回送る（定期実行は今のまま送らない） |
| AI からの登録 | できない | `ac-reserve.mjs` で登録・一覧・取消 |
| タブ | …部品・定期実行 | …部品・定期実行・予約 |

## 4 詳しい動き
### 4-1 保存（SSOT）
- 予約の正本は dataDir/reservations.json だけ。書き手はサーバー（`ReservationStore`）だけ。画面も AI 用コマンドも HTTP でサーバーに頼む（コマンドがファイルへ直接書くことは禁止＝書き手を1人にする）。
- 定期実行の routines.json には入れない。理由: 旧版（0.17.0〜0.19.0）は version 1/2 以外を読むと例外になる（`server/routines.ts:45`）ため、混ぜると切り戻し時に定期実行まで読めなくなる。別ファイルなら旧版は単に読まない。
- 書き方は `RoutineStore` と同じ（tmp＋rename、0600、dir 0700、serial、書く前に read し壊れた内容は上書きしない）。共通の関数 `writeJsonAtomic`/直列化を `server/json-store.ts` に切り出し、RoutineStore と ReservationStore の両方が使う（書き方の正本を1か所に）。RoutineStore の挙動は変えない。

### 4-2 予約の形（version 1）
```ts
type ReservationStatus = "pending" | "dispatching" | "done" | "cancelled";
type ReservationOutcome = RoutineOutcome | "interrupted"; // sent / not_ready / full / cwd_invalid / failed / interrupted
interface Reservation {
  id: string; name: string; roleId: string; cwd: string; branch?: string;
  runAt: number;            // 予定（epoch ms）
  runAtJst: string;         // "YYYY-MM-DDTHH:mm+09:00"（表示・照合用。runAt と同じ時刻）
  timeZone: "Asia/Tokyo"; promptText: string;
  createdBy: "ui" | "agent"; createdAt: number; updatedAt: number;
  status: ReservationStatus;
  startedAt?: number;       // 送信処理を始めた時刻
  lateMinutes?: number;     // startedAt - runAt が 60 秒を超えたときだけ、分（切り上げ）
  finishedAt?: number; outcome?: ReservationOutcome; sessionName?: string;
  purpose?: "measure"; measureNote?: string; // AI の予約だけが持つ（§4-9）
}
// ファイル: { "version": 1, "items": Reservation[] }
```
- 上限: pending は 50 件まで（超える登録は 400）。全体は 200 件まで。超えたら finishedAt（取消は updatedAt）が古い終了済みから消す。pending と dispatching は消さない。

### 4-3 登録の入力と検査
- 入力: `{ name, roleId, cwd, branch?, date: "YYYY-MM-DD", time: "HH:mm", promptText }`。date・time は日本時間として runAt に変換（`Date.UTC(y, m-1, d, hh-9, mm)`）。runAtJst は既存の `jstSlot(new Date(runAt)).key`（`server/routines.ts:50-54`）で作る（書式の再定義はしない）。存在しない日付（2/30 等）は、その key の年月日・時分が入力の date・time と一致しなければ 400。
- runAt は「今より 1 分以上先」かつ「366 日以内」。違えば 400。
- name・promptText・roleId・cwd・branch の検査は定期実行と同じ規則（`server/routines.ts:79-85`）。この検査を `validateLaunchTarget`（役割・cwd・branch）として共通関数に切り出し、定期実行と予約が同じ関数を使う。

### 4-4 時計と送信
- 起動の順番: `ReservationService.start(ready: Promise<unknown> = Promise.resolve())` の1形に固定。(1) store.list → (2) status "dispatching" のものを送らずに "done"・outcome "interrupted"・finishedAt にして save（送ったか不明なものを再送しない＝最大1回。この save に失敗したら console.error して tick を始めない）→ (3) `await ready` → (4) 1 秒ごとの tick を始める（`timer.unref()`）。index.ts は `const restored = startOpenSessionRestore(...).catch(log)`（今の `server/index.ts:95`、戻り値 `Promise<RestoreNotice[] | null>` `server/restore.ts:164-167`）を変数に受け、`void reservations.start(restored).catch(log)` とする。復元の成功・失敗・無効（AGENT_CONSOLE_RESTORE=off 等で即 null、`server/restore.ts:159`）に関わらず tick は始まる。shutdown（`server/index.ts:98-107`）で `routines.stop()` の隣に `reservations.stop()` を足す。復元を先にする理由: PO が使っていたセッションを先に戻し、予約が席（`sessions.hasCapacity()`、`server/sessions.ts:211,220`）を先に取って復元が失敗するのを防ぐ。予約は待つだけで消えない。起動時の読み込み（list と interrupted 化）が終わるまで、create・cancel・一覧API（listReady）は待つ（審査で見つかった、読み込み中の追加が消える穴の対処）。定期実行の起動（`server/index.ts:84`）は変えない。
- tick の対象は `status === "pending" && runAt <= now && (notBefore[id] ?? 0) <= now`。`notBefore` はメモリ上だけの Map（ファイルに書かない）。
- 1回の tick で選ぶのは runAt が最も古い1件だけ。次の1件を選んでよいのは「前の1件の startedAt + config.restoreStaggerMs」以降（復元と同じ間隔、既定 3000 `server/config.ts:34`、Config 必須項目 `:74`）。tick の時刻の比較はすべて `this.now()`（Date.now() は使わない。偽時計で試験するため）。launch.ts へ移す waitReady は今のまま Date.now()（`server/routines.ts:132-133`、既存の挙動を変えない）。何件も過ぎていても一斉には開かない。
- 1件の手順（`server/routines.ts:98-103` と同じ型）: (a) メモリ上で同期的に `status="dispatching"`・startedAt・lateMinutes を入れる → (b) `await store.save` → (c) 失敗なら同期的に pending に戻し startedAt・lateMinutes を消し、`notBefore[id] = now + 60_000`、console.error は1回 → (d) 成功なら `launchAndSend` を inflight に積む（待たない）。`settled()` は定期実行と同じ形。
- lateMinutes: `startedAt - runAt > 60_000` のときだけ `Math.floor((startedAt - runAt) / 60_000)`（61 秒〜119 秒の遅れは 1、120 秒で 2。実装中に式と例の食い違いが見つかり、例のほうに合わせて Opus が floor に決定 2026-10-14）。60 秒以内は付けない＝「送信済み」と表示。
- 送信は定期実行と同じ処理を使う: 今の `RoutineService.open`/`waitReady`/`isGone`（`server/routines.ts:114-140`）と `stamp`/`sessionNameFor`（`server/routines.ts:59-65`）を `server/launch.ts` に移し、`launchAndSend(deps: { config, sessions, hub, timing }, { roleId, name, slotKey, cwd, branch, promptText, stillWanted })` とする。定期実行・予約の両方が呼ぶ。`stillWanted` は送る直前の確認（定期実行は「有効のまま」＝今の `server/routines.ts:124`、予約は「status が dispatching のまま」）。セッション名は `sessionNameFor(name, runAtJst)`。予約は名前の先頭に「[予約] 」を付けて渡す（定期実行は付けない）。
- 終わったら status "done"・outcome・finishedAt・sessionName を保存。
- 遅れて送るのは pending かつ runAt を過ぎたもの（起動時・寝起き）。1件につき1回だけ。遅れの上限は設けない（PO y の言葉どおり）。

### 4-5 取消
- pending のものだけ取消できる（status "cancelled"、updatedAt）。dispatching 以降は 409。

### 4-6 HTTP API
- 画面用（今の `/api/*` 認証のまま）: `GET /api/reservations` → `{items}`（runAt 昇順）、`POST /api/reservations`（createdBy "ui"）→ 201、`POST /api/reservations/:id/cancel` → 200。
- AI 用（新）: `/api/agent/reservations`（GET・POST）と `/api/agent/reservations/:id/cancel`（POST）。createdBy は "agent"。
- 合言葉ファイル `dataDir/reserve-token`: 中身は `{"port": <config.port>, "token": "<64桁16進>"}`（0600、dir 0700、tmp＋rename）。書き手はサーバーだけ。起動のたびに port は今の config.port で書き直し、token は既存の正しい値があれば使い続ける（Chrome 拡張の `config.js` に `{port, token}` を書く型、`server/picker-extension.ts:93-95` と同じ）。作る条件は picker と同じ関数 `isPickerSetupEnabled`（`server/picker-extension.ts:38-39`、`AGENT_CONSOLE_PORT` が未設定か空のとき）を使う。安全の根拠は「書く先がそのサーバーの dataDir であること」: vitest の harness は env を見ず AppDeps で注入、e2e は一時 dataDir に作られ、本番 dataDir には触れない。作れなかったとき token は null。
- http.ts の位置と順序: `server/http.ts:384-387`（PICK_INGEST の分岐）の後、`:388`（`/api/` の Bearer 認証）の間に、`/^\/api\/agent\/reservations(\/[^/]+\/cancel)?$/` の完全一致だけを分岐する。順序は Host 検査（`:372`、済み）→ `Origin` ヘッダーがあれば 403 → token が null なら 401 → Bearer を定数時間比較（`server/picks-routes.ts:15-16` の `sameSecret` を共通の場所へ移して両方が使う）、不一致 401 → 本文（`readJsonBody`、64KiB `server/http.ts:31`）→ 処理。入力エラー 400 は今の仕組み（`server/http.ts:408-411`）に乗せる。この合言葉は他の /api では通らない（`auth.authenticate` は知らない）。
- AppDeps に `reserve: { token: string | null }` と `reservations: ReservationService` を足す。`tests/unit/helpers/harness.ts` に `reserve` の注入口を足す（picker の注入 `tests/unit/helpers/harness.ts:114-115` と同じ型）。

### 4-7 AI 用コマンド `hooks/ac-reserve.mjs`
- 配置は ac-board と同じ（起動時に `dataDir/bin/ac-reserve.mjs` へ copyAtomically、build で dist-server/hooks/ へ）。
- 使い方:
  - `node "<dataDir>/bin/ac-reserve.mjs" add < reservation.json`（入力は §4-3 の形に §4-9 の purpose・measureNote を加えたもの。成功で作られた予約の JSON を標準出力）
  - `… list`（JSON）／`… cancel <id>`
- dataDir は ac-board と同じ判定（コマンドの置き場所の1つ上 `path.resolve(here, "..")`、`hooks/ac-board.mjs:211-213,222`）。そこの `reserve-token` を読み、書かれた port の `http://127.0.0.1:<port>` へ送る。ポートの直書き・環境変数は使わない（ポートの正本はサーバーの config 1か所）。
- 試験用に `runCommand({ argv, stdinText, dataDir })` を export する（`hooks/ac-board.mjs:187` と同じ型）。
- 失敗は終了コード1と理由を stderr。合言葉の値は表示しない。標準入力 64KiB 上限。

### 4-8 画面（予約タブ）
- タブ順: チャット・端末・変更・PR・部品・定期実行・予約（`src/pages/ConsolePage.tsx:55,381-388,448`）。
- `src/components/Reservations/ReservationsPane.tsx`・`src/components/Reservations/ReservationEditor.tsx`・`src/components/Reservations/Reservations.css`。部品は `@sa/components/` の Badge・Button・Callout・EmptyState・Modal・Select・Stack・Textarea・TextField だけ（定期実行と同じ集合）。生の input/select/button は使わない。
- 入力欄: 名前 TextField、役割 Select、作業フォルダ TextField、ブランチ TextField、日付 `TextField type="date"`（金型が date を正式に持つ `.sa-cache/frontend/src/components/TextField.tsx:4`）、時刻 TextField 文字入力 HH:mm（定期実行と同じ。time 型は金型の正式一覧に無いため使わない）、指示 Textarea、新しいセッションの注意 Callout。
- 一覧: 「これから」（pending と dispatching、runAt 昇順）と「済み」（`finishedAt ?? updatedAt` の新しい順。§4-2 の削除順と同じ規則）の2つの見出し。各行: 名前、`YYYY/MM/DD HH:mm JST`、役割、登録元（画面／AI）、状態 Badge、pending には「取消」Button。
- 状態の文言: 待機中／送信中／送信済み／遅れて送信（{{minutes}}分）／取消／送れなかった（outcome ごと: 準備できず・満席・作業フォルダなし・失敗・中断）。
- CSS は SA トークンのみ（定期実行の Routines.css と同じ書き方）。色・大きさの直値なし。新しい --ac- トークンは作らない。
- 文言はすべて `src/locales/ja.json` の `ac.tabs.reservations` と `ac.reservations.*`。直書きなし。
- タブを開いたとき・10 秒ごと（タブが開いている間だけ）一覧を取り直す（AI が登録したものを表示するため）。useEffect で active のときだけ setInterval し、cleanup で clearInterval。

### 4-9 AI の予約は「測定」目的だけ（PO 決定 2026-10-14）
- PO 原文:「予約するのは今回のように実地で回してPDCAの成果を測る目的のみとする」。
- AI 用経路の登録入力には `purpose: "measure"` と `measureNote`（何を測るか、1〜200字、制御文字不可）が必須。purpose が "measure" 以外・欠落は 400。画面からの登録は purpose を持たない（人の予約は目的を制限しない。画面経路に purpose・measureNote が送られても無視して保存しない）。
- 保存形に `purpose?: "measure"; measureNote?: string` を足す（AI の予約だけが持つ）。
- AI の予約で pending のものは同時に 20 件まで（全体の 50 件の内数）。21 件目は 400（v0.43.0 で 10→20。PO 2026-10-18 y、docs/handoff/agent-pending-20/design.md）。
- 承認待ちは設けない（AI の予約も時刻どおり送る）。予約タブでは「AI・測定」と measureNote を表示し、いつでも取り消せる。
- README の ac-reserve の節に「使ってよいのは、変更の効果を実地で測る予約だけ（PO 決定 2026-10-14）」と書く。

## 5 代替案と選んだ理由
- A 予約を routines.json に入れる → 切り戻しで定期実行が壊れる（§4-1）。不採用。
- B AI 用コマンドがファイルへ直接書く（ac-board 方式）→ サーバーも状態を書くので書き手が2人になり上書き競合。不採用。
- C AI 用コマンドがサーバー秘密（keychain）で全 API を叩く → AI に全権（任意のセッションへの入力等）を渡す。不採用。
- 採用: 予約専用の合言葉で3経路だけ許す（Chrome 拡張の合言葉と同じ型、`server/picker-extension.ts`）。

## 6 リスクと対処
- 二重送信: 送る前に dispatching を保存、起動時の dispatching は interrupted（再送しない）。試験 R4・R6。
- 何日も寝ていた後に古い指示が動く: PO 決定（上限なし）。画面と sessionName で遅れが分かる。
- 合言葉の漏れ: 0600、表示しない、Origin 付き拒否、3経路だけ。
- 定期実行の退行: 共通化で挙動を変えない。既存 routines の試験をすべて無変更で通す。
- 起動直後に復元と予約が席を取り合う: 復元の完了を待ってから予約の tick を始め、1件ずつ3秒あけて送る（§4-4）。
- PR #35 と同じファイル（index.ts・ConsolePage.tsx・types.ts・ja.json・README・CHANGELOG・tests/unit/helpers/harness.ts）を触る: 後からマージする方が main を取り込んで解消。版は若い番号の PR を先に通す決まりにより #35 が v0.20.0、本件は v0.21.0。#35 が閉じられた場合は v0.20.0 に読み替える（マージ時に確認）。

## 7 受入条件
| 基準 | 検証方法 |
|---|---|
| R1 予約を登録してもセッションは開かない | 単体 |
| R2 runAt になった最初の tick で新しいセッションを1つ開き、括弧付き貼り付け→Enter で1回だけ送る。outcome sent・status done | 単体（偽時計） |
| R3 runAt を 10 分過ぎてから起動すると、復元の完了後に1回送り lateMinutes=10。遅れ 30 秒なら lateMinutes なし、90 秒なら 1 | 単体 |
| R3b 過ぎた予約が3件あると、runAt の古い順に1件ずつ、開始の間隔3秒以上で送る | 単体（偽時計、試験 cfg に restoreStaggerMs: 3000。R3 は start に手で解決する Promise を ready として渡す） |
| R4 dispatching の保存に失敗したら送らず pending に戻り、60 秒は再試行しない。起動時の interrupted の保存に失敗したら tick を始めない | 単体 |
| R5 送信直前に取消・status 変化があれば送らない | 単体 |
| R6 起動時に dispatching のものは送らず interrupted | 単体 |
| R7 過去・1分未満・366日超・存在しない日付・制御文字・不明な役割・cwd 不正は 400、pending 51 件目は 400 | 単体 |
| R8 pending 以外の取消は 409、未知 id は 400 | 単体 |
| R9 終了済みは 200 件を超えたら古い順に消え、pending は消えない | 単体 |
| R10 reservations.json が壊れていたら上書きしない／version 1 以外は読まない | 単体 |
| R11c AI 用経路は purpose "measure" と measureNote（1〜200字）が無いと 400、AI の pending 11 件目は 400、画面からの登録は purpose なしで通る | 単体（HTTP） |
| R11 AI 用経路: 正しい合言葉で add/list/cancel 可、合言葉なし・違い・token null は 401、Origin 付きは 403、この合言葉で /api/routines 等は 401 | 単体（HTTP、harness の reserve 注入） |
| R12 ac-reserve.mjs: add/list/cancel、失敗は終了コード1、合言葉を出力しない、reserve-token に書かれたポート以外へ送らない、reserve-token が無い・壊れていれば終了コード1 | 単体（runCommand、試験用 dataDir に harness のポートを書く） |
| R12b reserve-token は 0600 で `{port, token}`。2回起動しても token は同じで port は今の値 | 単体 |
| R13 定期実行の既存試験が無変更で全部通る | `npm test` |
| R14 タブ並びがチャット・端末・変更・PR・部品・定期実行・予約 | e2e（`tests/e2e/chat.spec.ts:85` を更新） |
| R15 画面で予約を作ると「これから」に出て、取消で「済み」に「取消」で出る | e2e（新 `tests/e2e/reservations.spec.ts`。予約日時は試験の実行日の翌日以降＝送信は起きない。`playwright.config.ts` の app project の testMatch に reservations を足し、CI の list 出力に reservations.spec.ts の試験名が出ることで実行を確認） |
| R16 lint（設計ガバナンス・日本語直書き）・typecheck・build が通り、新しい --ac- トークン・色直値がない。`grep -n "<input\|<select\|<button\|<textarea" src/components/Reservations/` が 0 件（ガバナンス検査は src/pages/ だけのため） | CI＋grep |
| R17 実機: 導入後、2分後の予約を画面と ac-reserve.mjs で1件ずつ作り、時刻に新しいセッションが開いて指示が届く | PO または Opus が目視（導入後） |

## 8 実装の約束（Sonnet 向け）
- 作業場所: `~/agent-console-wt/reservations`（branch release/reservations、origin/main f255892 起点）。他の worktree は触らない。
- 触るファイル: server/json-store.ts（新）、server/launch.ts（新）、server/reservations.ts（新）、server/reserve-token.ts（新。picker-token は生の16進1行 `server/picker-extension.ts:59` で形が違うため、共通化してよいのは tmp＋rename の書き方だけ。その場合は server/picker-extension.ts も触る）、server/routines.ts（共通関数へ置き換えのみ）、server/http.ts、server/index.ts、server/activity-setup.ts（コマンドの配置）、scripts/copy-board-command.mjs（ac-reserve も写す）、hooks/ac-reserve.mjs（新）・hooks/ac-reserve.d.mts（新）、src/api.ts、src/types.ts、src/pages/ConsolePage.tsx、src/components/Reservations/*（新）、src/locales/ja.json、server/picks-routes.ts（sameSecret を共通の場所へ移すだけ）、tests/unit/reservations.test.ts（新）・tests/unit/ac-reserve.test.ts（新）・tests/unit/helpers/harness.ts、tests/e2e/chat.spec.ts、tests/e2e/console.spec.ts（タブ数 6→7・dataDir の一覧に reserve-token、実装中に追加）、src/pages/ConsolePage.test.tsx（タブ数・並び、実装中に追加）、tests/e2e/reservations.spec.ts（新）、playwright.config.ts（testMatch）、README.md、docs/CHANGELOG.md、package.json・package-lock.json・extension/manifest.json（版 0.21.0）。
- 共通化で定期実行を壊さない条件: 既存試験が名前で触る private メンバー `routines`・`validate`・`now`（`tests/unit/routines.test.ts:54,199,208,209,217`）は名前と役割を残す。`RoutineService.validate(input)` は残してその中から共通関数 `validateLaunchTarget` を呼び、create/update は `this.validate` を呼び続ける。`RoutineStore` の `save`/`list` の名前、`RoutineService` のコンストラクタ引数（config, sessions, hub, store, now, timing）と `start/stop/list/tick/settled/create/update/setEnabled` の公開形は変えない（`tests/unit/routines.test.ts:34,52-57` がこれに依存）。launch.ts は sessions・hub・config・timing を引数で受け、RoutineService は自分の持ち物を渡すだけ。`tests/unit/routines.test.ts` は1行も変えずに通すこと。
- 触らない: routines の保存形式・試験の期待値、hooks/ac-board.mjs の動き、.github/workflows、Sales Anchor リポジトリ、dataDir の実ファイル、導入済みアプリ。
- 迷ったら・この設計で決まっていないことに当たったら、推測で決めずに止まって「NEEDS_DECISION: 内容」で報告。フックに止められたら言い換えず「BLOCKED: 理由」。
- 完了の報告に、npm run typecheck / lint / test / build / test:e2e の結果（生出力は /tmp/CC報告ファイル/agent-console-reservation/impl/ に保存）を付ける。

## 9 導入と戻し方
- 導入: マージ・タグ後、既存の手順（全セッションが入力待ちのときに ac-update を実行する予約 update-when-idle.sh）で行う。導入は本 PR の範囲外で、実施時に改めて状態を確認する。
- 戻し方: 前の版へ ac-update（切り戻し）。reservations.json と reserve-token は旧版が読まないだけで残る（害なし）。定期実行の routines.json は変えていないのでそのまま動く。

## 10 維持の仕組み
- 単体試験 R1〜R13 と e2e R14・R15 が CI（ubuntu・macOS）で毎回動く。
- 予約の書き方・送り方は共通関数（json-store・launch）1か所。定期実行と予約のどちらを直しても両方の試験が動く。
- README に予約と ac-reserve の使い方、CHANGELOG に 1 行。
- 守り手: CI（ubuntu・macOS の vitest・Playwright）と、設計ガバナンス検査（scripts/check-design-governance.mjs、lint の中で動く）。

## 外部・過去事例の参照と我々への応用
- 外部事例は使わない。理由: 必要な判断（取りこぼしの扱い・書き手を1人にする・狭い合言葉）は、このリポジトリの既存の実装（定期実行 v0.7.0/v0.18.0 の lastSlot、Chrome 拡張の合言葉 v0.6.0）で根拠が足りる。
- 応用した過去事例: v0.18.0（毎回新しいセッションで送る）、v0.6.0（狭い合言葉の受け取り口）、v0.12.0（bin へのコマンド配置）。

## 審査
- 第1回（Fable, 2026-10-14）: REVISE。指摘10件（e2e が testMatch に拾われない／コマンドのポートの正本／合言葉を作る条件の記述／tick と保存の順序・起動順／起動直後の復元との席の取り合い／http.ts での位置と順序／#35 との衝突に harness.ts／runAtJst・セッション名を既存関数へ／共通化で既存試験を壊さない条件／軽微3件）。すべて本文に反映済み。
- 審査が挙げた事業判断3件のうち、「復元を先にする」「1件ずつ3秒あける」は既存の動き（復元の間隔）に合わせて Opus が技術判断で決めた（§4-4）。
- PO 判断（2026-10-14 原文）:「予約するのは今回のように実地で回してPDCAの成果を測る目的のみとする」。→ §4-9 に反映（AI の予約は「測定」目的に限り、承認なしで送る）。
- 第2回（Fable, 2026-10-14）: REVISE。第1回の10件は反映済みと確認。残り4件（既存試験が触る private 名 routines/validate/now を残す／start(ready) の1形・復元の成否に関わらず tick 開始・shutdown に stop／間隔は startedAt+restoreStaggerMs を this.now() で比較／型ブロックへ purpose 追記・行参照の訂正・picker-token と形が違う点）を本文に反映済み。AI の pending 10 件・measureNote 1〜200 字は Opus の技術判断。
- PO 決定（2026-10-14）: 「測る目的のみ」を画面からの予約にも適用するか → 「n」。測定に限るのは AI の予約だけ（§4-9 のまま）。
- 第3回（Fable, 2026-10-14）: APPROVE（条件付き: A 送信中は「これから」に表示 B 「済み」は finishedAt ?? updatedAt 順 C ac-reserve の入力に purpose・measureNote）。A〜C と軽微（waitReady は Date.now のまま・行参照訂正・画面経路の purpose は無視）を反映済み。再審査不要との判定。
