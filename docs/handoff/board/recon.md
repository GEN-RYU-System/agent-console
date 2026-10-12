# 作戦ボード recon（右の欄「このセッション」→「作戦ボード」）

- 調査基準: origin/main = 288ddcb（v0.11.0）。最初の調査は 391b609（v0.10.0）で行い、v0.11.0 のマージ後に、activity.ts・activity-hook.mjs・activity-hooks.ts・http.ts・ja.json・ConsolePage.tsx の行番号を取り直した（288ddcb の中身を読んだ行番号。実装で変える前の状態）。
- 製品コード・設定は変更していない（調査のための記述）。
- 凡例: 【事実】= 読んだ行・実行した出力が根拠 / 【推測】/ 【未確認】。設計提案は書かない。
- 「（本リポジトリ外）」= agent-console リポジトリの外のパス。バッククォートの中は本リポジトリに実在するパスだけにし、外のパスはバッククォートを外して書く。

---

## A. 動いている担当

### A-1 「動いている」の判定【事実】
- server/activity.ts:423-465 の view() が starts（PreToolUse の Agent）を 1 件ずつ見て（:434）、endedAt = stop の ts ?? handback の ts ?? (completed なら post の ts、でなければ null)（:440）。endedAt が null で、かつ now − start の ts <= RUNNING_MAX_AGE_MS（24h、:9 と :455）なら running。endedAt があれば finished。
- 結び方: start.toolUseId → posts（PostToolUse の Agent。tool_use_id 一致、server/activity.ts:366-379）→ post.agentId → stops / handbacks（それぞれ agent_id をキーにした Map、server/activity.ts:305-310 と :343-348）。
- stops / handbacks は Map.set(agentId, …) なので（:307、:345）、同じ agent_id の 2 回目以降の終わりは**上書き**（最新の 1 件だけ残る）。開始（start）は tool_use_id ごとに 1 件で（:358）、再開で増えない。
- completed（:439）は post.status === "completed"（前景の担当）。背景の担当は async_launched なので、終わりは stops / handbacks だけが決める。
- 記録できる event は server/activity.ts:24 の 8 つのみ（PreToolUse・PostToolUse・SubagentStop・TaskCreated・TaskCompleted・UserPromptSubmit・Stop・StopFailure。最後の 2 つは v0.11.0 のチャット用）。SubagentStart は無い。
- 孫の担当（agent_id 付きの Agent 呼び出し）は出さない（server/activity.ts:352-357）。内部の担当（agent_type 空・報告なし）は出さない（:476）。

### A-2 hook が記録するもの【事実】
- server/activity-hooks.ts:23-32 HOOK_SPECS: PreToolUse（matcher Agent|SubagentHandback）、PostToolUse（matcher Agent）、SubagentStop、TaskCreated、TaskCompleted、UserPromptSubmit、Stop、StopFailure。
- **SendMessage は PreToolUse の matcher に入っていない**（Agent|SubagentHandback のみ）。SubagentStart は登録されていない。
- hooks/activity-hook.mjs:86-109（toolRecord）: Agent の Pre は tool_use_id・description・subagent_type・model、Handback の Pre は message（120字）、Agent の Post は tool_use_id・status・agentId・resolvedModel・totalDurationMs。:120-121 で common（ts・event・session_id・agent_id）、:126-130 で SubagentStop の agent_type・last_assistant_message（120字）。:221-235 どんな失敗でも終了コード 0。

