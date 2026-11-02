# ci-flake-fix design（第5.1版、2026-11-02 JST）

参照: docs/handoff/ci-flake-fix/recon.md（R1〜R7・数の表）、docs/handoff/v0.3.9-test-flake/design.md（試験だけの直しの前例）、docs/handoff/pc-meter/design.md:80（K4）、docs/handoff/keep-sessions/design.md:395・420（tmux の所要時間の判定と CI 段）。行番号は D1〜D7 が origin/main ff5997594、D8・D9 が release/ci-flake-fix 022433e（D1〜D7 を入れた後）の実物。

## 0. 目的
- 本線の CI が、アプリの不具合ではない「試験の作り」と「CI の段の作り」で赤くならないようにする。
- 次の段（Sales Anchor 側の見張り ADR-1029 の STRICT_CHECK_REPOS にこのリポジトリを足し、確かめが緑でない PR の合流を止める）の前提を作る。今は赤がやり直しで消える（recon §1: やり直して緑で合流 8 件）。
- 基準値: 本線 push 30 回で赤 19（recon §1）。

## 1. 成功条件

|基準|検証方法|
|---|---|
|S1 この PR の CI を 10 回走らせ（初回＋やり直し 9 回）、macOS・ubuntu の 20 ジョブすべて緑。10 回全部を数える（緑になるまでやり直した回だけを数えない）|`gh api repos/GEN-RYU-System/agent-console/actions/runs/<id>/attempts/<n>/jobs` の conclusion を 10 回分ファイルに保存。緑 20/20|
|S2 hub-write-lock.test.ts と routines.test.ts を、負荷（busy loop 8 本）の下で各 20 回、直す前と後に実行。直した後の失敗 0/20。直す前の回数も記録する（0 なら「再現せず」と書く）|scratchpad の load.sh。毎回の rc を出力|
|S3 揺れの再現（直す前に必ず落ちる形で確かめる）: (a) hub-write-lock の 2 つ目の試験で、`h.hub.checkChat` を 3 秒待ってから元を呼ぶ形に試験の中だけで一時的に包む。直す前は :93 が落ちる（3 回中 3 回）、直した後は 3 回中 3 回合格し、:89 は `[]`・:90 は `["queued"]` のまま。(b) routines の :44 の nameTimeoutMs を一時的に 2（namePollMs 5 より短い）にし、:154 の試験だけを `npx vitest run tests/unit/routines.test.ts -t "sends the name first, waits for the matching display name"` で 3 回回す（`-t` は正規表現なので、かっこを含む末尾 `(v0.29.0)` は入れない）。毎回、実行された試験が 1 件であることを出力で確かめる（0 件や 2 件以上なら止まる）。直す前は 3 回中 3 回、:163 で呼び出しが 1 回になって落ちる。直した後は :44 を同じく 2 にしても試験ごとの 2000 が勝ち、3 回中 3 回合格|下の「一時の変更の戻し方」の確かめ rc=0。生出力を保存|
|S4 偽の Claude の読み順: tests/fixtures/claude-stub.sh を一時的に書き換え、名前の読みと ps の間に `sleep 2` を入れる。console.spec.ts:1004 を 3 回。旧の順（名前→ps）では 3 回中 1 回以上、端末の先頭が /rename になる（0 回なら「再現せず」と書いて止まる）。新の順（ps→名前）では 3 回中 3 回合格。新の順で落ちたときは、落ちた行を保存し、sleep による時間切れ（page の 15000・試験の 90000）でないかを確かめてから × とする|下の「一時の変更の戻し方」の確かめ rc=0。生出力を保存|
|S5 後片付け: console.spec.ts:1010 の apiCreate の直後に一時的な `throw` を入れる。窓の数を読むため、tests/e2e/file-link.spec.ts の先頭に一時的な試験を 1 つ足し、`${BASE}/api/state` の sessions の数を `console.log("[S5] sessions=<n>")` で出す。`npx playwright test --project app tests/e2e/console.spec.ts tests/e2e/file-link.spec.ts tests/e2e/relay.spec.ts` を回す。直す前は 16 で file-link・relay が 400、直した後は 0 で file-link・relay が合格。直す前が 16 未満なら、その値を書いて止まる|下の「一時の変更の戻し方」の確かめ rc=0。窓の数と生出力を保存|
|S6 CI の段: npm test が赤でも build と画面の試験が走る（skipped にならない）。ジョブ全体は赤のまま|使い捨てのブランチで単体の試験を 1 つ落とした下書き PR を作り、その回の各段の conclusion とジョブの conclusion を保存。確かめた後に PR を閉じブランチを消す|
|S7 pc-meter K4: PO の Mac（CI 以外）では ±15 の比べを今まで通り行い、CI では行わない|手元の半分: PO の Mac で、CI を入れずに `npm run build` の後 `npx playwright test tests/e2e/pc-meter.spec.ts` rc=0 と保存された k2-k3-k4.json（K4 は Mac だけで動く。pc-meter.spec.ts:100）。取るのは PO の Mac で動く評価役（実装役がクラウドで動く場合も）。CI の半分: S1 の 10 回の macOS ジョブで pc-meter の試験が合格。macOS ジョブのログの `[K4] CI: ±15 check skipped` の行は補足とする（list の出力に試験の console.log が出るかは未確認。出なければその事実を書く）|
|S8 tmux の所要時間: 上限の値は変えない（D9 の macOS の CI の restore だけを除く）。AC_TMUX_TIMING=1 のときだけ 3 回測り中央値で判定。AC_TMUX_TIMING が無いとき（npm test）は今まで通り 1 回|git diff で上限の定数（tmux-host.integration.test.ts:41-45）は D9 の 1 行の追加だけ。npm test のログで `[10MB]`・`[reattach x12]` が各 1 行、timing の段で各 3 行と中央値の行|
|S11 日付の境目（D8）: 下の §5 の時刻ずらしの道具で、tests/unit/daily-use.integration.test.ts のファイル全体を、開始時刻 4 つ（ずらさず・2026-11-01T23:43:00Z・23:55:00Z・M）で各 3 回回す。M は、ずらさない回のファイルの所要時間（vitest の Duration）の半分だけ 2026-11-02T00:00:00Z より前の時刻（秒で切り捨て。ファイルの途中で日付が変わる回）。M の値と元の所要時間を記録する。直す前は 23:55 で 3 回中 3 回落ちる（2026-11-02 のクラウドの再現では K12 の 4 件。ファイル全体では数が変わってよいので、落ちた試験の名前を記録する）。直す前に 23:55 で 3 回中 3 回落ちなければ、値を書いて止まる（直しの効き目を確かめられないため）。直した後は 4 つ × 3 回の 12 回すべて合格|毎回の rc と、vitest の試験の数・落ちた名前の生出力を保存|
|S12 つなぎ直しの上限（D9）: macOS の CI だけ restore の上限が 1500、それ以外（手元・ubuntu）は 1000 のまま。probe の上限は全部 1000 のまま|git diff。S1 の 10 回の macOS ジョブの `[reattach x12] median` の行の restore が 1500 以下|
|S9 typecheck・lint・npm test・build・test:e2e が手元で全部 rc=0|生出力|
|S10 本番のコード（server/・src/・extension/）を変えない|`git diff --name-only origin/main...HEAD` が次の 10 個とこのフォルダの card.md だけ: docs/handoff/ci-flake-fix/recon.md・design.md、tests/e2e/pc-meter.spec.ts、tests/unit/daily-use.integration.test.ts、tests/unit/hub-write-lock.test.ts、tests/unit/routines.test.ts、tests/unit/tmux-host.integration.test.ts、tests/e2e/console.spec.ts、tests/fixtures/claude-stub.sh、.github/workflows/ci.yml|

