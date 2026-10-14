# recon: AI が画面なしで定期実行(routines)を登録・一覧・変更・有効/無効化する設計の材料

> 写し元: /tmp/CC報告ファイル/ac-routine-cli/recon.md。調査時の基準は origin/main 0a8266c（v0.21.0）。実装時は 6277505（0.24.0）で、routines.ts（:22 以降 +1 行）・launch.ts（:42 以降 +2 行）に差分がある。ほかの行番号は design.md の注記のとおり 658de91 基準。


基準: `~/agent-console` の origin/main = 0a8266c74a610fbd37387d5b6dbc86e28f776c5c（package.json version 0.21.0）。ローカル作業ツリーは origin/main より79コミット遅れていたため、すべて `git show origin/main:<path>` で読んだ。以下の `file:line` はそのときの行番号。
生の取得物: `/tmp/CC報告ファイル/ac-routine-cli/recon-raw/`（`<パス の / を _ にした名前>.txt` が行番号付き全文、`pr36.json` が PR #36 の変更ファイル、`roles.txt` が役割設定）。
導入先 = `/Users/tanizawashingo/Library/Application Support/agent-console/`（以下 `$DD`）。

## 1. 既存の AI 用 CLI の仕組み

【事実】置き場所
- リポジトリ内の正本: `hooks/ac-board.mjs`, `hooks/ac-reserve.mjs`, `hooks/ac-statusline.mjs`（+ `.d.mts`）。ビルド時に `scripts/copy-board-command.mjs:9` `for (const name of ["ac-board.mjs", "ac-reserve.mjs", "ac-statusline.mjs"]) {` で `dist-server/hooks/` へ写す。
- 導入先: サーバー起動時に `server/activity-setup.ts:53-54` `installReserveCommand` / `:43-44` `installBoardCommand` が `dataDir/bin/` へ原子的コピー（`:25-29` tmp→chmod→rename）。呼び出しは `server/activity-start.ts:42` `if (isActivitySetupEnabled(opts.env)) {` の中（`:49` board, `:54` reserve）。`server/activity-setup.ts:14-15` `env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === ""` のとき（=本番ポート起動のみ）。
- 導入先 `$DD/bin/` の ls -la（実測）:
  - `drwx------ bin`
  - `-rw------- 12482 10月 14 12:03 ac-board.mjs`
  - `-rw------- 5500 10月 14 12:03 ac-reserve.mjs`
  - `-rw------- 6825 10月 14 12:03 ac-statusline.mjs`
  - `current -> versions/v0.21.0`。導入先の `bin/ac-reserve.mjs` は origin/main の `hooks/ac-reserve.mjs` と diff 差分なし（実測 `same-reserve`）。
  - 実行ビットは無い（`node "<path>"` で呼ぶ前提）。

【事実】認証と書き込み方式（2つの CLI で方式が違う）
- ac-board: HTTP を使わず**ファイルへ直接書く**。`hooks/ac-board.mjs:3` 「書くのは dataDir/boards/<番号>.json の 1 か所だけ」、`:11` `BOARDS_DIR_NAME = "boards"`、`:16-17` `FILE_MODE = 0o600` / `DIR_MODE = 0o700`、`:142` `renameSync(tmp, file)`。認証は無い（ファイル権限のみ）。呼び出し元の識別は `:191` `const sessionId = env.CLAUDE_CODE_SESSION_ID;`（`:192` UUID形でなければ拒否）。副命令は `write` のみ（`:190`）。
- ac-reserve: **HTTP でサーバーへ頼む**。`hooks/ac-reserve.mjs:3` 「この命令はファイルへ書かず、サーバーの HTTP（/api/agent/reservations）に頼む」。
  - 宛先とトークン: `:22` `readFileSync(path.join(dataDir, RESERVE_TOKEN_FILE_NAME), "utf8")`、`:26` port 1〜65535 整数 + token `/^[0-9a-f]{64}$/`（`:12`）。`:32-34` `fetch(\`http://127.0.0.1:${access.port}${pathname}\`, … Authorization: \`Bearer ${access.token}\``。
  - トークンファイル: `$DD/reserve-token`（実測 `-rw------- 98 bytes 10月 14 12:03`）。形 `{port, token}`。
  - 発行元: `server/reserve-token.ts:28-38` `setupReserveToken`。`:29` `if (!isPickerSetupEnabled(opts.env)) return { token: null };`（本番ポート以外では作らず、受け口は常に401）。`:32` `(await readExistingToken(file)) ?? randomBytes(TOKEN_BYTES).toString("hex")`（既存の正しい値は使い続け、port は起動のたび更新）、`:33` `writeJsonAtomic(file, { port: opts.port, token })`。`server/json-store.ts:6-7` ファイル 0o600 / ディレクトリ 0o700。呼び出しは `server/index.ts:76`。
  - サーバー側の受け口: `server/http.ts:314` `AGENT_RESERVATION_PATH = /^\/api\/agent\/reservations(?:\/([^/]+)\/cancel)?$/`、`:320-329` `handleAgentReservations`（`:321` Origin ヘッダーがあれば403、`:323` token が null か `sameSecret`（定数時間比較 `server/auth.ts:92` `timingSafeEqual`）不一致なら401）。`:423-427` で通常の認証の**前**に分岐。`/api/routines` は agent 経路に無く、reservations.test.ts:291 が `GET /api/routines` を agent トークンで叩くと401を期待。
  - 通常の `/api/*`（定期実行を含む）は `server/http.ts:429` `deps.auth.authenticate({ authorization })`。`server/auth.ts:61` 「サーバー秘密（Bearer）またはセッショントークン」。サーバー秘密は `AGENT_CONSOLE_TOKEN`。`server/config.ts:217` `CHILD_ENV_BLOCKLIST = new Set(["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"])` により**端末内のプロセスには渡らない**（`server/sessions.ts:93-99` `buildChildEnv`）。つまり今の設計では、Claude のセッションは `/api/routines` を叩く手段を持たない。

