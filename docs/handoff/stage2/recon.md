# 段階2 recon（事実のみ・推奨なし）  2026-10-11
基準: agent-console origin/main（`git -C … show origin/main:<path>`）。行番号は各ファイル内の行。
生ファイル: s2-ac-server.txt（server/*.ts 全文+行番号）, s2-ac-front.txt, s2-sa-props.txt（同ディレクトリ）

## A. 終了通知
### A1 現行の状態取得と配信
- 状態型 `AgentStatus = busy|waiting|idle|unknown` server/agents.ts:6、`SessionState = working|waiting|idle|no-claude|stopped|unknown` agents.ts:13
- `claude agents --json` を execFile で実行（timeout 15000）agents.ts:58-65。解析は pid/status/name のみ取り込み agents.ts:21-39（sessionId・waitingFor・cwd・kind は捨てている）
- status→state 対応 agents.ts:46-55（busy→working, waiting→waiting, idle→idle, pidが一致しない→no-claude, pty終了→stopped）
- 更新間隔: agent-console.config.json:8 `agentsPollMs: 3000`、:9 `ledgerPollMs: 60000`。ポーリング実装 server/poll.ts:2-20（前回完了後に次を予約）
- 配信: Hub.pollAgents→publish() server/hub.ts:65-69,109-117（JSON が前回と同一なら送らない hub.ts:112）。WebSocket `/ws/events` server/ws.ts:90-94→hub.subscribe hub.ts:99-107。クライアント受信 src/pages/ConsolePage.tsx:30-34（onmessage で setState）、切断時1秒で再接続 ConsolePage.tsx:17,35-38
- 台帳は別経路: GET /api/ledger server/http.ts:122、画面側 60 秒ポーリング ConsolePage.tsx:16,61-66
- 画面の状態表示: SessionList.tsx:35,47（data-state, StatusDot）
- 遷移検出（busy→idle 等）をする実装は現行に無い（上記ファイルに前回値保持なし。hub.ts:30 lastPayload は文字列全体比較のみ）

### A2 公式文書（https://code.claude.com/docs/en/agent-view , /hooks 。Context7 /websites/code_claude）
- status/waitingFor の原文: 「`pid`, `status` | While the process is alive | Process ID and one of `busy`, `waiting`, or `idle`」「`waitingFor` | When `status` is `waiting` | … `permission prompt` for an approval, `input needed` for a question from Claude or an MCP server's input request, `sandbox request`, `worker request`, or `dialog open`」
- `state`（background セッションのみ）: working / blocked / done / failed / stopped。原文「A session that finished its turn and is waiting for your next instruction reads `done`, not `blocked`. `blocked` always means the session needs something from you」
- 「`claude agents --json` is the supported way to read session state from outside Claude Code」「Poll `claude agents --json --all`」。`~/.claude/jobs/<id>/` は「not a stable interface」
- interactive セッションには `state` が無い（この Mac 実測: interactive 9 件、キーは cwd,kind,name,pid,sessionId,startedAt,status）。interactive の「完了」を示す専用フィールドの記載: 未確認（文書上 status が busy→idle になることしか読み取れていない。busy→idle 遷移を「完了」と定義する記述も未確認）
- Notification フック matcher 原文表（/hooks）:
  - permission_prompt: 「Claude needs you to approve a tool use or a sandboxed command's network request, and the prompt has waited about six seconds」
  - idle_prompt: 「Claude finished responding about 60 seconds ago and you haven't typed since」
  - agent_needs_input: 「A background session starts waiting on your input while agent view is open in a terminal. …」
  - agent_completed: 「A background session finishes or fails. Fires only while agent view is open in a terminal」
  - ほか auth_success / elicitation_dialog / elicitation_url_dialog / elicitation_complete / elicitation_response / quota_auto_resume_fired / _stale / _disabled
  - 入力例: `{"session_id","transcript_path","cwd","hook_event_name":"Notification","message","title","notification_type"}`
- Stop フック: 「When Claude finishes responding」（/hooks 表）。フックは ~/.claude 等の設定側に置く必要があり、本調査では書き込まず未検証。

### A3 ブラウザ
- Notification: MDN https://developer.mozilla.org/en-US/docs/Web/API/Notification 「Secure context: This feature is available only in secure contexts (HTTPS)」
- secure context: MDN https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts 「Documents are secure contexts when their resources are delivered over an HTTPS connection, or are delivered from a loopback (local) address.」「A host value of 127.0.0.0/8 or ::1/128」→ 127.0.0.1 は原文の範囲内
- requestPermission: MDN …/Notification/requestPermission_static 「the request should be made in response to user interaction」。戻り値 granted / denied / default（default は denied 扱い）
- Chrome `--app=` 窓での許可ダイアログ・通知挙動の公式記述: 未確認（試したこと: MDN のみ。Chrome 公式文書は未取得。実機でも未実行）。起動は ops/launcher/launch.sh:76 `open -na "Google Chrome" --args "--app=${BASE}/pair?code=…"`
- Web Audio: MDN https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices 「Create or resume context from inside a user gesture」「if you create the context outside of a user gesture, its state will be set to `suspended` … using the `resume()` method」
- document.title の公式記述（通知用途）: 未確認。favicon バッジ: 公式記述未確認。代替の Badging API は MDN …/Badging_API 「setAppBadge() (for installed apps)」「Secure context」「not Baseline」。インストール済みでない `--app` 窓での挙動: 未確認

### A4 macOS 通知
- `man osascript`（この Mac）: `osascript [-l language] [-i] [-s flags] [-e statement | programfile] [argument ...]`
- Apple 公式 https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html 原文: 「provide the `display notification` command with a string to display. Optionally, provide values for the `with title`, `subtitle`, and `sound name` parameters」例: `display notification "All graphics have been converted." with title "My Graphic Processing Script" subtitle "Processing is complete." sound name "Frog"`。「the script … is added to the list of notifying apps in System Preferences > Notifications」
- この Mac に terminal-notifier: 無し（`which` 結果なし）。実行はしていない。

## B. 名前・よく使う指示
### B1 Claude Code
- 原文 https://code.claude.com/docs/en/sessions 「At startup `claude -n auth-refactor` / During a session `/rename auth-refactor`. The name also appears on the prompt bar / From the session picker … Ctrl+R」
- `claude --help`: 「-n, --name <name>  Set a display name for this session (shown in the prompt box, /resume picker, and terminal title)」
- name の出所: agent-view 文書「`sessionId`, `name` | When set | … An interactive session's `name` is its default display name until you name the session or accept a plan in it」
- 同名: 「if another live session on this machine already uses the name, Claude Code applies a variant」（two-word suffix）
- 外部からの改名: Agent SDK `rename_session(session_id, title, directory=None)`「Renames a session by appending a custom-title entry」(https://code.claude.com/docs/en/agent-sdk/python)。CLI から外部改名するサブコマンド: `claude --help` の Commands 一覧に無い（agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, purge, respawn, rm, setup-token, stop, ultrareview, update）

### B2 Orca（/private/tmp/…/orca-src/orca 残存・読めた）
- quick command 型: src/shared/terminal-quick-command-types.ts:3-32（scope global|repo、action terminal-command|agent-prompt、command/appendEnter、prompt）
- 上限: src/shared/terminal-quick-commands.ts:10-17（最大40件、label 80字、terminal text 4000字、agent prompt 6000字）
- 保存先: settings.terminalQuickCommands（src/shared/global-settings-types.ts:155、default-global-settings.ts:104）。永続化 src/main/runtime/runtime-client-settings.ts:180,196 `store.updateSettings({terminalQuickCommands: next})`。保存ファイル名は orca-data.json（src/main/persistence/*.test.ts:34 等で確認。settings がその中かは未確認）
- 送信方法: src/renderer/src/components/terminal-pane/terminal-quick-command-dispatch.ts:37-40 `transport.sendInput(buildTerminalQuickCommandInput(flattenTerminalQuickCommand(command)), 'driving')`。入力組立 terminal-quick-commands.ts:250-252 `appendEnter ? command + "\r" : command`。複数行は `; ` 連結 terminal-quick-commands.ts:258-270。agent-prompt 型は dispatch.ts:30-32 で false を返し別経路（起動コマンド）
- セッション名: 「displayName」「comment」を worktree メタに持つ。use-worktree-card-foundation.ts:58,75,90（openModal('edit-meta', {currentDisplayName…})）、更新 store/slices/worktrees/metadata/update-worktree-meta.ts:40-（updateWorktreeMeta）。Claude Code 側の /rename には送っていない（grep 未実施=未確認）

### B3 agent-console 現行
- 名前は入力値を保持するのみ: server/sessions.ts:9,44-50（1〜40字・制御文字不可）、:28-39 Session.name、:139-141 生成時に設定。メモリ上のみ（永続化なし: sessions.ts:71 Map）。再起動で消える
- 名前変更 API: 無し（http.ts のルートは /api/ledger, /api/ledger/refresh, POST /api/sessions, DELETE /api/sessions/:id のみ。http.ts:122-138）
- 表示: server/hub.ts:11,89 → src/components/SessionList/SessionList.tsx:45
- Claude の `name`（agents --json）は agents.ts:36 で取るが画面に出していない（AgentRow.name のみ・hub で未使用）
- よく使う指示: 現行に該当実装なし（ws.ts の /ws/term 入力は生の文字列を pty.write: sessions.ts:175-177）

## C. 過去セッション再開
- `claude --help` 原文: 「-c, --continue  Continue the most recent conversation in the current directory」「-r, --resume [value]  Resume a conversation by session ID, or open interactive picker with optional search term」「--from-pr [value]  Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term」「--fork-session  When resuming, create a new session ID instead of reusing the original」「--session-id <uuid>」「--bg, --background  … With --resume <session-id>, continues that session in the background under the same ID」
- 公式 CLI reference: 「`--resume`, `-r` | Resume a specific session by ID or name … you can pass the absolute path to a session's `.jsonl` transcript file … When you pass a session ID, Claude Code searches the current project directory and its git worktrees, then every other project on this machine」
- `claude agents --all --json` 実測（この Mac, 2026-10-11）: 9 件、`claude agents --json` と同件数・同キー: pid,cwd,kind(=interactive),startedAt,sessionId,name,status(busy|idle)。completed の background セッションは 0 件（全て interactive）
- 正規の一覧取得: Agent SDK `list_sessions(directory, limit)` / `listSessions()` と `get_session_messages` / `getSessionMessages()`、`get_session_info` / `rename_session` / `tag_session`（https://code.claude.com/docs/en/agent-sdk/sessions 「Both SDKs expose functions for enumerating sessions on disk and reading their messages」）。CLI 単体での非対話の過去セッション一覧コマンド: `claude --help` に無い（未確認=agents --all は背景セッション向け）
- 保存場所: 「Claude Code stores sessions per project directory」(sessions 文書)。~/.claude/projects 配下 jsonl の構造を「読んでよい」と明記した文書: 未確認（hooks 文書の入力例に transcript_path が *.jsonl として載るのみ）。ファイルは開いていない。
- SDK 利用時 2 点: agent-console は Node/TS（TypeScript SDK `@anthropic-ai/claude-agent-sdk` の listSessions 名は上記文書の記述。パッケージ導入・実行は未検証）

## D. 台帳ボード
### D1 現行の取得列
- server/ledger.ts:12-17 `parseBranchLine`（1行目 `branch: ` のみ）、:24-27 `LedgerRow {branch, state}`、:30-36 `parseLedgerRow`（表の1列目=ブランチ、4列目=状態のみ）、:96-104 `lookupBranch`（scripts/ledger-lookup.sh を1ブランチずつ実行、並列8: :8）、:65-79 groupByState（IN_PROGRESS/REVIEW/DONE/OTHER/UNREGISTERED: :54）
- カードに載る値は branch と state だけ（LedgerCard :44-47）。開始日時・PR#・担当・備考は取っていない
- 画面: src/components/LedgerBoard/LedgerBoard.tsx:35-45（列ごとにカード、ブランチ名のみ表示）。絞り込み機能は現行に無い

### D2 本店 .claude-pipeline/active-work.d の実測（作業ツリー。読み取りのみ）
- ファイル 498 件（`ls | wc -l`）。git 追跡は 85 件（`git ls-files`）= 残りは未追跡（.gitignore:71 `!…active-work.d/*.md`）
- ファイル構造: 1行目 `branch: …`、空行、ヘッダ `| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |`、区切り行、1行。`|` 行数が 0 のファイル 5 件、備考内の `|` 等で行数が 3 を超えるファイル 5 件
- 日付形式の行 489（開始日時列が YYYY-MM-DD を含む）の月別: 2026-07: 21 / 2026-08: 3 / 2026-09: 274 / 2026-10: 191
- 状態別（同 489 行）: DONE 344 / IN_PROGRESS 132 / WIP 7 / REVIEW 5 / pr-open 1。IN_PROGRESS の月別: 2026-07: 11 / 2026-09: 85 / 2026-10: 36
- 開始日時の書式揺れ: 日付形式でない値が混入（例 `20260920_010000`, `20260919_010000` の別形式、列ずれによる文字列）。表記は `YYYY-MM-DD HH:MM` が大半

### D3 正本ルール
- docs/specs/ledger-guard/design-phase2.md:12「置き場: `.claude-pipeline/active-work.d/<ブランチ名のセーフ形>.md`（1ブランチ1ファイル）」:13「1行目 `branch: <正式ブランチ名>`…続けて現行と同一の7列テーブル」:26「`scripts/ledger-view.sh`: 本体＋.d/全件を1枚の表に連結表示」:27「台帳の所在を知るのはこの3本だけ。読者・書き手は窓口だけを呼ぶ」:71「.d/ファイルはDONE後も残す（ADR-114踏襲）→ 件数増は対策③の掃き出し便で整理」
- 7列: scripts/ledger-view.sh:11 `| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |`
- docs/STANDARD-WORKFLOW.md:99「tasks/todo.md・.claude-pipeline/active-work.md の『完了（DONE）』移動は、上記4つを満たした事実の記録である。実証がないまま完了へ移してはならない。」
- 注: ledger.ts は窓口 ledger-lookup.sh 経由（ルール準拠）だが、ブランチ一覧は active-work.d を直接 readdir（ledger.ts:124-145）

## E. メモリ数値
### E1 この Mac の出力実例（1回）
- `sysctl hw.memsize`: `hw.memsize: 8589934592`（8GiB）
- `sysctl vm.swapusage`: `total = 5120.00M  used = 3704.44M  free = 1415.56M  (encrypted)`
- `ps -axo pid=,ppid=,rss=,comm=` 先頭: `    1     0   8448 /sbin/launchd` / `  197     1   3632 /usr/libexec/nehelper` …。`man ps`: 「rss  the real memory (resident set) size of the process (in 1024 byte units)」→ KB。comm はパス付き全体（スペース含む例あり: `…/Visual Studio Code.app/…`）。
- `memory_pressure`（先頭〜）: `The system has 8589934592 (524288 pages with a page size of 16384).` `Pages free: 3547` `Pages active: 128484` `Pages inactive: 127637` `Pages wired down: 109198` `Pages used by compressor: 119110` `Swapins: 1903709` `Swapouts: 2334007` … 末尾 `System-wide memory free percentage: 53%`
- `vm_stat`: `Mach Virtual Memory Statistics: (page size of 16384 bytes)` 以下 `Pages free: 3640.` `Pages active: 128491.` `Pages inactive: 127638.` `Pages wired down: 109198.` `Pages occupied by compressor: 119108.` `Swapins: 1903709.` `Swapouts: 2334007.`（行末にピリオド）
- 注: memory_pressure の free percentage(53%) と vm_stat の Pages free(3640×16384≈57MB) は指標が別。差の算出方法は未確認（`memory_pressure` 文書は未取得）

### E2 現行プロセスツリー
- server/process-tree.ts:42-45 `ps -axo pid=,ppid=`（rss 無し）、:11-18 parsePsOutput（正規表現 `^\s*(\d+)\s+(\d+)\s*$` で2列限定）、:21-40 descendantPids（BFS）。利用: hub.ts:86,94（snapshot ごとに ps 実行）。rss/comm を読む実装は無い

## F. Sales Anchor 金型（frontend/src/components/*, origin/main。全文: s2-sa-props.txt）
- Badge.tsx:16-34: variant `neutral|info|success|warning|danger`, appearance `soft|solid`, size `sm|md`, dot?, icon?, children, className?
- Button.tsx:24-37 / buttonAppearance.ts:1-2: variant `primary|secondary|ghost|danger|outline|tab`, size `sm|md|lg`, fullWidth, loading, loadingText, active(tab), iconOnly(aria-label必須), layoutClassName
- Modal.tsx:22-33: open, onClose, title(string), size `sm|md|lg|xl`, dismissOnOverlay?, children, footer?
- Popover.tsx:23-36: children(trigger), content, placement?, open?, onOpenChange?, className?
- Select.tsx:15-23,25-30: options `{value,label,disabled?}[]`, size `sm|md|lg`, fullWidth, placeholder, appearance `field|bare`（variant standard|karte|header|tabbar）
- Tabs.tsx:25-44: items `{key,label,count?,icon?,disabled?}[]`, activeKey, onChange, variant `underline|pill`, size `sm|md`
- TextField.tsx:19-27 / Textarea.tsx:19-25: label?, helperText?, error?, size `sm|md|lg`, fullWidth（+ input/textarea 標準属性）
- IconToggleButton.tsx:21-37: pressed, onClick, iconOff, iconOn, aria-label(必須), size?, variant `default|badge`, disabled?, count?
- loading/ProgressBar.tsx:6-12: value 0-100, variant?, label?
- loading/Toast.tsx:5-35,50-: `toast.success|warning|error|info(title, {description?, duration?=4000})`、`<Toaster/>` を一度マウント必須。aria role=status
- DataTable.tsx:45-87: columns, data, rowKey, sortKey/sortDir/onSort, selectable/selectedKeys/onSelectChange, density, emptyState, onRowClick, page/hasNextPage/onPageChange, rowClassName 等
- agent-console 側の利用: `@sa/components/*` で import（NewSessionForm.tsx 冒頭: Button, Callout, Select, Stack, TextField）。Toast/Badge/Modal/Card/EmptyState/Callout は ConsolePage.tsx:3-6, LedgerBoard.tsx:2-5 で利用中

## 未確認一覧
Chrome --app での Notification 許可/表示挙動(公式・実機とも) / favicon・title バッジの公式記述 / interactive セッションの「ターン完了」を示す公式定義 / ~/.claude/projects jsonl を読んでよいとの明記 / TS SDK の listSessions 実動作 / Orca の orca-data.json 内の settings 配置 / Stop・Notification フックの実機発火(書込禁止のため未実施)
