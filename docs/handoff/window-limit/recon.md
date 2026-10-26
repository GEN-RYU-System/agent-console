# recon: 同時に開ける窓の上限と、使っていない窓の休止（window-limit）

基準: origin/main 21df257（package.json 0.46.2）。行番号はこの時点のもの。コードは変更していない（読み取りのみ）。
目的（PO）: Mac（メモリ8GB）で Claude の窓が9つ開いたままになり重い。「同時に開ける窓の数の上限」と「しばらく使っていない窓を休ませる（プロセスを終了し、あとで同じ会話の続きから開き直す）」を入れたい。この文書は設計（Opus）のための現状の事実だけを書く。推測は書かず、分からないことは末尾の「未確認」に集める。
用語: 「窓」＝ `SessionManager` のセッション（`server/sessions.ts:59` の `Session`）。実体は tmux のセッション `ac-<id>`（既定）か node-pty。

## 1. 窓を開く・閉じる・閉じる前の確認

### 1-1 サーバー側の入口（開く）
- 新規作成: `SessionManager.create` `server/sessions.ts:264`。上限判定は `:275`（`sessions.size + pending >= maxSessions` で `SessionInputError("too many sessions")`）。worktree 作成中の枠は `pending`（`:173`）で数える。HTTP 入口は `POST /api/sessions` `server/http.ts:206-211`。
- 過去の会話を選んで再開: `SessionManager.resume` `sessions.ts:293`（上限判定 `:296`）。HTTP は `POST /api/sessions/resume` `http.ts:290-296`。コマンドは役割の `resumeCommand`（id なしの `--resume`＝Claude 公式の選択リスト。`agent-console.config.json` の roles）。
- 前回の続きとして開く（復元・予約・定期実行・引き継ぎが共通で使う）: `SessionManager.restore` `sessions.ts:324`（上限判定 `:325` の `hasCapacity()`）。`claudeSessionId` が UUID でかつ役割に `restoreCommand` があれば、それを環境変数 `AC_RESUME_ID` つきで起動（`:326-331`）。
- アカウント切り替えの端末: `createAccountLogin` `sessions.ts:304`（上限判定 `:310`）。復元リストには入らない（`restore.ts:74` で除外）。
- 実際の起動は全部 `spawnSession` `sessions.ts:380` → `openTerminal` `:440`（tmux が使えれば `newSession`、だめなら node-pty の `spawn`）。
- 空き判定の公開関数: `hasCapacity()` `sessions.ts:316`。呼び出し元: `server/launch.ts:104`、`server/relay.ts:179,254`、`server/restore.ts:138`、`sessions.ts:310,325`。
- 上限の値: `DEFAULT_MAX_SESSIONS = 16`（`sessions.ts:15`）、`SessionManagerOptions.maxSessions`（`:43`）で上書き可。**config には対応するキーが無い**。本番の生成は `new SessionManager(config)` `server/index.ts:75`（options なし）。options で上書きしているのは試験だけ（`tests/unit/helpers/harness.ts:91,228`）。
- 上限超過のエラー: 作成・再開・復元は `SessionInputError("too many sessions")` → HTTP 400（`http.ts:662`）。引き継ぎ開始は `SessionConflictError("too many sessions")` → 409（`relay.ts:179`、`http.ts:670`）。予約・定期実行は例外でなく結果 `"full"`（`launch.ts:104`）。
- 画面側の「満席」文言: `src/locales/ja.json:119`（`ac...full`＝「セッションの数が上限のため、新しいセッションを開けませんでした」）、`:278`（定期実行の履歴）、`:351`。

