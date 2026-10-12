# session-restore recon notes (agent-console main 53f8cca, v0.3.7) 2026-10-12
パスは /Users/tanizawashingo/agent-console 起点。【事実】=コマンド出力/ファイル引用あり。

## 1. 会話の番号 (session id)
### 1-1 `claude agents --json` の項目名【事実】(実行 2.1.296, 10行)
項目名: cwd, kind, name, pid, sessionId, startedAt, status （waitingFor は waiting 時のみ）
値(先頭8文字): sessionId 例 581c5b2c / 8b5353c3 / 87aa0732 ... 全10行とも UUID 形式(36文字)。kind は全行 interactive。
- 同じ sessionId が2行(pid 26719 と 93424、先頭 6b2babfc、全文一致=True)。startedAt が違う=同じ会話を再開(resume)した新プロセスと、古いプロセスが両方残っている。【推測】再開しても id は変わらない。
- 同じ情報の出どころ: ~/.claude/sessions/<pid>.json (項目: pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, name, nameSource, status, updatedAt ...)。プロセス終了で消える。
### 1-2 AgentRow と解析 【事実】
server/agents.ts:7-17 `interface AgentRow { pid:number; status; name?; sessionId?: string; waitingFor?; cwd?; startedAt?: number }`
server/agents.ts:46 `sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,`
server/agents.ts:27-53 parseAgentsOutput (ANSI除去→JSON.parse→配列でなければ null→pid が数値でない行は捨てる)
server/agents.ts:102-110 fetchAgents = execFile(claudeBin,["agents","--json"]) timeout 15000
現在 sessionId の使用箇所: agents.ts のみ (git grep -n sessionId -- server src: hub.ts/notify.ts の sessionId はアプリ側 UUID で別物)。
### 1-3 v0.3.2 の実装 【事実】
commit 767d9af (v0.3.2)。server/past-sessions.ts(現在は削除済み):
- :41-56 toPastSessions: `claude agents --all --json` の行から `r.sessionId` を取り、`SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/` (:12) で検証、cwd 無い行は捨てる、startedAt 降順。
- config (767d9af:agent-console.config.json): `"resumeCommand": ["/bin/zsh","-ic","ccopusgo --resume \"$AC_RESUME_ID\""]` / sonnet: `claude --model sonnet --resume "$AC_RESUME_ID"`。id は環境変数 AC_RESUME_ID で渡す(コマンド文字列に連結しない)。
- v0.3.3 (328a600) で past-sessions.ts を削除し、id なし `--resume`(公式選択リスト)に変更。
- ccopusgo は /Users/tanizawashingo/.claude/shell/ccopusgo.zsh:34-54,101-108 で `--resume <UUID>`(正規表現で UUID 検証)と id なし `--resume`(:34-38, :93-100)の両対応。起動時 cd は :84 で salesanchor 固定(本店)。
### 1-4 公式文書 (Context7 /websites/code_claude)
- `claude agents --json` 出力形式【事実】 https://code.claude.com/docs/en/agent-view
  原文: "**sessionId** (string) - Present when set. Full session UUID, usable with `claude --resume`." / "**name** (string) - Present when set. Session display name." / "`--all` - When combined with `--json`, includes completed background sessions in addition to active sessions." / "**pid** - Present while process is alive." / "**kind** (string) - Always present. `interactive` or `background`."
  同ページ: "`--all` ... Keeps listing sessions whose processes have already exited."
- `claude --resume` 【事実】 https://code.claude.com/docs/en/sessions
  原文: "`claude --resume` | Opens the session picker" / "`claude --resume <name>` | Resumes the named session directly" / "You can run `claude --resume <session-id>` from any directory, so you can resume a session that started elsewhere or moved with `/cd`." / "If no stored session matches the ID, Claude Code reports `No conversation found with session ID: <session-id>`." (cross-project 検索は v2.1.223 以降)
  https://code.claude.com/docs/en/cli-reference : "Resumes a session by ID or name, or opens an interactive picker if not specified. Searches the current project, git worktrees, and other projects on the machine."
