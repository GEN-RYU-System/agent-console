# 設計: チャット画面（Claude の Web 版のように、右に自分の文章、左に Claude の返事、下に入力欄）

- 状態: 設計者（Opus）が作成。Fable の設計審査 第1回 REVISE（HIGH 3・MEDIUM 8・LOW 4）を反映した第2版。再審査を待っている。
- 便の分け方（Fable 推奨を採用）:
  - 便1（本書の範囲）: チャットの表示、入力欄、よく使う指示を入力欄に入れる。送るのは今と同じく「Claude が手すきのとき」だけ。
  - 便2（別の設計）: 作業中にも送る。本物の claude での実測（作業中の順番待ち、許可の確認の画面に貼ったときの動き）と、Enter の直前の判定のし直しを含める。安全の穴と未確認の前提は、便2 だけに閉じ込める。PO の要望「作業中でも追加でメッセージが送れるように」は便2 で満たす。
- 版の番号: 実装の時点の main の次（v0.10.0 の後なら 0.11.0）。
- PO 承認（2026-10-13）:
  - 「claudeブラウザ版みたいにチャット形式に出来る？右に私の送ったメッセージが表示されて入力欄もちゃんとのようにして欲しい」
  - 知らせの仕組みで会話を出し、入力欄から端末に送り、端末も残す形に「y」。
  - 追加:「作業中でも追加でメッセージが送れるようにしてほしい（→便2）、よく使う指示も使えるようにして」
- 調査: docs/handoff/chat/recon.md（Sonnet。A〜I）
- 対象ADR: ADR-067、ADR-144

## 0. 事実（recon と Fable の審査より）
- 公式 hooks:
  - Stop の last_assistant_message は、1回の返事の最後の本文。長さの上限の記載は無い。
  - Esc などで作業を止めたときは、Stop は起きない。API のエラーのときは StopFailure が起き、その項目はエラーの文（hooks.md:2669-2673、2779-2785）。
  - ほかの Stop の hook が block すると、1回の入力に Stop が何回か起きうる（stop_hook_active、hooks.md:2681-2683）。PO の設定の Stop には、すでにほかの handler が2件ある。
  - UserPromptSubmit の prompt は、貼り付けを展開した全文。3行を超えるか 800 字を超える貼り付けは、印の付いたセッションでは `<pasted_content id="…">` と `</pasted_content id="…">` の行で包まれて届く（hooks.md:1440）。アプリは xterm の paste() で送るので、常に貼り付けの扱いになる。
  - 担当の報告の戻り、定期実行、ほかのセッションからのメッセージでも UserPromptSubmit が起きる。見分けられたのは、担当の報告（`<agent-message` で始まる）だけ。
- 今の記録: Stop は記録していない。prompt は clip() で先頭 80 字にし、連続した空白を1つにまとめている（hooks/activity-hook.mjs:27-31）。1行 4096 byte を超える記録は捨てる。サーバーは今日と昨日（UTC）のファイルだけを読む（server/activity.ts:178-181）。
- 送る: 画面が貼って Enter を送る（pasteSubmitAfter は、貼る→2秒待つ→Enter）。サーバーの send-check は、保存済みの指示の本文しか返さない。判定は inputVerdict（server/agents.ts:80-88。手すき、かつ許可などの待ちが無いときだけ可）。
- 表示: Markdown を描画する依存は無い。吹き出しの金型は SA に無いが、受信箱の CSS とトークン `--bubble-outbound-bg`・`--bubble-inbound-bg` がある。
- 端末は hidden（display:none）で隠すだけ（ConsolePage.tsx:369-370）。大きさ 0 のときは resize を送らず、見えたときに大きさを合わせる（TerminalPane.tsx:109-121）。最初から隠れた状態で端末を開く先例は無い。
- 既存の e2e は、タブを押さずに端末が見える前提（tests/e2e/console.spec.ts:65-71）。

