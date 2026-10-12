# v0.3.9 test-flake recon

調査元: /tmp/CC報告ファイル/orca-selfbuilt/restore-guard/k8-flake.md（生ログは同ディレクトリの runs/）。

## 観測された失敗（修正前）

- 負荷下（busy loop 8本＋重い3ファイル並列）で tests/unit/session-restore.integration.test.ts を20回実行して4回失敗。
- K8: tests/unit/session-restore.integration.test.ts の K8 試験。`expected [] to deeply equal [ { reason: 'unreadable' } ]`。前の試験が残した recorder.sync（server/restore.ts の sync → server/session-store.ts の save）が、K8 の putFile した壊れたファイルを rename で置き換える。
- K7 の FRESH 待ち（waitFor 既定 1000ms）、K1 の READY 待ち（既定 1000ms）、K1 の `toBeLessThan(600)`（猶予 closeGraceMs=600 と同値で、負荷の遅れ 6ms で超える）、K2 の試験全体 5000ms。いずれも負荷で時間切れ。
- K7 が落ちるとセッションが残り、後続が連鎖して落ちる。

## 修正後の途中の測定で分かった事実

- 試験全体 timeout と waitFor を延ばした段階で、20回中2回、K7 が `expected '' to contain 'FRESH'` で落ちた。
- 診断のため失敗時のセッション一覧を出した回の出力（/private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/tasks/byrpn2qo4.output）:
  `[["shell-with-id",false,".../ac-it-VE3hpF/root","READY\r\n"]]`
  つまり残っていたのは K4 が作った shell-with-id だけで、K7 の evil は作られていなかった。
- 【推測】K4 の closeAll が残した void sync が K7 の writeList を上書きし、K7 の復元が前のリスト（shell-with-id）を開いた。K8 と同じ競合が、同じ describe の共有 harness の試験間すべてに及ぶ。rename の計器は取っておらず、直接の証拠はない。
- 【未確認】上記の推測が唯一の原因か。ただし試験ごとに新しい harness にした後の負荷下20回は失敗0（design.md）。

## 本番で破れるか

- 【事実】k8-flake.md の「2-B」: 本番の起動経路（recorder.start の直後に hold）では起きない。本番コードは変えない。