## 2. 対象と対象外

### 対象（9 か所。すべて試験・試験の道具・CI）

#### D1 tests/e2e/pc-meter.spec.ts:125
- 変更前: `expect(Math.abs(api - (100 - idle))).toBeLessThanOrEqual(15);`
- 変更後:
  ```ts
  // K4 の ±15 は PO の Mac での受入の基準（docs/handoff/pc-meter/design.md K4）。CI の共有の機械では、測る 2 秒の窓のずれで差が 40 を超える（docs/handoff/ci-flake-fix/recon.md R1）ので、CI では範囲（0〜100）だけを確かめる
  if (process.env.CI !== "true") expect(Math.abs(api - (100 - idle))).toBeLessThanOrEqual(15);
  ```
  そして、繰り返しの外（試験の最後、値の保存の後）に 1 回だけ `if (process.env.CI === "true") console.log("[K4] CI: ±15 check skipped (recon R1); range 0-100 checked");` を足す。
- 0〜100 の確かめ（:123-124）と値の保存（:127-128）は残す。
- CI=true は GitHub Actions が必ず入れる（公式 variables「Always set to true」。このリポジトリも tmux-host.integration.test.ts:43 で同じ値を使っている）。CPU の計算そのものは tests/unit/pc-meter.test.ts:20-32・:78 が確かめている。

#### D2 tests/unit/hub-write-lock.test.ts:86-87（2 つ目の試験）
- 原因（recon R2、審査で細かく確かめた）: :86 の POST が送る処理を待たずに 1 回始める（server/hub.ts:454）。その処理が、まだ印を確かめる前（hub.ts:558 の checkChat の中）にいる間に、試験が :87 で印を取り、:88 の pollAgents は「送る処理が動いている」（hub.ts:529）ですぐ戻る。印が外れた後に先の処理が送る。だから :93 で Enter がまだ無い。
- 変更: :87 `expect(h.hub.tryBeginWrite(id)).toBe(true);` の直後に、POST が始めた送る処理が終わるまで待つ 1 行を足す。
  ```ts
  // POST の予約でも送る処理が 1 回走る（server/hub.ts:454）。それが終わるまで待ち、:88 の定期取得が必ず印の下で動くようにする（recon R2）
  await until(() => !(h.hub as unknown as { chatFlushing: Set<string> }).chatFlushing.has(id));
  ```
