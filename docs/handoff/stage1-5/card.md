# 実装カード: 段階1.5（起動・版管理・セキュリティ）

- 設計: docs/handoff/stage1-5/design.md（必読。§2 KGI・§4 仕組み・§6 安全・§13 条件が受入条件）
- 調査: docs/handoff/stage1-5/recon.md
- ブランチ: `design/stage1-5`（このブランチに実装も積む。PR は 1 本、base `main`、Draft）
- 実装: Claude Sonnet ／ 審査: Claude Opus

## 0. 約束（段階1カード §0 と同じ＋追加）
- 推測で実装しない。API・コマンドは Context7／man／公式文書で確認し impl-notes.md（docs/handoff/stage1-5/impl-notes.md）に記録。
- カードと実物が食い違う・カードに無い判断が要る → NEEDS_DECISION で止まる。
- **実環境を変えない**: ~/Library/LaunchAgents、~/Applications、~/Library/Application Support/agent-console、キーチェーンへの書込・launchctl の bootstrap/bootout/kickstart は実行しない。スクリプトは `AC_HOME`・`AC_LAUNCHCTL`・`AC_SECURITY`・`AC_GH`・`AC_OPEN`・`AC_OSACOMPILE` 等の環境変数で差し替え可能にし、テストは一時ディレクトリ＋スタブで通す。
- 例外（読み取り・無害のみ可）: §1 の Chrome 実機確認。
- フック/権限判定で止まったら言い換えず BLOCKED:。削除系コマンドは実行しない（スクリプト内に書くのは可、テストでは一時ディレクトリ内のみ対象であることをガード）。
- コミットは design/stage1-5 のみ。PR は Draft。CI 完了は待たない。

## 1. 最初に: `--app` 実機確認（設計 §9 条件1）
1. 一時ポートで静的ページを返す最小 HTTP サーバー（node）を起動。
2. Chrome が起動中かを `pgrep -x "Google Chrome"` で記録。
3. `open -na "Google Chrome" --args --app=http://127.0.0.1:<port>/probe` を実行し、サーバー側で `/probe` へのアクセスが来たか、`osascript -e 'tell application "Google Chrome" to get {mode, URL of active tab} of every window'` 等でアプリ窓として開いたかを記録（生出力）。
4. 確認用に開いた窓は `osascript` で閉じる（その窓だけ）。サーバー停止。
5. アプリ窓にならない／既存窓のタブになる場合は NEEDS_DECISION で停止。

## 2. 実装項目
1. server: `AGENT_CONSOLE_AUTH=keychain` 時のキーチェーン読込（`execFile(securityBin, ['find-generic-password','-s','agent-console','-a','server','-w'])`、securityBin は設定/環境変数で差し替え）。失敗で起動中止。未設定時は従来の起動ごと乱数。
2. server: `POST /api/pair`（Bearer 必須）→ 1 回限りコード（32B hex、30 秒、開発時ログ出力分は 5 分）。`GET /pair?code=` → 消費・セッション作成・Set-Cookie（HttpOnly; SameSite=Strict; Path=/）・303 `/`。無効は 401（SPA の案内画面へ: SA Callout）。セッション最長 24h。
3. server: 認証を「Cookie セッション or Bearer」に変更。`?t=` 廃止。Cookie 認証の POST/DELETE と WS は Origin 必須。`GET /healthz`（認証不要・Host 検査・本文 ok）。
4. server: 起動ログは開発時のペアリング URL のみ。秘密・セッション値は出さない。
5. フロント: `?t=` 依存を除去（Cookie で API/WS）。ペアリング失敗画面（SA Callout, i18n）。画面下部に版（package.json version）表示を追加。
6. ops/launchd/local.agent-console.server.plist.template（設計 §4-2）。
7. scripts/ac-install.sh, ac-update.sh, ac-rollback.sh, ac-uninstall.sh, lib（共通関数・mkdir ロック・trap）。bash、`set -euo pipefail`、パスは全て引用。設計 §4-4 の動作。秘密は変数→標準入力で渡し、引数・ログに出さない。
8. 起動アプリ: osacompile 用 AppleScript 雛形 ops/launcher/AgentConsole.applescript（設計 §4-3 の 3〜4）。
9. CI: `npm audit --audit-level=moderate`、`npm audit signatures` を追加。
10. package.json version を 0.2.0 に。docs/CHANGELOG.md を作成（0.1.0 段階1、0.2.0 段階1.5）。
11. README に PO 向けの導入・更新・切戻し・撤去の手順（`!` で実行する 1 行コマンド）。

## 3. テスト（TDD）
- 単体/統合: ペアリング（成功・再使用 401・31 秒後 401・Bearer 無し 401）、Cookie 属性、Cookie 認証の POST/DELETE で Origin 欠落/他所 403、WS の Cookie 認証、/healthz、`?t=` が拒否されること、ログに秘密が出ないこと（ログ全文を検査）、子プロセス env に秘密が無いこと、キーチェーン読込失敗で起動中止。
- スクリプト: 一時 AC_HOME とスタブ（launchctl/security/gh/open/osacompile は呼出し引数をファイルに記録するスクリプト）で install→update→rollback→uninstall。自己診断失敗時に current が変わらない。秘密がスタブの引数記録に出ない（標準入力経由）。`plutil -lint` を生成 plist に実行（macOS のみ。CI ubuntu ではスキップを明示）。
- e2e: 既存＋ペアリング経由で画面が開く（`/pair?code` → 一覧表示）。
- 段階1のテストは全て合格のまま。

## 4. PR
- タイトル `feat: stage1.5 launcher, pairing auth, local versioning, dependency audit`、Draft、本文は絶対パスの body-file（段階1カード §8 の形式。recon: docs/handoff/stage1-5/recon.md、設計: docs/handoff/stage1-5/design.md、対象ADR: ADR-067, ADR-144、触るファイル全件、削除するファイル: 該当があれば列挙）。

## 5. 報告
1 行目 DONE / BLOCKED: / NEEDS_DECISION:。§1 の実機確認の生出力、各 KGI の自己判定（テスト名・結果行）、未解決点。