- 同 sessions: "Claude Code leaves sessions created with `claude -p` or the Agent SDK out of the session picker" (対話セッションは対象)
### 1-5 会話開始前のセッションに id が出るか【事実】実測
手順: scratchpad/restore-probe/work(空フォルダ)で expect が `claude --model sonnet` 起動(env -u CLAUDECODE 等で親の変数を外す)→ 信頼確認画面で ↑+Enter → 本画面("Claude Code v2.1.296 Sonnet 5.5")表示 → 何も入力せず約4秒後に `claude agents --json`。
結果(3回, agents-ready*.json): 行数は常に 10 のまま(自分以外の既存セッション分)。cwd に restore-probe を含む行 = 0。~/.claude/sessions/ には `<pid>.<hash>.key` のみ存在し <pid>.json（プロセスごとのファイル） は無い(sessfile.txt: `95165.9243b8ac...key`)。
=> 一言も入力していない新規セッションは `claude agents --json` に出ない=sessionId を取れない。【未確認】最初の入力後にいつ出るか(今回は入力していないため)。
注: 信頼確認画面は既定選択が "No, exit" で、Enter のみだと claude が終了する(2回再現: GOT_EOF)。↑ を押してから Enter で進む。
後始末: 各 claude は ^C×2+kill で終了。最後の pid 95165 は `ps -p` で不在を確認。pgrep -fl "claude --model sonnet" は他エージェントの zsh -c 行(コマンド文字列に含むだけ)にヒットしたため、pid 指定で確認した。

## 2. 起動と保存の現状
### sessions.ts 【事実】
- create :116-137 (name は validateName 1-40字, role は config.roles から, needsWorktree なら branch 必須 release/<...>, 上限 DEFAULT_MAX_SESSIONS=16 :8, cwd = worktree か config.salesanchorRoot)
- resume :143-148 (role.resumeCommand 必須, cwd は呼び出し側検証済み, name)
- spawnSession :158-198: node-pty spawn(command[0], command.slice(1), {cwd, env}) ; Session{id: randomUUID() :174, name, roleId, branch, cwd, createdAt, term, ring, clients, exited:false}。**Claude の sessionId は保持していない**。
- onExit :191-194 `session.exited = true; this.notify();` (一覧には残る=stopped 表示)
- remove :201-209 `if (!session.exited) throw new SessionConflictError("session is still running")`。clients を close, map から delete, removedListeners 通知。
- killAll :221-225 全 pty を term.kill()。
- 動いているセッションを終わらせる API は無い【事実】: git grep の結果、DELETE /api/sessions/:id (http.ts:142-147) は上記 remove のみで running は 409。kill/close/terminate の語は server/src に該当なし(killAll のみ)。
- 画面: src/components/SessionList/SessionList.tsx:~83-95 `{s.state === "stopped" && (<Button ... aria-label={t("ac.removeSession")} onClick={() => onRemove(s.id)}>` = 停止済みの「一覧から外す」(ja: "一覧から外す")のみ。ConsolePage.tsx:142-145 handleRemove → src/api.ts:50 removeSession (DELETE)。
### http.ts API (sessions 関係) 【事実】
- GET /api/state :105 (sessions: SessionView[] を含む snapshot, roles, 版)
- POST /api/sessions :135 (create → 201 {id})
- DELETE /api/sessions/:id :142 (remove)
- POST /api/sessions/resume :196 (kind,path → resolveResumeTarget → sessions.resume → 201 {id})
- GET /api/resume-targets :192
- POST /api/sessions/:id/(read|rename|send-check) :204
- GET /api/memory :160, /api/quick-prompts 系 :166-191, /api/ledger :127
- 認証: /api/ はトークン必須、セッション認証の変更系は Origin 必須 :323-333。エラー写像 :343-354 (Input/Worktree/BadRequest→400, NotFound→404, Conflict→409)。
### index.ts (起動時) 【事実】
:50-85 main: loadConfig → resolveSecret → new SessionManager(config) → new Hub → createServer(handler{quickPrompts: new QuickPromptStore(config.dataDir) ...}) → listen の callback で hub.start()。**起動時にセッションを自動作成・復元する処理は無い**。
:77-83 shutdown(SIGINT/SIGTERM): hub.stop(); sessions.killAll(); server.close(); process.exit(0)。=サーバー再起動で全 pty が終了する(復元データは保存されない)。
### 保存の仕組み (quick-prompts.ts) 【事実】
- 保存先: config.dataDir (config.ts:25 既定 "~/Library/Application Support/agent-console") / quick-prompts.json (quick-prompts.ts:6,62)
- 形式 `{version:1, items:[...]}` (:12,:86)、読込時に version 検査、壊れていれば上書きせず例外 (:79-80)
- 書込 :83-89: mkdir recursive mode 0o700 (:84) → `${file}.${randomUUID()}.tmp` に mode 0o600 で writeFile (:86) → chmod 0o600 (:87) → rename (:88)
- 直列キュー :59-69 `serial()`: `this.queue.then(task, task)`; 失敗しても次を止めない
- 実機のモード: `ls -la`: quick-prompts.json -rw------- (600)。dataDir 自体は drwxr-xr-x (755)=mkdir の mode は既存ディレクトリには効かない。(ディレクトリ内: current -> versions/v0.3.6, logs, versions, .agent-console-home)
- 注意: dataDir の current は v0.3.6 を指す(ls 時点)。main の v0.3.7 は未配備かもしれない【未確認】。
### 再開の仕組み 【事実】
- server/resume-targets.ts: listResumeTargets :61-78 (本店=role resumeScope "main" + `git worktree list --porcelain` の worktree=role "worktree"), resolveResumeTarget :84-104 (kind/絶対パスを本店+worktree 一覧に照合し実パスのみ使用)。会話の一覧は持たない(:14)。
- config.ts:10-13 RoleConfig.resumeCommand / resumeScope。agent-console.config.json の役割:
  opus-designer: command ["/bin/zsh","-ic","ccopusgo"], resumeCommand ["/bin/zsh","-ic","ccopusgo --resume"] (scope main)
  sonnet-impl: command [.. "claude --model sonnet"], resumeCommand [.. "claude --model sonnet --resume"] (scope worktree)
  shell: command ["/bin/zsh","-i"] (resume なし)