- これで先の処理は印に当たって予約のまま戻り、:88 の定期取得は印の下で動き（:89 `[]`・:90 `queued` は本当に印を確かめる）、:92 の定期取得が貼り付け→待つ→Enter を全部待つので :93 は待ちなしで成り立つ。:93 の前に `until` は足さない（足すと、印の下で何も動かなかった回も緑になり、印を確かめない試験になるため）。
- 残る競り合いが 1 つある: POST が始めた処理が、試験の fetch が戻る前に印の確かめ（hub.ts:566）まで進むと、:87 の tryBeginWrite が false になって :87 で落ちる。ps を 2 回動かし終えるまでにループバックの応答が返らない場合だけで、本線 30 回では出ていない。黙って緑になるのでなく目に見えて落ちるので残す。将来 :87 で落ちたら、新しい不具合と取り違えずにこれを疑う。
- chatFlushing は hub.ts:122 の private。型を外して読むのは試験の中だけで、本体は変えない。
- 確かめる中身（:89・:90・:93 の値）は変えない。

#### D3 tests/unit/routines.test.ts
- setup（:55）の opts に `timing?: Partial<typeof TIMING>` を足し、:70 の `TIMING` を `{ ...TIMING, ...opts.timing }` にする。
- :155 の `await setup()` を `await setup({ timing: { nameTimeoutMs: 2000 } })` にし、注記「2 回目の確かめで一致する試験。混んだ機械で 5ms の休みが延びても時間切れにしない。一致した時点で戻るので遅くならない。vitest の既定の 5 秒より短くし、一致しない不具合は :163 の確かめで落ちるようにする」。
- 全体の TIMING（:44）と、時間切れの道を確かめる :168 の試験は変えない（全体を延ばすと、表示名が一致しない既定の setup を使う試験がすべて延びるため。recon R3）。

#### D4 tests/unit/tmux-host.integration.test.ts:411-462
- 10MB（:411-436）と 12 件のつなぎ直し（:438-462）の本体を、それぞれ「1 回測る関数」にまとめ、`const rounds = TIMING ? 3 : 1` 回呼ぶ。
- 役割 "big"（:25）は 1 つの窓で 1 回しか出力しない。そのため毎回 testSocket()・start・mk から作り直す。回の終わりに窓を close し、その回の harness も `await h.close()`（10MB）・`await h2.close()`（つなぎ直し）で閉じる。前の回のサーバーが残って次の回の負荷にならないようにする。afterAll（:79-82）の close は `.catch` 付きなので、2 回閉じても害はない。
- 毎回の値を今の行の形のまま出す（`[10MB] ...`・`[reattach x12] ...`）。TIMING のときは最後に `[10MB] median ...ms`・`[reattach x12] median probe ...ms restore ...ms` の行を出し、中央値を上限と比べる。sha256 の確かめは毎回行う。
- 上限の定数（:41-45）は変えない。ESC（:248）は既に中央値なので変えない。
- 試験の時間の上限: 10MB は 90000 のまま（中央値 819ms・最大 1834ms の 3 回で足りる）。12 件は 120000 を足す（今は vi.setConfig の 40000）。§5 の手順 1 で、直す前の 2 つの試験の 1 回分の所要時間（vitest の試験ごとの時間）を記録し、3 倍が 90000・120000 に収まることを確かめる。収まらなければ止まって報告する。
- 理由: 本線 30 回の値（recon R4 の表）で中央値は上限の半分程度で、1 回の値だけが時々跳ねる。上限を上げず、判定を 1 回の値から 3 回の中央値に変える。
- 過去の決定の修正: keep-sessions/design.md:395（R5）の「1 回の値で判定」を「3 回の中央値で判定」に改める（§4 に記録）。

#### D5 tests/e2e/console.spec.ts:70 の直後
- ファイル直下に足す:
  ```ts
  // 連続実行で途中が落ちると後ろの試験が動かず、窓が上限（16）のまま残って、同じサーバーで次に動くファイルの窓作りが 400 になる（recon R5）。ファイル直下の afterAll は失敗しても走る（Playwright 公式 test.afterAll）
  test.afterAll(async () => {
    // 窓は 1 つずつ閉じる。1 つで最大 5 秒待ち（server/sessions.ts:26）、終わらなければ強制終了してさらに 2 秒待つ（:28・:784-792）。16 ×（5 + 2）秒 = 112 秒なので 120 秒とる
    test.setTimeout(120000);
    await closeAllSessionsViaApi();
  });
  ```
