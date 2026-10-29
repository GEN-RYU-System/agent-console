# 便2b-3c 件のセッションを本体ごと部屋（Seatbelt）に入れ、外への通信を受付1か所に絞る（v0.48.0）作る係への指示書

- 設計: `docs/handoff/discord-pdca/room-design.md` 第8.1版（審査 APPROVE・PO の実装の承認と board-guard を外す承認は 2026-10-29。冒頭の状態の行）の §4-1〜§4-6・§6・§9。親 `docs/handoff/discord-pdca/design.md` 第24版。ADR-1039（Sales Anchor・Accepted）
- 目的: ①件のセッション（役割 `discord-case`。`caseSandbox: true`）の claude 本体・見張りのフック・Bash の子を、`/usr/bin/sandbox-exec -f <dataDir>/cases/<id>/room.sb` の1つの部屋の中で動かす。②外への通信をサーバーの中の受付（`127.0.0.1:18124`）1か所に絞り、`api.anthropic.com` は本体の pid にだけ通す。③本体の状態の置き場を件ごとの case-home に替え、ログインは専用の鍵（Keychain から起動関数が取る）で行う。④活動の記録を、件のフックからはサーバーの新しい入口へ送らせ、サーバーが今と同じファイル・同じ形で書く。⑤部屋・受付・case-home・macOS の版・claude の道・tmux のどれかが欠けたら件を開かない（503）
- この便に入れないもの: 本物のセッションを開く試験（G1〜G7 の実測・K11・K13・K17。マージのあとに設計者が手元で行う。お金が掛かる）、ac-case（便3）、件の鍵 `case-token`（便3）、終わった件の case-home の片付け（便2b-4。作成の途中の失敗の片付けはこの便）、ログインの鍵の期限の知らせ（便2b-4 の点検に入れる）、srt の版の月1回の点検（便2b-4）。ほかの役割（opus-designer・shell）の起動の形・フック・振る舞いは変えない。`maxSessions` の振る舞いも変えない
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `feat: case room sandbox and proxy (v0.48.0)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・テストが今の形で書けない、のどれかに当たったら、推測で埋めず、そこで止めて「何が・どこで（file:line）・何を試したか」を報告する

## 調べた実物（行番号は origin/main 50de8d5 = v0.47.2）

- `server/case-sandbox.ts`: import :3-8（`addHandlers` は ./activity-hooks.ts :7）・`CaseSandboxUnavailableError` :10・定数 :12-15・`CaseParams` :17-36・`casePaths` :49-64・`CASE_DENY_WRITE` :66-79・`CASE_DENY_READ` :81-91・`CASE_DENY_READ_SANDBOX` :94-102・`CASE_ALLOW_WRITE` :104・`caseNodeHome` :107-113・`CASE_ALLOW_READ` :116-129（git の設定のファイル4つは :123-126）・`CASE_ALLOWED_DOMAINS` :131・`buildCaseSettings` :136-178（`addHandlers({}, …)` は :139、件の見張りの組は :141-144、`sandbox` の塊は :158-175）・`caseDirOf` :181・`writeCaseFiles` :192-228（片付けの並び `made` :198、push :203・:208・:212、catch :224-227）・`removeCaseFiles` :231-240
- `server/activity-hooks.ts`: `HookSpec` :35-46（引数の欄は無い）・`HOOK_SPECS` :53-72（board-guard は :71）・`specHookPath` :91-93・`buildHandler` :96-102・`isOwnHandler` :104-108・`addHandlers` :164-207
- `server/sessions.ts`: `SessionManagerOptions` :46-65（`sandboxExecPath?` :56）・既定値 :218-222・`create()` :296-310・`createCase()` :326-348（`writeCaseFiles` :337、`spawnSession` :339、失敗の片付け :342-346）・`checkCaseSandbox()` :354-410（`AC_CASE_*` を返すのは :402-409）・`resume()` :416-421（件の役割は入れない）・`restore()` :462-473・`spawnSession` :518-574（`checkCaseSandbox` の結果 caseEnv :530・`openTerminal` :531）・`openTerminal` :580-617（tmux の条件 :582、probe :586-593、`newSession` :598、tmux の失敗で node-pty へ落ちる道 :600-607、node-pty :609-616）
- `server/restore.ts:154-162`・:179・:183-186（`startFailed`）
- `server/http.ts`: agent の入口の道 :385・:417、`handleAgentReservations` :391-415（Origin があれば 403 は :392）、`auditOf` :432-436、`writeAudit` :439-441、道の振り分け :621-656、`CaseSandboxUnavailableError` を 503 にするのは :671-675
- `server/routine-audit.ts`: action の型 :11（件の action は無い）・行の型 :13-44・`RoutineAudit` :46-61（書き先 `dataDir/routine-audit.jsonl`）
- `server/index.ts`: main :70-171（`new RoutineAudit` :79、listen :117 は 127.0.0.1、止める処理 :156-168）
- `server/config.ts`: `RoleConfig.caseSandbox` :22・:159-162、`claudeBin` :76・:140・:328（`agent-console.config.json:8` の値は `"claude"`。`server/agents.ts:129` などが PATH で探して使う）、`DEFAULT_DATA_DIR` :41、`CHILD_ENV_BLOCKLIST` :273。番号 4319 は `agent-console.config.json:2`、discord-case は :45-51
- `server/json-store.ts:30-36` `writeJsonAtomic`（async。この便の同期の関数の中では使わない）、`server/terminal-host/tmux-runner.ts` `probeSession` :60-69・`newSession` :82-92（`-P -F #{pane_pid}` で pane の pid を返す :83・:87-91。`-e K=V` は :84）、`server/activity-setup.ts:13-15` と `server/restore.ts:198-202`（`AGENT_CONSOLE_PORT` が空のときだけ動かす式）、`scripts/lib/ac-common.sh:412`（自己診断の2つ目のサーバーは `AGENT_CONSOLE_PORT` を付けて起きる）、`server/http.ts` の `readJsonBody` :93（`MAX_BODY_BYTES` :40）と Host の確かめ :617、`server/process-tree.ts:62-65` `readProcessTable`（`ps -axo pid=,ppid=,rss=,%cpu=`）
- `hooks/activity-hook.mjs`: import :5-7・`buildRecord` :131-182（session_id が UUID でなければ null）・`appendRecord` :193-223・`run` :226-235・本体の実行の塊 :246-260（dataDir は台本の2つ上 :254-255）
- `ops/shell/ccdiscord.zsh`（52行）: `claude_bin` :5・`sandbox_exec` :6・入力の確かめ :10-16・版の確かめ :18-26・gh の鍵 :29-33・export :34-41（:39 `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`・:41 `CLAUDE_CODE_TMPDIR`）・引数 :47・再開 :48-50・起動 :51（`command "$claude_bin" "${args[@]}"`。exec ではない）
- `scripts/ac-hooks.mjs:13-15`: 台本から `../server/*.ts` を直接 import している（node 24。`package.json` の engines は `>=24`）
- 版と記録: `package.json` の version は 0.47.2。`docs/CHANGELOG.md` は版ごとに1行（戻す命令つき）。入れるのは `scripts/ac-update.sh vX.Y.Z`
- テスト: `tests/unit/case-sandbox.test.ts`（buildCaseSettings :70・writeCaseFiles/removeCaseFiles :164）・`tests/unit/sessions.case.test.ts`（:99 作成・:220 の 503・:253 の tmux の probe）・`tests/unit/ccdiscord-zsh.test.ts`（:59 `AC_SANDBOX_EXEC=/bin/sh`・:67 zsh で動かす）・`tests/unit/activity-hook.test.ts`・`tests/unit/activity-hooks.test.ts`・下支え `tests/unit/helpers/harness.ts`・`case-repo.ts`・`tmux-env.ts`
- 参考（製品のコードではない。段階 P で実際に部屋を作って動いた試しの台本。道は公開用に `<…>` に伏せた）: `docs/handoff/discord-pdca/bin2b3c-ref/mkroom.py`（規則の順 1〜5 の書き方・`cip()` の大文字小文字を問わない正規表現・`reesc()`・mach-lookup の名前の一覧）と `bin2b3c-ref/sysctl-block.txt`（sysctl の許可の塊）。srt（`@anthropic-ai/sandbox-runtime@0.0.81`、Apache-2.0）の `dist/sandbox/macos-sandbox-utils.js`（以下 msu.js）と `sandbox-utils.js`（su.js）は、`npm pack @anthropic-ai/sandbox-runtime@0.0.81` で取って読む（依存には足さない）
- mkroom.py のうち、次の所は写さない（試しのときの形で、設計第8.1版と違う。下の「決めたこと」が優先）: ①CH を丸ごと subpath で書ける形（mkroom.py:100-101・:106-107）②開け直しの `D/hooks/activity-send.mjs` と `D/ops-case/case-guard.mjs`（:80-81。この便では A の `CASE_ROOM_READ_NAMED` のとおり）③room.sb の literal の再拒否（:92）④祖先の無い移動の塞ぎ（:94-98。この便では A の規則の順 2 のとおり祖先も塞ぐ）⑤kc=1 の Keychains・`com.apple.SecurityServer`・`com.apple.securityd.xpc`（:51-52・:82-83）

