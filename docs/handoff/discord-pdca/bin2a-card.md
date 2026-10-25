# 実装カード: discord-pdca 便2a — Discord の受付チャンネルを読む受け口の芯（既定は無効・セッションは開かない）（v0.46.0）

設計: [design.md](design.md)（第13版。§4-1 受け口、§4-2 の順番待ちの上限、§4-4 の知らせと Webhook のやり直し、§4-6 データの正本、§8 便2、§9 の上限・時計のテスト）。根拠: [recon.md](recon.md) と、このカードの「点検した事実」。
PO 承認: 2026-10-25「1」（「次の段階の指示書を作る：Discord の報告を実際にこの記録へつなぐ段階の指示書を作り、作る係に作らせます。本番に入れる前にもう一度聞きます。」）。
作業場所: `/Users/tanizawashingo/agent-console-wt/discord-pdca-bin2a`（ブランチ `release/discord-pdca-bin2a`、このカードが入った origin/main 起点）。

## 決めたこと（設計の読み方。便2 を3つに分ける）
- 設計 §8 の便2 は変更が大きいので、1回に1つ変えるために3つに分ける。この便2a は「読む・ふるいにかける・順番待ちに入れる・異常を知らせる・状態を見せる」だけ。
  - 便2a（このカード）: Keychain から2つの秘密を読む・設定を読む・30秒ごとに受付チャンネルを読む・ふるい・順番待ち（投稿 id だけ）・捨てた数・ボットの照合・Webhook の知らせ（やり直しと macOS の通知）・状態の入口・Keychain の登録の台本
  - 便2b（後のカード）: 役割 discord-case / discord-measure（`agent-console.config.json` の2つの役割と restoreCommand・resumeCommand）・起動関数と囲い（`~/.claude/shell` の起動関数を台本で入れる・GH_TOKEN と専用の gh の置き場の受け渡し）・§4-5 の守り（`server/diff.ts:35`・`server/pr-status.ts:180` の git を包む関数に上書き・`server/worktree.ts` で件の worktree と作業前の決まりを囲いの外で動かす）・routine-closer の判定の関数の取り出し・枠と見張り（kept でも枠を持つ・kept の「判断待ち」の知らせ・起こし直したときの読み直し）・起動の失敗を1分おきに5回までやり直す・同時セッションの上限16の扱い・保守 API への出来事（受け付けました・開始・closed・kept・launch_failed・notify_failed）・全停止の読み取り（60秒ごとの読み直し）・1日10件・遅れの知らせ・指示書の正本 S:docs/ai-agents/ops-incident-agent.md とその写しを入れる導入の台本・受け口の設定ファイル `discord-intake.config.json` を書く導入の台本（設計 §4-6 :348）・受入 K1〜K4・K8 の起動の部分・K9・K11・K13・K17
    - 便2b の前提（Sales Anchor の別の PR）: S:scripts/reaper-worktree.sh・S:scripts/disk-janitor.sh の件の worktree に向けた git に上書きを付ける（§4-5 の守り。設計 §8 便2 の前提どおり、件のセッションを開く前に K17 の手順で確かめる）
  - 便2c（後のカード）: K16 の知らせ（`server/routine-audit.ts:11` に `suspicious`・ac-reserve と ac-routine の入口での検出）・件の一覧の画面（金型・t()。全停止・やり直すのボタンと入口）・再開の確認・8時間の知らせ・受入 K16 と ADR-1025 G6 の負荷の測定（共通の受け口に全部つないだ後で測る）
  - 設計 :530 の上限・時計のテストの割り当て: 20件・1周回5回の読み取り・Webhook の3回のやり直し＝便2a（このカード）／10件/日・16の上限・5回のやり直し・60秒の読み直し＝便2b／8時間＝便2c／24時間＝便3（測定の結果待ち。設計 :251）／30分の印＝便5（見張り役の maintenance の印。設計 :377）
  - 設計 §8 便2 の残りはすべて便2b/2c で扱う。
- **この便の本番は設定ファイルを置かない（無効のまま）**。設定ファイルを書く台本は便2b なので、便2a を本番に入れても受け口は `noConfig` で止まっている。便2a の動きは偽の通信の試験で確かめる。
- **この便ではセッションを1つも開かない**。順番待ちに入った投稿は、便2b が来るまで待つだけ。
- **既定は無効**。`dataDir/discord-intake.config.json` が無い・形が違う・秘密が読めない、のどれかなら受け口は動かず、サーバーのほかの動きは続く（設計 :146）。
- **受付チャンネル（`bug`）を有効にできるのは `testMode: true` のときだけ**（設計 §8 の便2「便3 の受入が通るまで testMode でだけ有効」）。`testMode: false` で `bug` を `enabled: true` にした設定は「形が違う」として受け口を動かさない。
- **誤り報告チャンネル（`error-report`）は、この便では読まない**（設計 :505「enabled を true にするのは ADR-1025 の便4 の受入」）。設定に書けるが、`enabled` が true でも読まず、状態に `notReady` と出す。ADR-1025 の便4 のために、判定の関数 `matchesErrorReport` だけを作って試験する。
- **guildId の確かめ方**: Discord の公式資料のメッセージの項目に `guild_id` は無い（点検 j）。そこで、ボットの照合と同じ時（最初の読み取りの前と1時間ごと）に、チャンネル自身を `GET /channels/{id}` で読み、その `guild_id` が設定の `guildId` と同じかを見る。違えばそのチャンネルを止めて知らせる（設計 :149 の「guildId が設定の値と同じ」をこの形で守る）。**まだ確かめられていないチャンネルは読まない**（状態 `waitingGuildCheck`）。`getChannel` が `failed`・`rateLimited` なら、そのチャンネルは読まずに次の周回で確かめ直す（1時間を待たない）。確かめられたら以後1時間ごとに確かめ直し、その間は読む。
- **初めて読んで0件だったとき**は、`lastSeenId` を `"0"` にせず、**読んだ時刻から作った snowflake** にする: `String((BigInt(now) - 1420070400000n) << 22n)`（点検 j の snowflake の作り方）。`READ_MESSAGE_HISTORY` が無いと0件で返り（点検 j）空と見分けられないため、`"0"` にすると、あとで権限を直したときに過去の投稿を全部受けてしまう。投稿があれば一番大きい id にする（設計 :152）。Mac と Discord の時計のずれの補正は入れない（ずれの大きさを測っておらず、影響は「0件で始まった直後の数秒」に限られるため。審査 P5 は見送り）。
- **ふるいの順番**: 1つの投稿は、最初に当たった1つの理由だけで数える。順は `channel`（channel_id が違う）→ `webhook`（webhook_id がある）→ `bot`（author.bot が true）→ `messageType` → `notAllowedAuthor` → `queueFull`。Webhook を bot より先に見るのは、設計 K2（:84）が Webhook の投稿を Webhook の理由で数えるため。
- **秘密の形の決まりは1か所**（`server/discord-credentials.ts`）。登録の台本は形を判定しない（同じ決まりを2つ作らない）。台本は保存だけして、形は状態の入口（`credentials`）で確かめる。
- 外へ出る通信の行き先は `discord.com` だけ（コードの定数。台本・設定で変えられない）。

