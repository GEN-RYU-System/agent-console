# recon: v0.3.3 再開の入口を Claude 公式の選択リストに切り替える

調査基準: origin/main b6408f2。設計: /Users/tanizawashingo/agent-console-wt/resume-picker/docs/handoff/v0.3.3-resume-picker/design.md
既存 ADR 検索: このリポジトリに docs/adr/ は無い。SA 側の ADR-067（デザイントークン）・ADR-144（UI ガバナンス）は設計の対象 ADR として design.md に記載済み（`node scripts/check-design-governance.mjs` が強制）。

## 1. 消す対象（現行の過去セッション一覧）
- /Users/tanizawashingo/agent-console-wt/resume-picker/server/past-sessions.ts:1-122 全体（toPastSessions :41、PastSession :24、withResumability :100、SESSION_ID_PATTERN :12）。classifyCwd :80・roleForScope :95・listWorktreePaths :59 は再利用し、新ファイル server/resume-targets.ts へ移す（git mv で履歴を保つ）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/server/http.ts:10（import）、:152-154（runningIdsOf）、:156-160（sessionNameFrom）、:192-197（GET /api/past-sessions）、:198-216（POST /api/sessions/resume の sessionId 版）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/server/agents.ts:102-104（fetchAgents の `all` 引数と `agents --all --json`）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/server/hub.ts:121-129（livePids。呼び出しは http.ts:194,205 のみ）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/server/sessions.ts:136-145（resume の sessionId・AC_RESUME_ID）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/src/components/PastSessions/PastSessionsList.tsx、PastSessionsList.test.tsx、PastSessions.css（ディレクトリごと）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/src/pages/ConsolePage.tsx:12,22,27,34（import）、:89-93（past* 状態）、:184-212（openPastSessions・handleResume）、:235（canResume）、:325-327（Modal）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/src/api.ts:1（PastSession import）、:60-62（fetchPastSessions・resumeSession）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/src/types.ts:61-71（PastSession）。
- /Users/tanizawashingo/agent-console-wt/resume-picker/src/locales/ja.json:74（ac.pastSessions）、:108-127（ac.past.*）。
- 試験: /Users/tanizawashingo/agent-console-wt/resume-picker/tests/unit/past-sessions.test.ts（全体）、/Users/tanizawashingo/agent-console-wt/resume-picker/tests/unit/daily-use.integration.test.ts:15-28,32-33,252-309（past sessions K4）、/Users/tanizawashingo/agent-console-wt/resume-picker/tests/unit/config.test.ts:37-46（ccopusgo --resume "$AC_RESUME_ID" の期待）、/Users/tanizawashingo/agent-console-wt/resume-picker/src/pages/ConsolePage.test.tsx:46-47（モック）、/Users/tanizawashingo/agent-console-wt/resume-picker/tests/e2e/console.spec.ts:38,576-619（段階2 K4）。
- 試験用の道具: /Users/tanizawashingo/agent-console-wt/resume-picker/tests/fixtures/claude-stub.sh:7-12（agents --all）、/Users/tanizawashingo/agent-console-wt/resume-picker/tests/fixtures/e2e-env.ts:66-69,115（allFile）、/Users/tanizawashingo/agent-console-wt/resume-picker/playwright.config.ts:30（STUB_ALL_FILE）、/Users/tanizawashingo/agent-console-wt/resume-picker/tests/unit/helpers/harness.ts（resumeCommand・mainResumeCommand の AC_RESUME_ID 前提のダミー）。

## 2. 再利用する対象
- worktree 一覧の取得: /Users/tanizawashingo/agent-console-wt/resume-picker/server/worktree.ts:13-30 parseWorktreePorcelain（path・branch を返す）。`git worktree list --porcelain` の呼び出しは past-sessions.ts:59-65（listWorktreePaths）を resume-targets.ts に移して使う。
- 作業場所の照合: past-sessions.ts:80-93 classifyCwd（realpath・存在確認・main/worktree の分類）、:95-97 roleForScope。
- 役割と scope の対応: /Users/tanizawashingo/agent-console-wt/resume-picker/server/config.ts:11-16,63-74,112-114（resumeCommand・resumeScope。変更なし）。
- 起動: /Users/tanizawashingo/agent-console-wt/resume-picker/server/sessions.ts:140-145 resume → spawnSession（command を役割の resumeCommand にして cwd を渡す。env の AC_RESUME_ID だけ外す）。
- 絞り込み入力の金型: /Users/tanizawashingo/agent-console-wt/resume-picker/src/components/LedgerBoard/LedgerBoard.tsx:7（import TextField from "@sa/components/TextField"）、:81-87（size="sm" label value onChange fullWidth）。
- 画面の金型: PastSessionsList.tsx:2-6 の Button・Callout・Card・EmptyState・Stack、ConsolePage.tsx の Modal（:325 size="lg"）。
- エラー型: http.ts:12 SessionInputError / SessionNotFoundError / SessionConflictError（400/404/409 への対応は http.ts:369-373）。
- 版の置き場所: /Users/tanizawashingo/agent-console-wt/resume-picker/package.json:3、/Users/tanizawashingo/agent-console-wt/resume-picker/package-lock.json:3,9、/Users/tanizawashingo/agent-console-wt/resume-picker/src/pages/ConsolePage.test.tsx:13,126、/Users/tanizawashingo/agent-console-wt/resume-picker/README.md:32（ac-update.sh の例）、/Users/tanizawashingo/agent-console-wt/resume-picker/docs/CHANGELOG.md:5。server/index.ts:34 は package.json を読むだけ。
