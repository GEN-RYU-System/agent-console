# 設計書: 同時に開ける窓の上限と、使っていない窓を休ませる（window-limit）第1.5版
作成: Claude Opus（設計）2026-10-26。状態: 第1.0版〜第1.3版を別の審査役（claude -p・Opus）が REVISE → 第1.4版が **APPROVE**（重大・要修正なし、軽微 7）→ 第1.5版で軽微 7 件を反映。**PO 承認済み（2026-10-26「1」＝この設計で作り始める）**。便1 の作業指示書は `bin1-card.md`。

## 1. 目的（PO の言葉）
- 原文（2026-10-26）: 「agent consoleでは新しいセッションも過去の会話も含めて全てopusだけが展開して、sonnetは全てクラウドで作業を指せる仕組みにしたい、そうすればCPUやRAMが軽くなると考えるがどうか？」
- Opus の回答と PO 決定（2026-10-26「1」）: Sonnet の実装と試験はクラウドで動かす（運用は決定済み）。加えて、作業画面に「同時に開ける窓の数の上限」と「しばらく使っていない窓を休ませる」仕組みを入れる設計案を作る。窓を閉じる（休ませる）前に必ず PO に確かめる。
- 背景の実測（2026-10-26、PO の Mac、`ps`。生出力 /tmp/CC報告ファイル/cpu/claude-procs-now.txt）: claude の窓 9 本、すべて `--model opus`。CPU 合計 85.3%（32.1・23.7・15.4・8.7・2.1・1.6・0.8・0.5・0.4）、RSS 合計 932MB（263・215・157・122・58・53・23・22・19）。最長の経過 5 日 19 時間。Sonnet の窓は 0 本（Sonnet は Opus の窓の中のサブエージェントとして動いていた）。

## 2. 変更前 → 変更後（利用者に見える変化）
| 場所 | 前 | 後 |
|---|---|---|
| 新しい窓を開く・過去の会話を再開 | 16 本まで開ける（設定できない） | 設定の上限（この Mac では 6）まで。超えると「上限です。休ませられる窓が N 本あります」と案内し、休ませる確認へ進めるボタンを出す |
| 窓の一覧 | 動いている窓と止まった窓 | 30 分以上ずっと待機中（idle）の窓に「休ませられます」の印。休ませた窓は「休止中」として一覧に残り、「起こす」ボタンで同じ会話の続きから開き直す |
| 休ませる操作 | 無い（閉じるだけ） | 行の「休ませる」、または一覧の上の「候補をまとめて休ませる」→ 確認画面（対象の名前を全部並べる）→ 休ませる。**自動では休ませない** |
| 新しい窓の役割 | Opus・Sonnet・shell | Opus・shell（Sonnet の役割を外す。Sonnet の作業はクラウドへ） |
| 作業画面の再起動・更新 | 開いていた窓を開き直す | 開いていた窓は従来どおり開き直す。休止中の窓は休止中のまま一覧に戻す（勝手に起こさない） |

## 3. 事実（根拠）
recon: docs/handoff/window-limit/recon.md（基準 origin/main 21df257、v0.46.2）。以下はその要約と追加確認。
- 上限は `SessionManager` の `maxSessions` 1 か所で、作成・再開・復元・予約・定期実行・引き継ぎの全入口が使う（recon §1-1、`server/sessions.ts:15,275,296,316,325`）。config にキーが無く、本番は options なしで生成（`server/index.ts:75`）。
- 閉じる処理は `closeRunning`（SIGHUP → 5 秒猶予 → 子孫に SIGKILL、`sessions.ts:523-543`）。閉じると `Session` ごと消え、復元リスト `open-sessions.json` は「今開いている窓の写し」なので claudeSessionId も残らない（recon §2、`restore.ts:72-85`）。
- 続きから開く仕組みは既にある: `restore({id, claudeSessionId})` が役割の `restoreCommand` を `AC_RESUME_ID` 付きで起動（`sessions.ts:324-331`）。同じアプリ id を引き継げる（`:331,388-391`）。v0.3.8 から本番で使用中（docs/CHANGELOG.md 0.3.8）。
- 一言も入力していない窓は `claude agents --json` に出ず sessionId が取れない（v0.3.8 design.md:16、2026-10-12 に 3 回実測）。
- 窓の状態は 10 秒ごとの標本（`agentsPollMs`、`hub.ts:145`）。標本ごとの「アプリ id → 状態」を `onAgentsSampled` で購読できる（`hub.ts:181-189`、定期実行の自動クローズが既に使用 `index.ts:107`）。窓ごとの「最後に動いた時刻」は `Session` には無い（recon §3）。
- 手元の Mac の保存（2026-10-26 13:3x JST、`~/Library/Application Support/agent-console/` を grep）: `routines.json` の役割は opus-designer 8 件、`reservations.json` は opus-designer 23 件・shell 1 件、`open-sessions.json` は opus-designer 10 件。`sonnet-impl` を使うものは 0 件。
- 既存の自動クローズは定期実行が開いた窓だけ（idle 累計 10 分、`routine-closer.ts:8,42`）。
- 未処理の予約・名前予約がある窓は `hasPendingWork`（`hub.ts:245`）で分かる。
- 役割の設定（origin/main `agent-console.config.json`）: `opus-designer`（ccopusgo）、`sonnet-impl`（`claude --model sonnet`）、`shell`。`reserveRoles`・`routineManagerRoles` は未設定。
- 閉じる確認は SA の金型 `ConfirmModal`（`ConsolePage.tsx:640-649`）。文言は `src/locales/ja.json` の `ac.*`。
- Context7: 本件は agent-console 内部のコードと Claude Code の `--resume` だけで、新しいライブラリの仕様に依存しない。`--resume` の振る舞いは v0.3.8 以来の本番実績に依る。