- closeAllSessionsViaApi（:1458）はファイル直下の関数宣言なので上から呼べる。使う BASE・BEARER（:13-14）は読み込みの時に決まる。今の 5 か所の呼び出しは残す。
- hook の時間は、指定しなければ試験の時間（playwright.config.ts:22 の 30000）と同じ（Playwright 公式 test-timeouts）。足りないと閉じ切れずに同じ 400 が残るので、120000 にする。

#### D6 tests/fixtures/claude-stub.sh:12-15 と :18
- 名前の読み（:12-15 の 4 行。注記・NAME・`NAME_JSON=""`・`[ -n ... ]`）を、PIDS の行（:18）の後ろへ移す。UUID_MODE（:16-17）はそのまま。
- 注記を 1 行足す「名前は ps の後に読む。ps に出た窓は、試験が名前のファイルを書いた後に作られたものなので、後に読めば必ずその名前が見える（逆の順だと古い名前が新しい窓に付き、/rename が送られる。recon R6）」。
- 使う所は tests/fixtures/e2e-env.ts:68-69（e2e の 2 つのサーバー）だけ。単体の試験 9 ファイルは同じファイル名の別の偽物を自分で書いている（例 hub-write-lock.test.ts:24-25）ので、影響はない。
- 他の行は変えない。返す形は同じ。

#### D7 .github/workflows/ci.yml:59-76
- 変更前（:59-60・:64-66・:74-76）:
  ```yaml
        - name: sa-sync
          run: node scripts/sa-sync.mjs
  ...
        - run: npm run typecheck
        - run: npm run lint
        - run: npm test
  ...
        - run: npm run build
        - run: npx playwright install --with-deps chromium
        - run: npm run test:e2e
  ```
- 変更後:
  ```yaml
        - name: sa-sync
          id: sasync
          run: node scripts/sa-sync.mjs
  ...
        # 前の段が落ちても後ろの段の結果を出す（recon R7）。sa-sync が通っていないと何も確かめられないので、それだけを条件にする
        - run: npm run typecheck
          if: ${{ !cancelled() && steps.sasync.outcome == 'success' }}
        - run: npm run lint
          if: ${{ !cancelled() && steps.sasync.outcome == 'success' }}
        - run: npm test
          if: ${{ !cancelled() && steps.sasync.outcome == 'success' }}
  ...
        - run: npm run build
          id: build
          if: ${{ !cancelled() && steps.sasync.outcome == 'success' }}
        - run: npx playwright install --with-deps chromium
          id: pwinstall
          if: ${{ !cancelled() && steps.build.outcome == 'success' }}
        - run: npm run test:e2e
          if: ${{ !cancelled() && steps.build.outcome == 'success' && steps.pwinstall.outcome == 'success' }}
  ```
- sa-sync の env（:61-62）、tmux の段（:69-73、`if: always()`）、それより前の段は変えない。
- ジョブの合否は変わらない（どの段も continue-on-error を使わないので、1 段でも落ちればジョブは赤）。変わるのは、落ちた段の後ろも走って結果が見えること。S6 で実物を確かめる。
- 書き方は GitHub 公式（expressions「always は避け `!cancelled()` を使う」・`!` で始まる式は `${{ }}` が要る。contexts「steps.<id>.outcome は success・failure・cancelled・skipped」）。Context7 で確認。

#### D8 tests/unit/daily-use.integration.test.ts:455-461（「unread on reply」の時計）
- 原因（2026-11-02 の調べ。生の記録は /tmp/CC報告ファイル/ci-flake-fix/s1/cause_recon_20261102.md）:
  - :452 で試験の時計 T を本物の時刻の 1,000,000ms（約 16.7 分）先から始め、:457 で hub の時計だけを T に替える。
  - 記録の書き込み（:463 dayFile、:464 で定義する stopAt の :467 の appendFileSync）は T の UTC の日付のファイル名（events-YYYYMMDD.jsonl）に書く。
  - 記録を読む側（server/activity.ts:267 の now）は本物の時計のまま。:304-305 で「本物の今日と昨日」のファイルしか読まない。
  - そのため、本物の時刻が UTC 23:43 ごろ（日本時間 8:43 ごろ）から 0:00 までの間は、T が翌日になり、書いたファイルが読まれない。未読が 1 にならず 0 のまま落ちる。T は試験の中でさらに進む（K12 で合わせて約 186.7 秒）ので、後ろの試験ほど早い時刻から落ちる（クラウドの K12 だけの再現では 23:42 開始から、CI のファイル全体では 23:40 開始の回で落ちた）。
