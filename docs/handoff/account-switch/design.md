# 設計: 今の Claude アカウントを下の帯に出し、画面から別アカウントに入り直せるようにする

- 状態: 設計案（設計者 Opus 作成・2026-10-13）。Fable の設計審査（2026-10-13）は REVISE（CRITICAL 0 / HIGH 4 / MEDIUM 7 / LOW 6）→ 全件を §10 に反映 → 再審査 APPROVE（MEDIUM 1・LOW 4 は 10-11 で反映済み）。**§10 は §0〜§9 より優先する。** PO 承認前。実装未着手。
- PO の要望（2026-10-13 原文）:「agent consoleのアプリ側のアカウントの切り替えが出来ないので切り替えができるようにしてほしい、アプリの下部にログアウトは存在する別アカウントでログインする仕組みが存在しない、またログインしているユーザーも見える化してほしい」
- PO の回答（2026-10-13）:
  - 設計者の質問「切り替えたいのは Claude のアカウントですか？」→「y」
  - 設計者の質問「切り替えるたびにブラウザで別アカウントに入り直す方式でよいですか？（2つのアカウントに同時にログインしたままにはしない）」→「y」
  - PO の報告「すでに別アカウントに切り替えて現在セッションを進めている」
  - 設計者の質問「別アカウントに切り替えたとき、先に「ログアウト」をしてからログインしましたか？（y なら命令を「ログアウト→ログイン」の順にし、途中でやめると全部の会話が止まる注意書きを付ける）」→「y」
- 調査: [recon.md](recon.md)（以下「recon §X」）。

## 0. 事実（recon より）

- 今の「ログアウト」はアプリ画面のセッションを切るだけで、Claude のアカウントには触れない（recon §A）。
- Claude のログインは、この Mac の全部の会話で 1 つを共有する。別アカウントでログインすると、動いている会話も新しいアカウントを使い始める（recon §B「Not logged in」の公式原文）。
- 今のアカウントは `claude auth status --json` で読める（email・subscriptionType・loggedIn）。未ログインは終了コード 1 で、JSON は出る（recon §B）。
- `claude auth login` は端末なしでも URL を出し、「Paste code here if prompted」で待つ（recon §B 実測）。
- 【未確認】ログイン中に別アカウントで `claude auth login` したとき上書きされるか、先に logout が要るか（recon §C）。→ 工程0 で PO 立会いのもと実測する。

## 1. 方針

- 「アカウントを切り替える」＝ この Mac の Claude 全体のログインを入り直すこと。アプリはアカウントの情報を一切保存しない。正本は Claude Code（`claude auth status`）だけ（SSOT）。
- 入り直しは、アプリの端末画面で Claude 公式の `claude auth login` を動かす。ブラウザでのログイン・コードの貼り付けは、PO がその端末画面で行う。アプリはトークン・コードに触れない。
- 設定フォルダを分ける方式（`CLAUDE_CONFIG_DIR`）・長期トークン方式（`setup-token`）は採らない（§6）。

## 2. 成功条件

|基準|検証方法|
|---|---|
|K1 下の帯に「Claude ログイン: <メール>（<プラン>）」が出る（§11-2）。メールは `claude auth status --json` の email と一字一句同じ|e2e（偽物の claude が返す email と画面の文字が一致）＋工程4で PO が目視（ターミナルの `claude auth status --text` と同じか）|
|K2 未ログインのときは「Claude: 未ログイン」、読めないときは「Claude: アカウントを確認できません」と出る（空白にならない）|単体試験（終了コード 1・壊れた JSON・実行失敗の 3 通り）|
|K3 画面に送るのは loggedIn・email・subscriptionType の 3 つだけ。orgId・orgName 等は送らない|単体試験（応答のキーが 3 つ以下であること）|
|K4 アプリはアカウント情報をファイル・キーチェーン・ブラウザ保存に書かない|コード検査（新しいファイルに writeFile・sessionStorage・localStorage が 0 件）＋単体試験で dataDir に新しいファイルが増えないこと|
|K5 「アカウントを切り替える」を押すと確認ダイアログが出て、「全部の会話が新しいアカウントに切り替わる」ことが書いてある。「やめる」なら何も起きない|e2e（→ §11-2 で置き換え）|
|K6 確認すると「アカウント切り替え」という名前の端末が一覧に増え、その中で config 固定のログイン命令が動く。画面の文字は命令に入らない|e2e（偽物の claude が受け取った引数が「auth logout」「auth login」の 2 行だけ。10-2）＋単体試験|
|K7 端末でのログインが終わる（端末が停止する）と、10 秒以内に下の帯の表示が新しいアカウントに変わる|e2e（偽物の claude の email を差し替え→端末停止→表示が変わる）|
|K8 アカウント切り替えの端末は、アプリを再起動しても開き直されない（再開の記録に残らない）|単体試験（open-sessions.json に入らない）|
|K9 金型とトークン: 新しい部品は SA の Button・ConfirmModal・Badge だけ。CSS は var(--...) だけ。文言は ja.json だけ|`npm run lint`（check-design-governance）緑|
|K10 既存の動き（会話の起動・再開・アプリのログアウト・利用量バー）が変わらない|既存の単体・e2e がすべて緑（CI）|
|K11 本物で切り替えられる|工程4で PO が実施: 切り替え→表示が別アカウントのメールになる→元に戻す→元のメールになる|

