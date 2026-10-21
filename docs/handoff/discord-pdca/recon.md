# recon: Discord の不具合報告から agent-console が対応を回す（discord-pdca）

- 作成: 2026-10-21 Claude Opus（設計パートナー）。調査は Sonnet 担当2回（読み取りのみ）。
- 基準: agent-console origin/main `f3bc1c7a928851ebad260b119447fac35120ce73`（2026-10-18T03:03:17+09:00、v0.43.0）。salesanchor origin/main `1ffef628f`（2026-10-21T10:50:13+09:00）。
- 生出力: `/tmp/CC報告ファイル/discord-pdca-recon4/`、`/tmp/CC報告ファイル/discord-pdca-recon5/`、`/tmp/CC報告ファイル/ac-discord-recon2/`、`/tmp/CC報告ファイル/ac-discord-recon3/`、`/tmp/CC報告ファイル/discord-pdca-recon6/`（claude 2.1.305 のヘルプ）。
- 表記: A = agent-console origin/main、S = salesanchor origin/main、D = S:tools/claude-channels/discord-ops。
- 外部サイト・Claude 公式サイトは調べていない（PO 指示 2026-10-21「claudeの公式サイトや外部サイトを調査することは禁止」）。Discord の仕様は、リポジトリ内で動いた実装（D）から読める範囲だけを事実とし、それ以外は「未確認」とする。

## 0. 既存 ADR・仕様の検索結果

| 対象 | 状態 | 本件との関係 |
|---|---|---|
| S:docs/adr/ADR-1009-discord-ops-intake.md | Accepted（2026-10-13） | 監視アラートの webhook 投稿を、PO の Mac の常駐 Claude Code 1セッションで受ける。人の投稿は対象外（S:docs/specs/discord-ops-intake/README.md:11-12）。本件はこれを置き換える（Fable 条件「ADR-1009 の退役」） |
| S:docs/adr/ADR-1012-ai-ops-247.md | **Proposed** | AI 保守運用の24時間化。Decision 2「障害記録の正本はアプリ DB の表1か所」、Decision 5「ADR-1009 の受付は予備。共用の担当定義を1ファイル」。Why「指示（プロンプト）は防壁にならない」。:21「リポジトリは PUBLIC」。Consequences「常時起動がサブスクの通常利用に入るかは明言なし。段階4 の前に PO 判断」。障害記録の表・全停止・保守 API は段階2 で本番に入っている（§11） |
| S:docs/adr/ADR-1033 / ADR-1034 | **Proposed**（どちらも「便1のマージ時点。…の後に昇格」） | 会話の同意票・権限の足し引き台帳。本件のセッションは権限を変えない |
| S:docs/adr/ADR-136 | Accepted | 危険 PR の GO 手順 |
| A:docs/handoff/ac-routine/、agent-pending-20/、reservations/、server-kill-guard/ | マージ済み | 定期実行・予約・停止の見張りの既存設計 |

S の ADR 番号の最大は ADR-1036（次は 1037）。

## 1. 予約（A:server/reservations.ts）

- 上限: `MAX_PENDING=50`（:22）、`MAX_AGENT_PENDING=20`（:23）、`MAX_ITEMS=200`（:24。超えたら終わったものを古い順に消す :115-118）、`MAX_MEASURE_NOTE=200`（:25）。開始は60秒以上先（:17）、366日以内（:18、:172）。
- purpose は `"measure"` だけ（:51,:67）。AI が作るときは purpose=measure と measureNote（1〜200字）が必須（:176-181）。
- 取り消せるのは pending だけ（:197-206）。
- 起動の経路: `ReservationService.tick`（:209、1秒ごと :153）→ `dispatch`（:229）→ `launchAndSend`（A:server/launch.ts:98）。期限を過ぎた予約も拾う（:212）。60秒を超える遅れは lateMinutes に残す（:215）。
- 起動時に dispatching のまま残った予約は送り直さず、`outcome=interrupted` で done にする（:146-148）。
- 複数の予約は `restoreStaggerMs`（既定 3000ms、agent-console.config.json:13）ずつずらして開く（:211）。
- **予約の作成・取消の監査記録は無い**。A:server/http.ts の予約の経路（:195-198, :364-373）は writeAudit を呼ばない。残るのは reservations.json の status・createdBy・createdAt・outcome・measureNote だけで、200件を超えると古い順に消える。
- AI 用の入口の検査は合言葉（reserve-token）だけで、役割の検査は無い（http.ts:364-371）。