## 4. 設計
### 4-0 休止中の窓の作り（審査 C3 への答え。ほかの節はこれを前提にする）
- **端末（term）は残し、`exited` は真、`sleeping: true` を足す**。休止中の窓は「止まった窓の一種」として既存の各所を安全に通す（MemoryCollector `memory.ts:117`・RoutineCloser `routine-closer.ts:51`・relay `relay.ts:175,208`・launch `launch.ts:71` は exited を見て外す＝審査 (2) の事実）。
- 休ませた窓は、止めた端末の `term` をそのまま持つ（pid は死んだ pid。子孫は無い）。
- 再起動のあとに休止中として戻す窓は、新しい部品 `DormantTerminal`（`server/dormant-terminal.ts`）を持つ。`pid` は **-1**。`descendantPids` は根が正でなければ空を返すので（`process-tree.ts:41`）0 でも子孫は拾わないが、既存の「pid が分からない端末＝0」（`sessions.ts:452`）と区別するため -1 にする。`process.kill(-1)` に届く道が無いこと（`killQuietly` は family にだけ使う＝`sessions.ts:539`。sleep・close・remove の止め方は `pid > 0` のときだけ殺す＝`:533`）を単体試験で固定する。`TerminalHandle`（`terminal-host/types.ts:5`）の `write`・`resize`・`kill`・`release`・`onData` は何もしない。`addSleeping` は `spawnSession` を通らず（`onExit` を登録するのは `sessions.ts:426` だけ）、Session に `exited: true` を自分で付ける。`onExit` を登録した時点で即呼ぶのは、将来どこかが登録しても止まった端末として振る舞うための念のため。
- 状態の判定: `Hub.snapshot`（`hub.ts:710-731`）と `detectBreaks`（`hub.ts:570-571`）で、`s.sleeping` を **`stateForSession` より先に** 見て `"sleeping"` にする（`stateForSession` は exited を見て先に `"stopped"` を返すため＝`agents.ts:106`）。休止中の窓の `claudeSessionId` が付け替わらないことは今のコードで既に成り立つ（`setClaudeSessionId` は exited の窓を無視＝`sessions.ts:340`）。新しい処理は足さず、試験で固定するだけ。`hub.ts:255,321,351,500,594,602` の入力・チャットの判定は、exited が真なので既存どおり「入力できない」になる（変更しない）。
- 休止中の窓の行で許す操作は「起こす」と「外す」だけ。
  - 「外す」は既存の `remove()`（`sessions.ts:480`）。休止中の窓は exited なのでそのまま通る。画面では確認画面を挟み、本文は「{{name}} を一覧から外しますか？ 会話は『過去の会話を再開』から戻せます」。
  - 「閉じる」ボタンは出さない（`SessionList.tsx:176` の条件を下の `isInactive` に置き換える）。`POST /api/sessions/:id/close` に休止中の窓が来たら、既存の exited の扱い（`http.ts:303-307`＝remove）のまま。
- **画面で「止まった窓」を判定している所（審査 N5）**: 休止中の窓は「入力できない窓」として、止まった窓と同じに扱う。`state === "stopped"` を見ている 8 か所のうち 7 か所（`SessionList.tsx:80,121,176,189`・`RenameForm.tsx:20`・`chatLogic.ts:29`・`ConsolePage.tsx:150`）は、共通の判定関数 `isInactive(state)`（`stopped` または `sleeping` で真。`src/` に 1 つ置く）に置き換える。ただし `SessionList.tsx:189`（止まった行の「外す」ボタン）は、休止中の行では 4-3 の「起こす」「外す（確認つき）」に替える。残りの 1 か所 `src/pages/ConsolePage.tsx:373`（アカウント切り替えの端末が止まったかの判定。この端末は休ませる対象にならない）は**置き換えない**。状態ごとの表を持つ 3 か所（`PicksPane.tsx:33`・`DiffPane.tsx:48`・`chatLogic.ts:31`）には `sleeping` の行を足し、文言は「休止中の窓には送れません。『起こす』で開き直してください」（`t("ac.sleep.cannotSend")`）。名前の変更（F2・ダブルクリック）も休止中は開かない。

### 4-1 上限を設定にする・Sonnet の役割を外す（便1）
- `Config` に任意キー `maxSessions`。検証は正の**整数**（`parsePositive`＝`config.ts:203-207` は整数を見ないので、`Number.isInteger` の確認を足した `parsePositiveInt` を新設）。既定 16。`DEFAULT_MAX_SESSIONS` は `sessions.ts:15` から `config.ts` の `DEFAULT_*` 群へ移す。`server/index.ts:75` で `new SessionManager(config, { maxSessions: config.maxSessions })`。
- 実ファイル `agent-console.config.json` に `"maxSessions": 6`。
- 上限の数え方を 1 つの関数にそろえる（審査 M3）: `SessionManager.occupiedCount()` = `[...sessions.values()].filter((s) => !s.sleeping).length + pending`。`create`（`sessions.ts:275`）・`resume`（`:296`）・`hasCapacity`（`:316-317`）の 3 か所すべてで `occupiedCount() < maxSessions` を使う。**止まった（exited で sleeping でない）窓は今までどおり数える**（今の振る舞いを変えない）。便1 では sleeping がまだ無いので、数は今と同じ。
- `/api/state` に `maxSessions` と `openCount`（＝`occupiedCount()` から pending を引いた値）。名前は `activity.store.runningCount` と紛れないよう `openCount` にする。一覧の見出しに「開いている 5 / 6」（`t("ac.openCount", {count, max})`）。
- `roles` から `sonnet-impl` を外す。影響の点検（審査 M9）: 定期実行・予約は保存した役割を config から探す（`launch.ts:46`、`reservations.ts:211`）。手元の保存では `sonnet-impl` を使うものは 0 件（§3）。導入の直前に Opus が同じ grep をもう一度行い、1 件でもあれば導入を止めて PO に聞く。復元リストに残っていれば既存の `unknownRole` 案内で外れる（`restore.ts:13`）。

