# ci-flake-fix recon（2026-11-01 JST）

本線 HEAD ff5997594（v0.49.0）を基準に読んだ。行番号はすべてこの版。失敗の記録は、落ちた回 a8a0836a4 などの CI ログ（GitHub Actions、ジョブのログ全文）から取った。

## 1. 数（実測）

- 本線への push 30 回（2026-10-16 03:51〜11-01 04:28 UTC）: 緑 11・赤 19。落ちたジョブ 21（macOS 19・ubuntu 2。ubuntu の 2 本は同じ回の macOS も赤）。
- PR の CI（macOS ジョブ、やり直しを含む全試行）: 113 回、緑 80・赤 33。やり直しがあった PR 19 件。赤のあとやり直して緑になって合流した PR 8 件（#42 #48 #50 #53 #57 #62 #65 #87）。
- 必須の確かめ（Branch Protection / ruleset）は無い（API で 404・[]）。

## 2. 落ちた試験（本線 30 回分、省略なし）

|試験|回数|機械|誤り|
|---|---|---|---|
|tests/e2e/pc-meter.spec.ts:99 K4（CPU を top と比べる）|14|macOS|差の上限 15（:125）。実測の差 40.57 / 19.96 / 21.72 / 16.10 / 28.06 / 35.43 / 15.35 / 18.84 / 35.22 / 16.73 / 29.85 / 21.36 / 17.71 / 17.03|
|tests/unit/hub-write-lock.test.ts:83（印が他に取られている間の…）|3|macOS 2・ubuntu 1|`[pasted("待ち"), "\r"]` の想定に対し、貼り付けだけで `"\r"` が無い（:93）|
|tests/unit/tmux-host.integration.test.ts の所要時間（AC_TMUX_TIMING=1 の段）|2|macOS|12 件のつなぎ直し 1131ms（上限 1000、:44）／10MB 1834ms（上限 1500、:43）|
|tests/unit/routines.test.ts:154（v0.29.0）|1|macOS|names の呼び出しが 2 回の想定で 1 回（:163）|
|tests/e2e/console.spec.ts:1004（v0.4.0 K1〜K6）|1|ubuntu|端末の先頭が貼り付けでなく `/rename diff-target\r`（:1073 の `ALL:"\u001b[200~` が合わない）|
|tests/e2e/file-link.spec.ts:45・relay.spec.ts:26|各 1|ubuntu|セッション作成が 201 でなく 400|

- 記録の「open-sessions: save failed」「picks: skipping unreadable」は緑の回にも同数出る。壊れたファイルを読む試験の想定の文で、誤りではない。

## 3. 原因（コードの流れと観測の一致）

### R1 pc-meter K4
- アプリの CPU は 2 秒ごとの定期計測の値。比べる相手は、そのあと別に走らせる `top -l 2 -n 0 -s 2`（:119）。測る 2 秒の窓が別。
- K4 は PO の Mac での受入の基準（docs/handoff/pc-meter/design.md の成功条件表 K4「生出力を保存」）。設計時の実測の差は 0.5〜7.9pt（同 :22）。共有の CI 機では他の処理で CPU が上下し、差は最大 40.57。

### R2 hub-write-lock :83
- 予約を足すと、送る処理を待たずに 1 回始める（server/hub.ts:454 の `void this.flushChatQueue(...)`）。送る処理が動いている間の 2 回目はすぐ戻る（:529）。
- 試験は印を外したあと `pollAgents()` を 1 回待ち、すぐ `[貼り付け, "\r"]` を確かめる（test:91-93）。先に始まった送る処理が「貼り付け→待つ→Enter」の途中だと、試験の poll はすぐ戻り、Enter の前に確かめる。観測（貼り付けだけ）と一致。
- 同じファイルの 1 つ目の試験は、同じ理由で `await until(() => written(id).includes("\r"))` を入れている（:73-74、コメント「予約の登録でも送信が走るため、Enter が書かれるまで待つ」）。2 つ目には無い。

### R3 routines :154
- 試験の設定 `TIMING = { namePollMs: 5, nameTimeoutMs: 20 }`（:44）。waitName（server/launch.ts:88-96）は 20ms の間に 5ms ごとに表示名を確かめる。
- この試験は 2 回目で一致する作り（:159 `polls >= 2`）。5ms の sleep が混んだ機械で 15ms 以上かかると、2 回目の前に時間切れ。観測（1 回）と一致。
- setup の既定の displayNames は空の Map（:51）＝一致しない。setup を使う試験は全部 waitName を時間いっぱい待つ。nameTimeoutMs を全体で延ばすと、その分だけ全試験が遅くなる。

### R4 tmux の所要時間
- CI の段（.github/workflows/ci.yml:69-73）は AC_TMUX_TIMING=1 で 1 回だけ測り、1 回の値で合否を決める。経緯: docs/handoff/keep-sessions/design.md:395（R5）で「CI で単独・AC_TMUX_TIMING=1 で判定する」と決め、macOS CI の 10MB だけ 1.5 秒にした。
- 本線 30 回の CI ログの値（`[10MB]`・`[reattach x12]` の行、timing check on の段）:

