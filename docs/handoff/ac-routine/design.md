# design: AI が定期実行を登録・変更できるようにする（ac-routine、Opus 限定）

> 写し元: /tmp/CC報告ファイル/ac-routine-cli/design.md（v5）。実装時の origin/main は 6277505（package.json 0.24.0、PR #39 cwd-picker 反映後）。本文の行番号は 658de91 基準のまま。その後の差分は `server/routines.ts`（:22 以降 +1 行。`RoutineInput` の cwd が省略可）と `server/launch.ts`（:42 以降 +2 行。本店型の役割は cwd を省くと本店）。agent 経路は同じ `RoutineService` を通るので、cwd の省略は画面と同じ扱い。版は 0.24.0 が使用済みのため本件は 0.25.0。
> 実装での設計との差: list にも役割照合を適用（403 は監査しない）／監査の書き込み失敗は console.error のみで応答を続ける（操作は実行済みのため）／RoutineService に AI 操作の排他を追加／画面経路の本文の createdBy を除去／rebase がフックで止められたため origin/main は merge で取り込んだ。


状態: 設計 v5（Opus 2026-10-14）。設計審査済み（review-4 で「直せば再審査不要」の判定、指摘は反映済み）。review-1〜4（Fable REVISE）の指摘を反映。M4 は PO 決定済み（§3）。PO 実装承認前。旧版は design-v1〜v4.md。
根拠: 同じディレクトリの recon.md（調査時の基準 origin/main 0a8266c = v0.21.0）。review-3 の実測で、origin/main は 658de91（package.json 0.23.0、最新タグ v0.22.0）まで進んだ。本件が触るファイルのうち差分があるのは http.ts（+1行、:195の後）と reservations.ts（+2行、:11の後）だけで、routines.ts・activity-hooks.ts・launch.ts・sessions.ts・hub.ts・ac-reserve.mjs・ac-hooks.mjs・ac-rollback.sh は不変。そのため、以下の http.ts の :273 以降の行は +1、reservations.ts の :12 以降の行は +2 と読み替える。「R:n」は recon.md の節番号。版の番号は以下「本件の版」（U3）、戻し先は「直前の版」と書く。

## 1. 目的（PO の言葉）
- 「定期実行の登録もAIが出来るようにする」
- 「ただし管理職であるopusが判断することが条件」

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| S1 | opus-designer のセッションの Opus が Bash で `ac-routine add` を打つと定期実行が1件増え、画面の「定期実行」タブに出る | 単体試験＋導入後の実機（K15） |
| S2 | 同じ Opus が `list` / `update` / `enable` / `disable` を使える。AI 分の有効が10件ちょうどでも、(a) そのうち1件を update すると成功、(b) 画面で作った分を enable すると成功、(c) 11件目の add は400 | 単体試験 |
| S3 | sonnet-impl のセッション（Sonnet）から打つと拒否され、何も変わらない（終了コード1） | 単体試験（役割の照合） |
| S4 | Opus のセッションの中のサブエージェント（Agent ツールの Sonnet）から打つと拒否される | 単体試験3本（guard の判定関数: agent_id あり＋`/bin/ac-routine.mjs` を含む→拒否・終了2／agent_id なし→終了0・出力なし／agent_id あり＋`ac-routine` の文字はあるが実行形でない（例 `git show origin/main:hooks/ac-routine.mjs`）→終了0・出力なし）＋実機（settings.json に guard が入っていること、サブエージェントから打って止まること） |
| S5 | アプリ外のターミナル（アプリが開いていない会話）から打つと拒否される | 単体試験 |
| S6 | 追加・変更・有効化・無効化と、その拒否（403、上限の400）のたびに「いつ・どの会話・どの役割・理由・結果・対象の作成者（対象を解決できた行）」が監査記録に1行残る | 単体試験（成功1行・403で1行・上限の400で1行（add は routineId 無し／enable は routineId と targetCreatedBy:"agent" あり）・`routine not found` の400では行が増えない・画面で作った分を disable すると targetCreatedBy:"ui"）＋実機でファイルを読む |
| S7 | 直前の版へ戻しても routines.json が読める | 単体試験（`createdBy` 付きの routines.json を、v0.21.0 から不変の parse（routines.ts:29）と同じ規則で例外なく読む。入力には無関係なキー `zzz` も入れ、出力に残らないこと＝未知のキーを捨てる性質を固定する（review-2 L7）。あわせて、旧版相当の parse→save を通すと createdBy が消えることも既知として固定する） |
| S8 | トークンの値を標準出力・標準エラー・403/400 の本文・監査行のどれにも出さない | 単体試験（4か所それぞれに token 文字列が無いこと。ac-reserve の R12 の型） |