## 3. 仕組み

### 3-1 読む（表示）

- 新規 server/account.ts
  - `fetchAccount(claudeBin)`: `execFileAsync(claudeBin, ["auth", "status", "--json"], { timeout: 15000 })`。終了コード 1 のときも、エラーの stdout を解析する（未ログインでも JSON が出るため）。
  - `parseAccount(stdout)`: JSON の `loggedIn`（boolean）・`email`（string）・`subscriptionType`（string）だけを取り出す。型が違えば `{ status: "invalid" }`。他のキーは捨てる（K3）。
  - 返す形: `{ status: "ok", loggedIn: true, email, subscriptionType }` / `{ status: "ok", loggedIn: false }` / `{ status: "invalid" }` / `{ status: "error" }`。
  - 手本: server/agents.ts:100-119 の作法（パイプで実行・例外は握りつぶさず状態に変える）。
- 新規 server/account-routes.ts: `GET /api/account` → `fetchAccount` の結果を返す。手本 server/usage-routes.ts:10-14。server/http.ts:182 の `handleUsage` の次に `handleAccount` を 1 行足す。
  - 保存しない。毎回 Claude Code に聞く（SSOT）。同時に来た要求は 1 回の実行にまとめる（実行中の Promise を使い回す）。
- 新規 src/components/AccountBadge/（AccountBadge.tsx・AccountBadge.css・AccountBadge.test.tsx）
  - 60 秒ごとに `fetchAccount()`（src/api.ts に追加）を取り直す。手本 UsageMeter.tsx:63-93。
  - 外から「今すぐ取り直す」合図（`refreshKey` の prop）を受ける（K7 用）。
  - 表示: `t("ac.account.label")`「Claude」＋ email ＋ SA `Badge` で subscriptionType。未ログイン・読めないは K2 の文言。
  - 右に SA `Button variant="ghost" size="sm"` で `t("ac.account.switch")`「アカウントを切り替える」。
- src/pages/ConsolePage.tsx のフッター（:421-444）で `claude-version` の span の直後に `<AccountBadge ... />` を置く。他の要素は動かさない。

### 3-2 入り直す（切り替え）

- agent-console.config.json に最上位キー `accountLoginCommand` を足す（roles には足さない。roles は「新しい会話」の選択肢に全部出るため: recon §A）。
  - 値は工程0の結果で決める（§9）。上書きでよければ `["/bin/zsh", "-ic", "claude auth login"]`。
  - server/config.ts: 省略可。あれば parseCommand（:134-139）で検証。無ければ切り替えボタンを出さない（`/api/state` に `accountSwitchEnabled: boolean` を足す。http.ts:131-146）。
- 新規の経路 `POST /api/account/login`（account-routes.ts）→ `sessions.createAccountLogin()`。
  - server/sessions.ts に `createAccountLogin()` を足す。中身は固定の役割 `{ id: ACCOUNT_LOGIN_ROLE_ID（10-1 の定数）, labelKey: "role.accountLogin", command: config.accountLoginCommand, needsWorktree: false }` で既存の spawnSession（:258-302）を呼ぶ。名前は `t` を使えないので固定の識別名 "account-login" とし、画面では roleId から `t("role.accountLogin")`「アカウント切り替え」と出す。
  - 同時に 2 つ作らない（動いている account-login があれば 409）。会話の上限（maxSessions）に数える。
  - 画面からの文字列は受け取らない（本文なしの POST）。
