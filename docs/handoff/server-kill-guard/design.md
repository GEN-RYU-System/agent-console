# 設計: 本番サーバーを名前で止める命令の見張り（server-kill-guard）

状態: 設計案（Opus 作成・自己審査済み）。PO の方針決定「再発防止として、この種の命令を見張りで止める設計に進める」（2026-10-16 チャット「y」）に基づく。実装は未着手。

根拠は [recon.md](recon.md)（F1〜F13）。

## 0. 目的
試験や作業の都合で打たれた「名前一致でプロセスを止める命令」が、本番の agent-console サーバー（127.0.0.1:4319）まで止めてしまう事故（recon F4・F5）をなくす。止めようとした時点で命令を拒否し、試験サーバーの安全な止め方を本人に返す。

水準は ac-hardening と同じ A（うっかり防止）。悪意のある迂回は対象外（§6）。

## 1. 変更前と変更後
| | 変更前 | 変更後 |
|---|---|---|
| 担当・Opus 本体が `pkill -f "dist-server/server/index.js"` を打つ | 通る。本番も止まる（F4） | hook が拒否。本番は動いたまま |
| `lsof -ti tcp:4329 \| xargs kill`（試験サーバーを番号で止める） | 通る | 通る（変わらない） |
| `tmux -L agent-console kill-session -t …` | 通る | 通る（変わらない） |
| `bash scripts/ac-update.sh` 等の導入手順（中で launchctl を使う） | 通る | 通る（命令の文字列に launchctl の停止形が出ないため） |

## 2. 成功条件（○×で判定する）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 次の形はすべて終了コード 2・標準エラー 1 行で拒否される: `pkill -f "dist-server/server/index.js"`、`pkill -f dist-server`、`pkill -f "server/index.js"`、`pkill node`、`pkill -f node`、`killall node`、`killall -9 node`、`pkill -f agent-console`、`kill $(pgrep -f dist-server/server/index.js)`、`pgrep -f "server/index.js" \| xargs kill`、`kill $(lsof -ti tcp:4319)`、`lsof -ti :4319 \| xargs kill -9`、`launchctl kill SIGTERM gui/501/local.agent-console.server`、`launchctl stop local.agent-console.server`、`launchctl bootout gui/501/local.agent-console.server`、`cd x && pkill -f "dist-server/server/index.js" 2>/dev/null; sleep 1` | 単体試験（判定関数、1 形 1 本） |
| K2 | 次の形はすべて終了コード 0・無出力で通る: `lsof -ti tcp:4329 \| xargs kill`、`kill $(lsof -ti tcp:4330)`、`pkill -f playwright`、`tmux -L agent-console kill-session -t =ac-x`、`launchctl kickstart -k gui/501/local.agent-console.server`、`launchctl print gui/501/local.agent-console.server`、`grep -n "pkill" docs/handoff/server-kill-guard/design.md`、`git log --oneline`、`bash scripts/ac-update.sh v0.42.0` | 単体試験 |
| K3 | 判定は `agent_id` の有無に関係なく働く（担当も Opus 本体も拒否される） | 単体試験（agent_id あり・なし各 1 本） |
| K4 | 入力が読めない（JSON でない・command が無い）ときは通す（fail-open） | 単体試験 |
| K5 | `node scripts/ac-hooks.mjs install` 後、`~/.claude/settings.json` に本 hook の handler が 2 本（`if` が `Bash(*kill*)` と `Bash(*launchctl*)`）足され、2 回実行しても増えない。総数は 17 → 19 本 | 既存の activity-hooks 単体試験の本数を更新・実機で install 後に数える |
| K6 | 導入後の実機で、Opus 本体から `pkill -f "dist-server/server/index.js-NOMATCH-PROBE"` を打つと拒否され、その前後で 127.0.0.1:4319 の /healthz が応答し続ける | 実機 1 回（拒否文言と /healthz の HTTP コードを記録） |
| K7 | 拒否文言は 1 行・80 字以内で、試験サーバーの止め方（番号で止める例）を含む | 単体試験 |

## 3. 方式
### 3-1. 新しい同期 hook `hooks/server-kill-guard.mjs`
ac-routine-guard と同じ作り（判定関数 `judge(input)` を export、`isMain()` のときだけ stdin を読む、通すときは完全無出力）。別ファイルにする理由: ac-routine-guard は「担当だけ」を対象にする設計（recon F10）で、本件は担当・本体の両方が対象。混ぜると条件が読みにくくなる。