## 3. 対象 / 対象外
- 対象: 新しい命令 `ac-routine`（hooks/ac-routine.mjs）、AI 用の受け口 `/api/agent/routines`、呼び出し元の役割照合、監査記録、サブエージェント拒否の hook、README・CHANGELOG・版。
- 【PO 決定 2026-10-14・review-2 M4】AI（Opus）は、画面で作った定期実行（PO の分）も update/enable/disable してよい。PO の回答原文: 「n：PO が作った定期実行も、Opus の判断で止めたり変えたりできます。そのたびに、誰が作った定期実行を変えたかが記録に残ります。」
  - 実装: 監査行に、対象の作成者 `targetCreatedBy`（`"agent"` または `"ui"`。項目なしは `"ui"` と書く）を必ず入れる。S6 の単体試験に「画面で作った分を disable すると、監査行に targetCreatedBy:"ui" が残る」を1本足す。
- 対象外: 定期実行の削除（v0.7.0 以来の「対象外」を維持。止めるのは disable。R:3）、役割・作業場所・ブランチの変更（既存どおり不可。R:3）、予約（ac-reserve）の権限の変更、画面の変更（UI は触らない）。

## 4. 変更前 → 変更後
- 前: 定期実行の受け口は画面用の `/api/routines` だけ。サーバー秘密 `AGENT_CONSOLE_TOKEN` はセッションに渡らない（R:1, config.ts:217）。AI は登録できない。
- 後: AI 用の受け口を足す。通り道は ac-reserve と同じ（`dataDir/reserve-token` の Bearer、Origin ヘッダーがあれば403。R:1）。そのうえで次の3段で「Opus だけ」を守る。

### 4-1. 「Opus だけ」を守る3段
前提（正直な範囲）: 3段とも「担当が誤って・独断で登録すること」を止める誤用防止である。同じ Mac ユーザーの権限で動く、意図して隠すプロセスは止められない（review-1 M1）。

1. **役割の照合（サーバー側）**: `ac-routine` は `CLAUDE_CODE_SESSION_ID` を本文の `callerSessionId` に入れて送る。サーバーは正本である SessionManager のメモリ（`sessions.list()`）から `!exited && claudeSessionId === callerSessionId` のセッションを探し、その `roleId` が設定 `routineManagerRoles` に入っているかを見る（照合元をファイルの open-sessions.json にしない。http.ts:273、sessions.ts:330-335。review-1 M2）。一致する生きたセッションが複数あれば、すべての roleId が `routineManagerRoles` に入っているときだけ通す（1件でも違えば403。review-2 L4）。見つからない・役割が違う・`callerSessionId` が無いか UUID の形でないときは403（監査に denied、形が違えば callerSessionId は null。review-2 L5）。403 の文言に「起動直後は数秒〜数十秒待って再試行」（agentsPollMs=3000）を含める（claudeSessionId は hub.ts:404-410 の周期で入るため）。→ S3, S5
   - 実測（review-1）: サブエージェントの `CLAUDE_CODE_SESSION_ID` は、親の opus-designer の `claudeSessionId` と一致した。そのため、正しい Opus は照合を通る。