## 2. ac-reserve.mjs の全コマンド・入力・検証・エラー

【事実】`hooks/ac-reserve.mjs`
- コマンド: `add`（stdin に JSON、引数なし）/ `list`（引数なし）/ `cancel <id>`（id は `/^[A-Za-z0-9-]{1,64}$/` `:13`）。判定 `:54`。それ以外は `:14` の USAGE で `{code:1}`（`:55`）。
- 対応HTTP: `:68` add→`POST /api/agent/reservations`、`:69` list→`GET /api/agent/reservations`、`:70` cancel→`POST /api/agent/reservations/<id>/cancel` 本文 `"{}"`。
- クライアント側検証: stdin 64KiB 超は拒否（`:10`,`:57`）、JSON.parse 失敗は拒否（`:58-62`）、reserve-token が無い/壊れていれば拒否（`:64-65`、値は理由文に入れない `:18`）。形の検証はサーバー任せ。
- エラー時: すべて `reject()`＝`{code:1, stdout:"", stderr:"<理由>\n"}`（`:16`）。接続失敗 `:72`「agent-console に接続できませんでした」、HTTP 非2xx は `:75-76`「受け付けられませんでした（<status>）: <error または HTTP status>」。成功は `:74` `JSON.stringify(result.json, null, 2)` を stdout、code 0。タイムアウト15秒（`:11`,`:36`）。
- 実行形: `:87-105` `isMain()` のとき `path.basename(here) !== "bin"` なら拒否（`dataDir/bin` に写されたものからのみ実行可）。`dataDir` = スクリプトの1つ上（`:101`）。node 標準部品のみ（`:4`）。
- サーバー側の検証（`server/reservations.ts` `create`, `:164-192`）: JSON オブジェクト必須(`:166`)、`resolveRunAt(date,time)`(`:99-108`、DATE `^\d{4}-\d{2}-\d{2}$`・TIME `HH:mm`・存在しない日付拒否)、予定は now+60秒〜+366日（`:15-16`,`:170`）、`validateLaunchText`・`validateLaunchTarget`、**createdBy==="agent" のとき `purpose==="measure"` 必須(`:176`) と `measureNote` 1〜200字・制御文字なし(`:177`)**、待機中全体50件(`:20`,`:181`)・agent 分10件(`:21`,`:182`)、全体200件超は done/cancelled を古い順に prune(`:112-118`)。
- 共通化された関数（PR #36）: `server/launch.ts`。`:8` `MAX_NAME = 40`、`:9` `MAX_PROMPT = 8192`、`:14` `CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/`、`:35-39` `validateLaunchText(input,label)`（name 1〜40字・promptText 非空/8192字以下/制御文字なし）、`:41-51` `validateLaunchTarget(config,input,label)`（roleId が config.roles に存在・cwd が本店/worktree 境界内・needsWorktree 役は branch 必須）、`launchAndSend`（送信本体）、`LaunchOutcome` 型。routines.ts は `:6` で `validateLaunchTarget, validateLaunchText, launchAndSend` を import し `:58,:60,:90` で利用。reservations.ts は `:6` で同じものを import。PR #36 の routines.ts は +12/-61（`pr36.json`）。
- 時刻共通: `jstSlot` は routines.ts:40-44 に定義され reservations.ts:7 が import。

