# 設計: 画面の並べ方（上部タブの大きさ・よく使う指示・セッションの行・並び順のドラッグ）

- 状態: 設計者（Opus）が作成。Fable の設計審査 第1回 REVISE、第2回 APPROVE（条件の表記の直しは反映済み）。v0.7.0・v0.8.0 のマージ後に着手する。
- 版の番号は、実装の時点の main の次の版にする（v0.7.0・v0.8.0 の後の予定）。
- PO 承認（2026-10-12）:
  - 上部タブ「2倍ぐらい大きくしたい」。決まり「Sales Anchor に無い大きさや色だけを、アプリ専用の登録ファイルに足す」に「入れる」。
  - よく使う指示「1行に収めてほしい」「よく使う指示…をボタンにして押したらポップアップで指示一覧」「何を常時表示にするかも設定できると便利」。
  - セッションの行「表示場所を Opus 設計の右側に」「作業中や待機などのバッジと CI 失敗のバッジは2段目に移動」。
  - 「左側のセッションの表示位置もドラッグして移動できるようにしたい」。
  - 離席中は最後まで完結させる指示。
- 調査: docs/handoff/layout/recon.md（Sonnet）
- 対象ADR: ADR-067、ADR-144

## 0. 事実（recon より）
- タブ:
  - SA の Tabs は、className をコンテナにだけ受け取る（Tabs.tsx:58-70）。
  - 大きさは Tabs.css:67-71 が `--comp-tab-h-sm`、`--comp-tab-px-sm`、`--font-xs` を読んで決めている。
  - 24px の文字は SA に `--font-2xl`（tokens.css:20）としてある。
  - 56px のタブ用のトークンは SA に無い。
- デザインの検査（scripts/check-design-governance.mjs:97-102）は、tokens.app.css の値として font stack だけを許している。長さ（56px）は通らない。
- よく使う指示:
  - 保存形式は version 1 の `{id,label,text}` だけ（quick-prompts.ts:12,43-53,86）。ほかの項目は読み込みで落ちる。
  - 版が違うファイルは例外になり、上書きしない。古い版を読み替える先例は無い。
  - バーは `flex-wrap: wrap` で折り返す（QuickPrompts.css:19）。
  - SA の Modal は Esc で閉じる（Modal.tsx:71-77）。Popover には Esc の処理が無い。
  - SA に Checkbox は無い。
- セッションの行:
  - 1段目は、状態の丸と状態の文字、名前、CI の印、未読の印（SessionList.tsx:58-75）。
  - 2段目は、役割と予約の名前（:76-84）。
  - StatusDot は、丸と状態の文字を1つにまとめている（StatusDot.tsx:14-22）。
- 並び順:
  - 正本は SessionManager の Map の入れた順（sessions.ts:114）。画面はこの順で出す。
  - 復元のリスト（open-sessions.json）も、この順で書かれ、この順で開かれる（restore.ts:72-83,123）。
  - 並べ替える手段は無い。dnd の部品も依存も無い。SA には、HTML5 のドラッグで行を並べ替える例が1つある（ProductsPage.tsx:347-350,381-382）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 中央の上部タブの高さが 56px、文字が 24px（SA の --font-2xl）になる。件数の印（Badge）の大きさは変わらない|e2e（getComputedStyle で高さと文字の大きさ、件数の印の文字の大きさ）|
|K2 デザインの検査で、tokens.app.css の --ac- の値として長さ（px と rem）を許す。色や var() は、今までどおり許さない|単体試験（design-governance.test.ts の該当の例を、新しい決まりに合わせて直す。色と var() は違反のまま）|
|K3 「よく使う指示」のバーは1行。常に表示にした指示だけを並べ、入りきらない分は横に動かして見る（折り返さない）。左の「よく使う指示」はボタンで、押すと Modal に全件が出る。Modal から、指示を使うことと、常に表示する・しないの切り替えができる。Esc で閉じる|単体試験＋e2e|
|K4 「常に表示」の印は、指示の保存ファイル（quick-prompts.json、version 1 のまま）の各項目に、任意の項目 `pinned` として持つ。無い項目は「常に表示」と読む。新しく作った指示は「常に表示」。名前や本文だけを直しても、pinned は変わらない|単体試験（label だけの PUT で pinned が変わらない、pinned の無い項目、boolean でない pinned は壊れたファイル扱い）＋統合試験|
|K5 セッションの行の1段目は、状態の丸と名前（と未読の印）だけ。2段目は、役割（「Opus 設計」など）、状態の文字の印（作業中・待機など）、CI の印、予約の名前の順。行の高さは今と同じ 64px 以下|単体試験＋e2e|
|K6 セッションの行をドラッグして離すと、その位置に並び順が変わる。並び順は、アプリの再起動・更新のあとも残る（復元のリストの順）|統合試験（move の API と復元のリストの順）＋e2e（ドラッグ）|
|K7 キーボードでも並べ替えられる（行を選んだ状態で Alt+↑ と Alt+↓）|単体試験|
|K8 文言は i18n。見た目は SA の金型とトークンと、tokens.app.css に登録したものだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K9（導入後）PO が見て、タブが大きく、指示のバーが1行で、名前が隠れず、ドラッグで並べ替えられる|PO の目視|