### 4-2 休ませる・起こす（便2）
**部品の分け方（審査 M1）**: 端末を止める・起こすのは `SessionManager`、休ませてよいかの確認と待機時間の計測は新しい部品 `SessionSleeper`（`server/sleeper.ts`）。`SessionSleeper` は `sessions`・`hub`・`closer`（RoutineCloser）・`relay`（RelayManager）・`activity` を受け取る。`index.ts:98-112` で作り、HTTP に渡す部品の束（`index.ts:112`）に入れる。
- `RoutineCloser` に公開関数 `isTracking(id): boolean`、`RelayManager` に `isBusy(id): boolean` を足す（今は private＝`routine-closer.ts:39`、`relay.ts:138`）。
- **待機時間の計測**: `SessionSleeper` が `hub.onAgentsSampled` を購読し、窓ごとに「`state === "idle"` かつ `activity.store.runningCount(claudeSessionId) === 0`」が連続した時間を数える（`RoutineCloser` の `sample`＝`routine-closer.ts:51-61` と同じ作り。購読の中で `activity.store.refresh()` を待ってから `runningCount` を読む＝closer の購読 `index.ts:107` と同じ。標本の間隔が `gapLimitMsFor(agentsPollMs)` を超えたら数え直し）。ほかの状態が 1 回でも来たら 0 に戻す。作業画面の再起動で 0 から数え直す（候補が遅れて出るだけ）。
- **候補**: 待機の連続が `sleepSuggestMinutes`（config の任意キー、正の整数、既定 30）以上で、下の条件 2〜4 を満たす窓。
- **`SessionSleeper.sleep(id)` の手順**（`RelayManager.start`＝`relay.ts:170-187` と同じ「確認 → 取り直し → もう一度確認」）:
  1. 窓が動いていて（exited でない）、sleeping でない
  2. `claudeSessionId` が UUID で、役割に `restoreCommand` がある
  3. `hub.hasPendingWork(id)` が偽、`closer.isTracking(id)` が偽、`relay.isBusy(id)` が偽
  4. `hub.checkInput(id)`（`relay.ts:180` と同じ）で取り直した状態が idle、かつ `activity.store.runningCount(claudeSessionId) === 0`（裏で担当が動いていない＝審査 M2）
  - どれかを満たさなければ `SessionConflictError(<理由>)` → HTTP 409。理由は `notIdle`・`noResumeId`・`pendingWork`・`routine`・`relay`・`subagentRunning`・`closing`（閉じている最中・休ませている最中＝公開の `sessions.isClosing(id)`＝`sessions.ts:492-494`。`closing` の Map は private＝`:171`。条件 1 の中で見る）のどれか（画面は i18n で文言にする）。
  - 満たせば、止める前に Hub の表示名（Claude 側の名前、`hub.ts:717`）を `storableName`（`restore.ts:22-25`。制御文字を除き 40 字に切る。今は export されていないので、`server/session-store.ts` へ移して export し、`restore.ts` と `sleeper.ts` の両方から使う）に通してから `s.name` に写す（審査 M5・N6。`rename` は 40 字超で例外を出す＝`sessions.ts:81-87,376`。40 字の判定は `:84` ので使わない。手本は `relay.ts:63,186`）→ `sessions.sleep(id)`。
- **`SessionManager.sleep(id)`（審査 N3・N4）**:
  1. `closeRunning`（`sessions.ts:523-543`）の「端末と子孫を止めて待つ」部分を `stopTerminal(s)` に切り出し、close と sleep で共用する（close は `stopTerminal` のあと今までどおり `remove()`）。
  2. 最初に `closing.has(id)` なら 409（理由 `closing`）。閉じている最中に休ませない（審査 R1）。通れば sleep も `closing` の Map（`sessions.ts:516-519`）に登録する。Hub の `isClosing`（`hub.ts:527,551,556`）も休ませ中に真になる。
     - 休ませている最中に届いた close は **409**（理由 `sleeping`）を返し、待たない（審査 R2。既存の `close()`＝`:516-517` は登録済みの Promise を返して成功扱いになるため、sleep の登録には「休ませ中」の種類を持たせて close が見分ける）。休ませ終わったあとの close は、休止中の窓として既存の exited の扱い（`remove`）になる。
     - **休ませ中の印は exited より先に見る**（審査 W1）: 休ませる途中には「端末は止まった（exited 真）が子孫がまだ消えていない」時間が最大約 7 秒ある（止まりきった判定 `gone`＝`sessions.ts:531` は exited と子孫の両方を見る）。`close()`（今は exited を先に見て `remove()` へ進む＝`:512-514`）・`remove()`（`DELETE` の口＝`http.ts:238`、exited だけを見る＝`:483`）・`wake()` の 3 つとも、**最初に** `closing` の登録が「休ませ中」なら 409（理由 `sleeping`）を返す。
     - 休ませている最中に届いた sleep は 409（理由 `closing`）。
     - これで、休ませ中の登録が新しい Session に残ること（wake が先に通る場合）も起きない。
  3. 止める**前に** `s.sleeping = true` を付ける（`exited` はまだ偽）。`sync` の絞り込み（下の「復元リスト」3）は `sleeping` の窓を通すので、止まった瞬間の `notify`（`sessions.ts:426-429`）で保存しても復元リストから外れない。
  4. `stopTerminal` が止めきれなかったときは、**失敗した時点の `s.exited` の値**で分ける（どの行で失敗したかでは分けない。審査 S1・W2）。`stopTerminal` は `{ stopped: boolean; exited: boolean; remainingPids: number[] }` を返し、2 つの失敗を見分けられるようにする:
     - `exited` が偽（端末そのものが終わっていない）: `s.sleeping` を偽に戻して `notify()` し、`SessionConflictError("session did not stop")`。窓は動いたまま。
     - `exited` が真（端末は終わったが子孫のプロセスが残った）: `s.sleeping` は**真のまま**にして `notify()` し（休止中として復元リストに残す＝会話は起こせば戻る）、`SessionConflictError("descendants remain")` で残った pid を知らせる。上限には数えない。
     - close 側は今までどおり、どちらの失敗も `"session did not stop"` を返す（close の振る舞いは変えない）。
  5. 止まったら `notify()` を必ず呼ぶ（`sleeping` 真・`exited` 真の形で保存と配信をやり直す）。
  - 休ませ中の窓は `sleeping` が真でも `exited` が偽なので、4-0 の状態判定で「sleeping」と表示され、`occupiedCount` からも外れる。止め終わるまで最大約 7 秒（`closeGraceMs` 5 秒＋最後の待ち 2 秒＝`sessions.ts:21,23,532,540`）、上限の数に 1 本空きが早く出る（端末はまだ動いている）。その間に別の窓が開き、そのあと休ませるのに失敗して窓が動いたまま戻ると、上限を 1 本超えたままになる。これは受け入れる（新しく開くのを止めるだけで、動いている窓は止めない）。
