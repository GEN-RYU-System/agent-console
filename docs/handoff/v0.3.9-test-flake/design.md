# v0.3.9 test-flake design

参照: docs/handoff/v0.3.9-test-flake/recon.md、docs/handoff/v0.3.8-session-restore/design.md（K1 に 600ms の条件は無い）。

## 対象

tests/unit/session-restore.integration.test.ts だけ。
- 端末の出力・プロセス出現を待つ waitFor に timeout: 5000（WAIT）。ファイル全体の testTimeout を 30000 に（vi.setConfig）。
- K1「ends the terminal process...」を別 describe「(K1, SIGHUP path)」に分け、closeGraceMs=10000、上限 `< 10000`。
  意図は「SIGHUP で終わり、SIGKILL へ切替える猶予を待たなかった」こと（元の tests/unit/session-restore.integration.test.ts のコメント）。SIGKILL の経路は猶予が満了してから始まるので、猶予より短ければ入っていない。負荷の遅れ（数百 ms）と区別できる。製品コードに SIGKILL の経路に入ったことを直接観測する手段は無いので、経過時間で間接的に示す。
- K2 と K4〜K8 の describe を、試験ごとに新しい harness（beforeEach で作成・afterEach で close）に。K8 は新しい dataDir で動き、前の試験の sync と共有しない。名前と確かめる中身は変えない。
- K1（猶予 600）の describe は afterEach で残ったセッションを閉じる。
- 選んだ理由: afterEach でセッションを閉じるだけでは、閉じる操作が起こす void sync（server/restore.ts の `void this.sync()`）を待てず、次の試験の writeList を上書きされる（recon.md の K7）。新しい harness なら dataDir ごと別になり確実。

## 対象外

- 本番コード（server/、src/）と、外部の書き手との競合。本番に外部の書き手はいないので扱わない。
- 版は上げない・CHANGELOG に書かない（試験と docs だけで配布物が変わらない）。

## 成功条件

|基準|検証方法|
|---|---|
|負荷下（busy loop 8本＋重い3ファイル並列）で session-restore.integration.test.ts を20回実行して失敗0|scratchpad の load2.sh。毎回の終了コード rc を出力。結果 fails=0/20（修正前は4/20）|
|K1 の上限が closeGraceMs（10000）より小さく、SIGHUP 経路を確かめている|試験の closeGraceMs と toBeLessThan の値が同じ定数|
|K8 の名前と確認内容（unreadable・上書きなし・動作継続）が不変|git diff で K8 の本体が変わっていない|
|build・lint・typecheck・npm test・e2e が通る|各 rc=0（npm test: 44 files / 541 tests、e2e: 30 passed）|

## 外部・過去事例

- 一般則: 共有状態を持つ非同期の後始末（fire-and-forget）は、次の試験の準備と競合する。試験ごとに分離した状態（一時ディレクトリ）を使う。Vitest 公式も、試験間で共有する可変状態を避ける方針。
- 社内の過去事例: v0.3.9 restore-guard（docs/handoff/v0.3.9-restore-guard/design.md）も試験が共有する dataDir を一時ディレクトリに分離して解決した。

## 維持の仕組み

- 復元の試験は describe 内で harness を共有しない（beforeEach/afterEach）。コメントに理由を残した。
- 待ち時間は WAIT と SLOW_TEST_MS の定数に集約。新しい待ちはこの定数を使う。
- 負荷試験の手順はこの design.md の成功条件に残した。