- 再開の記録から外す（K8）: 工程0で、open-sessions.json に記録する処理（server/session-store.ts と OpenSessionRecorder）の判定箇所を file:line で確かめ、roleId "account-login" を記録しない 1 条件を足す。
- 画面: 「アカウントを切り替える」→ `ConfirmModal`（手本 ConsolePage.tsx:445-454）。
  - 本文 `t("ac.account.confirmBody")`:「この Mac の Claude のログインを入り直します。動いている会話も、新しいアカウントに切り替わります。開いた端末の案内に沿って、ブラウザでログインしてください。」 → §11-2 の確定文で置き換え
  - 確認 → `POST /api/account/login` → 返った id を選択状態にして端末を表示（手本 ConsolePage.tsx:156-168 handleCreate）。
- 表示の取り直し（K7）: ConsolePage は、roleId "account-login" の会話が「停止」に変わったのを見たら AccountBadge の `refreshKey` を 1 増やす。

### 3-3 文言（src/locales/ja.json）

- `ac.account`: label「Claude」/ loggedOut「未ログイン」/ error「アカウントを確認できません」/ switch「アカウントを切り替える」/ confirmTitle「アカウントを切り替える」/ confirmBody（上記）/ confirm「切り替える」/ cancel「やめる」/ busy「すでに切り替え中です」/ switchError「切り替えを始められませんでした」
- `role.accountLogin`「アカウント切り替え」（既存の role.* と同じ階層。位置は工程0で確認）

## 4. SSOT

- アカウントの正本は Claude Code（`claude auth status`）だけ。アプリは毎回聞き、保存しない（K4）。
- ログイン命令の正本は agent-console.config.json の `accountLoginCommand` だけ。

## 5. 安全

- アプリはトークン・認証コード・キーチェーン・~/.claude.json に触れない（stage1 design.md:85 を守る）。`auth status` が返す値のうち 3 つだけを画面へ。
- 命令は config 固定。画面の文字列は命令に入らない。
- 切り替えは Mac 全体に効くことを確認ダイアログで必ず示す。
- 戻し方: ① 同じボタンで元のアカウントに入り直す。② 版を戻す `! bash scripts/ac-rollback.sh`（README.md:171-175）。③ ボタンを止めるだけなら config から `accountLoginCommand` を消す。

## 6. 代替案

- 設定フォルダを分ける（公式の複数アカウント方式）: 不採用。CLAUDE.md・rules・安全フック 23 本・記憶・担当が別フォルダになり、写しを作るとデータが散らばる（recon §B）。
- 長期トークン（setup-token）をアプリが預かる: 不採用。秘密を持たない原則（stage1 design.md:85）に反し、claude.ai のコネクタが使えない（recon §B）。
- roles に「アカウント切り替え」を足す: 不採用。「新しい会話」の選択肢に混ざる。

## 7. リスク

- 先に logout が要る仕様だった場合、ログインを途中でやめると Mac 全体が未ログインになる。→ 工程0で確かめる。要るなら命令を `claude auth logout; claude auth login` にし、確認ダイアログに「途中でやめると全部の会話が止まる」と書く。 → §11-2 の確定文で置き換え（「全部の会話が止まる」とは書かない）
- 切り替え直後、利用量バーは前のアカウントの値のまま（次に会話が動くまで）。→ 既存の「◯分前」表示で古さは見える。今回は変えない。
- 公開 issue #91669 のように、入り直しの後に再ログインを求められる不具合が Claude Code 側にある。→ アプリでは直せない。工程4で起きたら記録する。

## 8. 外部・過去事例の参照と我々への応用

- Claude Code 公式は「同じ設定フォルダの会話はログインを共有し、別ウィンドウのログインを自動で使い始める」と明記（recon §B）。これを「Mac 全体の切り替え」として使う。
- 公開 issue #89785・#22872（複数アカウント対応の要望、open）: 公式の画面切替機能はまだ無い。適用限界: 要望であり、数値の実績ではない。数値の外部事例は調べていない。

## 9. 工程

- 工程0（PO 立会い・実装前）:
  - (a) PO がターミナルで: `claude auth status --text` → `claude auth login`（別アカウント）→ `claude auth status --text` → 元のアカウントで `claude auth login` → `claude auth status --text`。上書きできたか、logout が要ったかを記録。その間、動いている会話が 1 つ応答できるかを見る。
  - (b) Sonnet が読み取りで、再開記録の判定箇所と role.* の位置を file:line で確かめる。
  - （この工程0は 10-3 で置き換えた。10-3 を見よ）
