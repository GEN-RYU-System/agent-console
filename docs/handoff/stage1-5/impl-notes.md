# 段階1.5 実装メモ

実装: Claude Sonnet / 2026-10-11

## §1 Chrome `--app` 実機確認（設計 §9 条件1）

環境: Chrome は確認前から起動中（`pgrep -x "Google Chrome"` → 51043、確認後も同じ 51043。新しいプロセスは増えず、既存プロセスに転送された）。

1. 一時ポートの最小 HTTP サーバー（node、スクラッチ）を起動。
2. `open -na "Google Chrome" --args --app=http://127.0.0.1:<port>/probe` を実行（exit 0）。サーバー側のアクセスログ（生）:
   ```
   2026-10-11T01:12:48.215Z GET /probe ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/
   2026-10-11T01:12:48.444Z GET /favicon.ico ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/
   ```
3. `osascript` での窓の取得は macOS の権限判定で失敗した（Apple Events の送信権限が無い）:
   `execution error: Google ChromeにApple Eventsを送信する権限がありません。 (-1743)`。権限は変更していない（実環境を変えない約束）。
4. 代替の観測: probe ページ自身が報告する表示モード（`/report` への POST の生出力。`window.close()` で自分の窓を閉じる）。
   - `--app` で開いた窓: `{"locationbar":true,"toolbar":true,"menubar":true,"standalone":true,"minimalUi":false,"browser":false,"chromeH":76,"historyLength":1,"opener":false}`
   - 対照（通常の `open -a "Google Chrome" <URL>`）: `{"locationbar":true,"toolbar":true,"menubar":true,"standalone":false,"minimalUi":false,"browser":false,"chromeH":0,"historyLength":1,"opener":false}`
   - `matchMedia('(display-mode: standalone)')` が `--app` のときだけ true。`window.locationbar.visible` などは両方 true で、判別には使えなかった。
   - 生ログ: `/tmp/CC報告ファイル/orca-selfbuilt/s15-app-probe-control.log`
5. 判定: 既存の Chrome 起動中でも、`open -na … --args --app=URL` は URL を開き、ページから見て `display-mode: standalone`（アプリ窓）になる。ただし「見た目が通常タブでない」ことを画面や AppleScript では確認できていない（権限が無いため）。PO 実機での目視 1 回が必要（K1 の PO 実機確認に含める）。
6. 後始末: probe サーバーは停止済み。窓は 2 つ開いた（1 つ目は script 無しの静的ページで、閉じる手段が無い）。1 つ目の「probe」窓だけ PO が手で閉じる必要がある（⌘W）。2 つ目（`--app`）と対照のタブはページが `window.close()` で閉じた（閉じたかは目視で未確認）。

## 実装状況

| カード §2 | 状況 |
|---|---|
| 1 キーチェーン読込 | 完了（`server/keychain.ts`・`server/secret.ts`、テスト付き） |
| 2 /api/pair・/pair・セッション | 完了（`server/auth.ts`・`server/http.ts`） |
| 3 認証を Cookie か Bearer に、`?t=` 廃止、Origin、/healthz | 完了 |
| 4 起動ログ | 完了（開発時のみペアリング URL。本番は秘密・セッション・コードを出さない） |
| 5 フロント | 完了（Cookie 認証、ペアリング失敗画面、版表示） |
| 6 plist 雛形 | 完了（`ops/launchd/local.agent-console.server.plist.template`） |
| 7 ac-install/update/rollback/uninstall＋lib | **保留（BLOCKED）**: 下記 |
| 8 起動アプリ | 完了（`ops/launcher/AgentConsole.applescript`・`launch.sh`、テスト付き）。osacompile は実機で構文確認 |
| 9 CI audit | 完了（`npm audit --audit-level=moderate`・`npm audit signatures`、ローカルで両方 exit 0） |
| 10 version 0.2.0・CHANGELOG | 完了 |
| 11 README | 完了 |

### 保留の理由
スクリプト本文（`scripts/lib/ac-common.sh` と `scripts/ac-uninstall.sh`）に、AC_HOME 配下でマーカー確認済みのパスだけを対象にしたディレクトリ削除（再帰・強制の削除コマンド）を書く Bash コマンドが、agent-danger-hook に「不可逆操作」として拒否された。実行ではなく本文を書き出すだけだったが、言い換え再試行はしていない。スクリプトのテスト（`tests/unit/scripts.test.ts`、スタブ・一時ディレクトリ）は先に書いてあり、スクリプトが無いため現在は失敗する。

## 認証まわりの判断（カードに無い細部）

- セッション ID・ペアリングコードはサーバー内ではハッシュで保持し、全件を定数時間で比較する。
- `POST /api/pair` は Bearer のみ（Cookie では発行できない＝セッションの自己延命を防ぐ）。
- 無効なコードの `/pair` は、SPA の index.html を 401 で返す（画面は SA の Callout で案内）。
- ペアリング応答の 303 に `Cache-Control: no-store`・`Referrer-Policy: no-referrer` を付与。
- pty の子プロセス env から `AGENT_CONSOLE_TOKEN`・`AGENT_CONSOLE_AUTH`・`AC_SECURITY` を除去。
- `AGENT_CONSOLE_PORT` でポートだけ上書きできる（導入前の自己診断を別ポートで行うため）。
- 導入時の秘密保存は `security -i`（コマンドを標準入力から読む）。`add-generic-password -w <値>` を引数に出さない（man security: `-i`）。

## テスト
- TDD の例外: ペアリングの統合テスト（`tests/unit/pairing.integration.test.ts`）とフロントのテストは実装と同時に作成。auth・keychain は RED を確認してから実装。
