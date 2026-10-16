# ファイルタブの検索欄・端末へ戻る操作・端末リンクの実ブラウザ試験（v0.41.0）設計

- 状態: 設計案（Opus 作成 2026-10-16）。PO 承認: 2026-10-16 「y」（案 plan-v1 の3点を v0.41.0 で作り本番反映まで）。
- 起点: origin/main c67e90a（v0.40.0）。作業場所 ~/agent-console-wt/file-search（release/file-search）。
- 根拠（生出力）: /tmp/CC報告ファイル/ac-file-search/recon.md（検索の現状）、/tmp/CC報告ファイル/ac-file-back/recon.md（戻る操作の現状）、/tmp/CC報告ファイル/ac-file-link-gov/check.md（続ける仕組みの点検）、/tmp/CC報告ファイル/ac-file-link2/（クリック不具合の調査・再現 repro/）。案 ~/CC報告ファイル-keep/ac-file-search/plan-v1.md。
- 関連設計: docs/handoff/file-viewer/design.md（ファイルタブの正本。D2「見せてよいのは記録された絶対パスと完全一致する物だけ」:117）、docs/handoff/terminal-file-link/design.md（v0.40.0）。

## 1. 目的（PO の言葉）
- 「ファイルタブに検索バーを付けて特定のファイルを検索できるようにしてほしい」
- 「端末の元の画面に戻る、コマンドとかも用意できる？」
- 「この仕組みを標準化して管理定着させて継続させるための仕組みも出来ているか」→ 点検で ×3・△4（check.md）。この便で埋める。

## 2. 現状（事実）
- ファイルタブの一覧は「そのセッションが Write/Edit/MultiEdit/NotebookEdit で書いたファイル」最大500件を新しい順（server/activity.ts:34-36,491）。タブを開いた時と rev が進んだ時に全件取得（src/components/FilesPane/FilesPane.tsx:83-85）。ディスクの列挙は無い。
- 絞り込み・検索は無い。上部は説明文と「再読込」ボタンだけ（FilesPane.tsx:145-158）。
- 中央タブは ConsolePage.tsx:57 の8種、状態は useState 1個（:181）、金型 Tabs（:521-526）。端末へ戻る手段はタブのクリックだけ。戻っても端末に入力の焦点は戻らない（term.focus は pasteOnly のみ）。
- キー割当はアプリ全体で F2・Alt+↑↓（SessionList.tsx:78-91）と Enter 送信（ChatPane.tsx:140）だけ。window/document の keydown リスナー 0。端末に焦点がある時の Esc・Ctrl+C 等は Claude 用で横取りしない取り決め（docs/handoff/chat/recon.md:197 ほか）。ファイルタブ表示中、端末は hidden（ConsolePage.tsx:570）。
- 端末リンクのクリックを実ブラウザで通す e2e は 0 件（check.md 1b）。TerminalPane の単体試験は xterm を vi.mock（TerminalPane.test.tsx:30,48）。e2e は dom 描画固定、本番既定は webgl（server/config.ts:341-343）。
- 入れ替え手順（README 更新手順・update-when-idle.sh・ac-update.sh）に「目視の前に画面を再読み込み」の記載 0 件（check.md 3）。画面は「新しい版が入りました」の再読み込みを押すまで旧 JS（ConsolePage.tsx:84,426-432）。10/16 の PO 初回目視×はこれが原因（再読み込み後○）。
- 「Bash で作ったファイルはリンクにならない」の記載が design/README/CHANGELOG に 0 件（check.md 2）。

## 3. 対象と対象外
- 対象: src/components/FilesPane/（tsx・css・test）、src/pages/ConsolePage.tsx（戻る処理の受け渡しのみ）、src/components/TerminalPane/TerminalPane.tsx（TerminalHandle に focus を足すのみ）、src/locales/ja.json（ac.files.* に追加）、tests/e2e/（端末リンクの e2e 新規）、playwright.config.ts・e2e 設定（webgl 用の待受を足す場合のみ）、README.md、docs/CHANGELOG.md、package.json の version（0.41.0）、本設計書。
- 対象外（触らない）: server/・hooks/（差分0）、見せてよい範囲（D2）、一覧の上限500、他タブ、キー割当の全体方針（ファイルタブ表示中の Esc 以外は足さない）、.github/workflows/（既存の `npm run test:e2e` がそのまま走る。変えない）。