## 2. 対象と対象外
- 対象:
  - scripts/check-design-governance.mjs、tests/unit/design-governance.test.ts（K2）
  - src/tokens.app.css（`--ac-tab-h: 56px` を足す）
  - ConsolePage.tsx と CSS（タブのコンテナに className を付ける）
  - QuickPrompts（バー、一覧の Modal、編集）、server/quick-prompts.ts（任意の pinned を足す。version は 1 のまま）、API
  - SessionList、StatusDot
  - server/sessions.ts（move）、http.ts（API）、restore.ts（並べ替えたときに復元のリストを書き直す）
  - ja.json、試験、版、CHANGELOG、README
- 着手の条件: v0.7.0 と v0.8.0 が main にマージされた後に、main からブランチを作り直す。recon の行番号（ConsolePage.tsx、http.ts、StatusDot、ja.json、console.spec.ts）は、そのときに取り直す。
- 対象外:
  - SA 本体の変更
  - 右の欄（v0.8.0 で扱う）
  - 一覧の中の、並び順以外の操作（まとめて閉じる、など）

## 3. 仕組み
### 3-1 タブの大きさ（K1・K2）
- tokens.app.css に `--ac-tab-h: 56px;` を足す。デザインの検査は、--ac- の値が font stack か長さ（`^\d+(\.\d+)?(px|rem)$`）なら許す形に変える。
- ConsolePage の中央の Tabs に `className="ac-center-tabs"` を付ける。
- ConsolePage.css に、`.ac-center-tabs.comp-tabs .comp-tabs__tab { height: var(--ac-tab-h); font-size: var(--font-2xl); padding: 0 var(--space-6); }` を置く。
  - 詳細度は (0,3,0) で、SA の (0,2,0) に勝つ。読み込み順に頼らない。
  - 余白のトークン（--space-6 など）は、実装の時に .sa-cache で実在を確かめ、step0.md に書く。
- 件数の印（Badge）の文字の大きさは変えない。--font-xs のような SA の共通のトークンは上書きしない。印に波及させないため。
- SA の内側のクラス名（comp-tabs、comp-tabs__tab）に頼る。SA で名前が変わったら効かなくなるので、K1 の e2e で守る。

### 3-2 よく使う指示（K3・K4）
- 保存（Fable 審査 HIGH-1・HIGH-2 を受けて、版は上げない）:
  - version は 1 のまま。各項目に任意の `pinned: boolean` を足す。
  - 読むとき: pinned が無ければ true。あって boolean でなければ、壊れたファイルとして例外にし、上書きしない。
  - 作るとき: pinned: true（今の「作ったらすぐバーに出る」を保つ）。
  - 直すとき（update）: 送られてこなければ、今の値を引き継ぐ。move と remove は、そのまま写す。
  - 版を上げないので、古い版のアプリに戻しても読めなくなることはない。古い版のアプリは pinned を知らないので、保存すると pinned が消える。消えた項目は、新しい版では「常に表示」と読まれ、壊れることはない。
- API: 既存の PUT /api/quick-prompts/:id で、pinned も更新できるようにする。新しい口は作らない。
- バー:
  - 1行にする（flex-wrap: nowrap、overflow-x: auto）。ボタンが縮んで名前がつぶれないように、`.ac-quick__buttons > *` に flex: none を当てる。並べるのは pinned の項目だけ、保存順。
  - 左の「よく使う指示」は SA の Button（ghost、sm）にして、押すと SA の Modal（md）を開く。
  - 右端の「指示を編集」は、今のまま。
- 一覧の Modal:
  - 全件を保存順に出す。
  - 各行に「使う」の Button と、「常に表示」の切り替えを置く。切り替えは SA の Button の variant="tab" と active={pinned} にする。押されているかどうかを aria-pressed で支援技術に伝えるため（SA の Button.tsx:64）。SA に Checkbox は無い。
  - 「使う」は、バーのボタンと同じ動きにする（send-check → 貼る → Enter）。
  - Esc と閉じるボタンで閉じる。