- 実物の失敗: S1 の 10 回のうち 6 回目（2026-11-01T23:40 UTC 開始・K12 の 2 件）と 7 回目（23:50 UTC 開始・K1 から K12 まで 10 件）で、macOS と ubuntu の両方が落ちた（/tmp/CC報告ファイル/ci-flake-fix/d9/fails.txt）。
- 再現（クラウド、時刻ずらし、K12 だけ）: 23:40 は 3 回中 3 回合格、23:42 から落ち始め、23:55・23:59 は 3 回中 3 回落ちる、0:00:30 と 0:10 は 3 回中 3 回合格。fake timers は使っていない。
- 変更: :455-461 の beforeAll・afterAll で、hub と同じく活動記録（h.activity）の時計も T に替え、終わったら戻す。
  - 変更前:
    ```ts
    let realNow: () => number = Date.now;
    beforeAll(() => {
      realNow = hubInternals().now;
      hubInternals().now = () => T.now;
    });
    afterAll(() => {
      hubInternals().now = realNow;
    });
    ```
  - 変更後:
    ```ts
    // 活動記録も同じ T で読む。本物の時計のままだと、T が翌日になる UTC 23:43 以降に、T の日付で書いたファイルを読まない（server/activity.ts:304-305。ci-flake-fix design D8）
    const activityInternals = (): { now: () => number } => h.activity as unknown as { now: () => number };
    let realNow: () => number = Date.now;
    let realActivityNow: () => number = Date.now;
    beforeAll(() => {
      realNow = hubInternals().now;
      hubInternals().now = () => T.now;
      realActivityNow = activityInternals().now;
      activityInternals().now = () => T.now;
    });
    afterAll(() => {
      hubInternals().now = realNow;
      activityInternals().now = realActivityNow;
    });
    ```
- now は server/activity.ts:257 の private readonly。:457 の hub と同じく、型を外して替えるのは試験の中だけで、本体は変えない。
- 替えた時計が効く所（server/activity.ts の this.now() は :268・:304・:543・:573 の 4 か所）:
  - :268 の startedAt は作った時（:452 より前）に決まり、替えても変わらない。T は本物より先なので、:278 の「startedAt より前の記録は数えない」に当たらない。
  - :304 読むファイルの日付。これを T に合わせるのが今回の直し。
  - :543 動いている担当の 24 時間の判定（RUNNING_MAX_AGE_MS、:9）と :387 の 7 日の削除は、16.7 分先と約 3.1 分の進みでは境目に届かない。
  - :573 pruneOldFiles は本番のポートのサーバーだけが呼ぶ（:571 の注記）。
- 戻した後の影響: 戻すと、読むファイルの組が本物の日付に戻る。T が翌日だった回では「本物の昨日」の読み位置が :306 で消えており、昨日のファイルがあれば頭から読み直す。この試験の dataDir は harness を起動するたびに新しく作る（tests/unit/helpers/harness.ts:173 の mkdtempSync・:202）。ファイルが入るのはこの回に書いた分だけなので、本物の昨日のファイルが入るのは、この試験ファイルの実行中に本物の日付が変わった回だけ。この describe（:450〜:681）はファイルの最後なので、戻した後に動く試験はこのファイルには無い。活動記録を書くのもこの describe だけ。害は無いが、S11 の M（ファイルの途中で本物の日付が変わる回）で確かめる。
- 選ばなかった案: (a) dayFile（:463）を本物の日付にする。記録の ts（T）と入れるファイルの日付が食い違い、本物では起きない形の記録になる。(b) T を本物の日の中に収める。境目の時刻が変わるだけで、なくならない。

#### D9 tests/unit/tmux-host.integration.test.ts:44 と :484（12 件のつなぎ直しの restore の上限）
- 原因（S1 の 10 回の macOS ジョブのログ。生の記録は /tmp/CC報告ファイル/ci-flake-fix/d9/）:
  - 3 回目の macOS だけが、restore の 3 回の中央値 1029ms で上限 1000 を超えて落ちた（`expected 1029.0755830000016 to be less than or equal to 1000`）。
  - 1 回ごとの restore の値（40 個 = 10 回 × npm test の 1 回と timing の段の 3 回）: macOS は 155〜1099ms で、1000 を超えたのは 1029・1038・1099 の 3 個（mac_rounds_sorted.txt）。ubuntu は 171〜307ms（同じ 40 個）。
  - 中央値（timing の段 10 回）: macOS は 159〜1029ms（mac_medians.txt）。
  - probe の中央値は macOS でも 108〜283ms で、上限 1000 に遠い。