## 2. 定期実行（A:server/routines.ts, routine-audit.ts, routine-closer.ts）

- 上限: `AGENT_ENABLED_LIMIT=10`（:17）、`MAX_REASON=200`（:19）、`MAX_EVENTS=100`（:15）。
- 起動の経路: `RoutineService.tick`（:129、1秒ごと :70）→ `dispatch`（:142）→ `open`（:152）→ `launchAndSend`。JST の曜日と HH:mm が今の「分」に合い、`lastSlot` が今の枠と違うときに起動する（:129-131）。lastSlot を先に保存し、保存に失敗したらその枠は見送る（:134-135）。
- 同じ分の定期実行は**ずらさずに同時に全部開く**（:136-139）。
- 過ぎた枠を補う処理は無い。Mac が寝ていた間やサーバー停止中の枠は実行されない。
- AI 用の入口は合言葉に加えて呼び出し元の役割を検査する（http.ts:402-408, 440-443）。使える役割は `DEFAULT_ROUTINE_MANAGER_ROLES=["opus-designer"]`（A:server/config.ts:322）。
- 監査記録: `dataDir/routine-audit.jsonl` に1件1行で追記するだけ。ファイルは 0600、フォルダは 0700（routine-audit.ts:2-3,7-8,45）。action は add / update / enable / disable / approvalIssued / closed / kept（:11）。書き込みは Promise の鎖で順番に行い、失敗したら例外にする（:47-56）。token と promptText は書かない。
- 自動で閉じる仕組み（routine-closer.ts）: `claude agents --json` の標本を定期的に取る（:2）。`idle` かつ `runningCount===0` が**続けて** `CLOSE_IDLE_MS=10分` 続くと（途中で動けば数え直す） finish する（:8, :56-57）。`waiting` が `KEEP_WAITING_MS=60分` 続くと、閉じずに kept として記録する（:61-65）。最後の返答が `NEEDS_DECISION:` か `BLOCKED:` を含むなら kept(decision)（:13, :76-85）。

## 3. セッションの起動と同時数

- launchAndSend は次の順に進む（A:server/launch.ts:98-113）: `sessions.restore`（:107）→ waitReady（最長120秒、:11）→ /rename → waitReady → `hub.submitText`（:113）。名前は1〜40字、本文は8192字まで（:8-9）。
- 同時セッションの上限は `DEFAULT_MAX_SESSIONS=16`（A:server/sessions.ts:15,187,316-317）。超えたら outcome="full" になり、やり直さない（launch.ts:104）。
- **1時間の中での重なりを検査する仕組みは無い**。役割ごとの同時数の上限も無い。
- 役割は agent-console.config.json:31-51 で決めている。opus-designer は `ccopusgo`、sonnet-impl は `claude --model sonnet`（needsWorktree=true）、shell の3つ。型の検証は A:server/config.ts:138-155。ツールや権限の絞り込みは agent-console 側に無く、起動コマンドの側で決まる。
- `ccopusgo`（/Users/tanizawashingo/.claude/shell/ccopusgo.zsh:84）の動き:
  - `cd /Users/tanizawashingo/salesanchor` してから、`claude --model opus --effort <medium|high> --permission-mode auto --append-system-prompt "<salesanchor-designer.md + salesanchor-claude-go.md>"` を実行する（:7-8, :79）。
  - 依頼文は `--` の後ろに置く。
- セッションに渡す環境変数からは、AGENT_CONSOLE_TOKEN・AGENT_CONSOLE_AUTH・AC_SECURITY・AC_STUB_LOG を外す（A:server/config.ts:237, sessions.ts:98-108）。

## 4. 秘密と外向きの通信

- 秘密の置き場: Keychain の service `agent-console` / account `server` を、`/usr/bin/security find-generic-password -w` で読む（A:server/keychain.ts:7-8,15,23）。
- 外向きの送信は server/ に無い。fetch は 127.0.0.1 宛だけ（hooks/ac-reserve.mjs:32, ac-routine.mjs:35, extension/background.js:63, src/api.ts:38）。外と通信するのは、子プロセスとして呼ぶ gh（pr-status.ts:242,253）と claude（account.ts:40）だけ。
- 通知は macOS の通知だけ（A:server/notify.ts:19-21,33-39）。Discord の実装も依存も無い（git grep -i discord のヒットは docs/handoff の2件だけ）。
- データの保存: A:server/json-store.ts は書き換えを1件ずつ順番に行う（createSerial :10）。
  - 一時ファイル（0600）に書いてから rename するので、書き換えは一度で終わる（:30-36）。
  - 壊れた JSON は例外にして上書きしない（:20）。

