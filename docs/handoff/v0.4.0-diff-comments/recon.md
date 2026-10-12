# recon: 段階3 機能1「変更内容（diff）の表示と、行ごとのコメントを Claude に渡す」の現在地

- 作成: 調査担当（Sonnet）。事実のみ。設計提案は書かない。
- 基準: origin/main 054fd94（`git -C /Users/tanizawashingo/agent-console-wt/diff-comments rev-parse --short HEAD`）、package.json 版 0.3.9。
- 凡例: 【事実】= 読んだ/実行した根拠あり、【推測】、【未確認】。パスは worktree 直下からの相対（フルパス = /Users/tanizawashingo/agent-console-wt/diff-comments/ + 相対）。

## A. サーバーの現在地

### A-1 HTTP API 一覧（server/http.ts）
【事実】
- GET /api/state: server/http.ts:105（`hub.snapshot()` に roles・版を足して返す）
- POST /api/logout: server/http.ts:117
- GET /api/ledger: server/http.ts:127／POST /api/ledger/refresh: server/http.ts:131
- POST /api/sessions（作成）: server/http.ts:135／DELETE /api/sessions/:id: server/http.ts:142-147
- 段階2の群 handleDailyUse（server/http.ts:157）:
  - GET /api/memory :160／GET,POST /api/quick-prompts :166,:170／PUT,DELETE /api/quick-prompts/:id :182,:187／POST /api/quick-prompts/:id/move :177
  - GET /api/resume-targets :192／POST /api/sessions/resume :196
  - POST /api/sessions/:id/(read|rename|send-check|close): 正規表現 server/http.ts:204。close :209、read :215、rename :221、send-check :226-231
- 認証前: GET /healthz server/http.ts:323、POST /api/pair/challenge|/api/pair|/api/pair/redeem（handlePairing server/http.ts:251）
- 静的配信 serveStatic server/http.ts:60（GET/HEAD 以外は 405: :343-346）
- 本文上限 MAX_BODY_BYTES = 64 KiB: server/http.ts:14、readJsonBody :43-56（超過は SessionInputError → 400）
- エラー対応表（server/http.ts:348-362）: SessionInputError / WorktreeError / BadRequestError → 400、SessionNotFoundError → 404、SessionConflictError → 409、他 → 500。
- 応答ヘルパ sendJson server/http.ts:37-41（Cache-Control: no-store）。
- /api/ 配下で GET の diff・git に関するルートは【事実】現在存在しない（http.ts 全体に git の語なし。grep 結果は C 節）。

### A-2 認証・Origin 検査の位置
【事実】
- Host 検査 `deps.auth.isHostAllowed`: server/http.ts:318（不許可は 421）。
- /api/ 全体の認証 `deps.auth.authenticate`: server/http.ts:329-334（null は 401）。method は "session"（画面のトークン）か サーバー秘密の Bearer（CLI）。
- Origin 検査: server/http.ts:335-339。セッション認証かつ GET/HEAD 以外のときだけ `isOriginAllowed` を要求（不許可・欠落は 403）。GET は Origin 検査なし。Bearer（CLI）は対象外。
- 定義: server/auth.ts:62-64（インターフェイス）、:134 authenticate、:155 isOriginAllowed、:159 isHostAllowed。
- WebSocket の同等検査: server/ws.ts:80（Host）、:84（認証）、:88（Origin）。
- 画面側の認証: src/api.ts:12-45（sessionStorage のトークンを `Authorization: Bearer` で送る。Cookie は使わない）。

### A-3 hub の snapshot の形（server/hub.ts）
【事実】
- SessionView（server/hub.ts:11-27）: id, name, roleId, branch(string|null), cwd, state, createdAt, unread, hasClaude, canInput, pendingName?。
- Snapshot（server/hub.ts:32-37）: sessions[], agentsAvailable, restoreNotices[]。
- 生成 snapshot(): server/hub.ts:211-235。`cwd: s.cwd`（:222）、`branch: s.branch`（:221）、`canInput: inputVerdict(...).ok`（:227）。
- 配信: WebSocket /ws/events。subscribe server/hub.ts:237-245、publish :247-255（文字列が前回と同じなら送らない）。
- 画面側の型: src/types.ts:3-40（SessionView, ConsoleState）。