## 決めたこと

### A. 部屋の設定（`server/case-sandbox.ts`）

- 新しい定数（どれも `case-sandbox.ts` に1つずつ。今の5つの一覧と `CASE_ALLOWED_DOMAINS` はそのまま使い、部屋のための別の一覧を作らない）:
  - `CASE_ROOM_BASE`: srt の土台と既定の許可（msu.js:753-922 のうち mach-lookup・`allowAppleEvents` の塊 :795-807・利用者の mach :808-815 を除いた物）の文字列。sysctl は `bin2b3c-ref/sysctl-block.txt` の形。写した塊の上に `; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:<行> (Apache-2.0)` の注記を書く
  - `CASE_ROOM_MACH`: mach-lookup の名前の配列。完全な名前だけ（`*` を含まない）。`bin2b3c-ref/mkroom.py` の kc=0 の一覧（:47-50）そのまま（`com.apple.trustd.agent` はもう入っている。`com.apple.SecurityServer`・`com.apple.securityd.xpc` は入れない）
  - `CASE_ROOM_READ_NAMED = (p) => [...]`: 読み取りで名前を挙げて開ける物。`D/cases/<id>/settings.json`・`D/cases/<id>/case.json`・見張りの台本 `guardScript`（`ops/case/case-guard.mjs` の realpath）・`D/hooks/activity-hook.mjs`・`D/hooks/ac-routine-guard.mjs`・`D/hooks/server-kill-guard.mjs`・claude の実体（下の E）はファイル1つずつ `(literal …)`、case-home の根 `CH` だけ `(subpath …)`。git の設定のファイル4つは今の `CASE_ALLOW_READ`（:123-126）にあるので足さない
  - `CASE_PROTECTED_WRITE = (p) => string[]`（正規表現の配列）: X＝W・R・CH の realpath のそれぞれについて、room-design.md §4-1 の規則の順 3 の3つの形（危ないファイルと名前そのままのファイル `^<X>/(.+/)?<名>$`・危ない置き場と `.git/hooks` `^<X>/(.+/)?<名>(/.*)?$`・裸のリポジトリの名前 `^<X>/<名>(/.*)?$`）。`<X>` は正規表現の記号を逃がす（mkroom.py の `reesc`）、`<名>` は1文字ずつ大小を問わない形（mkroom.py の `cip`）。名前の一覧は room-design.md:119-121 のとおり（`.claude/workflows`・`.claude/scheduled_tasks.json`・`.claude/skills`・`.claude/hooks` を含む）
  - `CASE_MAIN_ONLY_DOMAINS = ["api.anthropic.com"]`
  - `caseProxyDomains()`: `CASE_ALLOWED_DOMAINS` から `127.0.0.1`・`localhost` を除き、`CASE_MAIN_ONLY_DOMAINS` を足した配列（受付が使う。ほかの所に一覧を書かない）
  - 番号: `CASE_PROXY_PORT = 18124`（1か所の定数）。agent-console の番号は `config.port` を渡す