- 工程1: server（account.ts・account-routes.ts・config・sessions・記録除外）＋単体試験。
- 工程2: 画面（AccountBadge・フッター・ConfirmModal・ja.json）＋部品試験。
- 工程3: claude-stub.sh に `auth status`（STUB_AUTH_FILE を読む）と `auth login`（引数を記録して終わる）を足し、e2e。版を 0.16.0、CHANGELOG・README（「Claude アカウントの切り替え」の節）。
- 工程4: PR → CI 緑 → 審査 → マージ → PO が `! bash scripts/ac-update.sh v0.16.0` → K1・K11 を PO が確認。

## 触るファイル・触らないファイル

- 触る: server/account.ts（新）、server/account-routes.ts（新）、server/http.ts、server/config.ts、server/sessions.ts、再開記録の判定箇所（工程0で特定）、src/api.ts、src/types.ts、src/components/AccountBadge/（新）、src/pages/ConsolePage.tsx、src/locales/ja.json、agent-console.config.json、tests/fixtures/claude-stub.sh、tests/unit・tests/e2e の新しい試験、package.json（版）、docs/CHANGELOG.md、README.md。
- 触らない: アプリのログアウト（src/api.ts:161-168・server/http.ts:147-155）、server/auth.ts、利用量バー、hooks/、scripts/ac-hooks.mjs、~/.claude 配下、キーチェーン、既存の roles。

## 維持の仕組み

- 守り手: 設計者（Opus）。
- K3（送るのは 3 つだけ）・K4（保存しない）・K8（再開記録に入らない）を単体試験で固定する。金型とトークンは `npm run lint` が CI で守る。

## 10. 設計審査（Fable REVISE）と PO 回答への対応（§0〜§9 より優先）

### 10-0 PO の切り替え実績（2026-10-13 22:05 JST に読み取りで確認）

- 【事実】`claude auth status --json`: loggedIn true・authMethod claude.ai・subscriptionType max・終了コード 0。
- 【事実】キーチェーン「Claude Code-credentials」の作成日時 = 更新日時 = 2026-10-13 21:42:18 JST。ログアウトで消えて、ログインで新しく作られた、という PO の手順（先に logout）と合う。
- 【未確認】この設計者の会話が 21:42 より前から続いていたか。「切り替えても動いている会話は止まらない」の証拠には使わない（工程0で確かめる）。
- 【未確認】logout なしで上書きできるか。PO の回答に従い、命令は logout→login の順にする（下記 10-2）。

### 10-1 役割名の表示（HIGH-1）

- src/components/SessionList/SessionList.tsx:39-42 `roleLabel` に「`roleId === ACCOUNT_LOGIN_ROLE_ID` なら `t("role.accountLogin")`」の 1 分岐を足す。触るファイルに追加。
- 定数 `ACCOUNT_LOGIN_ROLE_ID = "account-login"` は src/types.ts（画面）と server/sessions.ts（サーバー）に同じ値で置く。
- `role.accountLogin` の置き場は src/locales/ja.json:488-492 の最上位 `role`（LOW-3。§3-3 の「位置は工程0で確認」は取り消す）。

### 10-2 ログイン命令と e2e（HIGH-2・PO 回答）

- 本番の値（agent-console.config.json）: `"accountLoginCommand": ["/bin/zsh", "-ic", "claude auth logout; claude auth login"]`。logout が失敗しても（既に未ログイン等）login に進むよう `;` でつなぐ。
- 確認ダイアログの本文（`ac.account.confirmBody`）を差し替える:「この Mac の Claude からいったんログアウトして、別のアカウントでログインし直します。動いている会話も新しいアカウントに切り替わります。途中でやめると、ログインし直すまで全部の会話が止まります。開いた端末の案内に沿って、ブラウザでログインしてください。」 → §11-2 の確定文で置き換え
- e2e 用（触るファイルに追加）:
  - tests/fixtures/e2e-env.ts の config 生成（:101-148）に `accountLoginCommand: ["/bin/sh", "-c", `"${claudeBin}" auth logout; "${claudeBin}" auth login`]` を足す。
  - playwright.config.ts:28-40 に `STUB_AUTH_FILE`（auth status の応答 JSON）と `STUB_AUTH_LOG`（auth logout / login の引数記録）を足す。
  - tests/fixtures/claude-stub.sh: `auth status` は `$STUB_AUTH_FILE` を出し、loggedIn が false なら exit 1。`auth logout` と `auth login` は引数を `$STUB_AUTH_LOG` に 1 行ずつ追記して exit 0。
  - K6 の判定: `$STUB_AUTH_LOG` が「auth logout」「auth login」の 2 行だけ。
  - K7 の手順: 切り替えを押す前に STUB_AUTH_FILE の email を書き換える → 端末が停止する → 10 秒以内に `account-email` の文字が新しい値になる。

