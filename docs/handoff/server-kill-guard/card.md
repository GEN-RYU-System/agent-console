# 実装カード: server-kill-guard（v0.42.0）

設計: [design.md](design.md)（K1〜K7・§3）。根拠: [recon.md](recon.md)。PO 実装承認: 2026-10-16 チャット「y」（設計 PR #61 の後）。
作業場所: `/Users/tanizawashingo/agent-console-wt/server-kill-guard`（ブランチ `release/server-kill-guard`、origin/main c67e90a 起点。設計文書のコミット 2dce8b3 の上に積む）。

## 守ること
- 触ってよいのは §変更 のファイルだけ。`hooks/ac-routine-guard.mjs`・`server/index.ts`・`scripts/ac-*.sh`・plist・`playwright.config.ts` は触らない
- Bash の命令に `Application Support/agent-console` の文字列を書かない（既存 guard に止められる。止められたら言い換えず BLOCKED: で戻る）。試験の中で dataDir の文字列が要るときは ac-routine-guard.test.ts:104 と同じく分割して組み立てる
- `pkill` `killall` `kill` `launchctl` を Bash で実行しない（文字列として試験ファイルに書くのは可）。導入（ac-update・ac-hooks install）は行わない（Opus が行う）
- 迷ったら全停止して `NEEDS_DECISION:` で戻る。報告は DONE / BLOCKED: / NEEDS_DECISION: で始め、事実は生出力の保存パスを添える

## 変更
### 1. 新規 `hooks/server-kill-guard.mjs`
`hooks/ac-routine-guard.mjs` と同じ骨格（先頭コメントに設計 docs/handoff/server-kill-guard/design.md §3-1 を書く・`judge(input)` と `DENY_MESSAGE` を export・`isMain()` のときだけ stdin を読む・通すときは完全無出力・入力が読めなければ通す）。

- `agent_id` は見ない（K3）。`tool_input.command` が文字列でなければ `{ code: 0, stderr: "" }`
- 分割: command を `;` `&&` `||` `|` 改行 `$(` `` ` `` `(` `)` で部分に分ける
- 先頭語: 各部分を空白で語に分け、先頭から `NAME=値` の形・`sudo` `nohup` `env` `exec` `command` `xargs`・`timeout` とその次の 1 語・`-` で始まる語（xargs の後のオプション）を飛ばした最初の語。引用符（`"` `'`）は語の両端から外す
- kill 系の部分 = 先頭語が `kill` `pkill` `killall`
- 保護語の判定 `hasProtected(text)`: `dist-server` を含む、`server/index.js` を含む、`agent-console` を含む、または単独の語 `node`（正規表現 `(^|[^A-Za-z0-9_./-])node($|[^A-Za-z0-9_./-])`）
- 拒否条件（どれか 1 つ）:
  - R1 先頭語が `pkill` か `killall` の部分があり、その部分が `hasProtected`
  - R2 kill 系の部分があり、先頭語が `pgrep` の部分のどれかが `hasProtected`
  - R3 kill 系の部分があり、先頭語が `lsof` の部分のどれかが `:4319` を含む（`tcp:4319` も含まれる）。`PROD_PORT = "4319"` を定数で持つ
  - R4 先頭語が `launchctl` の部分で、次の語が `kill` `stop` `bootout` `remove` `disable` のどれかで、その部分が `local.agent-console.server` を含む
- `DENY_MESSAGE = "本番の agent-console を止める形です。試験サーバーは番号で止めてください（例: lsof -ti tcp:4329 | xargs kill）"`（80 字以内を試験で確かめる。超えたら例の部分を `lsof -ti tcp:4329|xargs kill` に詰める）

### 2. `server/activity-hooks.ts`
- :10 の後に `export const SERVER_KILL_GUARD_HOOK_FILE = "server-kill-guard.mjs";` と `export const SERVER_KILL_GUARD_IFS: readonly string[] = ["Bash(*kill*)", "Bash(*launchctl*)"];`（コメント: 設計 server-kill-guard §3-2）
- :25 `OWN_HOOK_SUFFIXES` に `` `/hooks/${SERVER_KILL_GUARD_HOOK_FILE}` `` を足す。:24 のコメントを 4 種に
- :46 のコメントの本数を 19 本に
- :63 の次の行に `...SERVER_KILL_GUARD_IFS.map((rule): HookSpec => ({ event: "PreToolUse", matcher: "Bash", file: SERVER_KILL_GUARD_HOOK_FILE, async: false, timeout: 5, if: rule })),`（コメント 1 行: 本番サーバーを名前で止める命令を、担当・本体とも拒否する同期の guard。async を付けると拒否できない）
- `checkHooks` が欠けを `PreToolUse(<file> <rule>)` で報告する仕組みに新しい handler が乗ることを確かめる（乗らなければ NEEDS_DECISION:）