- `casePaths`（:49-64）に `CH = D/case-home/<id>` を足す
- `CASE_DENY_WRITE`（:66-79）に足す: `H/.claude`・`H/.claude.json`・`H/.zshrc`・`D/activity`（`D/cases`・`D/hooks` は今ある）。`CASE_DENY_READ`（:81-91）に足す: `H/.claude/.credentials.json`（room-design.md §4-3 の最後）。どちらも今の権限の deny にもそのまま流れる（正本は1つ）
- 新しい純粋な関数 `buildCaseRoomProfile(p, opts: { proxyPort, consolePort, claudeReal, guardScript })`。出力は文字列。規則の順は room-design.md:114-130 の1〜5 のとおりで、mkroom.py の並びと同じ:
  1. `(version 1)` `(deny default)`・`CASE_ROOM_BASE`・`CASE_ROOM_MACH`（1つの `(allow mach-lookup (global-name …) …)`）
  2. 読み取り: `(allow file-read*)` → `CASE_DENY_READ_SANDBOX` と `CASE_DENY_READ` を `(deny file-read* (subpath …))` → 開け直しの塊1つ `(allow file-read* …)` に `CASE_ALLOW_READ`（subpath）・`CASE_ROOM_READ_NAMED`・`(literal "/dev/null")`・`(regex #"^/dev/ttys[0-9]+$")` のかわりに `(literal (param "TTY"))` → そのあと拒否だけ（開け直しの道の中にある拒否の再拒否。msu.js:294-305 の `lateReadDenyFilters` の形）→ ディレクトリの `file-read-metadata`（msu.js:666-667）→ 移動の塞ぎ（msu.js:585-609・:670。対象は `CASE_DENY_READ_SANDBOX` と `CASE_DENY_READ` の各道そのもの（subpath）と、その祖先のディレクトリ全部（literal）。msu.js:585-609 の moveBlockingFilters と同じ形。書ける場所 W・R・T・CH の中にある読み取りの拒否の道についての塊も、msu.js:1009-1020 の形で足す）→ W・R・T・CH の (A) の置き場（subpath）・`CH/.last-cleanup`・`CH/.claude.json`（literal）への `(allow file-write-unlink file-write-create …)`。この塊のあとに `(allow file-read*` を置かない（REVIEW INVARIANT。msu.js:628-632）
  3. 書き込み: `(allow file-write* …)` に W・R・T（subpath）・CH の (A) の置き場6つ `projects`・`sessions`・`session-env`・`shell-snapshots`・`tasks`・`teams`（subpath）・`CH/.last-cleanup`・`CH/.claude.json`（literal）・`/dev/null`・`(literal (param "TTY"))` → `(allow file-ioctl (literal (param "TTY")))`（mkroom.py:109 のとおり。土台の /dev の ioctl :909-922 は /dev/tty までで、端末の大きさや raw モードの切り替えに要る）→ `(deny file-write* …)` の1つの塊に `CASE_DENY_WRITE`（subpath）・`CASE_PROTECTED_WRITE`（regex）・CH の (B) と設定の名前 `^<CH>/(remote-settings\.json|remote-settings\.json\.synced-at|plugins|backups|settings\.json|agents|hooks|commands|skills|CLAUDE\.md)(/.*)?$` と `^<CH>/policy-limits[^/]*\.json$`。CH の根の subpath の書き込みの許可は書かない
  4. `(deny file-write-unlink file-write-create …)` の1つの塊: `CASE_PROTECTED_WRITE` の全部・3 の CH の名前の正規表現・X＝W・R・CH の根と `<X>/.claude`・`<X>/.git` の literal・`^<X>/(.+/)?\.git$`・`^<X>/(.+/)?\.claude$`（mkroom.py:134-146 の形）
  5. 通信: `(allow network-outbound (remote ip "localhost:<proxyPort>") (remote ip "localhost:<consolePort>"))` だけ。Unix ソケットへの接続・bind・inbound は許さない
  - 道はすべて realpath。空白を含む道は文字列の引用（mkroom.py の `q()`）で書く