- 既にある同じ形の決まり: 10MB の上限は「macOS の CI だけ 1.5 秒」（:42-43。CI の macOS 1031〜1078ms・ubuntu 337〜404ms の実測で決めた）。restore の macOS の値は、当たった CI の機械で大きく変わる（同じコードで 6 回目は 155〜162ms、3 回目は 611〜1099ms）。中央値の macOS / ubuntu の比は 0.56〜4.5 倍で、10 回中 4 回は 2 倍未満、6 回目と 10 回目は macOS の方が速い。遅い機械に当たった回だけ 1000 を超える。ubuntu と手元は 1000 のままなので、本当に遅くなればそこで落ちる。
- 変更:
  - :44 の後ろに 1 行足す。
    ```ts
    /** 12 件のつなぎ直しの restore の上限。手元（単独）は設計目標の 1 秒。macOS の CI だけ 1.5 秒（CI の macOS 1 回ごとの実測 155〜1099ms、ubuntu は 171〜307ms。2026-11-01 の 10 回。ci-flake-fix design D9） */
    const REATTACH_X12_RESTORE_MAX_MS = process.platform === "darwin" && process.env.CI === "true" ? 1500 : 1000;
    ```
  - :484 `expect(restore).toBeLessThanOrEqual(REATTACH_X12_MAX_MS);` を `expect(restore).toBeLessThanOrEqual(REATTACH_X12_RESTORE_MAX_MS);` にする。
  - :451 の注記「上限の値は変えない」を「上限の値は変えない（macOS の CI の restore だけ 1.5 秒。ci-flake-fix design D9）」にする。
  - :483 の probe と、:44 の REATTACH_X12_MAX_MS（1000）は変えない。手元と ubuntu の restore の上限も 1000 のまま。
- 1500 にした根拠: 10MB と同じ値にそろえる（同じ機械の同じ理由）。macOS の CI の 1 回ごとの最大 1099ms に対して 36% の余裕。中央値で判定するので、1 回だけの跳ねでは落ちない。
- 選ばなかった案: (a) 回数を 3 から 5 に増やす。中央値 1029 の回があり、5 回で下がるかの実測が無い。時間も延びる。(b) 上限を全部の機械で上げる。手元の設計目標（keep-sessions の 1 秒）まで緩める理由が無い。

### 対象外
- 本番のコード（server/・src/・extension/）。9 種類ともアプリの不具合ではない（recon R1〜R6・D8・D9 の原因）。
- 端末の文字に xterm の幅を測る部品の 32 文字が混ざること（recon R6 の最後）。失敗の原因ではなく、直すと試験の読み方が変わる。今回は変えない。
- console.spec.ts の連続実行（serial）そのものの見直し。ファイルをまたぐ影響は D5 で止まる。ファイルの中の後ろの試験が動かない件は残る（§7）。
- Playwright の retries（自動のやり直し）は足さない。やり直しは揺れを隠し、次の段の見張りの意味をなくす。
- 版は上げない・CHANGELOG に書かない（前例 v0.3.9-test-flake と同じ。配布物が変わらない）。

## 3. 仕組み（変更前→変更後）
- 試験の順序（D2）: 「先に走った送る処理と試験の確かめが競う」から「先の処理が終わってから印を確かめる」へ。確かめる中身は同じで、印を本当に確かめる。
- 試験の待ち（D3）: 1 つの試験だけ「起きるまで待つ（上限 2 秒）」へ。
- 比べる基準（D1・D4・D9）: 共有の機械の 1 回の値で合否を決めない。D1 は受入の基準を CI から外し、D4 は上限を変えず 3 回の中央値で判定する。D9 は 10MB と同じく macOS の CI だけ restore の上限を 1.5 秒にする。
- 試験の時計（D8）: 「hub だけ試験の時計で、活動記録は本物の時計」から「両方とも試験の時計」へ。日付の境目でファイルの読み書きが食い違わない。
- 試験の道具（D6）: 偽の Claude の読み順を、本物の順序の保証（ps に出た窓は名前を書いた後にできた）に合わせる。
- 後片付け（D5）: 窓を閉じるのを「後ろの試験が動くこと」に頼らず、ファイルの終わりに必ず行う。
- 見える範囲（D7）: 前の段が落ちても後ろの段の結果が出る。

## 4. SSOT・安全・戻し方
- SSOT: 上限の値（tmux :41-45、セッション上限 16、K4 の 15）は今の場所のまま。D9 の restore の上限は、同じ定数の並び（:44 の後ろ）に置く。ほかに値の置き場所を作らない。D3 の 2000・D4 の 120000・D5 の 120000 は、それぞれ 1 つの試験の中だけの値。
- 過去の決定の修正: keep-sessions/design.md:395（R5）の所要時間の判定を、1 回の値から 3 回の中央値に改める。上限の値と「CI で単独・AC_TMUX_TIMING=1 で判定」は変えない。ただし D9 で、12 件のつなぎ直しの restore だけ macOS の CI の上限を 1.5 秒にする（手元の設計目標 1 秒は変えない）。
- 安全: 本番のコード・設定・秘密に触れない。ci.yml の権限（permissions）は変えない。
- 戻し方: この PR の merge commit を `git revert -m 1`。試験と CI だけなので戻しても配布物は変わらない。
- 測り方: §1 の S1〜S10。合流後は本線の push ごとの CI を数え、§7 の見張りの段で使う。

