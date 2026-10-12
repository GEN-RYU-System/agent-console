# v0.3.9 restore-guard recon

調査記録の元: /tmp/CC報告ファイル/orca-selfbuilt/session-restore/notice-e.md（基準は origin/main 357d35b）。

## 事実

- tests/unit/server-process.test.ts:52-63 の config には dataDir が無い。子プロセスは tests/unit/server-process.test.ts:66-67 で server/index.ts をそのまま起動する。
- dataDir が無いと既定値になる: server/config.ts:104-108（parseDataDir）、既定は server/config.ts:32 の DEFAULT_DATA_DIR（本番と同じ場所）。
- 起動時に復元と記録が走る: server/restore.ts:154-163（旧 isRestoreEnabled は AGENT_CONSOLE_RESTORE が off でなければ有効）。server/restore.ts:42-60 の OpenSessionRecorder がセッションの作成のたびに open-sessions.json を書く。
- 試験 tests/unit/server-process.test.ts:148-149 が作る name "e" / roleId "envdump" が本番の復元リストに残り、PO の画面に「開き直せなかった：e」と出た。
- PO がセッションを開いている間に試験を手元で実行すると、本番の復元リストが試験の内容で上書きされる。
- 本番と同じ dataDir を読む別のサーバー（開発用の起動など）が復元を走らせると、PO の会話を二重に開く。
- 本番の LaunchAgent（/Users/tanizawashingo/Library/LaunchAgents/local.agent-console.server.plist）の EnvironmentVariables は AGENT_CONSOLE_AUTH=keychain と PATH の2つだけで、AGENT_CONSOLE_PORT は無い。
- ポート上書きは server/config.ts:183-193（applyPortOverride。空文字は未設定扱い）。e2e の webServer（playwright.config.ts:18-33）は AGENT_CONSOLE_PORT を設定せず、ポートは設定ファイル側（tests/fixtures/e2e-env.ts の E2E_PORT）。
- 試験 harness は index 経由でサーバーを起動しない（tests/unit/session-restore.integration.test.ts:363,379 は startOpenSessionRestore に env を直接渡す）。