- 書き込みは同期: この便で足す書き込み（`writeCaseRoom`・`rewriteCaseClaudeJson`）は、どちらも同期の関数にする。手順は `writeFileSync`（一時の名前、mode 0o600）→ `renameSync`。`writeJsonAtomic` は使わない（async のため。呼び出し元の `spawnSession`・`openTerminal`・`restore` は同期の関数）
- `writeCaseRoom(p, opts)`（同期）: `buildCaseRoomProfile` の結果を `D/cases/<id>/room.sb.<乱数>.tmp`（0o600）に書き、`room.sb` に rename する。どちらかが失敗したら `CaseSandboxUnavailableError("sandbox unavailable: room profile could not be written")`。書く前に `D/cases/<id>/` の `room.sb.*.tmp` の残りを消す。前の `room.sb` は使わない（rename の前に失敗したら、前の `room.sb` も消してから投げる）
- `buildCaseSettings`（:136-178）: `sandbox` の塊（:158-175）を `sandbox: { enabled: false }` だけにする。`permissions`・件の見張りの組（:141-144）・`includeGitInstructions: false` などはそのまま。フックは `addHandlers({}, nodeBin, hookPath, { skip: [BOARD_GUARD_HOOK_FILE], activityArgs: ["--post", "http://127.0.0.1:<consolePort>/api/agent/case-activity"] })`（下の C）。`buildCaseSettings` の引数に `consolePort` を足す。通し方: `writeCaseFiles`（:192・:200 で buildCaseSettings を呼ぶ）の引数にも `consolePort` を足し、`createCase`（sessions.ts:337）から `this.config.port` を渡す
- `writeCaseFiles`（:192-228）: CH を 0o700 で作り（`D/case-home` は無ければ 0o700 で作る。すでにあれば今の `isOwnRealDirectory` :183-186 と同じ確かめ）、`made` に足す。room.sb はここでは書かない（書くのは B の `spawnSession` だけ。作成のときも `spawnSession` を通る）
- `removeCaseFiles`（:231-240）に `D/case-home/<id>` を足す（今の UUID の確かめのもと）
- `.claude.json` の書き直し `rewriteCaseClaudeJson(CH, W)`（同期）: 前の `CH/.claude.json` を読み（無い・壊れていれば空とみなす）、残すキー `userID`・`machineID`・`firstStartTime`・`firstStartVersion`・`migrationVersion`・`opusProMigrationComplete`・`sonnet1m45MigrationComplete` のうち値が文字列・数・真偽の物だけ写し、`hasCompletedOnboarding: true` と `projects: { [W の realpath]: { hasTrustDialogAccepted: true } }` を足して、上の同期の手順（一時の名前 0o600 → rename）で書く。ほかのキーは全部落とす。値は記録・画面に出さない

### B. 起動の確かめと起動（`server/sessions.ts`）