### 1-2 サーバー側の入口（閉じる）
- 閉じる（動いている窓）: `SessionManager.close` `sessions.ts:509` → `closeRunning` `:523`。手順: 子孫 pid を先に控える（`:525`）→ `term.kill()`（SIGHUP 相当。tmux は `kill-session`、`tmux-terminal.ts:279-288`）→ 猶予 `closeGraceMs`（既定 5000ms、`sessions.ts:21`、`:188`）で終了を待つ → 終わらなければ子孫へ SIGKILL（`:532-543`）→ `remove()`。pid が 0 の端末は何も殺さず `SessionConflictError("session did not stop")`（`:533-537`）。
- 止まっている窓を一覧から外す: `SessionManager.remove` `sessions.ts:480`（動いている窓は `SessionConflictError`）。HTTP は `DELETE /api/sessions/:id` `http.ts:237-241`。
- HTTP の閉じる入口: `POST /api/sessions/:id/close` `http.ts:299-308`（コメント「確認は画面で行う」`:304`）。サーバー側に確認や強制フラグは無い。
- 閉じたあとの通知: `remove()` が `removedListeners` を呼ぶ（`sessions.ts:487`）。`Hub` は未読・前回 status などを忘れる（`hub.ts:134-141`）。
- サーバー停止時: `killAll()` `sessions.ts:546` は `term.release()` を呼ぶ。tmux 端末では `release()`（`tmux-terminal.ts:290-`）は control client を外すだけで tmux のセッションは残る（更新しても切れない仕組み）。`index.ts:156-169` の `shutdown` が `beginShutdown()` → `killAll()`。
- 自動で閉じる既存の仕組み: 定期実行の `closeWhenIdle`（`server/routine-closer.ts`）。idle が連続して累計 10 分（`CLOSE_IDLE_MS` `:8`）で `sessions.close`（`index.ts:102`）。対象は「定期実行が開いた窓」だけ（`track` `routine-closer.ts:42`）。返答に `NEEDS_DECISION:`/`BLOCKED:` があるか返答なしなら閉じない（`finish` `:76-80`）。waiting が 60 分続くと kept（`:10`、`sample` `:60-61`）。サンプルの間隔が `gapLimitMsFor(agentsPollMs)`（最小 60 秒）を超えたら unknown 扱い（`:35`、`:53-54`）。

### 1-3 閉じる前の確認（画面側）
- 確認は画面の `ConfirmModal`（`@sa/components/ConfirmModal`）。`src/pages/ConsolePage.tsx:640-649`（title `ac.close.title`、本文 `ac.close.body`、`danger`）。文言 `src/locales/ja.json:97-104`: 本文は「{{name}} を閉じますか？ 動いている作業は止まります。会話は「過去の会話を再開」から戻せます。」。
- 流れ: 行の × ボタン `SessionList.tsx:176-190`（`data-testid="close-session"`、`state !== "stopped"` の行だけ `:176`）→ `onClose` → `ConsolePage.tsx:511-513`（`setCloseTargetId`）→ 確認 → `handleConfirmClose` `:268-274` → `closeSession(id)` `src/api.ts:60`。失敗は `closeError`（`:186`）に出す。
- 引き継ぎ（relay）にも別の確認 `ConsolePage.tsx:650-657`。これは古い窓を閉じない（`relay.ts` 末尾コメント「古いセッションは閉じない」）。

### 1-4 新規作成・再開の画面側
- 新規: `handleCreate` `ConsolePage.tsx:249-261` → `createSession` `api.ts:52`。フォーム `src/components/NewSessionForm/NewSessionForm.tsx`（`ConsolePage.tsx:676` の Modal）。
- 再開: `openResumePicker` `ConsolePage.tsx:327`、`handleResume` `:340-353` → `resumeSession` `api.ts:78`。部品 `src/components/ResumePicker/ResumePicker.tsx`（Modal `ConsolePage.tsx:673-675`）。再開先の一覧 `GET /api/resume-targets` `http.ts:286`（本店と `git worktree list`、`server/resume-targets.ts:66-83`）。

## 2. 再起動・更新後の復元と、閉じた窓を続きから開き直す経路

