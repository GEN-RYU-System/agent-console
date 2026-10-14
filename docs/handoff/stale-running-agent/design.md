# 終わった担当が「動いている担当」に残る（v0.32.1）設計

状態: 設計案（Opus 作成）。PO 委任（2026-10-15「Y」＋同日の離席時の全権委任「PRマージ、デプロイまで完走」）により、Fable 審査 APPROVE 後に実装へ進む。

## 1. 目的（PO に見える変化）
終わった担当が、画面右の「動いている担当」に残り続けない。

## 2. 現在地（事実）
- 現象: セッション ffa7d9cd… の担当（agent_id a31ee361990cf76ae、「ディスクを食っている場所を調べる」）が、2026-10-14 06:36:07Z に終わったのに「動き始めて12時間」と出ている。
- 記録: activity/events-20261014.jsonl に最後の SubagentStart 06:35:56.812Z と、その後の SubagentStop 06:36:07.012Z（行2575、正常行）がある（/tmp/CC報告ファイル/stale-subagent/live-findings.md）。
- 動いているサーバーの応答（GET /api/sessions/4f77ef38…/activity、2026-10-15 PO 許可）: running に key=toolu_01TmaTkh5ogxqV42zD6Y8VhV、startedAt=1791959756812（live-response.json）。
- 原因のコード（origin/main 5f779b6）:
  - server/activity.ts:15 `STOPS_KEEP = 400`、:16 `HANDBACKS_KEEP = 400`、:17 `RESTARTS_KEEP = 400`。
  - server/activity.ts:174-177 `rememberLatest` → :180-184 `trimOldest` は、上限を超えると時刻の古いものから落とす。どの agent_id かは見ない。
  - server/activity.ts:355-360 SubagentStart・SubagentStop は、結び付いていない agent_id（孫の担当・Claude の内部の担当）も同じ Map に入れる。
  - server/activity.ts:490-492 `view()` は startedAt = max(呼び出し, restarts)、endedAt = max(stops, handbacks, 前景の完了)。
- 数（実ファイルのコピーを v0.32.0 の dist に再生、live/replay-dist-fullfile.json・stops-count.txt）: このセッションで stop を持つ agent_id は 1414 個。対象より新しい stop を持つものが 500 個で、対象の stop は落ちた。restarts は 83 個で上限未満のため、06:35:56 の再開は残った。そのため startedAt > endedAt になり「動いている」と判定された。
- 24時間上限（:9 RUNNING_MAX_AGE_MS）で、2026-10-15 15:35:56 JST に表示から消える。サーバーは起動時に全部読み直すため、再起動しても同じ状態に戻る。

## 3. 対象と対象外
- 対象: server/activity.ts の記憶の落とし方だけ。tests/unit/activity.test.ts に試験を足す。版を 0.32.1 にする（package.json・package-lock.json・extension/manifest.json・docs/CHANGELOG.md。前例 v0.9.1・v0.11.1）。
- 対象外: 記録の形（hooks/activity-hook.mjs）、hook の登録、API の形、画面（src/）、各 KEEP の値、24時間上限、starts・posts・files・tasks・chat の落とし方。

## 4. 変更（前 → 後）
- 前: stops・handbacks・restarts の3つの Map は、上限 400 を超えると、時刻の一番古い agent_id から落とす。
- 後: 落とす相手を選ぶとき、「守る agent_id」は落とさず、それ以外の古いものから落とす。守る物以外だけでは足りないときに限り、残りを今までどおり一番古いものから落とす（フォールバック）。
- 守る agent_id: `state.starts` に toolUseId がある `state.posts` の値の agentId のうち空でないもの（starts に無い post・孫の担当は守らない）。数は starts の件数以下＝STARTS_KEEP（400）以下。
- 形: `rememberLatest(map, agentId, ts, keep, protectedIds: ReadonlySet<string>)` とし、`trimOldest` には手を入れない（他の呼び出し元 files・tasks の動きを変えない）。protectedIds は落とす必要があるとき（map.size > keep）だけ呼び出し側で作る。
- 上限は増えない: フォールバックにより、守る集合の大きさに関わらず、3 つの Map は毎回 keep（400）件以内に戻る（posts の件数は上限の根拠にしない。applyPost :409-414 は starts に無い toolUseId でも posts に入れ、posts を消すのは :405 だけのため）。

