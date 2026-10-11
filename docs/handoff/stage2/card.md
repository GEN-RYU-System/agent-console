# 実装カード: 段階2（毎日の使い勝手）

- 設計: docs/handoff/stage2/design.md（必読。§2 KGI・§3 対象外・§4 仕組み・§5 SSOT・§6 安全が受入条件）
- 調査: docs/handoff/stage2/recon.md
- 作業場所: worktree /Users/tanizawashingo/agent-console-wt/s2（ブランチ design/stage2、base origin/main=9cbcd38）。本体 /Users/tanizawashingo/agent-console と他の worktree は触らない。毎回 `cd /Users/tanizawashingo/agent-console-wt/s2 && …`、コミット前に `git branch --show-current` が design/stage2 であること。
- 実装: Claude Sonnet ／ 審査: Claude Opus

## 0. 約束
- 推測で実装しない。API・コマンドは Context7／man／公式文書で確認し docs/handoff/stage2/impl-notes.md に記録。カードと実物が食い違う・カードに無い判断 → NEEDS_DECISION で止まる。
- 実環境（~/Library/LaunchAgents・~/Applications・~/Library/Application Support/agent-console・キーチェーン・launchctl）を変えない。稼働中の 127.0.0.1:4319 を止めない。テストの osascript はスタブ（実際に通知を出さない）。
- 本物の claude をテストで起動しない。タイマーで端末に文字を送る処理を作らない。
- フックで止まったら言い換えず BLOCKED:。削除コマンドを使わない。
- 設計の変更が必要なら、実装と別コミットで design.md を先に更新し、理由を impl-notes に。
- PR は Draft、マージしない、CI は待たない。

## 1. 実装順（各項目テスト先行）
1. ⑤メモリ（§4-6）: process-tree に rss、集計 API（画面を開いている間だけ 10 秒）、画面。
2. ①区切りの通知（§4-1）: 遷移判定（単体で busy→waiting/idle のみ、他の遷移・初回観測は通知しない）、未読数・既読 API、タイトル、macOS 通知（osascript スタブ、文字列エスケープの単体テスト）、設定 `notify.macos`。画面のヘルプ文に「区切りはアプリの定義」を明記（i18n）。
3. ②名前（§4-2）: Claude の name の表示、`/rename` 送信（waiting/idle のみ）、10 秒で反映されなければ案内。シェルはアプリ名変更。
4. ②よく使う指示（§4-3）: quick-prompts.json（設定 `dataDir`、権限 600、一時ファイル→rename）、CRUD API、Modal での編集、送信（上限 8KB）。
5. ③過去のセッション（§4-4）: `claude agents --all --json` の一覧、`resumeCommand`（Sonnet 実装役のみ。sessionId は環境変数 AC_RESUME_ID で渡す）、cwd 検証。
6. ④台帳の絞り込み（§4-5）: 開始日時の解析、既定フィルタ、隠れ件数、期間・状態・検索、localStorage（try/catch）。
7. version 0.3.0、CHANGELOG、README（使い方の追記）。

## 2. 確認と PR
- typecheck / lint / vitest / build / playwright / npm audit --audit-level=moderate / npm audit signatures の最終行を記録。K7（サーバー RSS ≤150MB、ダミー 3 本）を記録。
- 1440x900 ライト・ダークのスクショ（一覧＋未読、メモリ画面、よく使う指示の編集、過去セッション、台帳の絞り込み）を /tmp/CC報告ファイル/orca-selfbuilt/s2/ に。
- Draft PR（base main、タイトル `feat: stage2 notifications, rename, quick prompts, resume, ledger filter, memory`）。本文は絶対パスの body-file（`cd /Users/tanizawashingo/agent-console-wt/s2 && gh pr create --draft --repo shingo-cc/agent-console --base main --head design/stage2 --title "…" --body-file /Users/tanizawashingo/agent-console-wt/s2/.pr-body-s2.md`）。本文に `### 標準ワークフロー確認`、`対象ADR: ADR-067, ADR-144`、`recon: docs/handoff/stage2/recon.md`、`設計: docs/handoff/stage2/design.md`、`触るファイル:`（diff 全件を `- ` 箇条書き）、`削除するファイル:`。PR 本文検査は設計書・recon のバッククォート内パスの実在を確認するので、リポジトリ外・未作成のパスはバッククォートを外して「」で囲む（意味は変えない）。
- 最終報告 1 行目 DONE / BLOCKED: / NEEDS_DECISION:、PR URL、各 KGI の自己判定（テスト名と結果行）、未解決点。