- 復元リスト: `<dataDir>/open-sessions.json`（`session-store.ts:10`）。既定 dataDir は `~/Library/Application Support/agent-console`（`config.ts:37`）。形式 `{version:1, items:[{id?, roleId, name, cwd, branch?, claudeSessionId?}]}`（`session-store.ts:11-12,16-26,67`）。書込は直列・一時ファイル 600・rename（`:75-87`）。壊れた・版違いのファイルは読めず、上書きもしない（`:84`）。
- 記録係 `OpenSessionRecorder` `restore.ts:32-`: `sessions.onChange` のたびに「今開いている（`exited` でない・アカウント切替でない）窓の写し」を作り直して保存（`start` `:42-`、`sync` `:65-`）。サーバー停止中（`beginShutdown` 後）と復元中（`hold`）は書かない（`canWrite` `:60-62`）。**閉じた窓は次の同期で一覧から消えるので、「閉じた窓」の記録はこのファイルには残らない**（`sync` が `sessions.list()` の写しを保存するため。`restore.ts:72-85`）。
- 起動時の復元 `restoreOnStartup` `restore.ts:106-163`: 各項目の cwd を本店か `git worktree list` に照合（`:133`）→ 上限なら理由 `overLimit`（`:138-141`）→ `restore()` で開く（`:146`）。新しい claude を起動するときだけ `restoreStaggerMs`（既定 3000、`config.ts:36`、設定ファイル `agent-console.config.json`）の間隔を空ける（`:144-145`）。tmux に生きている `ac-<id>` があればつなぎ直す（`sessions.ts:447-452` の `probeSession`）。開き直せない理由は `missingCwd/unknownRole/startFailed/overLimit/unreadable`（`restore.ts:12`）で、`hub.setRestoreNotices` で画面の案内になる。
- 有効条件: `AGENT_CONSOLE_RESTORE` が `"off"` でなく、かつ `AGENT_CONSOLE_PORT` 未設定のときだけ（`isRestoreEnabled` `restore.ts:168-169`）。起動呼び出し `index.ts:149`（復元の完了後に予約の時計が動く `:151`）。
- `claudeSessionId` の取得: `Hub.detectBreaks` が `claude agents --json` の pid を窓の子孫プロセスと照合して `sessions.setClaudeSessionId` に渡す（`hub.ts:573`）。UUID 形式のみ受理（`sessions.ts:338-343`、正規表現 `:25`）。窓が閉じると `Session` ごと消えるのでメモリ上の値も消える。
- 続きから開く命令（config 固定）: `roles[].restoreCommand`（`agent-console.config.json`、例 `ccopusgo --resume "$AC_RESUME_ID"`、`claude --model sonnet --resume "$AC_RESUME_ID"`）。型 `config.ts:14-19`。`shell` 役には無い（通常の `command` で開く）。id は環境変数で渡し、コマンド文字列に連結しない（`sessions.ts:320-322` のコメント）。
- 既存の「閉じた窓を戻す」経路: 画面の「過去の会話を再開」（`resume`＝id なしの `--resume`）。会話は Claude 公式の選択リストで人が選ぶ（`resume-targets.ts:13` コメント）。`ja.json:97-104` の閉じる確認文もこの経路を案内している。**id を指定して特定の会話を開き直す HTTP 入口は、復元（起動時）と `restore()` を使う予約・定期実行・引き継ぎ以外には無い**（`http.ts` に `claudeSessionId` を受け取る作成系ルートは無いことを grep で確認）。
- 窓の識別子の二重性: アプリの `Session.id`（tmux 名 `ac-<id>`、`isSessionId`＝UUID 形式 `sessions.ts:27-30`）と Claude の `claudeSessionId`。`restore({id})` で同じアプリ id を引き継げる（`sessions.ts:331`、`spawnSession` の `knownId` `:388-391`）。

## 3. 窓の状態の取り方と「最後に動いた時刻」