- **`SessionManager.wake(id)`（審査 C1・N1・N2）**:
  1. 休止中（`sleeping` 真かつ `exited` 真）の窓だけが対象。ほかは 409。
  2. 起こし中の印 `waking: Map<id, Promise>`（`closing` と同じ作り）を置く。既に起こし中なら、その Promise を返す（2 回目は新しく起動しない）。
  3. `hasCapacity()` を確かめる（満席なら `SessionInputError("too many sessions")` → 400）。作業場所を `classifyCwd`（非同期）でもう一度確かめる（無ければ `SessionConflictError("missingCwd")` → 409、休止中のまま）。
  4. await のあとに、もう一度「まだ休止中か」「容量があるか」を確かめる（`relay.ts:180-185` と同じ「確認 → 待つ → もう一度確認」）。外れたら 409／400。
  4.5. 休ませたときに子孫が残っていた窓（4-2 sleep 4 の `descendants remain`）は、休止中の Session に残った pid を控えておく。起こす前にその pid がまだ生きていれば 409（理由 `descendants remain`）にして起動しない（審査 Y3。opus-designer の端末は zsh で claude はその子孫＝`agent-console.config.json:39` なので、残ったのが古い claude 本人だと同じ会話が 2 本になる）。再起動後の休止中の窓（DormantTerminal）は控えが無いので見ない。
  5. 起動は既存の `restore()`（`sessions.ts:324-335`）と同じ道を通す: 役割の `restoreCommand` を使い、`AC_RESUME_ID` に休ませる前の `claudeSessionId` を渡し、`claudeSessionId` を引き継ぎ、`initialName` は付けない（名前は 4-2 の sleep で `s.name` に写したものをそのまま使う）。
  6. id は同じ: `spawnSession` の id の決め方（`sessions.ts:390`＝`!this.sessions.has(knownId) ? knownId : randomUUID()`）に「既にある Session が sleeping なら knownId を使う」を足す。`Map.set` は既にあるキーなら並び順を保つので、一覧の位置も変わらない。`remove()` を通らないので、Hub の未読は消えない（`hub.ts:134-140` が呼ばれない）。名前・チャットの予約は休ませる条件 3 で 0 件で、休止中は名前の変更も受け付けない（`hub.ts:263`）ので、起こす時点で予約は無い（審査 S5）。
  7. Map を新しい Session に上書きしたら、**古い Session の `clients` を全部閉じる**（`remove` の `sessions.ts:484` と同じ）。画面の端末は WebSocket が閉じたときにつなぎ直す（`src/components/TerminalPane/TerminalPane.tsx:282-288`）ので、同じ id で新しい窓につながる（N1。`ws.ts:26,36` は つないだ時点の Session に書き込むため、閉じないと古い窓に残る）。
  8. 起動に失敗したときは、`spawnSession` は端末が開けたあとにしか Map に入れない（`sessions.ts:391,431`）ので、古い Session（休止中）がそのまま残る。失敗を返し、`waking` の印を外す。
  - tmux に `ac-<id>` が残っていた場合は、既存の `probe` でつなぎ直す（`sessions.ts:446-448`）。
- **復元リスト（審査 C2）**: 次の 4 か所を変える。
  1. `OpenSessionItem` に `sleeping?: true`（`session-store.ts:15-23`）
  2. `parseItem`（`:27-38`）と `normalizeItem`（`:41-50`）が `sleeping: true` を通す（true 以外は捨てる）
  3. `OpenSessionRecorder.sync` の絞り込み（`restore.ts:74`）を `(!s.exited || s.sleeping)` にし、休止中の項目には `sleeping: true` を付ける
  4. `version` は 1 のまま。旧版は `sleeping` を捨てる（`normalizeItem` が知らない項目を持たない）ので、旧版へ戻すと休止中の窓も普通に開き直す（窓は失われない）
- **起動時の復元（審査 M4）**: `restoreOnStartup`（`restore.ts:106-163`）で `sleeping` の項目は次のとおり扱う。
  - 役割の照合（`:128`）と作業場所の照合（`:133`）は今までどおり行い、外れたら既存の案内（`unknownRole`・`missingCwd`）で外す
  - 上限の判定（`:138`）はかけない（休止中は数えない）
  - `known.add`（`restore.ts:142`）はしない。`reportOrphans`（本体 `sessions.ts:227`、呼び出し `restore.ts:156`）は今の一覧にある id をすべて「迷子でない」に入れる（`sessions.ts:230`）ので、休止中の窓の `ac-<id>` が残っていても迷子とは報告されない。残っていた分は wake のときに `probe` でつなぎ直す（`sessions.ts:446-448`）
  - 端末を起動せずに Session を作る新しい入口 `SessionManager.addSleeping(item)` を使う（`DormantTerminal` を持ち、exited 真・sleeping 真・同じ id・名前・作業場所・ブランチ・claudeSessionId）
  - `normalizeItem` が捨てるのは UUID でない `id` の**項目だけ**で、件そのものは残る（`session-store.ts:43`。古い保存は id なしで復元される＝`restore.ts:142,146`）。休止中の件で `id` が無いものは、同じ id で作れないので `notResumable` で外す（審査 Y1）。`claudeSessionId` が UUID でない、または役割に `restoreCommand` が無い休止中の項目は、起こしても会話を戻せないので外し、既存の案内（`unknownRole` と同じ並びの新しい理由 `notResumable`、`restore.ts:13` に足す）で知らせる
  - 起動の間隔（`restoreStaggerMs`）は空けない（claude を起動しないため）
