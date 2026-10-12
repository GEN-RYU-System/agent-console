# 設計: v0.6.1 リポジトリの移管（GEN-RYU-System）に、アプリの更新の取得先を合わせる

- 状態: 設計者（Opus）が作成。小さな変更なので、Fable の審査はコード審査とまとめて行う。
- PO 承認（2026-10-12）: 「組織アカウント側に作成したい」。そのあと、GEN-RYU-System への移管に「y」。
- 調査: docs/handoff/v0.6.1-org-move/recon.md
- 対象ADR: ADR-067、ADR-144（画面の変更は無い）

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 アプリの更新の仕組みが取りに行く既定の先が GEN-RYU-System/agent-console になる（scripts/lib/ac-common.sh の AC_REPO）|単体試験（tests/unit/scripts.test.ts の期待を新しい名前にする）|
|K2 リポジトリの中で、旧い名前 shingo-cc/agent-console を取得先として使う箇所が0件になる（過去の記録 docs/handoff と、関数の試験の例の文字列は除く）|`git grep` の結果|
|K3 CI（両 OS）が、移管した先のリポジトリで通る|gh pr checks|
|K4（導入後）v0.6.1 の更新が新しい取得先から成功し、healthz が 0.6.1 になる。開いていたセッションが同じ sessionId で開き直される|更新の記録|

## 2. 対象と対象外
- 対象:
  - scripts/lib/ac-common.sh:26
  - tests/unit/scripts.test.ts:96,449
  - README（リポジトリの場所の記載があれば）
  - 版 0.6.1、CHANGELOG
- 対象外:
  - docs/handoff の過去の記録
  - tests/unit/pr-status.test.ts の例の文字列（取得先ではない）
  - 導入済みの古い版の clone の origin（使われない）

## 3. SSOT
- 取得先の正本は ac-common.sh の AC_REPO の1か所。環境変数 AC_REPO での上書きの仕組みは、そのまま残す。

## 4. 安全・戻し方
- 戻すときは、AC_REPO を元に戻す版を出す。GitHub の転送は、旧い名前からも効く（recon §1）。
- 組織の中での shingo-cc の権限は push まで。admin は無い（recon §2）。リポジトリの設定を変える操作が必要になったら、組織の owner に頼む必要がある。

## 外部・過去事例の参照と我々への応用
- GitHub 公式「Transferring a repository」（recon §1）: 転送は効くが、手元の clone は直すことが推奨されている。そのため、本店の clone の origin は直した。アプリの取得先も、転送に頼らずこの版で直す。
- 適用限界: 転送がいつまで続くかについて、公式の文書は「旧い場所に新しいリポジトリを作ると消える」とだけ書いている。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1 の単体試験で取得先を固定する。