## 1. 成功条件（便1）
|基準|検証方法|
|---|---|
|K1 中央のタブの先頭に「チャット」が加わり、最初に開くタブになる。ほかのタブは今のまま|単体試験＋e2e（既存の e2e は、端末タブを押してから端末を見る形に直す）|
|K2 チャットには、選んだセッションの会話を古い順に出す。しんごさんの文章は右寄せ、Claude の返事は左寄せの吹き出し。新しいものが来たら一番下まで動く（上を読んでいるときは動かさない）。出すのは、今日と昨日（UTC）の記録の分。アプリを再起動すると、それより古い会話は出ない|統合試験（偽の hook の入力）＋e2e|
|K3 担当の報告の戻り（`<agent-message` で始まる入力）は出さない。`<pasted_content …>` の包みの行は外して出す（記録は生のまま）。StopFailure は、エラーの種類の短い案内として出す。1回の入力に Stop が何回か来たら、その数だけ吹き出しを出す（消さない）|単体試験|
|K4 Claude の返事は Markdown として描画する（見出し、箇条書き、太字、コード、表）。HTML は描画しない。`javascript:` のリンクは作らない。リンクは別のタブで開く|単体試験|
|K5 下に入力欄と「送る」。Enter で送り、Shift+Enter で改行。日本語の変換中（isComposing、または keyCode 229）の Enter では送らない|単体試験（変換中）＋e2e（Enter と Shift+Enter）|
|K6 送れるのは、Claude が手すきのときだけ（今の判定と同じ）。作業中や確認の待ちのときは「送る」を押せず、理由の文を出す。確認の待ちのときは、端末タブへ移る Button も出す|単体試験＋統合試験|
|K7 入力欄の上に、よく使う指示（常に表示のもの）を並べる。押すと本文が入力欄に入る（すぐには送らない）。バーの部品は、v0.10.0 の QuickPromptBar を使い回し、2本目は作らない|単体試験＋e2e|
|K8 記録は、今と同じ dataDir/activity/ の日付のファイル1か所。Stop と StopFailure を足し、prompt と返事は全文を残す（改行もそのまま）。1行は JSON 全体で 64KiB まで。超えるときは、文字の区切りを割らずに切り、`truncated: true` を付ける（文言は画面の t() で出す）|単体試験（60KiB を超える行で、並列 20 プロセス × 200 行、読めない行 0）|
|K9 右の欄の「最近の入力」は、表示のときに先頭 80 字にする（同じ記録から作る）|既存の試験|
|K10 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る。npm audit が通る。v0.10.0 の大きいタブで6つ並べたとき、3つの幅で折り返しを目視で確かめる|CI＋目視|
|K11（導入後）PO が見て、Web 版のように会話が読め、手すきのときに送れ、よく使う指示を入力欄に入れられる|PO の目視|

## 2. 対象と対象外
- 対象:
  - hooks/activity-hook.mjs: Stop と StopFailure を足す。全文用の関数（改行とタブ以外の制御文字だけを除く）を足す。clip() は右の欄の短い項目にだけ使う。stop_hook_active と、StopFailure のエラーの種類も残す。
  - server/activity.ts: EVENTS に Stop と StopFailure を足す。セッションごとの会話の一覧（上限 200 件）と、`<pasted_content>` の包みを外す処理。
  - server/activity-hooks.ts: HOOK_SPECS に Stop と StopFailure を足す。
  - server/chat-routes.ts（新設）: `GET /api/sessions/:id/chat?since=<ts>`。since より後の分だけを返す。
  - src/components/ChatPane/（新設）、ConsolePage（タブ）、QuickPromptBar（onPick の prop を足す）
  - package.json（react-markdown と remark-gfm。§3-4）
  - ja.json（右の欄の警告に「install をもう一度」を足すことを含む）、試験（既存の e2e の直しを含む）、版、CHANGELOG、README