- 件を開くたび（作成・restore・つなぎ直し。`spawnSession` :518 で件の役割のとき、`checkCaseSandbox` を呼ぶ前）に `writeCaseRoom` を呼ぶ。claude の実体の道（E）は、その前にここで解く。E が解けなければ `writeCaseRoom` を呼ばず、`CaseSandboxUnavailableError("sandbox unavailable: claude binary not found")`（⑫ の理由）を投げる
- `checkCaseSandbox`（:354-410）に足す確かめ（1つでも落ちたら今と同じ `CaseSandboxUnavailableError`）: ⑧ `D/cases/<id>/room.sb` がある ⑨ 受付が待ち受けている（options の `caseProxyListening()` を同期で見る。受付を起こさなかった・起こせなかったサーバーでは偽） ⑩ `CH` がディレクトリ ⑪ macOS の版の記録がサーバーの起動のときに読んだ `sw_vers -productVersion` と同じ（D） ⑫ E で解いた claude の実体の道が room.sb に書いた literal と同じ文字列で、そのファイルがある ⑬ 端末の置き場が tmux（`config.terminalHost` が tmux で、tmux が使える）
- 返す環境に足す: `AC_CASE_ROOM`（room.sb の道）・`AC_CASE_HOME`（CH の realpath）・`AC_CLAUDE_BIN`（E の実体の道）・`AC_CASE_PROXY`（`http://127.0.0.1:18124`）
- `openTerminal`（:580-617）: 件の役割のときは、tmux が無い（:582 の条件が偽）か tmux の起動に失敗した（:600-607 の道）ら node-pty に落とさず `CaseSandboxUnavailableError` を投げる。新しく claude を起動するとき（`newSession` :598 の直前。probe :586-593 で生きたセッションにつなぎ直すときは呼ばない）だけ `rewriteCaseClaudeJson` を呼ぶ（任意の引数の関数で渡し、ほかの役割では渡さない）
- 本体の pid の記録: 件の役割で、新しく起動したときは `newSession` の戻り値（pane の pid。tmux-runner.ts:83・:87-91）、probe でつなぎ直したときは probe の pid（sessions.ts:586-593）を使う（`tmux-runner.ts` に新しい関数は足さない）。`ps -o lstart= -p <pid>` の開始時刻（`execFileSync` で同期に取る）と一緒に `Map<セッションid, {pid, lstart}>` に入れる。pid が 0 か引けないときは入れない（受付は断る側）。セッションが閉じたら消す。サーバーが起き直ったら空から始める（restore で件ごとに引き直す）。読む関数は SessionManager の `caseMainProcesses(): ReadonlyMap<string, { pid: number; lstart: string }>`（全件の写し）1つにする。受付の `mainOf` と活動の入口は、これを回して pid から件を逆引きする
- つなぎ方（`server/index.ts`）: `SessionManagerOptions`（sessions.ts:46-65）に任意の欄 `caseRoomMacosOk?: boolean` と `caseProxyListening?: () => boolean` を足す（どちらも無いときは偽として扱う）。index.ts の手順は、①:75 の前に `sw_vers -productVersion` を読み、記録と比べて `caseRoomMacosOk` を出す ②`let caseProxy: CaseProxy | null = null` を置く ③:75 を `new SessionManager(config, { caseRoomMacosOk, caseProxyListening: () => caseProxy?.isListening() ?? false })` に替える ④:79 の `new RoutineAudit` のあとで、本番の番号のときだけ `caseProxy = startCaseProxy({ …, mainOf: () => sessions.caseMainProcesses(), audit })` とする
- 活動の入口へは、`createRequestHandler`（index.ts:112）の deps に今ある `sessions` から `caseMainProcesses()` を引く。新しく AppDeps に足すのは任意の欄 `lookupPid?`（テストで差し替えるため）だけ。index.ts からは渡さず、無いときは D の本物の `lsof` の関数を使う
- 起き直しの順番: `startCaseProxy` は待ち受けが始まったら解ける Promise（`ready`）を返す。index.ts の件の開き直し（restore。:149 付近）は、本番の番号のときこの `ready` を待ってから始める（listen に失敗したときも解けて、⑨ で落ちる）
- ⑨ は `caseProxyListening()`、⑪ は `caseRoomMacosOk` を見る。`sessions.case.test.ts` の今の成功の道（:99 など）には `caseRoomMacosOk: true` と `caseProxyListening: () => true` を渡す。⑨・⑪ を落とすテストは、それぞれ偽を渡す。`tests/unit/helpers/harness.ts` の options（:114-119）と SessionManager に渡す所（:238-246）にも、この2つの欄を通す。`harness.ts:193` の `claudeBin` の既定は `"/nonexistent/claude"` なので、件の成功のテストの setup では、一時の置き場に作った実行できる偽のファイルを `claudeBin` に渡す（⑫ で落ちないため）
- `sessions.case.test.ts` の今のテストで direct（node-pty）の端末に頼っている物は、`tests/unit/helpers/tmux-env.ts` を使う形に替える。替えられないテストがあれば、替えずに止めて報告する

### C. フック（`server/activity-hooks.ts`・`hooks/activity-hook.mjs`）

- `addHandlers(settings, nodePath, hookPath, opts?)` に任意の4つ目の引数 `{ skip?: string[]; activityArgs?: string[] }` を足す。`skip` は `spec.file` と完全一致する spec を除く物（件の設定では `skip: [BOARD_GUARD_HOOK_FILE]`。:25 で export 済みの定数を使い、"board-guard" の文字列は書かない）。`activityArgs` は、`spec.file` が無い spec（＝ activity-hook.mjs を呼ぶ物）の handler の引数の後ろにだけ足す物。opts が無いときの出力は今と1文字も変わらない（`activity-hooks.test.ts` の今のテストが全部そのまま通ること）。ユーザー設定に入れる道（`scripts/ac-hooks.mjs`）は opts を渡さない
- `hooks/activity-hook.mjs` に `--post <url>` の形を足す: 引数に `--post` があれば、ファイルに書かず、標準入力の文字列をそのまま `fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(2000) })` で送る。url の host が `127.0.0.1` でなければ送らない。送る本文の上限は、書く1行の上限 `MAX_LINE_BYTES`（activity-hook.mjs:9-10）とは別の新しい定数 `export const POST_MAX_BYTES = 8 * 1024 * 1024` とする（activity-hook.mjs に足し、`hooks/activity-hook.d.mts` にも `POST_MAX_BYTES: number` を宣言する）。長さは `Buffer.byteLength` で byte で数え、超えるときは送らない。大きい入力を小さい1行にするのは今と同じくサーバー側の `run()`（`buildRecord`）で行う。fetch は await してから終わる（終わる前に `process.exit` しない）。どの失敗でも投げず、終了コード 0。`--post` が無いときの動きは今と同じ（`activity-hook.test.ts` の今のテストが全部そのまま通ること）。`run(stdinText, dataDir)` は今のとおり export のまま