## 4. 変更内容

### 4-1. 検索欄（画面の中だけで一覧を絞る）
- 置き場所: `.ac-files__toolbar` の説明文の後・「再読込」の前。部品は金型 `TextField`（@sa/components/TextField。先例 src/components/LedgerBoard/LedgerBoard.tsx:67-73 の `<TextField size="sm" … />`）。検索用の見た目 variant="search"（.sa-cache の FormField.css:359-377）が TextField の props に実在すれば使う。実在しなければ variant は付けない（自作の見た目を作らない）。
- 生の `<input>`・色/余白の直値・日本語の直書きは使わない（npm run lint の check-design-governance.mjs が検査）。CSS は既存トークン（var(--…)）だけ。
- 文言（ja.json ac.files.*、新キー）: 欄の名前（例「ファイル名で絞り込み」）、件数表示（例「{{shown}} / {{total}} 件」）、該当なし（例「当てはまるファイルはありません」）。文言の最終は実装時に ja.json へ。英語ファイルは無い（ja のみの既存方針）。
- 当て方: 欄の文字を NFKC で正規化して小文字化し、空白（半角・全角）で区切った語が「すべて」path（絶対パス全体。名前とフォルダの両方を含む）に含まれる物を残す。比べる側の path も同じく NFKC・小文字化。並び順は元のまま（新しい順）。
- 空欄なら全件（今と同じ）。件数表示は文字が入っている時だけ出す。0件なら一覧の位置に EmptyState（size="compact"）で該当なし。
- 開いているファイル（selected）は絞り込みで一覧から外れても右側の表示を消さない。
- セッションが替わったら欄を空にする（既存の FilesPane.tsx:51-55 の effect に足す）。
- サーバーへの問い合わせは増やさない（fetchFiles の回数は今と同じ）。

### 4-2. 端末へ戻る操作
- ボタン: `.ac-files__toolbar` の左端に金型 `Button`（variant="outline" size="sm"、既存「再読込」と同じ型）で「端末に戻る」（ja.json 新キー）。常に表示。
- キー: ファイルタブ表示中だけ、Esc で端末に戻る。
  - 受け方: FilesPane の外枠 div に `onKeyDown` を付け、`tabIndex={-1}` にする。ファイルタブが表示になった時（active が false→true、および openRequest で開いた時）、焦点がファイルタブの中に無ければ外枠に焦点を移す（端末は hidden になり焦点を失うため。window/document へのリスナーは足さない）。
  - 検索欄に文字がある状態で、焦点が検索欄にある時の Esc は、まず欄を空にする（戻らない）。空の欄での Esc、または欄以外での Esc は戻る。
  - IME 変換中（event.nativeEvent.isComposing）の Esc は何もしない。
- 戻る処理（ConsolePage）: FilesPane に `onBackToTerminal?: () => void` を渡す。中身は `setCenterTab("terminal")` の後、端末に入力の焦点を戻す。
  - TerminalHandle に `focus(): void`（xterm の term.focus() を呼ぶだけ）を足す。
  - 焦点を戻すのは端末の hidden が外れた後でなければならない。実装は「setCenterTab の後、次の描画で terminalRef.current?.focus()」（requestAnimationFrame）とし、e2e で document.activeElement が端末（.xterm の textarea）であることを確かめる。
  - **ConsolePage には早い return がある。新しいフック（useCallback/useEffect 等）は早い return より前に置くか、フックにしない（v0.40.0 審査の High 指摘と同じ。ConsolePage.tsx:393-398 のコメントの方式に揃える）。**