### 10-3 工程0 をアプリの端末で行う（HIGH-3・MEDIUM-6）

§9 工程0 を次に置き換える。コード変更は不要。

- (a) PO が、今のアプリの役割「シェル」（agent-console.config.json:47）で新しい端末を開き、その中で次を行う:
  1. `claude auth status --text`（今のアカウント）
  2. `claude auth logout; claude auth login`（別アカウント）
  3. ブラウザが開くか／開かなければ URL を自分で開けるか／「Paste code here」にアプリの端末から貼って完了するか
  4. `claude auth status --text`（別アカウントに変わったか）
  5. その間に、別の会話（Opus か Sonnet）が 1 回応答できるか
  6. 2〜4 を元のアカウントでもう一度（元に戻す）
- (b) 設計者が読み取りで: (a) の最中に `claude agents --json` がログインのプロセスを行に出すか（出すと hub.ts:521-524 で名前が差し替わる）。`time claude auth status --json` を 3 回測る（2 秒を超えたら 60 秒間隔を伸ばす）。
- 結果を本書 §11 に書いてから実装カードを出す。(a) のどれかが × なら実装に進まず PO に戻す。

### 10-4 K3 の書き直し（HIGH-4）

- K3: 「`/api/account` の応答のキーは status・loggedIn・email・subscriptionType だけ。orgId・orgName・configDirectory・projectsDirectory・authMethod・apiProvider・analyticsDisabled は無い」。単体試験は実物と同じ 10 キーの JSON を入れて、7 キーが落ちることで判定。

### 10-5 再開記録の除外（MEDIUM-1）

- server/restore.ts:74 の `.filter((s) => !s.exited && s.routineId === undefined)` に `&& s.roleId !== ACCOUNT_LOGIN_ROLE_ID` を足す。触るファイルに追加。
- K8 の試験は tests/unit/session-restore.integration.test.ts の作法で「account-login を 1 つ開いた後の open-sessions.json に入っていない」。

### 10-6 予約 id（MEDIUM-2）

- server/config.ts の roles 検証（:236-246）で `roles[i].id === "account-login"` を拒否する: `config: roles[${i}].id "account-login" is reserved`。tests/unit/config.test.ts に 1 件。

### 10-7 fetchAccount の分岐（MEDIUM-3・MEDIUM-7）

|起きたこと|返す値|
|---|---|
|成功（終了コード 0）|stdout を parse|
|失敗で、err.stdout が空でない文字列（終了コード 1 = 未ログインを含む）|err.stdout を parse（code は見ない）|
|失敗で、それ以外（ENOENT・timeout で killed・stdout 空）|`{ status: "error" }`|
|parse できない／型が違う|`{ status: "invalid" }`|

- err は `unknown` として型ガードを書く。
- stdout の中身（メール・組織名）を console.error 等のログに出さない。出してよいのは長さと分岐名だけ。
- §3-1「例外は握りつぶさず状態に変える」は「失敗は上の表の状態に変える（agents.ts:100-119 と同じ作法）」に読み替える。

### 10-8 createAccountLogin の中身（MEDIUM-4）

- `cwd = config.salesanchorRoot`、`branch = null`、`name = "account-login"`。
- 上限: `hasCapacity()` で判定し、超えたら `SessionInputError("too many sessions")`。
- 同時: `roleId === ACCOUNT_LOGIN_ROLE_ID && !exited` が 1 つでもあれば `SessionConflictError`（http.ts:413-416 で 409）。画面は `ac.account.busy`。
- `accountLoginCommand` が無いときの `POST /api/account/login` は 404。
- Config 型は `accountLoginCommand?: string[]`（省略可。既存の試験の Config 生成を壊さない）。

### 10-9 取り直しの判定と testid（MEDIUM-5）

