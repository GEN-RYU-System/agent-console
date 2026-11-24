# AI が「作業」の予約も入れられるようにする（v0.56.0）設計と実装カード

状態: 設計案（Opus 作成）。PO 方向承認済み（2026-11-25 チャット「1」）。実装承認: PO 2026-11-25 同じ返信「PRマージ、デプロイまで完走させてくれ」。

## 1 目的（PO の言葉）
- PO の選択（2026-11-25「1」）: 「作業の予約も入れられるようにする。予約タブには『AI・作業』と分けて表示し、何をするかの説明も必ず付けさせる」。
- 奥の目的: 夜や休日、PO の離席中にも、AI が自分で続きの作業を予約して動き出せるようにする（ADR-1012 AI 保守運用 24 時間化の流れ）。
- 背景: 2026-11-24、AI が「段階4 の次の段の段取り表を明日作る」予約を入れようとして、AI の予約は測定目的だけという決まり（§2 R1）で入れられなかった。

## 2 調べた実物（origin/main d417835）
- R1 決まりの由来: `docs/handoff/reservations/design.md:92-97` §4-9「AI の予約は『測定』目的だけ（PO 決定 2026-10-14）」。PO 原文「予約するのは今回のように実地で回してPDCAの成果を測る目的のみとする」（同 :93）。承認待ちは設けない（:97）。今回の PO 決定はこれを変える。
- R2 受付の検査: `server/reservations.ts:197-203`。createdBy が "agent" のとき `body.purpose !== "measure"` は 400「reservation purpose must be measure」（:200）、measureNote は 1〜200 字・制御文字不可（:201、上限 `MAX_MEASURE_NOTE = 200` は :27）。
- R3 保存形: `server/reservations.ts:53-54`（`purpose?: "measure"; measureNote?: string`）。読み込みの `parse()` は `r.purpose` が "measure" 以外なら例外（:69）で、ファイル全体を読まない。知らない項目は捨てる（:71-84 は項目を1つずつ写す）。
- R4 画面経路: `server/http.ts:379-383` の `uiReservationInput` が purpose・measureNote を捨てる（:252 で使用）。
- R5 画面の表示: `src/components/Reservations/ReservationsPane.tsx:58`（agent なら `ac.reservations.byAgent`）、:61（measureNote があれば `ac.reservations.measureNote`）。文言は `src/locales/ja.json:387`「AI・測定」・:388「測る内容: {{note}}」。型は `src/types.ts:143`。
- R6 AI の予約に掛かる他の守り（今回は変えない）: 待機中 AI 20 件まで（`server/reservations.ts:25`・:215）、ほかと開始が 60 分未満は 400（:216-218、v0.44.0）、呼び出し元の役割が reserveRoles（既定 opus-designer・shell）に無いと 403（README.md:31）、`reservable:false` の役割は予約不可（:211-212）、作成・取消・開始は監査記録（README.md:17）。
- R7 試験: `tests/unit/reservations.test.ts:306`（R11 の作成結果）、:320-339（R11c）、`tests/unit/ac-reserve.test.ts:17`（入力の形）、:44-47（purpose "other" は 400）、`tests/unit/schedule-gate.test.ts:163`。
- R8 説明書: `README.md:21`「使ってよいのは、変更の効果を実地で測る予約だけ（PO 決定 2026-10-14）」、:29 の入力の形。`hooks/ac-reserve.mjs:14` の USAGE は README を指すだけ。
- R9 実機: 2026-11-24 までの AI 予約 54 件はすべて measure（Opus が `ac-reserve.mjs list` で確認）。導入済みは v0.55.3。

