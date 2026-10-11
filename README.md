# agent-console

Local console for running parallel Claude Code sessions (Orca-inspired, lightweight).

- 設計・調査・実装メモ: `docs/handoff/stage1/`（段階1）、`docs/handoff/stage1-5/`（段階1.5: 起動・版管理・セキュリティ）
- 版の履歴: `docs/CHANGELOG.md`（版の正本は git タグ `vX.Y.Z`）
- テスト: `npm test`（単体・統合）/ `npm run test:e2e`（要 `npm run build`）
- 設定: `agent-console.config.json`（`AGENT_CONSOLE_CONFIG` で別ファイル指定、`AGENT_CONSOLE_PORT` でポートだけ上書き）

## 開発時の起動

`npm ci && npm start`（Sales Anchor の origin/main を `.sa-cache/` へ展開 → ビルド → `127.0.0.1:4319`）。
起動ログに **1 回限り・5 分で失効するペアリング URL**（`/pair?code=…`）が出るので、それをブラウザで開く。長期の秘密は URL にもログにも出ない。

## 使い方（毎日の操作）

- **作業の区切りの通知**: Claude の状態が「作業中」から「待ち」または「待機」に変わると、一覧の行に「未読」の印、窓のタイトルに未読数、macOS の通知が出ます。行を選ぶと未読が消えます。この「区切り」はこのアプリの定義で、Claude 公式の「ターン完了」ではありません。macOS 通知は設定 `notify.macos`（既定 true）で切り替えます。
- **名前の変更**: 一覧の「名前を変える」。Claude 起動中は Claude に `/rename` を送ります（待ち・待機のときだけ）。10 秒たっても名前が変わらなければ画面に案内が出ます。Claude が動いていないセッションは、このアプリでの表示名を変えます。
- **よく使う指示**: 端末の上のバーで「指示を編集」から登録・編集・削除します。ボタンを押すと、選択中の端末へ文章と改行を送ります（8KB まで）。保存先は `~/Library/Application Support/agent-console/quick-prompts.json`（設定 `dataDir` で変更、権限 600）の 1 ファイルだけです。
- **過去のセッション**: 「過去のセッション」から一覧（`claude agents --all --json`）を開き、「再開」で同じ作業場所に `--resume` で戻ります。役割に `resumeCommand` がある場合（既定では Sonnet 実装）だけです。作業場所が本店・ワークツリーのどれでもない行は再開できません。
- **台帳ボードの絞り込み**: 既定は「作業中・レビュー・WIP」かつ「開始日が直近 30 日」です。隠れた件数と、開始日を読めない行（日付不明）の件数が別に出ます。期間・状態・ブランチ名の検索を変えられます（この表示設定はブラウザの localStorage に保存されます）。
- **メモリ**: フッターの「メモリ」で、セッションごと・このアプリのサーバー・Mac 全体を MB と % で見られます（開いている間だけ 10 秒ごとに更新）。

## PO 向け: 導入・更新・切戻し・撤去（この Mac）

どれも PO が `!` を付けて実行する（キーチェーン・LaunchAgent・~/Applications を変更するため、Claude は実行しない）。
`vX.Y.Z` は git タグ（`docs/CHANGELOG.md` に載っている版）。リポジトリのどの場所からでも実行できる（この 4 本は、いま開いているチェックアウトの `scripts/` から呼ぶ）。

| やること | 1 行コマンド | 何が起きるか |
|---|---|---|
| 初回導入 | `! bash scripts/ac-install.sh v0.2.0` | サーバー秘密をキーチェーンに保存 → 版を取得（**タグのコミットが origin/main に含まれることを確認**、`npm ci --ignore-scripts`、**コミット SHA を表示**）・ビルド → **別ポートで自己診断（/healthz の版・コミットが一致）** → ログイン時自動起動を登録 → Dock 用の `~/Applications/Agent Console.app` を生成 → `/healthz` を確認して結果を表示 |
| 更新 | `! bash scripts/ac-update.sh v0.3.0` | 新しい版を導入（上と同じ検証）→ 自己診断に通ったときだけ切替 → 再起動 → `/healthz` の版・コミットの一致を確認。失敗したら元の版に戻る |
| 切戻し | `! bash scripts/ac-rollback.sh` | 1 つ前の版（semver 順）に切替 → 再起動 → `/healthz` の版・コミットの一致を確認 |
| 撤去 | `! bash scripts/ac-uninstall.sh` | 自動起動と起動アプリを外して **Trash へ移す**（削除しない）。導入済みの版とキーチェーンの秘密は残す |
| 完全撤去 | `! bash scripts/ac-uninstall.sh --purge` | 上に加えて、導入済みの版・current・logs を Trash へ移し、キーチェーンの秘密を削除（秘密の削除だけは元に戻せない） |

- 片付けはすべて `~/.Trash/agent-console-<種類>-<日時>` への移動で、スクリプトは削除コマンド（`rm` を含む）を使わない。戻したいときは Trash から元の場所へ戻す。
- 導入後は Dock に `Agent Console.app`（`~/Applications`）をドラッグして固定する。1 回クリックすると、Chrome のアプリ窓がログイン済みで開く。
- 使用中の版とコミットは、画面下部の「版」「コミット」で確認できる。
- 置き場所: `~/Library/Application Support/agent-console/`（`versions/<tag>/`、`current`、`logs/`）、`~/Library/LaunchAgents/local.agent-console.server.plist`、キーチェーンのサービス `agent-console` / アカウント `server`。
- 新しい版を出す手順: package.json の version を上げる PR → マージ → `vX.Y.Z` タグを付けて push → CHANGELOG に 1 行追記。

## 認証の仕組み（要点）

- サーバー秘密はキーチェーンだけに置く（ファイル・URL・ログに出さない）。**ネットワーク（4319 の相手）にも送らない**。
- 起動アプリは相互認証でサーバーを確かめる: 乱数 `cnonce` を送る → サーバーが `HMAC(秘密, "server|cnonce|snonce")` を返す → 起動アプリが検証（偽のサーバーなら、何も送らず中止）→ `HMAC(秘密, "client|snonce|cnonce")` を送って 1 回限りコード（30 秒で失効）を得る。HMAC の計算に秘密は標準入力で渡す（引数に出さない）。
- 画面は `/pair?code=` でコードを引換え、セッショントークン（最長 12 時間）を**タブの sessionStorage** に保存する。**Cookie は使わない**（Cookie は同じ 127.0.0.1 の別ポートへも送られるため）。API は `Authorization: Bearer`、WebSocket は `Sec-WebSocket-Protocol: ac.<token>`。画面下部の「ログアウト」でサーバー側のセッションを失効させる。
- 開発時（`npm start`）は秘密を使わず、起動ごとの乱数と、起動ログのペアリング URL（5 分）を使う。
- 本番実行では `AC_*` の差し替え環境変数を無視する（テストモード `AC_STUB_LOG` のときだけ有効）。
- 注意: キーチェーンは別ユーザー・ファイルの直読みからの保護で、同じユーザーのマルウェア・端末内のプロセスは対象外（`security` コマンドで読み出せ得る。未検証）。