2. **サブエージェントの拒否（同期の guard hook）**: 新しい hook 本体 `hooks/ac-routine-guard.mjs` を、PreToolUse・matcher `Bash` の別の group として、**同期**（`async` を付けない）で入れる。
   - 判定: `tool_input.command` が命令の実行形 `/bin/ac-routine.mjs` を含み（置き場所 `dataDir/bin/`）、かつ入力に `agent_id` があれば、終了コード 2 と標準エラーの理由で拒否する。それ以外は終了コード 0 で、何も出さない。
   - 公式資料（code.claude.com/docs/en/hooks、review-1 が WebFetch で取得）の要点は次の3つ。
     - async の hook は拒否できない。
     - サブエージェントのツール呼び出しにも同じ hook が掛かり、入力に `agent_id` が入る。
     - タイムアウトすると通る（fail-open）。
   - 既存の `server/activity-hooks.ts`（HOOK_SPECS :24-34、buildHandler :49-51 は async 固定、isOwnHandler :53-57、checkHooks :177-202）は、activity-hook の1本だけを前提にしている。そこで spec に「handler のファイル名・async の有無・timeout・if」を持たせ、2本を扱えるように広げる。
   - settings.json への反映は、サーバーが自動では行わない。導入後に `node scripts/ac-hooks.mjs install` をもう一度実行する（README の既存の型）。実行するまで S4 は守られない。
   - 実行形に絞る理由（review-2 M1）: 文字列 `ac-routine` を広く止めると、サブエージェントによる実物の読み取り・試験・審査（`git show …hooks/ac-routine.mjs`、`vitest …ac-routine.test.ts`）まで止まる。PO 条件は「命令の実行を Opus が判断」なので、実行形を止めれば足りる。写して別名で打つすり抜けは R3 の範囲として受け入れる。
   - 影響: matcher が `Bash` なので、この Mac の Claude の全セッションの全 Bash 呼び出しで、node が1回起動する。第0段で遅延を実測し、1回あたり 150ms を超える場合は止めて PO に諮る。handler に `timeout: 5`（秒）を書く。書かないと既定の600秒になる（公式資料）。
   - 起動の絞り込み: 公式資料の `if` 項目（permission rule の書き方。best-effort）で `Bash(*/bin/ac-routine.mjs*)` 相当を付け、それ以外の Bash では node を起動させない。best-effort なので、本体の文字列判定も残す（二重）。
   → S4
3. **理由の必須化と監査記録**: `add` / `update` / `enable` / `disable` は `reason`（1〜200字、制御文字なし）が必須。
   - サーバーは `reason` を取り除いてから RoutineService に渡す。
   - `dataDir/routine-audit.jsonl`（0600、追記のみ）に `{at, action, outcome: "ok"|"denied", routineId?, targetCreatedBy?, callerSessionId, roleId?, reason?, error?}` を1行書く。`routineId` を持つ行（対象を解決できた行）では `targetCreatedBy` は必須。役割・callerSessionId による403など、対象を引く前の拒否の行には無い。記録するのは成功・403・上限の400だけ。入力の不備による400（routine not found・役割や作業場所の変更・形の誤り）は、権限や上限の判断ではないので記録しない（review-3 L4）。token は書かない。
   - 検査の規則は予約の measureNote と同じ（1〜200字・制御文字なし）。`CONTROL` は launch.ts:14 で export 済みなので、reservations.ts:6 と同じく import して使う。上限 200 は routines 側に同じ値の定数 `MAX_REASON = 200` を持つ（reservations.ts:25 の `MAX_MEASURE_NOTE` は非公開。reservations.ts は触らない。review-4 L1）。
   → S6

### 4-2. 命令の形（ac-reserve に揃える）
- `node "$HOME/Library/Application Support/agent-console/bin/ac-routine.mjs" list`（標準入力なし）
- `... add`（標準入力に JSON: name, roleId, cwd, branch?, weekdays, timeHHmm, promptText, enabled, reason）
- `... update <id>`（標準入力に JSON。全項目渡し。roleId・cwd・branch は変えられない＝routines.ts:64 の既存の決まり）
- `... enable <id>` / `... disable <id>`（標準入力に `{"reason": "..."}`）
- ac-reserve は `add` のときだけ標準入力を読む（ac-reserve.mjs:94-100）。ac-routine は add/update/enable/disable の4つで読む。id の形は ac-reserve と同じ `/^[A-Za-z0-9-]{1,64}$/`。
- 受け口: `GET/POST /api/agent/routines`、`PUT /api/agent/routines/:id`、`POST /api/agent/routines/:id/enabled`。通り道は ac-reserve と同じ（Origin があれば403 → reserve-token の Bearer → 本文。http.ts:320-329）。画面用の `/api/routines` は変えない。
- 作成者の記録: `Routine` に省略可能な `createdBy?: "agent"` を足す（review-1 H2 の (a)）。ac-routine からの作成だけが `"agent"` を入れる。画面からの作成と既存の行は、項目なし（＝人が作った分）。`routines.ts:63 create` に省略可能な第2引数を足すだけで、画面用の入口 http.ts:180 は触らない（review-2 L6）。routines.json の version は 2 のまま。旧版の parse は既知の項目だけを取り出すので読める（routines.ts:29。S7 の試験で固定）。
- 上限（予約の AI 分10件に揃える。review-2 M2・review-3 M2）: 検査するのは add と、対象の `createdBy === "agent"` を enable するとき・enabled:true へ update するときだけ。対象 id を除いた `enabled && createdBy === "agent"` の件数が10以上なら拒否する。対象が PO の分（createdBy 無し）なら上限を見ない（AI 分の数は変わらないため）。拒否は `export class RoutineLimitError extends SessionInputError {}`（routines.ts に新設）で投げ、本文は `"too many enabled agent routines"`。http.ts の `instanceof SessionInputError` に当たるので400のまま（予約の AI 分上限と同じ状態コード）。監査を書く側は `instanceof RoutineLimitError` で入力不備の400と見分ける（前例: http.ts:76 `BodyTooLargeError extends SessionInputError`。review-4 M1）。上限は AI の操作にだけ掛かり、人が画面で AI 分を有効にして11件以上になるのは妨げない。
- 失敗は終了コード1、理由は標準エラー、token は出さない（ac-reserve と同じ）。