## 3. 定期実行のサーバー側

【事実】型（`server/routines.ts:20-23`）
- `RoutineEvent = { at:number; slot:string; outcome: RoutineOutcome | LegacyOutcome; sessionName?:string }`（`:20`）。
- `Routine = { id; name; enabled:boolean; roleId; cwd; branch?; timeZone:"Asia/Tokyo"; weekdays:number[]; timeHHmm:string; promptText; lastSlot?; createdAt; updatedAt; events:RoutineEvent[] }`（`:21`）。
- `RoutineInput = Pick<Routine,"name"|"enabled"|"roleId"|"cwd"|"weekdays"|"timeHHmm"|"promptText"> & { branch?: string }`（`:23`）。
- 結果 outcome: `sent|not_ready|full|cwd_invalid|failed`（LaunchOutcome）+ 旧 `busy|waiting|unknown|stopped|missing`（`:18-19`）。

【事実】保存: `dataDir/routines.json`（`:9` `ROUTINES_FILE`）、形 `{ version: 2, items: Routine[] }`（`:37` `writeJsonAtomic(this.file, { version: VERSION, items })`、`:10` `VERSION = 2`、`:11` 読めるのは 1,2）。書く前に read して壊れた内容は上書きしない(`:37`)。`createSerial` で直列化(`:33`)。events は最大100件(`:14`,`:85`)。
【事実】検証: `validate`（`:57-62`）= `validateLaunchText`（name 1〜40字・promptText ≤8192・制御文字なし）+ `TIME` `^([01]\d|2[0-3]):[0-5]\d$`(`:13,:59`) + `weekdays()`（0〜6の整数・重複なし `:27`、保存時にソート）+ `validateLaunchTarget`。パース側 `parse`(`:29`) は timeZone が "Asia/Tokyo" 以外なら例外。
【事実】操作（`RoutineService`）:
- `create` `:63`: id=`randomUUID()`、createdAt=updatedAt=now、events=[]。**登録してもセッションは開かない**（README:7）。件数上限のコードは routines.ts に無い（grep で `MAX_` は `MAX_EVENTS` のみ `:14`）。【未確認】登録件数の実運用上の上限。
- `update` `:64`: 全項目を `RoutineInput` で渡す（部分更新ではない）。**roleId・cwd・branch の変更は拒否** `"routine role, cwd and branch cannot be changed"`。未知の id は `SessionInputError("routine not found")`。
- `setEnabled` `:65`: `enabled` が boolean でなければ `"enabled required"`。名前・時刻などは触らず updatedAt のみ更新。
- 有効/無効はスケジューラの対象にするかだけ: `tick` `:70` `r.enabled && r.weekdays.includes(slot.weekday) && r.timeHHmm === slot.timeHHmm && r.lastSlot !== slot.key`。待機中に無効化されたら送らない `:90` `stillWanted: () => … ?.enabled === true`（試験 K11 `routines.test.ts:139`）。
- 取りこぼしの追い付きなし、1回の slot は `lastSlot` を送信前に保存して重複防止（`:73-74`）。
【事実】HTTP（通常認証 = `AGENT_CONSOLE_TOKEN` かセッショントークン。agent 用トークンでは通らない）`server/http.ts`:
- `:179` `GET /api/routines` → `{items}`
- `:180` `POST /api/routines` → 201、`routines.create(jsonBody(...))`
- `:183` `PUT /api/routines/:id` → `routines.update`
- `:184` `POST /api/routines/:id/enabled` → `routines.setEnabled(id, body.enabled)`（PATCH ではなく POST）
- DELETE ルートは存在しない（`:179-184` の6行が routines の全ルート）。
【事実】削除が無い理由: `docs/handoff/v0.7.0-routines/design.md:9` 「Enable/disable controls eligibility only; deletion and automatic session stop are excluded.」、`:17` 「The authenticated routes expose list/create/edit/enable only.」。`docs/handoff/routines-new-session/design.md:14` 「対象外: 削除の機能、前回の会話を自動で閉じること、取りこぼした回の追い付き、…」。理由の文章は上記以上の記述を見つけていない。【未確認】削除を入れない動機（設計文書に理由の説明文はなく「対象外」とだけ書かれている）。
【事実】切り戻し配慮: reservations は routines.json に混ぜず別ファイル（`docs/handoff/reservations/design.md:25` 旧版は version 1/2 以外を読むと例外）。routines.json の形を変えると旧版が読めなくなる。

