# 設計: 作戦ボードに「タスク」を足し、「今の状態」を外す

- 状態: 第2版（§10）は Fable の再審査で APPROVE（2026-10-13）。PO の要望原文と y（上記）、および「確立したなら進める」の指示に基づき実装へ進む。版は 0.14.0（0.13.0 は chat2。keep-sessions が止まっているためマージ順で繰り上げ）。
- 版の番号: 実装の時点の main の次。
- PO 承認（2026-10-13）
  - 「右側のカラムの今の状態表示は左側のセッションのバッジを見れば理解できるので不要なので削除、終わった担当も見えなくていいので削除」
  - 「task.mdを使ってこのセッションの進行タスクや進行状況を見える化したい…タスクはセッションごとにセッション内のタスクと進行状況のみ表示させる、SSOT捺せつつ見え方は分類して見せたい」
  - 設計者の y/n「タスクは task.md ではなく作戦ボードの記録（セッションごとに1つ）に持たせ、『進行中』『これから』『完了』に分けて出す」に「y」。
- 前提の設計: docs/handoff/board/design.md（v0.12.0。Fable APPROVE・PO 承認・マージ済み #27）
- 対象ADR: ADR-067、ADR-144

## 0. 事実
- PO が見ている右の欄は、本番の v0.9.1 のもの。v0.9.1 には「今の状態」「動いている担当」「終わった担当」「やること」がある。「やること」は TaskCreated の hook から作るが、Opus 5.5 では Task の道具が既定で無効なので、空になる。
- v0.12.0（main 4b86c9b、未導入）では、すでに「終わった担当」と「やること」を出さない（board/design.md K1）。「今の状態」は残っている（src/components/ActivityPane/ActivityPane.tsx:39、:55）。
- ボードの正本は dataDir/boards/<Claude の会話の番号>.json の1か所。書き手は、そのセッションの Claude だけ（ac-board.mjs write。board/design.md §3-2、§4）。
- 検査の関数は hooks/ac-board.mjs の1か所で、上限は BOARD_LIMITS（:13）。上の段の鍵は theme・kgi・kpis・roadmap だけ（:68-69）。それ以外の鍵は拒否する。
- 表示の進み具合（ProgressBar と「完了 N / M」）は、今はロードマップに付いている（board/design.md §3-3）。

## 1. 方針
- ボードの形に `tasks` を足す。タスクも、その会話のボードの1ファイルに入れる。新しいファイルや保存先は作らない（SSOT）。
- 画面では、タスクを「進行中」「これから」「完了」の3つに分けて出す。上に、タスクの進み具合のバーを出す。
- 「今の状態」の欄を外す（左のセッションのバッジで分かるため）。
- task.md は使わない（PO の y）。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 右の欄の作戦ボードに「今の状態」の欄が出ない。上から、動いている担当、KGI、KPI、ロードマップ、タスク、最近の入力の順に出す。「終わった担当」と「やること」も出ない（v0.12.0 のまま）|単体試験＋e2e|
|K2 ボードの形に `tasks:[{title, status}]` を足す。status は todo・doing・done。上限は `taskItems` 100件、`taskChars` 200字（BOARD_LIMITS に足す）。`tasks` は省いてもよい（省いたら0件）|単体試験|
|K3 タスクは3つの組に分けて出す。順は「進行中」（doing）、「これから」（todo）、「完了」（done）。各組の見出しに件数を出す。組の中は、書き込まれた順のまま並べる。0件の組は出さない|単体試験|
|K4 タスクの上に、ProgressBar（label なし）と「完了 N / M」の文を出す。M はタスクの全件|単体試験|
|K5 「完了」の組は、最初は閉じておき、押すと開く（件数が多くなっても、進行中とこれからが埋もれないように）|単体試験＋e2e|
|K6 タスクが0件のときは、「タスクはまだ書き込まれていません」と出す|単体試験|
|K7 ボードは、選んだセッションのものだけを出す（今のまま。会話の番号で引く）|既存の試験|
|K8 古い形のボード（tasks なし）も、今までどおり読める|単体試験|
|K9 Opus の設計役の起動指示の作戦ボードの項目に、tasks を足す（控えを取ってから。足すのは設計者）。README の形と上限も直す|設計者が足し、差分を step0.md と CHANGELOG に残す|
|K10 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K11（導入後）PO がセッションを選ぶと、そのセッションのタスクが3つの組に分かれて見え、進み具合のバーが動く|PO の目視|

## 3. 仕組み
### 3-1 形（hooks/ac-board.mjs）
- `TOP_KEYS` に "tasks" を足す。TOP_HINT の文も直す。
- 検査は roadmap と同じ作り（listProblem と stringProblem）を使い回す。鍵は title・status だけ。
- 書く形は `tasks: input.tasks?.map(t => ({title, status})) ?? []`。
- version は 1 のまま。足すのは省ける鍵だけなので、古いファイルも読める。

### 3-2 画面（ActivityPane）
- 「今の状態」の欄と、そのための props を外す。外した値を、ほかで使っていなければ、渡し元（ConsolePage）からも外す。
- タスクの欄を、ロードマップの次に足す。
  - 組の見出しは Badge（進行中 info・これから neutral・完了 success）と件数。
  - 「完了」の組は、開閉できる金型を使う。SA に開閉の金型が無ければ、工程0で設計者に戻す（自作しない）。
- ProgressBar と「完了 N / M」は、ロードマップのものと同じ部品を使い回す。

### 3-3 決まり（K9）
- ~/.claude/prompts/salesanchor-designer.md の作戦ボードの項目を、次のように直す（設計者が、控えを取ってから直す）。
  - 「…テーマ・KGI・KPI・ロードマップ・タスクを決めたとき、段階やタスクの状態が変わったとき…」
  - 「タスクは、このセッションで進める仕事の単位。担当に任せた仕事も含める。」