- **HTTP**: `POST /api/sessions/:id/sleep`（`SessionSleeper.sleep`）、`POST /api/sessions/:id/wake`（`sessions.wake`）。
- **画面への配信（審査 M6）**: `Hub` に `setSleepInfo(fn: (id) => { sleepable: boolean; idleMinutes: number } | undefined)` を足し、`snapshot`（`hub.ts:710-731`）が各窓に `sleepable` と `idleMinutes` を載せる。`idleMinutes` は **5 分単位に切り捨て**（10 秒ごとに配信が増えないように。値が変わったときだけ `publish`）。`/api/state` と WebSocket（`hub.ts:748-756`）の両方に同じ値が出る。`src/types.ts` の `SessionView` に `sleepable`・`idleMinutes`、`SessionState` に `"sleeping"` を足す（サーバー側 `agents.ts:19` と `hub.ts:15-37` も同じ）。
- **自動で休ませる処理は作らない**（PO 決定「閉じる前に必ず確かめる」）。

### 4-3 画面（便2）
- 一覧の行: 候補の行に Badge「休ませられます（待機 45 分）」と「休ませる」ボタン。休止中の行は灰色の点（`StatusDot` の `STATE_LABEL_KEY`＝`StatusDot.tsx:5` に sleeping を足す）と「休止中」、「起こす」「外す」ボタン。
- 一覧の上: 候補が 1 本以上あれば Callout「休ませられる窓が N 本あります」＋「まとめて休ませる」ボタン。
- 確認: `ConfirmModal`。本文に対象の名前を全部並べ、「休ませた窓は『起こす』で同じ会話の続きから開き直せます。作業中の窓は対象にしていません」。まとめて休ませるときは 1 本ずつ `sleep` を呼び、409 になった窓は理由を並べて表示する（ほかの窓は続ける）。
- 満席: 作成・再開が「too many sessions」のとき、既存の失敗表示に「休ませられる窓が N 本あります」と「まとめて休ませる」ボタンを添える。
- 文言はすべて `t("ac.sleep.*")`・`t("ac.openCount")`。例外 2 つ（審査 S4）: 状態の表示名 `ac.state.sleeping`（`StatusDot.tsx:5` は全状態の表なので必須。`ja.json:22-29` の並び）と、復元の案内の理由 `notResumable`（サーバー `restore.ts:13`・画面の型 `src/types.ts:37`・文言 `ja.json:127-131` の並びの 3 か所に足す）。部品は SA の金型（Badge・Button・Callout・ConfirmModal）だけ。金型の props は `npm run sa-sync` で `.sa-cache` を展開してから確かめる（recon 未確認のため）。

- **409・400 の理由と文言の対応表（審査 Y4。ここが 1 か所の正）**: サーバーは理由の文字列を `error` に入れる（`http.ts:670-671`）。画面は `t("ac.sleep.reason.<理由>")` で引く（`descendants remain`・`session did not stop`・`too many sessions` は空白入りのため、画面側で `descendantsRemain`・`didNotStop`・`tooManySessions` に読み替える）。
  | 理由 | 出る所 | 文言（ja） |
  |---|---|---|
  | notIdle | sleep 条件 1・4 | 作業中か入力待ちのため休ませられません |
  | noResumeId | sleep 条件 2 | 会話の番号が分からないため休ませられません |
  | pendingWork | sleep 条件 3 | 送る予定の指示があるため休ませられません |
  | routine | sleep 条件 3 | 定期実行の見張り中のため休ませられません |
  | relay | sleep 条件 3 | 引き継ぎ中のため休ませられません |
  | subagentRunning | sleep 条件 4 | 裏で担当が動いているため休ませられません |
  | closing | sleep 条件 1・sleep 2 | 閉じている途中か休ませている途中です |
  | sleeping | close・remove・wake の最初 | 休ませている途中です。少し待ってください |
  | session did not stop | sleep 4 | 止められなかったので、窓は動いたままです |
  | descendants remain | sleep 4・wake 4.5 | 一部の処理が残っています。少し待ってから試してください |
  | missingCwd | wake 3 | 作業場所が見つからないため起こせません |
  | too many sessions | wake 3・作成・再開 | 開ける窓の上限に達しています |

## 5. 対象と対象外
- 対象: agent-console のサーバー（config・sessions・dormant-terminal〔新規〕・sleeper〔新規〕・restore・session-store・hub・agents・routine-closer〔公開関数 1 つ〕・relay〔公開関数 1 つ〕・http・index）、画面（types・SessionList・StatusDot・ConsolePage・RenameForm・chatLogic・PicksPane・DiffPane・`isInactive` の置き場〔新規 1 関数〕・ja.json）、試験、`agent-console.config.json`、CHANGELOG、版（便1 v0.47.0、便2 v0.48.0。`extension/manifest.json` も合わせる）。
- 対象外: 予約・定期実行・引き継ぎが満席で `full` になる既存の扱い、定期実行の自動クローズの判定、tmux の作り、メモリ計測、salesanchor リポジトリ、~/.claude 配下。窓の自動休止（作らない）。