### A-4 セッションの cwd / branch の持ち方
【事実】
- Session インターフェイス: server/sessions.ts:40-54（`branch: string | null`、`cwd: string`）。
- 生成: spawnSession server/sessions.ts:238-270。`cwd` を node-pty spawn に渡す（:250）。
- 新規作成: branch があれば createWorktree で worktree を作り、その cwd（server/sessions.ts:174-177）。branch の形は `release/<小文字英数字とハイフン>`（server/worktree.ts:7）。
- 再開（resume）: `sessions.resume({roleId,name,cwd})` server/sessions.ts:187-191 は `branch = null` で起動（spawnSession 第3引数 null）。画面の表示名は `resume: <branch>`（server/http.ts:152-154）。
  → 再開で開いたセッションの `SessionView.branch` は null、`cwd` は実パス。【事実】
- 復元（restore）: server/sessions.ts:203-209（branch を引き継ぐ）。
- 本店のパスは設定 `salesanchorRoot`（server/config.ts:36, :163）。役割ごとの `resumeScope`（"main"|"worktree"）は agent-console.config.json の roles（:14-33）。

### A-5 resume-targets.ts の本店／worktree 照合
【事実】
- `git -C <root> worktree list --porcelain`（timeout 10000ms）: server/resume-targets.ts:25-28、GIT_TIMEOUT_MS :11。
- classifyCwd server/resume-targets.ts:43-51: realpath して存在・ディレクトリ確認 → 本店と一致なら scope "main"、worktree 一覧のどれかと一致なら "worktree"、それ以外は block "outside"。
- resolveResumeTarget server/resume-targets.ts:84-104: kind と path（絶対パス必須）を受け、一覧に照合し通った実パスだけ返す。失敗は SessionInputError（→400）。
- 呼び出し元: server/http.ts:199。
- worktree.ts: parseWorktreePorcelain :18-30（path と branch のみ。detached は branch=null）、findWorktreePath :32-34、WorktreeError :36。

### A-6 端末へ文字を書き込む既存経路
【事実】
1. WebSocket 入力: server/ws.ts:36 `msg.type === "input"` → `sessions.write(session, msg.data)`。`SessionManager.write` は server/sessions.ts:292-294（`if (!session.exited) session.term.write(data)`）。
2. v0.3.7 の rename: Hub.requestRename server/hub.ts:117-126。`checkInput`（:185-190）で判定し、ok なら applyRename（:129-138、Claude 起動中は `sessions.write(session, "/rename <name>\r")` :133）、ok でなければ pendingRenames に予約して "queued" を返す。
3. 予約の送出 flushPendingRenames server/hub.ts:141-160。pollAgents（:96-102）の中で detectBreaks の後に呼ばれる。送る条件は「ポーリング値で ok（:151-152）かつ要求時と同じ取り直し checkInput が ok（:153-155）かつ予約が差し替わっていない」。セッションが消えた/終了した予約は捨てる（:147-149）。
4. 判定 inputVerdict server/agents.ts:80-88: 終了済み → 不可、rows が null（取得失敗）→ 不可、Claude 不在（シェル）→ 可、Claude あり → `status === "idle"` かつ `waitingFor === undefined` のときだけ可。判定の根拠コメントは server/agents.ts:75-78。
5. checkInput server/hub.ts:185-190: 要求の都度 `claude agents --json`（fetchAgents server/agents.ts:102-110、timeout 15000）と ps（readProcessTable）を取り直す。
6. よく使う指示（send-check）はサーバーが端末へ書かない設計: server/http.ts:226 のコメント。サーバーは `{text}` を返すだけ（:231）。画面が xterm の paste() で入れてから Enter。
   - 画面: src/pages/ConsolePage.tsx:161-173 handleSendPrompt（確認中にセッションが切り替わったら入れない :169）。
   - src/components/TerminalPane/TerminalPane.tsx:35-41 pasteAndEnter（`term.paste(text)` → `term.input("\r", true)`）。TerminalHandle 型 :23。
   - src/api.ts:70-71 checkQuickPromptSend。
   - 本文検査: server/quick-prompts.ts:7 MAX_PROMPT_BYTES = 8 KiB、:26 TEXT_CONTROL（改行・タブ以外の制御文字は拒否）。保存は固定の promptId（任意文字列を返す API は現在無い）。