|機械|項目|上限|最小|中央値|90%|最大|上限超え|
|---|---|---|---|---|---|---|---|
|macOS|10MB|1500|575|819|1078|1834|1/30|
|macOS|restore x12|1000|211|558|955|1131|1/30|
|macOS|probe x12|1000|119|223|272|371|0/30|
|ubuntu|10MB|1000|407|661|747|843|0/30|
|ubuntu|restore x12|1000|148|195|219|284|0/30|
|ubuntu|probe x12|1000|60|76|87|110|0/30|

- 中央値は上限の半分程度。1 回の値だけが時々跳ねる。ESC の判定（:248）は既に中央値を使っている。

### R5 console.spec の連続実行と後片付け（ubuntu の 400）
- POST /api/sessions の 400 は SessionInputError（server/http.ts:216 の sessions.create）。create の 400 の条件は名前の形・知らない役割・ブランチ名の形・「too many sessions」（server/sessions.ts:347 ほか）。上限 16（DEFAULT_MAX_SESSIONS）。名前と役割はこの 2 試験では条件に当たらない。
- console.spec.ts はファイル全体が連続実行（:70 `mode: "serial"`）。試験の注記「これまでの試験でセッション数の上限（16）に達している」（:957、v0.3.8 K1 の中）。ensureRoom(1)（:980-984）は上限ちょうどまで埋める。
- 残った窓を閉じる closeAllSessionsViaApi（:1458）は、後ろの 5 試験の中（:1471・1563・1627・1649・1670）だけで呼ばれる。ファイル単位の afterAll は無い（:1725 は describe「アカウント切り替え」の中で account-login の窓だけ消す）。
- この回は 44 番目（:1004）が落ち、連続実行のため後ろの試験は動かず、窓が 16 のまま。同じサーバー（playwright.config.ts の app プロジェクト、workers 1）で次に動く file-link と relay の窓作りが 135ms で 400。応答の本文はログに無いので「too many sessions」とは記録で確かめていない（コードの流れで残る条件はこれだけ）。
- Playwright 公式: ファイル直下の test.afterAll は、そのファイルの試験が失敗しても実行される（失敗でワーカーを止める前に afterAll を走らせる。microsoft/playwright workerMain.ts、docs class-test.md「afterAll」）。Context7 で確認。

### R6 console.spec.ts:1004 の /rename
- 新しい窓には最初の入力待ちで /rename が 1 回書かれる。送るかは定期取得の名前が initialName と同じかで決まる（server/hub.ts:382-400 flushInitialNames、:400 `agent.name === initialName`）。
- 試験は窓を作る前に名前のファイルを書く（console.spec.ts:1009 `writeFileSync(NAME_FILE, "diff-target")`→:1010 apiCreate）。
- 偽の Claude（tests/fixtures/claude-stub.sh）は名前のファイルを先に読み（:13 NAME）、あとで窓の一覧を取る（:18 PIDS）。1 回の定期取得が「試験が書く前に NAME を読む → 窓ができた後に ps」をまたぐと、新しい窓の名前は古い値（空）に見え、/rename が送られる。端末の先頭が /rename だった観測と一致。手元での再現はしていない。
- 端末の文字の先頭に同じ文字が 32 個並ぶのは、@xterm/xterm 6.0.0 の文字幅を測る部品（WidthCache.ts:16 `REPEAT = 32`、:164 `el.textContent = c.repeat(...)`）を試験が端末の文字として一緒に読んでいるため。失敗の原因ではない（表示の読みにくさだけ）。

### R7 隠れる仕組み
- CI で前の段が落ちると、build と画面の試験は走らない（ci.yml:74-76 に if が無い）。本線 30 回のうち macOS で画面の試験が走らなかった回 5。その回の画面の試験の結果は分からない。
- 連続実行のファイルで 1 つ落ちると後ろは動かない（ubuntu の回は 80 試験中 23 が未実行）。

## 4. 未確認
- ubuntu の 400 の応答本文（ログに無い）。
- PR の赤の割合（33/113）が本線（19/30）より低い理由。
- R2・R3・R6 は手元で再現していない（design の検証で再現を作る）。

## 6. 訂正（2026-11-01、設計審査第1回の指摘）
- hub-write-lock の行番号（:121・test:119-121）と ci.yml の行番号（:290-294・:295-297）を、HEAD の実物（hub-write-lock.test.ts 114 行・ci.yml 76 行）に合わせて :93・:91-93・:69-73・:74-76 に直した。

## 5. 既存 ADR・設計の検索
- このリポジトリに docs/adr は無い。設計の正本は docs/handoff/*。関係するもの: pc-meter/design.md（K4）、keep-sessions/design.md:395・420-422（tmux の所要時間の判定と CI 段）、v0.3.9-test-flake/design.md（試験だけの直しの前例。版を上げない）、ci-badge/design.md。
- Sales Anchor 側: ADR-1029（マージ前の審査の見張り）の STRICT_CHECK_REPOS にこのリポジトリを足すのが次の段。この直しはその前提（赤が試験の揺れで出ない状態）を作る。