## 点検した事実（agent-console origin/main 139508f。生出力は /tmp/CC報告ファイル/discord-pdca-bin2/25-recon/・26-card/・27-card2a/）
- a. `server/keychain.ts:7-8` は service `agent-console`・account `server` の定数。`:12` `readKeychainSecret(securityBin)` は account を引数に取れない（`:15` で定数を渡す）。`:19-21` 失敗の文に値を入れない。`:23` 形の検査は `isValidSecret`（`server/auth.ts:42-44`、32文字以上・`/^[A-Za-z0-9_-]+$/`）＝16進の合言葉用で、トークンと URL には使えない（設計 :368）
- b. `tests/unit/keychain.test.ts:22` は引数を `find-generic-password -s agent-console -a server -w` と完全一致で見ている
- c. `server/secret.ts:14-17` `securityBinFor(env)`（テストモードの時だけ `AC_SECURITY` を使う）
- d. `server/notify.ts:30` `type NotificationSender = (body: string) => void`、`:33` `osascriptSender(osascriptBin)`。`server/hub.ts:131` で `config.notify.macos ? osascriptSender(config.notify.osascriptBin) : null`。`server/config.ts:172-181` `parseNotify`
- e. `server/json-store.ts:10` `createSerial`、`:20` `readJsonFile`（無ければ undefined・壊れていれば例外＝上書きしないため）、`:30-36` `writeJsonAtomic`（0600・dir 0700・tmp→rename）
- f. `server/index.ts:68` main、`:88` `setupReserveToken`、`:108` `createRequestHandler({ … schedule: gate, relay, reserve, routineApprovals })`、`:113` listen、`:150-161` shutdown
- g. `server/http.ts:50-77` `AppDeps`（`:77` `routineApprovals?`）。`:166` handleApi の if の並び。`:215` `GET /api/reservations`、`:216` `GET /api/schedule/preview`。共通の認証は `:639`（session の GET は Origin 不要。非 GET は `:645`）
- h. `tests/unit/helpers/harness.ts:231-248` で gate を作り `createRequestHandler({ … })` に渡している
- i. 本番のポートの判定は `env.AGENT_CONSOLE_PORT === undefined || env.AGENT_CONSOLE_PORT === ""`（`server/auth.ts:93-95`・`server/activity-setup.ts:13-15`・`server/picker-extension.ts:38-39` の `isPickerSetupEnabled`。`server/reserve-token.ts:29` が使う）
- j. Discord の公式資料（GitHub の discord/discord-api-docs @6128d99、2026-10-23。写しは 26-card/discord-docs/。Context7 は月の上限で使えず、discord.com の取得は拒まれたため、起動指示の代替で公式の資料庫を直接読んだ）:
  - 土台の URL は `https://discord.com/api/v10`。認証の見出しは `Authorization: Bot <token>`
  - `GET /channels/{channel.id}/messages`: 新しい順で返る。`after`（snowflake）・`limit`（1〜100、既定50）。`before`・`after`・`around` は同時に1つだけ。`READ_MESSAGE_HISTORY` が無いと0件で返る
  - メッセージの項目: `id`・`channel_id`・`author`（user。`bot?`）・`content`・`timestamp`（ISO8601）・`webhook_id?`・`type`。**`guild_id` は項目に無い**
  - `MESSAGE_CONTENT` の特権インテント（`1 << 15`）が無いと `content` は空で返る（message.mdx:22）。便2a は文字数を数えるだけなので `length` が0になるだけで止まらない。**便2b（本文の読み直し。設計 :176）と ADR-1025 便4（`matchesErrorReport`）には欠かせない**ので、PO が Discord の画面でボットのこのインテントを有効にすることを、後ろの便の前提として渡す
  - snowflake: 上位42ビットが Discord の起点（1420070400000 ミリ秒）からのミリ秒。時刻から作るときは `(timestamp_ms - DISCORD_EPOCH) << 22`（reference.mdx:156・:171・:176）
  - `GET /channels/{channel.id}`: チャンネルの `guild_id?`
  - `GET /users/@me`: ボット自身の user（`id`）
  - 種類: DEFAULT=0、REPLY=19（設計 0-3 の実物でも PO の投稿 0・返信 19・ピン留め 6）
  - 429: 本文 JSON の `retry_after`（秒・小数）と `global`、見出し `Retry-After`（秒）
  - Webhook の実行: `POST /webhooks/{id}/{token}`。`content` は2000字まで。`wait` 既定 false で 204、true なら 200 とメッセージ。**false のときは保存されなかったメッセージでも誤りを返さない**（webhook.mdx:228）。`allowed_mentions: { parse: [] }` で誰も呼ばない
