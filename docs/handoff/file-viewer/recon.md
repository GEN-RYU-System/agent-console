# セッションが作ったファイルを開く（file-viewer）現在地の調査

- 基準: origin/main 533e7f4（v0.20.0）。作業場所 ~/agent-console-wt/file-viewer（release/file-viewer）。
- 調査: Sonnet（生出力 /tmp/CC報告ファイル/file-viewer/r1・r2・r3）。要の行は Opus が読み直して照合した（hooks/activity-hook.mjs:84-160、src/components/ChatPane/ChatMarkdown.tsx 全文）。
- Context7 は月の上限で使えなかった（2026-10-14、"Monthly quota exceeded"）。Claude Code の hook 仕様は公式ページ https://code.claude.com/docs/en/hooks を直接読んだ（2026-10-14）。

## R1 ファイルを読む口・表示
- 任意のファイルを読む API は無い。中身を返すのは git の差分だけ（server/diff-routes.ts:29-38、server/diff.ts:56-81,115-125）。範囲はセッションの作業場所（server/workplace.ts:22-34 resolveWorkplace、realpath で照合）。未追跡ファイルは名前だけ。/tmp は見えない。
- 差分の許可は「git が出した一覧と完全一致」（server/diff-routes.ts:14-21 matchFile）。
- 上限の前例: server/config.ts:37 DEFAULT_DIFF_MAX_FILE_BYTES = 1 MiB、バイナリは numstat の "-"（server/diff.ts:49,99）。
- 認証: /api/ 全体に server/http.ts:389 authenticate。Host 完全一致 server/auth.ts:158-160（http.ts:372）。Origin は非 GET のみ必須（http.ts:394-397）。新しい口は handleApi（http.ts:132-、並び 179-188）に足せば認証の内側に入る。

## R2 会話の中身の出所（SSOT）
- チャットは hook の記録だけが源。server/chat-routes.ts:40-56 は session.claudeSessionId で deps.activity.chat() を返す。transcript jsonl を読む処理は server/・src/ に無い（r2/q1-grep.txt）。
- hook はファイルへ直書き（hooks/activity-hook.mjs:171-201 appendRecord → dataDir/activity/events-YYYYMMDD.jsonl、1 行 64KiB まで）。server は 2 秒ごとに読む（server/activity-start.ts:10,40）。
- 記録に残す項目は決め打ち。「transcript のパスなどは残さない」（hooks/activity-hook.mjs:113-114）。cwd も残さない。
- PostToolUse は Agent だけ記録（hooks/activity-hook.mjs:99-107）。登録 matcher も "Agent"（server/activity-hooks.ts:24-34 HOOK_SPECS）。Write/Edit は今は記録されていない。
- 起動時の復元は「今日と昨日」の 2 ファイルだけ（server/activity.ts:227-239 readNew、229 行）。古い日付のファイルは keepDays（既定 7、server/config.ts:46）を過ぎると消す（server/activity.ts:433-451 pruneOldFiles）。

## R3 セッションの持つ情報
- server/sessions.ts:59-77 Session（id, name, roleId, branch, cwd, createdAt, term, …, claudeSessionId?）。claudeSessionId は UUID 形だけ（sessions.ts:25-30）、hub.ts:409-410 で claude agents --json と pid で突き合わせて控える。
- 保存は dataDir/open-sessions.json（server/session-store.ts:15-24）。

## R4 hook の入力（公式ページの引用、2026-10-14）
- PostToolUse は「Runs immediately after a tool completes successfully.」失敗は PostToolUseFailure（別イベント）。
- Write の入力例: tool_input {file_path, content}、tool_response {filePath, type:"create"}。
- サブエージェントの中のツールでも PreToolUse/PostToolUse は同じ hook が動き、agent_id と agent_type が付く。
- matcher は "Edit|Write" のように | で複数指定できる。
- 実データ: サブエージェント由来の記録 460 件すべての session_id が親セッションの ID と同じ（events-20261014.jsonl、r3/q4.txt）。親の UserPromptSubmit/Stop で agent_id を持つ行は 0。

## R5 transcript 側（使わない案の材料）
- Write は message.content[] の {type:"tool_use", name:"Write", input:{file_path, content}}。Edit は {replace_all, file_path, old_string, new_string}（r2/q3-tooluse.txt）。
- サブエージェントの Write は親 jsonl には出ず、<projects>/<親sessionId>/subagents/agent-<id>.jsonl にだけ出た（1 セッションで観測、r2/q4-check.txt）。
- transcript の場所を決める関数はこのリポジトリに無い。worktree 側のディレクトリ名の符号化規則は未確認。
- MultiEdit・NotebookEdit は手元の transcript に 0 件（形は未確認）。

## R6 画面
- 中央のタブ: src/pages/ConsolePage.tsx:55 CenterTab（chat|terminal|changes|pr|picks|routines）、items :393-407、描画 :428-466。文言 src/locales/ja.json:204-211 ac.tabs.*（ja のみ、src/i18n.ts）。
- Markdown 部品は src/components/ChatPane/ChatMarkdown.tsx（38 行。skipHtml、defaultUrlTransform、a は別タブ、img は alt 文字）。見た目は ChatPane.css:79- の .ac-chat__md。使うのは ChatPane.tsx:12,159 だけ。
- アプリ独自のトークンは src/tokens.app.css（--ac- のみ）。SA 部品は @sa/…（.sa-cache、scripts/sa-sync.mjs）。SA にファイル表示・Markdown の部品は無い（r2/q5-sa-components.txt）。
- 生要素の検査は src/pages/ 配下の .tsx（scripts/check-design-governance.mjs:164）。

## R7 試験・CI
- 単体・統合 tests/unit/*.test.ts（HTTP は tests/unit/helpers/harness.ts startHarness）。画面は src/**/*.test.tsx。e2e は tests/e2e/*.spec.ts（chat.spec.ts は本物の hook に JSON を流す）。
- CI .github/workflows/ci.yml（ubuntu・macos、typecheck・lint・test・build・e2e）。

## 既存の設計・決まり（ADR に当たるもの）
- このリポジトリに ADR は無い。設計の正本は docs/handoff/<仕事>/design.md。関係するもの: docs/handoff/v0.8.0-activity（hook の記録）、docs/handoff/chat（チャット便1・Markdown）、docs/handoff/v0.4.0-diff-comments（差分の口と範囲）、docs/handoff/board-guard（activity-hooks.ts の一般化。未マージ）。