### A-3 公式の入力【事実】（出典: scratchpad の hooks.md 写し。本リポジトリ外の /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/hooks.md）
- :2484-2486 「SubagentStart ... Runs when Claude spawns a subagent with the Agent tool, when Claude [resumes a subagent](/docs/en/sub-agents#resume-subagents), and each time an in-process agent team teammate handles a new message.」
- :2490-2501 入力は共通項目＋agent_id・agent_type。例: "hook_event_name": "SubagentStart", "agent_id": "agent-abc123", "agent_type": "Explore"。
- :2505 「SubagentStart hooks can't block subagent creation」（止められない。追加の文脈は返せる）。
- :743-748 agent_id = 「Unique identifier for the subagent or in-process teammate the hook fires in.」
- :2530-2532 SubagentStop は内部の担当でも発火し、そのとき agent_type は空文字になりうる。
- :1849-1858 Agent の tool_input は prompt・description・subagent_type・model。:1874 SubagentHandback の報告は tool_input.message。
- **PreToolUse の SendMessage の tool_input は、この hooks.md には載っていない**（grep -n SendMessage で hooks.md に該当行なし）。tools-reference.md（同 scratchpad）:49 に SendMessage の説明があり「a subagent it resumes by agent ID or name」「optional summary input」とある。to・message の項目名は公式のこの写しには明記なし【未確認。工程0 (a) で実測する】。
- 公式ではない実物の手がかり（第三者 Orca リポジトリの実記録、本リポジトリ外の orca-src/orca/src/shared/__fixtures__/claude-task-notification-hooks.jsonl）: scenario subagent-resumed で、SendMessage を呼んだときの順序は次の通り（payload のキー名だけ抜粋して実行した出力）:
```
7.43  hook PreToolUse  tool_name=SendMessage tool_input={'to': 'a019312d4410bdebc', 'summary': 'Ask sub-agent to rep...
7.507 hook PostToolUse tool_name=SendMessage tool_input={'to': 'a019312d4410bdebc', 'summary': ...
7.507 hook SubagentStart agent_id=a019312d4410bdebc agent_type=general-purpose
11.162 hook SubagentStop agent_id=a019312d4410bdebc agent_type=general-purpose
```
  最初の起動時は SubagentStart（2.388）→SubagentStop（3.381）で、再開で同じ agent_id の SubagentStart が再び来て、また SubagentStop が来ている。第三者の記録であり、本環境の Claude Code の版での再現は【未確認】。

### A-4 本番の記録（再開の前後）【事実】
対象: 本番の dataDir の activity フォルダの events-20261012.jsonl（本リポジトリ外の ~/Library/Application Support/agent-console/activity/events-20261012.jsonl・373行・本文はコピーしていない）。集計の実行出力:
```
Counter({('SubagentStop', None): 249, ('UserPromptSubmit', None): 67, ('PreToolUse', 'Agent'): 19, ('PostToolUse', 'Agent'): 19, ('PreToolUse', 'SubagentHandback'): 19})
distinct stop agent_ids 243 with >1 stop 6
handback agents 14 with >1 handback 5
```
- event 名は上の 5 種類だけ。SubagentStart・SendMessage の行は 0 件（設定に入っていないため）。
- Agent の Post 19 件のうち、agentId ごとの SubagentStop / SubagentHandback 件数（先頭 6 桁は tool_use_id の末尾、抜粋）:
```
adLVnE agentId a3ddad790b79537e2 async_launched stops 2 handbacks 2
87mTLx agentId a3a33859e632450bb async_launched stops 2 handbacks 2
CZ3kAa agentId a60851eef1a4b0d17 async_launched stops 2 handbacks 2
rnik9M agentId afbe3cc268c4f9852 async_launched stops 2 handbacks 2
Jao4kW / Ggp7H3 / bHs8Cg / vryz4b  async_launched stops 0 handbacks 0
bjx3of  agentId aops-prod2-mem-… teammate_spawned stops 3 handbacks 0
MLX5qm  agentId adisk-prod1-… teammate_spawned stops 0 handbacks 0
```
- 再開された担当（例 a3ddad790b79537e2）の event 列（時刻は ms）:
```
1791825022519 PostToolUse Agent status async_launched
1791825270103 PreToolUse SubagentHandback
1791825270616 SubagentStop
1791825362534 PreToolUse SubagentHandback
1791825362932 SubagentStop
```
  → 再開の合図になる event は記録されておらず、2 回目の Handback/Stop の組が来るだけ。agent_id は Post の agentId と一致。
- 同じ列の 2 つ目 a3a33859e632450bb も同じ形（Post → Handback/Stop → Handback/Stop）。
- UserPromptSubmit は human 48 / agent 20（source=agent の印）。session_id は 8 種類。
- 状態 teammate_spawned（Post の status）は view() の completed ではないので、stop が無ければ running 側に入る（server/activity.ts:439-440）。

### A-5 「再開したのに終わったまま」の再現【事実】（コード読み＋実行）
- 読み: 1 回目の Handback/Stop で stops・handbacks に agentId のエントリができ endedAt が入る（server/activity.ts:437-440）。再開しても start も新しい終わりも記録されないので、2 回目の終わりが来るまで endedAt は 1 回目のまま＝finished のまま。
- 実行: 本リポジトリ外の使い捨て（scratchpad の board-probe/probe.mts）で、Pre(Agent)→Post(async_launched)→Handback→Stop の 4 行だけ（再開後の event は無し）を入れ ActivityStore.view() を呼んだ出力（v0.10.0 の activity.ts で実行。v0.11.0 でも running / finished の判定は変わっていない）:
```
{"running":0,"finished":[{"endedAt":1791853205100,"summary":"first report"}]}
```

### A-6 release/chat の変更（v0.11.0 として main に入った）【事実】
- 最初の調査のとき、release/chat は origin/main より 4 コミット先で、server/activity.ts・hooks/activity-hook.mjs・server/activity-hooks.ts の 3 ファイルに +147 −15 の差分があった。その後 v0.11.0（288ddcb）として main に入った。
- server/activity.ts: EVENTS に Stop・StopFailure を追加（:24）。ChatItem・chat()・epoch（起動ごとの randomUUID、:191）・unwrapPasted（:86）・previewOf（:91）を追加。applyPrompt は全文＋短い写し。**running / finished の判定（view・orphans・applyPre・applyPost）は変更なし**。
- hooks/activity-hook.mjs: MAX_LINE_BYTES 4096→64KiB（:10）、Stop・StopFailure の record（:145-153）、prompt / last_assistant_message を全文化。
- server/activity-hooks.ts: HOOK_SPECS に Stop・StopFailure を追加（:23-32、6→8 個）。SubagentStart・SendMessage は追加なし。
- → 作戦ボードは v0.11.0 の後に着手する（同じ 3 ファイルの同じ箇所を触るため）。

---

## B. アプリへ書き込む口

### B-1 認証【事実】
- server/http.ts:381-393: /api/ 配下は deps.auth.authenticate({authorization})。null なら 401。セッション認証（method "session"）の POST/DELETE は Origin が自分でないと 403。**Bearer（サーバー秘密）はこの Origin 検査の対象外**（コメント :387）。
- server/auth.ts:134-139: Authorization: Bearer <x> が サーバー秘密のダイジェストと一致 → "bearer"、セッショントークンなら "session"。
- 認証の前に通る口は /healthz、/api/pair*、拡張の部品受け取り 1 本（server/http.ts:370-380）だけ。
- 既存の /api/sessions/:id/activity は GET のみ（server/activity-routes.ts:5,14）。書き込みの口（POST/PUT）は今のところ routines・quick-prompts・sessions 系にあり、ボード用は無い。

### B-2 サーバー秘密の持ち方・既存の CLI【事実】
- 秘密はキーチェーン: server/keychain.ts:7-8,15 service agent-console・account server、security find-generic-password -s agent-console -a server -w。server/secret.ts:24-35 AGENT_CONSOLE_AUTH=keychain のとき読む。
- scripts/ にあるのは ac-install.sh・ac-update.sh・ac-rollback.sh・ac-uninstall.sh・ac-hooks.mjs（設定への hook 追加）・lib/ac-common.sh。**API を叩いて書き込む ac-* のクライアント CLI は無い**。scripts/ac-install.sh:18,27 は秘密の**存在確認**（-w なし）だけ。scripts/lib/ac-common.sh:27 AC_PORT 既定 4319。scripts/lib/ac-common.sh:8-11 は本番実行では AC_CURL などの環境変数の差し替えを無視する。
- 【未確認】Claude の Bash ツールの子プロセスからキーチェーンの秘密を -w で読めるか（読むと値が出るため今回は実行していない）。

### B-3 セッションが自分の id を知る方法【事実】
- pty の子へ渡す環境: server/sessions.ts:76-86 buildChildEnv = 親の環境全部（CHILD_ENV_BLOCKLIST を除く）＋terminalEnv＋TERM。blocklist は server/config.ts:206 の AGENT_CONSOLE_TOKEN・AGENT_CONSOLE_AUTH・AC_SECURITY・AC_STUB_LOG。server/sessions.ts:273 env: { ...buildChildEnv(…), ...extraEnv }。
- extraEnv は復元起動のときの AC_RESUME_ID（Claude の sessionId）だけ（server/sessions.ts:212）。**アプリのセッション id（randomUUID()、:276）も名前も port も環境変数では渡していない**（AC_SESSION などの設定箇所なし）。
- アプリのセッション id は起動のたびに randomUUID()（server/sessions.ts:276）。
- アプリ側が claudeSessionId を知る方法: server/hub.ts:212 が claude agents --json の agent.sessionId を setClaudeSessionId（server/sessions.ts:216-221、UUID の形のみ）に控える。/api/sessions/:id/activity はこの claudeSessionId で記録を引く（server/activity-routes.ts:17-22）。
- Claude 側の公式の環境変数【事実】: CLAUDE_CODE_SESSION_ID — 「Set automatically to the current session ID in Bash and PowerShell tool subprocesses, hook command subprocesses, and stdio MCP server subprocesses. For Bash, PowerShell, and hooks this matches the `session_id` field in the hook JSON input and is updated on /clear. An MCP server subprocess retains the ID it was spawned with. On `--resume <session-id>` it receives the resumed ID, matching hooks and Bash. On `--continue` or `--resume` without an explicit ID it may receive the initial startup ID instead.」（出典: 公式 env-vars の文書の CLAUDE_CODE_SESSION_ID の行、本日取得。本リポジトリ外）。
- 実機確認【事実】: 本調査のセッションの Bash で env | grep -c "^CLAUDE_CODE_SESSION_ID=" → 1（値は出していない）。
- 注意【事実】: /clear で id が変わる（上記の公式文）。一方 open-sessions.json の claudeSessionId は hub が claude agents --json から更新する（server/hub.ts:212）。

---

## C. 画面

### C-1 今の右の欄（v0.11.0 main）【事実】
- src/components/RightPane/RightPane.tsx:9-38: type RightTab = "session" | "ledger"。セッションを選ぶと SA の Tabs（variant="underline" size="sm"）で「このセッション」「台帳」。ラベルは ac.rightTabs.session / ac.rightTabs.ledger（ja: 「このセッション」「台帳」、src/locales/ja.json:362-365）。セッションを変えると「このセッション」が先に開く（:26）。
- 「このセッション」の本体 src/components/ActivityPane/ActivityPane.tsx（198行）: 5 秒ごと（:15）と rev 変化で fetchActivity(sessionId)（:63,75-83）。セクションは Section（SA の Card variant="container" density="compact"、:41-50）で、順に 今の状態（Badge、:117-123）→動いている担当（:135-137）→終わった担当（:138-140、finished は最大 10 件 = server/activity.ts:11）→やること（TaskCreated/Completed、Check/Circle アイコン、:141-154）→最近の入力（3 件、:155-168）。hooks が外れていると Callout 警告（:127-133）。
- 部品の import 元（SA の金型）: Badge・Callout・Card・EmptyState（ActivityPane.tsx:4-7）、Tabs（src/components/RightPane/RightPane.tsx:3）。
- CSS: src/components/ActivityPane/ActivityPane.css（96行、:1-96）= .ac-activity（縦 flex、gap --space-3）、__card、__heading（--font-sm・--text-secondary）、__list、__agent、__muted（--font-xs・--text-muted）、__task（done は --text-muted）、__mark--done（--success）など。src/components/RightPane/RightPane.css（10行）= .ac-right 縦 flex。
- 右の欄が「このセッション」の中身に依存する箇所: src/components/ActivityPane/ActivityPane.test.tsx（211行）、src/components/RightPane/RightPane.test.tsx（54行）、src/pages/ConsolePage.tsx（RightPane を使用、:419）。

### C-2 SA の金型（.sa-cache は本リポジトリ外・SOURCE の 1 行目 6c1c5e82418e3ba38c10702f2a74161fd24a7e80。実装時の sa-sync は ef2f8fca122d4a1a778a913de784fe9758aa4857）【事実】
- 本 worktree には .sa-cache が無かった（最初の調査時。tsconfig.json:16 で @sa/* → .sa-cache/frontend/src/*）。本店の .sa-cache（本リポジトリ外の /Users/tanizawashingo/agent-console/.sa-cache/frontend/src/components）を見た。
- **ProgressBar**（SA の components/loading/ProgressBar.tsx:6-12,20-63。本リポジトリ外）: props = value: number（0-100 に丸めて挟む）、variant?: 'linear'|'striped'|'circular'、label?: string。100% で成功色＋チェック。**label があるとき 100% で文字 'Done' を固定表示（:51。i18n されない）**。import は @sa/components/loading/ProgressBar（src/components/MemoryPanel/MemoryPanel.tsx:5 が実際に使用）。
- **Badge**（SA の Badge.tsx:16-34）: variant neutral|info|success|warning|danger、appearance soft|solid、size sm|md、dot、icon、children、className。
- **Card**（SA の Card.tsx:16-22）: variant container|interactive|metric、density default|compact。
- **Tabs**（SA の Tabs.tsx:26-43）: items {key,label,count?,icon?,disabled?}、activeKey、onChange、variant、size。
- **DataTable**（SA の DataTable.tsx:34-86）: props = columns[{key,header,width?,sortable?,renderCell?}]、data、rowKey(row)、sortKey/sortDir/onSort、selectable/selectedKeys/onSelectChange、density: compact|default|relaxed、emptyState、onRowClick、page/hasNextPage/onPageChange/prevPageLabel/nextPageLabel/pageInfo、rowClassName、className。
- **Stepper・Timeline・Checklist 相当は無い**: ls で components に Stepper 系の名前なし。grep -rli "progress\|stepper" の該当は SA の loading の README.md・index.ts・ProgressBar.tsx のみ。
- その他あるもの: EmptyState・Callout・Tooltip・Popover・Skeleton・Spinner（loading の下）など。

---

## D. 決まりの置き場所

### D-1 各セッションが読む決まり【事実】
- Opus 設計役の起動: agent-console の役割 opus-designer は ["/bin/zsh","-ic","ccopusgo"]（agent-console.config.json:29-35）。Sonnet 実装役は claude --model sonnet（同 :37-44）。shell 役は素の zsh。
- ccopusgo（本リポジトリ外の ~/.claude/shell/ccopusgo.zsh:5-117）は cwd を /Users/tanizawashingo/salesanchor（本リポジトリ外）にして claude --model opus --permission-mode auto --append-system-prompt "$go_prompt" を起動。$go_prompt = ~/.claude/prompts/salesanchor-designer.md（39行）＋ ~/.claude/prompts/salesanchor-claude-go.md（49行）の連結（:7-8,70-79。いずれも本リポジトリ外）。**Opus の起動指示はこの 2 ファイルが正本**。
- 起動指示の記述の食い違い【事実】: claude-go.md（本リポジトリ外）は「許可: Grep・Glob・Read・Bash」と書く一方、別の行に「OpusはBash無効のため直接実行不可」とある（49行中、開始時 1. の行）。Opus が Bash で ac-board を直接打てるかは**【未確認】**（Sonnet に委任すれば Bash は使える旨の記載あり）。
- 全セッション共通で自動に読まれるもの（いずれも本リポジトリ外）: ~/.claude/CLAUDE.md（個人の全体ルール）、~/.claude/rules 以下、cwd のリポジトリの CLAUDE.md（salesanchor の worktree でも読まれる）、自動メモリ MEMORY.md。
- salesanchor の CLAUDE.md（本リポジトリ外の /Users/tanizawashingo/salesanchor/CLAUDE.md、120行）は salesanchor の frontend/scripts/check-claude-size.js（本リポジトリ外）の LIMITS で CLAUDE.md の上限 120（:19-24 付近）。**すでに上限ちょうど**で、1 行足すとコミットがブロックされる。同ファイル内の注意書きは「90行を超えたらブロック」だが、スクリプトの実際の上限は 120（食い違い）。「追加前の決定木」（CLAUDE.md 内）の 6・7 番: ~/.claude/rules 以下に同等があれば書かない／全セッションで知る必要が無ければ書かない。
- salesanchor の AGENTS.md（本リポジトリ外の /Users/tanizawashingo/salesanchor/AGENTS.md、277行）は Codex・実装役向けの正本。「実装役の常設ルール（カード運用）」（:255）と定型文（:269 以降）がある。「自動更新ルール」（:209）あり。

### D-2 既存の KGI/KPI の書き方（引用）【事実】
- salesanchor の docs/STANDARD-WORKFLOW.md:23（本リポジトリ外） 「**1 KGI設定** | Planner＋PO | 何を実現するかを**定量のKGI**で定義。**PO承認が必須ゲート**」。:101-106「KGI/KPI 粒度基準」= 「KGIはPOが画面・出力で○×を一義に判定できる粒度で書く。抽象語（統一/改善/正常/復帰）禁止→観測可能な事象に分解。／KGI達成の道のりをKPIに分解し、各KPIを数値で測る。／KPIもKGIと同粒度で設計。」
- 成功条件の表の例（本リポジトリ）docs/handoff/stage1-5/design.md:12-17: 見出し「## 2. KGI（○×で判定）」、表ヘッダ | # | 基準 | 検証方法 |、行 | K1 | Dock（…）を 1 回クリックすると、URL を貼らずにログイン済みの画面がアプリ窓で開く | PO 実機 1 回＋自動テスト（…） |。K1〜K5 の番号（K=KGI）で並ぶ。ロードマップに当たる専用の様式は見つけていない（段階・便の番号付けは各 design.md に自由記述）【未確認】。
- salesanchor の docs/STANDARD-WORKFLOW.md:39（本リポジトリ外）に 3 ファイル構成（README.md / ideal-state.md / kgi.md）の記述あり（本調査では本文を読み切っていない）。

---

## E. 保存の作法

### E-1 dataDir の実物【事実】
本番の dataDir（本リポジトリ外の ~/Library/Application Support/agent-console/）を ls -la した出力:
```
drwx------ activity   drwx------ chrome-extension   lrwxr-xr-x current -> versions/v0.9.1
drwx------ hooks      drwxr-xr-x logs
-rw------- open-sessions.json (1776)  -rw------- picker-token (65)  -rw------- quick-prompts.json (4853)
drwx------ uploads    drwxr-xr-x versions
```
- curl -s http://127.0.0.1:4319/healthz → {"ok":true,"version":"0.9.1","commit":"807e9fa4afbed03b857586eb8f2c95086435323c"}（本番は v0.9.1 稼働。main の v0.10.0 は未導入）。
- 更新・切戻しは versions の下と current の付け替えで、dataDir 直下のファイル・hooks・activity はその外にあるので版をまたいで残る（構成からの読み取り。更新時に dataDir を消さないことを scripts/ac-update.sh で全行確認はしていない【未確認】）。

### E-2 書き方【事実】
- open-sessions.json: server/session-store.ts:6-9,45-51,87-98 = {version:1, items:[…]}。保存は直列キュー → 先に既存ファイルを読み（壊れていれば上書きせず例外）→ mkdir -p（700）→ <file>.<uuid>.tmp に 600 で書く → chmod 600 → rename。版違いは例外。
- quick-prompts.json: server/quick-prompts.ts:10-11,61-62,99-103 同じ作法（{version, items}）。picks: server/picks.ts:211-219,246 1 件 1 ファイル {version, pick}、dir 700・file 600・tmp→rename。
- activity: hooks/activity-hook.mjs:10-12,159-198 = events-YYYYMMDD.jsonl（UTC 日付）に O_APPEND の 1 回 write、dir 700 / file 600。サーバーが読む側（server/activity.ts）は dataDir の activity フォルダを読み足すだけで正本はファイル（:2）。保存日数 activityKeepDays 既定 7（server/activity.ts は keepDays ?? 7、:208）。古い日付ファイルは pruneOldFiles（:493-510）で消える。
- 今日時点の open-sessions.json の中身（値は伏せ、キーだけ）: version 1、items 9 件、各 roleId（すべて opus-designer）・name・cwd・claudeSessionId。

### E-3 セッションの識別子【事実】
- アプリのセッション id: 起動のたびに randomUUID()（server/sessions.ts:276）。再起動・復元で変わる。
- 再起動をまたいで同じ会話を指すのは claudeSessionId（open-sessions.json に保存、復元で AC_RESUME_ID として渡し、同じ id を引き継ぐ = server/sessions.ts:209-212 のコメント）。
- activity の記録の鍵も Claude の session_id（server/activity.ts:22,181）で、アプリのセッションとは claudeSessionId で結ぶ（server/activity-routes.ts:17-22）。
- 揺らぎ【事実・公式】: /clear で CLAUDE_CODE_SESSION_ID が更新される（B-3 の引用）。--continue や id なしの --resume では起動時の id になりうる。このとき記録の鍵（session_id）が変わる。claudeSessionId が変わったとき open-sessions.json が更新されるのは server/hub.ts:212 のポーリング経由【事実】だが、遅れの大きさは【未確認】。
- chat（v0.11.0）は ActivityStore に epoch（起動ごとの randomUUID、server/activity.ts:191）を足し、seq はアプリの起動ごとに振り直す。ボードを in-memory にすると同じ性質になる。

---

## 未確認の一覧
1. SendMessage の PreToolUse の tool_input の項目（公式の hooks.md には無い。第三者の実記録では to・summary）。→ 工程0 (a) で実測した（docs/handoff/board/step0.md）。
2. 本環境の Claude Code の版で、SendMessage による再開時に SubagentStart が実際に来るか（公式の文は有り。本番記録には SubagentStart が無く、hook 未登録のため検証不能）。→ 工程0 (a) で実測した。
3. Claude の Bash 子プロセスからキーチェーンの秘密を -w で読めるか。
4. Opus 設計役（ccopusgo）が Bash を直接使えるか（起動指示の記述が食い違い）。
5. ac-update.sh が dataDir 直下を触らないことの全行確認。
6. ロードマップの既存様式（専用のものは見つけていない）。