- k. 実行環境: `package.json:6` engines node >=24、ローカル v24.12.0 で `fetch` と `AbortSignal.timeout` は function（実測）
- l. Keychain への入れ方の前例: `scripts/ac-install.sh:25` `printf 'add-generic-password -U -s agent-console -a server -w %s\n' "$secret" | "$AC_SECURITY" -i`（値を引数に出さない）。`scripts/lib/ac-common.sh:9-11` はテストモード以外で `AC_*` を消す、`:19` `AC_SECURITY="${AC_SECURITY:-security}"`、`:50` `ac_guard_test_paths`。台本の試験は `tests/unit/scripts.test.ts`（`helpers/ac-env.ts`）
- m. macOS の入力画面: `/System/Library/ScriptingAdditions/StandardAdditions.osax/Contents/Resources/StandardAdditions.sdef:123-126` に `display dialog` の `default answer` と `hidden answer`（点で隠す）、`:151` に `text returned`（実物を読んだ）。`security add-generic-password -h` に `-U`（あれば上書き）・`-w`（実物）
- n. 誤り報告の本文の形: Sales Anchor `backend/app/services/discord_notifier.py:93` `誤り報告 {report_code} 項目: …`、`:126` `誤り報告 {code} 照合: …`。ADR-1025 の設計 `docs/handoff/analysis-error-report/design.md:68`・`:70`（webhook_id が決めた webhook と同じで、本文が `ER-` と6桁）
- o. 版: `package.json:3` 0.45.1（#75 で 0.45.0 から上がった）

## 守ること
- 触ってよいのは §変更 のファイルだけ。`hooks/`・`agent-console.config.json`・`.github/`・予約・定期実行・関門・routine-closer・sessions・launch は触らない
- cd を使わない（`git -C`・`npm --prefix` 等で絶対パス指定）
- Bash の命令に `Application Support/agent-console` の文字列を書かない。`pkill` `killall` `kill` `launchctl` を実行しない。導入（ac-update・install）しない。本番の dataDir を読まない・書かない
- **本物の Keychain を読まない・書かない**（試験は `security` の偽物だけ）。**本物の Discord に通信しない**（試験は偽の fetch だけ。登録の台本も実際には打たない）
- Discord の id（数字の列）・トークン・Webhook の URL の本物をコード・試験・コミット・報告に書かない。試験の id は `100000000000000001` のような作り物
- 投稿の本文を保存・ログ・知らせに出さない（数えるのは文字数だけ）
- 迷ったら全停止して `NEEDS_DECISION:`。報告は DONE / BLOCKED: / NEEDS_DECISION: で始め、生出力の保存パスを添える。試験を通すために既存の試験の期待値を変えない

## 変更

### 1. `server/keychain.ts`（足すだけ。今の `readKeychainSecret` の引数・文・振る舞いは変えない）
- 足す:
  ```ts
  /** 受け口が読む Keychain の項目（設計 discord-pdca §4-6。service は KEYCHAIN_SERVICE で同じ） */
  export type DiscordKeychainAccount = "discord-bot" | "discord-report-webhook";
  /** 項目を読む。読めなければ例外（文に値も出力も入れない）。形の検査は呼び出し側（discord-credentials.ts） */
  export async function readKeychainItem(securityBin: string, account: DiscordKeychainAccount): Promise<string>
  ```
  - 引数は `["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]`、timeout・maxBuffer は `:16-17` と同じ定数・値
  - 失敗の文は `keychain: ${account} を読めませんでした（scripts/ac-discord-secret.sh で登録してください）`。戻り値は `stdout.trim()`
  - 共通の execFile の部分を private の関数にまとめてよいが、`readKeychainSecret` の `keychain.test.ts` の試験がすべてそのまま通ること
  - `ops-api` はこの便では読まない（便2b で足す）

### 2. `server/discord-credentials.ts`（新規。秘密の形の決まりの正本）
```ts
export const DISCORD_HOST = "discord.com";
export const DISCORD_API_BASE = "https://discord.com/api/v10";
const WEBHOOK_URL = /^https:\/\/discord\.com\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,200}$/;
const BOT_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;
export function isValidBotToken(v: string): boolean   // BOT_TOKEN に合う
export function isValidWebhookUrl(v: string): boolean // WEBHOOK_URL に合う
export type CredentialState = "ok" | "unreadable" | "invalid";
export interface DiscordCredentials { botToken: string | null; webhookUrl: string | null; state: { bot: CredentialState; webhook: CredentialState } }
export async function loadDiscordCredentials(securityBin: string, read = readKeychainItem): Promise<DiscordCredentials>
```
- トークンの検査はゆるく（空でない・200字以内・英数字と `. _ -` だけ）。Discord のトークンの中身の構造は決めつけない（公式資料に形の定めを見つけていない）
- Webhook の URL は `discord.com` だけを通す（`discordapp.com` は通さない。行き先を1つにするため）
- 読めなければ `unreadable`、形が違えば `invalid`、どちらも値は `null`。値は返り値の外（ログ・例外の文）に出さない

### 3. `server/discord-intake-config.ts`（新規。`dataDir/discord-intake.config.json` を読む）
- 形:
  ```ts
  export type IntakeKind = "bug" | "error-report";
  export interface IntakeChannelConfig {
    kind: IntakeKind; enabled: boolean; guildId: string; channelId: string;
    allowedAuthors: { id: string; name: string }[];   // bug だけ必須（1件以上）。error-report は空でよい
    allowedMessageTypes: number[];                     // bug だけ必須（1件以上の 0 以上の整数）。PO の設定値は [0, 19]（設計 :149）
    reportWebhookId?: string;                          // error-report だけ必須（便4 で使う）
  }
  export interface IntakeConfig { testMode: boolean; forbiddenBotIds: string[]; channels: IntakeChannelConfig[] }
  export const INTAKE_CONFIG_FILE = "discord-intake.config.json";
  export type ConfigResult = { ok: true; config: IntakeConfig } | { ok: false; reason: "missing" } | { ok: false; reason: "invalid"; problem: string };
  export async function readIntakeConfig(dataDir: string): Promise<ConfigResult>
  ```
