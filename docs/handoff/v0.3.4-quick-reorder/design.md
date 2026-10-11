# 設計: v0.3.4 よく使う指示の並び替え

- 状態: 設計者（Opus）作成。PO 承認: 2026-10-11「y」（↑↓ボタン式）。
- 調査: docs/handoff/v0.3.4-quick-reorder/recon.md（実装担当 Sonnet が作成）
- 対象ADR: ADR-067, ADR-144

## 1. 目的
「指示を編集」画面で、登録した指示を1つずつ上下に動かせる。並び順は上部のボタン列にもそのまま反映される。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 「↑」を押すと、その指示が1つ上の指示と入れ替わる。「↓」を押すと1つ下と入れ替わる。保存ファイルの items の順番もその順になる|vitest（store と http）|
|K2 先頭の「↑」と末尾の「↓」は押せない。API に範囲外の移動を送ると 400 になり、ファイルは変わらない|vitest（画面と API）|
|K3 存在しない id は 404、direction が up/down 以外なら 400|vitest（http）|
|K4 並べ替えた後、上部のボタン列と編集画面が新しい順番で表示される|画面試験|
|K5 ファイルの権限が 600 のまま。ほかの変更と同時に起きても内容が欠けない（既存の直列キューを使う）|vitest|
|K6 既存の試験・CI が全部通る|CI 両 OS|

## 3. 対象と対象外
- 対象: server/quick-prompts.ts（move）、server/http.ts（API）、編集画面（↑↓ボタン）、i18n、版 0.3.4、CHANGELOG、README
- 対象外: ドラッグでの並び替え（SA の部品集に該当する金型があるかは未確認のため）、ボタン列の見た目の変更

## 4. 仕組み
- API `POST /api/quick-prompts/:id/move`、本文 `{direction: "up" | "down"}`（認証・Origin 検査は既存の内側）
- `QuickPromptStore.move(id, direction)`:
  - serial の中で load → 位置を探す → 隣と入れ替えた新しい配列を作る（元の配列は変えない）→ save。
  - 範囲外のときは SessionInputError、id が無いときは SessionNotFoundError。
- 画面:
  - QuickPromptEditor の各行に、SA の Button 金型で「↑」「↓」を付ける。aria-label と title は i18n。
  - 押したら API を呼び、成功したら既存の onChanged で一覧を読み直す。
  - 処理中は既存の busy で押せなくする。

## 5. SSOT
- 並び順は quick-prompts.json の items の順番だけで表す。順番用の項目や、別の保存場所は作らない。

## 6. 安全
- 既存と同じ（認証の内側、id はファイル内の照合のみ、書き込みは一時ファイル→rename）。

## 7. 代替案
- 番号を入力して並べる: 操作が多い → 不採用。
- ドラッグ: 金型が未確認 → 今回は対象外。

## 8. リスクと対処
- 連打による競合: 直列キューと busy で防ぐ。

## 外部・過去事例の参照と我々への応用
- 段階2の quick-prompts（docs/handoff/stage2/design.md）の、直列キューと原子的な保存をそのまま使う。
- 外部事例は不要（既存の保存方式の中で配列を並べ替えるだけのため）。

## 維持の仕組み
- 守り手: 設計者（Opus）。K1〜K3 の試験で並び替えの意味を固定する。