### 3-3 セッションの行（K5）
- StatusDot に、丸だけを出す形（label を出さない prop）を足す。丸だけの形でも `data-testid="status"` と `data-state` は残す（e2e が読むため）。
- 2段目の状態の文言は、v0.8.0 で StatusDot から出す対応表（STATE_LABEL_KEY）を使い回す。同じ表を複製しない。
- 1段目: 丸、名前、未読の印。
- 2段目: 役割、状態の文字の印（SA の Badge、neutral、sm。文言は今の ja.json の ac.state）、CI の印（今の Badge のまま）、予約の名前。
- 行の高さは 64px 以下（今の e2e の決まり）を守る。

### 3-4 並び順（K6・K7）
- 正本は SessionManager の Map の順のまま。新しい保存の場所は作らない。
- `SessionManager.move(id, toIndex)`:
  - フィールドの readonly を外し、新しい Map を作って代入する（不変の作法。clear して入れ直すことはしない）。
  - from と to が同じなら何もしない。
  - toIndex は Number.isInteger で、0 以上、件数（止まったセッションも含む）より小さいものだけを受け付ける。範囲の外は SessionInputError。id が無ければ SessionNotFoundError。
  - 最後に notify() を呼ぶ。復元のリストの記録係（restore.ts:45、72-83）が、今の順で open-sessions.json を書き直す。画面も hub.ts:77 の合図で並び直る。
- API: `POST /api/sessions/:id/move` `{toIndex}`。既存の認証と Origin の検査の内側に置く。
- 画面:
  - 各行に HTML5 の draggable を付ける。SA の ProductsPage と同じ作法で、外部の部品は足さない。
  - 離した位置の index で move を呼ぶ。
  - Alt+↑ と Alt+↓ は、行の中の選択の Button の onKeyDown で受け、既定の動きを止めて、1つずつ動かす（行の div にはフォーカスが乗らないため。SessionList.tsx:40-57）。
  - ドラッグは常に使える形にする。ダブルクリックでの名前の変更とぶつからないことは、既存の e2e（ダブルクリックで予約の名前が出る）で確かめる。
- 復元のときは、復元のリストの順に開くので、並び順は再起動のあとも残る。今の restore.ts:123 の動きのまま。

## 4. SSOT
- タブの高さの値は tokens.app.css の1か所。
- 「常に表示」の印は quick-prompts.json の各項目の1か所。
- 並び順は SessionManager の Map の1か所。open-sessions.json は、その写し（今までどおり）。

## 5. 安全
- 新しい API（move）は、既存の認証の内側に置き、入力を検査する。
- quick-prompts.json の version は 1 のまま。version が 1 以外、または pinned が boolean でないファイルは、今までどおり例外にして上書きしない。

## 6. 代替案
- SA の --comp-tab-h-sm と --font-xs をコンテナで上書きする: --font-xs は件数の印にも効くので不採用。
- 並び順を新しいファイルに保存する: 正本が2つになるので不採用。
- dnd のライブラリを入れる: 依存が増える。SA の先例は HTML5 で足りているので不採用。
- バーの入りきらない分を「他 N 件」にまとめる: 幅を測る処理が要る。横に動かす形と、全件の Modal で足りるので不採用（YAGNI）。

## 7. リスクと対処
- SA のクラス名が変わるとタブの大きさが効かない: K1 の e2e で検知する。
- 既存の試験（行の構造、タブの文字、バーのボタン列、dataDir の中身）が変わる: recon E の一覧に沿って、意味を保ったまま直す。

## 8. 外部・過去事例の参照と我々への応用
- SA の ProductsPage の並べ替え（HTML5 のドラッグ）を使い回す。
- 過去事例 v0.4.0: 一覧の操作を Modal にまとめる形（v0.3.x の再開の一覧）。
- 適用限界: 外部の事例は調べていない。成否は K9 で測る。

## 9. 設計審査
- 第1回（Fable、2026-10-12）: REVISE。
  - HIGH-1 pinned の既定値と引き継ぎ。
  - HIGH-2 版を上げずに任意の項目にした（古い版に戻しても壊れない）。
  - HIGH-3 着手の条件と、状態の文言の表の使い回し。
  - MEDIUM-1〜4、LOW-1・2 も反映した。
- K6 の「再起動のあとも残る」は、本番のポートでないと復元の記録が働かないので、統合試験で記録係を直接呼んで確かめる（e2e では確かめられない）。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K1（タブの大きさ）と K4（pinned の既定値と引き継ぎ）を試験で固定する。

## 追記（2026-10-14、file-viewer で上部タブが 8 個になったため）
- 上部タブの左右の余白を var(--space-6) から var(--space-3) に変えた。高さと文字の大きさ（PO 承認の「2倍ぐらい大きく」）はそのまま。理由と計測は docs/handoff/file-viewer/design.md §15。