### A-7 bracketed paste の利用
【事実】
- サーバー側（server/ 配下）に bracketed paste の記述は無い（`grep -rni "bracket\|paste" server/` は server/http.ts:226 のコメントのみ）。
- 画面側は xterm の `term.paste()` に任せる（TerminalPane.tsx:16-23 のコメント: 端末が括弧付き貼付モードを有効にしていればそれで包み、そうでなければ改行を \r に直して入れる）。
- 試験: tests/fixtures/bracketed-role.mjs:1-12（`\u001b[?2004h` で括弧付き貼付モードを有効にし、受信全体を `ALL:<JSON>` で出す役割）、tests/fixtures/e2e-env.ts:76,109（役割 `e2e-bracketed`）、tests/e2e/console.spec.ts:594（`bracketed-target`）。
- 【未確認】Claude Code CLI に複数行を paste() した際の挙動（本 recon では実機試験していない。recon-self.md:111 も【推測】）。

## B. 画面の現在地

### B-1 ページ構成
【事実】
- src/App.tsx:5-7: `/pair` なら PairingPage、それ以外は ConsolePage（ルーターなし。pathname 比較のみ）。
- src/pages/: ConsolePage.tsx/.css/.test.tsx、PairingPage.tsx、PairingFailedPage.tsx。
- src/components/: LedgerBoard, MemoryPanel, NewSessionForm, QuickPrompts(QuickPromptBar, QuickPromptEditor), RenameForm, ResumePicker, SessionList, StatusDot, TerminalPane, ThemeToggle（各ディレクトリに .test あり）。

### B-2 ConsolePage のレイアウト（src/pages/ConsolePage.tsx / .css）
【事実】
- 3 列グリッド `20% 1fr 22%`、下段 footer: src/pages/ConsolePage.css:1-11。
- 左 `aside.ac-page__left`（セッション一覧、新規・再開ボタン）: ConsolePage.tsx:252-312。
- 中央 `main.ac-page__center`: QuickPromptBar（:314-319）、エラー Callout（:320-324）、端末 `div.ac-page__terminal`（:325。`activeId ? <TerminalPane ref sessionId> : <EmptyState>`）。
- 右 `aside.ac-page__right`: LedgerBoard（:327-329）。
- footer: 版・コミット・Claude 版・メモリ(Modal を開く)・ThemeToggle・ログアウト（:330-352）。
- 既存 Modal 利用: 閉じる確認 ConfirmModal :353、改名 :363、よく使う指示の編集 :368、再開 :371、メモリ :374、新規 :377。
- 状態: useConsoleState ConsolePage.tsx:43-73（fetchState + WebSocket /ws/events、1 秒で再接続）。activeSession は `state.sessions.find(...)`（:244）→ `cwd`・`branch`・`canInput` が画面で使える。
- SessionList: src/components/SessionList/SessionList.tsx（props: sessions, roles, selectedId, onSelect, onRemove, onClose, onRename。ConsolePage.tsx:293-308）。