- 取得: `Hub.start` が `startPolling(() => this.pollAgents(), config.agentsPollMs, …)`（`hub.ts:145`、`poll.ts` は「前回の完了後に次を予約」＝多重起動なし）。`pollAgents` `hub.ts:170-177` は `fetchAgents` → `detectBreaks` → 名前の予約送信 → `publish` → チャット送信。
- 外部コマンド: `claude agents --json`（`agents.ts:117-122`、timeout 15000ms、maxBuffer 8MB）。失敗・不正出力は `null`（状態「不明」。前回値は保持しない `hub.ts:160-167`）。
- 設定: `agentsPollMs`＝10000（`agent-console.config.json`、必須の正の数 `NUMBER_KEYS` `config.ts:133`）。10 秒に変えた経緯 `docs/handoff/agents-poll-10s/design.md`。
- 状態の型: `AgentStatus = busy|waiting|idle|unknown`（`agents.ts:6`）→ 窓の状態 `SessionState = working|waiting|idle|no-claude|stopped|unknown`（`agents.ts:19`、変換 `stateForSession` `:105-115`）。waiting は `waitingFor`（許可プロンプト・質問）つき（`:10-13`）。窓と Claude の対応は、窓の pty の子孫 pid に `claude agents` の pid が含まれるか（`agentForSession` `agents.ts:61-64`、子孫は `process-tree.ts:40-60`）。
- 配信: `Hub.snapshot` `hub.ts:708-` が `SessionView`（`hub.ts:15-37`: id/name/roleId/branch/cwd/state/createdAt/unread/hasClaude/canInput/canChat/pendingName/ci/claudeSessionId）を作り、WebSocket `/ws/events` で購読者へ（`subscribe`/`publish` `hub.ts:738-757`、`ws.ts:90`）。画面は `/api/state`（`http.ts:172-186`）でも取れる。
- **窓ごとの「最後に動いた時刻」を持つ場所**:
  - `Session`・`SessionView` には無い（型 `sessions.ts:59-78`、`hub.ts:15-37`）。`createdAt`（作成時刻）だけ。
  - `BreakTracker`（`notify.ts:45-80`）は前回 status と未読数だけ。時刻は持たない。
  - `ActivityStore.view(claudeSessionId).lastEventAt` はある（`activity.ts:66-70,362,527`）。値は hooks が書く `activity/events-YYYYMMDD.jsonl` の最新イベント時刻（`apply` `activity.ts:358-363`）。キーは **Claude の sessionId**（アプリの id ではない。`activity-routes.ts:17-22`: `claudeSessionId` が未取得なら `noSession`）。保持日数 `activityKeepDays`（`config.ts:51,318`）を過ぎたセッションは捨てる（`activity.ts:352-355`）。hooks が入っていない環境では記録が無い（点検 `checkHooks`、`activity-routes.ts:22`）。
  - `RoutineCloser` の `idleMs`（`routine-closer.ts:29,52-53`）は定期実行が開いた窓の追跡中だけ、メモリ。
  - `Hub.onAgentsSampled`（`hub.ts:181-184`）は標本ごとに「アプリ id → SessionState」を渡す（`emitSample` `:186-189`）。窓ごとの idle 継続を数えたければ、この購読が既存の手がかり（`index.ts:107` が `closer.sample` に繋いでいる）。
  - 端末の出力（`ring` への書き込み `sessions.ts:407`）と、人の入力（`write` `sessions.ts:496`、WS の `message` `ws.ts:29-37`）は時刻を記録していない。

## 4. 窓ごとのメモリ・CPU の測定

- ある。`server/memory.ts` の `MemoryCollector`（`:157-`）。窓ごとは「pty の pid の全子孫の RSS 合計」（`sessionMemory` `:115-127`、`ps -axo pid=,ppid=,rss=,%cpu=` `process-tree.ts:62-65`）、CPU は子孫の %cpu 合計 ÷ コア数。型 `SessionMemory {id,name,rssMb,cpuPercent,ramPercent}`（`memory.ts:17-25`）。Mac 全体は `sysctl hw.memsize`＋`memory_pressure`（`readSystemMemory` `:129-142`）と Disk（`statfs` `:83-89`）。2 秒キャッシュ・同時要求は 1 回にまとめる（`CACHE_TTL_MS` `:144`、`raw` `:176-`）。
- 定期計測: `metricsPollMs`（既定 2000、設定ファイルも 2000。`config.ts:46,313`）。`index.ts:122-134` が `memory.measure` を呼び、`session-metrics.json`（`<dataDir>`、キーは claudeSessionId、30 秒で古い扱い `hooks/ac-statusline.mjs:14-17,134-142`）へ書く（statusline 用）。
- 画面: `GET /api/memory` `http.ts:254-258`（名前は Claude の表示名）。画面の部品 `src/components/MacMeter/MacMeter.tsx`（下の帯の Mac 全体 CPU/RAM/Disk、`fetchMemory` `:62`、`MEMORY_REFRESH_MS = 2000` `MemoryPanel.tsx:10`）と `src/components/MemoryPanel/MemoryPanel.tsx`（セッションごと。ボタンは v0.37.0 で非表示、部品と API は残置＝`docs/handoff/pc-meter/design.md` §2 の表）。試験 `tests/unit/pc-meter.test.ts`、`tests/unit/session-metrics.test.ts`、`tests/e2e/pc-meter.spec.ts`。
- 設計書: `docs/handoff/pc-meter/design.md`（`card.md` と `evidence/` も同じ階層）。`recon.md` は無い。