## 4. SSOT
- タスクの正本は、その会話のボードの1ファイル（dataDir/boards/）。task.md は作らない。
- 担当が動いているかの正本は、今の記録（activity）のまま。タスクの状態とは結ばない（結ぶと、2か所で同じことを持つため）。

## 5. 安全
- 書き込みの経路は、今の ac-board.mjs の1本だけ（入力の検査、600 のファイル、パスの検査は今のまま）。

## 6. 代替案
- task.md を使う: セッションごとの場所が決まらず、同じ内容が2か所にできる。不採用（PO の y）。
- Claude Code の Task の道具（TaskCreated の hook）を使う: Opus 5.5 では既定で無効。有効にすると、全てのセッションの道具が変わる。不採用。
- ロードマップの各段の下にタスクを入れる（入れ子）: 形が深くなり、書き込みの手間と検査が増える。YAGNI。不採用。

## 7. リスク
- Claude がタスクを書き忘れて古くなる: 最後に更新した時刻（今のまま）で分かる。決まり（K9）に書く。

## 8. 外部・過去事例の参照と我々への応用
- 過去事例: v0.12.0 の作戦ボード（ロードマップの Badge と ProgressBar）を、そのまま使い回す。
- 適用限界: 外部の事例は調べていない（同じ部品の使い回しで足りるため）。

## 9. 工程
- 工程0: SA の開閉の金型があるかを確かめる。
- 工程1: 試験を先に書く。
- 工程2: 実装。
- 工程3: CI。
- 工程4: Fable のコード審査。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K2（形と上限）と K3（組の順）を、試験で固定する。

## 10. 第1回審査の直し（§3 より優先）
### 10-1 tasks は省ける鍵（HIGH-1）
- 事実: hooks/ac-board.mjs:40-44 の keyProblem は TOP_KEYS の全部を必須にする。そのまま足すと、tasks の無い古いファイルが readBoard（:172-174）で invalid になる。
- 直し:
  - 鍵を「必須」（theme・kgi・kpis・roadmap）と「省ける」（tasks）に分ける。
  - 余分な鍵の検査では、両方を許す。
  - 足りない鍵の検査は、必須だけにする。
  - tasks が無ければ `tasks: []` として返す。
- 試験（K8）:
  - tasks の無い保存ファイルが ok になり、`tasks: []` を返す。
  - tasks の無い write の入力が通る。
  - 今の「4つの鍵が足りないと失敗」の試験は残す。
- 型と文書も直す: hooks/ac-board.d.mts:4（BOARD_LIMITS）と :8-13（BoardInput）、src/types.ts:225-233（Board）、README.md:84-85（形と上限）。
- version は 1 のまま。新しい版が書いた tasks 付きのファイルは、v0.12.0 では読めない（前にだけ互換）。README に1文書く。

### 10-2 完了の組の開閉（HIGH-2）
- 事実: SA の写し（.sa-cache）に、開閉の金型は無い。SA 本体は、素の `<details><summary>` を使っている（ImportWorkflowPanel.tsx:108,115 ほか）。禁止の一覧（docs/CC_UI_GOVERNANCE.md:23-27）に details は無い。
- 決め: SA の前例どおり、`<details><summary>` を使う。最初は閉じる（open 属性なし）。見た目はトークンだけにする。工程0の分岐は消す。
- 工程の最初に、`node scripts/sa-sync.mjs` で .sa-cache を作る。

### 10-3 「今の状態」を外す所（MEDIUM-3）
- 外す:
  - src/components/ActivityPane/ActivityPane.tsx:221-227（stateSection）と :238（描画）。
  - 同 :39-40（props.state）と :59（分割代入）。
  - 外すと使われなくなるもの: :21-28 STATE_VARIANTS、:10 STATE_LABEL_KEY の import、:9 SessionState の import。
  - :55 のコメント。
- 中継: src/components/RightPane/RightPane.tsx:16（Props.state）、:22、:34。
- 渡し元: src/pages/ConsolePage.tsx:419 の `state=` だけ。
- 試験:
  - src/components/RightPane/RightPane.test.tsx:24,31,39,43,49,50。
  - src/components/ActivityPane/ActivityPane.test.tsx:79、:116-117、:215 と、全ての render で `state=` を渡している所。
  - tests/e2e/activity.spec.ts:212-213。
- 文言・文書: src/locales/ja.json:401 `stateTitle` を消す。README.md:11、:58 の並び順を直す。docs/CHANGELOG.md に1行足す。
- 触らない:
  - ConsolePage.tsx:382、:398、:412 の `state=`（別の部品向け）。
  - StatusDot.tsx:5 の STATE_LABEL_KEY と、SessionList.tsx:9,125（左のバッジの正本）。
- K6 は、ボードが ok で tasks が0件のときだけ。ボードが none や invalid のときは、今のまま。

### 10-4 名前と言葉（LOW）
- data-testid: `board-tasks`（欄）、`board-tasks-progress`（バー）、`board-tasks-progress-text`（完了 N / M）、`board-tasks-group-doing`、`board-tasks-group-todo`、`board-tasks-group-done`（組）、`board-task-item`（各行）、`board-tasks-empty`（0件）。
- i18n の鍵: `ac.board.tasksTitle`、`ac.board.tasksGroup.doing`（進行中）、`ac.board.tasksGroup.todo`（これから）、`ac.board.tasksGroup.done`（完了）、`ac.board.tasksProgress`（完了 {{done}} / {{total}}）、`ac.board.tasksEmpty`（タスクはまだ書き込まれていません）。
- 言葉: タスクの組は、PO が y を出した言葉（進行中・これから・完了）を使う。ロードマップの Badge（未着手）は、この版では変えない。
