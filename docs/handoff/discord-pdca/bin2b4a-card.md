# 便2b-4a 受け口の設定ファイルを書く台本と保守の鍵の登録（v0.54.0）作る係への指示書

- 設計: `docs/handoff/discord-pdca/design.md` §4-4（全停止の読み方）・§4-6（データの正本: 受け口の設定は「PO が `!` で打つ台本で書く」、保守 API の鍵は Keychain の `ops-api`）・§8 便2。前の便 `bin2b3e-card.md`
- 目的: ①PO が `!` で1回打つだけで `dataDir/discord-intake.config.json`（不具合のチャンネル1つ・testMode で有効）を書けるようにする。②保守 API の鍵を Keychain の `ops-api` に登録でき、サーバーが読めるようにする（便2b-4b の全停止の読み取りが使う）
- この便に入れないもの: 順番待ちを読んで窓を開くこと（便2b-4b）・全停止の読み取りの呼び出し（便2b-4b）・誤り報告のチャンネル（error-report）の設定・画面の変更・指示書（`~/.claude/prompts/` の2つ）の写し方の変更・ほかの役割の振る舞い
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `feat: discord intake config script and ops-api keychain item (v0.54.0)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・テストが今の形で書けない、のどれかに当たったら、推測で埋めず、そこで止めて「何が・どこで（file:line）・何を試したか」を報告する

## 調べた実物（行番号は origin/main bc42154 = v0.53.1）

- `server/discord-intake-config.ts`: 形 `IntakeChannelConfig` :6-17・`IntakeConfig` :19-23・ファイル名 `INTAKE_CONFIG_FILE` :25・id の形 `ID = /^\d{1,20}$/` :29・欄の許可 :44・bug は投稿者1件以上と種類1件以上 :61-64・`forbiddenBotIds` は1件以上 :75・bug を有効にできるのは testMode のときだけ :81・読む所 `readIntakeConfig` :86-100。**このファイルを書く部品は今どこにも無い**
- `server/keychain.ts`: `KEYCHAIN_SERVICE = "agent-console"` :7・`DiscordKeychainAccount = "discord-bot" | "discord-report-webhook"` :28・`readKeychainItem` :31-41（値も出力も文に入れない）
- `scripts/ac-discord-secret.sh`: 使い方の文 :3・:11・受ける項目の `case` :12-16（`discord-bot`・`discord-report-webhook` だけ。知らない項目 :15）・入力元（`AC_STUB_LOG` のときだけ `AC_SECRET_INPUT`）:18-23・空白と引用符を断る :33-43・保存 :45・保存の確かめ（`-w` なし）:47-48
- `scripts/lib/ac-common.sh`: 呼ぶ前に `AC_*` を消す（`AC_NODE` も消える）:9-12・dataDir は `AC_HOME`（既定 `$HOME/Library/Application Support/agent-console`）:14・`ac_trash` :80-（`AC_HOME` の中の物は `AC_HOME/$AC_MARKER` が無いと止まる :85）・`ac_resolve_node` :317-（`AC_NODE` が無ければ `command -v node`）・`AC_SECURITY` :19・`ac_log` :40・`ac_die` :44・`ac_guard_test_paths` :50-59（試験の印があるとき一時の置き場以外を断る）
- 保守 API（Sales Anchor `backend/app/routers/ops.py`。行番号は Sales Anchor の origin/main）: `GET /ops/control` は `require_ops_reader` :689（Bearer の鍵 `OPS_API_TOKEN` か super admin のログイン :115-130）、答えは `{"halt_all": bool, "changed_at", "changed_by", "reason"}` :690-706
- テスト: `tests/unit/ac-discord-secret.test.ts`（:24・:34・:42・:60・:66・:76 の6件）・`tests/unit/discord-intake-config.test.ts`

## 決めたこと

### A. 保守の鍵の項目（`server/keychain.ts`・`scripts/ac-discord-secret.sh`）

- `server/keychain.ts:28` の型を `"discord-bot" | "discord-report-webhook" | "ops-api"` にする。`readKeychainItem` の中身は変えない
- 新しい関数 `isValidOpsApiToken(v: string): boolean` を `server/discord-credentials.ts` に置く（形の決まりは今と同じくこの1か所。`isValidBotToken` :11 の隣）。決まり: 長さ 16〜512、文字は `[A-Za-z0-9._~+/=-]` だけ。それ以外は false
- `server/discord-credentials.ts:27` の `load` の引数 `account` の型を `DiscordKeychainAccount`（keychain.ts から import）にする。中身は変えない
- 新しい関数 `loadOpsApiToken(securityBin, read = readKeychainItem): Promise<{ value: string | null; state: CredentialState }>`。今の `load` :27 を `"ops-api"` と `isValidOpsApiToken` で呼ぶだけ。`loadDiscordCredentials` :38-42 の答えの形は変えない（便2b-4b がこの関数を別に呼ぶ）
- `scripts/ac-discord-secret.sh` の `case` :12-16 の :14 の下に1行足す: `ops-api) prompt="保守 API の鍵（OPS_API_TOKEN）を入力してください" ;;`。使い方の文（:3・:11）と知らない項目の文（:15）に `ops-api` を足す。保存・確かめの行は変えない
- 値を `~/.claude-access.env` から読んで写す処理は作らない（PO が端末で打つ）

### B. 設定ファイルを書く台本（新しい `scripts/ac-discord-intake-config.sh`）

- 使い方: `bash scripts/ac-discord-intake-config.sh`（引数なし。あれば `ac_die`）。`ac-discord-secret.sh` と同じく `source scripts/lib/ac-common.sh`・`ac_guard_test_paths`・`set -euo pipefail`
- 入力元: `AC_STUB_LOG` があるときだけ `AC_CONFIG_INPUT`（1行1項目のファイル）、ないときは必ず `/dev/tty`（ac-discord-secret.sh :18-23 と同じ形）。入力元は台本の初めに `exec 3<"$src"` で**1回だけ**開き、問いはすべて `read -r -u 3` で読む（毎回開き直すと1行目しか読めない）
- 打った値は端末に普通に表示される（id と呼び名は秘密ではない。`read -s` は使わない）。ただし `ac_log`・`ac_die` の文には値を入れない
- 既にファイルがあるかの確かめと上書きの問い（下の「既にファイルがあるとき」）は、5つの問いより**前**に行う。試験の入力ファイルでは、既にあるときは1行目が上書きの答え、2〜6行目が5つの答え
- 聞く順（5つ。どれも Enter で確定）:
  1. サーバーの id（`guildId`）
  2. 不具合のチャンネルの id（`channelId`）
  3. 投稿してよい人の Discord の id（`allowedAuthors[0].id`）
  4. その人の呼び名（`allowedAuthors[0].name`。1〜40字・改行なし・`"` と `\` なし）
  5. 本番のボットの id（`forbiddenBotIds[0]`。§4-1 の「本番ボットの id と同じなら止める」の比べる相手）