## 5. 設定（config）の読み方・項目・既定値の置き場

- 読み込み: `loadConfig` `config.ts:388-` → `parseConfig` `:262-`。ファイルは `defaultConfigPath()` `:376-378`（環境変数 `AGENT_CONSOLE_CONFIG`、なければ `process.cwd()/agent-console.config.json`）。`AGENT_CONSOLE_PORT` でポートだけ上書き（`applyPortOverride` `:381`）。`index.ts:72` で一度だけ読む（再読み込みなし）。型 `Config` `config.ts:62-`。
- 検証の作法: 必須キー欠落・型違いは起動中止（例外、`parseConfig` `config.ts:262-`）。必須: 文字列 `salesanchorRoot,newWorktreeScript,ledgerLookupScript,ledgerDir,claudeBin`（`STRING_KEYS` `:132`）、正の数 `port,agentsPollMs,ledgerPollMs,ringBufferBytes`（`NUMBER_KEYS` `:133`）、`roles`（空でない配列）。任意項目は `parsePositive(raw, key, fallback)` `:203-207` などで既定値つき。
- 既定値の置き場: `config.ts:35-58` の `export const DEFAULT_*`（例 `DEFAULT_RESTORE_STAGGER_MS`、`DEFAULT_METRICS_POLL_MS`、`DEFAULT_PR_POLL_MS`、`DEFAULT_ACTIVITY_KEEP_DAYS`、`DEFAULT_RELAY_HANDOFF_TIMEOUT_MS`）。**例外**: セッション数の上限 `DEFAULT_MAX_SESSIONS=16` と閉じる猶予 `DEFAULT_CLOSE_GRACE_MS=5000` は `sessions.ts:15,21` にあり config を経由しない。定期実行の閉じ待ち `CLOSE_IDLE_MS` などは `routine-closer.ts:8-10` の定数。
- 項目一覧（`config.ts:62-130` の `Config` と実ファイル `agent-console.config.json`。★は実ファイルに書いてある）: `port★ salesanchorRoot★ newWorktreeScript★ ledgerLookupScript★ ledgerDir★ claudeBin★ agentsPollMs★(10000) ledgerPollMs★(60000) ringBufferBytes★ roles★ routineManagerRoles reserveRoles accountLoginCommand★ dataDir notify★ terminalEnv★ restoreStaggerMs★(3000) terminalHost tmuxPath tmuxSocket diffBaseRef★ diffMaxFileBytes★ diffSendMaxBytes★ pasteSubmitDelayMs★ ghBin★ prPollMs★ metricsPollMs★(2000) prRefreshMinMs★ pickMaxKeep★ pickSendMaxBytes★ pickHtmlInPromptChars★ activityKeepDays★ claudeSettingsPath terminalSmoothScrollMs★ terminalRenderer★ uploadMaxBytes★ uploadMaxKeep★ relayDir relayHandoffTimeoutMs`。`roles[]` の項目: `id labelKey command needsWorktree resumeCommand resumeScope restoreCommand reservable`（`config.ts:5-20`、検証 `parseRole` `:141-`）。
- 画面へ渡る設定: `/api/state` が `roles`・`terminalSmoothScrollMs`・`terminalRenderer`・`uploadMaxBytes`・`accountSwitchEnabled` などを返す（`http.ts:172-186`）。上限の値は画面に渡していない。
- 試験: `tests/unit/config.test.ts`。

