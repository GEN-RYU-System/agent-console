# 「よく使う指示」と「指示を編集」を1つのボタンにまとめる 設計

状態: 設計案（Opus 作成）。PO 要望（2026-10-15）と同日の離席時の全権委任（「PRマージ、デプロイまで完走」）により、Fable 審査 APPROVE 後に実装へ進む。版は v0.32.1（終わった担当の表示の修正）の後の **0.33.0**。

## 1. 目的（PO の言葉）
「よく使う指示ボタンと指示を編集ボタンを統合して1つのボタンに指示の編集と表示設定を編集できるようにしたい。右側の指示を編集表示がなくなればもう1つ常時表示させられる指示が増える」

PO に見える変化:
- バーのボタンは左の「よく使う指示」1つだけになり、右端の「指示を編集」が消える。
- 「よく使う指示」を押すと出る1つの画面で、使う・常に表示の切替・並べ替え・編集・削除・追加が全部できる。
- 右端のボタンが消えた分、常に表示の指示を並べる幅が広がる。

## 2. 現在地（事実。調査 /tmp/CC報告ファイル/quick-merge/recon.md、基準 origin/main 5f779b6）
- バーは src/components/QuickPrompts/QuickPromptBar.tsx:52-68。左から「よく使う指示」(ghost, :53-55)、常に表示の指示の列 (:56-65)、右端「指示を編集」(ghost, :66-68)。
- 「よく使う指示」は一覧の Modal（:69-94）。各行に「常に表示」の切替 (:84-86) と「使う」(:87-89)。編集・並べ替え・削除は無い。
- 「指示を編集」は ConsolePage.tsx:545 → :668-670 の Modal に QuickPromptEditor（QuickPromptEditor.tsx:23-137）。名前・本文・上下・追加・削除。常に表示の切替は無い。
- 同じバーをチャット入力欄でも使う（ChatPane.tsx:213、onEdit={onEditPrompts}。ConsolePage.tsx:568 で同じ Modal を開く）。
- 常に表示の数を決めるコードは無い。常に表示の全件を並べ、入りきらない分は横スクロール（QuickPrompts.css:16-24）。「指示を編集」は列の外で flex:none（:10-13）。
- 表示設定の正本は `<dataDir>/quick-prompts.json` の各項目の `pinned`（server/quick-prompts.ts:52-56, 98-104）。API は PUT /api/quick-prompts/:id（http.ts:248、api.ts:67）。画面側の保存は無い。
- 過去の決め: docs/handoff/layout/design.md:85「右端の『指示を編集』は、今のまま。」→ 本設計で変える（PO 要望）。

## 3. 正確に言うと（PO への訂正）
【事実】常に表示の数は「何個まで」と決まっていない。右端のボタンが消えると、その幅（「指示を編集」1つ分）だけ列が広がる。増える数は指示の名前の長さで変わり、ちょうど1個とは限らない。

## 4. 対象と対象外
- 対象（画面だけ）:
  - src/components/QuickPrompts/QuickPromptBar.tsx（右端のボタンを消す。左のボタンで開く Modal の中身を、まとめた画面にする）
  - src/components/QuickPrompts/QuickPromptEditor.tsx（各行に「常に表示」の切替と「使う」を足せるようにする）
  - src/components/QuickPrompts/QuickPrompts.css（右端ボタンの指定 `.ac-quick__edit-button` と、使わなくなった一覧の指定を消す。値はトークンのみ）
  - src/pages/ConsolePage.tsx（`quickEditorOpen` と :668-670 の Modal、onEdit の受け渡しを消す）
  - src/components/ChatPane/ChatPane.tsx（onEditPrompts を消す）
  - src/locales/ja.json（使わなくなったキーを消し、要るキーだけ足す。en.json は無い）
  - 試験: src/components/QuickPrompts/QuickPromptBar.test.tsx、src/components/QuickPrompts/QuickPromptEditor.test.tsx、tests/e2e/console.spec.ts の該当箇所（:637, :689, :706, :707, :714 と、バーの形 :1412-1449）
  - 版 0.33.0（package.json・package-lock.json・extension/manifest.json・docs/CHANGELOG.md）、README.md の該当説明（:228 付近）
