# ci-flake-fix design（第2版、2026-11-01 JST）

参照: docs/handoff/ci-flake-fix/recon.md（R1〜R7・数の表）、docs/handoff/v0.3.9-test-flake/design.md（試験だけの直しの前例）、docs/handoff/pc-meter/design.md:80（K4）、docs/handoff/keep-sessions/design.md:395・420（tmux の所要時間の判定と CI 段）。行番号はすべて origin/main ff5997594 の実物。

## 0. 目的
- 本線の CI が、アプリの不具合ではない「試験の作り」と「CI の段の作り」で赤くならないようにする。
- 次の段（Sales Anchor 側の見張り ADR-1029 の STRICT_CHECK_REPOS にこのリポジトリを足し、確かめが緑でない PR の合流を止める）の前提を作る。今は赤がやり直しで消える（recon §1: やり直して緑で合流 8 件）。
- 基準値: 本線 push 30 回で赤 19（recon §1）。

## 1. 成功条件

|基準|検証方法|
|---|---|
|S1 この PR の CI を 10 回走らせ（初回＋やり直し 9 回）、macOS・ubuntu の 20 ジョブすべて緑。10 回全部を数える（緑になるまでやり直した回だけを数えない）|`gh api repos/GEN-RYU-System/agent-console/actions/runs/<id>/attempts/<n>/jobs` の conclusion を 10 回分ファイルに保存。緑 20/20|
|S2 hub-write-lock.test.ts と routines.test.ts を、負荷（busy loop 8 本）の下で各 20 回、直す前と後に実行。直した後の失敗 0/20。直す前の回数も記録する（0 なら「再現せず」と書く）|scratchpad の load.sh。毎回の rc を出力|
|S3 揺れの再現（直す前に必ず落ちる形で確かめる）: (a) hub-write-lock の 2 つ目の試験で、`h.hub.checkChat` を 3 秒待ってから元を呼ぶ形に試験の中だけで一時的に包む。直す前は :93 が落ちる（3 回中 3 回）、直した後は 3 回中 3 回合格し、:89 は `[]`・:90 は `["queued"]` のまま。(b) routines の :154 の試験を `nameTimeoutMs: 8` で回す。直す前の setup では落ち、直した後（試験ごとの値 2000）は合格|一時の変更は検証の後に戻し、`git diff --exit-code` で戻ったことを確かめる。生出力を保存|
|S4 偽の Claude の読み順: tests/fixtures/claude-stub.sh を一時的に書き換え、名前の読みと ps の間に `sleep 2` を入れる。console.spec.ts:1004 を 3 回。旧の順（名前→ps）では 3 回中 1 回以上、端末の先頭が /rename になる（0 回なら「再現せず」と書いて止まる）。新の順（ps→名前）では 3 回中 3 回合格|検証の後に `git diff --exit-code tests/fixtures/claude-stub.sh` が「直した後の中身」と一致（sleep が残っていない）。生出力を保存|
|S5 後片付け: console.spec.ts:1010 の apiCreate の直後に一時的な `throw` を入れて app プロジェクトを実行。console.spec の実行の直後に /api/state の窓の数を保存する。直す前は 16 のままで file-link・relay が 400、直した後は 0 で file-link・relay が合格|一時の変更は戻し、`git diff --exit-code tests/e2e/console.spec.ts` が「直した後の中身」と一致。窓の数と生出力を保存|
|S6 CI の段: npm test が赤でも build と画面の試験が走る（skipped にならない）。ジョブ全体は赤のまま|使い捨てのブランチで単体の試験を 1 つ落とした下書き PR を作り、その回の各段の conclusion とジョブの conclusion を保存。確かめた後に PR を閉じブランチを消す|
|S7 pc-meter K4: PO の Mac（CI 以外）では ±15 の比べを今まで通り行い、CI では行わない|手元で `npx playwright test tests/e2e/pc-meter.spec.ts` rc=0 と保存された k2-k3-k4.json。CI のログに `[K4] CI: ±15 check skipped` の行が 1 行|
|S8 tmux の所要時間: 上限の値は変えない。AC_TMUX_TIMING=1 のときだけ 3 回測り中央値で判定。AC_TMUX_TIMING が無いとき（npm test）は今まで通り 1 回|git diff で上限の定数（tmux-host.integration.test.ts:41-45）が不変。npm test のログで `[10MB]`・`[reattach x12]` が各 1 行、timing の段で各 3 行と中央値の行|
|S9 typecheck・lint・npm test・build・test:e2e が手元で全部 rc=0|生出力|
|S10 本番のコード（server/・src/・extension/）を変えない|`git diff --name-only origin/main...HEAD` が次の 9 つだけ: docs/handoff/ci-flake-fix/recon.md・design.md、tests/e2e/pc-meter.spec.ts、tests/unit/hub-write-lock.test.ts、tests/unit/routines.test.ts、tests/unit/tmux-host.integration.test.ts、tests/e2e/console.spec.ts、tests/fixtures/claude-stub.sh、.github/workflows/ci.yml|

