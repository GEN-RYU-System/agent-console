# agent-console セッション一覧カードの表示整理 設計（2026-10-13・草案 v1）

PO 原文（2026-10-12T17:38Z・17:39Z、本セッション）:
- 「セッションの作業中と待機の表現も分かりづらい … 作業を進めているのか、私の回答街なのか、完全に待機しているのかなど不透明な表現になっている、位置も変更してとお願いしたが変更されていない、また鉛筆マークは不要なので消していい、ダブルクリックで開くので」
- 「未読1件のバッジも位置を下の段に移動させたい」
- 2026-10-13 離席時「このセッションだけで最後まで完結させる…PRマージ、デプロイまで完走」。

根拠: /tmp/CC報告ファイル/agent-console-status/recon.md、recon2.md（agent-console origin/main 391b609、v0.10.0）。

## 現在地（事実）
- 「位置の変更」（状態バッジと CI バッジを2段目・役割の右へ）は v0.10.0（PR #24、2026-10-12T17:12Z マージ）に入っている。PO が使っているのは v0.9.1（~/Library/Application Support/agent-console/current → versions/v0.9.1）。v0.10.0 は未導入。
- 状態は `claude agents --json` の status をそのまま使う（server/agents.ts:90-99: busy→working、waiting→waiting、idle→idle）。表示の文言は src/locales/ja.json:23-25（作業中・待ち・待機）、en.json の同キー。
- 公式の定義（https://code.claude.com/docs/en/agent-view.md 行788・789・137）: status は busy / waiting / idle。waiting は人の入力が要る状態（waitingFor: permission prompt・input needed・sandbox request・worker request・dialog open）。idle はやることがなく次の指示を待つ状態。
- 鉛筆ボタン: src/components/SessionList/SessionList.tsx:141-152（onRename）。名前の変更はダブルクリック（:105-107）でもできる。
- 未読バッジ: SessionList.tsx:112-118（1段目、data-testid=unread-badge）。2段目は :120-139（役割・状態バッジ・CI バッジ・予約名）。
- 注記文: ja.json:90 ac.notifyHelp（「作業中」から「待ち」または「待機」に変わった時点を…）。
- 未マージの作業は release/chat（agent-console-wt/chat）だけ。SessionList.tsx・StatusDot.tsx は触っていない。src/locales/ja.json と src/types.ts は触っている。

## 変更（v0.10.1）
1. 状態の文言を、PO が見分けたい3つに合わせる（判定のしくみは変えない。公式の定義どおり）。
   - working: 「作業中」（変更なし）／ en "Working"
   - waiting: 「待ち」→「回答待ち」／ en "Waiting" → "Needs your reply"
   - idle: 「待機」→「指示待ち」／ en "Idle" → "Waiting for instructions"
   - 理由: 「待ち」と「待機」は言葉が似ていて区別できない。公式の定義では waiting=人の返事・許可が要る、idle=次の指示を待つ。
   - ac.notifyHelp の文の「待ち」「待機」も新しい文言に合わせる。ほかに「待ち」「待機」を表示に使うキーがあれば、すべて洗い出して同じ扱いにする（キー名は変えない）。
2. 鉛筆ボタンを消す（SessionList.tsx:141-152）。名前の変更はダブルクリックだけにする。onRename の受け渡しとダブルクリックは残す。使わなくなる i18n キー（ac.rename.open 等）は、ほかで使っていなければ ja・en の両方から消す。
3. 未読バッジを2段目へ移す。並びは「役割・状態バッジ・未読バッジ・CI バッジ・予約名」。部品・文言・出る条件は変えない。
4. 試験: 鉛筆ボタンを使う試験（SessionList.test.tsx:64-66, :86-89, :176, :186, :196-212、tests/e2e/console.spec.ts:492-541）をダブルクリックに置き換え、未読が1段目にある前提の試験（SessionList.test.tsx:95-130 付近、console.spec.ts:1365-1374）を2段目の検査に直す。行の高さ 64px 以下の試験（console.spec.ts:382-387）は変えずに通ること。文言の試験があれば新しい文言に。
5. 版: package.json を 0.10.1、docs/CHANGELOG.md に1行。マージ後に v0.10.1 タグを push（README.md:100 の手順）。
6. 変えないもの: 状態の判定（server/）、waitingFor の画面への受け渡し（src/types.ts を触ると release/chat と競合するため今回はしない）、部品・CSS のトークン、他の画面。