- 1〜3 と 5 は `^[0-9]{1,20}$` に合わなければ、どの欄かだけを言って `ac_die`（値は出さない）。2 と 5 が同じ、3 と 5 が同じも `ac_die`
- 書く中身は固定の形で、上の値だけを入れる:
  ```json
  { "testMode": true, "forbiddenBotIds": ["<5>"], "channels": [ { "kind": "bug", "enabled": true, "guildId": "<1>", "channelId": "<2>", "allowedAuthors": [ { "id": "<3>", "name": "<4>" } ], "allowedMessageTypes": [0, 19] } ] }
  ```
  `allowedMessageTypes` は `[0, 19]`（通常の投稿と返信。設計 §4-1）で固定。聞かない
- 書き方: JSON は shell の文字列つなぎで作らない。`node="$(ac_resolve_node)"`（ac-common.sh :317。本番では `AC_NODE` は :9-12 で消えているので `"$AC_NODE"` を直接使わない）の node に、値を**環境変数**で渡し、`JSON.stringify` で組み立てて `<AC_HOME>/discord-intake.config.json.tmp.<pid>` に mode 0600 で書き、`fs.renameSync` で置き換える。値を node の引数（argv）には入れない
- 既にファイルがあるとき: 中身を読まず、上書きしてよいかを1問聞く（`上書きしますか（yes と打つと上書き）`）。`yes` 以外は `ac_die "取り消しました（書いていません）"`。上書きする前に今のファイルを `ac_trash <file> intake-config` で Trash へ移す（消さない。`kind` は `intake-config`）
- 書いたあと: `node --experimental-strip-types` で `server/discord-intake-config.ts` の `readIntakeConfig` を呼ぶのはしない（入れた版のサーバーの中身と台本の版がずれるため）。代わりに、台本の中の node で同じ決まり（id の形・bug は testMode・種類の重なりなし）を確かめ、合わなければ書いたファイルを Trash へ移して `ac_die`
- 終わりの文: `ac_log "受け口の設定を書きました（値は表示しません）。サーバーを起こし直すと読みます: bash scripts/ac-update.sh <今の版>"`。サーバーの起こし直しは台本ではしない
- `AC_HOME/$AC_MARKER`（`.agent-console-home`）が普通のファイルとして無い（未導入）なら、何も聞かずに `ac_die "agent-console が入っていません"`（`ac_trash` :85 もこの印を要るため）