## 6. 予約・定期実行が窓を新しく開くか、上限との関係

- 開く。予約も定期実行も共通の `launchAndSend`（`launch.ts:98-113`）で `sessions.restore({...manualInitialName:true})` を呼ぶ（`:107`）。呼び出し: 予約 `reservations.ts:289`（`dispatch` `:285-`）、定期実行 `routines.ts:156`。
- 上限との関係: `launchAndSend` は開く前に `hasCapacity()`（`launch.ts:104`）が false なら `{outcome:"full"}` を返すだけ（待たない・再試行しない）。結果は予約の `outcome`（`reservations.ts:58` の `OUTCOMES` に `full`）と定期実行の events（`routines.ts:38`）に記録される。画面の文言 `ja.json:278`（「上限のため開かなかった」）。`restore()` 自身も `:325` で再判定し `SessionInputError`（`launch.ts` 側で `relay.ts:261` のように文字列 `"too many sessions"` で判別する書き方もある）。
- 順番待ち: 予約と定期実行は `ScheduleGate`（`server/schedule-gate.ts:47`、`index.ts:81` で共有）で 1 時間の関門に並ぶ。起動時の復元が終わってから予約の時計が動く（`index.ts:151`）。
- 数の上限（別物）: AI が作る予約の保留は `MAX_AGENT_PENDING = 20`（`reservations.ts:25`、超過は `SessionInputError("too many pending agent reservations")` `:215`）。全体の保留 `MAX_PENDING = 50`（`:24`、判定 `:214`）。AI が作る有効な定期実行は `AGENT_ENABLED_LIMIT = 10`（`routines.ts:18`、`RoutineLimitError` `:25`）。これらは「窓の数の上限」とは独立で、窓の数を見ていない。経緯 `docs/handoff/agent-pending-20/design.md`。
- 予約・定期実行で開いた窓の後始末: 予約には自動で閉じる仕組みが無い（`closeWhenIdle` は定期実行だけ。`routines.ts:40,77`）。定期実行の `closeWhenIdle` の窓は idle 10 分で閉じる（1-2 参照）。
- 引き継ぎ（relay）も `restore()` で新しい窓を開く（`relay.ts:259`）。古い窓は閉じないので、引き継ぎのたびに窓が 1 つ増える（`relay.ts` の「6 完了。古いセッションは閉じない」）。開始前に `hasCapacity()`（`:179`）。

## 7. 画面側の部品

- 窓一覧: `src/components/SessionList/SessionList.tsx`（`interface Props` `:18-`: `sessions, roles, selectedId, onSelect, onRemove, onRename, onClose, onMove, relayBusyIds, onRelay`）。ConsolePage の組み込み `ConsolePage.tsx:499-`。状態の点 `src/components/StatusDot/StatusDot.tsx`（`STATE_LABEL_KEY` `:5`）。未読バッジ・CI バッジ（`CI_BADGES` `SessionList.tsx:12`）。ドラッグで並べ替え。型 `src/types.ts` の `SessionView`。
- ボタン等は SA の金型 `@sa/components/*`（`.sa-cache/frontend/src` へ展開、`tsconfig.json:16`、`vite.config.ts:5-9`、`scripts/sa-sync.mjs`）。`src` 内の import 回数（テスト除く）: Button 23、Callout 24、Badge 14、Stack 11、EmptyState 11、TextField 8、Card 5、Select 5、Textarea 5、Modal 4、ProgressBar 4、Tabs 2、ConfirmModal 1（`ConsolePage.tsx:6`）、IconToggleButton 1。SessionList は `Badge/Button/EmptyState/Stack` を使い、アイコンは `lucide-react`（`SessionList.tsx:2`）。デザインの遵守は `npm run lint`（`scripts/check-design-governance.mjs`、試験 `tests/unit/design-governance.test.ts`）。
- i18n: ある。`react-i18next`、日本語のみ。`src/i18n.ts:18-23`（`@sa/locales/ja.json` と `src/locales/ja.json` を深くマージ、`lng: "ja"`）。キーは `ac.*`（例 `ac.close.*` `ja.json:97`、`ac.memory.*` `:207`、`ac.resume.*` `:223`）。コンポーネントは `useTranslation().t(...)`。
- ConsolePage の窓の開閉まわりの状態: `closeTargetId/closeError`（`:185-186`）、`resumeOpen/resumeItems/resumeBusyPath/resumeError`、`formOpen/busy/formError`。下の帯の Mac 計: `<MacMeter />` `ConsolePage.tsx:620`。