- ConsolePage は `useRef` に前回の `Map<会話id, state>` を持つ。roleId が account-login の会話が「stopped 以外 → stopped」に変わったら `refreshKey` を 1 増やす。
- data-testid: `account-badge`（全体）・`account-email`・`account-plan`・`account-switch`（ボタン）。

### 10-10 LOW の扱い

- LOW-1: 端末の出力（ログイン URL・貼ったコード）はサーバーのメモリに残り、再接続で再送される（server/ws.ts:24、ファイルには書かれない）。一回限りの値で、ログイン完了後は使えない。確認ダイアログの後の案内として README に「終わったら『一覧から外す』」を書く。
- LOW-2: ログイン端末にもチャット・変更・PR のタブが出る。今回は隠さない（素のシェルと同じ扱い）。
- LOW-4: フッターは折り返す（src/pages/ConsolePage.css:48-58）。1 段に収まるかは K11 の PO 目視に含める。
- LOW-5: 版は 0.16.0 の予定。先に別の版がマージされたら、その次の番号にする。
- LOW-6: §7「利用量バーは前のアカウントの値のまま」は【推測】（根拠なし）。工程4で観察して記録する。
- 照合ずれ: governance の px 直書きは scripts/check-design-governance.mjs:89-125。recon §A の grep は server/keychain.ts（キーチェーンの account 名）にも当たるが、利用者アカウントの取得箇所 0 件は変わらない。

### 10-11 再審査（Fable APPROVE・2026-10-13）の残り指摘への対応

- MEDIUM-A: tests/fixtures/e2e-env.ts（偽物用ファイルの作成 :64-94、export :152-163 と同じ作法）で `authFile`（初期値: `{"loggedIn":true,"email":"stub@example.com","subscriptionType":"max"}`）と `authLog`（空）を作り、`AC_E2E_AUTH_FILE` / `AC_E2E_AUTH_LOG` として export する。playwright.config.ts で `STUB_AUTH_FILE: process.env.AC_E2E_AUTH_FILE`、`STUB_AUTH_LOG: process.env.AC_E2E_AUTH_LOG` に写す。K7 の試験は `process.env.AC_E2E_AUTH_FILE` を書き換える。
- LOW-A〜C: K6 の表・§9 工程0・§3-2 の role id を §10 に合わせて直した。
- LOW-D: 今後の工程記録では、キーチェーンの日時などのメタデータも読まない。アカウントの確認は `claude auth status` だけで行う。

## 11. 工程0 の結果と設計の修正（2026-10-13 夜・§0〜§10 より優先。Fable 再審査 REVISE を反映済み）

### 11-1 観測した事実

- アプリの端末で `claude auth logout; claude auth login` を実行し、最後まで完了した。出力は「Successfully logged out」→ URL 表示 →「Paste code here if prompted >」→「Login successful.」。コードの貼り付けが必要で、アプリの端末から貼り付けて成功した（PO の貼り付け出力と y 回答）。
- ログイン後の `claude auth status`: PO 本人のメール（h***@gmail.com）、subscriptionType max。
- 【未確認】切り替える前と、戻した後のアカウント。今回のログインは、21:50・22:05・22:18 の確認と同じ orgId に入り直した結果だった。§10-3 (a) 6 の「元のアカウントに戻す」往復は【未実施】。往復は工程4（K11）で行い、3 時点（前・切替後・戻し後）を伏せ字で記録する。
- 切り替えた後も、既存の会話「Agent Console2 引き継ぎ」（Session ID ffa7d9cd…）は月の上限の表示を返した（PO の観測）。この会話の `/status` には `Auth token: CLAUDE_CODE_OAUTH_TOKEN` と出ていた。保存されたログインではなく、環境変数の長期トークンで動いていた。
- 2026-10-13 22:23 頃の読み取り調査（Sonnet・値は出していない）:
  - 動いている claude の会話 11 本（開始時刻 10/13 03:13〜17:28）は、すべて環境に CLAUDE_CODE_OAUTH_TOKEN を持っていた。
  - agent-console のサーバー（PID 29605、4319 番で待ち受け）の環境には無かった。
  - ~/.zshrc とそこから読み込むファイル、~/.claude/settings.json、LaunchAgents、launchctl、agent-console のソースと設定にも記載は無かった（PO は先にターミナルからトークンを削除済み）。
  - 子の環境は、サーバーの環境を複製して作る（server/sessions.ts:76-86, :273）。除外リストはこの変数を含まない（server/config.ts:206）。