### C. テスト

- `tests/unit/ac-discord-secret.test.ts` に1件: `ops-api` を受け、`security -i` の標準入力にだけ値が渡り、引数・出力に値が出ない（:24 と同じ見方）
- `tests/unit/discord-credentials.test.ts` に: `isValidOpsApiToken` の通る形3つ・通らない形4つ（空・15字・513字・空白入り）、`loadOpsApiToken` が読めないとき `unreadable`・形違いで `invalid`・値を例外の文に入れない
- 新しい `tests/unit/ac-discord-intake-config.test.ts`（`AC_STUB_LOG`・一時の `AC_HOME`・`AC_CONFIG_INPUT` で。試験の中で `AC_HOME/.agent-console-home` を作る。手伝い `tests/unit/helpers/ac-env.ts` はこの印を作らない）:
  1. 正しい5行で、書いたファイルを `readIntakeConfig` で読むと `ok: true`・testMode true・bug が有効・types `[0,19]`
  2. ファイルの mode が 0600
  3. id の形違い（各欄1つずつ）で終わりが 0 以外・ファイルが無い・出力に打った値が無い
  4. 2 と 5 が同じで止まる
  5. 既にあるとき `yes` 以外で止まり、元のファイルが残る。`yes` で元のファイルが Trash の置き場（試験の `AC_TRASH`）に移る
  6. `AC_STUB_LOG` が無いとき `AC_CONFIG_INPUT` を読まない（`ac-discord-secret.test.ts:76` と同じ見方）
  7. 印 `.agent-console-home` が無いとき、何も書かず 0 以外で終わる
  8. `AC_NODE` を消した環境（`env -u AC_NODE`）でも 1 と同じく書ける（`ac_resolve_node` を使っている確かめ）
- Mac で試験を回さない。確かめは GitHub の CI（ubuntu・macOS）で行う

### D. 版と記録

- `package.json`・`package-lock.json`（ルートの version の2か所）・`extension/manifest.json` を `0.54.0` にする
- `docs/CHANGELOG.md` の先頭の行の上に1行: `- 0.54.0 Discord の受け口の設定ファイルを書く台本 scripts/ac-discord-intake-config.sh（PO が ! で打つ。不具合のチャンネル1つを testMode で有効にする）と、保守 API の鍵の Keychain の項目 ops-api（scripts/ac-discord-secret.sh ops-api）を足した。サーバーの動きは変わらない。戻し方 bash scripts/ac-update.sh v0.53.1。設計は docs/handoff/discord-pdca/design.md §4-4・§4-6`

## 確かめ（作る係が PR の前に行う）

- `npm run typecheck`・`npm run lint`・`npx vitest run tests/unit/ac-discord-secret.test.ts tests/unit/discord-credentials.test.ts tests/unit/ac-discord-intake-config.test.ts tests/unit/discord-intake-config.test.ts` をクラウドの作業場所で回し、生の出力をファイルに残して全文を読む
- 差分に家の道（`/Users/`）・id・URL・秘密の値が入っていないことを `git diff origin/main` で確かめる（公開リポジトリ）
- PR 本文に: 変えたファイルの一覧・試験の数・戻し方・「サーバーの動きは変わらない」