## 8. 試験の置き場所と種類

- 単体・統合（vitest）: `tests/unit/**/*.test.{ts,tsx}` と `src/**/*.test.{ts,tsx}`（`vitest.config.ts:12`、globals: true、`npm test`）。統合は `*.integration.test.ts` で、本物のサーバーを `tests/unit/helpers/harness.ts` の `startHarness` で立てる（オプション `maxSessions`・`closeGraceMs`・`recorder`・`accountLoginCommand` など `:91,228`）。`tests/unit/` に 89 ファイル。コンポーネント試験は各コンポーネントの隣（例 `src/components/SessionList/SessionList.test.tsx`、`src/pages/ConsolePage.test.tsx`）。
- e2e（Playwright）: `tests/e2e/*.spec.ts`、プロジェクトは app/tmux/picker（`playwright.config.ts:26-31`）。`npm run test:e2e`。claude の代わりに `tests/fixtures/claude-stub.sh` を使う（状態は `STUB_STATUS_FILE`）。
- 窓の開閉を扱う既存試験:
  - `tests/unit/session-restore.integration.test.ts`: 閉じる（SIGHUP の道 `:76`、`/close` が 200→404 `:119-121`、`:145`）、閉じると復元リストから消える（`:184-188`）、再起動後の復元、`overLimit`（`:348`）など。
  - `tests/unit/sessions-close-pid0.test.ts`: pid 不明の端末は殺さない（`:40`）。
  - `tests/unit/restore-guard.test.ts`、`tests/unit/session-store.test.ts`（復元リストの読み書き）、`tests/unit/tmux-host.integration.test.ts`・`tmux-fallback.test.ts`・`tmux-terminal-fake.test.ts`（tmux 端末）、`tests/unit/routine-closer.test.ts`（自動クローズ）、`tests/unit/routines.test.ts`・`reservations.test.ts`（`full` の扱い）、`tests/unit/account.integration.test.ts`（`maxSessions: 2` で上限 `:22,80`）、`tests/unit/daily-use.integration.test.ts`（`maxSessions: 40` `:27`、再開 API）、`tests/unit/resume-targets.test.ts`。
  - e2e: `tests/e2e/console.spec.ts:948-` 「閉じるボタン→確認画面→やめる／閉じる」。セッション数の上限 16 に達するので先頭の窓を閉じて枠を空ける書き方が既にある（`:949-951`、補助関数 `ensureRoom` `:972`）。`tests/e2e/relay.spec.ts`、`tests/e2e/tmux.spec.ts`。
- 注意: e2e の他の試験は「上限 16」を前提に枠を数えている（`console.spec.ts:542,949-951`）。

## 9. 設計書・recon の書式の例

- 置き場: `docs/handoff/<仕事>/design.md`・`recon.md`・`card.md`（Sonnet への作業票）。履歴は `docs/CHANGELOG.md`。
- recon の例: `docs/handoff/ac-hardening/recon.md`（先頭に基準 commit と行番号の時点、「事実（実物で確かめたもの）」の箇条書き、各項目に根拠の file:line または生出力のファイル名）。ほかに `docs/handoff/keep-sessions/recon.md`（【事実】【推測】【未確認】ラベル、範囲は「事実と選択肢の材料だけ」）、`docs/handoff/session-relay/recon.md`。
- 設計書の例: `docs/handoff/session-relay/design.md`（章: 1 目的 / 2 対象と対象外 / 3.. 各案 / 6 代替案と選んだ理由 / 7 リスクと対処 / 8 戻し方 / 10 工程 / 11 実装の約束（Sonnet 向け） / 審査への対応が版ごとに追記）。`docs/handoff/pc-meter/design.md`（1 目的に PO の言葉、2 変更前→後の表、3 事実（根拠）、版は「第1.0版」と状態を先頭に書く）。
- 版管理: 機能の追加は `package.json` の version を上げ、`docs/CHANGELOG.md` に 1 項目（例 0.34.0 ac-hardening）。`extension/manifest.json` も版を合わせる（`docs/handoff/agents-poll-10s/design.md:19` の記述）。