- 対象外（便1）:
  - 作業中に送ること（便2）
  - 返事を1文字ずつ流して出すこと、途中の道具の様子
  - Esc で止めた回の返事（Stop が起きないので、返事の吹き出しは出ない）
  - 定期実行やほかのセッションからのメッセージも「入力」として出うる（見分けられない）
  - 許可の確認にチャットから答えること
  - 画像を送ること（端末の画像の添付を使う）

## 3. 仕組み
### 3-1 記録（hook）
- 全文用の関数で本文を整え、1行の JSON を作る。
- JSON 全体が 64KiB を超えるときは、本文を後ろから、コードポイントの区切りで切って `truncated: true` を付ける。
- 書き方は今のまま。`a` で開き、1つの Buffer を1回の writeSync で書く。
- 根拠の書き方を直す: 「macOS と Linux は、実用上、1回の write を分割しない。並列の試験で固定する」。部分書き（書けた長さが足りない）のときは今と同じく、その後は書かない。残った断片の行は、サーバーが読めない行として捨てて数える（その前後の行も読めなくなることは許容する）。

### 3-2 サーバー
- 会話の一覧は、user・assistant・error の3種類を、ts の順に並べる。
- 表示のための整形（包みを外す、担当の報告を除く）は、サーバーで一覧を作るときに行う。記録は生のまま残す。
- 送る前の判定は、今の send-check の考え方（手すきだけ）をそのまま使う。
  - 任意の文章のために `POST /api/sessions/:id/chat/send-check {text}` を足す。本文の検査（空でない、32KiB まで、改行とタブ以外の制御文字なし）をして、checkInput を取り直す。
  - 判定は今の inputVerdict をそのまま使う。新しい判定の関数は作らない（便2 で `allowBusy` の引数を足す）。

### 3-3 画面（src/components/ChatPane/）
- タブの先頭に「チャット」を置き、最初に開く。
- 端末は、最初は隠れた状態で開くことになる。工程0 (b) で、そのあと端末タブを開いたときに正しく描けるかを確かめる。崩れる場合は、端末タブを開いた時点で大きさ合わせをやり直す処理を TerminalPane に足す。
- 吹き出し:
  - 右は `--bubble-outbound-bg`、左は `--bubble-inbound-bg`。
  - そのほかの値も SA のトークンを使う。実在は、実装の前に .sa-cache で確かめる。
  - 返事に `truncated` があれば、末尾に「（以下略）」を t() で出す。
- 入力: SA の Textarea（variant: composer）と「送る」の Button。
  - 送る流れ: send-check → pasteSubmitAfter（v0.4.0 と同じ。待ちの間にセッションが切り替わったら Enter は送らない）。
  - 送った文章は、hook の記録が届いてから会話に出る。届くまでの間は、入力欄の下に「送りました（Claude が受け取ると表示されます）」と出す。本文が一致するかで照らし合わせることはしない（包みが付くため）。
- よく使う指示: v0.10.0 の QuickPromptBar に `onPick(text)` の prop を足して使い回す。チャットでは押すと本文を入力欄の後ろに足すだけなので、送れない状態でも押せる。

### 3-4 Markdown の描画
- react-markdown と remark-gfm を、正確な版（package.json の今の流儀）で足す。
- rehype-raw は使わない。skipHtml を明示する。
- a の要素は、components で差し替えて target="_blank" と rel="noopener noreferrer" を付ける。`javascript:` の URL が href にならないことを、単体試験で固定する。
- 工程0 (d) で、次のことを step0.md に書く。
  - 版、公開日（2週間以上前のもの）
  - 推移的な依存の数、ライセンス
  - npm audit の結果
  - 既定の urlTransform の動き
  - 問題があれば止めて設計者に戻す（代わりの案は §6 の素の表示）
- CI の npm audit は、すでに ci.yml にある（v0.4.0 の recon）。

## 4. SSOT
- 会話の正本は、今の記録（dataDir/activity/ の日付のファイル）1か所。チャットも右の欄も、同じ記録から作る。整形は表示の側で行う。
- 状態の正本は agents --json。よく使う指示の正本は quick-prompts.json のまま。バーの部品も1つ。

