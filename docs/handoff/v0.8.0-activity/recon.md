# v0.8.0 activity recon（右の欄にセッションの様子を出す機能）

調査日 2026-10-12 / 基準 origin/main cee6737（v0.6.1）/ 製品コード・設定は変更なし / 設計提案なし。
略称: 公式 hooks 文書 = https://code.claude.com/docs/en/hooks.md（本リポジトリ外）を取得した写し hooks.md の行番号。Claude Code は 2.1.296（`claude --version` の実測）。

## A. 公式 hooks の仕様

### A-1 【事実】共通入力（hooks.md L732-741）
- session_id: 現在のセッション識別子
- prompt_id: 処理中のプロンプトの UUID。最初の入力までは無い
- transcript_path: 会話 JSON のパス。非同期に書かれ遅れることがある（最終文は Stop / SubagentStop の last_assistant_message を使うよう明記、L736）
- cwd, scratchpad_dir（v2.1.257 以降、無いこともある）, permission_mode, effort（level）, hook_event_name
- agent_id / agent_type（L745-748）: サブエージェント内で発火したときだけ付く。agent_type は --agent 指定時もあり、サブエージェントの種類が優先
- model は SessionStart だけ（L750）。環境変数 CLAUDE_MODEL は無い（L752）

### A-2 【事実】イベント別
- SubagentStart（L2490-2503）: 追加は agent_id、agent_type のみ。ブロック不可。再開・teammate の新メッセージでも発火（L2486）
- SubagentStop（L2526-2553）: stop_hook_active, agent_id, agent_type, agent_transcript_path（親 transcript とは別の nested subagents/ フォルダ、L2528）, last_assistant_message, background_tasks, session_crons（両配列は親セッション単位、L2536）。内部エージェント（prompt suggestions、/btw）でも発火し、そのとき agent_type は空文字のことがある（L2530）。SubagentHandback で報告するサブエージェントは、報告本文が last_assistant_message ではなく SubagentHandback の tool_input.message（L2534）
- PreToolUse の Agent（L1853-1858）: tool_input は prompt, description, subagent_type, model（任意の別名。例 "sonnet"）。PreToolUse 共通で tool_use_id が付く（L1697）
- PostToolUse の Agent（L1862-1878）: tool_response は status（completed / async_launched。run_in_background を省くと既定で async_launched、L1864）, agentId, content, resolvedModel, modelsUsed, totalTokens, totalDurationMs, totalToolUseCount, usage。バックグラウンド起動では usage 系は無く agentId, description, prompt, outputFile, resolvedModel（L1876）。PostToolUse には duration_ms（任意）もある（L2154-2156）
- TaskCreated（L2563-2588）/ TaskCompleted（L2618-2644）: task_id, task_subject, task_description（任意）, teammate_name（任意）, agent_id（v2.1.290 以降）。matcher 不可。TaskCreate ツールが無いセッションでは TaskCreated は発火しない（L2559）。TaskCompleted は TaskUpdate での完了時と teammate の手番終了時（L2614）
- 【事実】TaskUpdated に相当するイベントは公式文書に無い（hooks.md 全体の grep で TaskUpdate が出るのは L1105, L2614, L2651 の TaskCompleted 関連のみ）。完了以外の状態変更（in_progress への変更など）を拾うイベントは【未確認】
- UserPromptSubmit（L1438-1453）: prompt（貼付けは展開済み）, session_title（任意）。人が打った入力以外でも発火する（スケジュール、バックグラウンド subagent の報告、他セッションからのメッセージ、L1426-1430）
- Stop（L2679-2741）: stop_hook_active, last_assistant_message, background_tasks（id, type, status, description, agent_type など。type は shell / subagent / monitor / workflow / teammate など、L2689-2701）, session_crons。ユーザー中断では発火しない。API エラーは StopFailure（L2671-2673）
- Notification（L2466-2479）: message, title, notification_type。種類は permission_prompt（許可待ち約6秒後）, idle_prompt（応答後約60秒）, agent_needs_input, agent_completed など（L2398-2411）

### A-3 【事実】設定の書き方と動作
- 3階層: イベント → matcher group → handler（L239-243）
- matcher: 空・"*"・省略で全一致。英数字と _ - , | のみなら完全一致（| か , で複数）。他の文字を含むと JS 正規表現（L291-295）
- handler 共通項目: type, if, timeout, statusMessage, once（L422-428）。command 固有: command, args, async, asyncRewake, shell, onFailure（L454-461）
- timeout の既定: command は 600秒。UserPromptSubmit と PostModelSwitch は 30秒、MessageDisplay は 10秒（L426）
- 同期 hook は Claude の動作を止める。UserPromptSubmit は「止まった hook はセッションを止める」と明記（L1432）
- `"async": true`（command のみ）: Claude を止めずバックグラウンド実行。決定系の出力は無効。timeout は効かない（L3995-4022）。毎回別プロセス（L4100）。出力は次のターンで届く（L4099）
- 失敗時: 終了コード 0 以外（2 を除く）は非ブロックのエラーで動作は続行（L856-858）。onFailure:"block" は v2.1.295 以降（L881-883、現在の 2.1.296 で利用可）
- 並列と重複: マッチした hook は全て並列実行。同一 handler が複数の settings にあれば1回だけ（L412）。同一イベント内の実行順の保証は文書に記載なし【未確認】
- 標準入力で JSON を受け取る（L406）。hook はユーザー権限で任意コマンドを実行する（L4107）

