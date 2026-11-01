# ci-flake-fix design（第1版、2026-11-01 JST）

参照: docs/handoff/ci-flake-fix/recon.md（R1〜R7・数の表）、docs/handoff/v0.3.9-test-flake/design.md（試験だけの直しの前例）、docs/handoff/pc-meter/design.md（K4）、docs/handoff/keep-sessions/design.md:395・420-422（tmux の所要時間の判定と CI 段）。

## 0. 目的
- 本線の CI が、アプリの不具合ではない「試験の作り」と「CI の段の作り」で赤くならないようにする。
- 次の段（Sales Anchor 側の見張り ADR-1029 の STRICT_CHECK_REPOS にこのリポジトリを足し、確かめが緑でない PR の合流を止める）の前提を作る。今は赤がやり直しで消える（recon §1: やり直して緑で合流 8 件）。
- 基準値: 本線 push 30 回で赤 19（recon §1）。

## 1. 成功条件

|基準|検証方法|
|---|---|
|S1 この PR の CI を 10 回走らせ（初回＋やり直し 9 回）、macOS・ubuntu の 20 ジョブすべて緑。やり直しで緑にした回を数に入れない（10 回全部を数える）|`gh api .../actions/runs/<id>/attempts/<n>/jobs` の conclusion を 10 回分ファイルに保存。緑 20/20|
|S2 hub-write-lock.test.ts と routines.test.ts を、負荷（busy loop 8 本）の下で各 20 回、直す前と後に実行。直した後の失敗 0/20。直す前の回数も記録（0 なら「再現せず」と書く）|scratchpad の load.sh。毎回の rc を出力|
|S3 偽の Claude の読み順: 名前の読みと ps の間に `sleep 2` を入れた写しで、console.spec.ts:1004 を 3 回。旧の順（名前→ps）では端末の先頭が /rename になって落ち、新の順（ps→名前）では 3/3 合格|写しは scratchpad で作り、AC_E2E の stub を差し替えて実行。生出力を保存|
|S4 後片付け: console.spec.ts:1004 に一時的な `throw` を入れて app プロジェクトを実行。直す前は file-link・relay が 400 で落ち、直した後は file-link・relay が合格|一時の変更は検証の後に戻し、git diff で戻ったことを確かめる。生出力を保存|
|S5 CI の段: npm test が赤でも build と画面の試験が走る（skipped にならない）|使い捨てのブランチで単体の試験を 1 つ落とした下書き PR を作り、その回の各段の conclusion を保存。確かめた後に PR を閉じブランチを消す|
|S6 pc-meter K4: PO の Mac（CI 以外）では ±15 の比べを今まで通り行い、CI では行わない|手元で `npx playwright test tests/e2e/pc-meter.spec.ts` rc=0 と保存された k2-k3-k4.json。CI のログで K4 の比べが飛ばされた注記|
|S7 tmux の所要時間: 上限の値は変えない。AC_TMUX_TIMING=1 のときだけ 3 回測り中央値で判定。AC_TMUX_TIMING が無いとき（npm test）は今まで通り 1 回|git diff で上限の定数（:41-45）が不変。npm test のログで `[10MB]`・`[reattach x12]` が各 1 行、timing の段で各 3 行と中央値の行|
|S8 typecheck・lint・npm test・build・test:e2e が手元で全部 rc=0|生出力|
|S9 本番のコード（server/・src/・extension/）を変えない|`git diff --name-only origin/main...HEAD` が下の「対象」のファイルだけ|

## 2. 対象と対象外

### 対象（7 か所。すべて試験・試験の道具・CI）
- D1 tests/e2e/pc-meter.spec.ts:125
  - 変更前: `expect(Math.abs(api - (100 - idle))).toBeLessThanOrEqual(15);`
  - 変更後: `if (process.env.CI !== "true") expect(Math.abs(api - (100 - idle))).toBeLessThanOrEqual(15);` とし、直前に注記「K4 の ±15 は PO の Mac での受入の基準（docs/handoff/pc-meter/design.md K4）。CI の共有の機械では測る 2 秒の窓のずれで差が 40 を超える（docs/handoff/ci-flake-fix/recon.md R1）ので、CI では範囲（0〜100）だけを確かめる」。0〜100 の確かめ（:123-124）と値の保存（:127-128）は残す。