## 5. 安全
- 記録は、この Mac の中のファイル（600/700）だけで、7日で消える。全文を残すので、PO が貼った秘密の文も残りうる。
- 送るのは手すきのときだけ（便1）。許可の確認の画面に Enter を送る危険は、便1 では今と同じ（判定と Enter の間に 2秒ある。v0.4.0 から同じ）。便2 では、Enter の直前の判定のし直しで狭める。
- Markdown は HTML を描画しない（K4）。

## 6. 代替案
- 便を分けない: 作業中の送信の未確認の前提が、全体に広がる。Fable の推奨で分けた。
- 素の pre-wrap の表示: Web 版のようにならない。工程0 (d) で依存に問題があったときだけ、この形にする。
- stream-json、transcript を読む: 前の検討どおり不採用。

## 7. リスクと対処
- 端末を隠したまま開いたときの描画: 工程0 (b)。
- 6つの大きいタブの折り返し: K10 の目視。
- 依存の安全: 工程0 (d)。

## 8. 外部・過去事例の参照と我々への応用
- Claude の Web 版の見た目（PO の基準）。公式 hooks と interactive-mode の文書（Enter で送る：interactive-mode.md:80-90）。
- 過去事例: v0.9.0 の記録の仕組み、v0.4.0 の送る仕組み、v0.3.7 の「許可の確認に Enter を送らない」。
- 適用限界: 流れるような表示と途中の道具の様子は得られない。

## 9. 工程0（実装の最初）
- (a) 道具を2回以上使った回の返事で、Stop の last_assistant_message が、最後の本文だけか、途中の文章も含むかを確かめる。
- (b) 端末を、最初は隠れた状態で開き、あとで端末タブを開いたときに正しく描けるか（列の数と、文字が崩れないこと）。
- (c) 長い文章を貼ったときの UserPromptSubmit の prompt の形（`<pasted_content>` の印）。
- (d) Markdown の依存（§3-4）。
- 結果は step0.md に書く。(d) に問題があれば止めて戻す。

## 10. 設計審査
- 第1回（Fable）: REVISE。
  - H1 作業中の送信 → 便2 に分けた。
  - H2 貼り付けの包み → 表示のときに外す。
  - H3 最初に開くタブ → 既存の e2e の直しと、工程0 (b)。
  - M1〜M8、L1〜L4 → 各節に反映した。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K4（HTML を描画しない）、K3（包みと報告の除外）、K8（行が混ざらない）を試験で固定する。

## 11. 設計審査 第2回（Fable、2026-10-13）
- 判定: APPROVE。実装のときに入れる決め:
  - M-a K6 の待ちの状態は、偽の claude の STUB_STATUS_FILE=waiting で作る。
  - M-b 切り詰めは、先に本文の上限（64KiB − ほかの項目の長さ − 余裕）で切り、JSON にしてから長さを1回だけ測り直す。繰り返しはしない。
  - M-c 会話の一覧はサーバーで連番（seq）を付け、`GET /api/sessions/:id/chat?since=<seq>` にする（同じ ms の記録を取りこぼさない）。
  - L-a 工程0 (b) に「表示に戻ったときに ResizeObserver が発火したか」を足す。発火しなければ、hidden の変化を prop で TerminalPane に渡して大きさ合わせを呼ぶ。
  - L-b 一番下まで動くかの判定は純粋な関数に切り出して単体試験にし、実際の動きは e2e で見る。
  - L-c 文言のキー: ac.chat.truncated（以下略）、ac.chat.sent（送りました（Claude が受け取ると表示されます））、ac.chat.waitingInTerminal（端末で確認が出ています）、ac.activity.hooksReinstall（install をもう一度）。
  - 工程0 (d) の結果（版・依存の数・audit）は step0.md と PR 本文に書く。