### D. 受付（新しい `server/case-proxy.ts`）

- `startCaseProxy({ port, domains: caseProxyDomains(), mainOf: () => ReadonlyMap<string, { pid, lstart }>, audit, lookupPid })` を `server/index.ts` の main で起こす（`127.0.0.1` だけで待ち受ける）。`isListening()` を持つ
- 起こすのは本番の番号のサーバーのときだけ: `AGENT_CONSOLE_PORT` が未設定か空のとき（`server/activity-setup.ts:13-15`・`server/restore.ts:198-202` と同じ式。同じ判定を関数にして使い回してよい）。自己診断の2つ目のサーバー（`scripts/lib/ac-common.sh:412`）では起こさず、`isListening()` は偽
- listen に失敗しても（番号が使用中など）サーバーは止めない。`isListening()` を偽のままにし、件は ⑨ で 503 になる。失敗は標準エラーに1行出す
- 止める処理（index.ts:156-168）で受付も閉じる
- 受けるのは `CONNECT host:port` だけ。ほかの要求は 405 で閉じる。host は小文字にして末尾の点を1つ落とす。IP の直書き（v4・v6。`net.isIP`）・ASCII でない名前・空・443 以外の番号・`domains` に完全一致しない物は 403
- `api.anthropic.com` は本体だけ: 送り元の番号から `lookupPid`（`/usr/sbin/lsof -nP -Fp -iTCP@127.0.0.1:<送り元の番号>`。`execFile`・短い timeout）で pid を引き、サーバー自身の pid を除いて残りがちょうど1つで、その pid と `ps -o lstart= -p <pid>` が、どれかの件の `mainOf` の記録と一致するときだけ通す。親はたどらない。ほかは 403
- 通すときは相手に TCP でつなぎ `200 Connection established` を返して両方向に流すだけ（TLS は開かない）
- 1回ごとに監査記録に1行: `RoutineAuditAction` に `"caseProxy"` を足し、`{ action: "caseProxy", outcome: 通したら "ok"・断ったら "denied", callerSessionId: null, caseSessionId（本体と一致したときだけ）, host, main: boolean }`。`RoutineAuditEntry`（routine-audit.ts:13-44。`outcome`・`callerSessionId` は必須）に任意の欄 `caseSessionId?: string`・`host?: string`・`main?: boolean`・`productVersion?: string` を足す。書けなくても止めない（`writeAudit` :439-441 と同じ扱い）
- macOS の版: main で1回 `sw_vers -productVersion` を読み、`<dataDir>/case-room-macos.json`（`{ productVersion, acceptedAt }`）と比べた結果を SessionManager に渡す（渡し方は B の「つなぎ方」）。記録が無い・違う・読めないときは ⑪ で落ちる
- 記録を書く命令 `scripts/ac-case-macos.mjs accept`: `scripts/ac-hooks.mjs:13-15` と同じ形で `../server/config.ts`・`../server/json-store.ts`・`../server/routine-audit.ts` を import し、今の `sw_vers -productVersion` を `writeJsonAtomic` で書き、監査記録に `{ action: "caseRoomMacosAccepted", outcome: "ok", callerSessionId: null, productVersion }` を1行足す（`RoutineAuditAction` に足す）。サーバーは起き直したときに読み直す（この命令のあと `ac-update` か再起動で効くと CHANGELOG に書く）

### E. claude の実体の道

- `config.claudeBin` を正本にする。`/` を含めばそれを、含まなければサーバーの `process.env.PATH` を左から探して実行できる最初のファイルを取り、`realpathSync` する（同期）。見つからなければ ⑫ で落ちる。この道を room.sb の `CASE_ROOM_READ_NAMED` の literal と `AC_CLAUDE_BIN` の両方に、同じ変数から書く

### F. 活動の入口（`server/http.ts`）