## 5. 検証の手順（実装役が行う）
一時の変更の戻し方（手順 1 と手順 3 の両方で守る。S3・S4・S5）: 一時の変更は 1 つずつ入れて回し、回し終えたらすぐ `git checkout -- <file>` で戻す。戻したら、その作業場所で `git diff --exit-code -- tests/unit/hub-write-lock.test.ts tests/unit/routines.test.ts tests/fixtures/claude-stub.sh tests/e2e/console.spec.ts tests/e2e/file-link.spec.ts` が rc=0 であることを確かめる。直す前の写しでも同じ確かめを行う。push の前に `git status --porcelain` が空であることを確かめる。

1. 直す前の写し（origin/main から切った別の作業場所）で、S2・S3・S4（旧の順）・S5（直す前）を取り、tmux の 2 つの試験の所要時間（D4）を記録する。生出力を保存。
2. D1〜D7 を入れて commit する（一時の変更を入れる前に必ず commit する）。
3. S2・S3・S4（新の順）・S5（直した後）・S7・S8・S9・S10 を取る。
4. PR を作り、S1（10 回）と S6（使い捨ての下書き PR）を取る。
5. 第5版（D8・D9）: D1〜D7 は 022433e で入っている。D8・D9 は 022433e の上に足す。直す前（022433e）の写しで S11 を取る。D8・D9 を入れて commit し、直した後で S11・S12・S9（この Mac の評価役が build・test:e2e を含めて全部 rc=0 をもう一度取る）・S10 を取る。S1 の 10 回は D8・D9 を push した後に初めから数え直す。
   - 時刻ずらしの道具（S11。commit しない。scratchpad に置く）: 次の中身の shift.cjs を `NODE_OPTIONS=--require <shift.cjs のフルパス> AC_SHIFT_TO=<開始時刻> TZ=UTC npx vitest run tests/unit/daily-use.integration.test.ts` で読み込ませる。2026-11-02 のクラウドの再現では、この形で vitest の中の時刻がずれた（cause_recon_20261102.md の表）。
     ```js
     // AC_SHIFT_TO の時刻から始まったことにする（試験の確かめだけに使う一時の道具）
     const RealDate = Date;
     const off = RealDate.parse(process.env.AC_SHIFT_TO) - RealDate.now();
     if (!Number.isFinite(off)) throw new Error("shift.cjs: AC_SHIFT_TO が読めない");
     class ShiftDate extends RealDate {
       constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); }
       static now() { return RealDate.now() + off; }
     }
     globalThis.Date = ShiftDate;
     ```
     ずれの量は、プロセス（vitest の親と各 worker）ごとに、そのプロセスが起動した時刻を基準に決まる。worker の起動は親より少し後なので、worker の中の開始時刻は AC_SHIFT_TO より数秒以内だけ先になる。各回の出力に、試験の中の開始時刻（`new Date().toISOString()` を shift.cjs の読み込みの時に 1 回 stderr へ出す）を残す。
     ずらさない回は NODE_OPTIONS と AC_SHIFT_TO を付けない。毎回、vitest の出力の試験の数が直す前と後で同じことを確かめる（数が違えば止まる）。
6. 生出力のパスを PR 本文に書く。数が §1 と合わないときは止まって報告する（推測で書かない）。

## 外部・過去事例
- 社内の前例: v0.3.9-test-flake（共有の状態を試験ごとに分けて、負荷下 20 回で失敗 0/20。直す前 4/20）。同じ形の負荷試験を S2 に使う。負荷で再現しない場合に備え、S3 で必ず落ちる形の再現も作る。
- 公式の決まり: Playwright（ファイル直下の afterAll は失敗しても走る・hook の時間は既定で試験の時間）、GitHub Actions（`!cancelled()`・steps.<id>.outcome・CI=true）。Context7 で確認した。
- 他社の数値の事例は使わない。今回の判断は、自分の CI の実測（recon の表）と公式の挙動で決まり、他社の数で決める点が無いため。

## 維持の仕組み
- 先に走る処理がある試験は、その処理が終わってから確かめる（hub-write-lock の注記）。待つ試験は試験ごとの timing（routines）で「起きるまで待つ」形にする。各所に理由の注記を残す。
- 所要時間の判定は中央値（tmux の 3 項目すべて）。新しい所要時間の判定も中央値にする（注記に書く）。macOS の CI だけ上限を変えるときは、実測の範囲と日付を定数の注記に書く（:42 と D9 の形）。
- 試験の中で時計を替えるときは、その時刻を使う本体の部品（hub・活動記録）を全部同じ時計に替える（daily-use の注記に書く）。
- 窓を作る e2e のファイルは、ファイル直下の afterAll で閉じる（console.spec の注記に書く）。