- id はどれも `/^\d{1,20}$/` の文字列。`forbiddenBotIds` は1件以上（本番アプリの id を入れる。設計 :156。値は公開の文書に書かない）
- 拒む形（`invalid`。`problem` には欄の名前だけを書き、値は書かない）: 知らない欄・型の違い・同じ `channelId` が2つ・同じ `kind` が2つ・`testMode` が false で `bug` が `enabled: true`
- 読み方は `readJsonFile`（壊れた JSON も `invalid`）

### 4. `server/discord-api.ts`（新規。Discord への通信はこのファイルだけ）
- `fetch` を差し替えられる形（既定は globalThis.fetch）。1回の通信は `AbortSignal.timeout(10_000)`
- 関数:
  - `listMessagesAfter(token, channelId, after: string | null)` → `GET ${DISCORD_API_BASE}/channels/${channelId}/messages?limit=100`（after があれば `&after=`。limit は 100 の決め打ちで引数にしない）
  - `getChannel(token, channelId)` → `GET …/channels/${channelId}`（`{ guild_id: string | null }` を返す。`guild_id` が欠けている・null のときは `null` で返し、`badJson` にしない。止めるかどうかは §5 の 3 で決める）
  - `getCurrentUser(token)` → `GET …/users/@me`（`id` を返す）
  - `executeWebhook(url, content)` → `POST ${url}?wait=true`、本文 `{ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }`、`Content-Type: application/json`。**200 だけを成功とする**（204 は wait が効いていないので失敗扱い。点検 j の wait=false の注意）
- 見出しは `Authorization: Bot ${token}`（Webhook には付けない）
- 戻り値は判別できる形: `{ ok: true, value }` ／ `{ ok: false, kind: "rateLimited", retryAfterMs }` ／ `{ ok: false, kind: "unauthorized" }`（401）／ `{ ok: false, kind: "forbidden" | "notFound", status }`（403・404）／ `{ ok: false, kind: "failed", reason: "http" | "timeout" | "network" | "badJson" | "badHost", status?: number }`（`http` はそのほかの HTTP の状態で `status` 必須・`timeout` は時間切れ・`network` は通信の失敗・`badJson` は形の違う JSON と欄の欠け・`badHost` は行き先が discord.com でない。`reason` は必須）
- 429 の待ち: 本文の `retry_after`（秒）を優先し、無ければ見出し `Retry-After`（秒）。`Math.ceil(秒 * 1000)`。どちらも読めなければ `retryAfterMs: null`
- 送る前に `new URL(url).host === DISCORD_HOST` を確かめ、違えば通信せず `{ ok: false, kind: "failed", reason: "badHost" }`（行き先の定数。R12）
- メッセージは使う欄だけに絞った型（`id`・`channel_id`・`author: { id; bot? }`・`content`・`timestamp`・`webhook_id?`・`type`）で返す。欄が欠けたものは `failed`
- 失敗の文・ログにトークンと URL を出さない

### 5. `server/discord-notifier.ts`（新規。報告チャンネルへの知らせ）
```ts
export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];  // 設計 :271
export class DiscordNotifier {
  constructor(deps: { webhookUrl: string | null; send: (url: string, content: string) => Promise<{ ok: boolean }>; macos: NotificationSender | null; setTimer: (f: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void })
  notify(text: string): void   // 待たない。待ち行列の末尾に足す
  stop(): void                 // 待っているやり直しのタイマーを止め、待ち行列を捨てる
}
export const NOTIFY_QUEUE_LIMIT = 50;
```
- **1件ずつ順に送る**: 待ち行列の先頭の1件を送り、その件のやり直しが終わる（送れた、または macOS に回した）まで次の件は送らない（順番を保ち、429 のときに重ねて送らない）。待ち行列が `NOTIFY_QUEUE_LIMIT` 件のときに来た知らせは、行列に入れずにすぐ `macos(text)` を呼ぶ
- 送れたら終わり。失敗したら 30秒・2分・10分のあとに1回ずつ、合わせて3回やり直す。3回とも失敗したら `macos(text)` を呼び、`console.error("discord-notify: failed after retries")`（本文・URL は出さない）
- `webhookUrl` が null なら、送らずすぐ `macos(text)`
- 出来事 `notify_failed` を保守 API に書くのは便2b（この便は書かない）
- 知らせの本文は §6 の決まった文だけ（投稿の本文を入れない。設計 :269）

### 6. `server/discord-intake.ts`（新規。受け口の本体）
- 作り:
  ```ts
  export const INTAKE_STATE_FILE = "discord-intake.json";
  export const POLL_INTERVAL_MS = 30_000;           // 設計 :147
  export const MAX_PAGES_PER_ROUND = 5;             // 設計 :153（1チャンネル500件）
  export const BUG_QUEUE_LIMIT = 20;                // 設計 :178
  export const BOT_CHECK_INTERVAL_MS = 3_600_000;   // 設計 :156
  export class DiscordIntake {
    constructor(opts: { dataDir: string; securityBin: string; macos: NotificationSender | null }, overrides?: Partial<{ now: () => number; setTimer; clearTimer; api: §4 の関数の束; loadCredentials: () => Promise<DiscordCredentials>; readConfig: () => Promise<ConfigResult>; makeNotifier: (webhookUrl: string | null) => { notify(text: string): void; stop(): void } }>)
    // overrides は試験用。省いたものは本物（Date.now・setTimeout/clearTimeout・§4 の関数・loadDiscordCredentials(securityBin)・readIntakeConfig(dataDir)・§5 の DiscordNotifier）
    start(): Promise<void>
    stop(): void   // 周回のタイマーを止める・notifier.stop()・途中の通信の結果は捨てて状態ファイルに書かない。以後の周回は始めない
    status(): DiscordIntakeStatus
  }
  export function matchesErrorReport(msg: { webhook_id?: string; content: string }, reportWebhookId: string): boolean
  ```