## B. PO の今の hooks（/Users/tanizawashingo/.claude/settings.json、読み取りのみ。本リポジトリ外）
【事実】トップレベルキー: permissions, hooks, enabledPlugins, extraKnownMarketplaces, tui, skipDangerousModePermissionPrompt, skipAutoPermissionPrompt, autoMode（値は出していない）。timeout 指定は全 handler で無し（既定値）。

| イベント | 登録数（handler） | 内訳（matcher / スクリプト名 / async） |
|---|---|---|
| Stop | 2 | なし / agent-stop-hook.sh / 同期、なし / japanese-reply-guard.py（python3）/ 同期 |
| PreToolUse | 13 | なし / agent-start-hook.sh / async:true。Bash: worktree-only-guard.sh, agent-danger-hook.sh, worktree-access-guard.sh, gh-scope-guard.sh, pr-body-guard.sh。Read: worktree-access-guard.sh。Edit: worktree-only-guard.sh, worktree-access-guard.sh。Write: worktree-only-guard.sh, worktree-access-guard.sh。Glob: worktree-access-guard.sh。Grep: worktree-access-guard.sh（すべて同期） |
| PostToolUse | 1 | Write / jq と notify.sh の1行コマンド（プラン作成の通知。出力は180文字弱）/ async:true |
| UserPromptSubmit | 1 | なし / card-lint-hook.sh / 同期 |

- スクリプトはすべて /Users/tanizawashingo/.claude/scripts/ 配下（本リポジトリ外）
- SubagentStart / SubagentStop / TaskCreated / TaskCompleted / Notification の登録は 0 件
- PreToolUse の Agent に matcher した登録は 0 件（matcher なしの agent-start-hook.sh だけが Agent を含む全ツールに async で掛かる）
- salesanchor リポジトリ: /Users/tanizawashingo/salesanchor/.claude/settings.json に SessionStart が 6 件。/Users/tanizawashingo/salesanchor/.claude/settings.local.json に hooks は 0 件
- 【事実】本調査中、PreToolUse:Bash の worktree-only-guard.sh が、`cd` を含む私のコマンドを「working directory could not be resolved safely」で止めた。cd を使わず絶対パスで再開して通った

## C. agent-console の現在

### C-1 右の欄
- `src/pages/ConsolePage.tsx:380-382`: `<aside className="ac-page__right">` の中身は LedgerBoard（snapshot と onRefresh を渡す） のみ。左 aside は `src/pages/ConsolePage.tsx:266`
- `src/components/LedgerBoard/LedgerBoard.tsx:22-27` Props は snapshot, onRefresh, now。`src/components/LedgerBoard/LedgerBoard.tsx:42-49` section.ac-ledger と見出し・更新ボタン、`src/components/LedgerBoard/LedgerBoard.tsx:50-74` に期間・状態・検索のフィルタ
- 現在の右の欄は台帳（ledger）専用で、選択中セッションの情報を受け取る口は無い【事実】。選択中セッションは ConsolePage 側に activeSession がある（`src/pages/ConsolePage.tsx:376`）

### C-2 Claude の sessionId の把握
- `server/agents.ts:7-17` AgentRow に sessionId?: string。`server/agents.ts:46` で文字列のときだけ採用
- `server/hub.ts:113-119` pollAgents が `claude agents --json` を定期取得 → detectBreaks。`server/hub.ts:192-199` セッションごとに `agentForSession`（プロセスの子孫 pid 照合、`server/agents.ts:61-64`）で行を引き、sessionId があれば `this.sessions.setClaudeSessionId` を呼ぶ
- `server/sessions.ts:213-216` setClaudeSessionId は UUID の形（`server/sessions.ts:21` の isClaudeSessionId）だけ受理。`server/sessions.ts:51` Session.claudeSessionId
- 復元リスト: `server/session-store.ts:11-18` OpenSessionItem.claudeSessionId（取れたときだけ）、`server/session-store.ts:35-43` UUID でなければ捨てる。復元は `server/restore.ts:81, 140`、起動時の再開は `server/sessions.ts:201-205`（環境変数 AC_RESUME_ID）
- SessionView（`src/types.ts:3-19`）に claudeSessionId の項目は無い【事実】。画面側は sessionId を知らない
- sessionId が取れないセッション: `server/agents.ts:61-64` で行が引けない（Claude 未起動）か、行に sessionId が無いと claudeSessionId は未設定のまま。Claude 起動後に一言も入力していないセッションが `claude agents --json` の行を持つか否かは、今回の実測では【未確認】（実測の11行は全て sessionId を持っていた）