- `POST /api/agent/case-activity` を `/api/agent/*` の並び（:385・:417 の近く）に足す。Host の確かめ（:617）は今の入口と同じ道を通す。Origin があれば 403（:392 と同じ）。本文は既存の `readJsonBody`（:93）に上限 `POST_MAX_BYTES`（C で activity-hook.mjs に足す定数を import）を渡して受け、JSON でなければ 400。`run` には `JSON.stringify` した文字列で渡す
- 置く位置: http.ts の振り分けで、定期実行の入口（:638-642）の後ろ、`/api/` の認証（:643）の前（この入口は合言葉を持たないため）
- 確かめの順番（この入口は合言葉の確かめより前にあり、上限も 8MiB と大きいため）: Origin（403）→ pid で件を引く（401）→ 本文を読む（400）→ session-id（409）→ `run`。件が分かる前に本文を読まない
- build: サーバーが `hooks/activity-hook.mjs` を import するので、`scripts/copy-board-command.mjs` の写す一覧（:9）に `activity-hook.mjs` を足し、:1-2 の注記も直す（tsc は .mjs を `dist-server` に出さない。本番は `node dist-server/server/index.js` で起動する）
- どの件か: 送り元の番号から D と同じ `lookupPid` で pid を引き（サーバー自身を除いて1つでなければ 401）、`readProcessTable()`（`process-tree.ts:62-65`）の ppid で上へたどって（出発の pid そのものも数える）、どれかの件の `mainOf` の pid（`ps -o lstart=` の開始時刻も一致）に行き着いたらその件。行き着かない・引けない・記録が無いときは 401
- 会話の番号: その件で最初に受けた `session_id`（UUID の形のときだけ）を `D/cases/<id>/session-id` に `writeJsonAtomic`（この入口は async なので使ってよい）で書いて固定する（サーバーが起き直っても残る）。違う番号は 409 で受けない。このファイルは `CASE_ROOM_READ_NAMED` に入れない（部屋から読めず書けない）
- 書く: `hooks/activity-hook.mjs` の `run(本文, config.dataDir)` を import して呼ぶ（`buildRecord`・`appendRecord` を通る。別の置き場・別の形を作らない）。204 を返す

### G. 起動関数（`ops/shell/ccdiscord.zsh`）