### B-3 SA 金型（.sa-cache）で使える部品
【事実】
- 展開元: scripts/sa-sync.mjs:30-35（`git -C <salesanchorRoot> fetch origin main` → `git archive origin/main frontend/src` を .sa-cache へ展開。失敗は起動中止）。別名 `@sa` = .sa-cache/frontend/src（vite.config.ts:5,9、vitest.config.ts:5,9、tsconfig.json:16）。.sa-cache は .gitignore（.gitignore:3）。
- 本 worktree には .sa-cache が無い（未展開）。以下は本店 /Users/tanizawashingo/agent-console/.sa-cache/frontend/src/components/ の実在確認（`ls`）。
- 実在する金型（.tsx）: AvatarUpload, Badge, Button, ButtonLink, Callout, Card, ConfirmModal, ContentToolbar, DataTable, DesktopShell, Drawer, EmptyState, FormField(.css), HeaderButton, IconToggleButton, MobileShell, Modal, NavDropdown, NavItemList, PageLayout, Popover, Select, Stack, SubMenu, Tabs, Textarea, TextField, Tooltip, TwoColumn ほか（SA 固有の業務部品多数）。loading/ ディレクトリあり。
- シグネチャの要点:
  - Button: components/Button.tsx:24-41（variant/size は buttonAppearance.ts、`iconOnly` 等）。
  - Modal: components/Modal.tsx:22 `ModalSize = "sm"|"md"|"lg"|"xl"`、props :24。
  - Drawer: components/Drawer.tsx:22-30（open, onClose, title, children, onOpenFullPage?, footer?）。
  - Tabs: components/Tabs.tsx:30-40 `TabItem{key,label,count?,icon?,disabled?}`、`variant "underline"|"pill"`、`size "sm"|"md"`、props `items, activeKey, onChange`。
  - Callout: components/Callout.tsx:13-25（variant `'warning'|'info'`、title、children）。
  - Textarea: components/Textarea.tsx:20-30（label, helperText, error, size "sm"|"md"|"lg", fullWidth）。
  - Badge, EmptyState, Popover, Tooltip, DataTable も実在。