## 4. 予約(reservations)の削除・取消

【事実】削除は無いが取消がある。`server/reservations.ts:194-204` `cancel(id)`: 未知の id は `SessionInputError("reservation not found")`(400)、pending 以外は `SessionConflictError("reservation is not pending")`(409)、成功は `status:"cancelled"`・updatedAt 更新（行は消えない）。API は `server/http.ts:327` `POST /api/agent/reservations/:id/cancel`。実際に行が消えるのは `prune`(`:113-118`) で全体200件超のとき done/cancelled を古い順に落とすときだけ。試験 R8（cancel）`reservations.test.ts:220`, R9（prune）`:228`。
【事実】定期実行側に相当する「取消」は無い（有効/無効のみ）。

## 5. README の AI 向け書き方（`README.md` at origin/main）

【事実】
- 「定期実行」節 `README.md:5-7`（要約のみ。AI向けの使い方の記述なし。AI 用 CLI も無い）。
- 「予約」節 `README.md:9-29`。`:16` 「### ac-reserve の使い方（AI が Bash で打つ）」、`:18` 「**使ってよいのは、変更の効果を実地で測る予約だけ（PO 決定 2026-10-14）。**」、`:20-24` コマンド3行のコードブロック、`:26` 入力形「`name`（1〜40字）、`roleId`、`cwd`、`branch`（worktree 役のとき）、`date`（YYYY-MM-DD）、`time`（HH:mm、日本時間）、`promptText`（8192字以下）、`purpose`（必ず "measure"）、`measureNote`（何を測るか、1〜200字）」、`:27` 「予定は1分後から366日後まで。待機中の予約は全体で50件、AI の分は10件まで。」、`:28` 宛先 `dataDir/reserve-token`・失敗は終了コード1と理由を標準エラー。
- 「作戦ボード」節 `README.md:92-142`。`:100` 「### ac-board の使い方（Claude が Bash で打つ）」、`:102` 導入先パス `~/Library/Application Support/agent-console/bin/ac-board.mjs`・「ボードは丸ごと書き換わります」、`:105-121` heredoc の JSON 例、`:124` `CLAUDE_CODE_SESSION_ID`、`:125` 形(version 1・必須/省略可項目)、`:126` 上限「`theme` 200 字、`kgi` 10 件で各 500 字、`kpis` 20 件で各項目 200 字、`roadmap` 50 件で各 200 字、`tasks` 100 件で各 200 字、入力全体 256KiB」と制御文字の扱い、`:127` 失敗は何も書かず標準エラー+終了コード1。
- 形の書き方の型: ①コマンド例（コードブロック）②JSON 例または項目の列挙③上限（文字数/件数/byte）④失敗時の挙動（終了コード1・標準エラー）⑤導入先パスと認証元。

## 6. 版・PR・CI・テストの決まり