## 5. 代替案と選択理由
- A 案（採用）: 役割照合＋同期 guard hook＋理由と監査＋createdBy。既存の受け口・token・検証・hook の仕組みを広げて使い、新しい秘密を増やさない。
- B 案: Opus の会話にだけ専用 token を渡す。不採用: サブエージェントは親の環境を引き継ぐ（AC_RESUME_ID まで引き継ぐことを review-1 が実測）ので、Sonnet も同じ token を持つ。
- C 案: AI は申請だけ出し、人が画面で承認する。不採用: PO 条件は「Opus が判断」。人の承認を足すと目的を外れる。
- D 案: 作成者を持たず、上限を「有効な定期実行の総数」にする。不採用: 画面で作った分まで AI の上限に数えることになり、画面の挙動が変わる。
- 参考（不採用）: 接続元のポートから pid を引いて子孫判定する（hub.ts:406-408）。自己申告ではなくなるが、サブエージェントも同じ子孫なので2段目の代わりにならず、複雑さに見合わない。

## 6. リスクと対処
- R1: claudeSessionId が入る前（起動直後）は、正しい Opus も403になる。安全側に倒れる。文言で再試行を促す。
- R2: 同期 guard が全 Bash を遅くする。第0段で実測し、150ms 超なら止める。timeout 5 秒で、超えたら通る（fail-open。公式仕様）。
- R3: すり抜け（文字列を隠す・自己申告の偽装）。拒否も含めて監査記録に残るので、後から分かる。悪意への対策ではない。
- R4: 暴走。AI 分の有効は10件まで。最終の歯止めは maxSessions=16（sessions.ts:15、超過は :273 で launchAndSend が失敗）と、既存の LaunchOutcome（full/not_ready）。roleId に opus-designer を指定した定期実行は、起動した Opus がさらに登録できる（再帰）。ただし10件上限で有界で、監査の roleId と callerSessionId で後から追える。
- R5: 親の Opus 本体の PreToolUse 入力に `agent_id` が付くと、Opus も拒否される（S1 が落ちる）。第0段で実測する。

## 7. 実装の第0段（実装前に Sonnet が実物で確かめる。満たさなければ止まって Opus へ）
- U1（済・review-1 実測）: claudeSessionId は hub.ts:404-410 が `claude agents --json` から入れる。サブエージェントの CLAUDE_CODE_SESSION_ID は親と同じ。
- U2: 親（ccopusgo で起動した Opus 本体）の Bash の PreToolUse 入力に `agent_id` が無いこと、サブエージェントの Bash には有ることを実測する（`ccopusgo` は `--agent` を使わないことを review-2 で確認済み）。
- U3（review-3 実測・更新）: origin/main は 658de91。package.json は 0.23.0 で、v0.23.0 のタグはまだ無い。最新タグは v0.22.0（PR #37）。本件の版は、マージ直前に `git tag` と package.json で空いている次の番号を確かめて決める（現時点の見込みは v0.24.0）。採番は「若い番号の PR を先に通す」の決まりに従う。
- U4: 手元の版（claude 2.1.299）で `if` の絞り込みが効くこと（ac-routine を含まない Bash では node が起動しない）と、node で起動する同期 hook 1回の遅延（10回の中央値）を実測する。`if` が効かなければ全 Bash で起動することになり、150ms の基準で判定する。