## 導入
- 新しい版の導入（`bash scripts/ac-update.sh v0.10.1`）はアプリが再起動するため、PO が戻ってから PO が実行する（README.md:90）。本セッションではマージとタグまで。

## 受入
| 基準 | 検証方法 |
|---|---|
| 文言 | ja・en のキーの値の差分。画面の単体試験で、各状態のカードに新しい文言が出る |
| 鉛筆なし | 単体試験で、カードに名前変更のボタンが無く、ダブルクリックで改名フォームが開く |
| 未読が2段目 | 単体試験で、unread-badge が2段目（session-line-2）の中にあり、1段目に無い |
| 行の高さ | e2e の 64px 以下の試験が無修正で通る |
| 品質 | typecheck・lint・test・build・e2e（CI）がすべて成功 |
| 画面 | 開発サーバーで偽のセッション（作業中・回答待ち・指示待ち・未読あり）を出し、幅は今の左欄の幅で、変更前と変更後のスクリーンショットを撮る（設計者が目視） |

## 戻し方
PR を revert し、v0.10.0（または v0.9.1）へ `scripts/ac-rollback.sh` で戻す。

## 外部・過去事例の参照と我々への応用
外部事例: 不要（自前アプリの文言と並びの整理）。参照: 状態の定義は Claude Code 公式（https://code.claude.com/docs/en/agent-view.md の status・waitingFor・Idle）に合わせる。過去事例の応用: v0.10.0（PR #24）の2段構成と行の高さ 64px の試験をそのまま守る。

## 維持の仕組み
守り手: SessionList.test.tsx、tests/e2e/console.spec.ts、CI（ci.yml）。

## 改訂 1（2026-10-13、Fable 設計審査 REVISE への対応。本節が上の記述より優先）
- F1: en.json は無い（src/locales は ja.json だけ、src/i18n.ts:3-4,19）。en の記述と受入の「ja・en」を外す。
- F2（設計者の決定）: macOS 通知の文言もバッジと揃える。server/notify.ts:24 の `STATE_LABEL`（waiting: "待ち", idle: "待機"）を「回答待ち」「指示待ち」に変える。判定 isBreak（:9-11）は変えない。固定文字で検査している tests/unit/notify.test.ts:36-37、tests/unit/daily-use.integration.test.ts:98、tests/e2e/console.spec.ts:464 を新しい文言に直す。理由: 同じ状態に画面と通知で違う名前が付くと、PO の「分かりづらい」が残るため。
- F3: 変えるもの（file:line、すべて origin/main 391b6093）:
  - src/locales/ja.json:24（state.waiting「待ち」→「回答待ち」）、:25（state.idle「待機」→「指示待ち」）、:90（ac.notifyHelp の「待ち」「待機」→「回答待ち」「指示待ち」）、:95（ac.rename.hintClaude「…待機になったら送ります」→「…指示待ちになったら送ります」）、:98（ac.rename.queueBody の「待機」→「指示待ち」）。
  - README.md:55-56 の「待ち」「待機」の説明と、:56 の「鉛筆の『名前を変える』」の記述（ダブルクリックと F2 に書き換え）。
  - 同時に変わるもの（意図どおり）: 右欄 ActivityPane.tsx:10,120 の「今の状態」も STATE_LABEL_KEY を使うため新しい文言になる。
  - 変えないもの: ja.json:201 ac.routines.outcomes.waiting「待機中」（定期タスクの結果の表示で、セッション一覧の状態とは別の画面・別の意味の区分のため今回の範囲外。後で揃えるかは別件）。
