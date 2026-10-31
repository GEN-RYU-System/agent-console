# 返事が来たら未読を付け、PO が送るまで消さない 設計

状態: 設計案（Opus 作成・2026-11-01）。PO 決定 2026-11-01「1」（その窓で PO が何か送ったら消す）。設計審査（クラウド）の APPROVE と PO の実装承認の後に実装へ進む。

## 1. 目的（PO に見える変化）
- PO の願い（2026-11-01 原文）:「agent consoleのあなたが私の返答街をしているときも未読を表示させるようにして、殆どの場合で未読バッジがなくて気づかないことが多い」
- 同日の追加の観測（PO 原文）:「今も選択肢を出していたが未読はついていなかった」
- 変化: Claude が返事を終えるたびに、その窓の行に「未読」の印が付く。PO がその窓で何か送る（Enter を押す・チャット欄から送る）まで消えない。窓を開いているだけ・行を選んだだけでは消えない。

## 2. 現在地（事実。origin/main de28ba7）
- 未読の数え方: server/notify.ts:9-10 `isBreak(prev,next)` は `prev === "busy" && (next === "waiting" || next === "idle")`。server/notify.ts の `BreakTracker.observe()` がこのときだけ未読を 1 増やす。
- 呼ばれる間隔: server/hub.ts:569-589 `detectBreaks()` は `claude agents --json` の取得ごと（installed の agent-console.config.json の agentsPollMs = 10000）。
- 原因1（見ている窓は自動で既読になる）: src/pages/ConsolePage.tsx:216-220
  `if (selectedId !== null && selectedUnread > 0 && document.visibilityState === "visible") void markRead(selectedId)`。さらに :226-229 `handleSelect` も行を選ぶと既読にする。PO が今の窓を開いたままなら、未読は付いた直後に消える。PO の「今も…未読はついていなかった」はこの経路と合う。
- 原因2（短い返事は数えられない）: 状態は 10 秒ごとにしか見ない。10 秒未満で終わる返事は busy を一度も観測しないので、`isBreak` が成り立たず未読が増えない。
- 返事の終わりの印は既にある: Claude の Stop hook を agent-console の記録用 hook が書いている（server/activity-hooks.ts:60 `{ event: "Stop" }`、hooks/activity-hook.mjs:173-177 は `stop_hook_active` も残す）。server/activity.ts:393-394 は Stop を会話の記録にだけ使う。記録の読み込みは 2 秒ごと（server/activity-start.ts:10 `ACTIVITY_POLL_MS = 2000`）と agents 取得ごと（server/index.ts:114）。
- 実物の記録: 2026-10-31 の events-20261031.jsonl に Stop が 489 行。各行に session_id（Claude の会話番号）と stop_hook_active（false）がある。
- 窓と Claude の会話の対応: hub は窓ごとに `claudeSessionId` を持つ（server/hub.ts:577-581 で控える）。
- PO の入力の道: ①端末への直接入力 server/ws.ts:36（`msg.type === "input"` を `sessions.write`）②チャット欄からの送信 server/hub.ts:526-533（貼り付け→Enter）。定期実行の送信 server/hub.ts:548-566 `submitText` は PO の入力ではない。
- 既存の設計の定義: docs/handoff/stage2/design.md:14（K1「行を選ぶと未読が消える」）・:32。今回これを変える。

## 3. 対象と対象外
- 対象: server/notify.ts（未読の数え方）、server/activity.ts（返事の終わりを知らせる口）、server/hub.ts（返事の終わりで未読を足す・PO の送信で消す）、server/ws.ts（端末入力で消す合図）、src/pages/ConsolePage.tsx（自動の既読を外す）、関係する試験、README の未読の説明、docs/CHANGELOG.md、版（package.json・package-lock.json・extension/manifest.json）。
- 対象外: macOS の通知（今の busy→待ちの判定のまま）、未読の保存（今までどおりメモリだけ・再起動で消える）、印の見た目と言葉（ac.unread「未読 {{count}} 件」はそのまま）、記録用 hook の形（hooks/activity-hook.mjs は変えない）、定期実行。

## 4. 変更（前 → 後）
### 4-1. 未読を足すとき
- 前: 10 秒ごとの観測で busy→waiting/idle を見たとき 1 増やす。
- 後: 記録に Stop が届き、`stop_hook_active` が true でないとき、その Claude の会話番号を `claudeSessionId` に持つ窓の未読を 1 増やす。
  - `stop_hook_active` が true の Stop は、別の Stop hook に止められて続けた後の終わり。同じ 1 回の返事を 2 度数えないため足さない。
  - サーバー起動より前の時刻（ts）の Stop は足さない。起動時に今日・昨日の記録を読み直すので、古い返事で未読が付くのを防ぐ。
  - 会話番号に合う窓が無いとき（窓を閉じた・控える前）は何もしない。
