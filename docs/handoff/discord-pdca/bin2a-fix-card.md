# 便2a の直し（v0.46.1）作る係への指示書

- 元の指示書: `docs/handoff/discord-pdca/bin2a-card.md`（以下「2a の指示書」）。実装は PR #76（merge a8a0836、v0.46.0）
- この直しの出どころ: #76 の審査で見つかった指摘 L3・L4・L5・L6（審査の生出力は /tmp/CC報告ファイル/discord-pdca-bin2/31-impl2a/review-out.txt）。L1・L2 は設計者が追認済み（#76 のコメント）で、この便では触らない
- 受け口を有効にする便 2b より前に入れる。設定ファイルが無い今の本番の動きは変わらない

## 決めたこと
- **id の形を確かめる（L4）**: 受け口は投稿の `id` を `BigInt` にして比べる（`server/discord-intake.ts:354`, `:362`, `:368`, `:375`）。今は `toMessage`（`server/discord-api.ts:38-53`）が `id` を文字列かどうかしか見ていないので、数字でない id が返ると `BigInt` の例外になる。その例外は `round` の catch（`server/discord-intake.ts:269-271`）で握りつぶされ、`lastError` も失敗の数も変わらないまま「reading」と出続ける。そこで `toMessage` で `id` と `channel_id` が `/^\d{1,20}$/`（snowflake は 64 ビットの数で最大20桁）に合わなければ `null` を返す（＝その一覧は `badJson`）。`badJson` は既存の扱い（`fail` で `lastError: "badJson"`・失敗の数 +1、次の周回でやり直し）に乗る
- **思わぬ例外も見えるようにする（L4 の守り）**: `round` の catch で `lastError = "internal"`、`consecutiveFailures++` にする。console に出す文は今の固定の文のまま（例外の文は出さない）。知らせは送らない（毎周回の知らせが続くのを防ぐ。状態は便 2c の画面で見る）。`state` は `running` のまま、次の周回は今どおり張る
- **受け口が止まっているときのチャンネルの表示（L6）**: `channels[].status` に `"intakeStopped"` を足す。受け口の `state` が `running` でないとき、`kind: "bug"` で `enabled: true` のチャンネルは、そのチャンネル自身が止まっていなければ（`guildMismatch`・`forbidden`・`notFound` でなければ）`intakeStopped` と出す。今は秘密が読めずに止まったときに `waitingGuildCheck`（`server/discord-intake.ts:244`）と出て、確かめ待ちに見えてしまう。`401` で止まったあとに `reading` と出るのも同じ理由で直る
- **型の逃げ道を消す（L5）**: `haltChannel` の引数の型を `Extract<ApiResult<unknown>, { kind: "forbidden" | "notFound" }>` にして、`errorCode(res as never)`（`server/discord-intake.ts:342`）を `errorCode(res)` にする。動きは変えない
- **試験の補強（L3）**: 下の「試験」の4つ。ただし審査が挙げた「台本が保存した行の `-a <account>` を確かめる」はこの便でやらない。試験の道具（`tests/unit/helpers/ac-env.ts:93-99` の security の偽物）は `-i` の標準入力から値だけを保存し、account を残さないので、確かめるには共通の道具を変える必要があるため。account は既存の試験が `find-generic-password -s agent-console -a discord-bot` で確かめている（`tests/unit/ac-discord-secret.test.ts:32`）

## 守ること
- 2a の指示書の「守ること」をそのまま守る（id・トークン・URL・本文を試験の名前・ログ・状態・文書に入れない。作り物の id は `1000000000000000` で始まる今の作り物を使う）
- 下に書いた変更だけをする。ほかの振る舞い・文・既存の試験の期待は変えない（`channelStatus` の並びを変えることで既存の試験の期待が変わる場合は、変えずに止まって報告する）
- `tests/unit/helpers/harness.ts`・`tests/unit/helpers/ac-env.ts` は変えない

## 変更
### 1. `server/discord-api.ts`
- `toMessage` の最初の検査に、`id` と `channel_id` が `/^\d{1,20}$/` に合うことを足す。正規表現は1つの定数（例 `SNOWFLAKE_RE`）にする。`author.id`・`webhook_id`・`getChannel` の `guild_id`・`getCurrentUser` の `id` は `BigInt` にしないので変えない