## 7. 次の段への申し送り（この PR の範囲外）
- Sales Anchor の見張り ADR-1029 の STRICT_CHECK_REPOS に GEN-RYU-System/agent-console を足す。S1 の結果と、合流後の本線 10 回の赤の数を前提の根拠にする。
- やり直して緑で合流した 8 件（recon §1）は、見張りの設計で「やり直しの扱い」を決める材料にする。
- console.spec の連続実行で後ろの試験が動かない件は、見張りを入れた後の赤の数で直すかを決める。

## 審査の記録
- 第1版（2026-11-01）: REVISE。blocker 2（hub-write-lock と ci.yml の行番号が実物に無い）・should-fix 7・nit 6。審査記録は手元の scratchpad（acrecon/review_v1.md）。
- 第2版での対応: 行番号を実物で確かめて直した（recon §6 にも訂正を記録）。D2 を「待つ」から「先の処理を終わらせて印を確かめる」に変えた。D4 に回ごとの harness の close、D5 に hook の時間、D6 に使う所の正しい記述、D7 に変更前後の YAML を足した。D1 に CI の記録の行、D3 の値を 2000 に変えた。成功条件に必ず落ちる再現（S3）、throw の位置と窓の数（S5）、許すファイルの一覧（S10）を足した。keep-sessions R5 の修正を §4 に記録した。
- 第2版（2026-11-01）: REVISE。blocker 0・should-fix 3（S3(b) の値が必ず落ちる値でない・一時の変更の戻しの確かめが commit 前だと成り立たない・S5 の窓の数の読み方が無い）・nit 5。審査記録は手元の scratchpad（acrecon/review_v2.md）。D1〜D7 は実物と合うと確かめられた。
- 第3版での対応: S3(b) を :44 を 2 にする形に変えた。§5 に commit してから一時の変更を入れる手順と戻しの確かめの命令を書いた。S5 に窓の数を読む一時の試験と命令を書いた。D5 に 112 秒の計算、D2 に :87 で落ちる残りの競り合い、D4 に所要時間の記録、S4 に時間切れとの見分け、S7 に macOS だけ・取る人・ログの行が未確認であることを足した。
- 第3版（2026-11-01）: REVISE。blocker 0・should-fix 1（S3(b) の `-t` に完全な名前を入れると、末尾のかっこが正規表現として読まれて試験が選ばれない）・nit 2。審査記録は手元の scratchpad（acrecon/review_v3.md）。第2版の指摘はすべて解消と確かめられた。
- 第4版での対応: `-t` を正規表現の記号を含まない一部分にし、実行された試験が 1 件であることの確かめを足した。句点の抜けを直した。戻し方の段落を手順の前に移し、手順 1 と 3 の両方にかかると書いた。
- 第4版（2026-11-01）: APPROVE（設計合格）。blocker 0・should-fix 0・nit 1（節の番号の飛び。見た目だけで参照は壊れていない）。審査記録は手元の scratchpad（acrecon/review_v4.md）。未確認として残るのは、Playwright の list 表示に試験の console.log が出るか（S7 の補足。合否は頼らない）。設計合格は PO の実装承認を兼ねない。
- S1（第4版の直し、2026-11-01T15:07Z〜、10 回）の結果: 緑 7 回・赤 3 回（/tmp/CC報告ファイル/ci-flake-fix/d9/s1_attempts.txt）。赤の 3 回は、3 回目が macOS の 12 件のつなぎ直しの restore（D9）、6 回目と 7 回目が UTC 23:40・23:50 開始の日付の境目（D8）。D1〜D7 で直した 7 種類の失敗は 10 回で 0 回。S1 は ×。PO の決定（2026-11-02「1」: 新しく分かった 2 つを設計に足し、審査を通してから直し、10 回をもう一度確かめる）で第5版にした。
- 第5版での対応: D8（活動記録の時計も T に替える）・D9（macOS の CI だけ restore の上限 1.5 秒）を足した。成功条件に S11（4 つの時刻で日付の境目の確かめ）・S12 を足し、S8・S10 を直した。§5 に時刻ずらしの道具と手順を書いた。
- 第5版（2026-11-02）: REVISE。blocker 0・should-fix 5（:681 より後に試験は無い・「2〜5 倍」がログと合わない・S11 の直す前の停止条件が無い・card の S10 の数え方・card の終わりの条件と Mac の S9 の担当）・nit 7。審査記録は手元の scratchpad（acrecon/review_v5.md）。D8・D9 の変更前のコードと効き目、D9 の数、時刻ずらしの道具が worker に届くこと（vitest 5.0.3 の既定 pool は forks、env は process.env から作る）は確かめられた。
- 第5.1版での対応: 5 件と nit 7 件をすべて直した。S11 の 4 つ目の時刻を、ファイルの所要時間から決める M にした。