### 4-3. 続ける仕組み（点検の×・△を埋める）
- (a) 実ブラウザ e2e を新規（tests/e2e/file-link.spec.ts。playwright.config.ts の "app" project の testMatch に足す）。手本は /tmp/CC報告ファイル/ac-file-link2/repro/ の使い捨て試験（case-*.json・link-role.mjs・run*.txt）。
  - E1: 端末に、そのセッションの一覧にある絶対パスを出す → ホバーでリンク印（dom: 下線の装飾、webgl: `.xterm` の xterm-cursor-pointer）→ クリックでファイルタブが開き、そのファイルの中身（ac-files__content-path が一致）が出る。
  - E2: マウス報告モード（`\033[?1000h\033[?1003h\033[?1006h`）と別画面（`\033[?1049h`）を有効にした状態でも E1 と同じ（Claude Code の実機状態。panes.txt で mouse_any_flag=1・alternate_on=1 を確認済み）。
  - E3: 「端末に戻る」ボタン → 端末タブが表示、document.activeElement が端末の textarea。
  - E4: ファイルタブ表示中に Esc → E3 と同じ。検索欄に文字がある時の1回目の Esc は欄が空になり、ファイルタブのまま。
  - E5: 検索欄に名前の一部 → 一覧が絞られ件数表示が出る。当てはまらない語 → 該当なし。空にすると全件。
  - E6: 一覧に無いパス（Bash で作った扱い）はリンクにならない（リンク印が出ない）。
  - 描画: E1・E2 は dom と webgl の両方で走らせる。webgl は terminalRenderer "webgl" の設定で待受を1つ足す（既存 webServer 配列と同じ型。ポートは既存の E2E 用と重ならない値）か、既存の仕組みで描画を切り替えられるなら新しい待受は足さない（実装者は先に e2e 設定の file:line を確かめ、少ない変更の方を選ぶ）。webgl の試験では `data-renderer="webgl"` を必ず確かめる（GPU が無く dom に落ちたまま合格させない）。CI（ubuntu・macOS）で WebGL2 が使えず `data-renderer` が dom になる場合は、試験を skip にせず停止して Opus に NEEDS_DECISION で返す。
  - CI では既存の `npm run test:e2e`（.github/workflows/ci.yml:72）で毎回走る。workflow は変えない。
- (b) 文書: README.md のファイルタブの説明と docs/handoff/terminal-file-link/design.md に「リンクになるのは Write/Edit/MultiEdit/NotebookEdit で記録されたファイルだけ。Bash（シェルのコマンド）で作ったファイルはリンクにならず、ファイルタブの一覧にも出ない」を1行ずつ。検索欄・戻る操作の使い方を README に。docs/CHANGELOG.md に v0.41.0。
- (c) 入れ替え後の目視: README の更新手順（README.md:276-290 付近）に「新しい版が入ったら、目視の前に画面上部の『新しい版が入りました』の『再読み込み』（無ければブラウザの再読み込み）を押す。押すまで画面は前の版のまま」を1行。Opus 側の手順（memory）にも入れる（Opus が実施）。
- (d) 定期点検は新設しない。理由: (a) が PR ごと・main ごとの CI で毎回走る。土台の hook の停止は既存の ac-hooks check（server/activity-hooks.ts:238,292）と活動欄の警告（ActivityPane.tsx:275）で分かる。