## 5. 常駐・起こし直し・電源

- 自動起動の設定ファイル `~/Library/LaunchAgents/local.agent-console.server.plist`: RunAtLoad=true（:20-21）、KeepAlive=false（:22-23）、ThrottleInterval は無い。落ちても自分では起き直らない。
- 雛形（ops/launchd/…template:8）には「Dock の起動アプリが launchctl kickstart で起こし直す」とある。Dock のアプリは /Users/tanizawashingo/Applications/Agent Console.app。
- KeepAlive=true を採らなかった理由（A:docs/handoff/server-kill-guard/design.md:62）: 導入手順の `ac_stop_server_and_wait`（scripts/lib/ac-common.sh:226-236）は pid が消えるまで待つ作りで、自動で起き直る仕組みとぶつかる。
- /healthz は `{ok, version, commit}` を返す（A:server/http.ts:578-582）。
- 電源（`pmset -g`、/tmp/CC報告ファイル/ac-discord-recon2/pmset_g.txt）: `sleep 1 (sleep prevented by caffeinate …)`、`displaysleep 0`、`tcpkeepalive 1`。caffeinate がスリープを止めている。蓋を閉じたときと停電のときの挙動は未確認。

## 6. 既存の Discord 受付（ADR-1009）の実物

- 依存は `discord.js ^14.14.0` と `@modelcontextprotocol/sdk`。起動は bun（D/package.json、D/.mcp.json）。
- 接続は Gateway の常時接続（D/server.ts:94 `new Client`、:1088 `client.login`）。
  - intents は DirectMessages・Guilds・GuildMessages・MessageContent（:95-100）。
  - 本文は `msg.content` と embeds から作る（:974, :1051、D/lib.ts:46-55）。
  - `messages.fetch({limit})` は MCP の道具（`fetch_messages` は上限100件 :780-781、`list_monitor_alerts` は上限50件 :758-765）の中で呼ばれ、セッションが道具を呼んだときだけ動く。**自動の取りこぼし補完ではない**。`after` の指定は使っていない。
  - 接続の合図は `client.once('ready')`（:1084）で、1回だけ。回線が切れて戻ったときに何が起きるかは D からは分からない（U7）。
- 送信元の見分け方（:951-967）: bot の投稿のうち webhookId が無いものは捨てる。webhook は許可表で判定する。人の投稿は allowlist で判定する。
- **受け取った message_id で重複を防ぐ仕組みは無い**（seen/dedup の語が無い）。再接続は discord.js に任せている（:861-863）。
- 配置（`~/.claude/channels/discord-ops/access.json`）: opsChannel（id は伏せる。公開リポジトリのため）。monitorChannels は3件で、それぞれ許可した webhook が1件ずつある。allowFrom は1件だけ（PO の利用者 id。公開リポジトリのため伏せる）。
- トークンの置き場:
  - `~/.claude/channels/discord/.env` と `~/.claude/channels/discord-ops/.env`。どちらもキーは `DISCORD_BOT_TOKEN` だけ（値は見ていない）。
  - **今は動いていない**: heartbeat の最終が 2026-10-15T11:53:19Z、launchctl と ps に該当が無い、~/.claude/settings.json:514 が `"discord@claude-plugins-official": false`。
- ボットの区別:
  - S:docs/handoff/gas-viewer-fresh-fast/design.md:436 は、本番アプリのボットを「Sales Anchor#8667」、保守運用のボットを「SA Bug Intake」と書き分けている。
  - 本番 backend は `DISCORD_BOT_TOKEN` を使う（S:backend/app/discord_gateway/config.py:17）。OAuth の `DISCORD_CLIENT_ID` の既定値は `1499458730171961535`（S:backend/app/routers/discord_oauth.py:46）。
  - **SA Bug Intake の application id と本番の id が同じかは未確認**（トークンから id を取り出す操作は権限判定で拒否された）。

## 7. Sales Anchor の Webhook と不具合対応の手順