- 関数の一番初め（:5 の local より前）に1回: `unset SSH_AUTH_SOCK TMUX TMUX_PANE CLAUDECODE` と、`${(k)parameters}` のうち名前が `CLAUDE_CODE_`・`CLAUDE_`・`ANTHROPIC_` で始まる物を全部 `unset`
- 入力の確かめ（:10-16 と同じ形）に足す: `AC_CASE_ROOM` が読める・`AC_CASE_HOME` がディレクトリ・`AC_CLAUDE_BIN` が実行できる・`AC_CASE_PROXY` が空でない・`tty` の答えが `^/dev/ttys[0-9]+$`。版の確かめ（:18-26）は `"$AC_CLAUDE_BIN" --version` で行う
- ログインの鍵: gh の鍵（:29-33）と同じ形で `security find-generic-password -s agent-console-case-claude -a case -w` から取り、空なら 2 で終わる。`export CLAUDE_CODE_OAUTH_TOKEN` のあと local の変数を unset。値を出さない
- export に足す: `CLAUDE_CONFIG_DIR="$AC_CASE_HOME"`・`TMPDIR="$AC_CASE_TMP"`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`・`HTTPS_PROXY`・`HTTP_PROXY`・`https_proxy`・`http_proxy`（どれも `$AC_CASE_PROXY`）・`NO_PROXY=127.0.0.1,localhost`。:39・:41 は残す
- 最後（:51）を `exec "$sandbox_exec" -f "$AC_CASE_ROOM" -D TTY="$(tty)" "$AC_CLAUDE_BIN" "${args[@]}"` に替える。件の役割で `claude_bin`（:5）と PATH は使わない（:5 は消してよい）

### H. 版

- `package.json` を 0.48.0 に。`docs/CHANGELOG.md` に1行（何が変わるか・戻す命令 `bash scripts/ac-update.sh v0.47.2`・戻す前に件を全部閉じて `<dataDir>/cases/*`・`case-gh/*`・`case-home/*` を消す（room-design.md §6）・初めて入れたあと `node scripts/ac-case-macos.mjs accept` を設計者が測りのあとで打つまで件は開かない）

## テスト（vitest。sandbox-exec を本当に動かすテストは darwin 以外では skip）

- `case-sandbox.test.ts` に、room-design.md:133 の項目を1件ずつ（全部の一覧の道が規則に入る・書き込みの拒否が許可より後ろ・開け直しの塊の後ろに `(allow file-read*` が無い・`CASE_ROOM_READ_NAMED` が CH のほかは literal で再拒否の道に入らない・どの拒否の道についても開け直しの道が祖先でない（または再拒否に出る）・unlink/create の開け直し・移動の塞ぎ・移動の塞ぎに拒否の道の祖先のディレクトリが全部 literal で入る・入れ子の正規表現が W・R・CH の realpath で始まり `\.git$`／`\.claude$` で終わり T に掛からない・CH の (B) の名前が書き込みの拒否と作成の塞ぎの両方に入る・CH の根の subpath の書き込みの許可と unlink/create の開け直しが無い・`CH/Remote-Settings.json` が許可のどれにも当たらない・W・R の保護に `.claude/workflows` と `.claude/scheduled_tasks.json`・mach に `*` が無い・AppleEvents と lsopen の許可が無い・通信の許可が2つの番号だけ・`caseProxyDomains()` が式どおり・件の設定のフックに board-guard が無く、ほかの見張りの台本の道が `CASE_ROOM_READ_NAMED` に入る・件の設定の `sandbox` が `{ enabled: false }` だけ）
- `writeCaseRoom`: 書けたとき・一時の名前の書き込みに失敗したとき（前の room.sb が残っていても 503 側・前の room.sb が消える）・一時の名前の残りを消す
- `rewriteCaseClaudeJson`: 残すキーだけ・型の違う値を落とす・`mcpServers` などを落とす・壊れたファイル
- darwin のときだけ: 作った room.sb で `/usr/bin/sandbox-exec -f <room.sb> -D TTY=/dev/null /bin/sh -c '<命令>'` を動かし、W への書き込みが通る・W の外（テストの一時の置き場の別のディレクトリ）と `W/.git/hooks/x`・`W/sub/.Claude/agents/x`・`CH/remote-settings.json` への書き込みが拒まれる・`mv W/.git W/g` が拒まれる・H の下の別の道が読めない（テストではホームのかわりに一時の置き場を H として渡す）
- `sessions.case.test.ts`: ⑧〜⑬ をそれぞれ1つずつ落として 503・room.sb の書き込みに失敗させて 503・tmux が無いとき node-pty で開かず 503・つなぎ直しのとき `.claude.json` を書き直さない・新しく起動するとき書き直す・`AC_CASE_ROOM`・`AC_CASE_HOME`・`AC_CLAUDE_BIN`・`AC_CASE_PROXY` が渡る
- `ccdiscord-zsh.test.ts`: `CLAUDECODE`・`CLAUDE_CODE_CHILD_SESSION`・`CLAUDE_CODE_ENTRYPOINT`・`ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL`・`CLAUDE_CONFIG_DIR=/x`・`TMUX`・`SSH_AUTH_SOCK` を入れた環境で呼び、`sandbox-exec` の差し替え（今の :59 の形）に渡る環境に、前方一致の名前が足す物（`CLAUDE_CONFIG_DIR`＝`AC_CASE_HOME`・`CLAUDE_CODE_TMPDIR`・`CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`・`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`）のほかに残らない・`TMUX`・`SSH_AUTH_SOCK` が無い・引数が `-f <room> -D TTY=… <AC_CLAUDE_BIN>` で始まる・`AC_CASE_ROOM` が無い／`tty` が形に合わないと 2 で終わる。`security` は今の `gh` と同じく差し替えで渡す（本物の Keychain を読まない）。`tty` も PATH の `bin/tty` で差し替え、`/dev/ttys001` を返させる（形に合わない場合のテストだけ別の答えにする）
- `case-proxy.test.ts`（新しい）: CONNECT 以外 405・IP・IDN・空・443 以外・一覧に無い名前は 403・末尾の点と大文字を直して通る・`api.anthropic.com` は `lookupPid` と `mainOf` の差し替えで、1つで一致なら通る／0件・2件・違う pid・開始時刻の違いは 403・監査の行が1回ごとに1行・`AGENT_CONSOLE_PORT` があるときは受付を起こさない・番号が使用中のときサーバーは起き、件は 503 になる
- 活動の入口のテスト（成功の道は、本物の子のプロセスを起こし、`vi.spyOn(sessions, "caseMainProcesses")` でその pid を本体として用意する）: Origin で 403・行き着かない pid で 401・最初の session_id の固定と違う番号で 409・今の `events-YYYYMMDD.jsonl` に今と同じ形の1行
- `activity-hooks.test.ts`: opts 無しの出力が今と同じ・`skip` と `activityArgs` が効く。`activity-hook.test.ts`: `--post` で書かず送る・127.0.0.1 以外へ送らない・失敗でも 0
- 大きい入力: 100KiB の content を持つ PostToolUse Write と、100KiB の last_assistant_message を持つ Stop を `--post` で送り、ファイルに書く今の形のときと同じ1行が書かれる（後者は切った印が付く）
- 部屋: file-ioctl の許可は `(param "TTY")` と土台の /dev の物だけ
- build: PR を出す前に、作る係が手で `npm run build` を流し、`dist-server/hooks/activity-hook.mjs` があることを `ls` で確かめ、その出力を PR 本文に貼る（vitest には入れない）
- `npm test`・型の確かめ（`npm run build` の `tsc`）・lint が全部通ること

## PR に書くこと

- 変えたファイルの全部の一覧（`git diff origin/main...HEAD --name-only` の写し）と、上の決めたことの A〜H のそれぞれをどのファイルの何行で入れたか
- この便でしていないこと（上の「この便に入れないもの」）と、マージのあとに設計者が手元で行う確かめ: room-design.md §4-2 の受入の最初の確かめ（case-home の拒否を名前ごとに数える・`.claude.json` の書き込み・一時の名前）・§6 の戻しの試験・G1〜G7・`downloads.claude.ai` の断り0件・受付が断ったあと会話が続くか