- 対象外: サーバー（server/）・API・quick-prompts.json の形・`pinned` の意味、端末へ入れる動き（onSend・pasteOnly・send-check）、チャットで押したときの動き（onPick）、バーの並べ方（nowrap・横スクロール）。

## 5. 変更（前 → 後）
- バー: 前「よく使う指示」＋列＋「指示を編集」→ 後「よく使う指示」＋列。`QuickPromptBar` の props から `onEdit` を消す。
- 左のボタンで開く Modal（バーの中、1つだけ）: 題は `ac.quick.title`（よく使う指示）。中身は QuickPromptEditor を1つ置き、次を渡す:
  - `onTogglePinned`（今の handleTogglePinned と同じ。PUT で `{pinned}` だけ送る）
  - `onUse` と `usable`（今の handleUse・usable と同じ。押したら Modal を閉じて使う）
- QuickPromptEditor の各行の操作（左から）: 常に表示（variant=tab、active=pinned。今の一覧と同じ）・使う（primary）・↑・↓・編集・削除。`onTogglePinned`/`onUse` を渡さないときは今と同じ（その2つを出さない）。行の下の追加・編集の form は今のまま。
- 行の操作が入りきらない場合の並べ方は、今の `.ac-quick-editor__actions` の折り返しで受ける。Modal の大きさは金型 Modal の size の選択肢から選び、写真（K6）で確かめる。新しい色・寸法の直書きはしない。
- ConsolePage の編集 Modal（:668-670）と `quickEditorOpen` を消す。編集は端末側・チャット側ともバーの中の Modal から行う（同じ部品なので両方に効く）。
- 文言: `ac.quick.edit`・`ac.quick.editTitle`・`ac.quick.listTitle` は使われなくなれば消す（grep で使用0を確かめる）。新しい文言が要る場合だけ足す。

## 6. 代替案
- A. 右端に小さなアイコン（歯車）を残す: ボタンは2つのままで PO の「1つに」に合わない。不採用。
- B. 1つのボタンで小さなメニュー（一覧／編集）を出す: 押す回数が1回増える。金型 Popover は Esc で閉じない（layout/design.md:25）。不採用。
- C. 採用: 1つの Modal に一覧と編集をまとめる。部品は今ある QuickPromptEditor を育てるだけで、データの正本も API も変えない。

## 7. リスクと対処
- 画面の中で操作ボタンが増えて窮屈になる → K6 の写真で確かめる。
- 一覧から「使う」と、編集の form が同じ画面にある → 「使う」は今の一覧と同じく、押すと Modal を閉じる。
- 既存の e2e がボタンのラベル・数を固定している → 新しい形に合わせて直し、何を直したかを PR に列挙する。

## 8. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 端末の上のバーとチャットのバーに「指示を編集」が無く、ボタンは「よく使う指示」と常に表示の指示だけ | 単体試験（QuickPromptBar）と e2e で、バーの中の button の名前を全部数える |
| K2 「よく使う指示」を押すと出る1つの画面で、使う・常に表示の切替・↑↓・編集・削除・追加ができ、その結果が quick-prompts.json（試験用 dataDir）に反映される | e2e（試験用サーバー 4329/4330・一時 dataDir）で各操作の後に API の GET とバーの表示を確かめる |
| K3 常に表示を切り替えると、閉じなくてもバーの列に出る／消える | e2e |
| K4 「使う」で端末側は入力欄に入る（Enter は送らない）、チャット側は入力欄に入る（今と同じ） | 既存 e2e の該当試験が通る |
| K5 右端ボタンが消えた分、列の幅が広がる | e2e で、同じ画面幅で列（.ac-quick__buttons）の幅を前後で測る（前は v0.32.x の試験結果、または同じ試験を main で流した値） |
| K6 見た目: 明・暗の両方で、Modal とバーの写真（指示 5 件以上、常に表示 3 件以上）を撮り、Opus が目で確かめる。トークン以外の色・寸法の直書きが無い | AC_SHOT_DIR で写真、`npm run lint`（check-design-governance）と diff の grep |
| K7 typecheck・lint・build・全単体試験・e2e・CI（両 OS）が通る | 生出力を保存 |
| K8 導入後、/healthz が 0.33.0 | 更新ログ |