## 6. 受入条件と検証方法
| 基準 | 検証方法 |
|---|---|
| K1 config に `maxSessions` を書くとその数が上限になる。書かなければ 16。2.5・0・"6" は起動中止 | 単体（config.test.ts）＋統合（harness に config の値を渡す口を足す＝今は options のみ `tests/unit/helpers/harness.ts:228`） |
| K2 上限に達すると作成・再開が 400。画面に「開いている N / M」と案内（便2 で「まとめて休ませる」ボタン） | 統合＋e2e（上限を下げた別のサーバー設定で行う。既存 e2e は上限 16 前提＝`console.spec.ts:542,949-951`） |
| K3 休止中の窓は上限に数えない。止まった（休止でない）窓は今までどおり数える | 統合（上限 2、1 本休ませると 1 本開ける。止まった窓 1 本では開けない） |
| K4 `sleep` は 4-2 の条件 1〜4 をすべて満たすときだけ成功。working・waiting・shell 役・sessionId なし・予約あり・定期実行追跡中・引き継ぎ中・裏の担当が動作中・取り直しで idle でない・閉じている最中 は 409（理由つき）で窓は動いたまま | 統合（偽 claude の状態ファイル・activity の記録で各条件） |
| K5 休ませると、その窓の端末と子孫のプロセスがすべて無くなり、一覧には同じ id・休ませる前の表示名で「休止中」として残る | 統合（子孫 pid の生存確認・名前の照合） |
| K6 起こすと、同じ id・同じ名前・同じ作業場所で、`AC_RESUME_ID`＝休ませる前の sessionId で起動し、一覧の位置が変わらず、未読が残る。満席なら 400、作業場所が無ければ 409 で休止中のまま。開いていた端末の接続は閉じられ、同じ id でつなぎ直すと新しい窓の出力が届く。同時に 2 回起こしても起動は 1 回 | 統合（偽 claude が受け取った環境変数・起動回数を記録。WebSocket をつないだまま wake して close を受け、つなぎ直して出力を受ける） |
| K7 再起動後、休止中の窓は claude を起動せずに休止中で一覧に戻る（同じ id）。動いていた窓は従来どおり開き直す。作業場所が無い休止中の項目は `missingCwd` で外れる | 統合（session-restore の既存試験に追加） |
| K8 待機（idle かつ裏の担当 0）が `sleepSuggestMinutes` 以上続いた窓だけ候補。途中で working・裏の担当あり・標本の途切れがあると数え直す。`idleMinutes` は 5 分単位 | 単体（標本を時刻つきで与える） |
| K9 自動で休ませる道が無い: `server/` で `sessions.sleep(` を呼ぶのは `server/sleeper.ts` の 1 か所だけ、`sleeper.sleep(` を呼ぶのは `server/http.ts` の 1 か所だけ | `grep -rn` の件数（試験に組み込む） |
| K10 実物の `agent-console.config.json` の roles に `sonnet-impl` が無く、`maxSessions` が 6 | 単体（実物の設定ファイルを読む試験。e2e は試験用の役割表＝`tests/fixtures/e2e-env.ts:143-146` で動くため使わない） |
| K11 文言はすべて t()、金型以外の部品 0 | `npm run lint`（design-governance） |
| K12 既存の試験・CI（ubuntu・macOS）がすべて緑 | CI |
| K13 `DormantTerminal` の pid -1 で `descendantPids` が空、kill を呼んでも何も起きない。休止中の窓の sessionId が `detectBreaks` で付け替わらない | 単体 |
| K14（導入後・実機）PO の Mac で、休ませた窓を起こすと同じ会話の続きが表示される | PO の目視＋設計者が `claude agents --json` の sessionId を休止前後で照合 |
| K15（導入後・実機）動いている claude の窓の CPU と RSS の合計を、導入前と休止後に記録する（基準値: 9 本で CPU 85.3%・RSS 932MB） | 設計者が `ps` の生出力をファイルに残す。**目標値は置かない。○×は「記録が残ったか」だけ**（4-4） |
| K16 休ませている最中（exited が真になったあと、子孫が消える前も含む）に close・remove・sleep・wake が来ると 409 で、窓が消えない・二重に動かない。exited が偽のまま止めきれなかったときは窓が動いたまま（sleeping 偽）に戻る。閉じている最中の sleep は 409。子孫が残ったときは休止中のまま 409。休ませる途中のどの時点で保存しても、復元リストに休止中の窓が残る。休止中の窓では名前の変更・チャット・よく使う指示・部品・差分の送信が開かず案内が出る | 統合（止める処理を遅らせる偽端末で close/remove/wake を割り込ませる。偽端末で exit を先に返し子孫だけ残す場面と、exit を返さない場面の両方、保存ファイルを途中で読む）＋e2e（休止中の行で各操作） |

### 4-4 効果の見込みについて（事実のみ）
- §1 の実測では、重い窓（CPU 32.1%・RSS 263MB など）と軽い窓（CPU 0.4%・RSS 19MB など）の差が大きい。休ませて軽くなる量は「休ませた窓がどれだけ使っていたか」で決まり、待機中の窓が軽ければ効果は小さい。どの窓が待機中だったかは §1 の実測に含まれないため、効果の大きさは未確認。K15 で記録する。

## 7. 代替案と選んだ理由
- A 一定時間で自動的に休ませる: 不採用。PO 決定「閉じる前に必ず確かめる」に反する。人が読んでいる最中の待機中の窓を止める恐れ。
- B 上限だけ入れて休止は作らない: 不採用。満席のとき人が窓を選んで閉じるしかなく、閉じた窓の sessionId が残らないため「過去の会話を再開」の一覧から探し直す手間が残る。
- C 休ませた窓を一覧から消し、別の「休止中リスト」ファイルに残す: 不採用。窓の情報の置き場が 2 つになる。今の復元リストに `sleeping` を足して 1 か所に保つ。
- D 休止中の窓の term を undefined にする: 不採用。`Session.term` は省略できない型で（`sessions.ts:66`）、`hub.ts` の 8 か所が exited を見ずに `term.pid` を読む（審査 C3）。term は残し、exited 真で既存の「止まった窓」の扱いに乗せる。
- E 起こすときに先に `remove()` してから開く: 不採用。Hub が未読・名前の予約・チャットの予約を忘れ、WebSocket も閉じる（`sessions.ts:484,487`、`hub.ts:134-140`）。同じ id で上書きする（4-2）。
- F 選んだ案: 上限の設定化＋人が確かめて休ませる＋同じ id・同じ会話で起こす。既存の `closeRunning`・`restore` の起動・`onAgentsSampled`・復元リストを使い、新しい部品は `DormantTerminal` と `SessionSleeper` の 2 つに限る。