## 8. 変更するファイル（予定）
hooks/ac-routine.mjs, hooks/ac-routine.d.mts, hooks/ac-routine-guard.mjs, scripts/copy-board-command.mjs, scripts/ac-hooks.mjs（2本目の install/check）, server/activity-hooks.ts（spec の拡張）, server/activity-setup.ts, server/activity-start.ts, server/http.ts, server/routines.ts（createdBy・AI 分の上限・RoutineLimitError・MAX_REASON・呼び出し元を受ける入口）, server/routine-audit.ts（新規）, server/config.ts（routineManagerRoles。既定 `["opus-designer"]`、roles に無い id は起動時エラー）, tests/unit/helpers/harness.ts, tests/unit/ac-routine.test.ts（新規）, tests/unit/ac-routine-guard.test.ts（新規）, tests/unit/routines.test.ts, hook の本数（「9つ」等）に依存する既存の試験と文言, README.md, docs/CHANGELOG.md, package.json, package-lock.json, extension/manifest.json, playwright.config.ts, docs/handoff/ac-routine/{recon.md,design.md}。
触らない: src/（画面）、server/reservations.ts の権限、画面用 `/api/routines` の振る舞い。

## 9. 受入（導入後）
1. ac-update で本件の版を入れる（全セッションが手空きのとき）。続けて `node scripts/ac-hooks.mjs install` を実行し、settings.json に guard が入ったことを確かめる。
2. K15 を兼ねる: Opus が `ac-routine add` でテスト用の定期実行を登録する（約3分後の曜日・時刻）。新しいセッションが開いて指示が届くことを確かめたら、`disable` で止める。監査記録に add と disable の2行が残ることを確かめる。
3. サブエージェントから `ac-routine list` を打ち、guard に止められることを記録する。監査には残らない（サーバーまで届かないため）。止められた表示を保存する。
4. Bash の体感遅延を、第0段の実測値と並べて記録する。

## 10. 維持の仕組み
- S3, S4（判定関数）, S5, S6, S7, S8 の単体試験は、CI の vitest で毎回走る。
- 許可する役割は設定 `routineManagerRoles` の1か所だけ（SSOT）。
- `ac-hooks.mjs check` が guard の有無も報告する。

## 11. 戻し方
- 順番: 先に `node scripts/ac-hooks.mjs uninstall` で guard を外し、次に `scripts/ac-rollback.sh`（1つ前の版へ切り戻す既存の仕組み）で直前の版に戻す。直前の版の isOwnHandler（activity-hooks.ts:8 の suffix 固定）は guard を知らないため、この順にする。
- routines.json は読める（S7）。ただし直前の版で保存が1回でも走ると createdBy は全件消える（routines.ts:29,37）。再び本件の版に上げたときは、`routine-audit.jsonl` の `action:"add", outcome:"ok"` の routineId を見て、AI 分の扱いを PO が手で判断する（自動での復元はしない）。routine-audit.jsonl はそのまま残る。
- 外し忘れて本体だけが消えた場合: 公式資料によれば、起動できない hook は止めずに通す（通知は出る）。guard は fail-open のままにし、`onFailure: "block"` は使わない。理由は、全 Bash を止める方へ倒さないため（review-2 L1）。

## 12. 外部事例
- 該当なし。理由: 自作アプリ内の既存の仕組み（ac-reserve・activity hook）を広げる変更で、外部の数値は判断に効かない。

## 13. 審査の履歴
- review-1（Fable）: REVISE。H1（async の hook では拒否できない）、H2（AI 分の10件が数えられない）、M1〜M5、L1〜L4。すべて上に反映した。
- review-4（Fable）: REVISE（小。再審査不要、直した版を実装カードの根拠にしてよいとの判定）。M1（上限の400と入力不備の400の見分け→RoutineLimitError）、L1（CONTROL は export 済み・上限200は routines 側に定数）、L2（S6 の試験2本）、L3（本文の文言）を反映した。
- review-3（Fable）: REVISE（小）。M1（origin/main が進み版と行番号がずれた）、M2（PO の分の enable に上限が掛かる穴）、L1〜L5 を反映した。上限は ac-reserve に揃えて400とした。
- review-2（Fable）: REVISE（小）。M1（止め過ぎ→実行形に絞る）、M2（数え方の式）、M3（戻したとき createdBy が消える）、L1〜L7 を反映した。M4 は PO 決定済み（§3。PO の分も触ってよい、監査に作成者を残す）。

## 外部・過去事例の参照と我々への応用
該当なし。理由: 本件は agent-console 内の既存の仕組み（予約の ac-reserve、同 hook 機構、定期実行）を同じ型で広げるもので、外部の導入事例に頼る判断が無い。過去事例としては同リポジトリの ac-reserve（measureNote・AI 分10件上限・Origin/Bearer の通り道）を型として踏襲した（上記 §4-2、recon.md 参照）。