- アラート系の Webhook の環境変数: ADMIN_NOTIFICATION_DISCORD_WEBHOOK、ANALYSIS_ERROR_REPORT_DISCORD_WEBHOOK、ROLLBACK_DISCORD_WEBHOOK など（S:docker-compose.yml:105,237 ほか。一覧は recon4/E3_files.txt）。本件の報告先は、これらとは別の新しい Webhook にする（PO 決定）。
- 不具合対応の専用手順書は無い。近いのは次の4つ。
  - S:docs/STANDARD-WORKFLOW.md §1（:18）、§3（:115）、§5（:131。バグ修正は自律クラフト扱い :37,:134）
  - S:docs/ai-agents/executor-checklist.md
  - S:docs/runbooks/alerts.md
  - S:docs/ai-agents/agent-roles.md（Escalation :84）

## 8. 予約と定期実行の今の重なり（2026-10-21 10:55 の時刻変更後）

- 定期実行（有効な6件、`ac-routine list` の写し: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/a85af4bf-dc0b-4a6a-af02-abf376f27ef6/scratchpad/retime/after.json）:
  - 許可保守: 月〜金 09:00
  - バルク: 毎日 10:00 → 11:00 に変更予定（10/21 12:00 以降）
  - 仕入元A: 毎日 10:00 → 12:00 に変更予定（10/21 12:00 以降）
  - 〆: 毎日 10:00
  - 見出しe: 火・木 13:00（10:30 から変更済み）
  - 同意点検: 月 14:00（09:30 から変更済み）
- 残る重なり（予約と定期実行）: 10/22 09:00 の予約と許可保守、10/23 10:00 と 10/31 10:00 の予約と〆、01/14 09:00 の予約と許可保守。

## 9. CI と UI の決まり（A）

- CI（.github/workflows/ci.yml:1-72）の順番: npm ci・audit → SA を clone して sa-sync → typecheck → lint → vitest → tmux timing → build → playwright e2e。ubuntu と macos の両方で走る。設計文書の検査は無い。
- lint の中の scripts/check-design-governance.mjs が禁止しているもの:
  - 色・px・font の直書き（:86-123）
  - インライン style の数値（:131-149）
  - src/pages の生の button・input・select・textarea・a（金型を使う。:165-166）
  - tsx への日本語の直書き（t() を通す。:169-176）
- アプリ独自のトークンの置き場は src/tokens.app.css（`--ac-` だけ。:10, :102-108）。
- 版の出し方（README.md:300）: version を上げる PR → マージ → vX.Y.Z タグ → CHANGELOG に1行。導入は PO が `!` で scripts/ac-install.sh / ac-update.sh を実行する（README:283-291）。
- README.md:126 の「予約はメモリだけ」は古い。今は reservations.json に保存している（reservations.ts:10, :97）。

## 未確認のまとめ

| # | 内容 | 扱い |
|---|---|---|
| U1 | SA Bug Intake は本番アプリのボットとは別のアプリか（id の照合） | 便0 で、接続したときにボット自身の id を読み、`1499458730171961535` と比べる。同じなら止めて PO へ |
| U2 | 人の投稿の本文を、このボットが Discord から読めるか（MessageContent が有効か） | D は MessageContent を要求して動いていた（:95-100、heartbeat 10/15 まで）。便0 の試作で実際に読めるか確かめる |
| U3 | REST の `GET /channels/{id}/messages` で `after` と `limit=100` が設計どおりに返るか | 第4版で読み方を ADR-1025 と同じ REST に揃えた（§12）。ADR-1025 の設計が公式資料を引いている（S:docs/handoff/analysis-error-report/design.md:67）が、本件では外部サイトを見ない決まりのため確かめ直していない。第0段 0-3 の実物で確かめる |
| U4 | 蓋を閉じたときと停電のときの Mac の挙動 | 遅延通知と取りこぼしの補完で対処する。実測は便2 の受入で行う |
| U5 | `claude` の起動引数でツールを絞ったとき、auto の許可モードでも実際に拒まれるか | 引数があることは §10 で確認済み。効き目は第0段 0-4 で実物で確かめる |
| U6 | 常時起動がサブスクの通常利用に入るか（ADR-1012:42） | 本件は人の投稿1件ごとに1セッションを開き、上限も設ける。ADR-1012 の段階4（監視から常時起動）には当たらない。PO 判断の要否は design §6 R8 |
| U7 | 回線が切れて戻ったとき、discord.js がどの合図を出すか | 第4版で常時接続をやめたため、設計の前提から外れた（確かめない） |
| U8 | 起動引数のツール制限が、セッションが呼ぶサブエージェントにも効くか | 第0段 0-4 で実物で確かめる |
| U9 | `-T` 無しで登録した Keychain の項目を、同じ利用者のセッションの Bash から `/usr/bin/security` で読めるか | 第0段 0-5 で試験用の項目で確かめる（A:scripts/ac-install.sh:25 は `-T` を付けていない） |
| U10 | `ac_stop_server_and_wait`（A:scripts/lib/ac-common.sh:226-236）で止めたときのサーバーの終了コード | 第0段 0-6。KeepAlive の SuccessfulExit=false 案の採否が決まる |
| U11 | 保守 API を試す場所（試験の環境があるか） | 第0段 0-9。無ければ本番で試験の印（`labels.test`）を付けて行う時刻を PO に確かめる |
| U12 | `~/.claude/channels/` 配下の `.env` のトークンが SA Bug Intake のものか | 第0段 0-12。値を出さずに `GET /users/@me` の id だけを比べる |
| U13 | 今 ac-reserve を使っている役割 | 第0段 0-11。許可の一覧を決める前に数える |
| U14 | Discord のメッセージの種類（返信・転送・固定の知らせなど）のどれを受け付けるか | 第0段 0-3。`allowedMessageTypes` の値を決める前に実物で確かめる |
| U15 | `CLAUDE_CODE_SESSION_ID`・agent-console の記録・`claude agents --json` のセッションの id が同じか | 第0段 0-13。case-token の照合の前提 |