## 8. リスクと対処
- 起こしたときに会話の続きが開けない（sessionId のずれ）: 条件 2 で sessionId が UUID のものだけ対象。K14 で実測。起動に失敗したら休止中のまま残し、失敗を表示する。
- 起こすときの読み込みのトークン消費: 会話の長さ次第で未確認。休ませるのは人の判断。
- 旧版へ戻したとき: 復元リストの `sleeping` は旧版が捨て（`session-store.ts:41-50`）、休止中の窓も開き直る＝窓は失われない。ただし上限（旧版は 16）を超える分は `overLimit` の案内で外れる。
- 上限 6 で予約・定期実行が `full` で開かない回が増える: 既存の扱い（記録して諦める）のまま。満席の件数は予約・定期実行の履歴で見える。設定で上限を変えられる。
- 休ませる直前に人が入力を始める: 条件 4 の取り直しで idle でなければ 409。取り直しから止めるまでの間（端末に止める合図を送るまでの短い間）に入力された分は失われうる（引き継ぎ＝relay と同じ程度の幅）。休ませる途中（exited が偽の間）は、サーバー側の入力の口（`snapshot` の `canInput`・`canChat`＝`hub.ts:725-726`、名前変更の取り直し＝`:262`、端末の WebSocket の入力＝`ws.ts:36`→`sessions.write`＝`:497`）は止めない。画面は `isInactive` で止める。今の close の途中と同じ扱いで、入力された分は失われうる（審査 X5）。引き継ぎ（`relay.start`）も exited だけを見て `isClosing` を見ない（`relay.ts:175,181`）ので、休ませる途中に始めると止まりかけの窓に書き込み、失敗で終わる。今の close の途中と同じで、これも受け入れる（審査 Y6）。
- 戻す場合でも止まった窓になることがある（審査 Y2）: 止める処理の最後の SIGKILL は根の pid にも届く（`sessions.ts:539`、`descendantPids` は根を含む＝`process-tree.ts:47`）。待ち（`:540`）が過ぎたあとに exited が真になると、sleeping 偽の「止まった窓」になり、復元リストから外れて会話の id が残らない。まれな場合として受け入れる（会話は「過去の会話を再開」から戻せる）。
- 休ませる途中で作業画面のサーバーが落ちる（審査 S8）: 止める前に `sleeping: true` を保存するので、tmux の `ac-<id>` が動いたまま休止中として戻ることがある。一覧にあるので迷子とは報告されない（`sessions.ts:230`）。起こすときに `probe` でつなぎ直す（`:446-448`）ので窓は失われないが、それまで上限に数えない claude が 1 本動く。これは受け入れる。

## 9. 戻し方
- 便1: `agent-console.config.json` の `maxSessions` を消せば 16 に戻る。`roles` に `sonnet-impl` を戻せば Sonnet の役割が戻る。版を戻す場合は前の版を導入し直す。
- 便2: 前の版を導入し直す（8 の「旧版へ戻したとき」）。

## 10. 工程
- 便1: 4-1 ＋ K1・K2（ボタン以外）・K10・K11・K12。導入直前に Opus が `sonnet-impl` の使用 0 件を再確認。
- 便2: 4-0・4-2・4-3 ＋ K2（ボタン）〜K9・K11・K12・K13・K16。導入後に K14・K15。
- 実装と試験はクラウド（Sonnet）で行う（PO 決定 2026-10-26「1」）。手元の Mac で担当を起動しない。
- 導入（更新）は、すべての窓が idle で waitingFor が無いときに行う（既存の更新の条件）。

## 11. 維持する担当・仕組み
- 上限と候補の時間は config の 2 項目だけ。変えるときは設定ファイルを直すだけ。
- 自動休止が無いこと（K9）と、旧版との互換（K7・8）は試験で固定する。

## 12. 外部事例
- Google Chrome の Memory Saver（2023 年 2 月、Chrome 110。Windows・macOS・Linux・ChromeOS）: 使っていないタブをメモリから外し、開いたときに読み込み直す。Google は「最大 40%・10GB のメモリ削減」と発表したと報じられている（一次資料の Google の文面は未確認。二次資料: techradar.com「Google Chrome gets memory and energy saver modes」、alternativeto.net 2022-12 の記事）。音声再生中・入力途中のフォームなどは外さない例外がある。
- 適用の限界: ブラウザのタブと Claude の会話では、外したあとに戻す費用（会話の読み込み直し）が違う。数値（40%）は Chrome の最良の場合の値で、本件の効果の証明には使わない。取り入れたのは「使っていないものだけを外し、見た目は残して、触れたら戻す」「作業中のものは例外にする」という作りだけ。