- `start()` の順番: ①設定を読む → 無い・違うなら止まったまま（状態に理由）。②秘密を読む → ボットが `ok` でなければ止まったまま。③通知の部品を作る（Webhook が `ok` でなければ URL は null＝macOS へ）。④状態ファイルを `readJsonFile` で読む → 壊れていたら止まったまま・上書きしない・③の部品で知らせる。⑤読みの周回を始める（知らせる部品を、知らせる前に作る）
- 周回（前の周回が終わってから `POLL_INTERVAL_MS` 後に次。重ならない。`setTimer` の連鎖で、`setInterval` は使わない）:
  1. `pausedUntil` より前なら何もしない
  2. 前回のボットの照合から `BOT_CHECK_INTERVAL_MS` 以上（または未実施）なら照合: `getCurrentUser` の id が `forbiddenBotIds` にあれば受け口を止め、知らせる。読めなければこの周回は読まない（照合できないまま読まない）
  3. guildId の確かめ: `kind: "bug"` かつ `enabled: true` かつ止まっていないチャンネルのうち、未確認（`waitingGuildCheck`）のもの、または前回の確かめから `BOT_CHECK_INTERVAL_MS` 以上たったものに `getChannel`。`guild_id` が設定と同じなら確認済みにして時刻を残す。違えば、または `guild_id` が無ければ（`guild_id?` は省かれることがある。点検 j）、そのチャンネルを止めて（`guildMismatch`）知らせる。`failed`・`rateLimited` なら、確認済みでないチャンネルは `waitingGuildCheck` のまま（この周回は読まない。次の周回で確かめ直す）、確認済みのチャンネルは前の確認のまま読み、次の周回で確かめ直す（`rateLimited` は下の「通信の失敗の扱い」の `pausedUntil` も守る）。`unauthorized` は下の扱い。`forbidden`・`notFound` はそのチャンネルを止めて知らせる
  4. 読む対象 = `kind: "bug"` かつ `enabled: true` かつ止まっていなくて guildId を確認済みのチャンネル。1つずつ順に読む
  5. `lastSeenId` が無い: `listMessagesAfter(token, id, null)`。返った中の一番大きい id を、0件なら読んだ時刻の snowflake（決めたこと）を `lastSeenId` にして保存。投稿は受けない
  6. `lastSeenId` がある: `after = lastSeenId` で読み、返ったページを id（BigInt）の小さい順に並べ、`lastSeenId` より大きいものだけを小さい順にふるいにかける。ページが100件なら `after` をそのページの一番大きい id にして続きを読む。1周回で `MAX_PAGES_PER_ROUND` 回まで。5回目も100件なら「取りこぼしの可能性」を知らせ、チャンネルに「追いついていない」の印を立てて次の周回で続きから。**印が立っている間は、続けて上限に当たっても知らせない**（設計 :153 の「1件」）。ある周回で最後のページが100件未満になったら（追いついた）印を外す。印はメモリだけに持つ（起こし直したら外れる）
  7. 1ページを処理するごとに、`lastSeenId`・順番待ち・`dropCounts` を**まとめて1回**書く（`writeJsonAtomic`、`createSerial` で直列）。書けなければ受け口を止めて知らせる（同じ投稿を2回受けないため、書けないまま進まない）
- ふるい（決めたことの順。最初に当たった理由1つだけを `dropCounts` に足す）:
  - `channel_id !== 設定の channelId` → `channel`
  - `webhook_id` がある → `webhook`
  - `author.bot === true` → `bot`
  - `type` が `allowedMessageTypes` に無い → `messageType`
  - `author.id` が `allowedAuthors` に無い → `notAllowedAuthor`
  - 順番待ちが `BUG_QUEUE_LIMIT` 件 → `queueFull`。知らせは**1周回で1件にまとめる**（その周回で `queueFull` にした件数と、最初と最後の投稿の日本時間を書く。0件の周回は知らせない）。便2a では順番待ちは減らない（減るのは便2b でセッションを開いたとき）
  - 通ったら、同じ `messageId` が順番待ちに無いときだけ `{ messageId, channelId, postedAt: timestamp, authorId, length: content.length }` を末尾に足す
- 通信の失敗の扱い:
  - `rateLimited`: `pausedUntil = now + retryAfterMs`（null なら次の周回まで）。この周回は終わり
  - `unauthorized`: 受け口を止め、「ボットのトークンが拒まれました」を知らせる（1回）
  - `forbidden`・`notFound`: そのチャンネルを止め、知らせる（1回）。ほかのチャンネルは続ける
  - `failed`: その周回のそのチャンネルは終わり。`lastError` と続けての失敗の数を状態に出す。次の周回でやり直す（知らせない）。読めた周回で続けての失敗の数を0に戻す
  - `lastError` に入れるのは決まった値だけ: `"rateLimited"`・`"unauthorized"`・`"forbidden:403"`・`"notFound:404"`・`"failed:<status>"`（HTTP の数字）・`"timeout"`・`"network"`・`"badJson"`（形の違う JSON・欄の欠け）・`"badHost"`。§4 の `failed` の `reason` と `status` から作る（`http` → `"failed:<status>"`）。例外の文・URL・トークン・応答の本文は入れない
- 状態ファイルの形（設計 :347。本文は入れない）:
  ```json
  { "version": 1,
    "channels": { "<channelId>": { "lastSeenId": "<id>" } },
    "queues": { "bug": [ { "messageId": "", "channelId": "", "postedAt": "", "authorId": "", "length": 0 } ], "error-report": [] },
    "dropCounts": { "channel": 0, "webhook": 0, "bot": 0, "messageType": 0, "notAllowedAuthor": 0, "queueFull": 0 } }
  ```
  - 読んだ形が違えば（version が 1 でない・欄の型の違い）壊れているのと同じ扱い