- 事実（第5版で追加）: ADR-1012 Decision 5 は、段階4 の AI と ADR-1009 の受付が repo の共用の担当定義1ファイルを読むと決めている（S:docs/adr/ADR-1012-ai-ops-247.md:29）。このファイルは origin/main にまだ無い。生の出力: /tmp/CC報告ファイル/discord-pdca-recon6/aiops-design-agentdef.txt

## 10. 手元の claude のヘルプ（2.1.305、/tmp/CC報告ファイル/discord-pdca-recon6/claude_help.txt）

- ツールを絞る引数がある: `--allowedTools`（:23-25）、`--disallowedTools`（:81-83、例 `"Bash(git *) Edit"`）、`--tools`（:255-259）、`--settings`（:228-229）、`--strict-mcp-config`（:230-231）。`--restricted`（:195-209）は Bash と WebFetch を外す。
- 書いてあるのは引数の説明だけ。auto の許可モードでの効き目・サブエージェントへの効き目は書いていない（U5・U8）。

## 11. 本番の障害記録・全停止・保守 API（ADR-1012 段階2。S origin/main）

- 生出力: /tmp/CC報告ファイル/discord-pdca-recon6/ops_incident_sql.txt、ops_router.txt、stage2_design.txt
- 表（S:migrations/20261016_100000_create_ops_incident_tables.sql）:
  - `public.ops_incidents`（:5-39）: 1件1行。`fingerprint`・`starts_at` で一意（:31）。`status` は firing / resolved（:32）。`detection_path` は alert / human / ai（:33）。`human_noticed_at`・`ai_started_at`・`root_cause`・`fix_pr`・`review_note` の列がある。
  - `public.ops_incident_events`（:47-59）: 追記だけ。`kind` は notified / resolved / annotated / first_aid / ai / halt（:55）。`actor` は alertmanager / ops_token / super_admin（:57）。`detail` は 8192 バイトまで（:58）。
  - `public.ops_control`（:65-72）: 全停止スイッチ。1行だけ。行が無いときは止めていない（:64）。
  - 読み書きとも運用者の旗が立った接続だけ（RLS :78-115）。DELETE の権限は外している（:117-126）。
- 作った commit: 262704036（便A の表）、47a982279・b24a8fee8（便B の保守 API）。
- 保守 API（S:backend/app/routers/ops.py）:
  - `POST /ops/alertmanager`（:213、受け口の鍵）だけが行を作る。
  - `GET /ops/incidents`（:275）・`GET /ops/incidents/{id}`（:301）・`POST /ops/incidents/{id}/events`（:357。`kind` は annotated / first_aid / ai :352、`detection_path` などを決まった名前だけ更新 :53, :346）。
  - `GET /ops/control`（:454）・`POST /ops/control/halt`（:474、保守の鍵か super admin）・`POST /ops/control/resume`（:483、**super admin だけ** :486）。
  - 人の報告から行を作る入口は無い。