- 形: `ActivityStore` に `onTurnEnd(listener: (claudeSessionId: string, ts: number) => void)` を足し、`apply()` の `case "Stop"` から呼ぶ。`loadFileHistory`（ファイルの記録だけ）は Stop を通さないので影響しない。hub は `watchActivity` で受け、`BreakTracker` に `addUnread(sessionId)` を足して呼ぶ。
- `BreakTracker.observe()` は通知の判定（true/false を返す）だけを続け、未読は増やさない。

### 4-2. 未読を消すとき（PO 決定「1」）
- 前: 行を選んだとき、選んでいる行に未読が来たとき（窓が見えていれば）に消える。
- 後: 次の 2 つのときだけ消す。
  1. 端末へ PO が打った入力に Enter（`\r`）が含まれるとき（server/ws.ts:36）。選択肢を Enter で選ぶ・許可に答える・普通に送る、のどれも含む。クリックやフォーカスで端末が出す文字（`\x1b[I` など）・矢印キーには `\r` が無いので消えない。
  2. チャット欄からの送信が端末に Enter を書いたとき（server/hub.ts:533 の直後）。
  - 定期実行の `submitText` では消さない（PO の入力ではない）。
- 画面: src/pages/ConsolePage.tsx:216-220 の自動の既読を削る。:228 の `handleSelect` の既読も削る。`markRead` の API（server/hub.ts:614-617）は残す（ほかの呼び出し元の有無を実装で git grep し、無ければ画面から呼ばないだけにする）。

### 4-3. 変えないこと
- タイトルの合計（ConsolePage.tsx:212-215）と一覧の印（SessionList.tsx）は今の `unread` をそのまま出す。

## 5. 代替案と選ばなかった理由
- A. 観測の間隔を短くする（10 秒→1 秒）: `claude agents --json` を 10 倍呼ぶ。1 秒未満の返事はなお漏れる。原因1も直らない。不採用。
- B. 画面が見えていないときだけ自動既読を止める: PO はほとんど今の窓を開いたまま待つので、原因1が残る。PO の決定「1」と合わない。不採用。
- C. 行を選んだら消す（今の定義を残す）: PO が選んだ「1」と違う。不採用。
- D. 採用案（返事の終わりの記録で足し、PO の送信で消す）: 既にある記録を使い、新しい hook も Claude の設定の変更も要らない。

## 6. リスクと対処
- 記録用 hook が入っていない環境: 未読が足されない。今の K8 の点検（hook が入っているか）で分かる。この Mac では入っている（~/.claude/settings.json の Stop に activity-hook.mjs）。
- 1 回の入力に Stop が何度か来る（hooks/activity-hook.mjs:174 のコメント）: `stop_hook_active` で 2 度目以降を除く。背景の仕事の知らせで Claude が起きて返事をした回は、PO の入力が無くても数える（読むべき返事なので正しい）。
- 端末の入力に `\r` が入るのは Enter 以外にもある（貼り付けた文に改行が含まれる場合など）: どれも PO が窓に書いた操作なので、消してよい。
- 試験の書き換え: src/pages/ConsolePage.test.tsx:343 は「選んだら既読」を確かめている。新しい定義に合わせて書き換える（消すのでなく、逆の振る舞いを確かめる試験にする）。

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 Claude が 3 秒で終わる短い返事をしたとき、5 秒以内にその窓の行に「未読 1 件」が付く | 単体（Stop の記録を 1 行足して refresh → unread 1）＋PO の目視（短い質問を送り、別の窓を見ている間に印が付く） |
| K2 その窓を開いて見ている間も、印は消えない（30 秒見続けても残る） | 単体（ConsolePage で選んでいる行に unread 1 が来ても markRead が呼ばれない）＋PO の目視 |
| K3 行を選んだだけでは消えない | 単体（handleSelect で markRead が呼ばれない） |
| K4 その窓の端末で Enter を押す（選択肢を選ぶを含む）と消える。矢印キー・クリックだけでは消えない | 単体（ws に "\r" を含む input → unread 0。"\x1b[A"・"\x1b[I" → 残る）＋PO の目視 |
| K5 チャット欄から送ると消える | 単体（チャットの送信で Enter を書いた後 unread 0） |
| K6 定期実行の送信では消えない | 単体（submitText の後も unread が残る） |
| K7 別の hook に止められて続けた返事は 1 回と数える | 単体（stop_hook_active false → true の 2 行で unread 1） |
| K8 サーバーを入れ替えて起動した直後、昔の返事で未読が付かない | 単体（起動時刻より前の ts の Stop → unread 0） |
| K9 macOS の通知は今までどおり出る | 既存の通知の試験が通る |
| K10 既存の試験・型検査・lint がすべて通る | CI |

## 8. 維持の仕組み
- 未読の正本は hub のメモリ（BreakTracker）1 か所のまま。足す道は Stop の記録 1 本、消す道は PO の送信 2 本に固定し、試験 K3〜K6 で固定する。
- README の未読の説明と docs/handoff/stage2/design.md の K1 の定義の変更を、この設計の場所と CHANGELOG に書く。

## 9. 外部事例
- 該当なし。理由: 未読の付け方・消し方は PO の運用（「送るまで消さない」）で決めた。外の数値を根拠にしない。
