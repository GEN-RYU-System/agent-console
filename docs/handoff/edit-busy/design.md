# 設計カード: よく使う指示の「編集」を処理中は押せなくする（agent-console v0.38.3）

- 作成: Opus（設計）2026-10-15 23:55 ／ 基準 origin/main 7f56e35（v0.38.2）
- PO 承認: 10/15「y」（二重押し防止に進める。v0.38.3 として入れ替えまで）
- 由来: v0.33.0 のコード審査の軽微「Editor の『編集』に disabled={busy} 無し（持ち越し）」

## 0. 観測した事実
- 【事実】src/components/QuickPrompts/QuickPromptEditor.tsx:118 の「編集」ボタンだけ disabled が無い。同じ行の 常に表示(:86)・使う(:94)・↑(:101)・↓(:111)・削除(:121) は `disabled={busy...}` を持つ。
- 【事実】保存（handleSubmit→run、:57-60）が終わると run は keepForm=false で reset()（:37-41）を呼び、入力欄と editingId を空にする。
- 【推測】保存中に別の行の「編集」を押すと、入力欄にその行が読み込まれた直後、保存完了の reset() で消える（利用者には「押したのに入らない」に見える）。

## 1. 目的・変化
- 変える前: 保存・削除・並べ替えの処理中も「編集」が押せる。
- 変えた後: 処理中（busy）は「編集」も押せない（他のボタンと同じ）。処理が終われば押せる。
- 対象外: 取消ボタン、文言、他の部品、サーバー。

## 2. 変更（触るファイル）
1. src/components/QuickPrompts/QuickPromptEditor.tsx:118
   - 前: `<Button variant="outline" size="sm" onClick={() => startEdit(p)}>`
   - 後: `<Button variant="outline" size="sm" disabled={busy} onClick={() => startEdit(p)}>`
2. src/components/QuickPrompts/QuickPromptEditor.test.tsx: 試験1件を足す（K1）。既存「処理中（busy）は『常に表示』『使う』が押せない」(:126-135) と同じ書き方（Promise を保留して busy を作る）。ボタン名は ja.json の ac.quick.editItem の文言を使う。
3. 版 0.38.3: package.json・package-lock.json（2か所）・extension/manifest.json・docs/CHANGELOG.md に1行（v0.38.2 の 7f56e35 と同じ形）。
4. docs/handoff/edit-busy/design.md: 本カードの写し。

触らない: 上記以外すべて。

## 3. 受入条件
|基準|検証方法|
|---|---|
|K1 保存（update）を保留中、「編集」の disabled が true。保留を解くと false に戻る|単体試験（jsdom）|
|K2 既存の QuickPromptEditor.test.tsx はすべて通る|CI|
|K3 CI ubuntu/macOS 緑|CI|
|K4 導入後 healthz が 0.38.3|Opus が curl で確認|

## 4. 想定分岐
- 手元で src/ の画面試験が React 二重読込で全滅（既知）→ 手元は判定に使わず CI を正とする。
- CI macOS の既知の揺れ（tmux 計時・pc-meter CPU 比較）→ 失敗ジョブ再実行1回。2回落ちたら報告。

## 5. 戻し方・測り方
- 戻し方: `bash scripts/ac-update.sh v0.38.2`
- 測り方: K1（試験）・K4。

## 6. 外部事例
不要。理由: 既存の同じ行のボタンと揃えるだけで、新しい判断を含まない。

---
## 自己審査（Opus／同一AI）2026-10-15 23:57 判定: APPROVE
- 変更は1属性で、同じ行の他ボタンと同じ型。i18n・金型（Button）に影響なし。
- 【推測】の不具合経路は、変更後は起きえない（busy 中は startEdit が呼ばれない）。
- 未解決なし。