### 3. `server/activity-setup.ts`
:17-25 の `GUARD_FILE_NAME` / `guardPathIn` / `installGuardFile` と同じ形で `SERVER_KILL_GUARD_FILE_NAME` / `serverKillGuardPathIn` / `installServerKillGuardFile` を足す。

### 4. 写す処理の呼び出し
- `scripts/ac-hooks.mjs:68`（`installGuardFile(...)` の次）に `installServerKillGuardFile(path.join(root, "hooks"), dataDir);`。import（:15）に足す。:76 の報告文に「本番停止の guard hook」を足す
- `server/activity-start.ts:49`（`installGuardFile(...)` の次）に同じ呼び出し。import（:4）に足す

### 5. 試験
- 新規 `tests/unit/server-kill-guard.test.ts`（`tests/unit/ac-routine-guard.test.ts` の構成に合わせる）:
  - K1 の 16 形それぞれが `{ code: 2, stderr: DENY_MESSAGE + "\n" }`（`it.each`）
  - K2 の 9 形それぞれが `{ code: 0, stderr: "" }`
  - K3 agent_id あり・なしで同じ結果
  - K4 `undefined` `null` `{}` `{ tool_input: {} }` `{ tool_input: { command: 5 } }` と、実スクリプトに `"not json"` `""` を流して終了 0・無出力
  - K7 `DENY_MESSAGE.length <= 80`、改行を含まない
  - 実スクリプト（spawnSync）で拒否 1 形・通過 1 形の終了コードと出力
- `tests/unit/activity-hooks.test.ts`: :21 のコメントと総数を 19 に、:86・:296 の試験名と期待値を新しい 2 本込みに直す（期待の配列に `SERVER_KILL_GUARD_IFS` 由来の 2 行を足す）

### 6. 文書・版
- `package.json` version を `0.42.0`
- `docs/CHANGELOG.md` 先頭に 0.42.0 の 1 行（何を止め何を通すか・hook が 19 本・**更新後に `node scripts/ac-hooks.mjs install` の再実行が要る**・戻し方 `bash scripts/ac-update.sh v0.41.0`・設計 docs/handoff/server-kill-guard/design.md）
- `README.md` の guard の節（:53 付近）の後に「本番サーバーの停止の見張り（v0.42.0）」を 3〜5 行。限界（design §6 R1）を「限界」節（:56 付近）に 1 行

## 完了の確認（担当が実行し、生出力を /tmp/CC報告ファイル/server-kill-guard/ に保存）
1. `npm run typecheck`
2. `npm run lint`
3. `npx vitest run tests/unit/server-kill-guard.test.ts tests/unit/activity-hooks.test.ts tests/unit/ac-routine-guard.test.ts`
4. `npm test`（全体。main でも落ちている `tests/unit/auth.test.ts` の "revoked sessions are gone after reload" が落ちたら、その 1 件だけなら報告に記して続行。ほかが落ちたら BLOCKED:）
5. `git diff --stat origin/main...HEAD` が §変更 のファイルだけ
6. コミット（`feat: 本番サーバーを名前で止める命令を拒否する guard（v0.42.0）`）して push。PR は作らない（Opus が #61 に積む）

## 想定分岐
- `if` の `Bash(*kill*)` が `pkill`・`killall` にも当たることは文字列の包含で成り立つ。試験は判定関数で行うので `if` の実効は導入後に Opus が実機で確かめる（K6）
- 既存試験が handler の順番に依存して落ちたら、新しい 2 本を `HOOK_SPECS` の ac-routine-guard の直後に置いた形に試験を合わせる（順番を変えて回避しない）

## 追補（2026-10-16 Opus）: main が先に v0.41.0 を使ったための版上げ
PR #61 が main（a0b6db7、#62 ファイル検索が v0.41.0）と衝突。次で直す。
- `git merge origin/main`（rebase・force push はしない）。衝突は README.md・docs/CHANGELOG.md・package.json・package-lock.json・extension/manifest.json の想定。main 側の 0.41.0 の記載は残し、本件を **0.42.0** として上に足す
- 本件の版表記を 0.41.0 → 0.42.0 に（package.json・package-lock.json・manifest.json・CHANGELOG・README の「本番サーバーの停止の見張り（v0.41.0）」・hooks/server-kill-guard.mjs や試験のコメントにあれば同様）。CHANGELOG の戻し方は `bash scripts/ac-update.sh v0.41.0`
- `scripts/ac-hooks.mjs` 冒頭コメントの本数（「3 本」「17 本」）を本件込みの数に直す（server-kill-guard を含めた種類数と 19 本）
- design.md・card.md・recon.md の v0.41.0 表記は Opus が直す（担当は触らない）
- 完了の確認 1〜5 をやり直し、生出力を /tmp/CC報告ファイル/server-kill-guard/merge-*.txt に保存。コミット `chore: main を取り込み v0.42.0 に版上げ` で push
