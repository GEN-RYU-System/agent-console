# design: AI の予約の待機上限を 10→20 件にする（v0.43.0）

## 目的（PO の言葉）
- 2026-10-18 PO「上限を増やす、なぜ10件なのか意図はあるか？」→ Opus 提案「20件に」→ PO「y」。

## 事実
- 10件は v0.21.0 の設計時に Opus が技術判断で置いた数で、測定や PO 決定の根拠は無い（docs/handoff/reservations/design.md:164）。
- 2026-10-18 00:56 JST 時点で AI の待機中予約が10件（10/18〜10/24 の測定9件＋2027-01 の1件）あり、10/31 の測定予約の add が 400 `too many pending agent reservations` になった（server/reservations.ts:184）。

## 変更
- server/reservations.ts:23 MAX_AGENT_PENDING 10→20。試験 R11c を20基準に。README・reservations/design.md:96・CHANGELOG・版 0.43.0。
- 変えない: 全体の pending 50件、終了済み200件、定期実行の AI 有効10件、purpose measure 必須、maxSessions。

## 代替案
- 10件のまま枠が空くのを待つ: 測定が週単位で重なるたびに止まるため不採用。
- 上限を外す: 暴走時の歯止めが全体50件だけになるため不採用。20件なら全体50件の内数で、画面の予約に30件残る。

## リスクと対処
- AI の予約が同時刻に重なり多くのセッションが開く: 開始の間隔は restoreStaggerMs 以上、最終の歯止めは maxSessions（既存）。測定目的のみ（purpose measure 必須）は変えない。

## 受入条件
| 基準 | 検証方法 |
|---|---|
| AI の pending 20件目まで 201、21件目は 400 | 単体試験 R11c |
| 画面からの登録・全体50件の上限は変わらない | 既存の単体試験が全部通る |
| 導入後、healthz の版が 0.43.0 | `curl -s http://127.0.0.1:4319/healthz` |
| 導入後、10/31 の測定予約の add が 201 | ac-reserve.mjs add の出力 |

## 戻し方
- `bash scripts/ac-update.sh v0.42.3`（待機中の予約は保存形式が同じなので消えない。10件を超えた分も残り、新しい add だけが止まる）。

## 維持の仕組み
- 上限の数は server/reservations.ts の1か所。README と本書に理由を残す。