- 知らせの文（決まった文だけ。日時は日本時間 `YYYY/MM/DD HH:mm`。`チャンネル` は `bug`→「受付チャンネル」）:
  - `【取りこぼしの可能性】{日時} 受付チャンネルで1回に読む上限（500件）を超えました。次の周回で続きを読みます。`
  - `【異常】{日時} ボットが本番アプリと同じです。受け口を止めました。`
  - `【異常】{日時} 受付チャンネルが設定のサーバーのものではありません。このチャンネルを止めました。`
  - `【異常】{日時} 順番待ちが満杯（20件）のため、{最初の投稿の日時}〜{最後の投稿の日時}の投稿{件数}件を受けませんでした。`（1件のときも同じ形）
  - `【異常】{日時} ボットのトークンが Discord に拒まれました。受け口を止めました。`
  - `【異常】{日時} 受付チャンネルを読めません（{status}）。このチャンネルを止めました。`
  - `【異常】{日時} 受け口の作業の記録を読めない・書けないため、受け口を止めました。`
- `status()` の形（id・トークン・URL・本文を入れない）:
  ```ts
  export interface DiscordIntakeStatus {
    state: "disabled" | "running" | "stopped";
    reason: null | "notStarted" | "noConfig" | "configInvalid" | "credentials" | "forbiddenBot" | "tokenRejected" | "stateUnreadable" | "stateWriteFailed";
    problem: string | null;                   // configInvalid の欄の名前だけ
    testMode: boolean | null;
    credentials: { bot: CredentialState; webhook: CredentialState } | null;
    channels: { kind: IntakeKind; enabled: boolean; status: "reading" | "waitingGuildCheck" | "waitingFirstRead" | "notReady" | "disabled" | "guildMismatch" | "forbidden" | "notFound"; lastReadAt: string | null }[];
    queues: { bug: number; "error-report": number };
    dropCounts: Record<"channel" | "webhook" | "bot" | "messageType" | "notAllowedAuthor" | "queueFull", number>;
    lastBotCheckAt: string | null; pausedUntil: string | null; lastError: string | null; consecutiveFailures: number;
  }
  ```
  - `error-report` のチャンネルは `enabled` に関わらず `notReady`
  - `state` と `reason` の対応（これ以外の組は作らない）:
    | state | reason | いつ |
    |---|---|---|
    | `disabled` | `notStarted` | `start()` 前・`discordIntake` を渡していない入口 |
    | `disabled` | `noConfig` | 設定ファイルが無い（既定） |
    | `stopped` | `configInvalid` | 設定の形が違う（`problem` に欄の名前） |
    | `stopped` | `credentials` | ボットの秘密が `unreadable`・`invalid` |
    | `stopped` | `forbiddenBot` | ボットが本番アプリと同じ |
    | `stopped` | `tokenRejected` | 401 |
    | `stopped` | `stateUnreadable` | 状態ファイルが壊れている |
    | `stopped` | `stateWriteFailed` | 状態ファイルを書けない |
    | `running` | `null` | 周回している（チャンネルごとの状態は `channels`） |
- `matchesErrorReport`: `msg.webhook_id === reportWebhookId && /(?<![A-Za-z0-9])ER-\d{6}(?!\d)/.test(msg.content)`（点検 n。「ER- と6桁」なので、前に英数字が付くもの・7桁以上には当てない）。この便ではどこからも呼ばない（便4 のため。試験だけ）
- 中身の正本は設計 §4-6。順番待ちに本文は入れない。投稿の本文は Discord が正本（設計 :155）

### 7. `server/http.ts`
- `AppDeps`（:50-77）に `discordIntake?: { status(): DiscordIntakeStatus }` を足す（省略可。省いたときは下の入口が `{ state: "disabled", reason: "notStarted", … }` の形を返す）
- `:216` の後に1行: `GET /api/discord-intake/status` → `sendJson(res, 200, deps.discordIntake?.status() ?? disabledIntakeStatus())`。共通の認証 `:639` の内側（session の Bearer が要る）。`disabledIntakeStatus()` は `server/discord-intake.ts` に置いて export する（形を2か所で作らない）

### 8. `server/index.ts`
- `:88` の `setupReserveToken` の後に、本番のポートのとき（点検 i と同じ式。`isPickerSetupEnabled(process.env)` を使う）だけ作る:
  ```ts
  const discordIntake = isPickerSetupEnabled(process.env) ? new DiscordIntake({ dataDir: config.dataDir, securityBin: securityBinFor(process.env), macos: config.notify.macos ? osascriptSender(config.notify.osascriptBin) : null }) : null;
  ```
  （§6 のコンストラクタの1つ目の引数だけで本物の依存が入る）
- `:108` の `createRequestHandler({ … })` に `...(discordIntake ? { discordIntake } : {})` を足す
- `:113` の listen のコールバックで `void discordIntake?.start().catch((e) => console.error("discord-intake: start failed:", e instanceof Error ? e.message : e))`。起動の失敗でサーバーを止めない
- `:150` の shutdown で `discordIntake?.stop()`
- 本番のポートでないとき（試験・自己診断）は作らない＝同じ dataDir を2つのサーバーが読まない

### 9. `tests/unit/helpers/harness.ts`
- 変えない（`discordIntake` は省略可なので、harness の入口は `notStarted` を返す）。入口の試験は §12 で `discordIntake` を渡す形で作る

### 10. `scripts/ac-discord-secret.sh`（新規。PO が `!` で打つ登録の台本）
- 使い方: `bash scripts/ac-discord-secret.sh discord-bot` か `bash scripts/ac-discord-secret.sh discord-report-webhook`。ほかの引数は `ac_die`
- `source "$(dirname "${BASH_SOURCE[0]}")/lib/ac-common.sh"`、`set -euo pipefail`。`ac_guard_test_paths`
- 値の受け取り: `osascript` の入力画面（点を表示して隠す）。`set -e` の下で代入の失敗が `ac_die` より先に台本を止めないよう、必ず `if` の形で受ける:
  ```bash
  if ! value="$("${AC_OSASCRIPT:-osascript}" -e 'text returned of (display dialog "…" default answer "" with hidden answer)')"; then
    ac_die "取り消しました（保存していません）"
  fi
  ```
  - 入力画面の文は account ごとに日本語で「Discord のボットのトークンを貼り付けてください」「報告チャンネルの Webhook の URL を貼り付けてください」
  - 取り消し（osascript が 0 以外）なら何も保存せず上の `ac_die`
  - `AC_OSASCRIPT` はテストモードのときだけ使う（`ac-common.sh:9-11` の消す一覧に `AC_OSASCRIPT` を足す。ほかは変えない）