## 設計に効きそうな事実の要約（推測は含めない）

1. 上限は 1 か所（`SessionManager` の `maxSessions`、既定 16）で全入口が使う。config には無く、本番は options を渡していない（`index.ts:75`）。8GB の Mac で 9 窓が開いている現状は、既定 16 の下で起きている。
2. 閉じた窓は `Session` ごとメモリから消え、復元リスト（`open-sessions.json`）も「今開いている窓の写し」なので、閉じた窓の `claudeSessionId` はどこにも残らない。続きから開き直す仕組み（`restoreCommand`＋`AC_RESUME_ID`＋`restore()`）自体は既にある。
3. 窓の状態は `agentsPollMs`（10 秒）の標本。窓ごとの「最後に動いた時刻」は、アプリの `Session` には無く、`ActivityStore.lastEventAt`（Claude の sessionId がキー、hooks 依存）にだけある。`onAgentsSampled` で標本ごとの状態を購読できる。
4. 窓ごとの RSS/CPU は 2 秒周期で既に測っている（`MemoryCollector`）。
5. 予約・定期実行・引き継ぎは満席のとき `full` で諦める（待たない）。

## 未確認

- 実機（PO の Mac）の挙動: 窓 1 つあたりの実際のメモリ量、9 窓で 8GB が逼迫する内訳（`claude` 本体か tmux か zsh か）。この環境は Linux のクラウドコンテナで、`ps`/`memory_pressure`/`claude agents --json`/tmux の実測はしていない。
- `.sa-cache`（SA の金型の実体）が展開されていないため、`@sa/components/ConfirmModal`・`Button`・`Badge` などの props、`@sa/locales/ja.json` の中身は未確認（使い方は既存の import 箇所から読んだだけ）。
- `claude agents --json` が返す `sessionId` と、`--resume <id>` で再開できる会話 id が常に同一か（コード上は `setClaudeSessionId`→`AC_RESUME_ID` で渡している。再開に成功した実測は本 recon では未実施）。会話の記録が Claude 側に残る期間・条件も未確認。
- `claude --resume <id>` で開き直したときの、コンテキストの再読み込みにかかる時間・トークンの消費（休止→再開のコスト）。
- `claude` が動いていない窓（`shell` 役、`no-claude` 状態）に `claudeSessionId` があるか、休止の対象にしてよいか（`shell` 役に `restoreCommand` は無い `agent-console.config.json`）。
- 作業中（`busy`）・許可待ち（`waiting`）・チャット予約や名前の予約が残っている窓（`hasPendingWork` `hub.ts:245`）を休ませたときの影響の実測。
- `ActivityStore.lastEventAt` が hooks 未導入・記録の取りこぼしのときに更新されない範囲（`checkHooks` の判定条件の全体は読んでいない）。人が端末へ入力しただけでイベントが記録されるかも未確認（`UserPromptSubmit` の扱いは `activity.ts:470` の `applyPrompt` 付近を見ただけ）。
- tmux の窓を `kill-session` したあと同じ `ac-<id>` 名で `restore({id})` したときの競合（`probeSession` が `gone` を返す前提）の実測。
- 同時に開く窓の数の上限を実行時に変えたときの `/api/state` と画面の追従（現状、画面に上限値を渡す項目が無いため）。
- 試験ファイル 89 本の全てには目を通していない。窓の開閉に関する既存試験は grep で拾ったもので、漏れの可能性がある。
- 画面側 `ConsolePage.tsx` の全体（700 行超）は、窓の開閉に関わる部分しか読んでいない。