## 13. 審査
### 第1.0版
- 自己審査（同一 AI）: APPROVE としていた。
- 別の審査役（claude -p・Opus、detached の写し 15af5cb）: **REVISE**。生出力 /tmp/CC報告ファイル/window-limit/review1.txt。重大 3（C1 起こすと別 id になる・C2 休止中の印が保存されない・C3 端末を持たない Session が型と呼び出し元に合わない）、要修正 9（M1〜M9）、軽微 6（L1〜L6）。
### 第1.1版での対応
| 指摘 | 対応 |
|---|---|
| C1 | 4-2 wake: sleeping の Session は同じ id で上書き（`sessions.ts:390` の条件を足す）。remove を通らない。代替案 E を不採用に追記 |
| C2 | 4-2 復元リスト: 変更 4 か所（型・parseItem/normalizeItem・sync の絞り込み・版） |
| C3 | 4-0 を新設: term は残し exited 真・sleeping 真。再起動後は DormantTerminal（pid -1）。状態は sleeping を先に判定。休止中の行は「起こす」「外す」だけ。代替案 D |
| M1 | 4-2: 確認と計測は SessionSleeper（新規）、端末の操作は SessionManager。closer.isTracking・relay.isBusy を公開 |
| M2 | 4-2 条件 4: 直前に hub.checkInput で取り直し、activity の runningCount 0 を条件に。待機の計測も同じ条件 |
| M3 | 4-1: occupiedCount() を 3 か所にそろえる式を明記。止まった窓は今までどおり数える。名前は openCount |
| M4 | 4-2 起動時の復元: 照合は行う・上限はかけない・known.add しない・addSleeping の新設・間隔なし。wake で classifyCwd をかけ直す |
| M5 | 4-2 sleep 手順: 止める前に表示名を s.name へ写す |
| M6 | 4-2 画面への配信: Hub.setSleepInfo・5 分単位・types.ts の変更 |
| M7 | K10 を実物の設定ファイルを読む単体試験に |
| M8 | K9 を「sessions.sleep( は sleeper.ts だけ、sleeper.sleep( は http.ts だけ」に |
| M9 | §3 に手元の保存の grep 結果（sonnet-impl 0 件）、4-1 と §10 に導入直前の再確認 |
| L1 | `restore.ts:13` に直した |
| L2 | `session-store.ts:27-38`・`:41-50` に直した |
| L3 | parsePositiveInt を新設（整数の確認） |
| L4 | K2 の e2e は別のサーバー設定で |
| L5 | K1 に harness の口を足すと明記 |
| L6 | K15 は記録だけと明記 |

### 第1.1版
- 別の審査役（claude -p・Opus、detached の写し 81ddada）: **REVISE**。生出力 /tmp/CC報告ファイル/window-limit/review2.txt。前回の 18 件はすべて解消。新しい指摘は重大 2（N1 起こしても端末の画面が古い窓につながったまま・N2 起こすが 2 回届くと二重起動）、要修正 4（N3〜N6）、軽微 7（L-a〜L-g）。
### 第1.2版での対応
| 指摘 | 対応 |
|---|---|
| N1 | 4-2 wake 7: 上書き後に古い Session の clients を閉じる。K6 に追加 |
| N2 | 4-2 wake 2・4: waking の印、await 後の再確認。K6 に「2 回で起動 1 回」 |
| N3 | 4-2 sleep 1・2: stopTerminal を切り出し close と共用、sleep も closing に登録。K16 |
| N4 | 4-2 sleep 3〜5: 止める前に sleeping を付け、失敗で戻し、止めたら notify。K16 |
| N5 | 4-0 に 7 か所＋表 3 か所の扱い（isInactive・送れない案内）。§5 に追加。K16 |
| N6 | 4-2: storableName を通して s.name に写す。引用を relay.ts:63,186 に |
| L-a | 4-2 起動時の復元: reportOrphans の説明と引用を直した |
| L-b | 4-0: pid -1 の理由を直し、kill(-1) に届かないことを試験で固定 |
| L-c | 4-2 wake 5: restore() と同じ道（restoreCommand・AC_RESUME_ID・initialName なし） |
| L-d | 4-2 wake 8: 「Map に戻す」を消し、実物の振る舞いを書いた |
| L-e | 4-2 起動時の復元: 戻せない項目は notResumable で外して案内 |
| L-f | 4-2 待機時間: refresh() を待ってから読む |
| L-g | 4-0: 新しい処理を足さず試験で固定 |

### 第1.2版
- 別の審査役（claude -p・Opus、detached の写し 40b3b00）: **REVISE**。生出力 /tmp/CC報告ファイル/window-limit/review3.txt。前回の 13 件のうち 12 件解消・N3 一部残り。重大なし。要修正 3（R1〜R3）、軽微 8（S1〜S8）。
### 第1.3版での対応
| 指摘 | 対応 |
|---|---|
| R1 | 4-2 sleep 2: 最初に closing.has(id) なら 409（closing）。条件の理由と K4 に追加 |
| R2 | 4-2 sleep 2: 休ませ中の close は 409（sleeping）で待たない。K16 |
| R3 | §10 便2 に K16。表を K15 の次に並べ替え |
| S1 | 4-2 sleep 4: 端末が止まらない→戻す／子孫が残る→休止中のまま 409 |
| S2 | 4-2: 最大約 7 秒・上限を 1 本超えうることを受け入れると明記。§8 の「数百ミリ秒」を直した |
| S3 | storableName を session-store.ts へ移して export |
| S4 | 4-3: ac.state.sleeping と notResumable（3 か所）を例外として明記 |
| S5 | K6・wake 6 を「未読が残る」に直した |
| S6 | 4-0: SessionList.tsx:176 は isInactive に置き換える、に統一 |
| S7 | sessions.ts:81-87（40 字は :84）に直した |
| S8 | §8 にサーバーが落ちたときの 1 行を追加 |

### 第1.3版
- 別の審査役（claude -p・Opus、detached の写し 65408d3）: **REVISE**。生出力 /tmp/CC報告ファイル/window-limit/review4.txt。前回 11 件のうち 9 件解消・R2 と S1 は一部残り。重大なし。要修正 2（W1・W2）、軽微 5（X1〜X5）。
### 第1.4版での対応
| 指摘 | 対応 |
|---|---|
| W1 | 4-2 sleep 2: close・remove・wake の最初で「休ませ中」なら 409（exited より先に見る）。K16 に割り込みの場面 |
| W2 | 4-2 sleep 4: 失敗時の s.exited で分ける。stopTerminal の戻り値を決めた。close 側は変えない。K16 |
| X1 | TerminalPane の引用を src/components/TerminalPane/TerminalPane.tsx:282-288 に |
| X2 | 公開の isClosing(id) で書いた |
| X3 | onData を「何もしない」一覧に足した |
| X4 | addSleeping が exited を自分で付けること、即呼ぶのは念のため、を明記 |
| X5 | §8: 休ませる途中のサーバー側の入力の口は止めない、と明記 |

### 第1.4版
- 別の審査役（claude -p・Opus、detached の写し 175a0f8）: **APPROVE**（`VERDICT: APPROVE on 175a0f8797f63fdcf83bb219b208f7c776240651`）。生出力 /tmp/CC報告ファイル/window-limit/review5.txt。前回 7 件すべて解消。重大・要修正なし。軽微 7（Y1〜Y7）。
### 第1.5版での対応（軽微のみ。設計の筋は第1.4版から変えていない）
| 指摘 | 対応 |
|---|---|
| Y1 | 4-2 起動時の復元: id が無い休止中の件は notResumable で外す |
| Y2 | §8: 戻す場合でも止まった窓になりうることを受け入れる |
| Y3 | 4-2 wake 4.5: 残った pid が生きていれば 409 で起動しない |
| Y4 | 4-3 末尾に 409・400 の理由と文言の対応表を 1 か所 |
| Y5 | 4-0: ConsolePage.tsx:373 は置き換えない |
| Y6 | §8: 休ませる途中の relay も受け入れる |
| Y7 | relay.ts:180・180-185、ja.json:127-131 に直した |

### PO の決定
- 2026-10-26 PO「1」: この設計で作り始める（上限 6・候補は待機 30 分以上・休ませるのは人が確かめてから）。実装と試験はクラウド（Sonnet）、導入は設計者。
- 第1.5版の実装上の補足（設計の筋は変えない）: 一覧の見出しの文言キーは `ac.sessions` が既に文字列（`src/locales/ja.json:4`）なので、`ac.sessions.openCount` ではなく `ac.openCount` にする。