- D2 tests/unit/hub-write-lock.test.ts:120-121
  - `await h.hub.pollAgents();` と `expect(written(id)).toEqual([pasted("待ち"), "\r"]);` の間に `await until(() => written(id).includes("\r"));` を足す。注記は 1 つ目の試験（:73）と同じ文。確かめる中身（toEqual の値）は変えない。
- D3 tests/unit/routines.test.ts
  - setup（:55）の opts に `timing?: Partial<typeof TIMING>` を足し、:70 の `TIMING` を `{ ...TIMING, ...opts.timing }` にする。
  - :155 の `await setup()` を `await setup({ timing: { nameTimeoutMs: 5000 } })` にし、注記「2 回目の確かめで一致する試験。混んだ機械で 5ms の休みが延びても時間切れにしない。一致した時点で戻るので遅くならない」。
  - 全体の TIMING（:44）と、時間切れの道を確かめる :168 の試験は変えない（全体を延ばすと、表示名が一致しない既定の setup を使う試験がすべて延びるため。recon R3）。
- D4 tests/unit/tmux-host.integration.test.ts:411-458
  - 10MB（:411）と 12 件のつなぎ直し（:438）の本体を「1 回測る関数」にまとめ、`const rounds = TIMING ? 3 : 1` 回呼ぶ。役割 "big"（:25）は 1 つの窓で 1 回しか出力しないので、毎回 testSocket()・start・mk から作り直し、最後に close する。毎回の値をログに出し（今の行の形のまま）、TIMING のときだけ中央値を上限と比べる。sha256 の確かめと後片付けは毎回行う。
  - 上限の定数（:41-45）は変えない。ESC（:248）は既に中央値なので変えない。
  - 2 つの試験の時間の上限: 10MB は 90000 のまま、12 件は 120000 を足す（3 回分）。
  - 理由: 本線 30 回の値（recon R4 の表）で中央値は上限の半分程度、1 回の値だけが時々跳ねる。上限を上げず、判定を 1 回の値から中央値に変える。
- D5 tests/e2e/console.spec.ts:70 の直後
  - ファイル直下に `test.afterAll(async () => { await closeAllSessionsViaApi(); });` を足す。注記「連続実行で途中が落ちると後ろの試験が動かず、窓が上限（16）のまま残って、同じサーバーで次に動くファイルの窓作りが 400 になる（recon R5）。ファイル単位の afterAll は失敗しても走る（Playwright 公式 test.afterAll）」。
  - closeAllSessionsViaApi（:1458）は関数宣言なので、上で使える。今の 5 か所の呼び出しは残す。
- D6 tests/fixtures/claude-stub.sh:12-15 と :18
  - NAME の読み（:12-15 の注記・NAME・NAME_JSON の 3 行）を、PIDS の行（:18）の後ろへ移す。足す注記「名前は ps の後に読む。ps に出た窓は、試験が名前のファイルを書いた後に作られたものなので、後に読めば必ずその名前が見える（逆の順だと古い名前が新しい窓に付き、/rename が送られる。recon R6）」。
  - 他の行は変えない。単体の試験 9 ファイルもこの stub を写して使う（recon の stub users）が、読む順だけの変更で、返す形は同じ。
- D7 .github/workflows/ci.yml:280-297
  - sa-sync の段に `id: sasync`。typecheck・lint・npm test・build に `if: ${{ !cancelled() && steps.sasync.outcome == 'success' }}`、build に `id: build`。playwright install に `id: pwinstall` と `if: ${{ !cancelled() && steps.build.outcome == 'success' }}`、test:e2e に `if: ${{ !cancelled() && steps.build.outcome == 'success' && steps.pwinstall.outcome == 'success' }}`。
  - tmux の段（:290-294 の `if: always()`）は変えない。
  - ジョブの合否は変わらない（どれか 1 段でも落ちればジョブは赤）。変わるのは、落ちた段の後ろも走って結果が見えること。
  - 書き方は GitHub 公式（expressions「always は避け `!cancelled()` を使う」、contexts「steps.<id>.outcome」）。Context7 で確認。