- 同じ会話を開き直した後の `/status`（Session ID は同じ ffa7d9cd…、Peer address は 51928 から 31774 に変化）: `Auth token` の行が消え、`Login method: Claude Max account` と PO 本人のメールになった。履歴を保ったまま、保存されたログインに切り替わった。
- §10-3 (b) の測定:
  - `claude auth status --json` の所要時間は 0.15 秒（3 回、設計者の調査時に測定）。2 秒を下回るため、60 秒間隔は変えない。
  - 【未確認】ログインの最中に `claude agents --json` がログインのプロセスを行に出すか（測っていない）。表示名の乱れは K11 の PO 目視で確認する。乱れがあれば hub.ts:521-524 の扱いを別便で設計する。
- 【未確認】11 本の会話に変数が入った経路（削除前の ~/.zshrc からかどうか）。
- 【未確認】長期トークンを持たない会話（保存されたログインで動く会話）が、logout 直後や切り替え直後に、開き直さずにどうなるか。公式文書が保証しているのは「Not logged in の会話」だけ（recon §B）。PO がトークンを削除したので、次に切り替えるときは、開いている会話はこの種類になる。

### 11-2 設計への反映

- 前提: agent-console のサーバーの環境に CLAUDE_CODE_OAUTH_TOKEN を置かない。置くと、子の会話が全部トークンで動き、帯の表示と食い違う。README の同じ節にも書く。CHILD_ENV_BLOCKLIST への追加は今回しない（挙動が変わるため対象外）。
- 環境変数 CLAUDE_CODE_OAUTH_TOKEN を持つ会話は、`claude auth login` では切り替わらない。開き直すまで、起動したときのトークンを使い続ける。
- 確認ダイアログの本文（`ac.account.confirmBody`）を、次の文で確定する（§3-2・§10-2 の文は無効）。未確認の側は安全側に書く:
  「この Mac の Claude からいったんログアウトして、別のアカウントでログインし直します。途中でやめると、ログインし直すまで、新しい会話は使えず、開いている会話も止まることがあります。開いている会話は、閉じて開き直すと新しいアカウントで動きます。開いた端末の案内に沿って、ブラウザでログインしてください。」
  - 「新しい会話は使えず」の根拠: サーバーの環境にトークンが無い（11-1）＋ 公式「Not logged in」（recon §B）。
- K5（§2 の表を置き換え）:「アカウントを切り替える」を押すと ConfirmModal が出る。本文が ja.json `ac.account.confirmBody` の値と `toHaveText` で一致し、「開き直す」と「新しいアカウント」を含む。「やめる」を押すと `POST /api/account/login` が呼ばれない（STUB_AUTH_LOG が空のまま）。判定: e2e。
- AccountBadge が表示するのは、サーバーから見た保存済みのログインである。会話ごとの実際の認証（トークンかどうか）は表示しない。理由は、他プロセスの環境を読むのは「秘密を読まない」原則（docs/handoff/stage1/design.md:85）に反するため。誤読を防ぐため:
  - 帯のラベル `ac.account.label` を「Claude ログイン」にする（表示は「Claude ログイン: <メール>」）。
  - バッジに `title` 属性 `t("ac.account.hint")`「この Mac に保存されたログインです。会話ごとの確認は /status で行います。」を付ける。部品は増やさない。
  - K1 の判定文も「Claude ログイン: <メール>」に合わせる。
  - README に「会話ごとの確認は `/status` で行う」と書く。
- 工程4（実地確認）に次を足す。
  - 長期トークンを持たない会話を 1 本開いたまま切り替える。logout の直後（login 完了前）にその会話が応答できるかを記録する。login 完了後、開き直さずに `/status` を見て、移るかどうかも記録する。
  - 結果がどうなっても、ダイアログの文は上の確定文のまま変えない（変えるなら別便で PO 承認）。
- PO 承認では、「注意書きを §3-2・§10-2 の文から 11-2 の確定文に変える」ことを明示して y/n を取る（:9 の PO 回答の前提が変わるため）。

### 11-3 状態

- Fable 再審査（§11）: APPROVE（2026-10-13）。残り LOW-A（0.15 秒の測定時刻）: 時刻の記録が無いため【未確認】のまま。工程4 で時刻付きで測り直す。
- PO 承認: 2026-10-13、設計者の質問「この設計で作り始めてよいですか？（注意書きを §11-2 の確定文に変える）」に PO が「y」。