### C-3 `claude agents --json` の実測（2026-10-12、11行）
- 項目名（全行共通）: pid, cwd, kind, startedAt, sessionId, name, status。kind の値は 11 行とも interactive。status の値は busy / idle（11行中 busy 4、idle 7）
- waitingFor は status が waiting のときだけ付く（`server/agents.ts:12-13` の記述。今回の実測行には無し）
- サブエージェント・タスクに関する項目は無い【事実】
- 11 行の sessionId はすべて、/Users/tanizawashingo/.claude/projects/<プロジェクト>/<sessionId>.jsonl（本リポジトリ外） というファイル名と一致した（11/11）。hook の session_id と同一かは hook を実際に動かして比べるまで【未確認】

### C-4 dataDir の作法
- 既定の保存先は ~/Library/Application Support/agent-console/（本リポジトリ外）（README.md:19、設定 dataDir で変更）。`server/config.ts:58, 136-138, 230`
- 書き込み: 一時ファイルに書いて rename。ファイル権限 600、フォルダ 700。例 `server/quick-prompts.ts:10-11, 83-89`、`server/diff-comments.ts:10-11, 169-173`、`server/picks.ts:10-11, 211-219`、`server/picker-extension.ts:14-15, 56-61`
- 読み書きの直列化: `server/quick-prompts.ts:58-69`（Promise のキュー）。壊れたファイルは上書きせず例外（`server/quick-prompts.ts:79-80`）
- 追記型（appendFile）の先例: server 配下の .ts を grep して appendFile は 0 件【事実】。追記型の先例は無い
- 構築: `server/index.ts:62-71` で各 Store に config.dataDir を渡す

## D. 実物の観測（このMac、/Users/tanizawashingo/.claude/projects/、ファイル名と件数のみ）
- プロジェクトフォルダ 28。親セッションの transcript（<プロジェクト>/<sessionId>.jsonl）は深さ2で 91 件
- subagents フォルダは 71。配置は <プロジェクト>/<親sessionId>/subagents/。中のファイルは 12535
- 名前の形: `agent-<英数16桁>.jsonl` 6357 件（うち `agent-acompact-<16桁>.jsonl` 170 件）、agent-<16桁>.meta.json 6178 件
- 公式の「agent_transcript_path は nested subagents/ フォルダ」（hooks.md L2528, L2548）の形と一致
- 【申告】.meta.json のうち agentType と model の2項目だけは値を数えるために読んだ（jsonl の中身は読んでいない）。meta.json は公式文書に記載のない形式【事実】（hooks.md を grep、該当記述なし）。使う前提にするかは設計側の判断

## E. 文言（実例）
- 【事実】.meta.json の agentType の実在値（上位）: general-purpose（約5800）, reviewer（約120）, Explore（約75）, architect 5, research, researcher, evaluator, claude-code-guide, Plan, generator, fork。ほかに作業名のような値（例 recon-hooks-sonnet, impl-docs-sonnet）が多数。Agent ツールの name 指定がそのまま入っている可能性があるが、仕組みは【未確認】
- 【事実】.meta.json の model: 値あり sonnet 約1470, fable 28, opus 4, inherit 1。値なしが約4680（サブエージェントの model は PreToolUse の tool_input で省略可、hooks.md L1858 で任意項目）
- 【事実】公式の例: agent_type は "Explore", "security-reviewer"（L748）、組み込みは general-purpose, Explore, Plan、カスタムは frontmatter の name、プラグインは "my-plugin:reviewer" のように plugin 名付き（L2486-2488）
- 【事実】model の実際の呼び名は tool_input.model（別名）と tool_response.resolvedModel（例 "claude-sonnet-4-5"）の2系統で、後者が実際に動いたモデル（L1867, L1878）
- 【事実】この調査を依頼してきたセッションが選べるサブエージェント種別: architect, claude, claude-code-guide, evaluator, Explore, general-purpose, generator, governance, Plan, planner, research, researcher, reviewer, statusline-setup。Agent ツールの model 引数の選択肢は sonnet, opus, haiku, fable

## 未確認の一覧
1. 同一イベントに複数 hook があるときの実行順（hooks.md に記載なし）
2. TaskUpdated 相当（完了以外の進捗変更）を拾えるイベント
3. hook の session_id と `claude agents --json` の sessionId の一致（transcript ファイル名とは 11/11 一致）
4. Claude 起動後に未入力のセッションが `claude agents --json` に現れるか／sessionId を持つか
5. 実際の hook 入力の実物（PreToolUse の Agent で model が来る頻度、SubagentStart の発火タイミングと順序）