- 保存の前の検査は「空でない」「空白・引用符・バックスラッシュ・改行が無い」だけ（`security -i` が1行の命令として読むため。形の決まりは §2 の1か所）。合わなければ保存せず `ac_die`
- 保存: `printf 'add-generic-password -U -s agent-console -a %s -w %s\n' "$account" "$value" | "$AC_SECURITY" -i >/dev/null`、すぐ `unset value`。`"$AC_SECURITY" find-generic-password -s agent-console -a "$account" >/dev/null 2>&1 || ac_die "Keychain への保存を確認できませんでした"`（`-w` を付けない。`scripts/ac-install.sh:27-28` と同じ形）で有るかだけ確かめ、`ac_log "<account> を Keychain に保存しました（値は表示しません）。形の確かめは画面の状態の入口で行います"`
- 値を引数・標準出力・標準エラー・ログに出さない（`set -x` を使わない）

### 11. 版・文書
- `package.json`・`package-lock.json`（2 か所）・`extension/manifest.json` を 0.46.0
- `docs/CHANGELOG.md` の先頭に 0.46.0 の1行（Discord の受付チャンネルを読む受け口の芯。既定は無効で、設定と Keychain の2つの秘密があり testMode のときだけ動く。セッションは開かない／戻し方 `bash scripts/ac-update.sh v0.45.1`／設計パス）
- `README.md` に「Discord の受け口（便2a）」の節を足す: 設定ファイルの場所と形（id は例の作り物）・登録の台本の使い方・状態の入口 `GET /api/discord-intake/status`・この版ではセッションを開かないこと・**この版では順番待ちは減らない**（20件で満杯になり、以後は1周回1件の満杯の知らせが出る。試験のあとに空にするには、サーバーを止めてから `dataDir/discord-intake.json` を消す。次の起動は「初めて読む」扱いで、過去の投稿は受けない）・ボットに `MESSAGE_CONTENT` のインテントが無いと文字数が0になること（点検 j）

### 12. テスト（偽の時計・偽のタイマー・偽の fetch・偽の security。本物の Keychain と Discord は使わない）
- `tests/unit/keychain.test.ts` に足す（今の試験は変えない）: `readKeychainItem(bin, "discord-bot")` の引数が `find-generic-password -s agent-console -a discord-bot -w`。失敗の文に出力が入らない
- `tests/unit/discord-credentials.test.ts`: トークンの通る形・通らない形（空・201字・空白・`:`）。URL は `discord.com` の正しい形だけ通り、`discordapp.com`・`http://`・余計な道・空の token が通らない。読めない→`unreadable`、形違い→`invalid`、値が null
- `tests/unit/discord-intake-config.test.ts`: 無い→`missing`、壊れた JSON・知らない欄・id の形違い・同じ channelId 2つ・`testMode: false` で `bug` が有効 → `invalid`（`problem` に値が入らない）、正しい形→`ok`
- `tests/unit/discord-api.test.ts`: URL と見出し（`Bot ` が付く・Webhook には付かない）、`after` の有無、429 の本文の `retry_after: 1.5` → 1500、本文が無く見出しだけ → その秒、401・403・404・500・通信の失敗・形の違う JSON の判別、host が違う URL では fetch を呼ばず `{ ok: false, kind: "failed", reason: "badHost" }` を返す、`getChannel` の応答に `guild_id` が無い・null のとき `{ ok: true, value: { guild_id: null } }`（`badJson` にならない）、Webhook の本文が2000字で切れて `allowed_mentions.parse` が空、Webhook の URL に `?wait=true` が付き、200 は成功・204 は失敗
- `tests/unit/discord-notifier.test.ts`: 成功で1回だけ送る。失敗が続くと 30秒・2分・10分で送り直し、4回目も失敗で macOS に1回。途中で成功したら macOS は呼ばない。URL が null ならすぐ macOS。`stop()` で以後送らない。2件続けて `notify` すると、1件目のやり直しが終わるまで2件目は送らず、順番どおりに送る。待ち行列が50件のとき51件目はすぐ macOS
- `tests/unit/discord-intake.test.ts`（偽の時計で、設計 :530 の上限・時計のテストのうちこの便の分）:
  - I1 初めて読む: 3件あっても受けず、`lastSeenId` が一番大きい id。0件なら `lastSeenId` は読んだ時刻（偽の時計）の snowflake で、次の周回でそれより新しい1件は受け、それより古い id の投稿（権限を直したあとに見えるようになった過去の投稿の代わり）は受けない
  - I2 新しい順で返ったページを小さい順に受け、`lastSeenId` 以下は受けない（`after` が自身を含んで返っても2回受けない）。id の比較が BigInt（桁の違う id で並びが正しい）
  - I3 100件のページが続くと同じ周回で `after` を進めて読み、5回で止まり「取りこぼしの可能性」が1件、次の周回で続きから読み、取りこぼし0件。次の周回も5回とも100件なら知らせは増えず（合わせて1件）、追いついた（100件未満）後にまた上限に当たると2件目
  - I4 ふるい: channel・webhook（author.bot も true の Webhook 投稿は webhook に数える）・bot・messageType（6）・notAllowedAuthor がそれぞれ1ずつ。0 と 19 は受ける
  - I5 順番待ちが20件のとき21件目は `queueFull` に1・知らせ1件。同じ周回で3件が満杯で捨てられても知らせは1件（件数3）。次の周回で満杯の投稿が0件なら知らせ0件
  - I6 再起動: 受けたあとで作り直した `DiscordIntake` が同じ投稿を2回受けない（K3 の受け口の部分）
  - I7 状態ファイルが壊れている: 読みに行かず、ファイルを書き換えず、`stateUnreadable`、知らせ1件（Webhook が ok なら Webhook に、無ければ macOS に。知らせの部品が先に作られていること）
  - I8 書けない（dataDir を書込不可にする等）: `stateWriteFailed` で止まり、`lastSeenId` が進まない
  - I9 ボットの照合: 最初の読みの前に1回、59分後は呼ばず、60分後に1回。`forbiddenBotIds` の id なら止まり知らせ1件・メッセージを読まない。照合が `failed` ならその周回は読まない
  - I10 チャンネルの `guild_id` が設定と違う: そのチャンネルだけ止まり知らせ1件、ほかは読む。`getChannel` が `failed` なら、そのチャンネルへのメッセージの読み取りの通信は0回で `waitingGuildCheck`、次の周回で `getChannel` をやり直し、同じなら読む。確認済みのあとの1時間ごとの確かめが `failed` でも読み続ける。`guild_id` が無いチャンネルは `guildMismatch` で止まり知らせ1件
  - I11 429: `pausedUntil` まで通信0回、過ぎたら読む
  - I12 401 で止まり知らせ1件。403 でそのチャンネルだけ止まる。500 は次の周回でやり直し、知らせない
  - I13 周回が重ならない: 通信が終わらない間に30秒たっても次の周回が始まらない
  - I14 通信0回で、設定が無い→`disabled`/`noConfig`、`invalid`→`stopped`/`configInvalid`、ボットの秘密が `unreadable`→`stopped`/`credentials`（§6 の対応表どおり）。500 のあと `lastError` が `"failed:500"`、通信の失敗で `"network"`（例外の文が入らない）
  - I15 `error-report` のチャンネルは `enabled: true` でも読まず `notReady`
  - I16 状態ファイル・`status()`・知らせ・console に、投稿の本文（試験で入れた目印の文字列）とトークン（目印）が1つも出ない
  - I17 `matchesErrorReport`: webhook_id が同じで `ER-000123` を含む→true。webhook_id が違う・無い・`ER-12345`（5桁）・`ER-1234567`（7桁）・`XER-123456`→false
  - I18 `stop()`: 通信の途中（偽の api の Promise を解かずに止めておく）で `stop()` を呼び、そのあと Promise を解く → 状態ファイルへの書き込み0回・`setTimer` の呼び出し0回・`notifier.stop()` は1回だけ。`start()` の途中（`readConfig` を止めておく）で `stop()` を呼んでから解く → 周回は始まらない（`listMessagesAfter` 0回・`setTimer` 0回・`makeNotifier` 0回・知らせ0件）