### 2. `server/discord-intake.ts`
- `DiscordIntakeStatus` の `channels[].status` の型に `"intakeStopped"` を足す（型の正本はこのファイル。`server/http.ts` などに別の写しを作らない）
- `channelStatus` を次の順にする:
  1. `kind === "error-report"` → `notReady`
  2. `!enabled` → `disabled`
  3. `rt !== undefined && rt.halted !== null` → `rt.halted`
  4. `this.state !== "running"` → `intakeStopped`
  5. `rt === undefined || !rt.guildConfirmed` → `waitingGuildCheck`
  6. 状態ファイルにそのチャンネルが無い → `waitingFirstRead`、ある → `reading`
- `round` の catch: `this.lastError = "internal"; this.consecutiveFailures++;` を足す（`console.error("discord-intake: round failed")` は残す。`if (this.stopped)` の判定は今のまま catch の後）
- `haltChannel` の型（上の「決めたこと」）
- `lastError` に入る値の説明（コメントや型の注記があれば）に `"internal"` を足す

### 3. 版・文書
- 版を 0.46.1 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`CHANGELOG.md` に1行（何を直したか・戻し方 `bash scripts/ac-update.sh v0.46.0`）
- 2a の指示書は書き換えない（この指示書が追記の正本）

## 試験（偽の時計・偽のタイマー・偽の fetch・偽の security。本物の Keychain と Discord は使わない）
- `tests/unit/discord-api.test.ts`: `listMessagesAfter` で、`id` が `"12a"`・`""`・21桁、`channel_id` が `"x"` の要素が1つでもあれば `{ ok: false, kind: "failed", reason: "badJson" }`。20桁の数字の id は通る
- `tests/unit/discord-intake.test.ts`:
  - I19（新）`listMessagesAfter` が例外を投げる（偽の api が reject）→ `lastError: "internal"`、`consecutiveFailures: 1`、`state: "running"`、次の周回のタイマーが1つ張られ、知らせ0件。次の周回で読めたら `consecutiveFailures: 0`
  - I20（新）チャンネルの表示: 秘密が `unreadable` で止まったとき、有効な `bug` チャンネルは `intakeStopped`、無効なものは `disabled`、`error-report` は `notReady`。401 で止まったあと、読んでいたチャンネルは `intakeStopped`、その前に `forbidden` で止めていたチャンネルは `forbidden` のまま
  - I12 の「403 でそのチャンネルだけ止まる」に足す: 次の周回で、止めたチャンネルへのメッセージの読み取りの通信が0回増え、ほかのチャンネルは1回増える。知らせは1件のまま
  - I18 の1つ目に足す: `stop()` をもう1回呼んでも `notifier.stops` は 1 のまま、`clearTimer` の回数も増えない
- `tests/unit/ac-discord-secret.test.ts`: 値に `"`、`'`、`\` をそれぞれ含むとき保存しない（0 以外で終わる、`e.secret()` が空、ログに `security -i` が無い）。3つは `it.each` でよい

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/35-fix-impl/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/discord-api.test.ts tests/unit/discord-intake.test.ts tests/unit/discord-intake-status.test.ts tests/unit/ac-discord-secret.test.ts`  4. `npm test`
5. 差分に17〜20桁の数字があれば、すべて `1000000000000000` で始まる作り物であること（`git diff origin/main | grep -oE '[0-9]{17,20}' | sort -u`）
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」と「Evaluator は画面のファイル変更 0 のため省く」を書く

## 想定分岐
- 既存の試験の偽の世界が、数字でない id の投稿を作っていて落ちる → その試験の作り物を数字の id に直してよい（期待は変えない）。直した試験を PR 本文に列挙する
- `channelStatus` の順を変えたことで既存の試験の期待が変わる → 変えずに止まって報告する（設計の見落としなので設計者が決める）
- 手元の試験が高負荷で時間切れになる → 単独で回して合格を確かめ、生出力を残す。それでも落ちるなら止まって報告する
- 試験の偽のタイマーが `clearTimer` の回数を数えていない → `clearTimer` の確かめは省き、`notifier.stops` と `timers.state.pending` が変わらないことで確かめる。省いたことを PR 本文に書く