【事実】
- `~/agent-console` の origin/main に `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING*` は無い（`git ls-tree` で確認。ヒットは `server/agents.ts` 等のみ）。決まりは `docs/CHANGELOG.md` と各 `docs/handoff/<topic>/design.md` に分散。
- 版: `docs/CHANGELOG.md:3` 「版を出すたびに 1 行追記する（版の正本は git タグ `vX.Y.Z`）。」タグは `git tag` で v0.20.0, v0.21.0 を確認。版を書き換える場所は PR #36 の変更ファイルから: `package.json`, `package-lock.json`(+2/-2), `extension/manifest.json`(`:4 "version": "0.21.0"`), `playwright.config.ts`(+1/-1), `docs/CHANGELOG.md`(+1), `README.md`。版の採番ルール: `docs/handoff/reservations/design.md:112` 「版は若い番号の PR を先に通す決まりにより #35 が v0.20.0、本件は v0.21.0」。
- 導入手順: `docs/handoff/reservations/design.md:147` 「導入: マージ・タグ後、既存の手順（全セッションが入力待ちのときに ac-update を実行する予約 update-when-idle.sh）で行う。」戻し方 `:148` 前の版へ ac-update（切り戻し）。
- design.md の型: `docs/handoff/reservations/design.md:11` 対象、`:120` 以降「R番号 | 検証方法」表、`:164` レビュー履歴（Fable 審査 REVISE→反映）。recon.md と対で `docs/handoff/<topic>/` に置く。
- CI（`.github/workflows/ci.yml`）: pull_request と push(main)。ubuntu/macos 行列(`:15`)。手順 `npm ci` → `npm audit --audit-level=moderate`(`:46`) → `npm audit signatures` → Sales Anchor を clone して `sa-sync`(`:51-58`) → `npm run typecheck`(`:60`) → `npm run lint`(`:61`) → `npm test`(`:62`) → tmux timing check(`:65-69`) → `npm run build`(`:70`) → `npx playwright install` → `npm run test:e2e`(`:72`)。tmux 3.8 を入れる(`:29-41`)。
- npm scripts: `typecheck` = `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit`、`lint` = `node scripts/check-design-governance.mjs`、`test` = `vitest run`、`test:e2e` = `playwright test`（package.json:11-17）。
- 新規に hooks/*.mjs を足す場合の連動箇所: `scripts/copy-board-command.mjs:9` の配列、`server/activity-setup.ts` の install 関数、`server/activity-start.ts:42-59`（PR #36 はこの3つを触っている）。
- PR #36（"feat: 予約タブ（日時を指定して1回送る）v0.21.0"）変更ファイル一覧（`gh pr view 36 --json files`、全37件。`recon-raw/pr36.json`）:
  README.md(+21), docs/CHANGELOG.md(+1), docs/handoff/reservations/design.md(+166), docs/handoff/reservations/recon.md(+51), extension/manifest.json(+1/-1), hooks/ac-reserve.d.mts(+8), hooks/ac-reserve.mjs(+106), package-lock.json(+2/-2), package.json(+1/-1), playwright.config.ts(+1/-1), scripts/copy-board-command.mjs(+2/-2), server/activity-setup.ts(+10), server/activity-start.ts(+6/-1), server/auth.ts(+3), server/http.ts(+41/-1), server/index.ts(+9/-2), server/json-store.ts(+36), server/launch.ts(+94), server/picks-routes.ts(+1/-4), server/reservations.ts(+241), server/reserve-token.ts(+39), server/routines.ts(+12/-61), src/api.ts(+4/-1), src/components/Reservations/{ReservationEditor.tsx(+48), Reservations.css(+10), ReservationsPane.tsx(+81)}, src/locales/ja.json(+41/-1), src/pages/ConsolePage.test.tsx(+3/-3), src/pages/ConsolePage.tsx(+4/-1), src/types.ts(+11), tests/e2e/chat.spec.ts(+1/-1), tests/e2e/console.spec.ts(+3/-3), tests/e2e/reservations.spec.ts(+41), tests/unit/ac-reserve.test.ts(+76), tests/unit/helpers/harness.ts(+10/-1), tests/unit/reservations.test.ts(+330)。
- UI 文言は `src/locales/ja.json` のみ（`docs/handoff/routines-new-session/design.md:13` 「en.json は無いので作らない」）。`lint` は `scripts/check-design-governance.mjs`（Sales Anchor の金型・トークン規約）。

## 7. 既存テスト（ac-reserve / routines を検証しているもの）

【事実】
- `tests/unit/ac-reserve.test.ts`（`runCommand` を直接呼ぶ。`startHarness` でサーバー起動。R12 add/list/cancel とトークンを出力しない、R12 失敗は終了コード1、reserve-token 欠落/破損、reserve-token の port にしか送らない）。
- `tests/unit/reservations.test.ts`（R1〜R12b。R11 `:277` agent 受け口の認証、R11c `:295` purpose/measureNote と agent 10件上限、`:291` agent トークンで `/api/routines` が401、R12b `:316` reserve-token 0600・再起動で token 維持）。
- `tests/e2e/reservations.spec.ts`（R15 画面で作成・取消）。
- `tests/unit/routines.test.ts`（K1〜K11: 時刻/JST、保存と壊れたファイル、新規セッション、二重実行防止、v1→v2 読み替え、制御文字拒否、events 上限、`:214` 未知の routine と非boolean の enabled 拒否）。
- `tests/unit/held-merge.test.ts:33-49`（routines.json の held マージ）、`tests/unit/ac-board.test.ts`（ac-board）、`tests/unit/helpers/harness.ts:206`（RoutineService 構築）と `tests/unit/helpers/ac-env.ts`。
- 定期実行の e2e（Playwright）は見つからない（`git grep routines origin/main -- tests/e2e` が0件）。UI 側 `src/pages/ConsolePage.test.tsx` はタブ順の試験（PR #36 で変更）。

## 8. セッションの識別・役割・監査（「登録の判断は Opus だけ」を技術で守れるか）

【事実】agent-console が起動したセッションに渡す環境変数
- `server/sessions.ts:96-105` `buildChildEnv`: サーバーの `process.env` の**全部**（`CHILD_ENV_BLOCKLIST` を除く `:99`）+ config の `terminalEnv`（`TERMINAL_ENV_FORBIDDEN` を除く `:102`）+ `TERM`(`:104`)。blocklist = `AGENT_CONSOLE_TOKEN, AGENT_CONSOLE_AUTH, AC_SECURITY, AC_STUB_LOG`（`server/config.ts:217`）。
- 追加で渡す名前つき変数は復元起動時の `AC_RESUME_ID` のみ（`server/sessions.ts:326` `useRestore ? { AC_RESUME_ID: sid } : {}`、通常起動は `{}`）。tmux 経由は `:448-450` `env: { ...paneEnv, ...extraEnv }`、direct は `:466` `env: { ...this.childEnv(), ...extraEnv }`。
- アプリのセッション id・役割・モデルを渡す環境変数は無い。裏づけ: `docs/handoff/board/recon.md`（B-3）「アプリのセッション id（randomUUID()）も名前も port も環境変数では渡していない（AC_SESSION などの設定箇所なし）」。今回も `git grep 'AC_SESSION|AC_ROLE'` を server/hooks/scripts/src/docs/README/tests に対して実行し該当0件（`AC_RESUME_ID` と `CLAUDE_CODE_*` のみヒット）。
- `CLAUDE_CODE_SESSION_ID` は Claude Code 本体が Bash/hook の子へ自動で入れる（アプリが渡すものではない）。`docs/handoff/board/recon.md`（B-3 の引用）と `README.md:124`。

【事実】役割とモデルの保存場所
- 役割は config の `roles`（`agent-console.config.json:29-`、`server/config.ts:5-19` `RoleConfig` = id, labelKey, command, needsWorktree, resumeCommand?, resumeScope?, restoreCommand?）。**モデルを持つ専用フィールドは無く、`command` の文字列に埋まっている**: `opus-designer` = `["/bin/zsh","-ic","ccopusgo"]`（`needsWorktree:false`）、`sonnet-impl` = `["/bin/zsh","-ic","claude --model sonnet"]`（`needsWorktree:true`）、`shell` = `["/bin/zsh","-i"]`（`recon-raw/roles.txt`）。`ccopusgo` の中身（モデル指定）は zsh のエイリアス/関数で、今回は読んでいない【未確認】。
- セッション自体: `server/sessions.ts:384-` `Session` に `id`(randomUUID `:382`)、`name`、`roleId: role.id`、`branch`、`cwd`、`createdAt` … を保持。永続化は `dataDir/open-sessions.json`（実測 `-rw------- 2881`、役割・名前・作業場所・ブランチ・Claude の sessionId。`docs/CHANGELOG.md` 0.3.8）。モデル名の保存先は無い。
- 定期実行/予約が起動するセッションの役割: `Routine.roleId` / `Reservation.roleId`（routines.ts:21, reservations.ts:30）。`validateLaunchTarget` は roleId が存在することしか見ない（`server/launch.ts:43-44`）。**ポリシー上「どの役割が登録してよいか」を判定する仕組みは無い**。

【事実】ac-board / ac-reserve が呼び出し元を判別・記録するか
- ac-board: 判別する。`env.CLAUDE_CODE_SESSION_ID`（`hooks/ac-board.mjs:191`）。ただし記録は「書き込み先ファイル名が `boards/<会話の番号>.json`」になるだけで、役割・モデルは読まない。
- ac-reserve: 呼び出し元のセッション・役割を**送らない**。送るのは Bearer と JSON 本文のみ（`hooks/ac-reserve.mjs:32-37`）。サーバー側は `createdBy: "ui" | "agent"` の2値だけを記録（`server/reservations.ts:27,40`、`http.ts:326` で `"agent"` 固定）。どの会話から来たかは残らない。reserve-token は全セッション共通の1個（`server/reserve-token.ts:32`）で、`$DD/reserve-token` は権限 0600 だが同じユーザーで動く全プロセスが読める（Opus も Sonnet も同じ）。
- 結論の材料【事実】: 現状の仕組みでは、受け口に入れるかどうかは「`$DD/reserve-token` を読めるか」だけで決まり、役割（Opus/Sonnet）では区別されない。

【事実】サブエージェント（Agent ツールで起動した Sonnet）の環境変数
- 実測資料あり: `docs/handoff/board/step0.md:36-41` の表。Agent（general-purpose、sonnet）の中の Bash で `CLAUDE_CODE_SESSION_ID` = 親と同じ値 `ad60efcb-9d0c-43a1-936f-e3d31b43c907`、hook の session_id も同値。同表は「番号なしの再開」でも同値。→ サブエージェントの Bash は少なくとも `CLAUDE_CODE_SESSION_ID` を**親と同じ値で引き継ぐ**（Claude Code 2.1.296 での実測）。したがって `CLAUDE_CODE_SESSION_ID` では親(Opus)とサブエージェント(Sonnet)を区別できない。
- hook 側には区別材料がある: `docs/handoff/board/step0.md:19-21` PreToolUse の入力に `agent_id` と `agent_type`（例 `"agent_id":"ab4603515d5beee56","agent_type":"general-purpose"`）。これは hook の標準入力 JSON であり、Bash の環境変数ではない。
- その他の環境変数（`CLAUDE_CODE_CHILD_SESSION` 等）は `docs/handoff/board/step0.md:46` 「この実測を動かした Claude セッションは CLAUDE_CODE_CHILD_SESSION の印を引き継ぐ」と `chat2/recon.md:38` の記述があるのみ。親の全環境変数がサブエージェントの Bash に入るかを網羅的に調べた資料は見つけていない。【未確認】サブエージェントが `CLAUDE_CODE_SESSION_ID` 以外の変数（モデル名・役割を表すもの）を持つか。【未確認】Claude Code 本体が Bash ツールの環境にモデル名を入れる変数があるか。
- アプリ側の環境変数にはモデルや役割が無いので、「親と同じ環境変数を引き継ぐ」かどうかは、引き継ぐ対象が（`AC_RESUME_ID` を除き）元々 `process.env` 由来のものと `CLAUDE_CODE_*` だけ、という意味になる。【未確認】`AC_RESUME_ID` がサブエージェントの Bash に入るか（実測資料なし。復元起動のセッションのみに設定される）。

【事実】書き込みの監査記録（誰がいつ書いたか）
- 専用の監査ログは無い。`git grep -nE 'audit|監査' origin/main -- server hooks README.md` は該当0件。
- 部分的な痕跡のみ: ①`Routine.createdAt/updatedAt`（`routines.ts:21`）、`Reservation.createdBy/createdAt/updatedAt`（`reservations.ts:40-42`）。誰か（セッション・役割）は残らない。②`Routine.events`（実行履歴、最大100件）。③ac-board は `boards/<会話の番号>.json` の `updatedAt`（README:125）。④サーバーログ/activity は別目的（`dataDir/activity/events-YYYYMMDD.jsonl`、hook が記録するツール呼び出し。`README.md:30-` の v0.9.0 節）で、Bash の中身が `ac-reserve.mjs` を叩いたかは hook 入力（tool_input.command）には出る可能性があるが、今回は活動ログの実物を確認していない【未確認】。
- 反映確認: 導入先 `$DD/activity/` は存在（`drwx------`、10月14日 09:00）。中身は未確認。

## 未確認まとめ
1. routines の登録件数上限のコード（routines.ts に `MAX_` は events のみ。HTTP 層・UI 層は未読）。
2. 削除を入れない動機の説明文（設計文書は「対象外」とのみ記述）。
3. `ccopusgo` の実体（モデル指定の中身。zsh -ic 経由）。
4. サブエージェントの Bash が `CLAUDE_CODE_SESSION_ID` 以外の変数（モデル・役割・`AC_RESUME_ID`）を引き継ぐか。
5. `$DD/activity/*.jsonl` に ac-reserve 呼び出し（tool_input）が残るか。
6. `ac-update` / `update-when-idle.sh` の実物（導入手順の詳細は未読）。