- F4（設計者の決定）: 鉛筆ボタンは消す（PO 指示）。キーボードだけで改名する手段を残すため、セッションの選択ボタンにフォーカスがあるときの F2 キーで改名フォームを開く（handleKeyDown :71-77 に1つ追加。onRename の既存の流れを使う）。選択ボタンに `aria-keyshortcuts="F2"` を付ける。ac.rename.open は鉛筆専用なら ja.json から消し、ほかで使っていれば残す（実装時に grep で確定して記録）。試験に「F2 で改名フォームが開く」を足す。
- F5: release/chat（未マージ、v0.11.0 相当）との競合は package.json:3 と docs/CHANGELOG.md:5 で確実に起きる。ja.json と console.spec.ts は別の箇所。マージ順は本件（0.10.1）が先。release/chat の担当は後で main を取り込み、版と CHANGELOG の行を解決する（本件では release/chat を触らない）。
- F6: 受入の画面確認に「役割・回答待ち・未読・CI 失敗・予約名が同時に出る行」を1枚含める（右から切れるのは CSS どおりの挙動として記録）。
- 文言の補足: 「回答待ち」は許可の確認も含む（公式の waiting = Needs input）。PO が言う「私の回答待ち」に当たる。

## 幅ごとの見え方（実測）

方法: 偽データ（/api/state の応答を差し替え、/ws/events は無効）で、行（session-row）の実測幅を 260 / 300 / 360 / 420px に合わせ、各要素の getBoundingClientRect を 2 段目（session-line-2）の右端と比べた。全部見える=要素の右端が 2 段目の右端以内、一部切れる=右端を超える、または省略記号で切れている、見えない=要素の左端が 2 段目の右端以上。前=v0.10.0（origin/main 391b609）、後=v0.10.1。生データ: evidence/width-check.json、スクリーンショット: evidence/before-list-w*.png、evidence/after-list-w*.png。

deploy-check（回答待ち・未読2・CI 失敗・予約名）

| 幅 | 版 | 役割 | 状態 | 未読 | CI | 予約名 |
|---|---|---|---|---|---|---|
| 260 | 前 | 全部見える | 全部見える | 全部見える | 全部見える | 一部切れる |
| 260 | 後 | 全部見える | 全部見える | 全部見える | 一部切れる | 見えない |
| 300 | 前 | 全部見える | 全部見える | 全部見える | 全部見える | 一部切れる |
| 300 | 後 | 全部見える | 全部見える | 全部見える | 一部切れる | 見えない |
| 360 | 前 | 全部見える | 全部見える | 全部見える | 全部見える | 一部切れる |
| 360 | 後 | 全部見える | 全部見える | 全部見える | 全部見える | 一部切れる |
| 420 | 前 | 全部見える | 全部見える | 全部見える | 全部見える | 全部見える |
| 420 | 後 | 全部見える | 全部見える | 全部見える | 全部見える | 一部切れる |

ui-review（指示待ち・未読1・CI 成功。予約名なし）

| 幅 | 版 | 役割 | 状態 | 未読 | CI |
|---|---|---|---|---|---|
| 260 | 前 | 全部見える | 全部見える | 全部見える | 全部見える |
| 260 | 後 | 全部見える | 全部見える | 全部見える | 一部切れる |
| 300 | 前 | 全部見える | 全部見える | 全部見える | 全部見える |
| 300 | 後 | 全部見える | 全部見える | 全部見える | 一部切れる |
| 360 | 前 | 全部見える | 全部見える | 全部見える | 全部見える |
| 360 | 後 | 全部見える | 全部見える | 全部見える | 全部見える |
| 420 | 前 | 全部見える | 全部見える | 全部見える | 全部見える |
| 420 | 後 | 全部見える | 全部見える | 全部見える | 全部見える |

カード幅 300px 以下では CI バッジが一部切れる（変更前は見えていた）。PO の画面の幅（約360px）では全部見える。PO に報告し、必要なら別便で並びを決める。
