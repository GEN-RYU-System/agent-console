# agent-console

Local console for running parallel Claude Code sessions (Orca-inspired, lightweight).

- 設計・調査・実装メモ: `docs/handoff/stage1/`（段階1）、`docs/handoff/stage1-5/`（段階1.5: 起動・版管理・セキュリティ）
- 版の履歴: `docs/CHANGELOG.md`（版の正本は git タグ `vX.Y.Z`）
- テスト: `npm test`（単体・統合）/ `npm run test:e2e`（要 `npm run build`）
- 設定: `agent-console.config.json`（`AGENT_CONSOLE_CONFIG` で別ファイル指定、`AGENT_CONSOLE_PORT` でポートだけ上書き）

## 開発時の起動

`npm ci && npm start`（Sales Anchor の origin/main を `.sa-cache/` へ展開 → ビルド → `127.0.0.1:4319`）。
起動ログに **1 回限り・5 分で失効するペアリング URL**（`/pair?code=…`）が出るので、それをブラウザで開く。長期の秘密は URL にもログにも出ない。

## PO 向け: 導入・更新・切戻し・撤去（この Mac）

どれも PO が `!` を付けて実行する（キーチェーン・LaunchAgent・~/Applications を変更するため、Claude は実行しない）。
`vX.Y.Z` は git タグ（`docs/CHANGELOG.md` に載っている版）。リポジトリのどの場所からでも実行できる（この 4 本は、いま開いているチェックアウトの `scripts/` から呼ぶ）。

| やること | 1 行コマンド | 何が起きるか |
|---|---|---|
| 初回導入 | `! bash scripts/ac-install.sh v0.2.0` | サーバー秘密をキーチェーンに保存 → 版を取得・ビルド → **別ポートで自己診断** → ログイン時自動起動を登録 → Dock 用の `~/Applications/Agent Console.app` を生成 → `/healthz` を確認して結果を表示 |
| 更新 | `! bash scripts/ac-update.sh v0.3.0` | 新しい版を導入 → 自己診断に通ったときだけ切替 → 再起動 → `/healthz` 確認。失敗したら元の版に戻る |
| 切戻し | `! bash scripts/ac-rollback.sh` | 1 つ前の版（semver 順）に切替 → 再起動 → `/healthz` 確認 |
| 撤去 | `! bash scripts/ac-uninstall.sh` | 自動起動と起動アプリを外す。導入済みの版とキーチェーンの秘密は残す |
| 完全撤去 | `! bash scripts/ac-uninstall.sh --purge` | 上に加えて、導入済みの版とキーチェーンの秘密も削除 |

- 導入後は Dock に `Agent Console.app`（`~/Applications`）をドラッグして固定する。1 回クリックすると、Chrome のアプリ窓がログイン済みで開く。
- 使用中の版は、画面下部の「版」で確認できる。
- 置き場所: `~/Library/Application Support/agent-console/`（`versions/<tag>/`、`current`、`logs/`）、`~/Library/LaunchAgents/local.agent-console.server.plist`、キーチェーンのサービス `agent-console` / アカウント `server`。
- 新しい版を出す手順: package.json の version を上げる PR → マージ → `vX.Y.Z` タグを付けて push → CHANGELOG に 1 行追記。

## 認証の仕組み（要点）

- サーバー秘密はキーチェーンだけに置く（ファイル・URL・ログに出さない）。
- 起動アプリが秘密で 1 回限りコード（30 秒で失効）を受け取り、`/pair?code=` を開く → サーバーがセッション Cookie（HttpOnly・SameSite=Strict、最長 24 時間）を発行して `/` へ。
- 開発時（`npm start`）は秘密を使わず、起動ごとの乱数と、起動ログのペアリング URL（5 分）を使う。