- 段階2 の設計（S:docs/handoff/ai-ops-247/stage2-design.md）:
  - 全停止は「true の間、処置と AI 起動をしない（段階3・4 が読む）」（:103）。段階2 では「止めても記録は続ける」（:177）。
  - 保守 API が落ちても、Alertmanager の Discord への通知は別に届く（:191）。
  - 保守の鍵は段階2 では Mac の `~/.claude-access.env` にだけ置く（:213）。実物にキー名 `OPS_API_TOKEN` がある（値は見ていない）。
- 段階3・4（処置と AI 起動）は未作成（stage2-design.md:177 で受入を段階3・4 に移している）。
- 第2版の recon で「障害記録の表は無い」と書いたのは誤り。`backend/app/models` だけを探していた。表は migration と生の SQL（ops.py:183 など）で扱われている。

## 12. 解析の誤り報告（ADR-1025）の受け口の設計（S origin/main）

- 生出力: /tmp/CC報告ファイル/discord-pdca-recon6/adr1025.txt（44行）、aer-design.txt（150行）、aer-kgi.txt（24行）
- ADR-1025 は Proposed（adr1025.txt:5）。PO 承認済み（2026-10-17 チャット。:6）。
- 決定 4（adr1025.txt:24）: 起動は Mac の agent-console が誤り報告チャンネルを30秒ごとに Discord の REST で読む。同時1・1時間6・同じ番号1回、止めるスイッチを持つ。
- 設計 §4-4（aer-design.txt:66-73）:
  - :67 `GET /channels/{id}/messages?after=<最後の ID>&limit=100`。権限は VIEW_CHANNEL と READ_MESSAGE_HISTORY だけ。鍵は bot トークン（Mac の鍵ファイル）。
  - :68 拾う判定は webhook_id が決めた webhook と一致すること。
  - :69 作る場所は v0.42.3（今の稼働は v0.43.0。古い記載）。
  - :70 本文が `ER-` ＋6桁に合うものだけ。
  - :72 同じ report_code のセッションがあれば開かない。同時1・1時間6。止めるスイッチ（画面と設定ファイル）。
  - :73 指示は決まった文だけ。報告の文面は入れない。
- KGI（aer-kgi.txt）:
  - :12 G2b 通知から5分以内に、報告番号を名前に含むセッションが1つ開く。眠っていた間の報告は起きてから5分以内。
  - :15 G5 全停止スイッチを入れると新しいセッションは開かない。
  - :16 G6 受信の仕組みを足した後の CPU（1日平均）の増分1%未満、メモリの増分50MB未満。
- 進み具合（S の git log）: 便1 #4465・便2 #4473 はマージ済み（表・API・照合）。便4（agent-console の読み取り）は未着手。agent-console の origin/main に ADR-1025 の commit は無い。
- 画面更新の通知の台帳（S:backend/app/realtime/topics.py）: POST の入口ごとに登録がある。保守 API は :116-119、誤り報告は :420-421。
- 本件との重なり: Discord を読む部品・止めるスイッチ・同時の数え方。PO の決定（2026-10-21「1」）で、部品とスイッチは共通、枠は種類ごとに1つにした（design §1・§4-2）。

## 第6版・第7版で引用した実物の行（第5版・第6版の審査で照合済み。生の出力: /tmp/CC報告ファイル/arch-discord-pdca-v5/・/tmp/CC報告ファイル/arch-discord-pdca-v6/）

- S:backend/app/routers/ops.py:395-397 — 出来事の `detail` を `{fields, note, user_id}` で作る。
- S:backend/app/routers/ops.py:361 — 出来事の入口の呼び出し元の確かめ（保守の鍵とログインが同じ入口を通る）。
- S:docs/adr/ADR-1012-ai-ops-247.md:46 — マージの権限を広げるかは月次成績表の実績を見て PO が判断する。
- A:server/http.ts:196 — 画面からの予約の作成（`POST /api/reservations`、createdBy `ui`）。
- A:server/reservations.ts:65 — 予約の読み込みの検査。createdBy は `ui`・`agent` だけを通す。
- A:server/routine-closer.ts:78 — 最後の返答が読めないときは `no-reply` で kept にする。
- A:server/sessions.ts:506-507 — close が終わらせるのは端末とその子孫。
- A:server/routine-audit.ts:11 — 監査記録の操作の種類 `RoutineAuditAction`。