判定（`tool_input.command` の文字列に対して。どれか 1 つで拒否）:
- R1 区切り（`;` `&&` `||` `|` 改行 `$(` `` ` ``）で分けた各部分の先頭語（前置きの `sudo` `nohup` `env` `exec` `command` `timeout <n>` `xargs` と、`NAME=値` を飛ばした後）が `pkill` か `killall` で、その部分に保護語のどれかを含む
- R2 命令全体に kill 系の語（R1 の先頭語判定で `kill`・`pkill`・`killall`）があり、かつ `pgrep` の部分が保護語を含む
- R3 命令全体に kill 系の語があり、かつ `lsof` の部分が本番ポート（`:4319` または `tcp:4319`）を含む
- R4 先頭語が `launchctl` で、第 1 引数が `kill` `stop` `bootout` `remove` `disable` のどれかで、`local.agent-console.server` を含む

保護語: `dist-server`、`server/index.js`、`agent-console`、単独の語としての `node`（前後が英数字・`-`・`.`・`/` でない）。

- `kickstart`（起こし直し）と `print` は止めない（K2）
- 本番ポート 4319 は定数に持つ（`agent-console.config.json` を読まない。hook は速さと fail-open を優先）

拒否文言（1 行）: `本番の agent-console を止める形です。試験サーバーは番号で止めてください（例: lsof -ti tcp:4329 | xargs kill）`

### 3-2. 登録
`server/activity-hooks.ts` に `SERVER_KILL_GUARD_HOOK_FILE` と `SERVER_KILL_GUARD_IFS = ["Bash(*kill*)", "Bash(*launchctl*)"]` を足し、`HOOK_SPECS` に `{ event: "PreToolUse", matcher: "Bash", file, async: false, timeout: 5, if }` を 2 本足す。`OWN_HOOK_SUFFIXES` に足す。`server/activity-setup.ts` の写し先に足す（ac-routine-guard と同じ手順）。

### 3-3. 文書
README の guard 節に「本番サーバーの停止の見張り（v0.42.0）」と「導入後に `node scripts/ac-hooks.mjs install` をもう一度」を足す。限界（§6 R1・R2）も書く。CHANGELOG に v0.42.0。

## 4. 影響範囲（実装カードで file:line まで詰める）
- 新規: `hooks/server-kill-guard.mjs`、`tests/unit/server-kill-guard.test.ts`
- 変更: `server/activity-hooks.ts`（:10-19 付近・:46 のコメント・:63 の後）、`server/activity-setup.ts`（:17-25 付近）、`scripts/ac-hooks.mjs`（install で本体を dataDir/hooks/ へ写す段・:76 の報告文）、activity-hooks の本数を数える既存の単体試験、`README.md`、`docs/CHANGELOG.md`、`package.json`（version 0.42.0）
- 触らない: `hooks/ac-routine-guard.mjs`、`server/index.ts`、`scripts/ac-*.sh`、plist、`playwright.config.ts`

## 5. 代替案と選ばなかった理由
| 案 | 選ばなかった理由 |
|---|---|
| plist を `KeepAlive=true` にして落ちても起き直す | 導入手順の `ac_stop_server_and_wait`（`scripts/lib/ac-common.sh:226-236`）は pid が消えるまで待つ作りで、自動再起動と競合する。今回は SIGTERM による終了コード 0 なので `KeepAlive.SuccessfulExit=false` でも起き直らない。止める元を断つ方が先（1 回に 1 変更） |
| 試験サーバーの起動引数を変えて名前を本番と分ける | 名前が違っても `pkill node` `killall node` は防げない。担当の書き方次第で再発する |
| 担当への指示文（カード・AGENTS.md）で禁止するだけ | 今回の担当も「本番と分離」と考えたうえで打っていた（F6）。文書だけでは止まらない |
| ac-routine-guard に足す | 対象（担当だけ／全員）が違う（§3-1） |

## 6. リスクと対処
- R1 迂回できる（引用符の分割、変数経由、`kill <pid>` の番号直書き、スクリプトファイルに書いて実行）。水準 A のため止めない。README の限界に書く
- R2 誤って止める（例: 文字列 `node` を含む別の pkill）。拒否文言で代わりの形を示す。K2 に通す形を固定し、誤拒否が出たら形を K2 に足して直す
- R3 hook が起動しない・遅い。`if` で kill / launchctl を含む Bash だけに絞る。timeout 5 秒。読めない入力は通す
- R4 install し直すまで効かない。導入手順の最後に install の再実行を README とリリース報告に書く。点検（activity の「記録の仕組みが外れています」）は handler の欠けで出る既存の仕組みに乗る

## 7. 維持の仕組み
- 判定は単体試験（K1〜K4・K7）で CI（`.github/workflows/ci.yml` の `npm test`）が毎回確かめる
- 登録の欠けは既存の点検（handler が足りないと右欄に「記録の仕組みが外れています」）で見える
- 担当: agent-console の保守（Opus 設計・Sonnet 実装）

## 8. 戻し方
前の版へ `scripts/ac-rollback.sh` で戻し、`node scripts/ac-hooks.mjs install` を再実行する（前の版の HOOK_SPECS に無い handler は自分の handler として外れる想定。実装カードで実測して確かめる）。全部外すなら `node scripts/ac-hooks.mjs uninstall`（`scripts/ac-hooks.mjs:5`）。設定の控え `settings.json.ac-backup-*` からも戻せる。

## 9. 外部事例
不要。手元の道具（Claude Code の PreToolUse hook）の中の判定で、既存の ac-routine-guard と同じ型を使う。外部の数値で裏付ける種類の判断ではない。

## 10. 自己審査（Architect 役・同一 AI による）
判定: APPROVE（設計合格。ただし PO の実装承認とは別）
- 既存との整合: ac-routine-guard と同じ作り（判定関数・fail-open・同期・`if` で絞る）。登録の関数（activity-hooks.ts:63）の型に乗る
- 根拠: 停止の時刻一致（F1・F4・F5）と終了経路（F3）で原因は特定済み
- 検証可能性: K1〜K5・K7 は単体試験、K6 は実機 1 回で○×が出る
- 未解決: なし（09:56:48 の起き直し経路は設計に影響しない）