## 3 決めたこと
- D1 AI 用経路の入力に `purpose: "work"` を足す。そのときは `workNote`（何をするか。1〜200 字・空白だけ不可・制御文字不可。規則は measureNote と同じ関数・同じ上限定数を使う）が必須。`purpose: "measure"` と measureNote は今までどおり。purpose が "measure"・"work" 以外または欠落は 400（文言「reservation purpose must be measure or work」）。"work" に measureNote を付けた・"measure" に workNote を付けたものは 400（取り違え防止）。
- D2 保存形は `workNote?: string` だけを足し、作業の予約には **purpose を保存しない**。理由: 1つ前の版（v0.55.3）の `parse()` は purpose が "measure" 以外だとファイル全体を読めなくなる（R3）。purpose "work" を保存すると、切戻し（`ac-rollback.sh`）の後に予約が全部止まる。workNote だけなら古い版は項目を捨てて読める（表示が「AI・測定」になるだけ）。新しい版の `parse()` は workNote が文字列なら写す。measure の予約の保存形は変えない。
- D3 画面: agent の予約で workNote があれば「AI・作業」と「する内容: {{note}}」、それ以外の agent は今までどおり「AI・測定」と「測る内容」。新しい文言キーは `ac.reservations.byAgentWork`「AI・作業」・`ac.reservations.workNote`「する内容: {{note}}」（ja.json のみ。en.json は存在しない）。既存の `ac-reservations__note` の部品とクラスを使い、CSS・トークンは足さない。
- D4 画面経路（`uiReservationInput`）は workNote も捨てる。人の予約は目的を持たない（今までどおり）。
- D5 R6 の守りはすべてそのまま（作業の予約も 20 件の内数・60 分の関門・reserveRoles・監査）。承認待ちは設けない（PO 選択 1。選択 2 の「OK を待つ形」は採らなかった）。
- D6 説明書: README の ac-reserve の節の決まりを「使ってよいのは、変更の効果を実地で測る予約（measure）と、PO が承認済みの仕事の続きを始める予約（work）（PO 決定 2026-10-14、2026-11-25 に作業を追加）」へ。入力の形に `purpose`（`"measure"` か `"work"`）・`measureNote` か `workNote` を書く。`docs/handoff/reservations/design.md` §4-9 の末尾に「2026-11-25 PO 決定で作業目的を追加（docs/handoff/agent-work-reservations/design.md）」の1行を足す（§4-9 の本文は経緯として残す）。
- D7 版は 0.56.0（package.json と package-lock.json の version、`docs/CHANGELOG.md` の先頭に1行）。

## 4 代替案
- A 保存に purpose "work" を持たせる → 切戻しで reservations.json が読めず予約が全部止まる（R3）。不採用。
- B 作業の予約は PO の OK を待つ → PO が選択 2 として退けた。不採用。
- C 決まりを無くし purpose を任意にする → 予約タブで何の予約か分からなくなり、PO の「説明を必ず付けさせる」に反する。不採用。

## 5 リスクと対処
- 作業の予約は時刻どおり新しいセッションで動く。そのセッションは普段と同じ見張り（hooks・権限）の下で動き、予約で新しい権限は増えない。数は 20 件・間隔 60 分で抑え、予約タブでいつでも取り消せる（R6）。
- 切戻し: v0.55.3 へ戻すと作業の予約は「AI・測定」として表示され（説明の行は出ない）、時刻どおり動く（D2）。止めたいときは戻す前に予約タブで取り消す。
- 切戻し中に旧版が予約を保存し直す（取消・開始）と workNote はファイルから消え、新版へ戻しても説明は戻らない（その予約は「AI・測定」のまま表示）。
- 試験の期待を弱めない: R11c の「purpose "other" は 400」はそのまま残す。

## 6 受入条件
| 基準 | 検証方法 |
|---|---|
| W1 AI 用経路で purpose "work"＋workNote（200 字）は 201、作られた予約は createdBy "agent"・workNote 付き・purpose 無し | 単体（HTTP、tests/unit/reservations.test.ts に追加） |
| W2 purpose "work" で workNote 欠落・空・空白だけ・201 字・制御文字入りは 400。"work"＋measureNote、"measure"＋workNote も 400。purpose "other"・欠落は今までどおり 400 | 単体（HTTP） |
| W3 measure の予約は今までどおり（既存 R11・R11c・ac-reserve R12・schedule-gate の試験が期待を変えずに通る。R11c の 20 件上限は work と measure の合計で数える試験を1つ足す） | `npm test` |
| W4 画面経路に purpose "work"・workNote を送っても保存されない | 単体（HTTP） |
| W5 reservations.json に workNote 付きの予約があると新しい版は読んで残す。purpose "work" が書かれたファイルは今までどおり読まない（保存形に "work" は現れない） | 単体（保存→読み直し。後半は旧版互換の裏付けで、その意図を試験の注釈に書く） |
| W6 予約タブ: workNote 付きの agent 予約は「AI・作業」と「する内容: …」、measureNote 付きは「AI・測定」と「測る内容: …」、ui は「画面」 | 単体（新 `src/components/Reservations/ReservationsPane.test.tsx`。ReservationEditor.test.tsx と同じ jsdom・i18n・`vi.mock("../../api")` の作りで、Pane が使う fetchReservations・cancelReservation をモックする） |
| W7 ac-reserve.mjs で purpose "work" の入力が 201 で通り、終了コード 0 | 単体（tests/unit/ac-reserve.test.ts に追加） |
| W8 typecheck・lint・npm test・build が通る。新しい --ac- トークン・色直値・日本語直書きが無い | CI（macOS・ubuntu）。直書き・直値は Opus が差分を目視 |
| W9 導入後の実機: healthz が 0.56.0 と合流の sha。`ac-reserve.mjs add` で purpose "work" の予約を1件作り、予約タブ（list の JSON）に workNote が出て、取り消せる | Opus（導入後） |