- http.ts:196-203 POST /api/sessions/resume; 名前 resumeSessionName :152 ("resume: main" / "resume: <branch>")。
- 現状 id 付き再開はコードに無い(v0.3.3 で廃止)。復元をするなら: 保存した sessionId を `--resume <UUID>` に渡す必要があり、その環境変数渡し(AC_RESUME_ID 方式)は 767d9af の config が先例。ccopusgo 側は UUID 検証付きで対応済み(ccopusgo.zsh:43-53)。

## 3. メモリの目安 【事実】
`ps -axo pid,rss,etime,comm | grep ' claude$'` (RSS は KB):
60784 227600 02-14:04:25 / 1356 380016 02-15:09:47 / 26719 155600 02-01:54:07 / 63520 236464 02-14:03:23 / 56975 231104 02-14:04:49 / 28088 134880 02-12:46:58 / 2698 457424 02-15:08:52 / 1688 304704 02-15:09:26 / 63588 429760 01-03:08:17 / 93424 139600 01:28:45
件数 10 / 最小 134,880 KB (約132 MB) / 最大 457,424 KB (約447 MB) / 合計 2,697,152 KB (約2.57 GiB) / 平均 269,715 KB (約263 MB)
(同日の1回目の計測: 合計 1,910,768 KB 約1.82 GiB、最小 51,680 KB(28088)、最大 497,280 KB(63588)。RSS は短時間で大きく変動する。93424 は 103,440→139,600 KB)
`sysctl hw.memsize`: 8589934592 (= 8 GiB)
=> 10 セッションで物理メモリの約 31%。16 セッション(sessions.ts:8 上限)なら平均値で約 4.1 GiB(約 50%)【推測=平均の単純倍】。注意: 復元で全セッションを一斉に起動すると 1 件あたり1回目の計測で 93424(起動1時間強)は 103 MB。起動直後の値は未計測【未確認】。

## 4. zombie の確認 【事実】
`ps -o pid,ppid,stat,etime,command -p 23982,23978`:
  23978 ppid 23975 S   01:12:17 expect /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-.../scratchpad/exp/probe.exp
  23982 ppid 23978 ?Es 01:12:17 (2.1.296)
- 23982 の command 名が "(2.1.296)" で stat に "E"(終了処理中) と "?" 。ps の Z(zombie) ではない。 親 23978 は他エージェントの expect(probe.exp, scratchpad/exp)。その親 23975 は /bin/zsh -c (Bash ツール呼び出し; その中の `expect ... | ... ; pgrep ...`)、さらにその親 63588 は現在のメイン claude (agents 一覧の f16867bb)。
- 23982 は `claude agents --json` に載っていない(pid 一覧に無い)。
- 【推測】expect が spawn した claude が終了処理で止まっている(親が wait していない)。【未確認】原因。触っていない(指示により本番/動作中セッションに触れない)。他エージェントの expect を終わらせれば消えるかもしれないが未実施。
