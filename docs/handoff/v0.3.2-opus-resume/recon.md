# recon: v0.3.2 Opus 設計役の再開

調査時点: origin/main 40b7510（変更前）。行番号は変更前のもの。引用は絶対パス:行番号。

## 1. ccopusgo.zsh の現状（変更前の控え: /Users/tanizawashingo/.claude/shell/ccopusgo.zsh.bak-20261011）
- /Users/tanizawashingo/.claude/shell/ccopusgo.zsh:14 使い方の行は `ccopusgo [--high] [--] [依頼文]`。
- /Users/tanizawashingo/.claude/shell/ccopusgo.zsh:27-30 `--high` だけを先頭で受け、effort を high にして shift。
- /Users/tanizawashingo/.claude/shell/ccopusgo.zsh:32-37 次が `--` なら shift、他の `--*` は終了コード 2。
- /Users/tanizawashingo/.claude/shell/ccopusgo.zsh:59-76 本店（/Users/tanizawashingo/salesanchor）へ cd してから claude を起動。依頼文あり（61-68）と無し（69-74）の 2 分岐。--resume の受け口は無い。
- 起動指示は `--append-system-prompt` で渡す（:67, :74）。`claude --help` 2.1.296 で `--resume` と併用でき、`--system-prompt-snapshot`（既定 on）により再開時は記録済みの指示が使われる（設計 §4 の確認結果）。

## 2. 再開経路（変更前）
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/http.ts:192-197 `GET /api/past-sessions`: `claude agents --all --json` を toPastSessions → withResumability。
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/http.ts:198-216 `POST /api/sessions/resume`: :201 `config.roles.find((r) => r.resumeCommand !== undefined)` で「resumeCommand を持つ最初の役割」を選ぶ（段階2レビュー L8）。:210-211 classifyCwd の block が非 null なら 400。
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/http.ts:110 `canResume: r.resumeCommand !== undefined` を役割一覧に載せる。
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/past-sessions.ts:20 `ResumeBlock = "running" | "main" | "outside" | "missing"`。:80 cwd が本店そのものなら `block: "main"`（不可）。:86-101 withResumability は block のみ付与し、役割 id は持たない。
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/config.ts:11 `resumeCommand?: string[]`、:58-62 検証。`resumeScope` は無い。
- /Users/tanizawashingo/agent-console-wt/opus-resume/server/sessions.ts:137-145 `resume()` は役割の resumeCommand を AC_RESUME_ID 付きで起動（cwd は呼び出し側で検証済み）。
- /Users/tanizawashingo/agent-console-wt/opus-resume/agent-console.config.json:11-19 opus-designer は resumeCommand 無し、sonnet-impl のみ resumeCommand 有り。

## 3. 画面
- /Users/tanizawashingo/agent-console-wt/opus-resume/src/components/PastSessions/PastSessionsList.tsx:50-62 各行に block の理由（:51-55）と再開ボタン（:58-66）。再開する役割の表示は無い。
- /Users/tanizawashingo/agent-console-wt/opus-resume/src/types.ts:68 `blocked: "running" | "main" | "outside" | "missing" | null`。
- /Users/tanizawashingo/agent-console-wt/opus-resume/src/locales/ja.json:118 `noRoleBody` は Sonnet 実装のみと記載、:121 `blocked.main` は「Opus 設計役の再開は対象外」。

## 4. 関係する試験（変更前）
- /Users/tanizawashingo/agent-console-wt/opus-resume/tests/unit/past-sessions.test.ts:41-82 classifyCwd / withResumability（main を block とする期待）。
- /Users/tanizawashingo/agent-console-wt/opus-resume/tests/unit/daily-use.integration.test.ts:255-290 一覧が main を "main" とする期待、:277 付近で main の再開が 400 の期待。
- /Users/tanizawashingo/agent-console-wt/opus-resume/tests/unit/helpers/harness.ts:59, :98-100 resumable 役割（scope 無し）。
- /Users/tanizawashingo/agent-console-wt/opus-resume/tests/fixtures/e2e-env.ts:96-101 e2e-resume 役割。
- /Users/tanizawashingo/agent-console-wt/opus-resume/tests/e2e/console.spec.ts:576-619 本店の行が「Opus 設計役」の不可表示で 400 の期待。
- /Users/tanizawashingo/agent-console-wt/opus-resume/src/components/PastSessions/PastSessionsList.test.tsx:8-13, 47-60 blocked.main の表示。
- 版の置き場所: /Users/tanizawashingo/agent-console-wt/opus-resume/package.json:3、/Users/tanizawashingo/agent-console-wt/opus-resume/package-lock.json:3,9、/Users/tanizawashingo/agent-console-wt/opus-resume/src/pages/ConsolePage.test.tsx:13,126、/Users/tanizawashingo/agent-console-wt/opus-resume/README.md:32（ac-update の例）、/Users/tanizawashingo/agent-console-wt/opus-resume/docs/CHANGELOG.md。

## 5. 既存 ADR 検索（本リポジトリ agent-console）
- 本リポジトリに docs/adr は無し。対象 ADR は設計の指定どおり ADR-067、ADR-144（salesanchor 側）。画面は SA 金型（@sa/components の Button/Callout/Card/EmptyState/Stack）と既存の ac-past__muted クラスのみ使用、色・寸法の直値なし（npm run lint: design governance OK）。

## 6. 変更方針（設計 §4 のとおり）
- config に resumeScope（main / worktree）。役割は cwd の判定から scope で選ぶ。重複 scope・resumeCommand 無しの scope は設定エラー。
- 判定 main は「不可」でなく scope main。該当役割が無い行は新しい理由 noRole で不可（設計の「従来どおり不可」を、理由を明示して表示）。
- 一覧 API は各行に resumeRoleId、画面は役割ラベルを表示。
