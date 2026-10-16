# recon: 本番サーバーを名前で止める命令の見張り（server-kill-guard）

基準: origin/main c67e90a（v0.40.0）。生出力は /tmp/CC報告ファイル/agent-console-connect/ に保存（01〜15.txt）。

## 事実（実物で確かめたもの）

### 起きたこと（2026-10-16）
- F1 launchd の記録: `09:56:08 service inactive: local.agent-console.server`、`09:58:04 service inactive: local.agent-console.server`（04.txt）
- F2 `launchctl print gui/501/local.agent-console.server`: `state = not running`、`last exit code = 0`、`runs = 7`（02.txt:39-75）
- F3 サーバーが終了コード 0 で終わる経路は SIGINT/SIGTERM の shutdown だけ: `server/index.ts:156` `process.exit(0)`、`server/index.ts:158-159` `process.on("SIGINT"|"SIGTERM", shutdown)`（08.txt:135-139）
- F4 別セッション（ffa7d9cd）の担当（サブエージェント agent-a8a8177a1fa78f1a0）が、試験の前処理として次を実行（11.txt）:
  - `2026-10-16T00:56:04Z`（=09:56:04 JST）`pkill -f "dist-server/server/index.js"`
  - `2026-10-16T00:58:03Z`（=09:58:03 JST）同上
  - 以後 01:00〜01:07Z にも同じ命令を 5 回（本番はすでに止まっていた）
- F5 F4 の 2 回は、F1 の停止の 4 秒前・1 秒前。本番の起動引数は `/Users/tanizawashingo/Library/Application Support/agent-console/current/dist-server/server/index.js`（02.txt:17）で、`pkill -f` の文字列に一致する
- F6 担当は「試験は 4329 番で本番（4319）と分離」と記録していた（11.txt の result.md）。分離していたのはポートと dataDir で、`pkill -f` は名前一致なので分離の外
- F7 plist は `KeepAlive=false`（02.txt:23-24）。コメントは「落ちた場合は Dock の起動アプリが launchctl kickstart で起こし直す」（02.txt:8）。自動では起き直らない
- F8 画面の症状: 右欄「様子を取得できません」、端末「つなぎ直しています...」、下部の利用量・Mac 使用率・アカウントがすべて取得できない。127.0.0.1:4319 は `Couldn't connect`（03.txt）
- F9 本 Opus 会話からの `launchctl kickstart` は Claude Code の自動判定（auto mode）に拒否された。一方 F4 の担当の `pkill -f` は通っていた（拒否されたのは起こす側、通ったのは止める側）

### 見張りの仕組みの現状
- F10 既存の同期 guard は `hooks/ac-routine-guard.mjs`。判定は `agent_id` がある（担当）ときだけ（`hooks/ac-routine-guard.mjs:30-32`）。止める対象は ac-routine・reserve-token・dataDir・routines の宛先で、プロセスを止める命令は対象外（同:24-27）
- F11 guard の登録は `server/activity-hooks.ts:12-19` の `GUARD_IFS`（`if` は 1 handler に 1 規則）と `server/activity-hooks.ts:63`。登録総数は 17 本（`server/activity-hooks.ts:46` のコメント）
- F12 e2e は `playwright.config.ts` の webServer で `node dist-server/server/index.js` を起動し、`reuseExistingServer: false`（13.txt:80-84）。試験サーバーが残っていると次の試験が起動できないため、担当が前の試験サーバーを止めようとした
- F13 e2e の後片付けは `tests/fixtures/e2e-teardown.ts` で、試験用 tmux（`ac-test-` 接頭辞）だけを止める（15.txt:22-36）。webServer の node は playwright が止める

## 推測しないこと
- 09:56:48 に一度起き直した経路（Dock の起動アプリか、ほかか）は未確認。設計はこれに依存しない
- `kill <pid>`（番号直書き）で本番を止める形は、命令の文字列からは判定できない。本設計の範囲外とし、限界に書く

## 既存 ADR・設計の検索結果
- agent-console に ADR 体系は無い。設計は `docs/handoff/<topic>/`。関連: `docs/handoff/ac-hardening/design.md`（guard 第2層・水準A＝うっかり防止）
- Sales Anchor 側 `docs/adr/` は agent-console の hook を扱わない（本件の対象外）
