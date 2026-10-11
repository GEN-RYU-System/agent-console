# 実装カード: v0.3.1 アプリアイコン

- 設計: docs/handoff/v0.3.1-icon/design.md（§2 が受入条件）
- 作業場所: worktree /Users/tanizawashingo/agent-console-wt/icon（ブランチ feat/app-icon）。毎回 `cd /Users/tanizawashingo/agent-console-wt/icon && …`。コミット前に `git branch --show-current` が feat/app-icon であること。未コミットの SVG と render.mjs が既にある（PO 承認済みの絵。絵は変えない）。
- 実装: Claude Sonnet ／ 審査: Claude Opus

## 0. 約束
- 推測しない。osacompile の生成物（Info.plist の CFBundleIconFile、Resources 内のファイル名）は一時ディレクトリで実際に osacompile して確認し recon.md に生出力の要点を書く。
- 実環境（~/Applications・~/Library/Application Support/agent-console・~/Library/LaunchAgents・キーチェーン・launchctl）を変えない。稼働中の 127.0.0.1:4319 を止めない。`killall Dock` をしない。
- フックで止まったら言い換えず BLOCKED:。削除コマンドを使わない（不要物は ~/.Trash へ移動）。
- カードと実物が食い違う・カードに無い判断 → NEEDS_DECISION: で止まる。
- PR は通常（Draft 不要）で作成、マージしない、CI は待たない。

## 1. 手順
1. recon: 起動アプリを作る箇所（ac-install.sh / ac-update.sh / ac-rollback.sh / ac-common.sh 等）を file:行番号で列挙。巻き戻し時に起動アプリを作り直すか確認。既存のスクリプト試験の場所と、HOME 等を差し替えて試験する仕組みの有無を確認。docs/handoff/v0.3.1-icon/recon.md に記録。
2. ops/launcher/icon/build-icns.sh: render.mjs で SVG → 16,32,128,256,512 の @1x/@2x（計10枚、iconutil の命名）→ `iconutil -c icns` で ops/launcher/icon/AgentConsole.icns を出力。一時物はスクリプト終了時に片付ける（削除コマンドを使わず mktemp 配下に作り、OS の一時領域に任せる）。実行して icns を生成しコミット。
3. 起動アプリ作成の直後に icns を「<app>/Contents/Resources/<CFBundleIconFile の実名>」へ複製し `touch <app>`。icns が無ければ導入を失敗させる（黙って続けない）。
4. 試験（先に書く）: 一時ディレクトリで起動アプリ作成処理を実行し、配置後のアイコンファイルがリポジトリの icns と `cmp` 一致（K1）。CI macOS で icns を iconutil で展開し 10 枚（K2）。既存試験の仕組みに合わせる。
5. version 0.3.1（package.json 等、既存の版の置き場所すべて）、docs/CHANGELOG.md、README に「Dock の絵が古いままなら Dock から外して付け直す」。
6. typecheck / lint / vitest / build / playwright / design governance の最終行を記録。
7. PR（base main、タイトル `feat: app icon for launcher (v0.3.1)`）。本文は絶対パスの body-file。`### 標準ワークフロー確認`、`対象ADR: ADR-067, ADR-144`、`recon: docs/handoff/v0.3.1-icon/recon.md`、`設計: docs/handoff/v0.3.1-icon/design.md`、`触るファイル:`（diff 全件を `- ` 箇条書き）、`削除するファイル:`（なし）。リポジトリ外・未作成のパスはバッククォートを外し「」で囲む。

## 2. 最終報告
1 行目 DONE / BLOCKED: / NEEDS_DECISION:。PR URL、HEAD、K1〜K4 の自己判定（試験名と結果行の生出力）、未解決点。
