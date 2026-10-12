# 設計: 左の一覧の「CI」の印を、開いている PR のときだけ出す（不具合の修正）

- 状態: 設計者（Opus）が作成。小さな修正なので、Fable の審査はコードの審査とまとめて行う。
- PO の指摘（2026-10-12）: 「CI失敗がずっと表示されているが原因も調べて、これは何のステータスを表している？」
- 調査: docs/handoff/ci-badge/recon.md
- 対象ADR: ADR-067、ADR-144
- 版の番号: 実装の時点の main の次（v0.8.0・v0.9.0 の後なら 0.9.1）。

## 0. 事実（recon より）
- 全部のセッションが salesanchor の本店（ブランチ main）で作業している。
- アプリは `pr list --head main --state all` を使い、閉じた PR を選んでいた（server/pr-status.ts:255-259）。
  - OPEN の PR が無いときは、全体で一番新しいものを選ぶ（:229-232）。
  - 拾っていたのは、2026-10-02 に閉じた #2649（fail 8・pass 49・skipping 3）。
- 一覧の印の計算（ciOf、:154-158。hub.ts:318-322 の ciOfSession）は、PR の state を見ていない。
- 閉じていて実行中の検査が無い PR は、取り直さない（isSettled、:161-163）。
- そのため、閉じた古い PR の「失敗」が、ずっと出続けていた。
- 既定のブランチ（origin/HEAD）は、salesanchor では取れた。agent-console とその worktree、それに試験の一時のリポジトリでは取れなかった（exit 128）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 一覧の CI の印は、選んだ PR の state が OPEN のときだけ出す。CLOSED と MERGED のときは出さない|単体試験（ciOfSession）＋統合試験（CLOSED の PR に fail がある場合に snapshot の ci が無い）|
|K2 「PR」タブの表示は今のまま（閉じた PR も「クローズ」として出す）|既存の試験が通る|
|K3 lint と既存の試験・CI（両 OS）が通る|CI|
|K4（導入後）PO の画面で、main で作業しているセッションに「CI 失敗」が出ない|PO の目視|

## 2. 対象と対象外
- 対象: server/hub.ts の ciOfSession（または、snapshot に載せる前の判定）と試験。版、CHANGELOG。
- 対象外:
  - 既定のブランチで PR を探さないようにすること。origin/HEAD が取れない clone がある（§0）。OPEN だけに絞れば、閉じた古い PR の印は出なくなる。そのため要らない（YAGNI）。
  - PR タブの選び方。

## 3. 仕組み
- ciOfSession で、そのセッションの PR の state が "OPEN" でなければ undefined を返す。
- PR の state は、すでにメモリの写し（prByKey）にある。新しく取りに行かない。

## 4. SSOT・安全・戻し方
- 新しい値は持たない。判定を1か所足すだけ。
- 戻すときは、この判定を外す。

## 外部・過去事例の参照と我々への応用
- 外部の事例は不要。原因は、本リポジトリの実物と、gh の実測で特定できた（recon C）。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1 の統合試験で固定する。