## 5. 代替案と選択理由
- 検索を作業場所全体にする案: D2（file-viewer design.md:117・:126 で不採用済み）を変え、サーバーにディスク列挙を足すことになる。PO は一覧内の絞り込みで y。不採用。
- 戻るキーを Cmd+[ 等にする案: ブラウザ・OS の割当と重なる恐れがあり、実機未測定（ac-file-back/recon.md 未確認）。Esc はファイルタブ表示中なら Claude と衝突しない（端末は hidden）。Esc を採用。
- document に keydown リスナーを足す案: アプリ全体に前例が無く、他タブやモーダルに漏れる。FilesPane の外枠で受ける。

## 6. リスクと対処
- R1 Esc がモーダルの閉じると重なる: FilesPane 内にモーダルは無い。外枠の onKeyDown はファイルタブ内の焦点からしか届かない。e2e E4 で確かめる。
- R2 焦点を外枠へ移すことで、ファイル一覧のボタンのキーボード操作が変わる: 焦点を移すのは「ファイルタブの中に焦点が無い時」だけ。
- R3 webgl e2e が CI で動かない: 4-3(a) のとおり停止して判断を仰ぐ（skip で通さない）。
- R4 ConsolePage のフック順: 4-2 の太字。単体試験（ConsolePage.test.tsx）と e2e で画面が落ちないことを確かめる。

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 検索: 語の一部で一覧が絞られ、件数表示が出る。複数語は全て含む物だけ。全角/半角・大小文字を区別しない。0件は該当なし。空欄で全件 | FilesPane.test.tsx に単体試験を追加・npm test 緑、e2e E5 |
| K2 検索中も開いているファイルの表示は消えない。セッション切替で欄が空になる | FilesPane.test.tsx |
| K3 「端末に戻る」ボタンで端末タブになり、端末に入力の焦点がある | e2e E3 |
| K4 ファイルタブ表示中の Esc で戻る。検索欄に文字がある時の1回目は欄を空にするだけ。IME 変換中は何もしない | FilesPane.test.tsx（Esc の分岐3つ）・e2e E4 |
| K5 端末リンクのホバー→クリック→ファイルタブで開くが、dom・webgl の両方、マウス報告＋別画面の状態でも通る。一覧に無いパスはリンクにならない | e2e E1・E2・E6（webgl は data-renderer="webgl" を確認） |
| K6 server/・hooks/・.github/workflows/ の差分 0 | `git diff --stat origin/main...HEAD -- server hooks .github` が空 |
| K7 金型・トークン遵守（生 input・色/余白直値・日本語直書き 0） | npm run lint 緑・diff の目視（Opus 審査） |
| K8 文書: Bash で作った物はリンクにならない旨・再読み込みの手順・検索と戻るの使い方・CHANGELOG v0.41.0 | README.md・terminal-file-link/design.md・CHANGELOG の該当行を審査で確認 |
| K9 CI（ubuntu・macOS）緑 | gh pr checks |
| K10 入れ替え後 healthz の版が 0.41.0 | Opus が healthz を確認 |
| K11 PO 実機: 再読み込み後、検索で絞れる・ボタンと Esc で端末に戻ってすぐ打てる | PO 目視 |

## 8. 外部事例
- VS Code の「Quick Open」（Ctrl/Cmd+P）は、ファイル名の部分一致で絞り込む。ただし対象はワークスペース全体のディスク列挙であり、本件（記録済み一覧の中だけ）とは範囲が違う。参考にするのは「語の一部で絞る・空欄で全件」の振る舞いだけで、数値の根拠としては使わない。
- 本件の効果の根拠は外部事例ではなく、受入条件 K1〜K5 の試験と K11 の PO 目視で判定する。

## 9. 戻し方
- PR のマージを revert し、タグ v0.40.0 で update-when-idle.sh を実行（入れ替え手順は既存と同じ）。データ・サーバーの変更は無いので戻しの副作用なし。

## 10. 維持の仕組み
- 4-3(a) の e2e が PR ごと・main ごとの CI で毎回走り、端末リンク・検索・戻るが壊れたら赤になる。
- 担当: 変更を作る Sonnet、審査と GO・入れ替えは Opus（ADR-1003 委任）。PO は目視 K11。

## 11. 審査記録
- 2026-10-16 Opus 自己審査（同一AIの自己審査。独立レビューではない）: **APPROVE**。
  - 整合: D2（見せてよい範囲）を変えない・server/hooks 差分0・workflow 不変。既存の金型（TextField・Button・EmptyState）と ja.json の方式に沿う。v0.40.0 の High 指摘（早い return 後のフック）を 4-2 で明示。
  - 検証可能性: K1〜K10 は試験・コマンド・healthz で○×が一義。K11 のみ PO 目視。
  - 残る未確認（実装時に事実で確かめる）: TextField の variant="search" の実在（無ければ付けない）／CI の WebGL2 可否（不可なら停止）／e2e で webgl 用の待受が要るか。いずれも分岐を本書に記載済みで、推測で進めない。