## 2. 対象と対象外

### 対象（7 か所。すべて試験・試験の道具・CI）

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
- 試験の時間の上限: 10MB は 90000 のまま（中央値 819ms・最大 1834ms の 3 回で足りる）。12 件は 120000 を足す（今は vi.setConfig の 40000）。
- 理由: 本線 30 回の値（recon R4 の表）で中央値は上限の半分程度で、1 回の値だけが時々跳ねる。上限を上げず、判定を 1 回の値から 3 回の中央値に変える。
- 過去の決定の修正: keep-sessions/design.md:395（R5）の「1 回の値で判定」を「3 回の中央値で判定」に改める（§4 に記録）。

#### D5 tests/e2e/console.spec.ts:70 の直後
- ファイル直下に足す:
  ```ts
  // 連続実行で途中が落ちると後ろの試験が動かず、窓が上限（16）のまま残って、同じサーバーで次に動くファイルの窓作りが 400 になる（recon R5）。ファイル直下の afterAll は失敗しても走る（Playwright 公式 test.afterAll）
  test.afterAll(async () => {
    // 窓は 1 つずつ閉じ、1 つで最大数秒かかる（server/sessions.ts:757 closeGraceMs）。16 個分の時間をとる
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

### 対象外
- 本番のコード（server/・src/・extension/）。7 種類ともアプリの不具合ではない（recon R1〜R6）。
- 端末の文字に xterm の幅を測る部品の 32 文字が混ざること（recon R6 の最後）。失敗の原因ではなく、直すと試験の読み方が変わる。今回は変えない。
- console.spec.ts の連続実行（serial）そのものの見直し。ファイルをまたぐ影響は D5 で止まる。ファイルの中の後ろの試験が動かない件は残る（§7）。
- Playwright の retries（自動のやり直し）は足さない。やり直しは揺れを隠し、次の段の見張りの意味をなくす。
- 版は上げない・CHANGELOG に書かない（前例 v0.3.9-test-flake と同じ。配布物が変わらない）。

## 3. 仕組み（変更前→変更後）
- 試験の順序（D2）: 「先に走った送る処理と試験の確かめが競う」から「先の処理が終わってから印を確かめる」へ。確かめる中身は同じで、印を本当に確かめる。
- 試験の待ち（D3）: 1 つの試験だけ「起きるまで待つ（上限 2 秒）」へ。
- 比べる基準（D1・D4）: 共有の機械の 1 回の値で合否を決めない。D1 は受入の基準を CI から外し、D4 は上限を変えず 3 回の中央値で判定する。
- 試験の道具（D6）: 偽の Claude の読み順を、本物の順序の保証（ps に出た窓は名前を書いた後にできた）に合わせる。
- 後片付け（D5）: 窓を閉じるのを「後ろの試験が動くこと」に頼らず、ファイルの終わりに必ず行う。
- 見える範囲（D7）: 前の段が落ちても後ろの段の結果が出る。

## 4. SSOT・安全・戻し方
- SSOT: 上限の値（tmux :41-45、セッション上限 16、K4 の 15）は今の場所のまま。新しい値の置き場所を作らない。D3 の 2000・D4 の 120000・D5 の 120000 は、それぞれ 1 つの試験の中だけの値。
- 過去の決定の修正: keep-sessions/design.md:395（R5）の所要時間の判定を、1 回の値から 3 回の中央値に改める。上限の値と「CI で単独・AC_TMUX_TIMING=1 で判定」は変えない。
- 安全: 本番のコード・設定・秘密に触れない。ci.yml の権限（permissions）は変えない。
- 戻し方: この PR の merge commit を `git revert -m 1`。試験と CI だけなので戻しても配布物は変わらない。
- 測り方: §1 の S1〜S10。合流後は本線の push ごとの CI を数え、§7 の見張りの段で使う。

## 5. 検証の手順（実装役が行う）
1. 直す前の写し（origin/main）で S2・S3・S4（旧の順）・S5（直す前）を取り、生出力を保存。
2. D1〜D7 を入れる。
3. S2・S3・S4（新の順）・S5（直した後）・S7・S8・S9・S10 を取る。一時の変更が残っていないことを `git diff` で確かめる。
4. PR を作り、S1（10 回）と S6（使い捨ての下書き PR）を取る。
5. 生出力のパスを PR 本文に書く。数が §1 と合わないときは止まって報告する（推測で書かない）。

## 外部・過去事例
- 社内の前例: v0.3.9-test-flake（共有の状態を試験ごとに分けて、負荷下 20 回で失敗 0/20。直す前 4/20）。同じ形の負荷試験を S2 に使う。負荷で再現しない場合に備え、S3 で必ず落ちる形の再現も作る。
- 公式の決まり: Playwright（ファイル直下の afterAll は失敗しても走る・hook の時間は既定で試験の時間）、GitHub Actions（`!cancelled()`・steps.<id>.outcome・CI=true）。Context7 で確認した。
- 他社の数値の事例は使わない。今回の判断は、自分の CI の実測（recon の表）と公式の挙動で決まり、他社の数で決める点が無いため。

## 維持の仕組み
- 先に走る処理がある試験は、その処理が終わってから確かめる（hub-write-lock の注記）。待つ試験は試験ごとの timing（routines）で「起きるまで待つ」形にする。各所に理由の注記を残す。
- 所要時間の判定は中央値（tmux の 3 項目すべて）。新しい所要時間の判定も中央値にする（注記に書く）。
- 窓を作る e2e のファイルは、ファイル直下の afterAll で閉じる（console.spec の注記に書く）。

## 7. 次の段への申し送り（この PR の範囲外）
- Sales Anchor の見張り ADR-1029 の STRICT_CHECK_REPOS に GEN-RYU-System/agent-console を足す。S1 の結果と、合流後の本線 10 回の赤の数を前提の根拠にする。
- やり直して緑で合流した 8 件（recon §1）は、見張りの設計で「やり直しの扱い」を決める材料にする。
- console.spec の連続実行で後ろの試験が動かない件は、見張りを入れた後の赤の数で直すかを決める。

## 審査の記録
- 第1版（2026-11-01）: REVISE。blocker 2（hub-write-lock と ci.yml の行番号が実物に無い）・should-fix 7・nit 6。審査記録は手元の scratchpad（acrecon/review_v1.md）。
- 第2版での対応: 行番号を実物で確かめて直した（recon §6 にも訂正を記録）。D2 を「待つ」から「先の処理を終わらせて印を確かめる」に変えた。D4 に回ごとの harness の close、D5 に hook の時間、D6 に使う所の正しい記述、D7 に変更前後の YAML を足した。D1 に CI の記録の行、D3 の値を 2000 に変えた。成功条件に必ず落ちる再現（S3）、throw の位置と窓の数（S5）、許すファイルの一覧（S10）を足した。keep-sessions R5 の修正を §4 に記録した。
- 第2版: 未審査。