## 5. 代替案と選ばなかった理由
- A. KEEP を大きくする: 1 セッションの agent_id は今回 1414 個で、上限をいくつにしても長いセッションで再発する。不採用。
- B. 結び付いた agent_id だけを記憶する（他は入れない）: 背景の担当は SubagentStart が PostToolUse（結び付け）より先に届く（findings.md の 06:14:57 の並び）。最初の開始の記録を捨てることになり、動きが今と変わる。不採用。
- C. 採用案（結び付いている物を落とさない）: 普段の動きは変わらず、落とす順だけが変わる。

## 6. リスクと対処
- 計算量: 落とす時だけ posts（400 件以内）から集合を作る。今の trimOldest も毎回並べ替えている。起動時の全読み（今回 1 日分）で時間が大きく延びないことを、再生の所要時間で確かめる（K4）。
- 結び付く前に落ちる: SubagentStart と PostToolUse の間に、結び付いていない 400 件が届く場合だけ。最初の開始は呼び出しの時刻で代わるので、表示は変わらない。

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 結び付いた担当の stop の後に、結び付いていない 500 個の stop が届いても、その担当は running に出ない | tests/unit/activity.test.ts に試験を足す。今の main では失敗し、直した後に通ることを両方記録する |
| K2a handbacks: 結び付いた担当の handback の後に、結び付いていない 500 個の handback が届いても、その担当は running に出ない（終わり判定のまま） | 同上 |
| K2b restarts: 結び付いた担当が stop → 再開（SubagentStart）した後に、結び付いていない 500 個の SubagentStart が届いても、その担当は running に出る（再開が落ちて「終わり」に化けない） | 同上 |
| K3a 3 つの Map の件数が 400 を超えない | K1・K2 の試験で `sizes()` を確かめる |
| K3b フォールバック: 守る集合が keep を超える場合（試験では keep を小さくできないため、starts 400 件すべてが結び付いた状態で、さらに結び付いていない stop を足す等）でも Map の件数は keep 以下 | 同上 |
| K3c 守る集合は starts にある post だけ: starts に無い toolUseId の post（孫など）の agentId は守られない | 同上 |
| K4 実ファイルのコピー（events-20261014.jsonl・同 13・12 等、activity/ にある全日）を新しい dist で再生すると、ffa7d9cd の running に toolu_01TmaTkh5ogxqV42zD6Y8VhV が無い。全セッションについて、上限なし（KEEP を無限にした参照）の再生と running が一致（差 0）。所要時間を前後で記録 | 試験用の一時スクリプト（リポジトリに入れない）。生出力を /tmp/CC報告ファイル/stale-subagent/impl/ に置く |
| K5 既存の試験・型・lint・build が通る | npm の全単体試験・typecheck・lint・build、CI（両 OS） |
| K6 導入後、動いているサーバーで同じ GET を 1 回叩き、running に toolu_01TmaTkh5ogxqV42zD6Y8VhV が無い（15:35 JST より前に確かめた場合だけ意味がある。後なら「上限で消えた」と区別して記録） | /healthz の version 0.32.1 と、GET 1 回の応答を保存 |

## 8. 戻し方
v0.32.0 へ戻す（scripts/ac-rollback.sh）。記録・設定・保存の形は変えないので、戻しても何も残らない。

## 9. 維持する仕組み
K1〜K3 の単体試験が CI で毎回走る。

## 10. 未解決事項（今回は触らない）
- posts には上限が無い（starts に無い toolUseId の post は消えない。:409-414・:405）。今回の実データでは posts 103・starts に無い post 0（/tmp/CC報告ファイル/stale-subagent/review-posts-count.txt）。別便の候補として記録だけ残す。
- K6 は 2026-10-15 15:35:56 JST 以降だと 24 時間上限で消えた場合と区別できない。実施時刻を記録する。

## 審査
- 第1版: Fable REVISE（/tmp/CC報告ファイル/stale-subagent/review-design.md）。上限の根拠・守る集合の限定・K2/K3・前例の版を直して第2版。
- 第2版: Fable APPROVE（/tmp/CC報告ファイル/stale-subagent/review-design-2.md）。「守る集合 > keep」の分岐は今の定数では到達しない防御として残す。
- 実装承認: PO 委任（2026-10-15「Y」と同日の離席時の全権委任）に基づき Opus が 2026-10-15 に実装へ進めると判断。

## 外部事例
不要（社内アプリの記憶の落とし方の不具合で、比べる外部の事例がない）。