## 9. 戻し方
v0.32.1 へ戻す（scripts/ac-rollback.sh）。データの形は変えないので、戻しても何も残らない。

## 10. 第2版の決め（Fable 第1版 REVISE /tmp/CC報告ファイル/quick-merge/review-design.md への答え。§5・§8 と食い違う所はここが優先）
1. 大きさ: Modal は size="lg"（800px、tokens.css:292-294）。`.ac-quick-editor__actions` に折り返しは足さない（CSS :65-69 のまま）。名前・プレビューは今どおり `.ac-quick-editor__text` が縮む。K6 の写真で、6つの操作が1行に入り、名前が読めることを確かめる。
2. 行の印: まとめた画面の行は編集側の `data-testid="quick-prompt-item"` と `.ac-quick-editor__label` に寄せる。一覧側の `quick-prompt-list-item`・`quick-prompt-list-label` と `.ac-quick-list__item` は消す。直す試験: src/components/QuickPrompts/QuickPromptBar.test.tsx :48-130・:20・:149-153、src/components/ChatPane/ChatPane.test.tsx :49・:396、tests/e2e/console.spec.ts :1453-1471（と §4 の :637, :642, :689, :690, :706, :707, :708, :714）。
3. エラーと busy: エラーの表示は QuickPromptEditor の1か所（:119-123 の Callout）だけにする。Bar の `error` 状態と :71-75 は消す。`onTogglePinned` は Promise を返し、Editor の `run(…, true)` の中で呼ぶ（busy 中は「常に表示」を押せない。失敗は同じ Callout）。「使う」は `disabled={busy || !usable}`。
4. ボタンの種類: 「使う」は variant="outline"（primary は form の追加/保存の1つだけ。Button.tsx:12 の規格に合わせる）。「常に表示」は今と同じ variant="tab"。
5. 題: Modal の題は `ac.quick.title`（よく使う指示）。`ac.quick.edit`・`ac.quick.editTitle`・`ac.quick.listTitle` は使用0を grep で確かめて消す。
6. 対象に足す: src/components/ChatPane/ChatPane.test.tsx、src/components/QuickPrompts/QuickPromptEditor.test.tsx（新 props `onTogglePinned`・`onUse`・`usable` の単体試験：渡さないと出ない／渡すと出る／busy で押せない／usable=false で「使う」が押せない）、ConsolePage.tsx:42 の import 削除。
7. K5 を差し替え: 同じ試験の中で、`.ac-quick__buttons` の右端がバー（`.ac-quick`）の内側の右端と 1px 以内（右端に他の部品が無い）。
8. K6 の写真: tests/e2e/console.spec.ts に、指示 5 件・常に表示 3 件を作って、バーと開いた Modal を明・暗で撮る試験を1つ足す（AC_SHOT_DIR のときだけ保存する既存の shoot() を使う）。
9. タブを切り替えると、バーごと Modal が外れる（ConsolePage.tsx:539、ChatPane.tsx:213 の条件描画）。今の一覧 Modal と同じ振る舞いで、編集の途中の入力は消える。§7 のリスクとして受ける。
10. layout/design.md:85 は書き換えず、その行の直後に「→ v0.33.0 で右端のボタンを無くした（docs/handoff/quick-merge/design.md）」の1行を足す。
11. 版の順番: 終わった担当の表示の修正（release/stale-running-agent、0.32.1）を先にマージ・導入する。このブランチはその後の origin/main に rebase してから 0.33.0 にする（package.json・lock・manifest・CHANGELOG の衝突を避ける）。

## 11. 維持する仕組み
K1〜K5 の試験が CI で毎回走る。

## 外部事例
不要（社内アプリのボタンの整理で、比べる外部の事例がない）。

## 審査
- 第1版: Fable REVISE（/tmp/CC報告ファイル/quick-merge/review-design.md）→ §10 で答えた。
- 第2版: Fable APPROVE（/tmp/CC報告ファイル/quick-merge/review-design-2.md）。試験のパスと見出しの順を直した。
- 実装承認: PO 要望（2026-10-15）と同日の離席時の全権委任に基づき Opus が実装へ進めると判断。見た目は K6 の写真を Opus が確かめ、帰着後に PO が目で見る。