## 7 実装カード（クラウド Sonnet 向け）
- 枝: `release/agent-work-reservations`（origin/main から）。PR は作らない（Opus が作る）。
- 触るファイル: server/reservations.ts、server/http.ts、src/types.ts、src/components/Reservations/ReservationsPane.tsx、src/components/Reservations/ReservationsPane.test.tsx（新）、src/locales/ja.json、tests/unit/reservations.test.ts、tests/unit/ac-reserve.test.ts、README.md、docs/handoff/reservations/design.md（§4-9 末尾に1行）、docs/CHANGELOG.md、package.json、package-lock.json（version 行だけ）。
- 触らない: 関門（server/schedule-gate.ts 等）・上限の数・reserveRoles・監査・hooks/ac-reserve.mjs・CSS・トークン・ほかの試験の期待。
- 変更の形（目安。行は origin/main d417835）:
  - server/reservations.ts:53-54 の型に `workNote?: string` を足す。:82 の次に `...(typeof r.workNote === "string" ? { workNote: r.workNote } : {})`。:69 は変えない。
  - :197-203 を、purpose が "measure" なら今までどおり measureNote を検査、"work" なら workNote を同じ規則（`MAX_MEASURE_NOTE`・`CONTROL`）で検査して `{ workNote }` だけを入れる、それ以外は 400（D1 の文言）。取り違え（D1）も 400。変数名 `measure` は `purposeFields` 等に直してよい。
  - server/http.ts:379-383 で workNote も捨てる（注釈も直す）。
  - src/types.ts:143 に `workNote?: string`。
  - ReservationsPane.tsx:58 を「agent かつ workNote あり→byAgentWork、agent→byAgent、ほか→byUi」、:61 の後に workNote の行（同じ `ac-reservations__note`）。
  - ja.json の :387-388 の並びに `"byAgentWork": "AI・作業"`・`"workNote": "する内容: {{note}}"`。
- 試験: §6 W1〜W7 を足す。既存の試験の期待は変えない。
- 流す命令（CI と同じ。Sales Anchor の部品が要る）: `git clone --depth 1 https://github.com/shingo-ops/salesanchor.git /tmp/salesanchor` → `.github/workflows/ci.yml` と同じ設定を作って `node scripts/sa-sync.mjs` → `npm ci` → `npm run typecheck`・`npm run lint`・`npm test`・`npm run build`。落ちた試験は origin/main でも落ちるかを確かめて書く。
- 止まる条件: 実物が §2 と違う、判断が要る、試験の期待を変えないと通らない → 作らずに NEEDS_DECISION。

## 8 続ける仕組み
- 予約タブの表示（AI・作業／AI・測定）と監査記録 `routine-audit.jsonl` の reserveCreate で、AI が何の予約をいつ入れたかを PO がいつでも見られる。
- README の決まりの文が AI 側の使い方の正本（ac-reserve の USAGE が README を指す）。

## 9 外部事例
- 該当なし（自作アプリ内の入力検査の拡張で、外部の数値で成否を測る性質のものではない）。

## 10 審査記録
- Opus 自己審査（2026-11-25）: §2 の行番号を origin/main d417835 の実物で照合済み。D2 の切戻しの安全は R3（:69 と :71-84）で裏付け。APPROVE（自己審査）。クラウド審査の結果は下に追記。
- クラウド審査 1 回目（2026-11-25 01:59 JST、Sonnet・読むだけ）: 行番号はすべて一致（README の 1 か所だけ :20→:21）。D2 は切戻しに安全。指摘（§5 に切戻し後の 2 点、W5 の注釈、W6 のモック、W8 の目視）を反映した。判定行は記録が途中で切れて読めず、再審査した。