- 入口の試験（`tests/unit/discord-intake-status.test.ts`。harness と同じ作り方で `createRequestHandler` に偽の `discordIntake` を渡す。harness を使えなければ http を直接立てる）: 認証なし 401、認証ありで 200 と `status()` の中身、`discordIntake` を渡さないと `notStarted`
- 台本の試験（`tests/unit/scripts.test.ts` に足す。`AC_STUB_LOG` のテストモード・`AC_OSASCRIPT` と `AC_SECURITY` の偽物）: 値が `security` の標準入力にだけ渡り、`security` の引数・台本の標準出力・標準エラーに値が出ない。取り消し（偽の osascript が 1 で終わる）で保存0回・`ac_die` の文が出る。空白入りの値で保存0回。知らない account で保存0回。保存の確かめ（偽の `find-generic-password`）が失敗したら 0 以外で終わる

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2a/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/keychain.test.ts tests/unit/discord-credentials.test.ts tests/unit/discord-intake-config.test.ts tests/unit/discord-api.test.ts tests/unit/discord-notifier.test.ts tests/unit/discord-intake.test.ts tests/unit/discord-intake-status.test.ts tests/unit/scripts.test.ts`  4. `npm test`
5. `git diff --stat origin/main...HEAD` が §変更 のファイルと新しい試験だけ
6. `git -C <作業場所> diff origin/main...HEAD -- . ':!package-lock.json' | grep -nE '^\+.*[0-9]{17,20}'` の出力を保存し、作り物の試験の id（`1000000000000000` で始まるもの）以外が0件
7. コミット `feat: Discord の受付チャンネルを読む受け口の芯（既定は無効・セッションは開かない）（v0.46.0）`（末尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）して push。PR は作らない

## 想定分岐
- `readKeychainSecret` と共通にしたら `keychain.test.ts` の今の試験が落ちた: 共通にせず別に書く（期待値は変えない）
- `tests/unit/scripts.test.ts` の `helpers/ac-env.ts` で新しい台本を動かせない（osascript の偽物を渡す道が無い等）: 新しいファイル `tests/unit/ac-discord-secret.test.ts` に、同じテストモードの作法で書く。それでも動かせなければ、その試験だけ BLOCKED: で返してよい（ほかは進める）
- `ac-common.sh:9-11` に `AC_OSASCRIPT` を足すと既存の台本の試験が落ちた: NEEDS_DECISION:
- `isPickerSetupEnabled` の export の場所・名前が違う: `server/picker-extension.ts` の実物に合わせる。無ければ `server/auth.ts:93-95` と同じ式を使い、報告に書く
- `AppDeps` を省略可にすると型の検査で困る（`createRequestHandler` の呼び出しが多い等）: 省略可のまま、入口の側で既定の形を返す。それでも困るなら NEEDS_DECISION:
- 偽の時計で `AbortSignal.timeout` が邪魔をする: 時間切れの作り方を差し替え可能にしてよい（本物は 10秒）
- `npm test` で今回のファイル以外が落ちたら、単独で回し直して結果を添える。単独で通るなら報告に書いて進める（便1 で chat-queue.integration:323・daily-use.integration:152 が負荷で落ち、単独では通った）。単独でも落ちるなら BLOCKED:
- 設計・このカードと実物が食い違う、または上のどれにも当たらない迷い: NEEDS_DECISION:（推測で進めない）