- agent-console が現在 import している金型: Button, Callout, EmptyState, ConfirmModal, Modal（ConsolePage.tsx:3-7。他コンポーネントの分は未全数調査＝【未確認】。`grep` は zsh のグロブ展開エラーで 0 件になったため）。
- 【事実】diff 表示用の金型は無い（recon-self.md:54「components/*.tsx を grep -li diff → GoogleCalendarStatusBar.tsx のみで無関係」を引用。本 recon では再実行していない）。

### B-4 i18n の作法
【事実】
- src/i18n.ts:3-23: SA の @sa/locales/ja.json（.sa-cache 側。本リポジトリ外） と src/locales/ja.json を deepMerge。lng "ja"、fallbackLng "ja"。ja のみ（en なし）。
- src/locales/ja.json はキー先頭 `ac.`。例: `ac.quick.*`（:107-）、`ac.state.*`、`ac.form.*`、`ac.footer.*`。
- 呼び出し: `useTranslation()` の `t("ac.xxx")`（ConsolePage.tsx:76）。動的キーは `t(\`ac.restoreNotice.${n.reason}\`, {name})`（:279）。
- 文言の直書き禁止は scripts/check-design-governance.mjs（`npm run lint`、package.json scripts.lint）が検査。

### B-5 デザイントークンの場所
【事実】
- アプリ固有: src/tokens.app.css:1-9（`--ac-font-mono` のみ。冒頭コメントで「--ac- で始まるカスタムプロパティだけ」）。
- SA のトークン: .sa-cache 側。CSS では `var(--bg-primary)`, `--bg-subtle`, `--border`, `--text-primary`, `--text-muted`, `--space-2..6`, `--font-xs/md`, `--font-weight-semi` を使用（src/pages/ConsolePage.css:9,17,18,20,29,30,35,36,42-47）。
- 検査: scripts/check-design-governance.mjs:1-4（ADR-067/144。色名・直値の禁止、font stack の許可 :32-41、`APP_TOKEN_FILE = "src/tokens.app.css"` :10）。
- 端末の見た目トークン読取: src/components/TerminalPane/terminalTokens.ts（ファイルのみ確認）。

## C. git の扱い（サーバー）

【事実】execFile 利用箇所（`grep -n "execFile\|\"git\"" server/*.ts`）:
| 箇所 | 呼び方 | timeout / maxBuffer | cwd・パス検証 |
|---|---|---|---|
| server/resume-targets.ts:26 | `execFile("git", ["-C", root, "worktree", "list", "--porcelain"])` | timeout 10000（:11） | root は設定値。画面の path は後段で照合（:84-104） |
| server/worktree.ts:47 | 同じ `git -C root worktree list --porcelain` | timeout なし | root は設定値 |
| server/worktree.ts:42 | `execFile("bash", [path.join(root, script), branch], { cwd: root })` | timeout 120000、maxBuffer 4 MiB | branch は `^release/[a-z0-9][a-z0-9-]{1,60}$`（:7,:40）で検証済み |
| server/index.ts:44 | `execFile("git", ["rev-parse","HEAD"], { cwd: process.cwd() })` | timeout 5000 | 版情報 |
| server/ledger.ts:113 | `execFile("bash", [path.join(root, script), branch], { cwd: root })` | LOOKUP_TIMEOUT_MS | |
| server/agents.ts:105 | `execFile(claudeBin, ["agents","--json"])` | timeout 15000、maxBuffer 8 MiB | |
| server/process-tree.ts:53 | `execFile("ps", ["-axo", ...])` | maxBuffer 8 MiB | |
- 作法: すべて `promisify(execFile)`＋引数配列（シェルを通さない）。セッションの cwd を `cwd:` に渡して git を実行する箇所は現在無い。`git diff` / `git status` を呼ぶコードは server/ に無い。
- 作業場所の検証部品: classifyCwd / resolveResumeTarget（A-5）。

## D. 外部（Orca の diff コメント調査）
出典: /tmp/CC報告ファイル/orca-selfbuilt/stage3/recon-orca.md（以下 O:行）、recon-self.md（以下 S:行）。
【事実（調査報告の記載）】
- O:12: 方式「Monaco 系 diff にガター「+」。コメントはワークツリーのメタに保存」、保存先 `WorktreeMeta.diffComments`（Orca の状態ファイル）、Claude への渡し方「端末に貼り付け（ブラケットペースト＋Enter）。`terminal.send` RPC。ファイル化・hooks は使わない」。
- O:32-34: 公式説明「leave comments on any line of any AI-generated hunk, then send them back to the agent as a single batch」。操作はガターの +、Cmd-Enter で保存、Esc で取消。O:34: 行追従（編集で diff がずれても追う）。
- O:41-42: 型 Orca リポジトリの src/shared/diff-comment-types.ts:27-48（本リポジトリ外）（id, worktreeId, filePath, startLine?, lineNumber, body, createdAt, sentAt?, scope?, diffIdentity?, side:'modified'）。`sentAt` は送信済みの印、編集すると再送対象に戻る。
- O:48-54: 整形 Orca リポジトリの src/shared/diff-comments-format.ts:9-30（本リポジトリ外）。1 件 3 行 `File: <path>` / `Line: <n>`（範囲は `Lines: a-b`、ファイル全体は `Scope: file`）/ `User comment: "<本文>"`、複数件は空行で連結。
- O:55-62: 送信は `terminal.wait` で入力待ち（`tui-idle`）を待ち（active-agent-note-send.ts:112-117）、`BRACKETED_PASTE_BEGIN + sanitize(prompt) + END` を `terminal.send`（active-agent-note-send-delivery.ts:70-82、`requireAgentStatus: 'sendable'`）、遅延後に Enter（:105）。
- O:63: コピー（クリップボード）経路もある。
- O:37: diff 取得は git（staged/unstaged/untracked 結合）。実装行は【未確認】（O:192）。
- O:186: 抵触整理で「1 行コメント／端末ペースト／抵触なし」。
- S:96-106（agent-console 側の実測）: 小さい worktree で status 0.42s・diff --stat 0.69s、最大でも --stat 0.29s。
- S:97-106: 90 worktree の `git diff origin/main...HEAD` 行数: median 158, p90 2150, max 446,699（19.5 MB・73 ファイル）、0 行 23 件、2000 行超 10 件、5000 行超 4 件。
- S:99-100: 3 点 `origin/main...HEAD` はコミット済みのみ。未コミットは `git status --porcelain`。2 点 `origin/main` は main が進んだ分の逆差分が混ざる。
- S:111-113: 既存の送り方（よく使う指示）と本文制限（quick-prompts.ts:7,:24-26）、「任意文字列を返す API は未実装」。
- S:115-123: Claude Code 公式の記法。`@file` 参照は 256KB 超のテキストを省く。`@file.ts#5-10` は VS Code 拡張が挿入する書式。【未確認】CLI で直接打って行範囲として解釈されるか。
- S:59: 対象外の明記（内蔵ブラウザ等は作らない。タイマーで Claude を動かさない）。

## E. 試験の構成

【事実】
- 単体・統合: vitest（vitest.config.ts:10-13。include `tests/unit/**/*.test.{ts,tsx}` と `src/**/*.test.{ts,tsx}`、globals true）。`npm test` = `vitest run`（package.json）。
- tests/unit/ のファイル: agents, auth, child-env, config, daily-use.integration, design-governance, keychain, launcher, ledger, memory, notify, pair-proof, pairing.integration, poll, process-tree, quick-prompts, restore-guard, resume-targets, ring-buffer, scripts, server-process, server.integration, session-restore.integration, session-store, worktree（各 .test.ts）＋ helpers/ac-env.ts, helpers/harness.ts。
- harness: tests/unit/helpers/harness.ts。`startHarness(options)`（:80。実 HTTP/WS/PTY を 127.0.0.1 の空きポートで起動）。固定 TOKEN（:19）。HarnessOptions :55-78（claudeBin のスタブ、resumeCommand、extraRoles 等）。組込み役割 echo/short/envcheck/langcheck/wt(+resumable)（:115 付近）。
- 画面の試験: src/**/*.test.tsx（App, api, ConsolePage, 各コンポーネント, theme）。
- e2e: Playwright 1.64（package.json）。playwright.config.ts:7-30（testDir tests/e2e、workers 1、chromium、viewport 1400x800、webServer は `node dist-server/server/index.js`）。tests/e2e/console.spec.ts 786 行（`test(` 31 件）。fixtures: tests/fixtures/{claude-stub.sh, ledger-lookup.sh, new-worktree.sh, osascript-stub.sh, role.mjs, bracketed-role.mjs, e2e-env.ts, ac/fake-version-server.cjs}。
- 偽 claude: tests/fixtures/claude-stub.sh（`STUB_STATUS_FILE` 等の環境変数で `agents --json` を差し替え。playwright.config.ts:22-28）。
- CI: .github/workflows/ci.yml。job id `check`（:12）、matrix `os: [ubuntu-latest, macos-latest]`（:15）→ チェック名は 【推測】「check (ubuntu-latest)」「check (macos-latest)」（GitHub の表示規則。本 recon では gh で実測していない）。手順: npm ci → npm audit（moderate 以上で失敗 :25-26）→ npm audit signatures → Clone Sales Anchor → sa-sync → typecheck → lint → test → build → playwright install → test:e2e（:19-45）。node 24（:22）。

## F. docs/handoff の様式と pr-body-guard

### F-1 design.md の様式（docs/handoff/v0.3.8-session-restore/design.md）
【事実】見出し構成: 状態・PO 承認・調査・対象ADR・前提の設計（:1-11）→ `## 0. 事実（recon より）`（:13）→ `## 1. 成功条件`（:21。`|基準|検証方法|` の表、K1〜K10 形式）→ `## 2. 対象と対象外`（:35）→ `## 3. 仕組み`（:51。3-1…3-5）→ `## 4. SSOT`（:~97）→ `## 5. 安全` → `## 6. 代替案` → `## 7. リスクと対処` → `## 外部・過去事例の参照と我々への応用`（出典 URL・取得日・「適用限界」）→ `## 維持の仕組み`（守り手・固定する試験）。
- 直近の handoff ディレクトリ: v0.3.9-restore-guard（design.md, recon.md）、v0.3.9-test-flake。recon.md と design.md の 2 ファイル組が慣例。
- 対象ADR 欄は ADR-067、ADR-144（同 design.md:8）。

### F-2 pr-body-guard の要件
【事実】
- フック本体: /Users/tanizawashingo/.claude/scripts/pr-body-guard.sh（settings.json の PreToolUse に登録。/Users/tanizawashingo/.claude/settings.json:60）。対象は Bash の `gh pr create|edit` で `--body` / `--body-file` を含むもの（:23-26）。`PR_BODY_VALIDATE_SKIP=1` でスキップ可能（:33-38。ただし回避の使用可否は別途 PO 判断＝【未確認】）。
- 検証本体 salesanchor の scripts/dev/validate-pr-body.sh（本リポジトリ外） の探し方: cwd 直下 → ~/salesanchor → ~/worktrees 配下（pr-body-guard.sh:56-69）。見つからないとスキップ（:71-74）。
  - 【事実】agent-console リポジトリ内に scripts/dev/validate-pr-body.sh は無い（`git ls-files` に無し）。cwd が agent-console の worktree の場合は ~/salesanchor 側のスクリプトが使われる（pr-body-guard.sh:61-62）。
- 規則（/Users/tanizawashingo/salesanchor/scripts/dev/validate-pr-body.sh）:
  - 検査1 `### 標準ワークフロー確認` 見出し（:38）
  - 検査2 `対象ADR:` 行に `ADR-\d[\w-]*`（:46-52）
  - 検査3 `recon: docs/handoff/<名>/....md`（実在確認。`<…>` 残りはNG）（:58-69）
  - 検査4 `設計: <パス>`（実在確認）（:75-87）
  - 検査5 `触るファイル:` と `削除するファイル:` の宣言が必須（:90-以降）
  - 検査6 触るファイル宣言と git diff の照合（:111 付近）
  - 検査 7 以降の詳細は【未確認】（本 recon は先頭 130 行までを読了）。
- 実在確認は `git rev-parse --show-toplevel` のリポジトリルート基準（validate-pr-body.sh:15,:67,:85）。

## G. 実測: git diff の出力サイズ（agent-console 自身）
【事実】実行（worktree /Users/tanizawashingo/agent-console-wt/diff-comments、HEAD=054fd94、全 62 コミット。作業ツリーは recon.md 追加前でクリーン＝`git diff --stat origin/main` は 0 行）:
```
$ git diff --stat 41d2cc4e HEAD | tail -1          （最初のコミット → HEAD）
 177 files changed, 18423 insertions(+)
$ git diff 41d2cc4e HEAD | wc -lc
   19485 1032611
$ git diff --numstat 41d2cc4e HEAD | sort -rn | head -3
2656	0	package-lock.json
786	0	tests/e2e/console.spec.ts
579	0	tests/unit/scripts.test.ts
$ time git diff --stat 41d2cc4e HEAD > /dev/null     → 0.047 s total

$ git diff --stat 357d35b^1 357d35b | tail -1      （v0.3.8 の merge 1 件）
 28 files changed, 1384 insertions(+), 31 deletions(-)
$ git diff 357d35b^1 357d35b | wc -lc
    2086  126945
$ git diff --numstat 357d35b^1 357d35b | sort -rn | head -3
384	0	session-restore.integration.test.ts  ほか（server/restore.ts 164、design.md 127）
```
- 目安: 全履歴 19,485 行 / 約 1.0 MB（最大 1 ファイルは package-lock.json 2,656 行）。1 リリース分（v0.3.8）で 2,086 行 / 約 127 KB。
- 比較用（recon-self.md:97-106 の salesanchor 90 worktree）: median 158 行、p90 2,150 行、max 446,699 行（19.5 MB）。
- 【未確認】未コミット分・untracked ファイルを含む diff の取得コマンド形は本 recon で未実測（recon-self.md:99-100 は status --porcelain との合成が必要と記載）。