### 対象外
- 本番のコード（server/・src/・extension/）。7 種類ともアプリの不具合ではない（recon R1〜R6）。
- 端末の文字に xterm の幅を測る部品の 32 文字が混ざること（recon R6 の最後）。失敗の原因ではなく、直すと試験の読み方が変わる。今回は変えない。
- console.spec.ts の連続実行（serial）そのものの見直し。ファイルをまたぐ影響は D5 で止まる。ファイルの中の後ろの試験が動かない件は残る（§7 の宿題）。
- Playwright の retries（自動のやり直し）は足さない。やり直しは揺れを隠し、次の段の見張りの意味をなくす。
- 版は上げない・CHANGELOG に書かない（前例 v0.3.9-test-flake と同じ。配布物が変わらない）。

## 3. 仕組み（変更前→変更後）
- 試験の待ち（D2・D3）: 「決まった回数・決まった短い時間で確かめる」から「起きるまで待つ（上限つき）」へ。確かめる中身は同じ。
- 比べる基準（D1・D4）: 共有の機械の 1 回の値で合否を決めない。D1 は受入の基準を CI から外し、D4 は上限を変えず中央値で判定する。
- 試験の道具（D6）: 偽の Claude の読み順を、本物の順序の保証（ps に出た窓は名前を書いた後にできた）に合わせる。
- 後片付け（D5）: 窓を閉じるのを「後ろの試験が動くこと」に頼らず、ファイルの終わりに必ず行う。
- 見える範囲（D7）: 前の段が落ちても後ろの段の結果が出る。

## 4. SSOT・安全・戻し方
- SSOT: 上限の値（tmux :41-45、セッション上限 16、K4 の 15）は今の場所のまま。新しい値の置き場所を作らない。D3 の 5000 は 1 つの試験の中だけの値。
- 安全: 本番のコード・設定・秘密に触れない。ci.yml の権限（permissions: contents: read）は変えない。
- 戻し方: この PR の merge commit を `git revert -m 1`。試験と CI だけなので戻しても配布物は変わらない。
- 測り方: §1 の S1〜S9。合流後は本線の push ごとの CI を数え、§7 の見張りの段で使う。

## 5. 検証の手順（実装役が行う）
1. 直す前の写し（origin/main）で S2・S3（旧の順）・S4（直す前）を取り、生出力を保存。
2. D1〜D7 を入れる。
3. S2・S3（新の順）・S4（直した後）・S6・S7・S8・S9 を取る。
4. PR を作り、S1（10 回）と S5（使い捨ての下書き PR）を取る。
5. 生出力のパスを PR 本文に書く。数が §1 と合わないときは止まって報告する（推測で書かない）。

## 外部・過去事例
- 社内の前例: v0.3.9-test-flake（共有の状態を試験ごとに分けて、負荷下 20 回で失敗 0/20。直す前 4/20）。同じ形の負荷試験を S2 に使う。
- 公式の決まり: Playwright（ファイル単位の afterAll は失敗しても走る）、GitHub Actions（`!cancelled()`、steps.<id>.outcome）。どちらも Context7 で確認した。
- 他社の数値の事例は使わない。今回の判断は、自分の CI の実測（recon の表）と公式の挙動で決まり、他社の数で決める点が無いため。

## 維持の仕組み
- 待つ試験は `until`（hub-write-lock）・試験ごとの timing（routines）で「起きるまで待つ」形にする。各所に理由の注記を残す。
- 所要時間の判定は中央値（tmux の 3 項目すべて）。新しい所要時間の判定も中央値にする（注記に書く）。
- 窓を作る e2e のファイルは、ファイル直下の afterAll で閉じる（console.spec の注記に書く）。

## 7. 次の段への申し送り（この PR の範囲外）
- Sales Anchor の見張り ADR-1029 の STRICT_CHECK_REPOS に GEN-RYU-System/agent-console を足す。S1 の結果と、合流後の本線 10 回の赤の数を前提の根拠にする。
- やり直して緑で合流した 8 件（recon §1）は、見張りの設計で「やり直しの扱い」を決める材料にする。
- console.spec の連続実行で後ろの試験が動かない件は、見張りを入れた後の赤の数で直すかを決める。

## 審査の記録
- 第1版: 未審査。
